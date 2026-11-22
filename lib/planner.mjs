import { distanceMeters, positionAtDistance, samplePositions, validPosition } from './geo.mjs';

export { readIntent } from './intent.mjs';

export class PlanningError extends Error {}
const routedLegs = Symbol('routed legs');
const legKey = (from, to) => JSON.stringify([from.id, from.coords, to.id, to.coords]);

export function seedRouteLegs(cache, route) {
  for (const [key, leg] of route?.[routedLegs] ?? []) cache.set(key, leg);
}

export function normalizePoints(points) {
  if (!Array.isArray(points) || points.length > 12) throw new PlanningError('首版最多支持 12 个路线点。');
  return points.map(point => {
    if (!point || typeof point.id !== 'string' || typeof point.name !== 'string' || !validPosition(point.coords)) {
      throw new PlanningError('有一个路线点无效，请重新选择。');
    }
    const visit = ['stop', 'checkpoint'].includes(point.visit) ? point.visit : null;
    const stopType = typeof point.stopType === 'string' ? point.stopType.slice(0, 40) : '';
    return { id: point.id.slice(0, 160), name: point.name.slice(0, 120), coords: point.coords,
      ...(visit ? { visit, stopType } : {}) };
  });
}

function climbFrom(values, length) {
  if (!Array.isArray(values) || values.length !== length || !values.every(Number.isFinite)) return null;
  const smooth = values.map((height, index) => (values[index - 1] ?? height) / 4 + height / 2 + (values[index + 1] ?? height) / 4);
  return smooth.slice(1).reduce((total, height, index) => total + Math.max(0, height - smooth[index]), 0);
}

export async function buildRoute(provider, input, loop, savedLegs = new Map()) {
  const points = normalizePoints(input);
  if (points.length < 2) throw new PlanningError(loop ? '请添加至少一个环线途经点。' : '请设置起点和终点。');
  const sequence = loop ? [...points, points[0]] : points;
  const legPairs = sequence.slice(1).map((to, index) => ({ from: sequence[index], to }));
  const keys = legPairs.map(({ from, to }) => legKey(from, to));
  const legs = await Promise.all(legPairs.map(async ({ from, to }) => {
    if (distanceMeters(from.coords, to.coords) < 5) throw new PlanningError(`「${from.name}」与「${to.name}」距离过近，请调整点位。`);
    const key = legKey(from, to);
    if (!savedLegs.has(key)) savedLegs.set(key, Promise.resolve().then(() => provider.leg(from, to)).catch(error => {
      savedLegs.delete(key);
      throw error;
    }));
    const leg = await savedLegs.get(key);
    if (!leg || distanceMeters(from.coords, leg.geometry[0]) > 100 ||
        distanceMeters(to.coords, leg.geometry.at(-1)) > 100) {
      throw new PlanningError(`无法连接「${from.name}」和「${to.name}」，请调整点位。`);
    }
    return leg;
  }));
  const geometry = [...legs[0].geometry];
  const legEnds = [geometry.length - 1];
  for (const leg of legs.slice(1)) {
    const gap = distanceMeters(geometry.at(-1), leg.geometry[0]);
    if (gap > 35) throw new PlanningError('途经点附近的骑行轨迹无法连续拼接，请调整位置。');
    geometry.push(...leg.geometry.slice(gap < 1 ? 1 : 0));
    legEnds.push(geometry.length - 1);
  }
  if (loop && distanceMeters(geometry[0], geometry.at(-1)) > 35) throw new PlanningError('环线在起点未闭合，请调整出发点。');
  const distance = legs.reduce((sum, leg) => sum + leg.distance, 0);
  const { climb, profile } = await estimateRouteElevation(provider, geometry, distance);
  const duration = legs.every(leg => Number.isFinite(leg.duration)) ? legs.reduce((sum, leg) => sum + leg.duration, 0) : null;
  return { points, loop, geometry, legEnds, distance, duration, climb, profile,
    [routedLegs]: keys.map((key, index) => [key, legs[index]]) };
}

export function sectionDistance(route, from, to) {
  return route[routedLegs].slice(from, to).reduce((distance, [, leg]) => distance + leg.distance, 0);
}

export async function estimateRouteElevation(provider, geometry, distance) {
  const samples = samplePositions(geometry, Math.max(100, distance / 500));
  let elevations = null;
  try { elevations = await provider.elevations(samples); } catch {}
  const climb = climbFrom(elevations, samples.length);
  return { climb, profile: climb === null ? null : elevations };
}

const km = value => (value / 1000).toFixed(1);

export function checkRoute(route, intent) {
  const rules = [];
  const describeLimit = (value, limit, unit, label, actual, passes) => {
    if (limit === null) return;
    rules.push({ label, status: value === null ? 'unknown' : passes ? 'pass' : 'fail',
      detail: value === null ? '数据待核实' : `${actual} ${unit}`, hard: true });
  };
  describeLimit(route.distance, intent.maxDistanceKm, 'km', `里程不超过 ${intent.maxDistanceKm} km`,
    Number((route.distance / 1000).toFixed(3)), route.distance <= intent.maxDistanceKm * 1000);
  describeLimit(route.distance, intent.minDistanceKm, 'km', `里程至少 ${intent.minDistanceKm} km`,
    Number((route.distance / 1000).toFixed(3)), route.distance >= intent.minDistanceKm * 1000);
  describeLimit(route.climb, intent.maxClimbM, 'm', `爬升不超过 ${intent.maxClimbM} m`,
    route.climb === null ? null : Number(route.climb.toFixed(1)), route.climb <= intent.maxClimbM);
  if (intent.targetKm !== null) {
    const difference = route.distance - intent.targetKm * 1000;
    rules.push({ label: `目标 ${intent.targetKm} km`, status: 'info',
      detail: `${difference < 0 ? '少' : '多'} ${km(Math.abs(difference))} km`, hard: false });
  }
  if (intent.loop) {
    const retraced = isMostlyRetraced(route.geometry);
    rules.push({ label: '骑回起点', status: retraced ? 'fail' : 'pass', detail: retraced ? '原路折返' : '环线已闭合', hard: true });
  }
  return { ...route, rules, canApply: rules.every(rule => !rule.hard || rule.status === 'pass') };
}

function isMostlyRetraced(geometry) {
  const seen = new Set();
  let total = 0;
  let repeated = 0;
  for (let index = 1; index < geometry.length; index++) {
    const from = geometry[index - 1];
    const to = geometry[index];
    const length = distanceMeters(from, to);
    const key = [from, to].map(coords => coords.map(value => value.toFixed(5)).join(',')).sort().join('|');
    total += length;
    if (seen.has(key)) repeated += length;
    seen.add(key);
  }
  return total > 0 && repeated >= total * 0.47;
}

const angleFrom = ([lon, lat], [centerLon, centerLat]) => Math.atan2(
  (lon - centerLon) * Math.cos(centerLat * Math.PI / 180), lat - centerLat);

export function verifyAreaLoop(geometry, { center, radius }) {
  if (distanceMeters(geometry[0], geometry.at(-1)) > 35 ||
      geometry.some(coords => distanceMeters(coords, center.coords) < radius * 0.2)) return false;
  const angles = geometry.map(coords => angleFrom(coords, center.coords));
  const winding = angles.slice(1).reduce((total, angle, index) => {
    const delta = angle - angles[index];
    return total + Math.atan2(Math.sin(delta), Math.cos(delta));
  }, 0);
  return Math.abs(Math.abs(winding) - 2 * Math.PI) <= 0.1 * Math.PI;
}

export const areaLoopUnavailable = area => `暂时无法核实绕「${area}」一圈的连通路线。可以指定想经过的环岛路段或地标。`;

export async function findAreaLoopWaypoints(provider, anchor, points, area, selections) {
  const localMatches = places => places.filter(place => place.name.endsWith(area) &&
    distanceMeters(anchor.coords, place.coords) < 15000);
  let matches = localMatches(await provider.find(area));
  if (!matches.length) {
    const nearby = await provider.nearby(anchor.coords, area, 6500);
    const city = nearby.find(place => place.address)?.address.split(' · ')[0].replace(/市$/, '');
    if (city && !area.startsWith(city)) matches = localMatches(await provider.find(city + area));
  }
  const center = matches.find(place => place.id === selections[area]) ?? (matches.length === 1 ? matches[0] : null);
  if (!center && matches.length > 1) return { question: '请选择想绕行的地点。', ambiguous: [{ name: area, places: matches.slice(0, 6) }] };
  if (!center) return { question: `在原终点附近没有找到「${area}」。可以补充完整地名。` };

  const radius = Math.max(1200, Math.min(4000, distanceMeters(anchor.coords, center.coords) * 1.2));
  const searchRadius = Math.round(radius * 0.55);
  const keywords = `${area}外环绿道|${area}外环路|绿道|公园`;
  const sectors = [0, 90, 180, 270].map(bearing => positionAtDistance(center.coords, bearing, radius));
  const anchors = await Promise.all(sectors.map(async coords => {
    const places = await provider.nearby(coords, keywords, searchRadius);
    return places.filter(place => distanceMeters(place.coords, coords) <= searchRadius * 1.25 &&
      points.every(point => distanceMeters(point.coords, place.coords) > 100))
      .toSorted((a, b) => Number(/外环|环岛/.test(b.name)) - Number(/外环|环岛/.test(a.name)) ||
        distanceMeters(a.coords, coords) - distanceMeters(b.coords, coords))[0];
  }));
  if (anchors.some(point => !point) || new Set(anchors.map(point => point.id)).size < sectors.length) {
    return { question: areaLoopUnavailable(area) };
  }

  const angle = angleFrom(anchor.coords, center.coords);
  const clockwise = point => (angleFrom(point.coords, center.coords) - angle + 2 * Math.PI) % (2 * Math.PI);
  const around = anchors.toSorted((a, b) => clockwise(a) - clockwise(b));
  return { center, radius, orders: [around, around.toReversed()] };
}

export async function planAreaLoop(provider, base, intent, { selections, legs }) {
  const { points, supplyPoints } = base;
  const area = intent.loopAround;
  if (base.loop || points.length < 2) return { question: '请先选择一条有明确终点的单程路线，再从终点接着绕行。' };
  if (points.length + 5 > 12) return { question: '绕行需要额外点位。请先减少原路线的途经点，再试一次。' };
  const anchor = points.at(-1);
  const found = await findAreaLoopWaypoints(provider, anchor, points, area, selections);
  if (!found.orders) return found;
  const candidates = [];
  let upstreamError;
  for (const stops of found.orders) {
    try {
      const returns = intent.loop === true;
      const route = await buildRoute(provider, [...points, ...stops, anchor], returns, legs);
      const local = route.geometry.slice(route.legEnds[points.length - 2], route.legEnds[points.length + stops.length - 1] + 1);
      if (!verifyAreaLoop(local, found)) continue;

      const candidate = checkRoute(route, { ...intent, loop: false });
      candidate.supplyPoints = supplyPoints;
      candidate.rules.push({ label: `绕行${found.center.name}`, status: 'pass', detail: '地图轨迹已绕行一圈', hard: true });
      if (returns) candidate.rules.push({ label: '骑回原起点', status: 'pass', detail: '环线已闭合', hard: true });
      if (intent.requireSupply && !supplyPoints.length) {
        candidate.rules.push({ label: '途中补给', status: 'unknown', detail: '补给点待核实', hard: true });
        candidate.canApply = false;
      }
      candidates.push(candidate);
    } catch (error) {
      if (!(error instanceof PlanningError)) upstreamError = error;
    }
  }
  if (!candidates.length && upstreamError) throw upstreamError;
  if (!candidates.length) return { question: areaLoopUnavailable(area) };
  const finish = intent.loop === true ? '再骑回原起点' : '绕完回到原终点';
  return { candidates: rankRoutes(candidates, intent), question: candidates.some(route => route.canApply)
    ? `已保留原路线点位，从「${anchor.name}」接上绕「${found.center.name}」一圈的路段，${finish}。`
    : '绕行路线未满足全部既有硬条件，请查看候选详情。' };
}

export const searchDistance = intent => intent.targetKm ??
  (intent.minDistanceKm !== null && intent.maxDistanceKm !== null
    ? (intent.minDistanceKm + intent.maxDistanceKm) / 2 : intent.maxDistanceKm ?? intent.minDistanceKm);

export function nearDistanceGoal(distance, intent) {
  const goal = intent.targetKm;
  return (goal === null || Math.abs(distance / 1000 - goal) <= goal * 0.15) &&
    (intent.minDistanceKm === null || distance >= intent.minDistanceKm * 1000) &&
    (intent.maxDistanceKm === null || distance <= intent.maxDistanceKm * 1000);
}

export function rankRoutes(routes, intent, open = false) {
  const goal = open ? searchDistance(intent) : intent.targetKm;
  const deviation = route => goal === null ? 0 : Math.abs(route.distance - goal * 1000);
  const outsideTarget = route => open && !nearDistanceGoal(route.distance, intent);
  return routes.toSorted((a, b) => Number(b.canApply) - Number(a.canApply) ||
    Number(outsideTarget(a)) - Number(outsideTarget(b)) ||
    (outsideTarget(a) ? deviation(a) - deviation(b) : 0) ||
    Number(b.rules.some(rule => rule.label === '途中补给' && rule.status === 'pass')) -
      Number(a.rules.some(rule => rule.label === '途中补给' && rule.status === 'pass')) ||
    (intent.lowClimb ? (a.climb ?? Infinity) - (b.climb ?? Infinity) || 0 : 0) ||
    deviation(a) - deviation(b));
}

export async function planRouteStop(provider, base, intent, { query, checkpoint }, legs) {
  const { points, loop, supplyPoints } = base;
  if (points.length < 2) return { question: '先规划一条路线，再添加沿途停靠点。' };
  if (points.length >= 12) return { question: '这条路线已有 12 个点位。移除一个途经点后即可添加。' };
  const original = await buildRoute(provider, points, loop, legs);
  const samples = samplePositions(original.geometry, Math.max(100, original.distance / 180));
  const radius = 3000;
  const count = Math.min(7, Math.max(3, Math.ceil(original.distance / 9000)));
  const centers = Array.from({ length: count }, (_, index) =>
    samples[Math.round((samples.length - 1) * (index + 1) / (count + 1))]);
  const responses = await Promise.allSettled(centers.map(coords => provider.routeStopsNearby(coords, query, radius)));
  const found = responses.flatMap(response => response.status === 'fulfilled' ? response.value : []);
  const failed = responses.find(response => response.status === 'rejected');
  if (!found.length && failed) throw failed.reason;
  const sections = original.legEnds.map((end, index) =>
    samplePositions(original.geometry.slice(original.legEnds[index - 1] ?? 0, end + 1), 180));
  const unique = [...new Map(found.map(point => [point.id, point])).values()];
  const proposals = unique.filter(stop => points.every(point => point.id !== stop.id &&
    distanceMeters(point.coords, stop.coords) > 100)).map(stop => {
    let nearest = { index: 0, distance: Infinity };
    for (const [index, section] of sections.entries()) {
      for (const coords of section) {
        const distance = distanceMeters(stop.coords, coords);
        if (distance < nearest.distance) nearest = { index, distance };
      }
    }
    return { stop, ...nearest };
  }).filter(proposal => proposal.distance <= radius).sort((a, b) => a.distance - b.distance);
  if (!proposals.length) return { question: `在路线中段附近没有找到「${query}」。可以换个关键词或指定地点名称。` };

  const candidates = [];
  let upstreamError;
  for (const { stop, index } of proposals.slice(0, 5)) {
    try {
      const visit = { ...stop, visit: checkpoint ? 'checkpoint' : 'stop', stopType: query };
      const route = await buildRoute(provider, points.toSpliced(index + 1, 0, visit), loop, legs);
      const candidate = checkRoute(route, { ...intent, loop });
      candidate.supplyPoints = supplyPoints;
      if (intent.requireSupply && !supplyPoints.length) {
        candidate.rules.push({ label: '途中补给', status: 'unknown', detail: '补给点待核实', hard: true });
        candidate.canApply = false;
      }
      candidate.rules.push({ label: checkpoint ? '签到点' : '沿途停靠点', status: 'pass', detail: stop.name, hard: true });
      candidate.rules.push({ label: '相对原路线', status: 'info', hard: false,
        detail: (route.distance >= original.distance ? '增加 ' : '减少 ') + km(Math.abs(route.distance - original.distance)) + ' km' });
      candidates.push(candidate);
    } catch (error) {
      if (!(error instanceof PlanningError)) upstreamError = error;
    }
  }
  if (!candidates.length && upstreamError) throw upstreamError;
  if (!candidates.length) return { question: `已找到沿途的「${query}」。现有骑行路网暂时无法接入这些地点。` };
  const ranked = candidates.sort((a, b) => Number(b.canApply) - Number(a.canApply) ||
    Number(nearDistanceGoal(b.distance, intent)) - Number(nearDistanceGoal(a.distance, intent)) ||
    Math.abs(a.distance - original.distance) - Math.abs(b.distance - original.distance));
  return { candidates: ranked.slice(0, 3), intent,
    question: ranked.some(route => route.canApply) ? '已找到可骑达的沿途停靠点。' : '找到包含停靠点的路线，仍有硬条件未满足或无法核实。' };
}

async function findDestinationGroups(provider, coords, remaining, searchTerms, searchScale) {
  const terms = [...new Set([...searchTerms, '公园', '地铁站', '景点'])].slice(0, 3);
  if (provider.kind === 'demo') return [await provider.nearby(coords, '公园', remaining)];

  // Around search favors POIs near its center. Place centers around the estimated endpoint band.
  const reach = Math.min(200000, remaining / 1.3 * (searchScale ?? 1));
  const radius = Math.min(15000, Math.max(750, Math.round(reach * 0.22)));
  const offset = searchScale === undefined ? 0 : 30;
  const groups = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
    provider.nearby(positionAtDistance(coords, index * 60 + offset, reach), terms.join('|'), radius)));
  const available = groups.filter(group => group.status === 'fulfilled');
  if (!available.length) throw groups[0].reason;
  return available.map(group => group.value);
}

async function openLayouts(provider, base, intent, searchTerms, searchScale) {
  const last = base.at(-1);
  const goal = (searchDistance(intent) ?? 20) * 1000;
  const committed = base.slice(1).reduce((sum, point, index) => sum + distanceMeters(base[index].coords, point.coords), 0);
  const remaining = Math.max(1000, goal - committed * 1.3);
  const known = new Set(base.map(point => point.id));
  const directDistance = point => distanceMeters(last.coords, point.coords) * 1.3;
  const estimatedTarget = remaining * (searchScale ?? 1);
  const score = point => Math.abs(directDistance(point) - estimatedTarget);
  const matches = await findDestinationGroups(provider, last.coords, remaining, searchTerms, searchScale);
  const groups = matches.map(group => group.filter(point => !known.has(point.id) &&
    distanceMeters(last.coords, point.coords) > 300 && distanceMeters(base[0].coords, point.coords) > 300)
    .toSorted((a, b) => score(a) - score(b)));
  const places = [...new Map(groups.flat().map(place => [place.id, place])).values()];
  const bestPerDirection = groups.flatMap(group => group.slice(0, 1));
  const ordered = [...new Set([...bestPerDirection, ...places.toSorted((a, b) => score(a) - score(b))].map(point => point.id))];
  const byId = new Map(places.map(place => [place.id, place]));
  const direct = ordered.slice(0, 8).map(id => ({ layout: [...base, byId.get(id)], loop: false }));
  if (provider.kind !== 'demo' || base.length > 10) return direct;

  // The small demo graph needs intermediate stops to produce longer routes.
  const detours = [];
  if (remaining > 5000) {
    for (const via of places) {
      for (const end of places) {
        if (end === via) continue;
        const section = distanceMeters(via.coords, end.coords) * 1.3;
        if (section < 2000) continue;
        const estimate = directDistance(via) + section;
        const difference = Math.abs(estimate - remaining);
        const detour = estimate - directDistance(end);
        detours.push({ via, end, score: difference + detour * 0.12 });
      }
    }
  }
  const used = new Set();
  const extended = detours.sort((a, b) => a.score - b.score).filter(({ end }) => {
    if (used.has(end.id)) return false;
    used.add(end.id);
    return true;
  }).slice(0, 7).map(({ via, end }) => ({ layout: [...base, via, end], loop: false }));
  return [...direct, ...extended];
}

export async function planFromIntent(provider, intent, {
  current = [], currentLoop = false, selections = {}, searchTerms = [], searchScale, legs = new Map(), startPoint,
} = {}) {
  const points = normalizePoints(current);
  const open = intent.destination === 'open' && intent.loop !== true;
  const loop = open ? false : intent.loop ?? currentLoop;
  const ambiguous = new Map();
  const missing = new Set();
  async function resolve(name, fallback) {
    if (!name) return fallback ?? null;
    const existing = points.find(point => point.name === name);
    if (existing) return existing;
    const results = await provider.find(name);
    const selected = results.find(place => place.id === selections[name]);
    if (selected) return selected;
    const exact = results.filter(place => place.name === name);
    const matches = exact.length ? exact : results;
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) ambiguous.set(name, { name, places: matches.slice(0, 6) });
    else missing.add(name);
    return null;
  }
  if (intent.minDistanceKm !== null && intent.maxDistanceKm !== null && intent.minDistanceKm > intent.maxDistanceKm) {
    return { question: '最短里程大于最长里程，请调整区间。' };
  }
  if (intent.loop === true && intent.end) {
    return { question: '你希望回到起点，还是在「' + intent.end + '」结束？' };
  }
  if (startPoint === null) {
    return { question: '还没获取到当前位置。请先在地图上定位，或回复一个出发地点。', waitingFor: 'start' };
  }
  const [start, end, via] = await Promise.all([
    startPoint ?? resolve(intent.start, points[0]),
    loop || open ? null : resolve(intent.end, points.length > 1 && !currentLoop ? points.at(-1) : null),
    intent.via.length ? Promise.all(intent.via.map(name => resolve(name))) :
      intent.keepVia !== false ? points.slice(1, currentLoop || loop ? undefined : -1) : [],
  ]);
  if (ambiguous.size) return { question: '请选择地图上的具体地点。', ambiguous: [...ambiguous.values()] };
  if (missing.size) return { question: `没有找到「${[...missing].join('、')}」，请换一个地点名称。` };
  if (!start) return { question: '想从哪里出发？可以回复地名，或先在地图上选起点。', waitingFor: 'start' };
  if (!end && !open && !loop) {
    return { question: '想在哪里结束？可以回复地名、让 AI 选终点，或骑回起点。', waitingFor: 'end' };
  }
  if (via.length > (loop ? 11 : 10)) {
    return { question: '最多设置 12 个路线点。请减少途经点，为起点和终点留出位置。' };
  }

  let layouts = [];
  if (open) {
    layouts = await openLayouts(provider, [start, ...via], intent, searchTerms, searchScale);
  } else if (loop && !via.length) {
    const target = (searchDistance(intent) ?? 30) * 1000;
    const groups = await findDestinationGroups(provider, start.coords, target / 3, searchTerms, searchScale);
    const awayFromStart = point => distanceMeters(point.coords, start.coords) > 700;
    if (provider.kind === 'demo') {
      const anchors = groups[0].filter(awayFromStart).slice(0, 10);
      for (let index = 0; index < Math.floor(anchors.length / 2); index++) {
        layouts.push({ layout: [start, anchors[index], anchors.at(-1 - index)], loop });
      }
      if (anchors.length === 1) layouts.push({ layout: [start, anchors[0]], loop });
    } else {
      // Adjacent search sectors give two anchors for a roughly triangular loop.
      const anchors = groups.map(group => group.find(awayFromStart)).filter(Boolean);
      const distinct = [...new Map(anchors.map(point => [point.id, point])).values()];
      layouts = distinct.map((point, index) => {
        const next = distinct[(index + 1) % distinct.length];
        return { layout: next === point ? [start, point] : [start, point, next], loop };
      });
    }
  } else {
    layouts.push({ layout: loop ? [start, ...via] : [start, ...via, end], loop });
  }
  if (!layouts.length) return { retryable: true, question: open ? '这个范围内没有找到适合的终点。可以调整里程，或指定想骑的方向。' :
    '附近没有找到可用于环线的途经点，请指定一个想经过的地点。' };

  const supplyIds = new Set();
  if (intent.supply) {
    const located = await provider.nearby(via[0]?.coords ?? start.coords, intent.supply, 8000);
    const supply = located.filter(point => point.id !== start.id && point.id !== end?.id).slice(0, 2);
    for (const stop of supply) supplyIds.add(stop.id);
    if (intent.requireSupply && !supply.length) return { question: '附近未找到所需补给点，请调整补给要求或途经位置。' };
    const withSupply = layouts.slice(0, 8).flatMap(({ layout, loop }) => supply.flatMap(stop => {
      const index = layout.findIndex(point => point.id === stop.id);
      if (index > 0 && (loop || index < layout.length - 1)) return [{ layout, loop }];
      if (index >= 0 || layout.length === 12) return [];
      const middle = Math.min(layout.length - 1, Math.max(1, Math.floor(layout.length / 2)));
      return [{ layout: layout.toSpliced(middle, 0, stop), loop }];
    }));
    layouts = intent.requireSupply ? withSupply : [...withSupply, ...layouts];
  }

  let lastIssue = '';
  let upstreamError = null;
  const candidates = [];
  const geometries = new Set();
  for (const { layout, loop } of layouts.slice(0, open ? 15 : 6)) {
    try {
      const route = await buildRoute(provider, layout, loop, legs);
      if (open && isMostlyRetraced(route.geometry)) continue;
      const signature = JSON.stringify(route.geometry);
      if (geometries.has(signature)) continue;
      geometries.add(signature);
      const candidate = checkRoute(route, { ...intent, loop });
      candidate.supplyPoints = route.points.slice(1, loop ? undefined : -1)
        .filter(point => supplyIds.has(point.id)).map(point => point.id);
      if (candidate.supplyPoints.length) {
        candidate.rules.push({ label: '途中补给', status: 'pass', detail: '已加入途经点', hard: intent.requireSupply });
      }
      candidates.push(candidate);
    } catch (error) {
      if (error instanceof PlanningError) lastIssue = error.message;
      else upstreamError = error;
    }
  }
  if (!candidates.length && upstreamError) throw upstreamError;
  if (!candidates.length) return { retryable: open || loop && !via.length,
    question: lastIssue || '当前条件下没有找到连贯路线，请调整途经点后再试。' };
  return {
    candidates: rankRoutes(candidates, intent, open).slice(0, 3), intent,
    retryable: open || loop && !via.length,
    question: candidates.some(route => route.canApply) ? (open ? '已为你挑选单程终点。' : '可以在地图上比较候选路线。') :
      '当前候选未满足或无法核实全部硬条件，可调整条件后重试。',
  };
}

const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
export function demoGpx(name, geometry) {
  const points = geometry.map(([lon, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cycler Roadbook Demo" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${xml('演示样例 · ' + name)}</name><trkseg>\n${points}\n</trkseg></trk></gpx>\n`;
}
