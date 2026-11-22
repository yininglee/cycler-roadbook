import { demoBounds, demoPlaces, demoRoads } from './demo.js';

const lookup = new Map(demoPlaces.map(place => [place.id, place]));
const center = [120.132, 30.217];
const lake = [[120.139,30.262],[120.148,30.255],[120.151,30.247],[120.151,30.237],[120.144,30.233],[120.137,30.234],[120.130,30.241],[120.131,30.251],[120.136,30.256]];
const river = [[119.95,30.155],[120.055,30.160],[120.096,30.160],[120.125,30.168],[120.145,30.184],[120.165,30.199],[120.193,30.204],[120.217,30.213],[120.233,30.230],[120.245,30.254],[120.284,30.259],[120.33,30.255]];
const park = [[119.955,30.261],[119.998,30.274],[120.038,30.268],[120.074,30.254],[120.084,30.236],[120.116,30.224],[120.127,30.201],[120.119,30.178],[120.093,30.177],[120.056,30.193],[120.006,30.196],[119.952,30.179]];
const patches = [
  [[120.015,30.287],[120.040,30.288],[120.072,30.281],[120.071,30.261],[120.045,30.263],[120.016,30.271]],
  [[120.198,30.146],[120.226,30.155],[120.241,30.145],[120.242,30.131],[120.207,30.128]],
  [[120.075,30.332],[120.111,30.329],[120.118,30.317],[120.099,30.312],[120.071,30.315]],
  [[120.245,30.295],[120.271,30.291],[120.283,30.282],[120.260,30.274],[120.241,30.280]],
];
const labels = [
  ['拱墅区', [120.171,30.301]], ['西湖区', [120.071,30.220]], ['上城区',[120.210,30.275]],
  ['滨江区',[120.179,30.162]], ['萧山区',[120.264,30.186]], ['西 湖',[120.141,30.247]],
  ['钱 塘 江',[120.233,30.213]], ['西溪湿地',[120.050,30.280]],
  ['龙井村',[120.091,30.217]], ['白马湖',[120.209,30.172]], ['九溪',[120.109,30.185]],
];
const color = { route: '#487d60', routeOutline: '#f9fff8', preview: '#6b59b2' };
const gridRoads = [];
for (let column = 0; column < 31; column++) {
  const lon = 119.92 + column * 0.015;
  const major = column % 5 === 0;
  gridRoads.push({
    major,
    points: Array.from({ length: 19 }, (_, row) => {
      const lat = 30.05 + row * 0.018;
      return [lon + Math.sin(row * 0.72 + column * 0.27) * (major ? 0.006 : 0.004) + row * 0.0011, lat];
    }),
  });
}
for (let row = 0; row < 25; row++) {
  const lat = 30.063 + row * 0.012;
  const major = row % 5 === 2;
  gridRoads.push({
    major,
    points: Array.from({ length: 27 }, (_, column) => {
      const lon = 119.91 + column * 0.018;
      return [lon, lat + Math.sin(column * 0.58 + row * 0.2) * (major ? 0.006 : 0.003) - column * 0.0008];
    }),
  });
}

function mapLabel(ctx, coordinates, label, ink, font) {
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#f3f5ea';
  ctx.strokeText(label, ...coordinates);
  ctx.fillStyle = ink;
  ctx.fillText(label, ...coordinates);
}

export function offlineMap(canvas, onPick) {
  const ctx = canvas.getContext('2d');
  let state = { geometry: [], points: [], preview: false };
  let zoom = 1;
  let focus = [...center];
  let pointer = null;
  const size = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });
  const base = () => {
    const { w, h } = size();
    return Math.min(w / 0.24, h / 0.20);
  };
  const project = ([lon,lat]) => {
    const { w, h } = size();
    const scale = base() * zoom;
    return [w / 2 + (lon - focus[0]) * scale, h / 2 - (lat - focus[1]) * scale * 1.13];
  };
  const unproject = (x,y) => {
    const { w, h } = size();
    const scale = base() * zoom;
    return [focus[0] + (x - w / 2) / scale, focus[1] - (y - h / 2) / (scale * 1.13)];
  };
  function line(coordinates) {
    ctx.beginPath();
    coordinates.forEach((point, index) => {
      const [x,y] = project(point);
      if (index) ctx.lineTo(x,y); else ctx.moveTo(x,y);
    });
  }
  function fill(coordinates, tone) {
    line(coordinates); ctx.closePath(); ctx.fillStyle = tone; ctx.fill();
  }
  function stroke(coordinates, tone, width) {
    line(coordinates); ctx.strokeStyle = tone; ctx.lineWidth = width; ctx.stroke();
  }
  function draw() {
    const ratio = window.devicePixelRatio || 1;
    const { w, h } = size();
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.fillStyle = '#e8ebe1'; ctx.fillRect(0,0,w,h);
    fill(park, '#d9e6ce');
    for (const patch of patches) fill(patch, '#d9e7cd');
    for (const road of gridRoads) {
      if (road.major) stroke(road.points, '#e4dbc0', 5.2);
      stroke(road.points, road.major ? '#fffaf0' : '#fafbf7', road.major ? 3.8 : 1.6);
    }
    stroke(river, '#b3d0cc', Math.max(12, 0.011 * base() * zoom + 6));
    stroke(river, '#badad6', Math.max(10, 0.011 * base() * zoom + 3));
    fill(lake, '#bbdbd6');
    stroke([...lake, lake[0]], '#adccc7', 1.5);
    for (const [a,b,via] of demoRoads) {
      const points = [lookup.get(a).coords, ...via, lookup.get(b).coords];
      stroke(points, '#d6d8c8', 6);
      stroke(points, '#fffdf1', 4.5);
    }
    for (let index = 0; index < labels.length; index++) {
      const [label, coordinates] = labels[index];
      mapLabel(ctx, project(coordinates), label, index < 5 ? '#596251' : '#536c66',
        index < 5 ? '600 13px system-ui,sans-serif' : '500 11px system-ui,sans-serif');
    }
    if (state.geometry.length) {
      stroke(state.geometry, color.routeOutline, 9);
      stroke(state.geometry, state.preview ? color.preview : color.route, 5.5);
    }
    state.points.forEach((point, index) => {
      const [x,y] = project(point.coords);
      const endpoint = index === 0 || (!state.loop && index === state.points.length - 1);
      ctx.beginPath(); ctx.arc(x,y, endpoint ? 11 : 9, 0, Math.PI * 2);
      ctx.fillStyle = state.preview ? color.preview : index === 0 ? '#355f45' : index === state.points.length - 1 && !state.loop ? '#242825' : '#5e8265';
      ctx.fill(); ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = 'white'; ctx.font = '700 10px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(index === 0 ? '起' : endpoint ? '终' : String(index), x, y + .5);
    });
  }
  const resize = new ResizeObserver(draw);
  resize.observe(canvas);
  canvas.addEventListener('pointerdown', event => {
    pointer = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointer) return;
    if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 5) pointer.moved = true;
    if (pointer.moved) {
      const scale = base() * zoom;
      focus[0] -= (event.clientX - pointer.x) / scale;
      focus[1] += (event.clientY - pointer.y) / (scale * 1.13);
      draw();
    }
    pointer.x = event.clientX; pointer.y = event.clientY;
  });
  canvas.addEventListener('pointercancel', () => { pointer = null; });
  canvas.addEventListener('pointerup', event => {
    if (pointer && !pointer.moved) {
      const rect = canvas.getBoundingClientRect();
      const point = unproject(event.clientX - rect.left, event.clientY - rect.top);
      if (point[0] >= demoBounds.west && point[0] <= demoBounds.east && point[1] >= demoBounds.south && point[1] <= demoBounds.north) {
        const nearest = demoPlaces.reduce((best, place) =>
          Math.hypot(place.coords[0] - point[0], place.coords[1] - point[1]) <
          Math.hypot(best.coords[0] - point[0], best.coords[1] - point[1]) ? place : best);
        onPick(nearest);
      }
    }
    pointer = null;
  });
  return {
    render(next) { state = next; draw(); },
    zoom(delta) { zoom = Math.max(0.55, Math.min(4, zoom * (delta === 1 ? 1.28 : 0.78))); draw(); },
    select(active) { canvas.classList.toggle('can-select', active); },
    fit() {
      const points = state.geometry.length ? state.geometry : state.points.map(point => point.coords);
      if (!points.length) { focus = [...center]; zoom = 1; draw(); return; }
      const longitudes = points.map(point => point[0]);
      const latitudes = points.map(point => point[1]);
      const xMin = Math.min(...longitudes), xMax = Math.max(...longitudes);
      const yMin = Math.min(...latitudes), yMax = Math.max(...latitudes);
      focus = [(xMin+xMax) / 2, (yMin+yMax) / 2];
      const { w,h } = size();
      zoom = Math.max(.55, Math.min(2.2, (w - 90) / (base() * Math.max(xMax-xMin,.02)),
        (h - 135) / (base() * 1.13 * Math.max(yMax-yMin,.02))));
      draw();
    },
  };
}

export async function liveMap(element, key, onPick) {
  window._AMapSecurityConfig = { serviceHost: location.origin + '/_AMapService' };
  const sdk = await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => reject(new Error('高德底图加载超时。')), 8500);
    script.src = 'https://webapi.amap.com/loader.js';
    script.onload = () => window.AMapLoader.load({ key, version: '2.0' }).then(sdk => { clearTimeout(timeout); resolve(sdk); }, reject);
    script.onerror = () => { clearTimeout(timeout); reject(new Error('高德底图加载失败。')); };
    document.head.append(script);
  });
  const map = new sdk.Map(element, { viewMode: '2D', zoom: 12, center, mapStyle: 'amap://styles/normal' });
  let overlays = [];
  map.on('click', event => onPick({
    id: `map-${event.lnglat.lng.toFixed(6)}-${event.lnglat.lat.toFixed(6)}`,
    name: '地图选点', coords: [event.lnglat.lng, event.lnglat.lat],
  }));
  return {
    select(active) { map.setDefaultCursor(active ? 'crosshair' : 'grab'); },
    zoom(delta) { map.setZoom(map.getZoom() + delta); },
    fit() { if (overlays.length) map.setFitView(overlays, false, [65,70,65,70], 16); },
    render({ geometry, points, preview }) {
      if (overlays.length) map.remove(overlays);
      overlays = points.map(point => new sdk.Marker({ position: point.coords, title: point.name }));
      if (geometry.length > 1) overlays.push(new sdk.Polyline({
        path: geometry, strokeColor: preview ? color.preview : color.route,
        isOutline: true, outlineColor: '#fff', borderWeight: 2, strokeWeight: 6,
      }));
      if (overlays.length) map.add(overlays);
    },
  };
}
