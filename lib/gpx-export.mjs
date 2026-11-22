import { randomUUID } from 'node:crypto';
import coordinateTransform from 'coordtransform';
import { distanceMeters, validPosition } from './geo.mjs';
import { estimateRouteElevation, normalizePoints, PlanningError } from './planner.mjs';

const baseUrl = 'https://routing.openstreetmap.de/routed-bike';
const snapLimit = 100;
const previewLifetime = 10 * 60 * 1000;
const previews = new Map();
let lastRequest = -Infinity;

export class ExportRouteError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function bikeEndpoint() {
  const value = process.env.GPX_OSRM_BIKE_URL?.trim() || baseUrl;
  if (!URL.canParse(value)) throw new ExportRouteError('GPX 骑行算路服务地址配置无效。', 503);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new ExportRouteError('GPX 骑行算路服务地址配置无效。', 503);
  }
  return url;
}

export function exportRouterHost() {
  try { return bikeEndpoint().host; } catch { return null; }
}

function cleanName(name) {
  if (typeof name !== 'string') return '骑行路书';
  return name.slice(0, 120).replace(/[\x00-\x1F\uFFFE\uFFFF]/gu, '').trim() || '骑行路书';
}

const escapeXml = value => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);

function osmGpx(name, geometry) {
  const points = geometry.map(([lon, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${(lon === 180 ? -180 : lon).toFixed(6)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AI Cycler Roadbook" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/1-0/</license></copyright></metadata>
  <trk><name>${escapeXml(name)}</name><src>OpenStreetMap contributors (ODbL)</src><trkseg>
${points}
  </trkseg></trk>
</gpx>\n`;
}

async function calculateCyclingTrack(points, loop) {
  const coordinates = points.map(point => coordinateTransform.gcj02towgs84(...point.coords));
  if (loop) coordinates.push(coordinates[0]);
  const url = bikeEndpoint();
  url.pathname = url.pathname.replace(/\/$/, '') + '/route/v1/driving/' +
    coordinates.map(position => position.map(value => value.toFixed(6)).join(',')).join(';');
  url.search = new URLSearchParams({ overview: 'full', geometries: 'geojson', steps: 'false',
    radiuses: coordinates.map(() => snapLimit).join(';') });
  const now = performance.now();
  if (now - lastRequest < 1000) throw new ExportRouteError('请稍候，再生成导出预览。', 429);
  lastRequest = now;
  let payload;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'AI-Cycler-Roadbook/1.0 (interactive GPX export)' },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 429) throw new ExportRouteError('导出算路服务繁忙，请稍后重试。', 429);
    payload = await response.json();
    if (!response.ok && !['NoRoute', 'NoSegment'].includes(payload?.code)) throw new Error();
  } catch (error) {
    if (error instanceof ExportRouteError) throw error;
    throw new ExportRouteError('导出算路服务暂不可用，请重试。', 503);
  }
  if (payload?.code !== 'Ok') throw new ExportRouteError('开放骑行路网无法连通这些点位。试试把起点、途经点或终点移到附近道路。', 422);
  const route = payload.routes?.[0];
  const geometry = route?.geometry?.coordinates;
  const waypoints = payload.waypoints;
  if (route?.geometry?.type !== 'LineString' || !Array.isArray(geometry) || geometry.length < 2 ||
      geometry.length > 60000 || !geometry.every(validPosition) || !Number.isFinite(route.distance) || route.distance <= 0 ||
      route.legs?.length !== coordinates.length - 1 || !Array.isArray(waypoints) || waypoints.length !== coordinates.length) {
    throw new ExportRouteError('导出算路未返回完整轨迹，请重试。', 502);
  }
  for (const [index, waypoint] of waypoints.entries()) {
    if (!validPosition(waypoint.location) || distanceMeters(waypoint.location, coordinates[index]) > snapLimit) {
      const point = points[index % points.length];
      throw new ExportRouteError(`开放骑行路网无法靠近「${point.name}」，请把该点移到附近道路。`, 422);
    }
  }
  if (distanceMeters(geometry[0], waypoints[0].location) > 5 ||
      distanceMeters(geometry.at(-1), waypoints.at(-1).location) > 5 ||
      (loop && distanceMeters(geometry[0], geometry.at(-1)) > 5)) {
    throw new ExportRouteError(loop ? '导出环线未闭合，请调整起点后重试。' : '导出轨迹的起终点不完整，请重试。', 422);
  }
  let cursor = 0;
  for (const waypoint of waypoints.slice(1, -1)) {
    while (cursor < geometry.length && distanceMeters(geometry[cursor], waypoint.location) > 5) cursor++;
    if (cursor === geometry.length) throw new ExportRouteError('导出轨迹未依次经过途经点，请调整点位后重试。', 422);
  }
  return { geometry, distance: route.distance };
}

export async function prepareExport(provider, body) {
  const points = normalizePoints(body.points);
  const loop = body.loop === true;
  if (points.length < 2) throw new PlanningError('请先保存包含起终点的路线。');
  if (body.confirmed !== true) throw new PlanningError('请先确认使用开放骑行路网生成导出预览。');
  const { geometry: wgs84, distance } = await calculateCyclingTrack(points, loop);
  const geometry = wgs84.map(point => coordinateTransform.wgs84togcj02(...point));
  const { climb } = await estimateRouteElevation(provider, geometry, distance);
  const token = randomUUID();
  const name = cleanName(body.name);
  const now = Date.now();
  for (const [key, preview] of previews) if (preview.expiresAt <= now) previews.delete(key);
  if (previews.size >= 24) previews.delete(previews.keys().next().value);
  previews.set(token, { file: osmGpx(name, wgs84), expiresAt: now + previewLifetime });
  return { token, name, geometry, distance, climb };
}

export function preparedGpx(token) {
  const preview = previews.get(token);
  if (!preview || preview.expiresAt <= Date.now()) {
    previews.delete(token);
    throw new ExportRouteError('这份导出预览已失效，请重新生成。', 410);
  }
  return preview.file;
}
