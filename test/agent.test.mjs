import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../lib/agent.mjs';
import { distanceMeters, positionAtDistance } from '../lib/geo.mjs';
import { getProvider } from '../lib/providers.mjs';

const openRequest = '从西湖文化广场出发，骑 40 公里左右，尽量少爬升。不限终点';
const demo = getProvider();

test('an open endpoint yields a one-way route and a follow-up preserves the start and preferences', async () => {
  const first = await runAgent(demo, { prompt: openRequest }, null);
  assert.equal(first.context.intent.destination, 'open');
  assert.ok(first.candidates.length);
  assert.ok(first.candidates.every(route => !route.loop && route.canApply &&
    route.points[0].name === '西湖文化广场' && route.points.at(-1).id !== route.points[0].id));
  assert.ok(Math.abs(first.candidates[0].distance - 40000) < 6000);

  const followUp = await runAgent(demo, { prompt: '改成 30 公里左右', context: first.context }, null);
  assert.equal(followUp.context.intent.targetKm, 30);
  assert.equal(followUp.context.intent.lowClimb, true);
  assert.equal(followUp.context.intent.destination, 'open');
  assert.equal(followUp.candidates[0].points[0].id, first.candidates[0].points[0].id);
});

test('current-location prompts route from the supplied coordinates without looking up a place name', async () => {
  const location = [121.4737, 31.2304];
  const destination = { id: 'end', name: '终点公园', coords: positionAtDistance(location, 90, 15000) };
  const provider = {
    kind: 'test',
    find: async name => assert.fail(`Unexpected place lookup: ${name}`),
    nearby: async () => [destination],
    leg: async (from, to) => ({ geometry: [from.coords, to.coords], distance: 20000 }),
    elevations: async () => null,
  };
  const prompt = '从当前位置出发，骑 20 公里左右，尽量少爬升，终点不限。';
  const result = await runAgent(provider, { prompt, location }, async messages => {
    if (messages.length > 2) return { action: 'finish' };
    const input = JSON.parse(messages[1].content);
    assert.equal(input.locationAvailable, true);
    assert.equal(input.location, undefined);
    return { action: 'plan_route', mode: 'new', intent: { destination: 'open', targetKm: 20, lowClimb: true } };
  });
  assert.deepEqual(result.candidates[0].points[0].coords, location);
  assert.equal(result.candidates[0].points[0].name, '定位起点');
  const missing = await runAgent(provider, { prompt, location: [999, 0] }, null);
  assert.equal(missing.context.waitingFor, 'start');
  assert.match(missing.question, /请先在地图上定位/);

  const loop = await runAgent({ ...provider,
    nearby: async coords => [{ id: coords.join(','), name: '环线途经点', coords }],
    leg: async (from, to) => ({ geometry: [from.coords, to.coords], distance: distanceMeters(from.coords, to.coords) * 1.3 }),
  }, { prompt: '从当前位置出发，骑一条 30 公里左右的环线，最后回到起点。', location }, null);
  assert.ok(loop.candidates.some(route => route.canApply && route.loop && Math.abs(route.distance - 30000) < 100));
  assert.deepEqual(loop.candidates[0].geometry.at(-1), location);

  const selected = { id: 'start', name: '已选地名', coords: [121.49, 31.22] };
  const named = await runAgent(provider, {
    prompt: `从${selected.name}出发，骑 20 公里左右，终点不限。`, points: [selected], location,
  }, null);
  assert.deepEqual(named.candidates[0].points[0], selected);
});

test('the route tool returns measured feedback and tries wider search without changing constraints', async () => {
  const home = { id: 'home', name: '起点公园', coords: [120, 30] };
  const short = { id: 'short', name: '近处公园', coords: positionAtDistance(home.coords, 0, 16000) };
  const target = { id: 'target', name: '远处公园', coords: positionAtDistance(home.coords, 30, 33500) };
  const centers = [];
  let searches = 0;
  const provider = {
    kind: 'test',
    find: async name => {
      assert.equal(name, home.name);
      searches++;
      return [home, { ...home, id: 'station', name: '起点公园地铁站' }];
    },
    nearby: async coords => {
      centers.push(coords);
      return distanceMeters(home.coords, coords) > 40000 ? [target] : [short];
    },
    leg: async (from, to) => ({ geometry: [from.coords, to.coords], distance: to.id === target.id ? 40000 : 20000 }),
    elevations: async () => null,
  };
  let step = 0;
  const decide = async messages => {
    switch (step++) {
      case 0: return { action: 'search_places', query: home.name };
      case 1:
        assert.match(messages.at(-1).content, /起点公园地铁站/);
        return { action: 'plan_route', mode: 'new', intent: {
          start: home.name, destination: 'open', targetKm: 40, maxDistanceKm: 45, maxClimbM: 100,
        } };
      case 2:
        assert.match(messages.at(-1).content, /"status":"too_short"/);
        assert.match(messages.at(-1).content, /"km":20/);
        return { action: 'plan_route', searchTerms: ['绿道'], intent: { maxClimbM: null, maxDistanceKm: 100 } };
      default:
        assert.match(messages.at(-1).content, /"status":"climb_unknown"/);
        return { action: 'finish' };
    }
  };
  const result = await runAgent(provider, {
    prompt: '从起点公园出发，骑 40 公里左右，最多 45 公里，累计爬升不超过 100 米，终点不限',
  }, decide);
  assert.equal(step, 4);
  assert.equal(searches, 1);
  assert.equal(centers.length, 12);
  assert.ok(distanceMeters(centers[0], centers[1]) > 10000);
  assert.ok(distanceMeters(home.coords, centers[6]) > distanceMeters(home.coords, centers[0]));
  assert.equal(result.candidates[0].points.at(-1).id, target.id);
  assert.equal(result.context.intent.maxDistanceKm, 45);
  assert.equal(result.context.intent.maxClimbM, 100);
  assert.equal(result.candidates[0].canApply, false);
  assert.ok(result.candidates[0].rules.some(rule => rule.hard && rule.status === 'unknown'));
});

test('choosing between exact same-name starts resumes the plan and preserves its route conditions', async () => {
  const matches = await demo.find('西湖文化广场');
  const provider = { ...demo, find: async name => name === '西湖文化广场' ?
    [...matches, { ...matches[0], id: 'another-square' }] : demo.find(name) };
  const first = await runAgent(provider, { prompt: openRequest }, null);
  assert.equal(first.ambiguous[0].places.length, 2);
  const next = await runAgent(provider, {
    prompt: openRequest, resume: true, context: first.context, selections: { 西湖文化广场: matches[0].id },
  }, null);
  assert.equal(next.context.intent.targetKm, 40);
  assert.equal(next.context.intent.lowClimb, true);
  assert.ok(next.candidates.every(route => route.points[0].id === matches[0].id && !route.loop));
});

test('a local edit to an open-end candidate keeps its endpoints and earlier constraints', async () => {
  const first = await runAgent(demo, { prompt: openRequest }, null);
  const original = first.candidates[0];
  const followUp = await runAgent(demo, {
    prompt: '加上六和塔作为途经点',
    preview: original,
    context: first.context,
  }, null);
  const revised = followUp.candidates.find(route => route.canApply);
  assert.equal(revised.points[0].id, original.points[0].id);
  assert.equal(revised.points.at(-1).id, original.points.at(-1).id);
  assert.ok(revised.points.slice(1, -1).some(point => point.name === '六和塔'));
  assert.match(followUp.question, /途经点新增「六和塔」/);
  assert.equal(followUp.context.intent.destination, 'open');
  assert.equal(followUp.context.intent.targetKm, 40);
  assert.equal(followUp.context.intent.lowClimb, true);

  const shortened = await runAgent(demo, {
    prompt: '改成 30 公里左右',
    preview: revised,
    context: followUp.context,
  }, null);
  assert.equal(shortened.context.holdEnd, false);
  assert.ok(shortened.candidates.every(route => route.points.some(point => point.name === '六和塔')));

  const moved = await runAgent(demo, {
    prompt: '把终点换成钱江新城，保留途经点',
    preview: revised,
    context: followUp.context,
  }, null);
  assert.equal(moved.candidates[0].points.at(-1).name, '钱江新城');
  assert.ok(moved.candidates[0].points.some(point => point.name === '六和塔'));
  assert.match(moved.question, /终点改为「钱江新城」/);
});

test('the next model turn receives the selected route and previous exchange', async () => {
  const initial = await runAgent(demo, {
    prompt: '从西湖文化广场出发，途经六和塔，骑到湘湖',
  }, null);
  const route = initial.candidates[0];
  const next = await runAgent(demo, {
    prompt: '把刚才的途经点换成复兴大桥',
    preview: route,
    history: [{ prompt: '从西湖文化广场出发，途经六和塔，骑到湘湖', reply: initial.question }],
    context: initial.context,
  }, async messages => {
    if (messages.length > 2) return { action: 'finish' };
    const input = JSON.parse(messages[1].content);
    assert.deepEqual(input.current, ['西湖文化广场', '六和塔', '湘湖']);
    assert.match(input.history[0].prompt, /六和塔/);
    assert.equal(input.km, Math.round(route.distance / 100) / 10);
    return { action: 'plan_route', mode: 'revise', intent: { via: ['复兴大桥'] } };
  });
  assert.deepEqual(next.candidates[0].points.map(point => point.name), ['西湖文化广场', '复兴大桥', '湘湖']);
});

test('a saved route remains the reference even when a different candidate is previewed', async () => {
  const initial = await runAgent(demo, { prompt: openRequest }, null);
  const [first, savedRoute, preview] = initial.candidates;
  assert.notEqual(savedRoute.points.at(-1).id, preview.points.at(-1).id);
  const next = await runAgent(demo, {
    prompt: '加上六和塔作为途经点',
    points: savedRoute.points,
    loop: savedRoute.loop,
    saved: true,
    preview,
    context: initial.context,
    history: [{ prompt: openRequest, candidates: [first.points.at(-1).name, preview.points.at(-1).name] }],
  }, async messages => {
    if (messages.length > 2) return { action: 'finish' };
    const input = JSON.parse(messages[1].content);
    assert.equal(input.saved, true);
    assert.deepEqual(input.current, savedRoute.points.map(point => point.name));
    return { action: 'plan_route', mode: 'new', intent: { via: ['六和塔'] } };
  });
  assert.equal(next.context.mode, 'revise');
  assert.equal(next.context.intent.targetKm, 40);
  assert.equal(next.candidates[0].points.at(-1).id, savedRoute.points.at(-1).id);
});

test('along-route stops use requested categories and preserve the saved point order', async () => {
  const origin = { id: 'start', name: '起点', coords: [120, 30] };
  const at = (id, name, distance) => ({ id, name, coords: positionAtDistance(origin.coords, 90, distance) });
  const middle = at('existing', '原有途经点', 11000);
  const end = at('end', '原有终点', 28000);
  const queries = [];
  const provider = {
    kind: 'test',
    routeStopsNearby: async (coords, query, radius) => {
      queries.push({ coords, query, radius });
      return [at('far', '很远的地点', 52000), at('near', '可骑达地点', 17000)];
    },
    leg: async (from, to) => ({
      geometry: [from.coords, to.coords], distance: distanceMeters(from.coords, to.coords),
    }),
    elevations: async () => null,
  };
  const base = { saved: true, points: [origin, middle, end], context: { intent: { maxDistanceKm: 35 } } };
  for (const [prompt, category, visit] of [
    ['途中增加住宿的地方', '住宿', 'stop'],
    ['途中增加吃饭的地方', '餐饮', 'stop'],
    ['途中加一个景点作为签到点', '景点', 'checkpoint'],
  ]) {
    const result = await runAgent(provider, { ...base, prompt }, async () => {
      assert.fail('a supported short command should use the route tool directly');
    });
    const route = result.candidates[0];
    assert.deepEqual(route.points.map(point => point.id), ['start', 'existing', 'near', 'end']);
    assert.equal(route.points[2].visit, visit);
    assert.equal(route.points[2].stopType, category);
    assert.equal(route.canApply, true);
    assert.equal(result.context.intent.maxDistanceKm, 35);
    const searches = queries.splice(0);
    assert.ok(searches.length >= 3 && searches.length <= 7);
    assert.ok(searches.every(search => search.query === category && distanceMeters(origin.coords, search.coords) > 3000));
  }
  const custom = await runAgent(provider, { ...base, prompt: '想在路上找家轮胎维修店', context: { intent: { maxDistanceKm: 25 } } },
    async () => ({ action: 'add_route_stop', query: '轮胎维修店' }));
  assert.equal(custom.candidates[0].points[2].stopType, '轮胎维修店');
  assert.equal(custom.candidates[0].canApply, false);
});

test('model timeouts report a model-specific service error', async () => {
  await assert.rejects(runAgent(demo, { prompt: '想走一条风景更好的线路' }, async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  }), { message: '路线助手响应超时，请重试。', status: 504 });
});
