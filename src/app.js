'use strict';
/* Acervo: interface do explorer de B-roll. Fala com o Rust via window.__TAURI__. */

const T = window.__TAURI__;
const invoke = T.core.invoke;
const toSrc = (p) => T.core.convertFileSrc(p);
const IS_MAC = /Mac/.test(navigator.userAgent);
const FINDER = IS_MAC ? 'Finder' : 'Explorer';
const TRASH = IS_MAC ? { para: 'para o Lixo', pela: 'pelo Lixo do Mac' } : { para: 'para a Lixeira', pela: 'pela Lixeira do Windows' };
const $ = (id) => document.getElementById(id);

const S = {
  roots: [],
  favorites: new Set(),
  used: [],
  expanded: new Set(),
  prefs: { size: 210, sort: 'name', filter: 'all', orient: 'all', scope: 'all' },
  view: { type: 'home' },
  folders: [],
  files: [],
  visible: [],
  query: '',
  selected: new Set(),
  anchor: -1,
  focus: -1,
  draggingOut: null,
  internalDrop: false,
  signature: '',
};

const el = {
  tree: $('tree'), crumbs: $('crumbs'), search: $('search'), scope: $('scope'),
  content: $('content'), folders: $('folders'), grid: $('grid'), empty: $('empty'),
  sort: $('sort'), size: $('size'), menu: $('menu'), toasts: $('toasts'),
  preview: $('preview'), stage: $('pv-stage'), dropOverlay: $('drop-overlay'),
};

// ---------- utilidades ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sepOf = (p) => (p.includes('\\') ? '\\' : '/');
const basename = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const parentOf = (p) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
const icon = (name, cls = 'ic') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[_\-.]/g, ' ');

function isInside(path, root) {
  if (path === root) return true;
  const sep = sepOf(root);
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}
const rootOf = (path) => S.roots.filter((r) => isInside(path, r)).sort((a, b) => b.length - a.length)[0];

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

function fmtDur(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

const isVertical = (f) => f.meta && f.meta.w && f.meta.h > f.meta.w;

function relLocation(path) {
  const root = rootOf(path);
  const parent = parentOf(path);
  if (!root) return parent;
  const rel = parent.slice(root.length).replace(/^[\\/]+/, '');
  return [basename(root), ...rel.split(/[\\/]/).filter(Boolean)].join(' › ');
}

function waitEvent(target, name, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); target.removeEventListener(name, ok); target.removeEventListener('error', bad); fn(v); };
    const ok = () => done(resolve);
    const bad = () => done(reject, new Error('nopreview'));
    const timer = setTimeout(() => done(reject, new Error('timeout')), ms);
    target.addEventListener(name, ok, { once: true });
    target.addEventListener('error', bad, { once: true });
  });
}

// ---------- estado salvo no PC ----------

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const state = {
      roots: S.roots,
      favorites: [...S.favorites],
      used: S.used,
      expanded: [...S.expanded],
      prefs: S.prefs,
      lastView: S.view,
    };
    invoke('save_state', { state }).catch((e) => console.error('save_state', e));
  }, 250);
}

function remapPaths(from, to) {
  const swap = (p) => (isInside(p, from) ? to + p.slice(from.length) : p);
  S.favorites = new Set([...S.favorites].map(swap));
  S.used = S.used.map((u) => ({ ...u, path: swap(u.path) }));
  S.expanded = new Set([...S.expanded].map(swap));
  if (S.view.type === 'folder') S.view = { ...S.view, path: swap(S.view.path) };
  persist();
}

function forgetPaths(paths) {
  const gone = (p) => paths.some((x) => isInside(p, x));
  S.favorites = new Set([...S.favorites].filter((p) => !gone(p)));
  S.used = S.used.filter((u) => !gone(u.path));
  persist();
}

// ---------- avisos e diálogos ----------

function toast(msg, type = '', ms = 3200) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  el.toasts.append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

function progressToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span></span><div class="bar"><i></i></div>`;
  t.firstChild.textContent = msg;
  el.toasts.append(t);
  return {
    update(text, ratio) { t.firstChild.textContent = text; t.querySelector('.bar i').style.width = `${Math.round(ratio * 100)}%`; },
    close() { t.remove(); },
  };
}

let dialogResolve = null;
function ask({ title, message = '', input = null, ok = 'OK', danger = false, selectBase = false }) {
  $('dlg-title').textContent = title;
  $('dlg-msg').textContent = message;
  const field = $('dlg-input');
  field.classList.toggle('hidden', input === null);
  field.value = input ?? '';
  const okBtn = $('dlg-ok');
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-accent'}`;
  $('dialog').classList.remove('hidden');
  setTimeout(() => {
    if (input === null) { okBtn.focus(); return; }
    field.focus();
    const dot = field.value.lastIndexOf('.');
    if (selectBase && dot > 0) field.setSelectionRange(0, dot); else field.select();
  });
  return new Promise((resolve) => { dialogResolve = resolve; });
}

function closeDialog(value) {
  $('dialog').classList.add('hidden');
  const r = dialogResolve;
  dialogResolve = null;
  if (r) r(value);
}

$('dialog-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const field = $('dlg-input');
  closeDialog(field.classList.contains('hidden') ? true : field.value.trim() || null);
});
$('dlg-cancel').addEventListener('click', () => closeDialog(null));
$('dialog').addEventListener('pointerdown', (e) => { if (e.target.id === 'dialog') closeDialog(null); });

// ---------- menu de contexto ----------

let menuActions = [];
function openMenu(x, y, items) {
  menuActions = [];
  el.menu.innerHTML = items.filter(Boolean).map((it) => {
    if (it === '-') return '<hr>';
    menuActions.push(it.run);
    return `<button data-k="${menuActions.length - 1}" class="${it.danger ? 'danger' : ''}"><span>${esc(it.label)}</span>${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>`;
  }).join('');
  el.menu.classList.remove('hidden');
  const r = el.menu.getBoundingClientRect();
  el.menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  el.menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
const closeMenu = () => el.menu.classList.add('hidden');
el.menu.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  closeMenu();
  menuActions[+b.dataset.k]?.();
});
window.addEventListener('pointerdown', (e) => { if (!el.menu.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);

// ---------- navegação ----------

function go(view) {
  S.view = view;
  S.query = '';
  el.search.value = '';
  S.selected.clear();
  S.anchor = S.focus = -1;
  S.signature = '';
  if (view.type === 'folder') {
    const root = rootOf(view.path);
    if (root) {
      let p = parentOf(view.path);
      while (p && isInside(p, root) && p !== root) { S.expanded.add(p); p = parentOf(p); }
      S.expanded.add(root);
    }
  }
  persist();
  renderNav();
  renderTree();
  el.content.scrollTop = 0;
  loadView();
}

function searchRoots() {
  if (S.prefs.scope === 'here' && S.view.type === 'folder') return [S.view.path];
  return S.roots;
}
const backendSearch = () => S.query.trim() && (S.prefs.scope === 'all' || S.view.type === 'folder');

let loadSeq = 0;
async function loadView({ quiet = false } = {}) {
  const seq = ++loadSeq;
  const bar = quiet ? null : showLoading();
  try {
    let folders = [], files = [];
    if (backendSearch()) {
      files = await invoke('search', { roots: searchRoots(), query: S.query });
    } else if (S.view.type === 'folder') {
      ({ folders, files } = await invoke('list_dir', { path: S.view.path }));
    } else if (S.view.type === 'favorites') {
      files = await invoke('files_info', { pathsList: [...S.favorites] });
    } else if (S.view.type === 'used') {
      files = await invoke('files_info', { pathsList: S.used.map((u) => u.path) });
    } else if (S.view.type === 'recent') {
      files = await invoke('recent', { roots: S.roots, limit: 300 });
    }
    if (seq !== loadSeq) return;
    const sig = folders.map((f) => f.path).join('|') + '#' + files.map((f) => f.key).join('|');
    if (quiet && sig === S.signature) return;
    S.signature = sig;
    S.folders = folders;
    S.files = files;
    const existing = new Set(files.map((f) => f.path));
    S.selected = new Set([...S.selected].filter((p) => existing.has(p)));
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    S.folders = []; S.files = [];
    render();
    toast(`Não deu pra abrir: ${e}`, 'error', 5000);
  } finally {
    bar?.remove();
  }
}

function showLoading() {
  const b = document.createElement('div');
  b.className = 'loading-bar';
  setTimeout(() => { if (b.isConnected === false && !b.dataset.done) el.content.parentElement.append(b); }, 160);
  return { remove() { b.dataset.done = '1'; b.remove(); } };
}

function renderNav() {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view.type));
  $('count-fav').textContent = S.favorites.size || '';
  const titles = { favorites: 'Favoritos', used: 'Usados recentemente', recent: 'Adicionados recentemente', home: 'Acervo' };
  let html = '';
  if (S.view.type === 'folder') {
    const root = rootOf(S.view.path) || S.view.path;
    const sep = sepOf(root);
    const parts = S.view.path.slice(root.length).split(/[\\/]/).filter(Boolean);
    const base = root.endsWith(sep) ? root : root + sep;
    const crumbs = [{ name: basename(root), path: root }];
    parts.forEach((name, i) => crumbs.push({ name, path: base + parts.slice(0, i + 1).join(sep) }));
    html = crumbs.map((c, i) => {
      const sepHtml = i ? `<span class="crumb-sep">${icon('chevron')}</span>` : '';
      return i === crumbs.length - 1 && !S.query
        ? `${sepHtml}<span class="crumb">${esc(c.name)}</span>`
        : `${sepHtml}<button class="crumb" data-path="${esc(c.path)}">${esc(c.name)}</button>`;
    }).join('');
  } else {
    html = S.query ? `<button class="crumb" data-back>${titles[S.view.type]}</button>` : `<span class="crumb">${titles[S.view.type]}</span>`;
  }
  if (S.query) html += `<span class="crumb-sep">${icon('chevron')}</span><span class="crumb">Busca: “${esc(S.query)}”</span>`;
  el.crumbs.innerHTML = html;

  const here = S.view.type === 'folder' ? basename(S.view.path) : null;
  el.scope.textContent = S.prefs.scope === 'here' && here ? 'Só nesta pasta' : 'Tudo';
  el.search.placeholder = S.prefs.scope === 'here' && here ? `Buscar em ${here}` : 'Buscar em todas as bibliotecas';
  const natural = S.view.type === 'used' || S.view.type === 'recent';
  el.sort.disabled = natural;
  el.sort.title = natural ? 'Esta lista já vem em ordem de uso' : '';
  const inFolder = S.view.type === 'folder';
  $('btn-new-folder').disabled = !inFolder;
  $('btn-import').disabled = !inFolder;
}

el.crumbs.addEventListener('click', (e) => {
  const b = e.target.closest('.crumb[data-path], .crumb[data-back]');
  if (!b) return;
  if (b.dataset.back !== undefined) { S.query = ''; el.search.value = ''; renderNav(); loadView(); return; }
  go({ type: 'folder', path: b.dataset.path });
});

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => go({ type: b.dataset.view })));

// ---------- árvore de pastas ----------

const treeCache = new Map();

async function childrenOf(path) {
  if (!treeCache.has(path)) treeCache.set(path, await invoke('subfolders', { path }).catch(() => []));
  return treeCache.get(path);
}

let treeSeq = 0;
async function renderTree() {
  const seq = ++treeSeq;
  if (!S.roots.length) {
    el.tree.innerHTML = '<div class="tree-empty">Nenhuma pasta ainda. Clique no + pra adicionar a pasta dos seus B-rolls.</div>';
    return;
  }
  const current = S.view.type === 'folder' ? S.view.path : null;
  const rows = [];
  async function walk(node, depth, isRoot) {
    const open = S.expanded.has(node.path);
    const kids = open ? await childrenOf(node.path) : null;
    const hasKids = kids ? kids.length > 0 : node.hasChildren;
    rows.push(`<div class="tree-row${isRoot ? ' root' : ''}${node.path === current ? ' on' : ''}" data-folder="${esc(node.path)}" data-root="${isRoot ? 1 : ''}" style="padding-left:${4 + depth * 14}px" title="${esc(node.path)}">
      <span class="chev${open && hasKids ? ' open' : ''}${hasKids ? '' : ' none'}" data-act="toggle">${icon('chevron')}</span>
      ${icon(open && hasKids ? 'folder-open' : 'folder', 'ic folder-ic')}<span class="name">${esc(node.name)}</span></div>`);
    if (kids) for (const k of kids) await walk(k, depth + 1, false);
  }
  for (const root of S.roots) await walk({ name: basename(root), path: root, hasChildren: true }, 0, true);
  if (seq === treeSeq) el.tree.innerHTML = rows.join('');
}

el.tree.addEventListener('click', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  const path = row.dataset.folder;
  if (e.target.closest('[data-act="toggle"]')) {
    if (S.expanded.has(path)) S.expanded.delete(path); else S.expanded.add(path);
    persist();
    renderTree();
    return;
  }
  S.expanded.add(path);
  go({ type: 'folder', path });
});

el.tree.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  e.preventDefault();
  folderMenu(e.clientX, e.clientY, row.dataset.folder, !!row.dataset.root);
});

function refreshTreeAt(path) {
  for (const key of [...treeCache.keys()]) if (isInside(key, path) || isInside(path, key)) treeCache.delete(key);
  renderTree();
}

async function addRoots(paths) {
  const fresh = paths.filter((p) => !S.roots.includes(p));
  if (!fresh.length) { go({ type: 'folder', path: paths[0] }); return; }
  S.roots.push(...fresh);
  persist();
  go({ type: 'folder', path: fresh[0] });
  toast(`${basename(fresh[0])} adicionada à biblioteca`, 'ok');
}

async function addRootDialog() {
  const p = await invoke('pick_folder').catch((e) => { toast(String(e), 'error'); return null; });
  if (p) addRoots([p]);
}

function removeRoot(root) {
  S.roots = S.roots.filter((r) => r !== root);
  persist();
  if (S.view.type === 'folder' && isInside(S.view.path, root)) {
    go(S.roots.length ? { type: 'folder', path: S.roots[0] } : { type: 'home' });
  } else {
    renderTree();
  }
  toast(`${basename(root)} saiu da lista. Os arquivos continuam no computador.`);
}

$('btn-add-root').addEventListener('click', addRootDialog);

// ---------- lista visível (filtro, formato, ordem) ----------

function computeVisible() {
  let list = S.files;
  if (S.query.trim() && !backendSearch()) {
    const terms = norm(S.query).split(/\s+/).filter(Boolean);
    list = list.filter((f) => { const n = norm(f.name); return terms.every((t) => n.includes(t)); });
  }
  if (S.prefs.orient !== 'all') {
    list = list.filter((f) => f.kind !== 'audio' && (!f.meta || !f.meta.w || (S.prefs.orient === 'v') === isVertical(f)));
  }
  const counts = { all: list.length, video: 0, image: 0, audio: 0 };
  list.forEach((f) => counts[f.kind]++);
  if (S.prefs.filter !== 'all') list = list.filter((f) => f.kind === S.prefs.filter);

  const natural = S.view.type === 'used' || S.view.type === 'recent';
  if (S.view.type === 'used' && !backendSearch()) {
    const order = new Map(S.used.map((u, i) => [u.path, i]));
    list = [...list].sort((a, b) => (order.get(a.path) ?? 1e9) - (order.get(b.path) ?? 1e9));
  } else if (!natural || backendSearch()) {
    const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' });
    const sorters = {
      name: byName,
      new: (a, b) => b.modified - a.modified,
      old: (a, b) => a.modified - b.modified,
      size: (a, b) => b.size - a.size,
      dur: (a, b) => (a.meta?.duration ?? Infinity) - (b.meta?.duration ?? Infinity) || byName(a, b),
    };
    list = [...list].sort(sorters[S.prefs.sort] || byName);
  }
  return { list, counts };
}

function waveHTML(key, n = 44) {
  let seed = parseInt(key.slice(0, 8), 16) || 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const phase = rand() * 6;
  let bars = '';
  for (let i = 0; i < n; i++) {
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / n * Math.PI * 2.2 + phase));
    bars += `<i style="height:${Math.round(12 + 70 * env * (0.45 + 0.55 * rand()))}%"></i>`;
  }
  return `<div class="wave">${bars}</div>`;
}

function subLine(f, withLocation) {
  const parts = [];
  if (withLocation) parts.push(relLocation(f.path));
  if (f.meta?.w) parts.push(`${f.meta.w}×${f.meta.h}`);
  parts.push(fmtSize(f.size));
  return esc(parts.join(' · '));
}

function cardHTML(f, i, withLocation) {
  const m = f.meta || {};
  const cls = ['card'];
  if (S.selected.has(f.path)) cls.push('sel');
  if (S.favorites.has(f.path)) cls.push('fav');
  if (f.key === audioKey && !audio.paused) cls.push('playing');
  let media;
  if (f.kind === 'audio') {
    media = waveHTML(f.key) + `<button class="play" data-act="play" title="Ouvir">${icon(f.key === audioKey && !audio.paused ? 'pause' : 'play')}</button>`;
  } else {
    media = `<div class="placeholder">${icon(f.kind)}${m.nopreview ? '<small>Sem prévia, mas arrasta normal</small>' : ''}</div>`;
  }
  const dur = fmtDur(m.duration);
  return `<div class="${cls.join(' ')}" data-i="${i}" data-kind="${f.kind}" data-key="${f.key}">
    <div class="thumb${isVertical(f) ? ' contain' : ''}">${media}
      <span class="badge badge-ext">${esc(f.ext)}</span>
      ${isVertical(f) ? '<span class="badge badge-vert">9:16</span>' : ''}
      ${dur ? `<span class="badge badge-dur">${dur}</span>` : ''}
      <button class="star" data-act="fav" title="Favoritar">${icon('star')}</button>
      ${f.kind === 'video' ? '<div class="scrub"><i></i></div>' : ''}
    </div>
    <div class="info"><div class="name" title="${esc(f.name)}">${esc(f.name)}</div><div class="sub">${subLine(f, withLocation)}</div></div>
  </div>`;
}

let cardEls = [];
let observer;

function render() {
  stopScrub();
  thumbQueue.length = 0;
  const { list, counts } = computeVisible();
  S.visible = list;

  document.querySelectorAll('#filter button').forEach((b) => {
    b.classList.toggle('on', b.dataset.f === S.prefs.filter);
    b.querySelector('em').textContent = counts[b.dataset.f] || '';
  });
  document.querySelectorAll('#orient button').forEach((b) => b.classList.toggle('on', b.dataset.o === S.prefs.orient));

  const showFolders = S.view.type === 'folder' && !S.query.trim();
  el.folders.innerHTML = showFolders
    ? S.folders.map((f) => `<button class="folder-tile" data-folder="${esc(f.path)}" title="${esc(f.name)}">${icon('folder')}<span>${esc(f.name)}</span></button>`).join('')
    : '';

  const withLocation = S.view.type !== 'folder' || !!S.query.trim();
  el.grid.innerHTML = list.map((f, i) => cardHTML(f, i, withLocation)).join('');
  cardEls = [...el.grid.children];

  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      const f = S.visible[+en.target.dataset.i];
      if (f) showThumb(f, en.target);
    }
  }, { root: el.content, rootMargin: '400px 0px' });
  cardEls.forEach((c) => observer.observe(c));

  renderEmpty(list, showFolders);
  updateStatus(counts);
}

let countTimer;
function refreshCounts() {
  const { counts } = computeVisible();
  document.querySelectorAll('#filter button').forEach((b) => { b.querySelector('em').textContent = counts[b.dataset.f] || ''; });
  updateStatus(counts);
}

function renderEmpty(list, showFolders) {
  const hasFolders = showFolders && S.folders.length;
  let html = '';
  if (!S.roots.length) {
    html = `<div class="big-ic">${icon('video')}</div>
      <h2>Monte o acervo de B-roll</h2>
      <p>Escolha a pasta onde ficam os vídeos, imagens e áudios. Os arquivos continuam onde estão: o Acervo só organiza e deixa arrastar direto pro CapCut.</p>
      <div class="actions">
        <button class="btn btn-accent" data-empty="pick">${icon('folder-open')}Escolher pasta</button>
        <button class="btn" data-empty="create">${icon('folder-plus')}Criar pasta nova em ${IS_MAC ? 'Filmes' : 'Vídeos'}</button>
      </div>
      <p style="font-size:12px;color:var(--faint)">Também dá pra arrastar uma pasta do ${FINDER} pra cá.</p>`;
  } else if (!list.length && !hasFolders) {
    if (S.query.trim()) {
      html = `<div class="big-ic">${icon('search')}</div><h2>Nada encontrado</h2><p>Nenhum arquivo com “${esc(S.query)}”${S.prefs.filter !== 'all' || S.prefs.orient !== 'all' ? ' com esses filtros' : ''}.</p>`;
    } else if (S.files.length) {
      html = `<div class="big-ic">${icon('grid')}</div><h2>Nada com esse filtro</h2><p>Troque o filtro de tipo ou de formato lá em cima.</p>`;
    } else if (S.view.type === 'favorites') {
      html = `<div class="big-ic">${icon('star')}</div><h2>Sem favoritos ainda</h2><p>Clique na estrela de um card pra guardar aqui os clipes que você mais usa.</p>`;
    } else if (S.view.type === 'used') {
      html = `<div class="big-ic">${icon('history')}</div><h2>Nada usado ainda</h2><p>Tudo que você arrastar pro editor aparece aqui, do mais recente pro mais antigo.</p>`;
    } else if (S.view.type === 'recent') {
      html = `<div class="big-ic">${icon('clock')}</div><h2>Nenhum arquivo nas bibliotecas</h2><p>Adicione vídeos, imagens ou áudios nas suas pastas.</p>`;
    } else if (S.view.type === 'folder') {
      html = `<div class="big-ic">${icon('import')}</div><h2>Pasta vazia</h2><p>Arraste vídeos, imagens ou áudios do ${FINDER} pra cá, ou use o botão Importar.</p>`;
    }
  }
  el.empty.innerHTML = html;
  el.empty.classList.toggle('hidden', !html);
}

el.empty.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-empty]');
  if (!b) return;
  if (b.dataset.empty === 'pick') addRootDialog();
  if (b.dataset.empty === 'create') {
    try { addRoots([await invoke('create_default_library')]); } catch (err) { toast(String(err), 'error'); }
  }
});

function updateStatus(counts = computeVisible().counts) {
  const parts = [];
  if (counts.video) parts.push(plural(counts.video, 'vídeo', 'vídeos'));
  if (counts.image) parts.push(plural(counts.image, 'imagem', 'imagens'));
  if (counts.audio) parts.push(plural(counts.audio, 'áudio', 'áudios'));
  if (S.view.type === 'folder' && !S.query && S.folders.length) parts.unshift(plural(S.folders.length, 'pasta', 'pastas'));
  $('st-count').textContent = parts.join(' · ');
  const sel = S.visible.filter((f) => S.selected.has(f.path));
  $('st-sel').textContent = sel.length
    ? `${plural(sel.length, 'selecionado', 'selecionados')} · ${fmtSize(sel.reduce((a, f) => a + f.size, 0))} · arraste pro editor`
    : '';
}

// ---------- miniaturas (geradas uma vez e guardadas no PC) ----------

const thumbQueue = [];
const queued = new Set();
let thumbBusy = 0;

function showThumb(f, card) {
  if (f.thumb) { attachImg(card, toSrc(f.thumb)); return; }
  if (f.direct) { attachImg(card, toSrc(f.path)); return; }
  if (f.meta && (f.meta.nopreview || f.kind === 'audio')) return;
  if (queued.has(f.key)) return;
  queued.add(f.key);
  thumbQueue.push(f);
  pumpThumbs();
}

function attachImg(card, src) {
  const thumb = card.querySelector('.thumb');
  if (!thumb || thumb.querySelector('img')) return;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.draggable = false;
  img.decoding = 'async';
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => img.remove();
  img.src = src;
  thumb.insertBefore(img, thumb.querySelector('.badge'));
}

function pumpThumbs() {
  while (thumbBusy < 2 && thumbQueue.length) {
    const f = thumbQueue.pop();
    thumbBusy++;
    makeThumb(f)
      .catch((e) => console.warn('miniatura', f.name, e))
      .finally(() => { thumbBusy--; queued.delete(f.key); pumpThumbs(); });
  }
}

function frameToJpeg(source, w, h) {
  const scale = Math.min(1, 520 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8).split(',')[1];
}

async function makeThumb(f) {
  const src = toSrc(f.path);
  let data = null, meta = {};
  try {
    if (f.kind === 'video') {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      v.src = src;
      try {
        await waitEvent(v, 'loadedmetadata', 20000);
        if (!v.videoWidth) throw new Error('nopreview');
        let d = v.duration;
        if (!isFinite(d)) {
          // .webm de gravação de tela costuma vir sem duração: pular pro fim força o cálculo.
          v.currentTime = 1e101;
          await waitEvent(v, 'seeked', 8000).catch(() => {});
          d = isFinite(v.duration) ? v.duration : 0;
        }
        meta = { duration: d || null, w: v.videoWidth, h: v.videoHeight };
        v.currentTime = Math.max(0.05, Math.min(d * 0.3, 4));
        await waitEvent(v, 'seeked', 15000);
        data = frameToJpeg(v, v.videoWidth, v.videoHeight);
      } finally {
        v.removeAttribute('src');
        v.load();
      }
    } else if (f.kind === 'image') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = src;
      try { await img.decode(); } catch { throw new Error('nopreview'); }
      const w = img.naturalWidth || 480, h = img.naturalHeight || 270;
      meta = { w, h };
      data = frameToJpeg(img, w, h);
    } else {
      const a = new Audio();
      a.preload = 'metadata';
      a.src = src;
      try {
        await waitEvent(a, 'loadedmetadata', 15000);
        meta = { duration: a.duration };
      } finally {
        a.removeAttribute('src');
        a.load();
      }
    }
  } catch (e) {
    if (e.message === 'timeout') return; // tenta de novo na próxima vez
    if (e.name === 'SecurityError') {
      // Sem permissão pra ler o quadro: mostra a imagem original sem guardar miniatura.
      if (f.kind === 'image') { f.direct = true; updateCard(f); }
      return;
    }
    meta = { ...meta, nopreview: true };
    data = null;
  }
  const thumb = await invoke('save_thumb', { key: f.key, data, meta });
  f.meta = meta;
  if (thumb) f.thumb = thumb;
  updateCard(f);
}

function updateCard(f) {
  const i = S.visible.indexOf(f);
  const old = cardEls[i];
  if (!old || old.dataset.key !== f.key) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = cardHTML(f, i, S.view.type !== 'folder' || !!S.query.trim());
  const fresh = tmp.firstElementChild;
  if (old.classList.contains('focus')) fresh.classList.add('focus');
  if (S.prefs.orient !== 'all' && (f.kind === 'audio' || (f.meta?.w && (S.prefs.orient === 'v') !== isVertical(f)))) {
    fresh.classList.add('hidden');
    clearTimeout(countTimer);
    countTimer = setTimeout(refreshCounts, 200);
  }
  old.replaceWith(fresh);
  cardEls[i] = fresh;
  if (f.thumb) attachImg(fresh, toSrc(f.thumb));
  else if (f.direct) attachImg(fresh, toSrc(f.path));
}

// ---------- prévia ao passar o mouse (vídeo) ----------

const scrubV = document.createElement('video');
scrubV.muted = true;
scrubV.preload = 'auto';
scrubV.playsInline = true;
scrubV.crossOrigin = 'anonymous';
let scrubCard = null, scrubPending = null;

function startScrub(card) {
  const f = S.visible[+card.dataset.i];
  if (!f || f.kind !== 'video' || f.meta?.nopreview) return;
  scrubCard = card;
  card.classList.add('scrubbing');
  scrubV.classList.remove('ready');
  if (scrubV.dataset.path !== f.path) {
    scrubV.dataset.path = f.path;
    scrubV.src = toSrc(f.path);
  }
  const thumb = card.querySelector('.thumb');
  thumb.insertBefore(scrubV, thumb.querySelector('.badge'));
}

function scrubTo(ratio) {
  if (!scrubCard) return;
  scrubCard.querySelector('.scrub i').style.width = `${ratio * 100}%`;
  const dur = isFinite(scrubV.duration) ? scrubV.duration : S.visible[+scrubCard.dataset.i]?.meta?.duration;
  if (!dur || scrubV.readyState < 1 || scrubV.seeking) { scrubPending = ratio; return; }
  scrubPending = null;
  scrubV.currentTime = Math.min(dur - 0.05, Math.max(0, ratio * dur));
}

scrubV.addEventListener('seeked', () => {
  scrubV.classList.add('ready');
  if (scrubPending !== null) scrubTo(scrubPending);
});
scrubV.addEventListener('loadedmetadata', () => { if (scrubPending !== null) scrubTo(scrubPending); });

function stopScrub() {
  if (!scrubCard) return;
  scrubCard.classList.remove('scrubbing');
  scrubV.classList.remove('ready');
  scrubV.remove();
  scrubCard = null;
  scrubPending = null;
}

el.grid.addEventListener('pointermove', (e) => {
  if (press) return;
  const card = e.target.closest('.card');
  if (card !== scrubCard) { stopScrub(); if (card) startScrub(card); }
  if (!scrubCard) return;
  const r = scrubCard.querySelector('.thumb').getBoundingClientRect();
  if (e.clientY > r.bottom) return;
  scrubTo(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
});
el.grid.addEventListener('pointerleave', stopScrub);

// ---------- áudio no card ----------

const audio = new Audio();
let audioKey = null;

function togglePlay(f) {
  if (audioKey === f.key && !audio.paused) { audio.pause(); return; }
  if (audioKey !== f.key) {
    audio.src = toSrc(f.path);
    audioKey = f.key;
  }
  audio.play().catch(() => toast('Não deu pra tocar esse áudio aqui', 'error'));
}

function paintAudio() {
  document.querySelectorAll('.card[data-kind="audio"]').forEach((c) => {
    const on = c.dataset.key === audioKey && !audio.paused;
    c.classList.toggle('playing', on || (c.dataset.key === audioKey && audio.currentTime > 0));
    const use = c.querySelector('.play use');
    if (use) use.setAttribute('href', on ? '#i-pause' : '#i-play');
  });
}
audio.addEventListener('play', paintAudio);
audio.addEventListener('pause', paintAudio);
audio.addEventListener('ended', () => { audio.currentTime = 0; paintAudio(); });
audio.addEventListener('timeupdate', () => {
  const c = cardEls.find((x) => x.dataset.key === audioKey);
  if (!c || !audio.duration) return;
  const bars = c.querySelectorAll('.wave i');
  const upto = Math.floor((audio.currentTime / audio.duration) * bars.length);
  bars.forEach((b, i) => b.classList.toggle('past', i < upto));
});

// ---------- seleção ----------

function paintSelection() {
  cardEls.forEach((c, i) => {
    c.classList.toggle('sel', S.selected.has(S.visible[i]?.path));
    c.classList.toggle('focus', i === S.focus);
  });
  updateStatus();
}

function selectOnly(i) {
  S.selected = new Set(S.visible[i] ? [S.visible[i].path] : []);
  S.anchor = S.focus = i;
  paintSelection();
}

function toggleSel(i) {
  const p = S.visible[i].path;
  if (S.selected.has(p)) S.selected.delete(p); else S.selected.add(p);
  S.anchor = S.focus = i;
  paintSelection();
}

function rangeSel(i, add) {
  const a = S.anchor < 0 ? i : S.anchor;
  const [lo, hi] = a < i ? [a, i] : [i, a];
  if (!add) S.selected.clear();
  for (let k = lo; k <= hi; k++) S.selected.add(S.visible[k].path);
  S.focus = i;
  paintSelection();
}

const selectedFiles = () => S.visible.filter((f) => S.selected.has(f.path));

function moveFocus(delta, extend) {
  if (!S.visible.length) return;
  const next = Math.min(S.visible.length - 1, Math.max(0, (S.focus < 0 ? -1 : S.focus) + delta));
  if (extend) rangeSel(next, false); else selectOnly(next);
  cardEls[next]?.scrollIntoView({ block: 'nearest' });
}

const gridColumns = () => getComputedStyle(el.grid).gridTemplateColumns.split(' ').length || 1;

// ---------- arrastar pra fora (CapCut, Premiere, DaVinci...) ----------

let press = null;
let lastDragAt = 0;
const justDragged = () => Date.now() - lastDragAt < 500;

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function dragImage(items) {
  const W = 176, H = 99, off = items.length > 1 ? 10 : 0;
  const c = document.createElement('canvas');
  c.width = W + off;
  c.height = H + off;
  const g = c.getContext('2d');
  if (off) {
    g.fillStyle = 'rgba(255,255,255,.35)';
    roundRect(g, off, 0, W, H, 10);
    g.fill();
  }
  const f = items[0];
  const colors = { video: '#ff6a3d', image: '#2f8fe0', audio: '#8a63e0' };
  g.save();
  roundRect(g, 0, off, W, H, 10);
  g.clip();
  g.fillStyle = colors[f.kind] || '#444';
  g.fillRect(0, off, W, H);
  const card = cardEls[S.visible.indexOf(f)];
  const img = card?.querySelector('img.loaded');
  let drew = false;
  if (img?.naturalWidth) {
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    try { g.drawImage(img, (W - w) / 2, off + (H - h) / 2, w, h); drew = true; } catch { /* sem miniatura */ }
  }
  if (!drew) {
    g.fillStyle = '#fff';
    g.font = '600 20px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(f.ext.toUpperCase(), W / 2, off + H / 2);
  }
  g.restore();
  if (items.length > 1) {
    g.fillStyle = '#ff6a3d';
    g.beginPath();
    g.arc(W + off - 16, 16, 15, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '700 13px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(items.length > 99 ? '99+' : String(items.length), W + off - 16, 16.5);
  }
  try { return c.toDataURL('image/png'); } catch { return null; }
}

function startDragOut(items) {
  if (!items.length) return;
  stopScrub();
  closeMenu();
  const paths = items.map((f) => f.path);
  lastDragAt = Date.now();
  S.draggingOut = paths;
  S.internalDrop = false;
  let dropped = false;
  const channel = new T.core.Channel();
  channel.onmessage = (r) => { if (r?.result === 'Dropped') dropped = true; };
  const image = dragImage(items) || toSrc(paths[0]);
  invoke('plugin:drag|start_drag', { item: paths, image, options: { mode: 'copy' }, onEvent: channel })
    .catch((e) => toast(`Não deu pra arrastar: ${e}`, 'error'))
    .finally(() => setTimeout(() => {
      if (dropped && !S.internalDrop) markUsed(paths);
      S.draggingOut = null;
      hideDropUI();
    }, 450));
}

function markUsed(paths) {
  const now = Date.now();
  S.used = [...paths.map((path) => ({ path, at: now })), ...S.used.filter((u) => !paths.includes(u.path))].slice(0, 300);
  persist();
}

el.grid.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('[data-act]')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  const i = +card.dataset.i;
  const mod = e.ctrlKey || e.metaKey || e.shiftKey;
  if (!S.selected.has(S.visible[i].path) && !mod) selectOnly(i);
  press = { x: e.clientX, y: e.clientY, items: () => (S.selected.has(S.visible[i].path) ? selectedFiles() : [S.visible[i]]) };
});

window.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < 6) return;
  const items = press.items();
  press = null;
  startDragOut(items);
});
window.addEventListener('pointerup', () => { press = null; });

el.grid.addEventListener('click', (e) => {
  if (justDragged()) return;
  const card = e.target.closest('.card');
  if (!card) return;
  const i = +card.dataset.i;
  const f = S.visible[i];
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'fav') { toggleFav([f]); return; }
  if (act === 'play') { togglePlay(f); return; }
  if (e.shiftKey) rangeSel(i, e.ctrlKey || e.metaKey);
  else if (e.ctrlKey || e.metaKey) toggleSel(i);
  else selectOnly(i);
});

el.grid.addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (card && !e.target.closest('[data-act]')) openPreview(+card.dataset.i);
});

el.content.addEventListener('click', (e) => {
  if (justDragged()) return;
  if (e.target === el.content || e.target === el.grid || e.target === el.folders) {
    S.selected.clear();
    S.focus = -1;
    paintSelection();
  }
});

el.folders.addEventListener('click', (e) => {
  const t = e.target.closest('.folder-tile');
  if (t) go({ type: 'folder', path: t.dataset.folder });
});

// ---------- favoritos ----------

function toggleFav(files) {
  const allFav = files.every((f) => S.favorites.has(f.path));
  files.forEach((f) => (allFav ? S.favorites.delete(f.path) : S.favorites.add(f.path)));
  persist();
  $('count-fav').textContent = S.favorites.size || '';
  if (S.view.type === 'favorites' && allFav) { loadView(); return; }
  files.forEach((f) => cardEls[S.visible.indexOf(f)]?.classList.toggle('fav', !allFav));
  if (!el.preview.classList.contains('hidden')) paintPreviewFav();
}

// ---------- ações de arquivo ----------

async function renameItem(path, isFolder) {
  const name = await ask({ title: isFolder ? 'Renomear pasta' : 'Renomear arquivo', input: basename(path), ok: 'Renomear', selectBase: !isFolder });
  if (!name || name === basename(path)) return;
  try {
    const target = await invoke('rename_path', { path, newName: name });
    remapPaths(path, target);
    if (isFolder) refreshTreeAt(parentOf(path));
    S.selected = new Set([target]);
    renderNav();
    loadView({ quiet: true });
  } catch (e) { toast(String(e), 'error'); }
}

async function trashItems(paths) {
  if (!paths.length) return;
  const label = paths.length === 1 ? `“${basename(paths[0])}”` : plural(paths.length, 'item', 'itens');
  const ok = await ask({ title: `Mover ${label} ${TRASH.para}?`, message: `Dá pra recuperar depois ${TRASH.pela}.`, ok: `Mover ${TRASH.para}`, danger: true });
  if (!ok) return;
  try {
    await invoke('trash_paths', { pathsList: paths });
    forgetPaths(paths);
    paths.forEach((p) => refreshTreeAt(parentOf(p)));
    if (S.view.type === 'folder' && paths.some((p) => isInside(S.view.path, p))) { go({ type: 'folder', path: parentOf(paths[0]) }); return; }
    S.selected.clear();
    loadView({ quiet: true });
    toast(`${label} ${paths.length === 1 ? 'foi' : 'foram'} ${TRASH.para}`, 'ok');
  } catch (e) { toast(String(e), 'error'); }
}

async function newFolder(parent) {
  const name = await ask({ title: 'Nova pasta', input: 'Nova pasta', ok: 'Criar' });
  if (!name) return;
  try {
    await invoke('create_folder', { parent, name });
    S.expanded.add(parent);
    refreshTreeAt(parent);
    if (S.view.type === 'folder' && S.view.path === parent) loadView({ quiet: true });
  } catch (e) { toast(String(e), 'error'); }
}

async function importFiles() {
  if (S.view.type !== 'folder') return;
  const dest = S.view.path;
  const paths = await invoke('pick_files').catch(() => []);
  if (paths.length) transfer(paths, dest, 'copy');
}

async function transfer(paths, dest, mode) {
  const verb = mode === 'move' ? 'Movendo' : 'Copiando';
  const t = progressToast(`${verb}...`);
  const unlisten = await T.event.listen('transfer-progress', ({ payload: p }) => {
    t.update(`${verb} ${p.done} de ${p.total}: ${p.name}`, p.done / Math.max(1, p.total));
  });
  try {
    const r = await invoke('transfer', { pathsList: paths, dest, mode });
    if (r.failed.length) toast(`Falhou: ${r.failed[0]}${r.failed.length > 1 ? ` (+${r.failed.length - 1})` : ''}`, 'error', 6000);
    if (r.done.length) {
      const what = plural(r.done.length, 'item', 'itens');
      toast(`${what} ${mode === 'move' ? (r.done.length === 1 ? 'movido' : 'movidos') : (r.done.length === 1 ? 'copiado' : 'copiados')} para ${basename(dest)}`, 'ok');
      if (mode === 'move') paths.forEach((p, k) => r.done[k] && remapPaths(p, r.done[k]));
    } else if (r.skipped && !r.failed.length) {
      toast('Esses arquivos já estão nessa pasta');
    }
    refreshTreeAt(dest);
    if (mode === 'move') paths.forEach((p) => refreshTreeAt(parentOf(p)));
    loadView({ quiet: true });
  } catch (e) {
    toast(String(e), 'error', 6000);
  } finally {
    unlisten();
    t.close();
  }
}

$('btn-new-folder').addEventListener('click', () => S.view.type === 'folder' && newFolder(S.view.path));
$('btn-import').addEventListener('click', importFiles);

// ---------- menus ----------

function cardMenu(x, y) {
  const files = selectedFiles();
  if (!files.length) return;
  const one = files.length === 1 ? files[0] : null;
  const allFav = files.every((f) => S.favorites.has(f.path));
  openMenu(x, y, [
    { label: 'Visualizar', kbd: 'Espaço', run: () => openPreview(S.visible.indexOf(files[0])) },
    { label: allFav ? 'Tirar dos favoritos' : 'Favoritar', kbd: 'F', run: () => toggleFav(files) },
    '-',
    one && { label: `Mostrar no ${FINDER}`, run: () => invoke('reveal', { path: one.path }) },
    one && { label: 'Abrir no programa padrão', run: () => invoke('open_default', { path: one.path }) },
    { label: files.length > 1 ? 'Copiar caminhos' : 'Copiar caminho', run: () => navigator.clipboard.writeText(files.map((f) => f.path).join('\n')).then(() => toast('Copiado', 'ok')) },
    '-',
    one && { label: 'Renomear', kbd: 'F2', run: () => renameItem(one.path, false) },
    { label: `Mover ${TRASH.para}`, kbd: IS_MAC ? '⌘⌫' : 'Del', danger: true, run: () => trashItems(files.map((f) => f.path)) },
  ]);
}

function folderMenu(x, y, path, isRoot) {
  openMenu(x, y, [
    { label: 'Abrir', run: () => go({ type: 'folder', path }) },
    { label: 'Nova pasta aqui dentro', run: () => newFolder(path) },
    { label: `Mostrar no ${FINDER}`, run: () => invoke('reveal', { path }) },
    '-',
    isRoot
      ? { label: 'Tirar da biblioteca', run: () => removeRoot(path) }
      : { label: 'Renomear', run: () => renameItem(path, true) },
    !isRoot && { label: `Mover ${TRASH.para}`, danger: true, run: () => trashItems([path]) },
  ]);
}

document.addEventListener('contextmenu', (e) => {
  if (e.target instanceof Element && e.target.matches('input, textarea')) return;
  e.preventDefault();
  if (el.tree.contains(e.target) || !el.preview.classList.contains('hidden')) return;
  const card = e.target.closest('.card');
  if (card) {
    const i = +card.dataset.i;
    if (!S.selected.has(S.visible[i].path)) selectOnly(i);
    cardMenu(e.clientX, e.clientY);
    return;
  }
  const tile = e.target.closest('.folder-tile');
  if (tile) { folderMenu(e.clientX, e.clientY, tile.dataset.folder, false); return; }
  if (el.content.contains(e.target) && S.view.type === 'folder') {
    const path = S.view.path;
    openMenu(e.clientX, e.clientY, [
      { label: 'Nova pasta', run: () => newFolder(path) },
      { label: 'Importar arquivos...', run: importFiles },
      { label: 'Atualizar', kbd: 'F5', run: () => { treeCache.clear(); renderTree(); loadView(); } },
      '-',
      { label: `Abrir no ${FINDER}`, run: () => invoke('open_default', { path }) },
    ]);
  }
});

document.addEventListener('dragstart', (e) => e.preventDefault());

// ---------- prévia grande ----------

let pvIndex = -1;
let pvPress = null;

function openPreview(i) {
  if (!S.visible[i]) return;
  stopScrub();
  audio.pause();
  pvIndex = i;
  selectOnly(i);
  el.preview.classList.remove('hidden');
  renderPreview();
}

function closePreview() {
  el.preview.classList.add('hidden');
  el.stage.innerHTML = '';
  cardEls[pvIndex]?.scrollIntoView({ block: 'nearest' });
}

function paintPreviewFav() {
  const f = S.visible[pvIndex];
  $('pv-fav').classList.toggle('on', !!f && S.favorites.has(f.path));
}

function renderPreview() {
  const f = S.visible[pvIndex];
  if (!f) { closePreview(); return; }
  const m = f.meta || {};
  $('pv-name').textContent = f.name;
  $('pv-meta').textContent = [f.ext.toUpperCase(), m.w ? `${m.w}×${m.h}` : '', fmtDur(m.duration), fmtSize(f.size), relLocation(f.path)].filter(Boolean).join(' · ');
  $('pv-prev').disabled = pvIndex <= 0;
  $('pv-next').disabled = pvIndex >= S.visible.length - 1;
  paintPreviewFav();
  const src = toSrc(f.path);
  const fail = `<div class="pv-fail">Este formato não abre na prévia deste computador.<br>Mas pode arrastar pro editor normalmente.</div>`;
  if (f.kind === 'video') {
    el.stage.innerHTML = m.nopreview ? fail : `<video src="${esc(src)}" controls autoplay playsinline></video>`;
  } else if (f.kind === 'image') {
    el.stage.innerHTML = m.nopreview ? fail : `<img src="${esc(src)}" alt="" draggable="false">`;
  } else {
    el.stage.innerHTML = `<div class="pv-audio">${waveHTML(f.key, 72)}<audio src="${esc(src)}" controls autoplay></audio></div>`;
  }
  const media = el.stage.querySelector('video, img');
  if (media) media.addEventListener('error', () => { el.stage.innerHTML = fail; }, { once: true });
  cardEls[pvIndex]?.scrollIntoView({ block: 'nearest' });
  selectOnly(pvIndex);
}

function stepPreview(d) {
  const n = pvIndex + d;
  if (n < 0 || n >= S.visible.length) return;
  pvIndex = n;
  renderPreview();
}

$('pv-close').addEventListener('click', closePreview);
$('pv-prev').addEventListener('click', () => stepPreview(-1));
$('pv-next').addEventListener('click', () => stepPreview(1));
$('pv-fav').addEventListener('click', () => S.visible[pvIndex] && toggleFav([S.visible[pvIndex]]));
$('pv-reveal').addEventListener('click', () => S.visible[pvIndex] && invoke('reveal', { path: S.visible[pvIndex].path }));

function previewPointerDown(e) {
  if (e.button !== 0) return;
  pvPress = { x: e.clientX, y: e.clientY };
}
$('pv-drag').addEventListener('pointerdown', previewPointerDown);
el.stage.addEventListener('pointerdown', (e) => { if (e.target.tagName === 'IMG') previewPointerDown(e); });
window.addEventListener('pointermove', (e) => {
  if (!pvPress) return;
  if (Math.abs(e.clientX - pvPress.x) + Math.abs(e.clientY - pvPress.y) < 6) return;
  pvPress = null;
  const f = S.visible[pvIndex];
  if (f) startDragOut([f]);
});
window.addEventListener('pointerup', () => { pvPress = null; });
el.preview.addEventListener('click', (e) => { if (e.target === el.stage) closePreview(); });

// ---------- soltar arquivos do computador no app ----------

let dragIn = null;
let dropHi = null;

function dropTargetAt(pos) {
  const ratio = window.devicePixelRatio || 1;
  const x = pos.x / ratio, y = pos.y / ratio;
  const hit = document.elementFromPoint(x, y);
  if (!hit) return { kind: 'none' };
  const folder = hit.closest('[data-folder]');
  if (folder) return { kind: 'folder', path: folder.dataset.folder, el: folder };
  if (hit.closest('[data-drop-root]') || hit.closest('.tree')) return { kind: 'roots', el: document.querySelector('[data-drop-root]') };
  if (hit.closest('.main')) {
    if (!S.roots.length) return { kind: 'roots', el: null };
    if (S.view.type === 'folder' && !S.query.trim()) return { kind: 'current', path: S.view.path };
  }
  return { kind: 'none' };
}

function updateDropUI(pos) {
  if (!pos) return;
  const t = dropTargetAt(pos);
  if (dropHi && dropHi !== t.el) dropHi.classList.remove('drop-target');
  dropHi = t.el || null;
  dropHi?.classList.add('drop-target');
  const internal = !!S.draggingOut;
  let title = '', sub = '';
  if (t.kind === 'current' && !internal) {
    title = `Solte pra copiar para ${basename(t.path)}`;
    sub = 'Os originais continuam onde estão';
  } else if (t.kind === 'roots' && !internal && !t.el) {
    title = 'Solte a pasta pra adicionar à biblioteca';
    sub = 'Nada é copiado, o Acervo só passa a mostrar essa pasta';
  }
  $('drop-title').textContent = title;
  $('drop-sub').textContent = sub;
  el.dropOverlay.classList.toggle('hidden', !title);
}

function hideDropUI() {
  dropHi?.classList.remove('drop-target');
  dropHi = null;
  el.dropOverlay.classList.add('hidden');
}

async function handleDrop(paths, target) {
  const internal = !!S.draggingOut;
  if (internal) S.internalDrop = true;
  if (!paths?.length) return;
  if (target.kind === 'roots') {
    const kinds = await invoke('path_kinds', { pathsList: paths });
    const dirs = paths.filter((_, i) => kinds[i]);
    if (dirs.length) addRoots(dirs);
    else toast('Solte uma pasta aqui pra adicionar à biblioteca');
    return;
  }
  if (target.kind === 'folder') { transfer(paths, target.path, internal ? 'move' : 'copy'); return; }
  if (target.kind === 'current') { if (!internal) transfer(paths, target.path, 'copy'); return; }
  if (!internal) toast('Abra uma pasta da biblioteca pra soltar os arquivos');
}

function listenDrops() {
  const wv = T.webview?.getCurrentWebview?.();
  if (!wv) return;
  wv.onDragDropEvent(({ payload: p }) => {
    if (p.type === 'enter') { dragIn = p.paths || []; updateDropUI(p.position); }
    else if (p.type === 'over') updateDropUI(p.position);
    else if (p.type === 'leave') { dragIn = null; hideDropUI(); }
    else if (p.type === 'drop') {
      const target = dropTargetAt(p.position);
      hideDropUI();
      handleDrop(p.paths?.length ? p.paths : dragIn, target);
      dragIn = null;
    }
  });
}

// ---------- barra de ferramentas ----------

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    S.query = el.search.value;
    S.selected.clear();
    S.signature = '';
    renderNav();
    el.content.scrollTop = 0;
    loadView();
  }, 200);
});

el.scope.addEventListener('click', () => {
  if (S.view.type !== 'folder') { toast('Abra uma pasta pra buscar só dentro dela'); return; }
  S.prefs.scope = S.prefs.scope === 'all' ? 'here' : 'all';
  persist();
  renderNav();
  if (S.query.trim()) loadView();
  el.search.focus();
});

$('filter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  S.prefs.filter = b.dataset.f;
  persist();
  render();
});

$('orient').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-o]');
  if (!b) return;
  S.prefs.orient = b.dataset.o;
  persist();
  render();
});

el.sort.addEventListener('change', () => { S.prefs.sort = el.sort.value; persist(); render(); });

el.size.addEventListener('input', () => {
  S.prefs.size = +el.size.value;
  document.documentElement.style.setProperty('--card-w', `${S.prefs.size}px`);
  persist();
});

// ---------- teclado ----------

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (!$('dialog').classList.contains('hidden')) { if (k === 'Escape') closeDialog(null); return; }
  if (!el.menu.classList.contains('hidden') && k === 'Escape') { closeMenu(); return; }
  if (k === 'F5' || (mod && k.toLowerCase() === 'r')) {
    e.preventDefault();
    treeCache.clear();
    renderTree();
    loadView();
    return;
  }
  if (!el.preview.classList.contains('hidden')) {
    if (k === 'Escape' || (k === ' ' && e.target.tagName !== 'VIDEO' && e.target.tagName !== 'AUDIO')) { e.preventDefault(); closePreview(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stepPreview(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepPreview(1); }
    else if (k.toLowerCase() === 'f' && !mod) toggleFav([S.visible[pvIndex]]);
    return;
  }
  if (mod && k.toLowerCase() === 'f') { e.preventDefault(); el.search.focus(); el.search.select(); return; }
  if (e.target instanceof Element && e.target.matches('input, select, textarea')) {
    if (k === 'Escape' && e.target === el.search) {
      el.search.value = '';
      el.search.dispatchEvent(new Event('input'));
      el.search.blur();
    }
    if (k === 'ArrowDown' && e.target === el.search && S.visible.length) { el.search.blur(); el.content.focus(); selectOnly(0); }
    return;
  }
  const files = selectedFiles();
  if (mod && k.toLowerCase() === 'a') { e.preventDefault(); S.selected = new Set(S.visible.map((f) => f.path)); paintSelection(); return; }
  if (k === ' ' || k === 'Enter') {
    e.preventDefault();
    const i = S.focus >= 0 ? S.focus : S.visible.indexOf(files[0]);
    openPreview(i >= 0 ? i : 0);
    return;
  }
  if (k === 'F2' && files.length === 1) { e.preventDefault(); renameItem(files[0].path, false); return; }
  if ((k === 'Delete' || (IS_MAC && mod && k === 'Backspace')) && files.length) { e.preventDefault(); trashItems(files.map((f) => f.path)); return; }
  if (k.toLowerCase() === 'f' && !mod && files.length) { toggleFav(files); return; }
  if (k === 'Escape') { S.selected.clear(); S.focus = -1; paintSelection(); return; }
  if (k === 'Backspace' && !mod && S.view.type === 'folder') {
    const root = rootOf(S.view.path);
    if (root && S.view.path !== root) go({ type: 'folder', path: parentOf(S.view.path) });
    return;
  }
  const cols = gridColumns();
  const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
  if (moves[k]) { e.preventDefault(); moveFocus(moves[k], e.shiftKey); }
});

// Volta pro app: atualiza a pasta (pode ter arquivo novo do Explorer/Finder).
let focusTimer;
window.addEventListener('focus', () => {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (S.draggingOut || !$('dialog').classList.contains('hidden')) return;
    treeCache.clear();
    renderTree();
    if (S.view.type !== 'home') loadView({ quiet: true });
  }, 250);
});

// ---------- início ----------

async function init() {
  $('search-kbd').textContent = IS_MAC ? '⌘F' : 'Ctrl F';
  const st = (await invoke('load_state').catch(() => null)) || {};
  S.roots = Array.isArray(st.roots) ? st.roots : [];
  S.favorites = new Set(st.favorites || []);
  S.used = Array.isArray(st.used) ? st.used : [];
  S.expanded = new Set(st.expanded || []);
  Object.assign(S.prefs, st.prefs || {});
  el.sort.value = S.prefs.sort;
  el.size.value = S.prefs.size;
  document.documentElement.style.setProperty('--card-w', `${S.prefs.size}px`);
  listenDrops();
  const last = st.lastView;
  if (last?.type === 'folder' && rootOf(last.path)) go(last);
  else if (last && ['favorites', 'used', 'recent'].includes(last.type) && S.roots.length) go(last);
  else if (S.roots.length) go({ type: 'folder', path: S.roots[0] });
  else go({ type: 'home' });
}

init();
