import assert from 'node:assert/strict';
import test from 'node:test';
import { getProvider } from '../lib/providers.mjs';
import { buildRoute, checkRoute, demoGpx, planFromIntent, readIntent } from '../lib/planner.mjs';
import { demoPlaces } from '../public/demo.js';

const demo = getProvider();
const byId = (...ids) => ids.map(id => demoPlaces.find(place => place.id === id));

test('edits preserve direction and update both the geometry and distance', async () => {
  const original = await buildRoute(demo, byId('hub', 'lake', 'river'), false);
  const changed = await buildRoute(demo, byId('hub', 'tower', 'river'), false);
  assert.deepEqual(changed.geometry[0], changed.points[0].coords);
  assert.deepEqual(changed.geometry.at(-1), changed.points.at(-1).coords);
  assert.ok(changed.geometry.some(coords => coords.join(',') === changed.points[1].coords.join(',')));
  assert.notEqual(changed.distance, original.distance);
});

test('parsing a named waypoint preserves characters such as 和', async () => {
  const intent = await readIntent('从西湖文化广场出发，途经六和塔，骑到湘湖，中途需要补给。');
  assert.deepEqual(intent.via, ['六和塔']);
  const result = await planFromIntent(demo, intent);
  const route = result.candidates.find(candidate => candidate.canApply);
  assert.ok(route?.points.some(place => place.id === 'tower'));
  assert.ok(route?.points.some(place => ['shop', 'river'].includes(place.id)));
});

test('loop candidates close, and unmet or unverifiable limits fail automated verification', async () => {
  const intent = await readIntent('从西湖文化广场出发，骑40公里左右的环线。');
  const generated = await planFromIntent(demo, intent);
  assert.ok(generated.candidates.some(route => route.canApply));
  assert.ok(generated.candidates.every(route => route.geometry.at(-1).join(',') === route.geometry[0].join(',')));

  const constrained = { ...intent, loop: false, maxClimbM: 400, maxDistanceKm: 50 };
  for (const [distance, climb, canApply] of [[50000, 400, true], [50040, 400, false], [49900, 400.4, false], [49900, null, false]]) {
    assert.equal(checkRoute({ distance, climb }, constrained).canApply, canApply);
  }
  const reviewed = checkRoute({ distance: 50040, climb: null }, constrained);
  assert.deepEqual(reviewed.rules.filter(rule => rule.hard).map(({ status, detail }) => [status, detail]), [
    ['fail', '里程为 50.04 km，超过上限'],
    ['unknown', '缺少高程数据，无法核实爬升'],
  ]);
});

test('connected routes remain available for review when no required supply stop is found', async () => {
  const intent = await readIntent('从西湖文化广场出发，骑到湘湖，中途需要补给。');
  const result = await planFromIntent({ ...demo, nearby: async () => [] }, intent);
  assert.ok(result.candidates.length);
  for (const route of result.candidates) {
    assert.ok(route.geometry.length > 1);
    assert.equal(route.canApply, false);
    assert.ok(route.rules.some(rule => rule.status === 'unknown' && rule.detail.includes('没有已匹配的补给点')));
  }
});

test('disconnected segments never produce an exportable route', async () => {
  const provider = {
    leg: async (from, to) => ({ geometry: [from.id === 'lake' ? [120.133, 30.236] : from.coords, to.coords], distance: 1000 }),
    elevations: async () => null,
  };
  await assert.rejects(buildRoute(provider, byId('hub', 'lake', 'river'), false), error => {
    assert.match(error.message, /拼接/);
    assert.equal(error.issues[0].type, 'disconnected');
    assert.deepEqual(error.issues[0].geometry, [[120.132, 30.236], [120.133, 30.236]]);
    return true;
  });
  await assert.rejects(buildRoute({ ...provider, leg: async () => null }, byId('hub', 'lake', 'river'), false), error => {
    assert.deepEqual(error.issues.map(issue => issue.geometry), [
      byId('hub', 'lake').map(point => point.coords), byId('lake', 'river').map(point => point.coords),
    ]);
    return true;
  });
});

test('GPX includes an escapable demo name and track points in route order', () => {
  const output = demoGpx('西湖 & 湘湖 <环线>', [[120.161, 30.279], [120.226, 30.148]]);
  assert.match(output, /西湖 &amp; 湘湖 &lt;环线&gt;/);
  assert.match(output, /<trkseg>\s*<trkpt lat="30\.279000" lon="120\.161000"\/>\s*<trkpt lat="30\.148000" lon="120\.226000"\/>/);
});
