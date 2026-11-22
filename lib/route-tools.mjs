import { buildRoute, checkAreaSection, checkRequiredSupply, checkRoute, findAreaLoopWaypoints, PlanningError, sectionDistance } from './planner.mjs';

const samePoint = (a, b) => a.id === b.id && a.coords[0] === b.coords[0] && a.coords[1] === b.coords[1];
const describe = ({ ref, name, address }) => ({ ref, name, ...(address ? { address } : {}) });

export function routeTools(provider, current, location, selections, legs) {
  const places = new Map(current.points.map((point, index) => [`S${index}`, point]));
  if (location) places.set('location', location);
  const areas = new Map();
  const supply = new Set(current.supplyPoints);
  let nextRef = 1;

  function register(point) {
    let ref = [...places].find(([, existing]) => samePoint(point, existing))?.[0];
    if (!ref) {
      ref = `P${nextRef++}`;
      places.set(ref, point);
    }
    return describe({ ...point, ref });
  }

  function place(ref) {
    const point = places.get(ref);
    if (!point) throw new PlanningError('请使用现有路线或地图工具返回的点位引用。');
    return point;
  }

  function resolvePath(refs) {
    if (!Array.isArray(refs) || refs.length < 2 || refs.length > 13) {
      throw new PlanningError('每段路线至少需要两个点位，整条路线最多保存 12 个点位。');
    }
    return refs.map(place);
  }

  function keptPath({ from, to }) {
    if (from === undefined && to === undefined) {
      if (current.points.length < 2) throw new PlanningError('当前没有可保留的已规划路段。');
      return current.loop ? [...current.points, current.points[0]] : current.points;
    }
    const first = current.points.indexOf(place(from));
    const last = current.points.indexOf(place(to));
    if (first < 0 || first >= last) throw new PlanningError('保留路段的起止点需按原路线顺序指定。');
    return current.points.slice(first, last + 1);
  }

  return {
    current: current.points.map((point, index) => describe({ ...point, ref: `S${index}` })),
    point: place,
    async search({ query, near, radius }) {
      const term = query.trim().slice(0, 100);
      const matches = near === undefined ? await provider.find(term) : await provider.nearby(place(near).coords,
        term, Number.isFinite(radius) ? Math.min(12000, Math.max(300, Math.round(radius))) : 3500);
      const chosen = matches.find(point => point.id === selections[term]);
      const returned = chosen ? [chosen] : matches.slice(0, 6);
      if (/^(?:便利店|补给点)$/.test(term)) returned.forEach(point => supply.add(point.id));
      return { places: returned.map(register) };
    },
    async findLoop({ query, at }) {
      const area = query.trim().slice(0, 100);
      const anchor = place(at);
      const found = await findAreaLoopWaypoints(provider, anchor, [anchor], area, selections);
      if (!found.orders) return found;
      const center = register(found.center);
      areas.set(center.ref, { ...found, area });
      const options = found.orders.map(order => [at, ...order.map(point => register(point).ref), at]);
      return { center, options, places: [...new Set(options.flat())].map(ref => describe({ ...place(ref), ref })) };
    },
    async measure(refs) {
      const path = resolvePath(refs);
      const loop = samePoint(path[0], path.at(-1));
      const route = await buildRoute(provider, loop ? path.slice(0, -1) : path, loop, legs);
      return { km: route.distance / 1000, climb: route.climb };
    },
    async compose(sections, intent, mode) {
      if (!Array.isArray(sections) || !sections.length || sections.length > 8) {
        throw new PlanningError('请按骑行顺序提交 1 至 8 个路段。');
      }
      if (intent.minDistanceKm !== null && intent.maxDistanceKm !== null && intent.minDistanceKm > intent.maxDistanceKm) {
        throw new PlanningError('最短里程大于最长里程，请调整区间。');
      }
      const path = [];
      const spans = [];
      for (const section of sections) {
        if (section?.kind !== 'keep' && section?.kind !== 'ride') throw new PlanningError('请指定保留路段或骑行路段。');
        const kept = section.kind === 'keep';
        const points = kept ? keptPath(section) : resolvePath(section.points);
        if (path.length && !samePoint(path.at(-1), points[0])) {
          throw new PlanningError(`「${path.at(-1).name}」和「${points[0].name}」之间还缺少连接路段。`);
        }
        const name = typeof section.name === 'string' && section.name.trim() ? section.name.trim().slice(0, 40) :
          kept ? '保留路段' : `骑行段 ${spans.length + 1}`;
        const start = path.length ? path.length - 1 : 0;
        path.push(...(path.length ? points.slice(1) : points));
        const area = areas.get(section.around);
        if (section.around !== undefined && !area) throw new PlanningError('环绕段需要使用地图工具返回的区域引用。');
        spans.push({ name, start, end: path.length - 1, area });
      }
      const loop = samePoint(path[0], path.at(-1));
      if (intent.loop === true && !loop) throw new PlanningError('已确认返回原起点，请补齐最后一段返程。');
      if (intent.loop === false && loop) throw new PlanningError('已确认在其他地点结束，请检查返程终点。');
      if (mode === 'revise' && intent.loop === true && !intent.start && current.points[0] && !samePoint(path[0], current.points[0])) {
        throw new PlanningError('请从原起点出发并回到同一个点位。');
      }
      if (intent.loopAround) {
        if (!spans.some(({ area }) => area && (area.area === intent.loopAround || area.center.name.endsWith(intent.loopAround)))) {
          throw new PlanningError(`请先查找「${intent.loopAround}」的环绕点，再加入绕行路段。`);
        }
        if (!current.loop && current.points.length > 1 &&
          (!current.points.every((point, index) => path[index] && samePoint(point, path[index])) ||
          spans.some(({ area, start }) => area && start < current.points.length - 1))) {
          throw new PlanningError('请先保留原路线到原终点，再接入绕行路段。');
        }
      }
      const route = await buildRoute(provider, loop ? path.slice(0, -1) : path, loop, legs);
      const hasArea = spans.some(span => span.area);
      const candidate = checkRoute(route, { ...intent, loop: loop && !hasArea });
      candidate.sections = spans.map(({ name, start, end, area }) => ({ name, start, end,
        ...(area ? { area: { center: area.center, radius: area.radius } } : {}) }));
      const stops = route.points.slice(1, loop ? undefined : -1);
      candidate.supplyPoints = stops.filter(point => supply.has(point.id)).map(point => point.id);
      checkRequiredSupply(candidate, intent);
      if (loop && hasArea) candidate.rules.push({ label: '骑回原起点', status: 'pass', detail: '环线已闭合', hard: true });
      const measured = spans.map(({ name, start, end, area }) => {
        const distance = sectionDistance(route, start, end);
        candidate.rules.push({ label: name, detail: `${(distance / 1000).toFixed(1)} km`, status: 'info', hard: false });
        if (area) checkAreaSection(candidate, { start, end, area });
        return { name, km: distance / 1000 };
      });
      return { candidate, sections: measured };
    },
  };
}
