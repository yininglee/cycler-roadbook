import { demoPlaces, demoPresets } from './demo.js';
import { offlineMap, liveMap } from './map.js';

const icons = {
  bike: '<circle cx="5" cy="17" r="3.5"/><circle cx="19" cy="17" r="3.5"/><path d="m5 17 4-7 4 7H5m8 0 3-9-1-2h3M8 10h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
  locate: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  book: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 3v18m3-13h5m-5 4h5"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3"/>',
  spark: '<path d="M12 2c0 6 4 10 10 10-6 0-10 4-10 10 0-6-4-10-10-10 6 0 10-4 10-10Z"/>',
  edit: '<path d="m5 16-1 4 4-1L20 7l-3-3L5 16Zm10-10 3 3"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  send: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
};
const glyph = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const $ = id => document.getElementById(id);
document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = glyph(node.dataset.icon); });

const state = {
  config: null, map: null, points: [], loop: false, name: '我的骑行路书',
  active: null, pending: false, routeError: '', previousView: false, editIndex: null, choosing: false,
  revision: 0, routeRequest: 0, searchRequest: 0, planning: false, download: false,
  turns: [], preview: null, context: null, appliedContext: null,
  roadbooks: [], roadbook: null, draft: null, expanded: true, panel: 'ai', dirty: false,
};
const item = (tag, className, label) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
};
function iconButton(name, label, handler, disabled = false) {
  const button = item('button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = glyph(name);
  button.disabled = disabled;
  button.addEventListener('click', handler);
  return button;
}
function action(label, className, handler) {
  const button = item('button', className, label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}
async function request(path, input) {
  const response = await fetch(path, input === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(failure.error || '服务暂不可用，请重试。');
  }
  return response;
}
const api = async (...args) => (await request(...args)).json();
const asKm = distance => (distance / 1000).toFixed(1);
const routeFrom = route => ({ points: route.points, loop: route.loop, distance: route.distance, supplyPoints: route.supplyPoints });
const previewRoute = () => state.preview?.turn.result.candidates[state.preview.index];
const destinationOf = route => route.loop ? route.points[0].name : route.points.at(-1).name;
const pointLabel = point => point.visit === 'checkpoint' ? point.name + '（签到点）' : point.name;
let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
function selectedRoute() {
  return !state.pending && (!state.routeError || state.previousView) ? state.active : null;
}
function metric(id, value, unit = '') {
  const node = $(id);
  node.textContent = value;
  if (unit) node.append(item('small', '', unit));
}

function renderRoadbooks() {
  const details = $('roadbook-details');
  const list = $('roadbook-list');
  list.after(details);
  details.hidden = !state.expanded;
  $('roadbook-empty').hidden = state.roadbooks.length > 0;
  $('resume-draft').hidden = state.draft === state.roadbook || !hasDraftContent(state.draft);
  const rows = state.roadbooks.map(book => {
    const current = book === state.roadbook;
    const saved = book.saved;
    const row = item('li', current ? 'roadbook current' : 'roadbook');
    const select = action('', 'roadbook-select', () => {
      if (current) {
        state.expanded = !state.expanded;
        details.hidden = !state.expanded;
        select.setAttribute('aria-expanded', state.expanded);
      } else {
        openRoadbook(book);
        document.querySelector('.roadbook-select[aria-current=true]')?.focus({ preventScroll: true });
      }
    });
    select.setAttribute('aria-expanded', current && state.expanded);
    if (current) {
      select.setAttribute('aria-current', 'true');
      select.setAttribute('aria-controls', details.id);
    }
    const icon = item('span', 'roadbook-icon');
    icon.dataset.icon = '';
    icon.innerHTML = glyph('book');
    const label = item('span', 'roadbook-text');
    const type = saved.loop ? '环线' : '单程';
    label.append(item('strong', '', saved.name), item('small', '', `${type} · ${saved.points.length} 个点位`));
    const arrow = item('span', 'roadbook-chevron');
    arrow.dataset.icon = '';
    arrow.innerHTML = glyph('down');
    select.append(icon, label, arrow);
    row.append(select);
    if (current) row.append(details);
    return row;
  });
  list.replaceChildren(...rows);
  if (!state.roadbook?.saved) details.hidden = true;
}

const roadbookKey = () => 'cycler-roadbooks:' + state.config.mode;
const newRoadbook = (name, points = []) => ({ id: crypto.randomUUID(), name, points, loop: false, autoName: true });
const hasDraftContent = draft => Boolean(draft && (draft.points.length || draft.turns?.length || draft.input));

function uniqueRoadbookName(base) {
  const names = new Set(state.roadbooks.map(book => book.saved.name));
  let name = base;
  for (let index = 2; names.has(name); index++) name = base + ' ' + index;
  return name;
}

function cacheDraft() {
  if (!state.roadbook) return;
  Object.assign(state.roadbook, {
    name: state.name, points: [...state.points], loop: state.loop, dirty: state.dirty,
    active: state.active, needsRoute: state.pending, routeError: state.routeError, revision: state.revision,
    turns: state.turns, context: state.context, appliedContext: state.appliedContext, input: $('agent-input').value,
  });
}

function persistRoadbooks() {
  try {
    const books = state.roadbooks.map(({ id, saved: { name, points, loop, appliedContext, supplyPoints } }) =>
      ({ id, name, points, loop, appliedContext, supplyPoints }));
    localStorage.setItem(roadbookKey(), JSON.stringify({ books, selected: state.roadbook.id }));
    return true;
  } catch {
    return false;
  }
}

function commitRoadbook() {
  const book = state.roadbook;
  if (!book || !state.active || state.pending || state.routeError || state.previousView) return;
  if (book.autoName && !book.saved) {
    const start = state.points[0].name;
    const end = state.loop ? '环线' : '到' + state.points.at(-1).name;
    state.name = uniqueRoadbookName(start + end);
  }
  state.dirty = false;
  cacheDraft();
  if (!book.saved) state.roadbooks.unshift(book);
  const { name, points, loop, active, appliedContext } = book;
  book.saved = { name, points, loop, route: active, appliedContext, supplyPoints: active.supplyPoints };
  if (state.draft === book) state.draft = null;
  state.expanded = true;
  renderRoadbooks();
  toast(persistRoadbooks() ? '路书已保存。' : '已保存到当前页面。浏览器存储不可用。');
}

function loadRoadbooks(demo) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(roadbookKey())); } catch {}
  state.roadbooks = Array.isArray(saved?.books) ? saved.books.filter(book => typeof book?.id === 'string' &&
    typeof book.name === 'string' && Array.isArray(book.points) && book.points.length >= 2)
    .map(book => ({ ...book, saved: book })) : [];
  const book = state.roadbooks.find(book => book.id === saved?.selected) ?? state.roadbooks[0];
  const points = demo ? demoPresets.scenic.map(id => demoPlaces.find(place => place.id === id)) : [];
  openRoadbook(book ?? newRoadbook(demo ? '西湖到钱塘江' : '未命名路线', points));
}

function openRoadbook(book) {
  cancelPlanning('已切换路书，本轮规划已结束。');
  cacheDraft();
  if (!book.saved) state.draft = book;
  state.routeRequest++;
  state.searchRequest++;
  const needsRoute = book.points.length > 1 && (book.needsRoute || !book.active && !book.routeError);
  Object.assign(state, {
    roadbook: book, expanded: true, dirty: book.dirty ?? !book.saved,
    name: book.name, points: [...book.points], loop: book.loop === true,
    revision: book.revision ?? 0, active: book.active ?? null, routeError: book.routeError ?? '', pending: needsRoute,
    turns: book.turns ?? [], context: book.context ?? book.appliedContext ?? null, appliedContext: book.appliedContext ?? null,
    editIndex: null, choosing: false, previousView: false,
  });
  $('search-results').hidden = true;
  $('search-input').value = '';
  $('agent-input').value = book.input ?? '';
  cacheDraft();
  if (book.saved) persistRoadbooks();
  renderRoadbooks(); renderPlan(true); renderRoute();
  if (needsRoute) calculateRoute();
  else state.map?.fit();
}

function showEditor(panel) {
  state.panel = panel;
  for (const name of ['ai', 'manual']) {
    const selected = name === panel;
    const tab = $(name + '-tab');
    tab.setAttribute('aria-selected', selected);
    tab.tabIndex = selected ? 0 : -1;
    $(name + '-panel').hidden = !selected;
  }
  if (panel === 'manual' && state.preview) showPreview(null, null);
  else if (panel === 'ai') renderPlan(true);
}

function renderRoadbookDetails() {
  const saved = state.roadbook?.saved;
  const current = saved?.route;
  const points = saved?.points ?? [];
  metric('distance', current ? asKm(current.distance) : '—', current ? 'km' : '');
  metric('climb', current?.climb == null ? '—' : Math.round(current.climb), current?.climb == null ? '' : 'm');
  const minutes = current?.duration == null ? null : Math.round(current.duration / 60);
  metric('duration', minutes === null ? '—' : minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : minutes,
    minutes === null ? '' : minutes >= 60 ? 'h' : 'min');
  $('roadbook-endpoints').hidden = !points.length;
  $('roadbook-start').textContent = points[0]?.name ?? '';
  $('roadbook-end').textContent = saved?.loop ? '返回起点' : points.at(-1)?.name ?? '';
  const status = $('roadbook-status');
  status.textContent = state.dirty ? '有未保存的修改' : state.pending ? '正在加载路线…' :
    state.routeError ? '路线待调整' : current?.climb === null ? '爬升待核实' : '';
  status.hidden = !status.textContent;
  $('export').disabled = state.download || !saved;
}

function renderRoute() {
  const current = selectedRoute();
  const candidate = previewRoute();
  const route = candidate ?? current;
  $('route-title').textContent = state.name;
  $('draft-status').textContent = !state.roadbook?.saved ? '路线草稿' : state.dirty ? '有未保存的修改' : '已保存';
  $('search-form').querySelectorAll('input, button').forEach(control => { control.disabled = Boolean(candidate); });
  $('loop').checked = candidate?.loop ?? (state.previousView ? state.active.loop : state.loop);
  const readOnly = state.previousView || Boolean(candidate);
  $('loop').disabled = !state.config || readOnly;
  $('add-point').hidden = Boolean(candidate);
  $('add-point').disabled = !state.config || state.points.length >= 12 || readOnly;
  $('add-point').classList.toggle('active', state.choosing && state.editIndex === null);
  $('save-roadbook').disabled = !current || readOnly || !state.dirty || state.planning;
  renderRoadbookDetails();
  const note = $('route-note');
  note.replaceChildren();
  if (state.routeError && !candidate) {
    note.append(item('span', '', state.previousView ? '正在查看上一条完整路线。' : state.routeError));
    if (state.previousView) {
      note.append(action('继续编辑', 'inline-action', () => { state.previousView = false; renderPlan(); renderRoute(); }));
    } else {
      note.append(action('重试', 'inline-action', updateRoute));
      if (state.active) note.append(action('查看上一版', 'inline-action', () => { state.previousView = true; renderPlan(); renderRoute(); state.map?.fit(); }));
    }
  } else if (route && route.climb === null) note.textContent = '爬升暂无法核实。';
  note.hidden = !note.hasChildNodes();

  const pointList = $('points');
  const points = candidate?.points ?? (state.previousView ? state.active.points : state.points);
  const loop = candidate?.loop ?? (state.previousView ? state.active.loop : state.loop);
  pointList.replaceChildren();
  if (!points.length) pointList.append(item('li', 'point-empty', '先在地图上选择起点。'));
  points.forEach((point, index) => {
    const end = !loop && index > 0 && index === points.length - 1;
    const row = item('li', end ? 'point end' : 'point');
    row.append(item('span', 'point-marker', index === 0 ? '起' : end ? '终' : index));
    const label = readOnly ? item('span', 'point-name', pointLabel(point)) :
      action(pointLabel(point), 'point-name', () => choosePoint(index));
    label.title = pointLabel(point);
    row.append(label);
    if (!readOnly) {
      const actions = item('div', 'point-actions');
      if (index > 0 && !end) {
        actions.append(iconButton('up', `将${point.name}上移`, () => movePoint(index, -1), index === 1));
        actions.append(iconButton('down', `将${point.name}下移`, () => movePoint(index, 1), index >= points.length - (loop ? 1 : 2)));
      }
      actions.append(iconButton('close', `删除${point.name}`, () => {
        state.points.splice(index, 1);
        updateRoute();
      }));
      row.append(actions);
    }
    pointList.append(row);
  });
  state.map?.render({ geometry: route?.geometry ?? [], points, preview: Boolean(candidate), loop });
  state.map?.select(!candidate && (state.choosing || !points.length));
  const message = state.choosing ? (state.editIndex === null ? '在地图上选点，或搜索地点' : '请选择点位的新位置') :
    candidate ? '正在预览候选路线' :
    state.pending ? '正在更新骑行路线' :
    state.routeError && !state.previousView ? '路线待调整' :
    !points.length ? '点击地图设置起点' :
    points.length === 1 ? '请添加下一个路线点' : '可在右侧调整路线点位';
  $('map-message').textContent = state.map || state.config?.mode !== 'amap' ? message : '高德底图暂不可用，可搜索地点';
}
function cancelPlanning(message = '草稿已更新，本轮规划已结束。') {
  const turn = state.turns.at(-1);
  if (turn?.pending) {
    turn.pending = false;
    turn.result = { question: message };
  }
  state.planning = false;
  state.preview = null;
}
function choosePoint(index = null) {
  if (!state.config || state.previousView) return;
  state.choosing = true;
  state.editIndex = index;
  renderRoute();
  if (window.matchMedia('(max-width: 760px)').matches) $('search-form').scrollIntoView({ block: 'nearest' });
  $('search-input').focus({ preventScroll: true });
}
function pickPoint(point, fromSearch = false) {
  if (!state.config || state.previousView || state.preview || (!fromSearch && !state.choosing && state.points.length >= 2)) return;
  if (state.editIndex !== null) {
    state.points[state.editIndex] = point;
  } else {
    if (state.points.length >= 12) return toast('最多可以设置 12 个路线点。');
    const where = !state.loop && state.points.length > 1 ? state.points.length - 1 : state.points.length;
    state.points.splice(where, 0, point);
  }
  $('search-results').hidden = true;
  $('search-input').value = '';
  state.searchRequest++;
  if (!state.context?.waitingFor) showEditor('manual');
  updateRoute();
}
function movePoint(index, delta) {
  const next = index + delta;
  [state.points[index], state.points[next]] = [state.points[next], state.points[index]];
  updateRoute();
}
async function updateRoute() {
  if (!state.context?.waitingFor) {
    if (state.appliedContext) {
      state.appliedContext = { intent: {
        ...state.appliedContext.intent, via: [], keepVia: true,
        loop: state.loop, destination: state.loop ? null : 'fixed',
      } };
    }
    state.context = state.appliedContext;
  }
  state.revision++;
  state.dirty = true;
  cancelPlanning();
  state.choosing = false;
  state.editIndex = null;
  state.routeError = '';
  state.previousView = false;
  state.pending = state.points.length > 1;
  if (!state.pending) state.active = null;
  cacheDraft();
  renderPlan(); renderRoute();
  if (state.pending) await calculateRoute();
  else {
    state.routeRequest++;
    state.map?.fit();
  }
}

async function calculateRoute() {
  const request = ++state.routeRequest;
  try {
    const result = await api('/api/route', { points: state.points, loop: state.loop });
    if (request !== state.routeRequest) return;
    state.active = state.roadbook.saved && !state.dirty
      ? { ...result, supplyPoints: state.roadbook.saved.supplyPoints } : result;
    state.pending = false;
    state.routeError = '';
    if (state.roadbook.saved && !state.dirty) state.roadbook.saved.route = state.active;
    cacheDraft();
    renderPlan(); renderRoute();
    state.map?.fit();
  } catch (error) {
    if (request !== state.routeRequest) return;
    state.pending = false;
    state.routeError = error.message;
    cacheDraft();
    renderPlan(); renderRoute();
  }
}
async function search(event) {
  event.preventDefault();
  const query = $('search-input').value.trim();
  const sequence = ++state.searchRequest;
  const results = $('search-results');
  results.hidden = !query;
  if (!query) return;
  results.replaceChildren(item('p', '', '正在搜索…'));
  try {
    const { places } = await api('/api/places?q=' + encodeURIComponent(query));
    if (sequence !== state.searchRequest) return;
    results.replaceChildren();
    for (const place of places) results.append(placeButton(place, () => pickPoint(place, true)));
    if (!places.length) results.append(item('p', '', '没有找到地点，试试其他名称。'));
  } catch (error) {
    if (sequence === state.searchRequest) results.replaceChildren(item('p', '', error.message));
  }
}
function placeButton(place, handler) {
  const button = action('', 'place-choice', handler);
  button.append(item('strong', '', place.name));
  if (place.address) button.append(item('small', '', place.address));
  return button;
}
function conversationBase() {
  const latest = state.turns.at(-1);
  const saved = state.roadbook?.saved;
  const route = saved ?? state;
  const measuredRoute = saved ? saved.route : selectedRoute();
  const pendingTurn = latest?.revision === state.revision && !latest.result?.candidates?.length && latest.result?.context
    ? latest : null;
  return {
    points: route.points, loop: route.loop,
    distance: measuredRoute?.distance, supplyPoints: measuredRoute?.supplyPoints ?? saved?.supplyPoints,
    saved: Boolean(saved), context: pendingTurn?.result.context ?? (saved ? saved.appliedContext : state.context),
    selections: pendingTurn?.base.selections ?? {},
  };
}

function showPreview(turn, index) {
  state.preview = index === null ? null : { turn, index };
  state.choosing = false;
  state.editIndex = null;
  $('search-results').hidden = true;
  state.searchRequest++;
  renderPlan(); renderRoute(); state.map?.fit();
}

function saveCandidate(turn, index) {
  const candidate = turn.result.candidates[index];
  const book = state.roadbook;
  const canSave = () => state.roadbook === book && state.turns.includes(turn) && candidate.canApply &&
    book.saved?.route !== candidate && !state.pending && !state.planning && !state.previousView;
  if (!canSave()) return;
  const save = () => {
    if (!canSave()) return;
    state.revision++;
    state.active = candidate;
    state.points = [...candidate.points];
    state.loop = candidate.loop;
    state.choosing = false;
    state.editIndex = null;
    state.routeError = '';
    const { intent } = turn.result.context;
    const open = intent.destination === 'open' && !candidate.loop;
    const via = candidate.points.slice(1, candidate.loop ? undefined : -1);
    state.appliedContext = { intent: {
      ...intent, start: '', end: '', keepVia: !open,
      via: open ? (via.some(point => point.visit) ? via.map(point => point.name) : intent.via) : [],
    } };
    state.context = state.appliedContext;
    cancelPlanning();
    commitRoadbook();
    renderPlan(); renderRoute(); state.map?.fit();
  };
  if (state.dirty && (book.saved || turn.revision !== state.revision)) {
    dialog('保存候选路线', '保存路线', save).textContent = '保存这条候选路线会覆盖当前未保存的手动修改。';
  } else {
    save();
  }
}

function renderCandidate(turn, candidate, index) {
  const selected = state.preview?.turn === turn && state.preview.index === index;
  const card = item('article', selected ? 'candidate selected' : 'candidate');
  const title = candidate.loop ? `环线 ${index + 1}` : `终点 · ${destinationOf(candidate)}`;
  card.append(item('h3', '', title));
  card.append(item('p', 'score', `${asKm(candidate.distance)} km · ${candidate.climb === null ? '爬升待核实' : '预估爬升 ' + Math.round(candidate.climb) + ' m'}`));
  const via = candidate.points.slice(1, candidate.loop ? undefined : -1);
  if (via.length) card.append(item('p', 'candidate-via', '途经 ' + via.map(pointLabel).join('、')));
  const rules = item('ul');
  for (const rule of candidate.rules) rules.append(item('li', rule.status, rule.label + ' · ' + rule.detail));
  if (candidate.rules.length) card.append(rules);
  const buttons = item('div', 'candidate-actions');
  const preview = action(selected ? '结束预览' : '预览', 'button secondary', () => {
    showPreview(turn, selected ? null : index);
    if (!selected && window.matchMedia('(max-width: 760px)').matches) {
      $('demo-map').closest('.map-card').scrollIntoView({ block: 'start' });
    }
  });
  preview.disabled = state.planning || state.pending || state.previousView;
  buttons.append(preview);
  const saved = state.roadbook?.saved;
  if (saved?.route === candidate) {
    buttons.append(item('span', 'candidate-saved', '已保存'));
  } else {
    const save = action(saved ? '替换已保存路线' : '保存路线', 'button dark', () => saveCandidate(turn, index));
    save.disabled = !candidate.canApply || state.planning || state.pending || state.previousView;
    buttons.append(save);
  }
  card.append(buttons);
  return card;
}

function renderPlan(follow = false) {
  const log = $('agent-results');
  const latest = state.turns.at(-1);
  const scrollTop = log.scrollTop;
  log.replaceChildren();
  $('plan-button').disabled = !state.config || state.planning || state.pending || state.previousView;
  $('prompts').hidden = Boolean(latest);
  log.hidden = !latest;
  const target = $('agent-target');
  target.replaceChildren();
  const preview = previewRoute();
  if (preview) {
    target.append(item('span', '', '候选预览 · ' + destinationOf(preview)),
      action('结束预览', 'inline-action', () => showPreview(null, null)));
  }
  target.hidden = !preview;
  $('agent-input').placeholder = state.roadbook?.saved ? '说说想怎么改已保存的路线' :
    latest ? '补充你的骑行需求' : '说说想从哪出发、骑多远';
  for (const turn of state.turns) {
    const entry = item('div', 'agent-turn');
    entry.append(item('p', 'agent-request', turn.prompt));
    if (turn.pending) entry.append(item('p', 'agent-reply', '正在查找地点并比较骑行路线…'));
    if (turn.result?.question) entry.append(item('p', 'agent-reply', turn.result.question));
    if (turn.failed && turn === latest && turn.revision === state.revision) {
      const retry = action('重试', 'button secondary', () => runPlan(turn.query, turn));
      retry.disabled = state.pending || state.planning;
      entry.append(retry);
    }
    if (turn.revision === state.revision) {
      for (const group of turn.result?.ambiguous ?? []) {
        entry.append(item('p', 'agent-reply', group.name));
        for (const place of group.places) {
          const choice = placeButton(place, () => runPlan(turn.query, {
            ...turn, prompt: '选择 ' + place.name, resume: true,
            base: { ...turn.base, context: turn.result.context,
              selections: { ...turn.base.selections, [group.name]: place.id } },
          }));
          choice.disabled = state.planning || state.pending || state.previousView;
          entry.append(choice);
        }
      }
    }
    const candidates = turn.result?.candidates ?? [];
    if (candidates.length) {
      const details = item('details', 'agent-candidates');
      details.open = turn.expanded ?? (turn === latest || state.preview?.turn === turn);
      details.addEventListener('toggle', () => { if (details.isConnected) turn.expanded = details.open; });
      details.append(item('summary', '', `${candidates.length} 条候选路线`));
      const list = item('div', 'agent-route-list');
      candidates.forEach((candidate, index) => list.append(renderCandidate(turn, candidate, index)));
      details.append(list);
      entry.append(details);
    }
    log.append(entry);
  }
  const lastEntry = log.lastElementChild;
  log.scrollTop = follow && lastEntry ? lastEntry.offsetTop : scrollTop;
  if (follow) $('agent-announcement').textContent = latest?.pending
    ? '正在规划路线' : latest?.result?.question ?? '';
}

async function runPlan(query, continuation = null) {
  if (!state.config || state.pending || state.previousView || state.planning) return;
  const base = continuation?.base ?? conversationBase();
  const history = state.turns.slice(-6).map(turn => ({
    prompt: turn.prompt, reply: turn.result?.question,
    candidates: turn.result?.candidates?.map(route => destinationOf(route)),
  }));
  const turn = { prompt: continuation?.prompt ?? query, query, base, revision: state.revision,
    resume: continuation?.resume === true, pending: true };
  state.turns.push(turn);
  state.planning = true;
  renderPlan(true); renderRoute();
  try {
    const result = await api('/api/plan', {
      ...base, prompt: query, resume: turn.resume, history,
    });
    if (!turn.pending) return;
    turn.result = result;
    state.context = result.context;
    const candidates = turn.result.candidates;
    if (candidates?.length && state.panel === 'ai') {
      const usable = candidates.findIndex(route => route.canApply);
      if (state.preview) state.preview.turn.expanded = false;
      state.preview = { turn, index: Math.max(0, usable) };
      state.choosing = false;
      state.editIndex = null;
    }
  } catch (error) {
    if (!turn.pending) return;
    turn.result = { question: error.message };
    turn.failed = true;
  } finally {
    if (turn.pending) {
      turn.pending = false;
      state.planning = false;
      renderPlan(true); renderRoute();
      if (state.preview?.turn === turn) state.map?.fit();
    }
  }
}
function dialog(title, label, confirm) {
  const element = $('dialog');
  const content = $('dialog-content');
  $('dialog-title').textContent = title;
  $('dialog-confirm').textContent = label;
  content.replaceChildren();
  element.returnValue = '';
  element.addEventListener('close', () => { if (element.returnValue === 'confirm') confirm(content); }, { once: true });
  element.showModal();
  return content;
}
async function download(route, name) {
  state.download = true; renderRoute();
  try {
    const response = await request('/api/export', { ...routeFrom(route), name });
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '演示样例-' + name.replace(/[\\/:*?"<>|]/g, '-') + '.gpx';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已生成演示 GPX 文件。');
  } catch (error) { toast(error.message); }
  finally { state.download = false; renderRoute(); }
}

$('search-form').addEventListener('submit', search);
$('search-input').addEventListener('keydown', event => { if (event.key === 'Escape') { state.searchRequest++; $('search-results').hidden = true; } });
$('search-input').addEventListener('input', () => { state.searchRequest++; $('search-results').hidden = true; });
$('add-point').addEventListener('click', () => {
  if (state.choosing && state.editIndex === null) { state.choosing = false; renderRoute(); }
  else choosePoint();
});
$('loop').addEventListener('change', () => { state.loop = $('loop').checked; updateRoute(); });
$('new-roadbook').addEventListener('click', () => {
  cacheDraft();
  const create = () => openRoadbook(newRoadbook('未命名路线'));
  if (hasDraftContent(state.draft)) {
    dialog('新建路线', '新建', create).textContent = '未保存的路线草稿将被替换。';
  } else {
    create();
  }
});
$('resume-draft').addEventListener('click', () => openRoadbook(state.draft));
$('edit-roadbook').addEventListener('click', () => {
  showEditor('manual');
  $('manual-tab').focus();
});
$('save-roadbook').addEventListener('click', () => {
  commitRoadbook();
  renderRoute();
});
$('delete-roadbook').addEventListener('click', () => {
  const book = state.roadbook;
  dialog('删除路书', '删除', () => {
    state.roadbooks = state.roadbooks.filter(entry => entry !== book);
    openRoadbook(state.roadbooks[0] ?? state.draft ?? newRoadbook('未命名路线'));
    toast(persistRoadbooks() ? '路书已删除。' : '已从当前页面移除。浏览器存储不可用。');
  }).textContent = `确定删除「${book.saved.name}」？`;
});
$('rename').addEventListener('click', () => {
  const input = item('input');
  input.value = state.name; input.maxLength = 80; input.setAttribute('aria-label', '路线名称');
  dialog('重命名路线', '确定', () => {
    const name = input.value.trim() || state.name;
    if (name !== state.name) {
      state.name = name;
      state.roadbook.autoName = false;
      state.dirty = true;
      cacheDraft();
      renderRoute();
    }
    $('rename').focus();
  }).append(input);
  input.focus(); input.select();
});
for (const name of ['ai', 'manual']) {
  const tab = $(name + '-tab');
  tab.addEventListener('click', () => showEditor(name));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'ai' : event.key === 'End' ? 'manual' : name === 'ai' ? 'manual' : 'ai';
    showEditor(target);
    $(target + '-tab').focus();
  });
}
$('export').addEventListener('click', () => {
  const saved = state.roadbook?.saved;
  if (!saved) return;
  if (state.config.mode !== 'demo') {
    toast('高德路线暂无法导出 GPX，待确认数据授权和坐标方案。');
    return;
  }
  const content = dialog('导出演示 GPX', '下载 GPX', () => download(saved, saved.name));
  content.append(item('p', '', saved.route ? saved.name + ' · ' + asKm(saved.route.distance) + ' km' : saved.name));
  content.append(item('p', '', '用于验证文件导入。示例路网不用于实际导航。'));
});
$('agent-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('agent-input').value.trim();
  if (!value) return $('agent-input').focus();
  if ($('plan-button').disabled) return;
  $('agent-input').value = '';
  runPlan(value);
});
$('agent-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  $('agent-form').requestSubmit();
});
$('prompts').querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  $('agent-input').value = button.dataset.prompt;
  $('agent-input').focus();
}));
$('zoom-in').addEventListener('click', () => state.map?.zoom(1));
$('zoom-out').addEventListener('click', () => state.map?.zoom(-1));
$('fit-map').addEventListener('click', () => state.map?.fit());

async function initialize() {
  try {
    state.config = await api('/api/config');
    const demo = state.config.mode === 'demo';
    $('environment').lastChild.textContent = demo ? '演示模式' : '已配置高德';
    $('map-credit').hidden = !demo;
    $('demo-map').hidden = !demo;
    $('live-map').hidden = demo;
    $('footer-note').textContent = demo ? '示例路网与爬升用于体验编辑、规划和 GPX 流程。'
      : '真实路线可用于预览。高德轨迹的 GPX 导出需完成授权和坐标验证。';
    loadRoadbooks(demo);
    $('new-roadbook').disabled = false;
    if (demo) {
      state.map = offlineMap($('demo-map'), pickPoint);
    } else {
      state.map = await liveMap($('live-map'), state.config.mapKey, pickPoint);
    }
    renderRoute(); state.map.fit();
  } catch (error) {
    $('environment').lastChild.textContent = '地图未连接';
    $('map-message').textContent = error.message;
    renderPlan();
  }
}
initialize();
