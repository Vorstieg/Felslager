import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpServer } from '../http-server.js';
import { loadConfig } from '../config.js';

test('production HTTP server allows long uploads while retaining the header deadline', async (t) => {
  const env = { BETTER_AUTH_SECRET: 'a-secret-longer-than-thirty-two-characters',
    AUTH_DATABASE_PATH: '/srv/private/auth.sqlite' };
  for (const [overrides, expected] of [[{}, 21600000], [{ HTTP_REQUEST_TIMEOUT_MS: '43200000' }, 43200000]]) {
    const server = createHttpServer((req, res) => res.end('ok'), loadConfig({ ...env, ...overrides }));
    assert.equal(server.requestTimeout, expected);
    assert.equal(server.headersTimeout, 60000);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'ok');
  }
  for (const value of ['0', '-1', '59999', 'NaN', 'Infinity', '60000.5', '9007199254740992', ''])
    assert.throws(() => loadConfig({ ...env, HTTP_REQUEST_TIMEOUT_MS: value }), /HTTP_REQUEST_TIMEOUT_MS/);
});
