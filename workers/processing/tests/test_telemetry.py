"""GPS positions must follow the sampled video timeline and survive ODM upload."""
from pathlib import Path
from unittest.mock import Mock

from PIL import Image
import pytest

from felslager_processing import capture
from felslager_processing.telemetry import geotag_frames, read_positions, write_gps, Position
from felslager_processing.errors import JobCancelled


def cue(start, end, lat=48.12, lon=16.25, altitude="abs_alt: 342.5"):
    return (f"1\n{start} --> {end}\n<font size=28>[latitude: {lat}] "
            f"[longitude: {lon}] [rel_alt: 12.5 {altitude}]</font>\n\n")


def coordinates(frame):
    with Image.open(frame) as image:
        gps = image.getexif().get_ifd(34853)
    def decimal(values):
        return sum(float(value) / divisor for value, divisor in zip(values, (1, 60, 3600)))
    return (decimal(gps[2]) * (-1 if gps[1] == "S" else 1),
            decimal(gps[4]) * (-1 if gps[3] == "W" else 1), gps)


def test_modern_srt_bom_crlf_signed_coordinates_and_absolute_altitude(tmp_path):
    subtitle = tmp_path / "flight.SRT"
    subtitle.write_bytes(("\ufeff" + cue("00:00:01,000", "00:00:02,000", -48.12, -16.25,
                                           "abs_alt: -20.125")).replace("\n", "\r\n").encode())
    positions = read_positions(subtitle)
    assert positions == [Position(1, 2, -48.12, -16.25, -20.125)]
    frame = tmp_path / "frame.jpg"
    Image.new("RGB", (32, 32), "red").save(frame)
    original = frame.read_bytes()
    with Image.open(frame) as image:
        original_pixels = image.tobytes()
    write_gps(frame, positions[0])
    lat, lon, gps = coordinates(frame)
    assert lat == pytest.approx(-48.12) and lon == pytest.approx(-16.25)
    assert gps[5] == b"\x01" and float(gps[6]) == 20.125
    assert frame.read_bytes().split(b"\xff\xda", 1)[1] == original.split(b"\xff\xda", 1)[1]
    with Image.open(frame) as image:
        assert image.tobytes() == original_pixels
    # Replacing existing GPS must not accumulate EXIF blocks.
    write_gps(frame, Position(1, 2, 48, 16, None))
    assert frame.read_bytes().count(b"Exif\x00\x00") == 1
    assert 6 not in coordinates(frame)[2]


def test_legacy_gps_and_missing_absolute_altitude(tmp_path):
    subtitle = tmp_path / "flight.srt"
    subtitle.write_text("1\n00:00:00.000 --> 00:00:01.000\nGPS(48.12,16.25,340.125M) BAROMETER:12M\n\n"
                        + cue("00:00:01,000", "00:00:02,000", altitude=""))
    assert read_positions(subtitle) == [Position(0, 1, 48.12, 16.25, 340.125),
                                        Position(1, 2, 48.12, 16.25, None)]


def test_invalid_positions_and_timestamps_are_not_geotagged(tmp_path):
    subtitle = tmp_path / "flight.srt"
    subtitle.write_text("not telemetry\n\n" + cue("00:00:00,000", "00:00:01,000", 0, 0)
                        + cue("00:00:01,000", "00:00:02,000", 100, 16)
                        + cue("00:00:03,000", "00:00:02,000")
                        + cue("00:61:00,000", "00:61:01,000")
                        + cue("00:00:04,000", "00:00:05,000", lon=200))
    assert read_positions(subtitle) == []


def test_trim_sampling_gaps_boundaries_and_original_video_unchanged(tmp_path, monkeypatch):
    source, work = tmp_path / "capture", tmp_path / "work"
    (source / "flight").mkdir(parents=True); work.mkdir()
    video = source / "flight/DJI_20261031122718_0003_D.MP4"
    video.write_bytes(b"original video")
    subtitle = video.with_suffix(".SRT")
    subtitle.write_text(cue("00:00:02,000", "00:00:03,000", lat=48.1)
                        + cue("00:00:03,000", "00:00:04,000", lat=48.2)
                        + cue("00:00:05,000", "00:00:06,000", lat=48.3))
    original_srt = subtitle.read_bytes()
    commands = []
    def extract(command, *_):
        commands.append(command)
        for index in range(1, 9):
            Image.new("RGB", (32, 32), "blue").save(Path(command[-1]).parent / f"{index:06d}.jpg")
    monkeypatch.setattr(capture, "run_batch", extract)
    monkeypatch.setattr(capture.client, "check_cancelled", Mock())
    monkeypatch.setattr(capture.client, "report_progress", Mock())
    job = {"id": "job", "options": {"preparing": {"videoStartSeconds": 2,
            "videoEndSeconds": 6, "videoFrameIntervalSeconds": .5}}}
    prepared = capture.prepare_capture(job, source, work)
    frames = sorted(prepared.rglob("*.jpg"))
    # Samples at 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5 seconds.
    assert [coordinates(frames[index])[0] for index in (0, 1, 2, 3, 6, 7)] == pytest.approx(
        [48.1, 48.1, 48.2, 48.2, 48.3, 48.3])
    for index in (4, 5):
        with Image.open(frames[index]) as image:
            assert not image.getexif().get_ifd(34853)
    assert commands[0][commands[0].index("-ss") + 1] == "2"
    assert commands[0][commands[0].index("-t") + 1] == "4"
    assert video.read_bytes() == b"original video"
    assert subtitle.read_bytes() == original_srt
    assert (work / "telemetry/flight" / subtitle.name).read_bytes() == original_srt


@pytest.mark.parametrize("excluded,other_folder", [(True, False), (False, True)])
def test_excluded_or_other_video_srt_is_never_used(tmp_path, monkeypatch, excluded, other_folder):
    source, work = tmp_path / "capture", tmp_path / "work"
    source.mkdir(); work.mkdir()
    (source / "flight.mp4").write_bytes(b"video")
    folder = source / "other" if other_folder else source
    folder.mkdir(exist_ok=True)
    (folder / "flight.srt").write_text(cue("00:00:00,000", "00:00:10,000"))
    def extract(command, *_):
        for index in (1, 2):
            Image.new("RGB", (32, 32)).save(Path(command[-1]).parent / f"{index:06d}.jpg")
    monkeypatch.setattr(capture, "run_batch", extract)
    monkeypatch.setattr(capture.client, "check_cancelled", Mock())
    monkeypatch.setattr(capture.client, "report_progress", Mock())
    prepared = capture.prepare_capture({"id": "job", "options": {"preparing": {
        "excludedPaths": ["flight.srt"] if excluded else []}}}, source, work)
    for frame in prepared.rglob("*.jpg"):
        with Image.open(frame) as image:
            assert not image.getexif().get_ifd(34853)


def test_telemetry_does_not_extrapolate_and_can_be_cancelled(tmp_path):
    subtitle = tmp_path / "flight.srt"
    subtitle.write_text(cue("00:00:01,000", "00:00:02,000"))
    frames = []
    for index in range(3):
        frame = tmp_path / f"{index}.jpg"
        Image.new("RGB", (32, 32)).save(frame); frames.append(frame)
    assert geotag_frames(frames, subtitle, 0, 1, lambda: None) == 1
    with pytest.raises(JobCancelled):
        geotag_frames(frames, subtitle, 0, 1, Mock(side_effect=JobCancelled()))


def test_real_ffmpeg_trim_and_sampled_frames_receive_gps(tmp_path, monkeypatch):
    import shutil
    import subprocess
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg is required for video preparation")
    source, work = tmp_path / "capture", tmp_path / "work"
    source.mkdir(); work.mkdir()
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                    "color=c=red:s=64x64:r=4:d=3", "-c:v", "mpeg4", str(source / "flight.mp4")], check=True)
    (source / "flight.srt").write_text(
        cue("00:00:01,000", "00:00:01,500", lat=48.1)
        + cue("00:00:01,500", "00:00:02,000", lat=48.2)
        + cue("00:00:02,000", "00:00:02,500", lat=48.3))
    monkeypatch.setattr(capture.client, "check_cancelled", Mock())
    monkeypatch.setattr(capture.client, "report_progress", Mock())
    prepared = capture.prepare_capture({"id": "job", "options": {"preparing": {
        "videoStartSeconds": 1, "videoEndSeconds": 2.5, "videoFrameIntervalSeconds": .5}}}, source, work)
    frames = sorted(prepared.rglob("*.jpg"))
    assert len(frames) == 3
    assert [coordinates(frame)[0] for frame in frames] == pytest.approx([48.1, 48.2, 48.3])


def test_fractional_sampling_boundary_uses_next_cue(tmp_path):
    subtitle = tmp_path / "flight.srt"
    subtitle.write_text(cue("00:00:00,000", "00:00:00,900", lat=48.1)
                        + cue("00:00:00,900", "00:00:01,200", lat=48.2))
    frames = []
    for index in range(4):
        frame = tmp_path / f"{index}.jpg"
        Image.new("RGB", (32, 32)).save(frame); frames.append(frame)
    assert geotag_frames(frames, subtitle, 0, .3, lambda: None) == 4
    assert coordinates(frames[-1])[0] == pytest.approx(48.2)
