// Prefect owns scheduling and execution state; Felslager owns private files.
export function createPrefect(config) {
  const base = (config.prefectApiUrl || 'http://127.0.0.1:4200/api').replace(/\/$/, '');
  const request = async (route, body) => {
    try {
      const response = await fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Prefect returned ${response.status}`);
      return response.status === 204 ? undefined : await response.json();
    } catch (cause) {
      throw Object.assign(new Error('PREFECT_UNAVAILABLE', { cause }), { status: 503 });
    }
  };
  return {
    request,
    state: (id, type) => request(`/flow_runs/${id}/set_state`, { state: { type }, force: true }),
    create: async (job) => {
      const deployment = await request(job.sourceProcessingId
        ? '/deployments/name/Felslager%20detection/detection'
        : `/deployments/name/Felslager%20reconstruction/reconstruct-${job.engine}`);
      // Bind the run to private storage before making it eligible for execution.
      return request(`/deployments/${deployment.id}/create_flow_run`, {
        name: `processing-${job.id}`, parameters: { job_id: job.id },
        idempotency_key: job.id, state: { type: 'PAUSED', name: 'Awaiting admission' },
      });
    },
  };
}

export async function processingState(config, job) {
  if (!job.flowRunId) return { status: ['completed', 'failed', 'cancelled'].includes(job.status) ? job.status : 'failed',
    error: job.error || 'Legacy processing run; start a new job.' };
  const run = await createPrefect(config).request(`/flow_runs/${job.flowRunId}`);
  const type = run.state.type;
  const status = { COMPLETED: 'failed', FAILED: 'failed', CRASHED: 'failed',
    CANCELLED: 'cancelled', CANCELLING: 'processing', RUNNING: 'processing' }[type] || 'queued';
  return { status, ...(type === 'CANCELLING' ? { cancelRequested: true } : {}),
    ...(['failed', 'cancelled'].includes(status) ? { finishedAt: run.end_time || run.state.timestamp } : {}),
    ...(status === 'failed' ? { error: run.state.message || 'Processing ended without a result.' } : {}) };
}
