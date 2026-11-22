import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getProvider, servicesConfigured, MapServiceError } from './lib/providers.mjs';
import { configuredElevationSource } from './lib/elevation.mjs';
import { ExportRouteError, exportRouterHost, prepareExport, preparedGpx } from './lib/gpx-export.mjs';
import { buildRoute, demoGpx, normalizePoints, PlanningError } from './lib/planner.mjs';
import { modelConfigured, ModelServiceError, runAgent } from './lib/agent.mjs';
import { validPosition } from './lib/geo.mjs';

const port = Number(process.env.PORT || 4319);
const tracks = new Map();
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/map.js', ['map.js', 'text/javascript; charset=utf-8']],
  ['/demo.js', ['demo.js', 'text/javascript; charset=utf-8']],
]);
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

function cacheTrack(route) {
  const trackId = route.trackId ?? randomUUID();
  const track = { ...route, trackId };
  tracks.delete(trackId);
  tracks.set(trackId, track);
  if (tracks.size > 32) tracks.delete(tracks.keys().next().value);
  return track;
}

function readTrack(body) {
  const route = tracks.get(body.trackId);
  if (!route || route.loop !== (body.loop === true) || !Array.isArray(body.points) ||
      JSON.stringify(route.points) !== JSON.stringify(normalizePoints(body.points))) return null;
  tracks.delete(body.trackId);
  tracks.set(body.trackId, route);
  return route;
}

async function readJson(req) {
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 25000) throw new PlanningError('请求内容过长。');
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch { throw new PlanningError('请求格式无效。'); }
}

async function proxyMap(req, res, url) {
  if (!servicesConfigured()) return json(res, 503, { error: '地图服务未配置。' });
  const path = url.pathname.replace(/^\/_AMapService/, '');
  if (!/^\/(?:v[345]\/|maps\/|service\/)/.test(path) || path.includes('..')) {
    return json(res, 404, { error: '地图接口不存在。' });
  }
  const upstream = new URL(path === '/v4/map/styles' ? 'https://webapi.amap.com' : 'https://restapi.amap.com');
  upstream.pathname = path;
  upstream.search = url.search;
  upstream.searchParams.set('key', process.env.AMAP_JS_KEY);
  upstream.searchParams.set('jscode', process.env.AMAP_JS_SECRET);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '请求方法无效。' });
  const result = await fetch(upstream, { signal: AbortSignal.timeout(6500) });
  res.writeHead(result.status, { 'Content-Type': result.headers.get('content-type') ?? 'application/json' });
  res.end(Buffer.from(await result.arrayBuffer()));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const provider = getProvider();
  if (url.pathname.startsWith('/_AMapService/')) return proxyMap(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, { mode: provider.kind,
      mapKey: servicesConfigured() ? process.env.AMAP_JS_KEY : null,
      llm: modelConfigured(),
      elevationSource: provider.kind === 'amap' ? configuredElevationSource() : 'demo',
      exportRouter: provider.kind === 'amap' ? exportRouterHost() : null });
  }
  if (req.method === 'GET' && url.pathname === '/api/places') {
    const query = url.searchParams.get('q')?.trim().slice(0, 100);
    return json(res, 200, { places: query ? (await provider.find(query)).slice(0, 8) : [] });
  }
  if (req.method === 'POST' && url.pathname === '/api/location') {
    if (provider.kind !== 'amap') return json(res, 503, { error: '高德地图未配置。' });
    const { coords } = await readJson(req);
    if (!validPosition(coords)) throw new PlanningError('定位坐标无效。');
    return json(res, 200, { coords: await provider.convertGps(coords) });
  }
  if (req.method === 'POST' && url.pathname === '/api/route') {
    const body = await readJson(req);
    return json(res, 200, cacheTrack(readTrack(body) ?? await buildRoute(provider, body.points, body.loop === true)));
  }
  if (req.method === 'POST' && url.pathname === '/api/plan') {
    const body = await readJson(req);
    const result = await runAgent(provider, body, undefined, body.saved === true ? readTrack(body) : null);
    if (result.candidates) result.candidates = result.candidates.map(cacheTrack);
    return json(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/export/preview') {
    if (provider.kind !== 'amap') return json(res, 409, { error: '演示路线可直接下载 GPX。' });
    return json(res, 200, await prepareExport(provider, await readJson(req)));
  }
  if (req.method === 'POST' && url.pathname === '/api/export') {
    const body = await readJson(req);
    let file;
    if (provider.kind === 'demo') {
      const route = await buildRoute(provider, normalizePoints(body.points), body.loop === true);
      const name = typeof body.name === 'string' ? body.name.slice(0, 120).replace(/[\x00-\x1F]/g, '') : '骑行路书';
      file = demoGpx(name, route.geometry);
    } else {
      file = preparedGpx(body.token);
    }
    res.writeHead(200, { 'Content-Type': 'application/gpx+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(file);
  }
  const asset = req.method === 'GET' && assets.get(url.pathname);
  if (!asset) return json(res, 404, { error: '页面不存在。' });
  const contents = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
  res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(contents);
}

createServer((req, res) => handle(req, res).catch(error => {
  if (res.headersSent) return res.end();
  if (error instanceof PlanningError) return json(res, 422, { error: error.message });
  if (error instanceof ExportRouteError) return json(res, error.status, { error: error.message });
  if (error instanceof MapServiceError) {
    console.warn('AMap request failed:', error.code);
    return json(res, error.status, { error: error.message });
  }
  if (error instanceof ModelServiceError) {
    console.warn('Route assistant request failed:', error.code);
    return json(res, error.status, { error: error.message });
  }
  return json(res, 502, { error: '地图或规划服务暂不可用，请重试。' });
})).listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
