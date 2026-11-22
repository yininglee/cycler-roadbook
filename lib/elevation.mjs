import coordinateTransform from 'coordtransform';
import pngjs from 'pngjs';
import { validPosition } from './geo.mjs';

const terrainSource = 'terrain-tiles';
const terrainBase = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const tileSize = 256;
const tileZoom = 12;
const tileCount = 2 ** tileZoom;
const maxLatitude = 85.05112878;
const cachedTiles = new Map();

export function configuredElevationSource() {
  if (process.env.ELEVATION_URL?.trim()) return 'custom';
  return process.env.ELEVATION_PROVIDER === terrainSource ? terrainSource : null;
}

function terrainPixel(point) {
  if (!validPosition(point)) throw new Error('高程采样点坐标无效。');
  const [lon, lat] = coordinateTransform.gcj02towgs84(...point);
  if (Math.abs(lat) >= maxLatitude) throw new Error('高程采样点超出地形瓦片范围。');
  const world = tileCount * tileSize;
  const x = Math.min(world - 1, Math.floor((lon + 180) / 360 * world));
  const projectedLatitude = Math.asinh(Math.tan(lat * Math.PI / 180));
  const y = Math.max(0, Math.min(world - 1, Math.floor((1 - projectedLatitude / Math.PI) * world / 2)));
  return {
    key: `${tileZoom}/${Math.floor(x / tileSize)}/${Math.floor(y / tileSize)}`,
    byteOffset: (y % tileSize * tileSize + x % tileSize) * 4,
  };
}

async function fetchTile(key) {
  const response = await fetch(`${terrainBase}/${key}.png`, { signal: AbortSignal.timeout(6500) });
  if (!response.ok) throw new Error('高程瓦片暂不可用。');
  const tile = pngjs.PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  if (tile.width !== tileSize || tile.height !== tileSize) throw new Error('高程瓦片尺寸无效。');
  return tile.data;
}

function getTile(key) {
  let tile = cachedTiles.get(key);
  cachedTiles.delete(key);
  if (!tile) {
    tile = fetchTile(key).catch(error => {
      if (cachedTiles.get(key) === tile) cachedTiles.delete(key);
      throw error;
    });
  }
  cachedTiles.set(key, tile);
  if (cachedTiles.size > 64) cachedTiles.delete(cachedTiles.keys().next().value);
  return tile;
}

async function terrainElevations(points) {
  const pixels = points.map(terrainPixel);
  const tiles = new Map(pixels.map(({ key }) => [key, null]));
  const keys = [...tiles.keys()];
  for (let start = 0; start < keys.length; start += 8) {
    const batch = keys.slice(start, start + 8);
    await Promise.all(batch.map(async key => tiles.set(key, await getTile(key))));
  }
  return pixels.map(({ key, byteOffset }) => {
    const data = tiles.get(key);
    const [red, green, blue, alpha] = data.subarray(byteOffset, byteOffset + 4);
    if (alpha === 0) return null;
    return red * 256 + green + blue / 256 - 32768;
  });
}

export async function lookupElevations(coords) {
  const source = configuredElevationSource();
  if (source === terrainSource) return terrainElevations(coords);
  if (source !== 'custom') return null;
  const response = await fetch(process.env.ELEVATION_URL.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinateSystem: 'GCJ-02', coordinates: coords }),
    signal: AbortSignal.timeout(6500),
  });
  if (!response.ok) throw new Error('高程服务暂不可用。');
  return (await response.json()).elevations;
}
