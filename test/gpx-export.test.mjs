import assert from 'node:assert/strict';
import test from 'node:test';
import coordinateTransform from 'coordtransform';
import { distanceMeters } from '../lib/geo.mjs';
import { prepareExport, preparedGpx } from '../lib/gpx-export.mjs';

const provider = { elevations: async () => null };
const path = [[113.24, 23.12], [113.25, 23.115], [113.26, 23.11], [113.25, 23.12], [113.24, 23.12]];
const points = [path[0], path[2]].map((coords, index) => ({
  id: String(index), name: `点位 ${index + 1}`, coords: coordinateTransform.wgs84togcj02(...coords),
}));

test('a confirmed preview preserves loop stops and exports exactly its WGS84 track', async t => {
  const downstream = t.mock.method(globalThis, 'fetch', async url => {
    assert.match(url.pathname, /\/route\/v1\/driving\//);
    const requested = url.pathname.split('/').at(-1).split(';').map(point => point.split(',').map(Number));
    assert.equal(requested.length, 3);
    assert.deepEqual(requested[0], requested.at(-1));
    assert.ok(distanceMeters(requested[1], path[2]) < 5);
    assert.equal(url.searchParams.get('geometries'), 'geojson');
    return Response.json({
      code: 'Ok', waypoints: [path[0], path[2], path[0]].map(location => ({ location })),
      routes: [{ geometry: { type: 'LineString', coordinates: path }, distance: 4200, legs: [{}, {}] }],
    });
  });
  await assert.rejects(prepareExport(provider, { points }), /请先确认/);
  assert.equal(downstream.mock.callCount(), 0);
  assert.throws(() => preparedGpx('missing'), { status: 410 });

  const preview = await prepareExport(provider, { confirmed: true, points, loop: true, name: '广州 & 环线' });
  const file = preparedGpx(preview.token);
  assert.equal(downstream.mock.callCount(), 1);
  assert.equal(preview.distance, 4200);
  assert.deepEqual(preview.geometry[0], points[0].coords);
  assert.match(file, /<name>广州 &amp; 环线<\/name>/);
  assert.match(file, /OpenStreetMap contributors/);
  assert.deepEqual([...file.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)].map(([, lat, lon]) => [Number(lon), Number(lat)]), path);
});
