"""Conservative, mesh-seeded multi-view estimation with fixed camera calibration.

All spatial gates scale with camera distance; no metric reconstruction is assumed.
Ambiguous matches retain their original triangle positions.
"""
from itertools import combinations

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial import cKDTree

from ..reconstruction import project_pixels

MIN_ANGLE = 2.0
MAX_ERROR = 6.0  # Calibration pixels, independent of source-image resizing.
SURFACE_RATIO = 0.03
MAX_TRACK = 64


def angle(a, b):
    return float(np.degrees(np.arccos(np.clip(a @ b, -1, 1))))


def triangulate(observations):
    matrices = [np.eye(3) - np.outer(o["ray"], o["ray"]) for o in observations]
    matrix = np.sum(matrices, axis=0)
    if np.linalg.cond(matrix) > 1e8:
        return None
    return np.linalg.solve(matrix, sum(m @ o["cam"]["center"] for m, o in zip(matrices, observations)))


def errors(point, observations):
    result = []
    for o in observations:
        local = o["cam"]["R"] @ (point - o["cam"]["center"])
        result.append(float(np.linalg.norm(project_pixels(o["cam"], [point])[0] - o["pixel"]))
                      if local[2] > 0 else np.inf)
    return np.asarray(result)


def near_surface(point, observations):
    # Compare to actual visible surface intersections, avoiding nearest-vertex
    # density bias and preventing estimates from jumping to a hidden surface.
    return all(np.linalg.norm(point - o["surface"]) <= SURFACE_RATIO * o["distance"]
               for o in observations)


def estimate(observations):
    """Deterministic pair consensus followed by robust pixel-error refinement."""
    best, best_mask, best_score = None, None, (-1, -np.inf)
    # Bound work on long video tracks; sample pairs across the entire track.
    pairs = list(combinations(range(len(observations)), 2))
    if len(pairs) > 256:
        pairs = [pairs[i] for i in np.linspace(0, len(pairs) - 1, 256, dtype=int)]
    for i, j in pairs:
        pair = [observations[i], observations[j]]
        if not MIN_ANGLE <= angle(pair[0]["ray"], pair[1]["ray"]) <= 175:
            continue
        point = triangulate(pair)
        if point is None or not np.isfinite(point).all():
            continue
        residuals = errors(point, observations)
        mask = residuals <= MAX_ERROR
        score = (int(mask.sum()), -float(np.sum(np.minimum(residuals, MAX_ERROR))))
        if score > best_score:
            best, best_mask, best_score = point, mask, score
    required = max(3, int(np.ceil(len(observations) * 0.6)))
    if best is None or best_mask.sum() < required:
        return None
    inliers = [o for o, keep in zip(observations, best_mask) if keep]

    def residual(point):
        return np.concatenate([(project_pixels(o["cam"], [point])[0] - o["pixel"])
                               * np.sqrt(np.clip(o["confidence"], 0.1, 1)) for o in inliers])

    fit = least_squares(residual, best, loss="soft_l1", f_scale=2, max_nfev=100)
    if not fit.success or not np.isfinite(fit.x).all():
        return None
    mask = errors(fit.x, observations) <= MAX_ERROR
    # Never add observations after refinement without fitting them.
    mask &= best_mask
    if mask.sum() < required or not np.array_equal(mask, best_mask):
        return None
    inliers = [o for o, keep in zip(observations, mask) if keep]
    spread = max(angle(a["ray"], b["ray"]) for a, b in combinations(inliers, 2))
    if not MIN_ANGLE <= spread <= 175 or not near_surface(fit.x, inliers):
        return None
    return fit.x, mask, errors(fit.x, inliers), spread


def refine_hits(hits, observations, check_cancelled=lambda: None):
    """Preserve one hit per observation, adding shared track IDs for inliers."""
    if not hits:
        return []
    tree = cKDTree([o["surface"] for o in observations])
    edges = [set() for _ in hits]
    for i, o in enumerate(observations):
        check_cancelled()
        # Crowded regions are deliberately left for manual inspection.
        neighbours = tree.query_ball_point(o["surface"], SURFACE_RATIO * o["distance"])
        if len(neighbours) > MAX_TRACK:
            hits[i]["positioning"]["fallbackReason"] = "crowded_region"
            continue
        by_image = {}
        for j in neighbours:
            other = observations[j]
            if hits[i]["img"] == hits[j]["img"] or hits[i]["class"].lower() != hits[j]["class"].lower():
                continue
            if not MIN_ANGLE <= angle(o["ray"], other["ray"]) <= 175:
                continue
            point = triangulate([o, other])
            if point is None or not np.isfinite(point).all():
                continue
            if np.max(errors(point, [o, other])) <= MAX_ERROR and near_surface(point, [o, other]):
                by_image.setdefault(hits[j]["img"], []).append(j)
        for matches in by_image.values():
            if len(matches) == 1:
                edges[i].add(matches[0])
            else:
                hits[i]["positioning"]["fallbackReason"] = "ambiguous_match"
    # Only reciprocal, unambiguous matches can join a track.
    graph = [{j for j in links if i in edges[j]} for i, links in enumerate(edges)]
    visited, tracks = set(), []
    for seed in range(len(hits)):
        if seed in visited:
            continue
        pending, members = [seed], []
        while pending:
            i = pending.pop()
            if i in visited:
                continue
            visited.add(i)
            members.append(i)
            pending.extend(graph[i] - visited)
        members.sort()
        if len(members) < 3:
            continue
        check_cancelled()
        if len(members) > MAX_TRACK or len({hits[i]["img"] for i in members}) != len(members):
            for i in members:
                hits[i]["positioning"]["fallbackReason"] = "ambiguous_track"
            continue
        result = estimate([observations[i] for i in members])
        if result is None:
            for i in members:
                hits[i]["positioning"]["fallbackReason"] = "inconsistent_geometry"
            continue
        point, mask, residuals, spread = result
        accepted = [i for i, keep in zip(members, mask) if keep]
        track_id = f"track_{len(tracks):05d}"
        tracks.append({"id": track_id, "position": point.tolist(), "hitIndices": accepted,
                       "reprojectionRmsPx": float(np.sqrt(np.mean(residuals ** 2))),
                       "viewAngleDeg": spread})
        for i, keep in zip(members, mask):
            if not keep:
                hits[i]["positioning"]["fallbackReason"] = "reprojection_outlier"
                continue
            hit, o = hits[i], observations[i]
            hit["pos"] = point.tolist()
            hit["cam_dist"] = float(np.linalg.norm(point - o["cam"]["center"]))
            hit["positioning"].update(method="multiview", trackId=track_id, fallbackReason=None,
                                      reprojectionErrorPx=float(errors(point, [o])[0]),
                                      surfaceOffset=float(np.linalg.norm(point - o["surface"])))
    return tracks
