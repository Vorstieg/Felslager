import { createServer } from 'node:http';

export function createHttpServer(app, config) {
  // Node's five-minute default includes the entire upload, even while data flows.
  return createServer({
    requestTimeout: config.requestTimeoutMs ?? 6 * 60 * 60 * 1000,
    headersTimeout: 60000,
  }, app);
}
