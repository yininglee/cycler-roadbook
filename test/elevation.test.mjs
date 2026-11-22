import assert from 'node:assert/strict';
import test from 'node:test';
import pngjs from 'pngjs';
import { configuredElevationSource, lookupElevations } from '../lib/elevation.mjs';

function setElevationConfig(t, provider, customUrl) {
  for (const [key, value] of [['ELEVATION_PROVIDER', provider], ['ELEVATION_URL', customUrl]]) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const points = [[120.150, 30.24], [120.151, 30.241]];

test('Terrain Tiles decodes Terrarium heights and shares tile reads across points and calls', async t => {
  setElevationConfig(t, 'terrain-tiles');
  const png = new pngjs.PNG({ width: 256, height: 256 });
  png.data.fill(Buffer.from([128, 51, 128, 255]));
  const body = pngjs.PNG.sync.write(png);
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    assert.match(url, /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/12\/3414\/1686\.png$/);
    return new Response(body);
  });
  assert.equal(configuredElevationSource(), 'terrain-tiles');
  assert.deepEqual(await lookupElevations(points), [51.5, 51.5]);
  assert.deepEqual(await lookupElevations(points.toReversed()), [51.5, 51.5]);
  assert.equal(fetch.mock.callCount(), 1);
});

test('custom URLs retain precedence and the existing GCJ-02 request contract', async t => {
  setElevationConfig(t, 'terrain-tiles', 'https://elevation.example/lookup');
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, 'https://elevation.example/lookup');
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { coordinateSystem: 'GCJ-02', coordinates: points });
    return Response.json({ elevations: [10, 60] });
  });
  assert.equal(configuredElevationSource(), 'custom');
  assert.deepEqual(await lookupElevations(points), [10, 60]);
});
