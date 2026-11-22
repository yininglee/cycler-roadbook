import assert from 'node:assert/strict';
import test from 'node:test';
import { getProvider } from '../lib/providers.mjs';

test('the map provider retries throttled cycling requests and preserves the upstream error code', async t => {
  const keys = ['AMAP_WEB_KEY', 'AMAP_JS_KEY', 'AMAP_JS_SECRET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'test-key';
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', () => {
    requested.push(performance.now());
    return requested.length === 2
      ? Response.json({ status: '1', route: { paths: [{ distance: '1000', steps: [{ polyline: '120,30;120.01,30' }] }] } })
      : Response.json({ status: '0', infocode: '10021' });
  });
  const provider = getProvider();
  const from = { coords: [120, 30] };
  const to = { coords: [120.01, 30] };
  assert.equal((await provider.leg(from, to)).distance, 1000);
  assert.equal(requested.length, 2);
  assert.ok(requested[1] - requested[0] >= 1000);
  await assert.rejects(provider.leg(from, to), { code: '10021', status: 503 });
  assert.equal(requested.length, 4);
});
