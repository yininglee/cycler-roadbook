import { distanceMeters, positionAtDistance, samplePositions, validPosition } from './geo.mjs';

export { readIntent } from './intent.mjs';

export class PlanningError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.issues = issues;
  }
}

function connectionError(message, from, to, type = 'disconnected') {
  return new PlanningError(message, [{ type, geometry: [from, to], message }]);
}
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
  const outcomes = await Promise.allSettled(legPairs.map(async ({ from, to }) => {
    if (distanceMeters(from.coords, to.coords) < 5) throw new PlanningError(`「${from.name}」与「${to.name}」距离过近，请调整点位。`);
    const key = legKey(from, to);
    if (!savedLegs.has(key)) savedLegs.set(key, Promise.resolve().then(() => provider.leg(from, to)).catch(error => {
      savedLegs.delete(key);
      throw error;
    }));
    const leg = await savedLegs.get(key);
    if (!leg) throw connectionError(`骑行路网未返回「${from.name}」到「${to.name}」的轨迹，请调整点位。`, from.coords, to.coords);
    const startGap = distanceMeters(from.coords, leg.geometry[0]);
    const endGap = distanceMeters(to.coords, leg.geometry.at(-1));
    if (startGap > 100 || endGap > 100) {
      const gaps = [startGap > 100 && `「${from.name}」偏离轨迹起点 ${startGap.toFixed(1)} m`,
        endGap > 100 && `「${to.name}」偏离轨迹终点 ${endGap.toFixed(1)} m`].filter(Boolean);
      throw connectionError(`${gaps.join('，')}，超过 100 m 的接入核验范围。`, from.coords, to.coords, 'unverified');
    }
    return leg;
  }));
  const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) {
    const issues = errors.flatMap(error => error instanceof PlanningError ? error.issues : []);
    if (issues.length) throw new PlanningError(issues[0].message, issues);
    throw errors[0];
  }
  const legs = outcomes.map(result => result.value);
  const geometry = [...legs[0].geometry];
  const legEnds = [geometry.length - 1];
  for (const [offset, leg] of legs.slice(1).entries()) {
    const gap = distanceMeters(geometry.at(-1), leg.geometry[0]);
    if (gap > 35) throw connectionError(`「${sequence[offset + 1].name}」附近的两段轨迹相差 ${gap.toFixed(1)} m，超过 35 m 的拼接范围。`,
      geometry.at(-1), leg.geometry[0]);
    geometry.push(...leg.geometry.slice(gap < 1 ? 1 : 0));
    legEnds.push(geometry.length - 1);
  }
  const loopGap = loop ? distanceMeters(geometry[0], geometry.at(-1)) : 0;
  if (loopGap > 35) {
    throw connectionError(`环线首尾相差 ${loopGap.toFixed(1)} m，超过 35 m 的闭合范围。`, geometry.at(-1), geometry[0]);
  }
  const distance = legs.reduce((sum, leg) => sum + leg.distance, 0);
  const { climb, profile } = await estimateRouteElevation(provider, geometry, distance);
  const duration = legs.every(leg => Number.isFinite(leg.duration)) ? legs.reduce((sum, leg) => sum + leg.duration, 0) : null;
  return { points, loop, geometry, legEnds, distance, duration, climb, profile,
    [routedLegs]: keys.map((key, index) => [key, legs[index]]) };
}

export function sectionDistance(route, from, to) {
  return route[routedLegs].slice(from, to).reduce((distance, [, leg]) => distance + leg.distance, 0);
}

export async function revisePoint(provider, base, index, replacement, intent, legs = new Map()) {
  const before = base.points[index];
  if (!before) throw new PlanningError('这个点已不在当前路线中，请重新选点。');
  if (!replacement && (index === 0 || !base.loop && index === base.points.length - 1)) {
    throw new PlanningError('请为起点或终点选择一个新位置。');
  }
  const point = replacement && { ...replacement, ...(before.visit ? { visit: before.visit, stopType: before.stopType } : {}) };
  const points = base.points.toSpliced(index, 1, ...(point ? [point] : []));
  seedRouteLegs(legs, base);
  const route = await buildRoute(provider, points, base.loop, legs);
  const sections = (base.sections ?? []).map(section => point ? section : {
    ...section, start: section.start - Number(index <= section.start), end: section.end - Number(index <= section.end),
  });
  const candidate = checkRoute(route, { ...intent, loop: base.loop && !sections.some(section => section.area) });
  if (base.loop && sections.some(section => section.area)) {
    candidate.rules.push({ label: '骑回原起点', status: 'pass', detail: '环线已闭合', hard: true });
  }
  for (const { name, start, end, area } of sections) {
    if (end > start) candidate.rules.push({ label: name, status: 'info', detail: `${km(sectionDistance(route, start, end))} km`, hard: false });
    if (!area) continue;
    checkAreaSection(candidate, { start, end, area });
  }
  const supplies = new Set(base.supplyPoints ?? []);
  candidate.supplyPoints = points.slice(1, base.loop ? undefined : -1).filter(p => supplies.has(p.id)).map(p => p.id);
  checkRequiredSupply(candidate, intent);
  candidate.sections = sections;
  return candidate;
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
  const describeLimit = (label, value, limit, unit, minimum = false) => {
    if (limit === null) return;
    const passes = minimum ? value >= limit : value <= limit;
    const actual = value === null ? '' : `${Number(value.toFixed(3))} ${unit}`;
    rules.push({ label: `${label}${minimum ? '至少' : '不超过'} ${limit} ${unit}`,
      status: value === null ? 'unknown' : passes ? 'pass' : 'fail',
      detail: value === null ? `缺少${label === '爬升' ? '高程数据' : '里程数据'}，无法核实${label}` :
        passes ? actual : `${label}为 ${actual}，${minimum ? '低于下限' : '超过上限'}`, hard: true });
  };
  describeLimit('里程', route.distance / 1000, intent.maxDistanceKm, 'km');
  describeLimit('里程', route.distance / 1000, intent.minDistanceKm, 'km', true);
  describeLimit('爬升', route.climb, intent.maxClimbM, 'm');
  if (intent.targetKm !== null) {
    const difference = route.distance - intent.targetKm * 1000;
    rules.push({ label: `目标 ${intent.targetKm} km`, status: 'info',
      detail: `${difference < 0 ? '少' : '多'} ${km(Math.abs(difference))} km`, hard: false });
  }
  if (intent.loop) {
    const retraced = isMostlyRetraced(route.geometry);
    rules.push({ label: '骑回起点', status: retraced ? 'fail' : 'pass',
      detail: retraced ? '轨迹已回到起点，但至少 47% 的里程重复经过同一路段' : '环线已闭合', hard: true });
  }
  return { ...route, rules, canApply: rules.every(rule => !rule.hard || rule.status === 'pass') };
}

export function checkRequiredSupply(candidate, intent) {
  if (!intent.requireSupply || candidate.supplyPoints.length) return;
  candidate.rules.push({ label: '途中补给', status: 'unknown', detail: '路线的途经点中没有已匹配的补给点', hard: true });
  candidate.canApply = false;
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

function areaLoopIssues(geometry, { center, radius }) {
  const gap = distanceMeters(geometry[0], geometry.at(-1));
  const nearest = geometry.reduce((min, coords) => Math.min(min, distanceMeters(coords, center.coords)), Infinity);
  const innerRadius = radius * 0.2;
  const angles = geometry.map(coords => angleFrom(coords, center.coords));
  const winding = angles.slice(1).reduce((total, angle, index) => {
    const delta = angle - angles[index];
    return total + Math.atan2(Math.sin(delta), Math.cos(delta));
  }, 0);
  const degrees = Math.abs(winding) * 180 / Math.PI;
  return [
    gap > 35 && `环绕段首尾相差 ${gap.toFixed(1)} m，超过 35 m 的闭合范围`,
    nearest < innerRadius && `轨迹与区域中心最近相距 ${nearest.toFixed(1)} m，小于环绕判定所需的 ${innerRadius.toFixed(1)} m`,
    Math.abs(Math.abs(winding) - 2 * Math.PI) > 0.1 * Math.PI && `轨迹绕区域中心的净转角为 ${degrees.toFixed(1)}°，超出一圈允许的 342° 到 378° 范围`,
  ].filter(Boolean);
}

export function checkAreaSection(candidate, { start, end, area }) {
  const from = start === 0 ? 0 : candidate.legEnds[start - 1];
  const to = candidate.legEnds[end - 1];
  const located = end > start && Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from &&
    to < candidate.geometry.length;
  const issues = located ? areaLoopIssues(candidate.geometry.slice(from, to + 1), area) : ['缺少可供核验的环绕段轨迹'];
  const passed = issues.length === 0;
  candidate.rules.push({ label: `绕行${area.center.name}`, status: passed ? 'pass' : located ? 'fail' : 'unknown',
    detail: passed ? '地图轨迹已绕行一圈' : issues.join('。'), hard: true,
    ...(!passed && located ? { mapSpan: [from, to] } : {}) });
  candidate.canApply &&= passed;
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
  let issues;
  for (const stops of found.orders) {
    try {
      const returns = intent.loop === true;
      const route = await buildRoute(provider, [...points, ...stops, anchor], returns, legs);
      const candidate = checkRoute(route, { ...intent, loop: false });
      candidate.sections = [{ name: '环绕段', start: points.length - 1, end: points.length + stops.length,
        area: { center: found.center, radius: found.radius } }];
      candidate.supplyPoints = supplyPoints;
      checkAreaSection(candidate, candidate.sections[0]);
      if (returns) candidate.rules.push({ label: '骑回原起点', status: 'pass', detail: '环线已闭合', hard: true });
      checkRequiredSupply(candidate, intent);
      candidates.push(candidate);
    } catch (error) {
      if (error instanceof PlanningError) issues = error.issues;
      else upstreamError = error;
    }
  }
  if (!candidates.length && upstreamError) throw upstreamError;
  if (!candidates.length) return { question: areaLoopUnavailable(area), issues };
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
  let issues;
  for (const { stop, index } of proposals.slice(0, 5)) {
    try {
      const visit = { ...stop, visit: checkpoint ? 'checkpoint' : 'stop', stopType: query };
      const route = await buildRoute(provider, points.toSpliced(index + 1, 0, visit), loop, legs);
      const candidate = checkRoute(route, { ...intent, loop });
      candidate.supplyPoints = supplyPoints;
      checkRequiredSupply(candidate, intent);
      candidate.rules.push({ label: checkpoint ? '签到点' : '沿途停靠点', status: 'pass', detail: stop.name, hard: true });
      candidate.rules.push({ label: '相对原路线', status: 'info', hard: false,
        detail: (route.distance >= original.distance ? '增加 ' : '减少 ') + km(Math.abs(route.distance - original.distance)) + ' km' });
      candidates.push(candidate);
    } catch (error) {
      if (error instanceof PlanningError) issues = error.issues;
      else upstreamError = error;
    }
  }
  if (!candidates.length && upstreamError) throw upstreamError;
  if (!candidates.length) return { question: `已找到沿途的「${query}」。现有骑行路网暂时无法接入这些地点。`, issues };
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
    const withSupply = layouts.slice(0, 8).flatMap(({ layout, loop }) => supply.flatMap(stop => {
      const index = layout.findIndex(point => point.id === stop.id);
      if (index > 0 && (loop || index < layout.length - 1)) return [{ layout, loop }];
      if (index >= 0 || layout.length === 12) return [];
      const middle = Math.min(layout.length - 1, Math.max(1, Math.floor(layout.length / 2)));
      return [{ layout: layout.toSpliced(middle, 0, stop), loop }];
    }));
    layouts = intent.requireSupply && withSupply.length ? withSupply : [...withSupply, ...layouts];
  }

  let lastIssue;
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
      checkRequiredSupply(candidate, intent);
      candidates.push(candidate);
    } catch (error) {
      if (error instanceof PlanningError) lastIssue = error;
      else upstreamError = error;
    }
  }
  if (!candidates.length && upstreamError) throw upstreamError;
  if (!candidates.length) return { retryable: open || loop && !via.length,
    question: lastIssue?.message || '当前条件下没有找到连贯路线，请调整途经点后再试。', issues: lastIssue?.issues };
  return {
    candidates: rankRoutes(candidates, intent, open).slice(0, 3), intent,
    retryable: open || loop && !via.length,
    question: candidates.some(route => route.canApply) ? (open ? '已为你挑选单程终点。' : '可以在地图上比较候选路线。') :
      '已找到骑行路线。部分条件未通过或待核实，请查看候选详情。',
  };
}

const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
export function demoGpx(name, geometry) {
  const points = geometry.map(([lon, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cycler Roadbook Demo" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${xml('演示样例 · ' + name)}</name><trkseg>\n${points}\n</trkseg></trk></gpx>\n`;
}
