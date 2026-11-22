import { demoPlaces, demoRoads } from '../public/demo.js';
import { distanceMeters, validPosition } from './geo.mjs';
import { setTimeout as wait } from 'node:timers/promises';

export class MapServiceError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const demoById = new Map(demoPlaces.map(place => [place.id, place]));
const roadGeometry = (from, to, via) => [demoById.get(from).coords, ...via, demoById.get(to).coords];
const lengthOf = path => path.slice(1).reduce((sum, point, index) => sum + distanceMeters(path[index], point), 0);
const demoGraph = new Map(demoPlaces.map(place => [place.id, []]));
for (const [from, to, via] of demoRoads) {
  const geometry = roadGeometry(from, to, via);
  const distance = lengthOf(geometry);
  demoGraph.get(from).push({ to, geometry, distance });
  demoGraph.get(to).push({ to: from, geometry: geometry.toReversed(), distance });
}

function demoLeg(from, to) {
  if (!demoGraph.has(from.id) || !demoGraph.has(to.id)) return null;
  const frontier = [{ id: from.id, geometry: [from.coords], distance: 0 }];
  const best = new Map();
  while (frontier.length) {
    const current = frontier.sort((a, b) => b.distance - a.distance).pop();
    if (best.has(current.id)) continue;
    best.set(current.id, current.distance);
    if (current.id === to.id) {
      return { distance: current.distance, duration: current.distance / 5, geometry: current.geometry };
    }
    for (const edge of demoGraph.get(current.id)) {
      if (!best.has(edge.to)) {
        frontier.push({
          id: edge.to,
          distance: current.distance + edge.distance,
          geometry: [...current.geometry, ...edge.geometry.slice(1)],
        });
      }
    }
  }
  return null;
}

const demoProvider = {
  kind: 'demo',
  find: async query => demoPlaces.filter(place => (place.name + place.address).includes(query)),
  nearby: async (coords, query) => demoPlaces
    .filter(place => query === '便利店' ? place.kind === 'supply' : true)
    .toSorted((a, b) => distanceMeters(coords, a.coords) - distanceMeters(coords, b.coords)),
  routeStopsNearby: async (coords, query, radius) => demoPlaces.filter(place =>
    distanceMeters(coords, place.coords) <= radius && (
      query === '景点' ? /堤|村|溪|塔|湿地|公园|湘湖|竹径/.test(place.name) :
      query === '便利店' || query === '补给点' ? place.kind === 'supply' : place.name.includes(query))),
  leg: async (from, to) => demoLeg(from, to),
  elevations: async coords => coords.map(([lon, lat]) => Math.round(14 + 95 *
    Math.exp(-((lon - 120.085) ** 2) / 0.0019) * (0.55 + 0.45 * Math.cos((lat - 30.220) * 120) ** 2))),
};

const throttledCodes = new Set(['10014', '10015', '10019', '10020', '10021']);
const nextRequestAt = new Map();

async function waitForAmapSlot(path) {
  const now = performance.now();
  const at = Math.max(now, nextRequestAt.get(path) ?? now);
  if (at - now > 8000) throw new MapServiceError('高德地图请求较多，请稍后重试。', 'QUEUE_BUSY', 503);
  // Keep each API below three request starts per second, across all active plans.
  nextRequestAt.set(path, at + 350);
  if (at > now) await wait(Math.ceil(at - now));
}

async function amap(path, parameters) {
  const url = new URL(path, 'https://restapi.amap.com');
  url.search = new URLSearchParams({ ...parameters, key: process.env.AMAP_WEB_KEY });
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForAmapSlot(path);
    let response;
    let data;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(6500) });
      data = await response.json().catch(error => {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
        return null;
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new MapServiceError('高德地图响应超时，请重试。', 'TIMEOUT', 504);
      }
      throw new MapServiceError('高德地图连接失败，请重试。', 'NETWORK');
    }
    if (response.ok && data?.status === '1') return data;
    const code = typeof data?.infocode === 'string' && /^\d+$/.test(data.infocode) ? data.infocode : String(response.status);
    if (response.status !== 429 && !throttledCodes.has(code)) {
      throw new MapServiceError('高德地图请求失败，请重试。', code);
    }
    if (attempt === 0) await wait(1100);
    else throw new MapServiceError('高德地图请求达到频率上限，请稍后重试。', code, 503);
  }
}

const coordinateString = coords => coords.map(value => value.toFixed(6)).join(',');
const parsePosition = value => typeof value === 'string' ? value.split(',').map(Number) : [];
const firstText = value => typeof value === 'string' ? value : '';
const routeStopTypes = new Map([['景点', '110000'], ['住宿', '100000'], ['餐饮', '050000']]);
function placesFrom(data) {
  return (Array.isArray(data.pois) ? data.pois : []).map(poi => ({
    id: poi.id,
    name: poi.name,
    address: [poi.cityname, poi.adname, poi.address].map(firstText).filter(Boolean).join(' · '),
    coords: parsePosition(poi.location),
  })).filter(place => typeof place.id === 'string' && typeof place.name === 'string' && validPosition(place.coords));
}

const amapProvider = {
  kind: 'amap',
  find: async query => placesFrom(await amap('/v5/place/text', { keywords: query, page_size: '8' })),
  nearby: async (coords, query, radius) => placesFrom(await amap('/v5/place/around', {
    location: coordinateString(coords), keywords: query, radius: String(radius), page_size: '6',
  })),
  routeStopsNearby: async (coords, query, radius) => placesFrom(await amap('/v5/place/around', {
    location: coordinateString(coords), radius: String(radius), page_size: '10', sortrule: 'distance',
    ...(routeStopTypes.has(query) ? { types: routeStopTypes.get(query) } : { keywords: query }),
  })),
  leg: async (from, to) => {
    const data = await amap('/v5/direction/bicycling', {
      origin: coordinateString(from.coords), destination: coordinateString(to.coords), show_fields: 'cost,polyline',
    });
    const path = data.route?.paths?.[0];
    if (!path || !Array.isArray(path.steps)) return null;
    const geometry = [];
    for (const step of path.steps) {
      const points = typeof step.polyline === 'string' ? step.polyline.split(';').map(parsePosition) : [];
      if (points.length < 2 || !points.every(validPosition)) return null;
      if (geometry.length && distanceMeters(geometry.at(-1), points[0]) > 35) return null;
      if (geometry.length && distanceMeters(geometry.at(-1), points[0]) < 1) points.shift();
      geometry.push(...points);
    }
    const distance = Number(path.distance);
    const duration = path.cost?.duration == null ? null : Number(path.cost.duration);
    if (!Number.isFinite(distance) || distance <= 0 || geometry.length < 2) return null;
    return { geometry, distance, duration: Number.isFinite(duration) ? duration : null };
  },
  elevations: async coords => {
    if (!process.env.ELEVATION_URL) return null;
    const response = await fetch(process.env.ELEVATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinateSystem: 'GCJ-02', coordinates: coords }),
      signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) throw new Error('高程服务暂不可用。');
    return (await response.json()).elevations;
  },
};

export function servicesConfigured() {
  return Boolean(process.env.AMAP_JS_KEY && process.env.AMAP_JS_SECRET && process.env.AMAP_WEB_KEY);
}

export const getProvider = () => servicesConfigured() ? amapProvider : demoProvider;
