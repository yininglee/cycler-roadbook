import { offlineMap, liveMap } from './map.js';
import { isCurrentLocation, isLocationReply, mentionsCurrentLocation } from './location-intent.js';

const icons = {
  bike: '<circle cx="5" cy="17" r="3.5"/><circle cx="19" cy="17" r="3.5"/><path d="m5 17 4-7 4 7H5m8 0 3-9-1-2h3M8 10h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
  fit: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
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
  undo: '<path d="M9 14l-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5m5 5H10a6 6 0 0 0 0 12h3"/>',
};
const glyph = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const $ = id => document.getElementById(id);
document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = glyph(node.dataset.icon); });

const state = {
  config: null, map: null, points: [], loop: false, name: '',
  active: null, pending: false, routeError: '', routeIssues: [], previousView: false, editIndex: null, choosing: false,
  revision: 0, searchRequest: 0, planning: false,
  turns: [], preview: null, selection: null, context: null, appliedContext: null,
  roadbooks: [], roadbook: null, panel: 'ai', dirty: false,
  location: null, locating: false,
};
const ridePrompts = [
  ['轻松骑 20 公里', '骑 20 公里左右，尽量少爬升，终点不限。'],
  ['30 公里环线', '骑一条 30 公里左右的环线，最后回到起点。'],
  ['40 公里单程', '骑 40 公里左右的单程，终点不限。'],
];
const editPrompts = [
  ['加个补给点', '途中加一个补给点。'],
  ['找个用餐点', '途中加一家餐厅。'],
  ['找个住宿点', '途中加一个住宿的地方。'],
];
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
    throw Object.assign(new Error(failure.error || '服务暂不可用，请重试。'), { status: response.status, issues: failure.issues });
  }
  return response;
}
const api = async (...args) => (await request(...args)).json();
const asKm = distance => (distance / 1000).toFixed(1);
const routeFrom = route => ({ points: route.points, loop: route.loop, distance: route.distance, supplyPoints: route.supplyPoints });
const previewCandidate = () => state.preview?.turn.candidates[state.preview.index];
const workingCandidate = entry => state.roadbook?.previewEdits?.get(entry)?.current;
const previewHistory = () => state.roadbook?.previewEdits?.get(previewCandidate());
const previewRoute = () => previewHistory()?.current.route ?? previewCandidate()?.route;
const conversationTarget = () => previewRoute() ?? state.roadbook?.saved ?? state.points;
const editorPoints = () => previewRoute()?.points ?? (state.panel === 'ai' ? state.roadbook?.saved?.points : null) ?? state.points;
const selectedIndexFor = points => state.selection?.points === points ? state.selection.index : null;
const canContinueTurn = turn => turn.targetRoute === conversationTarget() &&
  (turn.base?.selectedPoint?.index ?? null) === selectedIndexFor(editorPoints());
const pointRole = (index, points, loop) => index === 0 ? (loop ? '起终点' : '起点') : !loop && index === points.length - 1 ? '终点' : `途经点 ${index}`;
const pointInteractions = () => Boolean(state.roadbook && !state.previousView && !state.pending && !state.planning && !currentExportReview()?.geometry);
const verificationIssues = route => (route?.rules ?? []).filter(rule => rule.hard && (rule.status === 'fail' || rule.status === 'unknown'));
const verificationStatus = rule => rule.status === 'fail' ? '未通过' : '待核实';
const verificationReason = rule => `${rule.label} · ${verificationStatus(rule)}（${rule.detail}）`;
const sameTrack = (first, second) => Boolean(first && second &&
  (first === second || first.trackId && first.trackId === second.trackId));
const savedVersionOf = (entry, route) => sameTrack(entry?.savedVersion?.route, route) ? entry.savedVersion : null;
const candidateSaveLabel = (entry, candidate, saved, fallback) =>
  !savedVersionOf(entry, candidate)?.verification?.length && verificationIssues(candidate).length ? '核实后保存' :
    saved ? '替换已保存路线' : fallback;
const canReviewCandidate = (entry, candidate) => candidate.geometry?.length > 1 &&
  (savedVersionOf(entry, candidate) || candidate.canApply || verificationIssues(candidate).length > 0);
const currentDiagnostic = () => {
  const manual = previewHistory()?.current;
  if (manual?.issues.length) return { target: manual.route, issues: manual.issues };
  const diagnostic = state.roadbook?.diagnostic;
  return diagnostic?.target === conversationTarget() ? diagnostic : null;
};

function recordEdit(history, previous) {
  if (history.undo.length === 30) history.undo.shift();
  history.undo.push(previous);
  history.redo.length = 0;
}

function draftSnapshot() {
  const { points, loop, active, routeError, routeIssues, dirty, appliedContext, context } = state;
  return { points: [...points], loop, active, routeError, routeIssues, dirty, appliedContext, context };
}

function editDraft(change) {
  if (!pointInteractions()) return;
  const history = state.roadbook.draftHistory ??= { undo: [], redo: [] };
  recordEdit(history, draftSnapshot());
  change();
  updateRoute();
}

function activeHistory() {
  return state.preview ? previewHistory() : state.panel === 'manual' ? state.roadbook?.draftHistory : null;
}

function stepHistory(direction) {
  const history = activeHistory();
  if (!pointInteractions() || !history?.[direction].length) return;
  const next = history[direction].pop();
  const other = direction === 'undo' ? 'redo' : 'undo';
  if (state.preview) {
    history[other].push(history.current);
    history.current = next;
    const { points } = next.route;
    state.selection = Number.isInteger(next.index) && points[next.index] ? { points, index: next.index } : null;
  } else {
    history[other].push(draftSnapshot());
    Object.assign(state, next);
    state.dirty ||= Boolean(state.roadbook.saved && state.name !== state.roadbook.saved.name);
    state.revision++;
    state.selection = null;
    renderRoadbooks();
  }
  state.roadbook.diagnostic = null;
  state.choosing = false;
  state.editIndex = null;
  state.searchRequest++;
  $('search-results').hidden = true;
  renderPlan(); renderRoute();
  state.map?.fit();
}
function currentExportReview(book = state.roadbook) {
  const review = book?.exportReview;
  return review && review.saved === book.saved ? review : null;
}
const destinationOf = route => route.loop ? route.points[0].name : route.points.at(-1).name;
const routeEndpoints = route => [route.points[0].name, route.loop ? '返回起点' : destinationOf(route)].join(' → ');
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
  details.hidden = !state.roadbook;
  $('roadbook-empty').hidden = state.roadbooks.length > 0;
  const rows = state.roadbooks.map(book => {
    const current = book === state.roadbook;
    const { name, loop, points } = book.saved ?? (current ? state : book);
    const row = item('li', current ? 'roadbook current' : 'roadbook');
    const select = action('', 'roadbook-select', () => {
      openRoadbook(current ? null : book, book.saved ? 'ai' : undefined);
      persistRoadbooks();
      list.children[state.roadbooks.indexOf(book)]?.firstElementChild.focus({ preventScroll: true });
    });
    select.setAttribute('aria-expanded', current);
    if (current) {
      select.setAttribute('aria-current', 'true');
      select.setAttribute('aria-controls', details.id + ' route-editor');
      select.title = '取消选择';
    }
    const icon = item('span', 'roadbook-icon');
    icon.dataset.icon = '';
    icon.innerHTML = glyph('book');
    const label = item('span', 'roadbook-text');
    const subtitle = points.length ? `${loop ? '环线' : '单程'} · ${points.length} 个点位` : '空白路线';
    label.append(item('strong', '', name), item('small', '', subtitle));
    const arrow = item('span', 'roadbook-chevron');
    arrow.dataset.icon = '';
    arrow.innerHTML = glyph('down');
    select.append(icon, label, arrow);
    row.append(select);
    if (current) row.append(details);
    return row;
  });
  list.replaceChildren(...rows);
}

const roadbookKey = () => 'cycler-roadbooks:' + state.config.mode;

function uniqueRoadbookName(base, except = null) {
  const names = new Set(state.roadbooks.filter(book => book !== except).map(book => book.saved?.name ?? book.name));
  let name = base;
  for (let index = 2; names.has(name); index++) name = base + ' ' + index;
  return name;
}

function cacheEditor() {
  if (!state.roadbook) return;
  Object.assign(state.roadbook, {
    name: state.name, points: [...state.points], loop: state.loop, dirty: state.dirty,
    active: state.active, pending: state.pending, routeError: state.routeError, routeIssues: state.routeIssues, revision: state.revision,
    turns: state.turns, context: state.context, appliedContext: state.appliedContext, input: $('agent-input').value,
    panel: state.panel, planning: state.planning, preview: state.preview, previousView: state.previousView,
  });
}

function persistRoadbooks() {
  try {
    const books = state.roadbooks.map(book => {
      const { id, saved } = book;
      if (!saved) return { id, name: book.name, points: [], loop: false, autoName: book.autoName };
      const { name, points, loop, appliedContext, supplyPoints, verification } = saved;
      return { id, name, points, loop, appliedContext, supplyPoints, verification, trackId: saved.route?.trackId ?? saved.trackId };
    });
    localStorage.setItem(roadbookKey(), JSON.stringify({ books, selected: state.roadbook?.id ?? null }));
    return true;
  } catch {
    return false;
  }
}

function commitRoadbook(verification) {
  const book = state.roadbook;
  if (!book || !state.active || state.pending || state.routeError || state.previousView) return;
  if (book.saved?.route === state.active) verification ??= book.saved.verification;
  if (book.autoName && !book.saved) {
    const start = state.points[0].name;
    const end = state.loop ? '环线' : '到' + state.points.at(-1).name;
    state.name = uniqueRoadbookName(start + end, book);
  }
  state.dirty = false;
  book.draftHistory = null;
  cacheEditor();
  const { name, points, loop, active, appliedContext } = book;
  book.saved = { name, points, loop, route: active, appliedContext, supplyPoints: active.supplyPoints, verification };
  initializeOriginalCandidate(book);
  book.exportReview = null;
  renderRoadbooks();
  toast(persistRoadbooks() ? '路书已保存。' : '已保存到当前页面。浏览器存储不可用。');
}

function loadRoadbooks() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(roadbookKey())); } catch {}
  state.roadbooks = Array.isArray(saved?.books) ? saved.books.filter(book => typeof book?.id === 'string' &&
    typeof book.name === 'string' && Array.isArray(book.points) && book.points.length !== 1)
    .map(book => book.points.length ? { ...book, saved: book } : { ...book, autoName: book.autoName ?? true }) : [];
  openRoadbook(state.roadbooks.find(book => book.id === saved?.selected) ?? null);
}

function openRoadbook(book, panel = book?.panel ?? 'ai') {
  cacheEditor();
  if (state.roadbook && state.roadbook !== book) state.roadbook.exportReview = null;
  state.searchRequest++;
  const needsRoute = book?.points.length > 1 && !book.routeRequest && !book.active && !book.routeError;
  Object.assign(state, {
    roadbook: book, dirty: book?.dirty ?? false,
    name: book?.name ?? '', points: [...(book?.points ?? [])], loop: book?.loop === true,
    revision: book?.revision ?? 0, active: book?.active ?? null, routeError: book?.routeError ?? '', routeIssues: book?.routeIssues ?? [],
    pending: book?.pending ?? needsRoute,
    turns: book?.turns ?? [], context: book?.context ?? book?.appliedContext ?? null, appliedContext: book?.appliedContext ?? null,
    editIndex: null, choosing: false, selection: null, previousView: book?.previousView ?? false,
    planning: book?.planning ?? false, preview: book?.preview ?? null, panel,
  });
  $('search-results').hidden = true;
  $('search-input').value = '';
  $('agent-input').value = book?.input ?? '';
  $('route-editor').hidden = !book;
  initializeOriginalCandidate(book);
  renderEditorTabs();
  renderRoadbooks(); renderPlan(); renderRoute();
  $('agent-results').scrollTop = 0;
  if (needsRoute) calculateRoute();
  else state.map?.fit();
}

function renderEditorTabs() {
  for (const name of ['ai', 'manual']) {
    const selected = name === state.panel;
    const tab = $(name + '-tab');
    tab.setAttribute('aria-selected', selected);
    tab.tabIndex = selected ? 0 : -1;
    $(name + '-panel').hidden = !selected;
  }
}

function showEditor(panel) {
  state.panel = panel;
  state.choosing = false;
  state.editIndex = null;
  state.searchRequest++;
  $('search-results').hidden = true;
  renderEditorTabs();
  renderPlan(panel === 'ai');
  renderRoute();
}

function renderRoadbookDetails() {
  const book = state.roadbook;
  const saved = book?.saved;
  const current = saved?.route;
  const points = saved?.points ?? [];
  $('roadbook-metrics').hidden = !saved;
  metric('distance', current ? asKm(current.distance) : '—', current ? 'km' : '');
  metric('climb', current?.climb == null ? '—' : Math.round(current.climb), current?.climb == null ? '' : 'm');
  const minutes = current?.duration == null ? null : Math.round(current.duration / 60);
  metric('duration', minutes === null ? '—' : minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : minutes,
    minutes === null ? '' : minutes >= 60 ? 'h' : 'min');
  const via = points.slice(1, saved?.loop ? undefined : -1);
  $('roadbook-stops').hidden = !points.length;
  $('roadbook-start').textContent = points[0]?.name ?? '';
  $('roadbook-via').hidden = !via.length;
  $('roadbook-via-list').replaceChildren(...via.map(point => item('li', '', pointLabel(point))));
  $('roadbook-end').textContent = saved?.loop ? '返回起点' : points.at(-1)?.name ?? '';
  const status = $('roadbook-status');
  status.textContent = saved && state.dirty ? '有未保存的修改' : state.pending ? '正在加载路线…' :
    state.routeError ? '路线待调整' : current?.climb === null ? '缺少高程数据，爬升待核实' : '';
  status.hidden = !status.textContent;
  const verification = $('roadbook-verification');
  const review = saved?.verification ?? [];
  verification.hidden = !review.length;
  if (verification.hidden) verification.open = false;
  $('roadbook-verification-issues').replaceChildren(...review.map(rule => item('li', rule.status, verificationReason(rule))));
  $('export').hidden = !saved;
  $('export').disabled = Boolean(book?.download || currentExportReview(book));
  renderExportReview();
}

function renderRoute() {
  const current = selectedRoute();
  const saved = state.panel === 'ai' ? state.roadbook?.saved : null;
  const exportReview = currentExportReview();
  const comparison = exportReview?.geometry ? exportReview : null;
  const candidate = comparison ? null : previewRoute();
  const route = comparison ? comparison.saved.route : candidate ?? (saved ? saved.route : current);
  const diagnostic = comparison || state.previousView ? null : currentDiagnostic();
  const issues = comparison || state.previousView ? [] : mapIssuesFor(route, diagnostic?.issues ?? (candidate || saved && state.dirty ? [] : state.routeIssues));
  const mapIssues = $('map-issues');
  mapIssues.replaceChildren(...issues.map(issue => {
    const row = item('li', `map-issue ${issue.type}`);
    row.append(item('span', 'map-issue-key'), item('span', '', issue.message));
    if (issue.detail) row.title = issue.detail;
    return row;
  }));
  mapIssues.hidden = !issues.length;
  $('clear-map-issues').hidden = !diagnostic;
  $('route-title').textContent = state.name;
  const draftClimb = $('draft-climb');
  draftClimb.hidden = route?.climb == null;
  draftClimb.textContent = draftClimb.hidden ? '' : `预估累计爬升 ${Math.round(route.climb)} m`;
  $('draft-status').textContent = candidate ? '编辑候选路线' : !state.roadbook?.saved ? '路线草稿' : state.dirty ? '有未保存的修改' : '已保存';
  $('manual-end-preview').hidden = !candidate;
  $('manual-end-preview').disabled = state.pending || state.planning;
  $('rename').disabled = Boolean(candidate);
  $('search-form').querySelectorAll('input, button').forEach(control => {
    control.disabled = Boolean(comparison || candidate && (!state.choosing || !pointInteractions()));
  });
  $('loop').checked = candidate?.loop ?? (state.previousView ? state.active.loop : state.loop);
  const readOnly = state.previousView || Boolean(candidate || comparison);
  $('loop').disabled = !state.config || readOnly;
  $('add-point').hidden = Boolean(candidate);
  $('add-point').disabled = !state.config || state.points.length >= 12 || readOnly;
  $('add-point').classList.toggle('active', state.choosing && state.editIndex === null);
  $('save-roadbook').textContent = candidate ? candidateSaveLabel(previewCandidate(), candidate, state.roadbook?.saved, '保存路书') : '保存路书';
  $('save-roadbook').disabled = candidate ? !canReviewCandidate(previewCandidate(), candidate) ||
    sameTrack(candidate, state.roadbook?.saved?.route) || !pointInteractions() || Boolean(diagnostic) :
    !current || readOnly || !state.dirty || state.planning;
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
  } else if (candidate && diagnostic) note.replaceChildren(...diagnostic.issues.map(issue => item('div', '', issue.message)));
  else if (candidate && verificationIssues(candidate).length) {
    note.replaceChildren(...verificationIssues(candidate).map(rule => item('div', rule.status, verificationReason(rule))));
  } else if (route?.climb === null) note.textContent = '缺少高程数据，爬升暂无法核实。';
  note.hidden = !note.hasChildNodes();

  const pointList = $('points');
  const points = comparison?.saved.points ?? (state.previousView ? state.active.points : editorPoints());
  const loop = comparison?.saved.loop ?? candidate?.loop ?? saved?.loop ?? (state.previousView ? state.active.loop : state.loop);
  const selectPoints = pointInteractions();
  const history = activeHistory();
  $('map-history').hidden = !state.roadbook || !(candidate || state.panel === 'manual') || Boolean(comparison);
  for (const direction of ['undo', 'redo']) {
    for (const scope of ['map', 'manual']) $(scope + '-' + direction).disabled = !selectPoints || !history?.[direction].length;
  }
  const selectedIndex = selectedIndexFor(points);
  pointList.replaceChildren();
  if (!points.length) pointList.append(item('li', 'point-empty', '先在地图上选择起点。'));
  points.forEach((point, index) => {
    const end = !loop && index > 0 && index === points.length - 1;
    const row = item('li', `point${end ? ' end' : ''}${selectedIndex === index ? ' selected' : ''}`);
    row.append(item('span', 'point-marker', index === 0 ? (loop ? '环' : '起') : end ? '终' : index));
    const label = !selectPoints && readOnly ? item('span', 'point-name', pointLabel(point)) :
      action(pointLabel(point), 'point-name', () => choosePoint(index));
    if (label.tagName === 'BUTTON') {
      label.disabled = !selectPoints;
      label.setAttribute('aria-pressed', selectedIndex === index);
    }
    label.title = pointLabel(point);
    row.append(label);
    if (candidate) {
      const actions = item('div', 'point-actions');
      actions.append(iconButton('edit', `编辑${pointRole(index, points, loop)} · ${point.name}`, () => choosePoint(index), !selectPoints));
      if (index > 0 && !end) actions.append(iconButton('close', `删除${pointRole(index, points, loop)} · ${point.name}`,
        () => revisePreviewPoint(index, null), !selectPoints || points.length <= 2));
      row.append(actions);
    } else if (!readOnly) {
      const actions = item('div', 'point-actions');
      if (index > 0 && !end) {
        actions.append(iconButton('up', `将${point.name}上移`, () => movePoint(index, -1), index === 1));
        actions.append(iconButton('down', `将${point.name}下移`, () => movePoint(index, 1), index >= points.length - (loop ? 1 : 2)));
      }
      actions.append(iconButton('close', `删除${point.name}`, () => editDraft(() => { state.points.splice(index, 1); }), !selectPoints));
      row.append(actions);
    }
    pointList.append(row);
  });
  state.map?.render({ geometry: route?.geometry ?? [], issues, points, preview: Boolean(candidate), loop, selectedIndex,
    selectable: selectPoints, draggable: selectPoints && (Boolean(candidate) || state.panel === 'manual'), alternateGeometry: comparison?.geometry });
  $('fit-map').disabled = !state.map || !points.length;
  state.map?.select(selectPoints && (state.choosing || !candidate && points.length < 2));
  const message = comparison ? (route ? '绿线为原路书 · 蓝紫线为导出轨迹' : '蓝紫线为导出轨迹') : !state.roadbook ? '选择或新建路线后可在地图上选点' :
    state.choosing ? (state.editIndex === null ? '在地图上选点，或搜索地点' : '请选择点位的新位置') :
    candidate ? state.pending ? '正在重算候选路线' : '点击选中 · 拖动点位调整路线' :
    state.pending ? '正在更新骑行路线' :
    state.routeError && !state.previousView ? '路线待调整' :
    !points.length ? '点击地图设置起点' :
    points.length === 1 ? '请添加下一个路线点' : '可在右侧调整路线点位';
  $('map-message').textContent = state.map || state.config?.mode !== 'amap' ? message : '高德底图暂不可用，可搜索地点';
}

function mapIssuesFor(route, attempts) {
  const rules = verificationIssues(route);
  const marked = rules.filter(rule => rule.mapSpan).map(rule => ({
    type: 'unverified', message: `路段${verificationStatus(rule)} · ${rule.label}`, detail: rule.detail,
    geometry: route.geometry.slice(rule.mapSpan[0], rule.mapSpan[1] + 1),
  }));
  const whole = rules.filter(rule => !rule.mapSpan).map(rule => `${rule.label} · ${rule.detail}`);
  if (route?.climb === null && !whole.some(label => label.includes('爬升'))) whole.push('爬升待核实');
  if (whole.length) marked.push({ type: 'overall', message: `整条路线 · ${whole.join('；')}` });
  return [...attempts.map(issue => ({ ...issue, message: `${issue.type === 'disconnected' ? '未连通' : '接入待核实'} · ${issue.message}（虚线为位置示意）` })), ...marked];
}
function cancelPlanning() {
  const turn = state.turns.at(-1);
  if (turn?.pending) {
    turn.pending = false;
    turn.result = { question: '草稿已更新，本轮规划已结束。' };
  }
  state.planning = false;
  resetOriginalPreview(state.roadbook, state.preview);
  state.preview = null;
  state.selection = null;
}
function choosePoint(index = null) {
  if (!pointInteractions()) return;
  if (index !== null) state.selection = { points: editorPoints(), index };
  state.choosing = true;
  state.editIndex = index;
  renderPlan(); renderRoute();
  if (window.matchMedia('(max-width: 760px)').matches) $('search-form').scrollIntoView({ block: 'nearest' });
  $('search-input').focus({ preventScroll: true });
}
function selectMapPoint(points, index) {
  if (!pointInteractions() || points !== editorPoints() || !points[index]) return;
  state.selection = { points, index };
  state.editIndex = null;
  state.choosing = false;
  renderPlan(); renderRoute();
}

function moveMapPoint(points, index, point) {
  if (!pointInteractions() || points !== editorPoints() || !points[index]) return;
  if (!point.coords.every(Number.isFinite)) return;
  if (points[index].coords.every((value, axis) => Math.abs(value - point.coords[axis]) < 0.000001)) return;
  if (state.preview) {
    revisePreviewPoint(index, point);
  } else if (state.panel === 'manual') {
    editDraft(() => { state.points = points.map((entry, position) => position === index ? { ...entry, ...point } : entry); });
  }
}

function pickPoint(point, fromSearch = false) {
  if (!state.roadbook) {
    if (fromSearch) {
      $('search-results').hidden = true;
      state.map?.centerOn(point.coords);
    }
    return;
  }
  if (state.preview) {
    if (state.choosing && state.editIndex !== null && pointInteractions()) revisePreviewPoint(state.editIndex, point);
    return;
  }
  if (!pointInteractions() || (!fromSearch && !state.choosing && state.points.length >= 2)) return;
  const index = state.editIndex;
  if (index === null && state.points.length >= 12) return toast('最多可以设置 12 个路线点。');
  $('search-results').hidden = true;
  $('search-input').value = '';
  state.searchRequest++;
  if (!state.context?.waitingFor) showEditor('manual');
  editDraft(() => {
    if (index !== null) state.points[index] = point;
    else {
      const where = !state.loop && state.points.length > 1 ? state.points.length - 1 : state.points.length;
      state.points.splice(where, 0, point);
    }
  });
}
function movePoint(index, delta) {
  const next = index + delta;
  editDraft(() => { [state.points[index], state.points[next]] = [state.points[next], state.points[index]]; });
}
async function updateRoute() {
  const book = state.roadbook;
  if (!book) return;
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
  state.routeIssues = [];
  book.diagnostic = null;
  state.previousView = false;
  state.pending = state.points.length > 1;
  if (!state.pending) state.active = null;
  renderRoadbooks(); renderPlan(); renderRoute();
  if (state.pending) await calculateRoute();
  else {
    book.routeRequest = null;
    state.map?.fit();
  }
}

async function calculateRoute() {
  const book = state.roadbook;
  const request = Symbol();
  book.routeRequest = request;
  let result;
  let failure;
  try {
    result = await api('/api/route', { points: state.points, loop: state.loop,
      trackId: state.dirty ? undefined : book.saved?.trackId });
  } catch (error) { failure = error; }
  if (request !== book.routeRequest) return;
  book.routeRequest = null;
  const editor = state.roadbook === book ? state : book;
  editor.pending = false;
  editor.routeError = failure?.message ?? '';
  editor.routeIssues = failure?.issues ?? [];
  if (result) {
    if (book.saved && !editor.dirty) {
      book.saved.route = { ...result, supplyPoints: book.saved.supplyPoints };
      book.saved.trackId = result.trackId;
      initializeOriginalCandidate(book);
      persistRoadbooks();
    }
    editor.active = book.saved && !editor.dirty ? book.saved.route : result;
  }
  if (editor === state) {
    renderPlan(); renderRoute();
    if (result || editor.routeIssues.length) state.map?.fit();
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
  const saved = state.roadbook?.saved;
  const candidate = previewRoute();
  const target = conversationTarget();
  const route = candidate ?? saved ?? state;
  const index = selectedIndexFor(route.points);
  const latest = state.turns.findLast(turn => turn.targetRoute === target && turn.revision === state.revision && !turn.failed &&
    (turn.base?.selectedPoint?.index ?? null) === index);
  const measuredRoute = candidate ?? (saved ? saved.route : selectedRoute());
  const pendingTurn = latest?.result?.context && !latest.result.candidates?.length ? latest : null;
  const context = pendingTurn?.result.context ?? (candidate ? candidateContext(state.preview.turn, previewCandidate(), candidate) :
    saved ? saved.appliedContext : state.context);
  return {
    points: route.points, loop: route.loop,
    distance: measuredRoute?.distance, supplyPoints: measuredRoute?.supplyPoints ?? saved?.supplyPoints, trackId: measuredRoute?.trackId,
    saved: Boolean(saved && !candidate), target: candidate ? 'preview' : saved ? 'saved' : 'draft', context,
    ...(index === null ? {} : { selectedPoint: { index, id: route.points[index].id } }),
    selections: pendingTurn?.base.selections ?? {},
  };
}

function candidateContext(turn, entry, candidate) {
  const savedVersion = savedVersionOf(entry, candidate);
  if (savedVersion) return savedVersion.appliedContext;
  const intent = entry.savedVersion?.appliedContext?.intent ?? turn.result?.context?.intent;
  const open = intent?.destination === 'open' && !candidate.loop;
  const via = candidate.points.slice(1, candidate.loop ? undefined : -1);
  return { intent: {
    ...intent, start: '', end: '', loopAround: '', loop: candidate.loop, keepVia: !open,
    via: open ? (via.some(point => point.visit) ? via.map(point => point.name) : intent.via) : [],
  } };
}

async function revisePreviewPoint(index, replacement) {
  const original = state.preview;
  const entry = previewCandidate();
  const candidate = previewRoute();
  const book = state.roadbook;
  if (!candidate?.points[index] || !pointInteractions()) return;
  const context = candidateContext(original.turn, entry, candidate);
  const previous = previewHistory()?.current ?? { route: candidate, issues: [], index: selectedIndexFor(candidate.points) };
  const request = Symbol();
  book.previewRequest = request;
  book.diagnostic = null;
  state.pending = true;
  state.choosing = false;
  state.editIndex = null;
  state.selection = { points: candidate.points, index };
  state.searchRequest++;
  $('search-results').hidden = true;
  $('search-input').value = '';
  renderPlan(); renderRoute();
  let updated;
  let error;
  try {
    updated = await api('/api/route', { previewEdit: {
      base: { ...routeFrom(candidate), trackId: candidate.trackId }, index, replacement, intent: context?.intent,
    } });
  } catch (failure) { error = failure; }
  if (book.previewRequest !== request) return;
  book.previewRequest = null;
  const editor = state.roadbook === book ? state : book;
  editor.pending = false;
  if (editor.preview === original && (updated || error?.issues?.length)) {
    const edits = book.previewEdits ??= new WeakMap();
    const history = edits.get(entry) ?? { undo: [], redo: [] };
    recordEdit(history, previous);
    history.current = { route: updated ?? candidate, issues: error?.issues ?? [], index: replacement ? index : null };
    edits.set(entry, history);
    if (editor === state) state.selection = replacement ? { points: history.current.route.points, index } : null;
  }
  if (editor === state) {
    if (error) toast(error.message);
    renderPlan(); renderRoute();
    if (error?.issues?.length) state.map?.fit();
  }
}

function resetOriginalPreview(book, preview) {
  if (preview?.index === 0 && preview.turn === book?.originalTurn) book.previewEdits?.delete(preview.turn.candidates[0]);
}

function showPreview(turn, index) {
  if (state.roadbook) state.roadbook.exportReview = null;
  resetOriginalPreview(state.roadbook, state.preview);
  state.preview = index === null ? null : { turn, index };
  state.selection = null;
  state.choosing = false;
  state.editIndex = null;
  $('search-results').hidden = true;
  state.searchRequest++;
  renderPlan(); renderRoute(); state.map?.fit();
}

function initializeOriginalCandidate(book) {
  const savedVersion = book?.saved;
  const route = savedVersion?.route;
  if (!book?.originalTurn && route?.geometry?.length) {
    book.originalTurn = { candidates: [{ route, savedVersion, title: '原路线' }] };
  }
}

function retainSavedCandidate(book, turn) {
  const savedVersion = book.saved;
  const route = savedVersion?.route;
  if (!route?.geometry?.length) return;
  initializeOriginalCandidate(book);
  const entries = [...book.originalTurn.candidates, ...state.turns.flatMap(item => item.candidates ?? [])];
  const existing = entries.find(entry => {
    const working = workingCandidate(entry);
    return !working?.issues.length && sameTrack(working?.route ?? entry.route, route);
  });
  if (existing) existing.savedVersion = savedVersion;
  else (turn ?? book.originalTurn).candidates.push({ route, savedVersion, title: '上一版路线' });
}

function saveCandidate(turn, index) {
  const entry = turn.candidates[index];
  const book = state.roadbook;
  const atStart = turn === book.originalTurn;
  const isOriginal = atStart && index === 0;
  const working = workingCandidate(entry);
  const candidate = working?.route ?? entry.route;
  const canSave = () => state.roadbook === book && (atStart || state.turns.includes(turn)) && canReviewCandidate(entry, candidate) &&
    workingCandidate(entry) === working && !working?.issues.length &&
    !sameTrack(book.saved?.route, candidate) && pointInteractions() && currentDiagnostic()?.target !== candidate;
  if (!canSave()) return;
  const priorVerification = savedVersionOf(entry, candidate)?.verification;
  const review = priorVerification?.length ? [] :
    verificationIssues(candidate).map(({ label, status, detail }) => ({ label, status, detail }));
  const save = () => {
    if (!canSave()) return;
    const resultTurn = atStart ? state.turns.findLast(item => item.candidates?.length) : turn;
    const appliedContext = candidateContext(turn, entry, candidate);
    const history = book.previewEdits?.get(entry);
    if (history) { history.undo.length = 0; history.redo.length = 0; }
    cancelPlanning();
    retainSavedCandidate(book, resultTurn);
    state.revision++;
    state.active = candidate;
    state.points = [...candidate.points];
    state.loop = candidate.loop;
    state.choosing = false;
    state.editIndex = null;
    state.routeError = '';
    state.routeIssues = [];
    book.diagnostic = null;
    state.appliedContext = appliedContext;
    state.context = state.appliedContext;
    commitRoadbook(priorVerification ?? (review.length ? review : undefined));
    if (!isOriginal || sameTrack(entry.route, candidate)) entry.savedVersion = book.saved;
    renderPlan(); renderRoute(); state.map?.fit();
  };
  const overwrite = state.dirty && (book.saved || turn.revision !== state.revision);
  if (review.length) {
    const checked = item('input');
    checked.type = 'checkbox';
    const content = dialog('核实路线后保存', book.saved ? '替换已保存路线' : '保存路线', () => {
      if (checked.checked) save();
    });
    const issues = item('ul', 'verification-issues');
    for (const rule of review) {
      const row = item('li', rule.status);
      row.append(item('strong', '', `${rule.label} · ${verificationStatus(rule)}`), item('p', '', rule.detail));
      issues.append(row);
    }
    const confirmation = item('label', 'verification-confirm');
    confirmation.append(checked, item('span', '', '我已核实上述问题，确认采用这条路线'));
    content.append(issues);
    if (overwrite) content.append(item('p', '', '保存这条候选路线会覆盖当前未保存的手动修改。'));
    content.append(confirmation);
    const button = $('dialog-confirm');
    button.disabled = true;
    checked.addEventListener('change', () => { button.disabled = !checked.checked; });
    $('dialog-title').focus();
  } else if (overwrite) {
    dialog('保存候选路线', '保存路线', save).textContent = '保存这条候选路线会覆盖当前未保存的手动修改。';
  } else {
    save();
  }
}

const candidateTitle = (entry, candidate, index) => entry.title ?? (candidate.loop ? `环线 ${index + 1}` : `终点 · ${destinationOf(candidate)}`);

function renderCandidate(turn, entry, index) {
  const saved = state.roadbook?.saved;
  const working = workingCandidate(entry);
  const candidate = working?.route ?? entry.route;
  const selected = state.preview?.turn === turn && state.preview.index === index;
  const card = item('article', selected ? 'candidate selected' : 'candidate');
  const title = candidateTitle(entry, candidate, index);
  card.append(item('h3', '', title));
  card.append(item('p', 'score', `${asKm(candidate.distance)} km · ${candidate.climb === null ? '爬升待核实' : '预估爬升 ' + Math.round(candidate.climb) + ' m'}`));
  const via = candidate.points.slice(1, candidate.loop ? undefined : -1);
  if (selected) {
    const points = item('div', 'candidate-points');
    candidate.points.forEach((point, pointIndex) => {
      const role = pointRole(pointIndex, candidate.points, candidate.loop);
      const button = action(`${role} · ${pointLabel(point)}`, '', () => {
        selectMapPoint(candidate.points, pointIndex);
        cardFocusPoint(pointIndex);
      });
      button.dataset.routePoint = pointIndex;
      button.setAttribute('aria-pressed', selectedIndexFor(candidate.points) === pointIndex);
      button.disabled = !pointInteractions();
      points.append(button);
    });
    card.append(points);
  } else {
    if (entry.title) card.append(item('p', 'candidate-via', routeEndpoints(candidate)));
    if (via.length) card.append(item('p', 'candidate-via', '途经 ' + via.map(pointLabel).join('、')));
  }
  const rules = item('ul');
  const candidateRules = candidate.rules ?? savedVersionOf(entry, candidate)?.verification ?? [];
  for (const rule of candidateRules) {
    const needsReview = rule.status === 'fail' || rule.status === 'unknown';
    rules.append(item('li', rule.status, needsReview ? verificationReason(rule) : rule.label + ' · ' + rule.detail));
  }
  if (candidateRules.length) card.append(rules);
  const buttons = item('div', 'candidate-actions');
  const preview = action(selected ? '结束预览' : '预览', 'button secondary', () => {
    showPreview(turn, selected ? null : index);
    if (!selected && window.matchMedia('(max-width: 760px)').matches) {
      $('demo-map').closest('.map-card').scrollIntoView({ block: 'start' });
    }
  });
  preview.disabled = state.planning || state.pending || state.previousView;
  buttons.append(preview);
  if (sameTrack(saved?.route, candidate)) {
    buttons.append(item('span', 'candidate-saved', saved.verification?.length ? '已保存 · 用户已核实' : '已保存'));
  } else {
    const save = action(candidateSaveLabel(entry, candidate, saved, '保存路线'), 'button dark', () => saveCandidate(turn, index));
    save.disabled = !canReviewCandidate(entry, candidate) || !pointInteractions() ||
      Boolean(working?.issues.length) || currentDiagnostic()?.target === candidate;
    buttons.append(save);
  }
  card.append(buttons);
  return card;
}

function cardFocusPoint(index) {
  document.querySelector(`.candidate.selected [data-route-point="${index}"]`)?.focus({ preventScroll: true });
}

function ridePrompt(request) {
  const start = state.points[0]?.name || (state.config.mode === 'amap' && state.location ? '当前位置' : '');
  return start ? `从${start}出发，${request}` : `想${request}`;
}

function renderPrompts() {
  const latest = state.turns.at(-1);
  const origin = $('prompt-origin');
  const shortcuts = $('agent-shortcuts');
  const editing = Boolean(previewRoute() || state.roadbook?.saved || state.points.length > 1);
  const waiting = latest?.revision === state.revision &&
    (latest.result?.context?.waitingFor || latest.result?.ambiguous?.length || latest.failed);
  shortcuts.hidden = !state.roadbook || (editing ? Boolean(waiting) : Boolean(latest));
  if (shortcuts.hidden) return;

  const start = state.points[0];
  const live = state.config.mode === 'amap';
  origin.hidden = editing;
  $('prompt-origin-label').textContent = start ? `起点 · ${start.name}` : live && state.location ? '起点 · 当前位置' : '可先设置起点';
  $('prompt-locate').hidden = Boolean(start) || !live || Boolean(state.location);
  $('prompt-locate').disabled = state.locating || !state.map;
  $('prompt-locate-label').textContent = state.locating ? '正在定位…' : '使用当前位置';
  const input = $('agent-input');
  const buttons = (editing ? editPrompts : ridePrompts).map(([label, message]) => {
    const button = action(label, '', () => {
      const value = editing ? message : ridePrompt(message);
      state.roadbook.rideShortcut = editing ? null : { request: message, value };
      input.value = value;
      input.focus({ preventScroll: true });
      input.setSelectionRange(value.length, value.length);
    });
    button.disabled = state.planning || state.pending || state.previousView;
    return button;
  });
  $('prompts').replaceChildren(...buttons);
}

function renderPlan(follow = false) {
  const log = $('agent-results');
  const latest = state.turns.at(-1);
  const book = state.roadbook;
  const original = book?.originalTurn;
  const scrollTop = log.scrollTop;
  log.replaceChildren();
  $('plan-button').disabled = !state.roadbook || state.planning || state.pending || state.previousView;
  renderPrompts();
  log.hidden = !latest && !book?.saved;
  const target = $('agent-target');
  target.replaceChildren();
  const preview = previewRoute();
  const points = editorPoints();
  const picked = selectedIndexFor(points);
  if (preview) {
    target.append(item('span', '', `修改候选 · ${candidateTitle(previewCandidate(), preview, state.preview.index)} · ${asKm(preview.distance)} km`),
      action('结束预览', 'inline-action', () => showPreview(null, null)));
    target.lastChild.disabled = state.pending || state.planning;
  }
  target.hidden = !preview;
  const selection = $('agent-point');
  selection.replaceChildren();
  if (picked !== null) {
    selection.append(item('span', '', `已选${pointRole(picked, points, preview?.loop ?? state.roadbook?.saved?.loop ?? state.loop)} · ${pointLabel(points[picked])}`),
      action('取消选点', 'inline-action', () => { state.selection = null; renderPlan(); renderRoute(); }));
    selection.lastChild.disabled = state.pending || state.planning;
  }
  selection.hidden = picked === null;
  $('agent-input').placeholder = picked !== null ? '想把这个点改到哪里？' : preview ? '说说想怎么改这条候选路线' :
    state.roadbook?.saved ? '说说想怎么改已保存的路线' :
    latest ? '补充你的骑行需求' : '说说想从哪出发、骑多远';
  if (original) {
    original.candidates.forEach((entry, index) => log.append(renderCandidate(original, entry, index)));
  } else if (book?.saved) {
    const card = item('article', 'candidate');
    card.append(item('h3', '', '原路线'), item('p', 'candidate-via', routeEndpoints(book.saved)));
    const status = item('p', 'score', state.routeError || '正在加载路线…');
    status.setAttribute('role', 'status');
    card.append(status);
    if (state.routeError && !state.dirty) {
      const buttons = item('div', 'candidate-actions');
      buttons.append(action('重试', 'button secondary', () => {
        state.pending = true;
        state.routeError = '';
        state.routeIssues = [];
        renderPlan(); renderRoute();
        calculateRoute();
      }));
      card.append(buttons);
    }
    log.append(card);
  }
  for (const turn of state.turns) {
    const entry = item('div', 'agent-turn');
    entry.append(item('p', 'agent-request', turn.prompt));
    if (turn.pending) entry.append(item('p', 'agent-reply', '正在查找地点并比较骑行路线…'));
    if (turn.result?.question) entry.append(item('p', 'agent-reply', turn.result.question));
    if (turn.failed && turn === latest && turn.revision === state.revision) {
      const retry = action('重试', 'button secondary', () => runPlan(turn.query, turn));
      retry.disabled = state.pending || state.planning || !canContinueTurn(turn);
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
          choice.disabled = state.planning || state.pending || state.previousView || !canContinueTurn(turn);
          entry.append(choice);
        }
      }
    }
    const candidates = turn.candidates ?? [];
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
  if (follow || !latest) $('agent-announcement').textContent = latest?.pending
    ? '正在规划路线' : latest?.result?.question ?? '';
}

async function runPlan(query, continuation = null) {
  const book = state.roadbook;
  if (!book || state.pending || state.previousView || state.planning) return;
  const targetRoute = conversationTarget();
  if (continuation && !canContinueTurn(continuation)) return;
  const requestBase = continuation?.base ?? conversationBase();
  const waitingFor = requestBase.context?.waitingFor;
  const needsStart = waitingFor === 'start' || !waitingFor && !requestBase.points.length;
  const usesLocation = mentionsCurrentLocation(query) || needsStart && isLocationReply(query) ||
    isCurrentLocation(requestBase.context?.intent?.start);
  const base = { ...requestBase, location: usesLocation && state.config.mode === 'amap' ? state.location ?? undefined : undefined };
  const history = state.turns.slice(-6).map(turn => ({
    prompt: turn.prompt, reply: turn.result?.question,
    candidates: turn.result?.candidates?.map(route => destinationOf(route)),
  }));
  const turn = { prompt: continuation?.prompt ?? query, query, base, targetRoute, revision: state.revision,
    resume: continuation?.resume === true, pending: true };
  state.turns.push(turn);
  book.diagnostic = null;
  state.planning = true;
  renderPlan(true); renderRoute();
  let result;
  let failed = false;
  try {
    result = await api('/api/plan', {
      ...base, prompt: query, resume: turn.resume, history,
    });
  } catch (error) {
    result = { question: error.message, issues: error.issues };
    failed = true;
  }
  if (!turn.pending) return;
  const editor = state.roadbook === book ? state : book;
  const candidates = result.candidates ?? [];
  Object.assign(turn, { result, failed, pending: false, candidates: candidates.map(route => ({ route })) });
  editor.planning = false;
  if (result.issues?.length) book.diagnostic = { target: targetRoute, issues: result.issues };
  if (!failed) editor.context = result.context;
  if (candidates.length && (editor.panel === 'ai' || turn.base.target === 'preview')) {
    const usable = candidates.findIndex(route => route.canApply);
    if (editor.preview) {
      resetOriginalPreview(book, editor.preview);
      editor.preview.turn.expanded = false;
    }
    editor.preview = { turn, index: Math.max(0, usable) };
    editor.selection = null;
    editor.choosing = false;
    editor.editIndex = null;
  }
  if (editor === state) {
    renderPlan(true); renderRoute();
    if (state.preview?.turn === turn || currentDiagnostic()) state.map?.fit();
  }
}
function dialog(title, label, confirm) {
  const element = $('dialog');
  const content = $('dialog-content');
  $('dialog-title').textContent = title;
  $('dialog-confirm').textContent = label;
  $('dialog-confirm').disabled = false;
  content.replaceChildren();
  element.returnValue = '';
  element.addEventListener('close', () => { if (element.returnValue === 'confirm') confirm(content); }, { once: true });
  element.showModal();
  return content;
}
function exportLink(label, url) {
  const link = item('a', '', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function renderExportReview() {
  const panel = $('export-review');
  panel.replaceChildren();
  const book = state.roadbook;
  const review = currentExportReview(book);
  panel.hidden = !review;
  if (!review) return;
  panel.append(item('h3', '', 'GPX 导出预览'));
  if (review.pending) panel.append(item('p', '', '正在计算可导出的骑行轨迹…'));
  if (review.error) panel.append(item('p', 'export-error', review.error));
  if (review.geometry) {
    const overview = (value, kind, label) => {
      const distance = Number.isFinite(value?.distance) ? `${asKm(value.distance)} km` : '里程待核实';
      const climb = value?.climb == null ? '爬升待核实' : `爬升 ${Math.round(value.climb)} m`;
      const row = item('div', `export-line ${kind}`);
      row.append(item('strong', '', label), item('span', '', `${distance} · ${climb}`));
      return row;
    };
    const lines = item('div', 'export-legend');
    if (review.saved.route) lines.append(overview(review.saved.route, 'original', '原路书'));
    lines.append(overview(review, 'download-track', '导出轨迹'));
    panel.append(lines, item('p', '', '请在地图上检查蓝紫色轨迹，GPX 将使用这条路线。'));
    const credits = item('p', 'export-credit');
    credits.append(exportLink('© OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'),
      ' · ', exportLink('纠正地图', 'https://www.openstreetmap.org/fixthemap'));
    panel.append(credits);
  }
  const controls = item('div', 'export-controls');
  controls.append(action('关闭', 'button secondary', () => {
    book.exportReview = null;
    renderRoute();
    if (state.roadbook === book) $('export').focus();
  }));
  if (!review.pending && review.error) {
    controls.append(action('重新生成', 'button secondary', () => prepareDownload(book, review.saved)));
  }
  if (review.geometry) {
    const button = action(book.download ? '正在下载…' : '下载 GPX', 'button dark', () => download(book, review.saved, review.token));
    button.disabled = Boolean(book.download || review.expired);
    controls.append(button);
  }
  panel.append(controls);
}

async function prepareDownload(book, saved) {
  if (book !== state.roadbook || book.saved !== saved) return;
  const review = { saved, pending: true };
  book.exportReview = review;
  $('search-results').hidden = true;
  renderRoute();
  try {
    const track = await api('/api/export/preview', { ...routeFrom(saved), name: saved.name, confirmed: true });
    Object.assign(review, track);
  } catch (error) {
    review.error = error.message;
  } finally {
    review.pending = false;
    if (book === state.roadbook && currentExportReview(book) === review) {
      renderRoute();
      if (review.geometry) state.map?.fit();
    }
  }
}

async function download(book, saved, token = null) {
  const review = currentExportReview(book);
  if (book.saved !== saved || (token && review?.token !== token)) return;
  book.download = true;
  renderRoadbookDetails();
  try {
    const response = await request('/api/export', token ? { token } : { ...routeFrom(saved), name: saved.name });
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    const name = token ? review.name : saved.name;
    anchor.download = (token ? '' : '演示样例-') + name.replace(/[\\/:*?"<>|]/g, '-') + '.gpx';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(token ? '已下载 GPX。' : '已生成演示 GPX 文件。');
  } catch (error) {
    if (token && review) {
      review.error = error.message;
      review.expired = error.status === 410;
    } else toast(error.message);
  } finally {
    book.download = false;
    if (book === state.roadbook) renderRoadbookDetails();
  }
}

$('search-form').addEventListener('submit', search);
$('search-input').addEventListener('keydown', event => { if (event.key === 'Escape') { state.searchRequest++; $('search-results').hidden = true; } });
$('search-input').addEventListener('input', () => { state.searchRequest++; $('search-results').hidden = true; });
$('add-point').addEventListener('click', () => {
  if (state.choosing && state.editIndex === null) { state.choosing = false; renderRoute(); }
  else choosePoint();
});
$('loop').addEventListener('change', () => editDraft(() => { state.loop = $('loop').checked; }));
$('new-roadbook').addEventListener('click', () => {
  const book = { id: crypto.randomUUID(), name: uniqueRoadbookName('未命名路线'), points: [], loop: false, autoName: true };
  state.roadbooks.unshift(book);
  openRoadbook(book);
  if (!persistRoadbooks()) toast('已在当前页面新建路线。浏览器存储不可用。');
});
$('edit-roadbook').addEventListener('click', () => {
  showEditor('manual');
  $('manual-tab').focus();
});
$('save-roadbook').addEventListener('click', () => {
  if (state.preview) return saveCandidate(state.preview.turn, state.preview.index);
  commitRoadbook();
  renderPlan(); renderRoute();
});
$('manual-end-preview').addEventListener('click', () => showPreview(null, null));
for (const direction of ['undo', 'redo']) {
  for (const scope of ['map', 'manual']) $(scope + '-' + direction).addEventListener('click', () => stepHistory(direction));
}
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing ||
      event.target.closest?.('input, textarea, select, [contenteditable], dialog')) return;
  const key = event.key.toLowerCase();
  const direction = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' ? 'redo' : null;
  if (!direction || !pointInteractions() || !activeHistory()?.[direction].length) return;
  event.preventDefault();
  stepHistory(direction);
});
$('clear-map-issues').addEventListener('click', () => {
  if (previewHistory()?.current.issues.length) return stepHistory('undo');
  if (state.roadbook) state.roadbook.diagnostic = null;
  renderPlan(); renderRoute();
});
$('delete-roadbook').addEventListener('click', () => {
  const book = state.roadbook;
  dialog('删除路书', '删除', () => {
    if (state.roadbook !== book) return;
    cancelPlanning();
    book.routeRequest = null;
    book.previewRequest = null;
    state.roadbooks = state.roadbooks.filter(entry => entry !== book);
    openRoadbook(null);
    $('new-roadbook').focus({ preventScroll: true });
    toast(persistRoadbooks() ? '路书已删除。' : '已从当前页面移除。浏览器存储不可用。');
  }).textContent = `确定删除「${book.saved?.name ?? state.name}」？`;
});
$('rename').addEventListener('click', () => {
  const book = state.roadbook;
  const input = item('input');
  input.value = state.name; input.maxLength = 80; input.setAttribute('aria-label', '路线名称');
  dialog('重命名路线', '确定', () => {
    if (state.roadbook !== book) return;
    const name = input.value.trim() || state.name;
    if (name !== state.name) {
      state.name = name;
      book.autoName = false;
      state.dirty = true;
      cacheEditor();
      if (!book.saved) persistRoadbooks();
      renderRoadbooks();
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
  const book = state.roadbook;
  const saved = book?.saved;
  if (!saved) return;
  if (state.config.mode === 'demo') {
    const content = dialog('导出演示 GPX', '下载 GPX', () => download(book, saved));
    content.append(item('p', '', saved.route ? saved.name + ' · ' + asKm(saved.route.distance) + ' km' : saved.name));
    content.append(item('p', '', '用于验证文件导入。示例路网不用于实际导航。'));
    return;
  }
  const host = state.config.exportRouter;
  if (!host) return toast('GPX 骑行算路服务地址配置无效。');
  const content = dialog('生成 GPX 导出预览', '生成预览', () => prepareDownload(book, saved));
  content.append(item('p', '', `将把已保存路书的起点、途经点和终点坐标发送给 ${host} 算路服务。`));
  content.append(item('p', '', '导出轨迹按 OpenStreetMap 骑行路网重新计算，走向可能与原路书不同。请预览后下载。'));
  if (host === 'routing.openstreetmap.de') content.append(exportLink('算路服务与隐私说明', 'https://routing.openstreetmap.de/about.html'));
});
$('agent-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('agent-input').value.trim();
  if (!value) return $('agent-input').focus();
  if ($('plan-button').disabled) return;
  state.roadbook.rideShortcut = null;
  $('agent-input').value = '';
  runPlan(value);
});
$('agent-input').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  $('agent-form').requestSubmit();
});
$('zoom-in').addEventListener('click', () => state.map?.zoom(1));
$('zoom-out').addEventListener('click', () => state.map?.zoom(-1));
$('fit-map').addEventListener('click', () => state.map?.fit());
$('nationwide-map').addEventListener('click', () => state.map?.showNationwide());

async function locate() {
  if (!state.map || state.locating) return;
  if (!window.isSecureContext) return toast('请通过 HTTPS 或本机地址打开页面后定位。');
  if (!navigator.geolocation) return toast('当前浏览器不支持定位。');

  const button = $('locate-map');
  state.locating = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  renderPrompts();
  toast('正在获取当前位置…');
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 12000,
      });
    });
    const gps = [position.coords.longitude, position.coords.latitude];
    const { coords } = state.config.mode === 'amap' ? await api('/api/location', { coords: gps }) : { coords: gps };
    state.location = coords;
    state.map.showLocation(coords);
    const shortcut = state.roadbook?.rideShortcut;
    if (shortcut && $('agent-input').value === shortcut.value) {
      shortcut.value = ridePrompt(shortcut.request);
      $('agent-input').value = shortcut.value;
    }
    toast('已定位到当前位置。');
  } catch (error) {
    const message = {
      1: '请在浏览器和系统设置中允许访问位置信息。',
      2: '暂时无法获取当前位置，请检查设备定位设置。',
      3: '定位超时，请重试。',
    }[error.code];
    toast(message || error.message || '定位失败，请重试。');
  } finally {
    state.locating = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    renderPrompts();
  }
}
$('locate-map').addEventListener('click', locate);
$('prompt-locate').addEventListener('click', locate);

async function initialize() {
  try {
    state.config = await api('/api/config');
    const demo = state.config.mode === 'demo';
    $('environment').lastChild.textContent = demo ? '演示模式' : '已配置高德';
    $('map-credit').hidden = !demo;
    $('demo-map').hidden = !demo;
    $('live-map').hidden = demo;
    $('footer-note').textContent = demo ? '示例路网与爬升用于体验编辑、规划和 GPX 流程。'
      : 'GPX 导出使用开放骑行路网生成的预览轨迹。';
    if (state.config.elevationSource === 'terrain-tiles') {
      const credit = item('a', '', '高程数据 · Mapzen Terrain Tiles / USGS');
      credit.href = 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md';
      credit.target = '_blank';
      credit.rel = 'noopener noreferrer';
      $('footer-note').append(' ', credit);
    }
    loadRoadbooks();
    $('new-roadbook').disabled = false;
    if (demo) {
      state.map = offlineMap($('demo-map'), pickPoint, selectMapPoint, moveMapPoint);
    } else {
      state.map = await liveMap($('live-map'), state.config.mapKey, pickPoint, selectMapPoint, moveMapPoint);
      $('nationwide-map').hidden = false;
      $('search-input').placeholder = '搜索全国地名或地点';
    }
    for (const id of ['zoom-in', 'zoom-out', 'locate-map']) $(id).disabled = false;
    renderPrompts();
    renderRoute(); state.map.fit();
  } catch (error) {
    $('environment').lastChild.textContent = '地图未连接';
    $('map-message').textContent = error.message;
    renderPlan();
  }
}
initialize();
