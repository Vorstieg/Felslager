import express from 'express';
import crypto from 'node:crypto';

// An HTTP contract double; real deployment execution is covered by Python tests.
export async function prefectServer(t) {
  const runs = new Map();
  const app = express();
  app.use(express.json());
  app.get('/api/deployments/name/:flow/:name', (req, res) => res.json({ id: req.params.name }));
  app.post('/api/deployments/:id/create_flow_run', (req, res) => {
    const run = { id: crypto.randomUUID(), deployment: req.params.id, ...req.body };
    runs.set(run.id, run); res.json(run);
  });
  app.get('/api/flow_runs/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.sendStatus(404);
    res.json(run);
  });
  app.post('/api/flow_runs/:id/set_state', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.sendStatus(404);
    run.state = req.body.state;
    res.json({ status: 'ACCEPT', state: run.state });
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/api`, runs,
    state: (id, type, message) => { runs.get(id).state = { type, message }; } };
}
