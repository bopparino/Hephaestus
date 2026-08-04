// Hephaestus shell 2.0 — direction 1b. Thin client: the daemon owns
// everything, this renders. Auth rides the URL fragment from `heph ui`.

'use strict';

const token = location.hash.slice(1);
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- markdown (assistant turns only) --------------------------------------
// Escape-first, then transform — nothing model-authored ever reaches
// innerHTML unescaped. Small on purpose: headings, lists, quotes, fences,
// inline code/bold/em, and http(s) links. Tables render as text.

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function md(src) {
  const fences = [];
  const s = esc(src).replace(/```\w*\n([\s\S]*?)```/g, (_, code) => {
    fences.push(`<pre class="mdc"><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${fences.length - 1}\u0000`;
  });
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join('\n'))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of s.split('\n')) {
    const fence = line.match(/^\u0000(\d+)\u0000\s*$/);
    if (fence) { flushPara(); flushList(); out.push(fences[Number(fence[1])]); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${mdInline((ul ?? ol)[1])}</li>`);
      continue;
    }
    const q = line.match(/^&gt;\s?(.*)$/);
    if (q) { flushPara(); flushList(); out.push(`<blockquote>${mdInline(q[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}

const OP_VERBS = {
  fs_read: 'read', fs_write: 'write', fs_list: 'list', fs_grep: 'grep',
  shell: 'shell', web_search: 'search', web_fetch: 'fetch',
  memory_save: 'recall', skills_list: 'skills', skill_view: 'skill', skill_save: 'skill+',
};
const opVerb = name => OP_VERBS[name] ?? (name.startsWith('mcp_') ? name.split('_')[1] : name);

const state = {
  sessions: [], projects: [], skins: [], models: [], bindings: {},
  view: 'new',              // new | chat | project | memory | receipts | artifacts
  sessionId: null,
  projectFilter: null,      // switcher: null = all
  spaceName: null,
  scopeProject: null,       // composer @project chip
  refs: [], attachments: [], fileTexts: [],
  plan: false,
  // Streams route by session — leaving a chat never kills its run. The
  // daemon was always fine; the glass had one global wire. Not anymore.
  inflight: new Set(),      // sessionIds with a run in progress
  streams: new Map(),       // sessionId -> buffered text (replay on return)
  awaitingSession: false,   // a send whose new session id hasn't landed yet
  meter: { calls: 0, tokens: 0 },
  touched: new Map(),       // file -> 'written' | 'read' (this thread, live)
  learned: [],              // facts captured in this session (from memory.list)
};

// ---- rpc ------------------------------------------------------------------

let ws = null, nextId = 1;
const pending = new Map();

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${token}`);
  ws.onopen = async () => {
    setConn('linked', 'ok');
    await loadSkins();
    state.projects = await rpc('project.list');
    await refreshSessions();
    await loadModels();
    await loadPermMode();
    renderCounts();
    try {
      const { done } = await rpc('setup.status');
      if (!done) showSetup();
    } catch { /* older daemon */ }
  };
  ws.onclose = () => { setConn('relinking…', 'bad'); setTimeout(connect, 1500); };
  ws.onmessage = e => {
    const frame = JSON.parse(e.data);
    if (frame.event) return onEvent(frame.event, frame.params ?? {});
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    frame.error ? waiter.reject(new Error(frame.error.message)) : waiter.resolve(frame.result);
  };
}

function rpc(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function setConn(text, cls) { const c = $('conn'); c.textContent = text; c.className = cls; }

// ---- events ---------------------------------------------------------------

let liveBody = null;   // streaming agent prose target
let liveTools = null;  // current tool table body

const typingDots = () => {
  const d = document.createElement('span');
  d.className = 'dots'; d.innerHTML = '<i></i><i></i><i></i>';
  return d;
};

function onEvent(event, p) {
  if (event === 'chat.delta' || event === 'agent.delta') {
    // a brand-new chat learns its id from the first stamped event
    if (state.awaitingSession && state.sessionId == null && p.sessionId) {
      state.sessionId = p.sessionId;
      state.awaitingSession = false;
    }
    if (p.sessionId) {
      state.inflight.add(p.sessionId);
      state.streams.set(p.sessionId, (state.streams.get(p.sessionId) ?? '') + p.text);
    }
    if (p.sessionId !== state.sessionId) return; // background — buffered, safe
    // a tool table may have closed the previous prose turn mid-reply —
    // text after tools opens a fresh HEPH turn instead of vanishing
    if (!liveBody) startLive();
    liveBody.querySelector('.dots')?.remove();
    const tok = document.createElement('span');
    tok.className = 'tok'; tok.textContent = p.text;
    liveBody.appendChild(tok);
    $('view').scrollTop = $('view').scrollHeight;
  } else if (event === 'chat.done') {
    if (p.sessionId) {
      state.inflight.delete(p.sessionId);
      state.streams.delete(p.sessionId);
    }
    if (p.sessionId === state.sessionId) {
      const usage = p.usage ?? {};
      state.meter.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      state.meter.calls += 1;
      renderMeter();
      finalizeLive();
    }
    renderSendState();
    refreshSessions();
  } else if (event === 'agent.tool') {
    // a fresh dev chat's FIRST event is a tool event — adopt here too
    if (state.awaitingSession && state.sessionId == null && p.sessionId) {
      state.sessionId = p.sessionId;
      state.awaitingSession = false;
    }
    if (p.sessionId && p.sessionId !== state.sessionId) {
      state.inflight.add(p.sessionId);
      refreshSessions(); // background dev work — mark the row, don't render
      return;
    }
    state.meter.calls++;
    renderMeter();
    trackTouched(p);
    appendToolRow(p);
  } else if (event === 'approval.request') {
    $('approval-tool').textContent = `${p.tool} · ${p.risk}`;
    $('approval-summary').textContent = p.summary;
    openOverlay('approval-modal');
    $('overlay').dataset.approvalId = p.approvalId;
  } else if (event === 'skin.changed') {
    applySkin(p.skin);
  } else if (event === 'session.updated') {
    // another surface (Telegram, a job, another window) moved a session —
    // refresh what we're looking at, or just the rail
    if (state.view === 'chat' && state.sessionId === p.sessionId && !state.inflight.has(p.sessionId) && !state.awaitingSession) {
      openSession(p.sessionId);
    } else {
      refreshSessions();
    }
  } else if (event === 'delegate.done') {
    // a background sub-run finished — its result is a new message in the
    // parent session; refresh if we're looking at it
    if (state.view === 'chat' && state.sessionId === p.sessionId && !state.inflight.has(p.sessionId)) openSession(p.sessionId);
    else refreshSessions();
  }
}

function trackTouched(p) {
  let file = null;
  try {
    const args = JSON.parse(p.summary);
    file = args.path ?? null;
  } catch {
    // summaries come formatted too: "SUMMARY.txt (100c)" or a bare path
    const m = String(p.summary).match(/^(\S+?)(?:\s+\(\d+c?\))?$/);
    if (m && /[\w.]/.test(m[1])) file = m[1];
  }
  if (!file || typeof file !== 'string') return;
  if (p.name === 'fs_write') state.touched.set(file, 'written');
  else if (p.name === 'fs_read' && !state.touched.has(file)) state.touched.set(file, 'read');
  renderInspector();
}

// ---- skins → 2.0 token bridge ---------------------------------------------

const TOKEN_KEYS = ['--paper', '--paper-raised', '--paper-sunken', '--rail', '--rail-inspector',
  '--stone', '--stone-strong', '--stone-active', '--hairline', '--hairline-soft',
  '--hairline-rail', '--hairline-strong', '--window-border', '--separator',
  '--ink', '--ink-2', '--ink-3', '--ink-4', '--ink-5', '--ink-placeholder', '--ink-muted',
  '--oxblood', '--oxblood-hover', '--on-oxblood',
  '--seg-active', '--focus-border', '--send-disabled', '--scrim',
  '--diff-add-bg', '--diff-del-bg'];

function applySkin(skin) {
  const root = document.documentElement.style;
  if (skin.name === 'marble') { // marble IS the stylesheet — clear overrides
    for (const key of TOKEN_KEYS) root.removeProperty(key);
    return;
  }
  const p = skin.palette;
  const map = {
    '--paper': p.bg, '--paper-raised': p.surface, '--paper-sunken': p.bgAlt,
    '--rail': p.bgAlt, '--rail-inspector': p.bgAlt,
    '--stone': p.surface, '--stone-strong': p.border, '--stone-active': p.surface,
    '--hairline': p.border, '--hairline-soft': p.border, '--hairline-rail': p.border,
    '--hairline-strong': p.border, '--window-border': p.border, '--separator': p.fgMuted,
    '--ink': p.fg, '--ink-2': p.fg, '--ink-3': p.fg, '--ink-4': p.fgMuted,
    '--ink-5': p.fgMuted, '--ink-placeholder': p.fgMuted, '--ink-muted': p.fgMuted,
    '--oxblood': p.accent, '--oxblood-hover': p.accentAlt,
    '--on-oxblood': skin.resolved?.fgOnAccent ?? '#F7F5F0',
    // Derived states re-derive from the skin, never from marble's hexes —
    // a light chip under light ink was the bug this section exists for.
    '--seg-active': p.border, '--focus-border': p.fgMuted,
    '--send-disabled': p.border, '--scrim': 'rgba(0, 0, 0, .45)',
    '--diff-add-bg': 'rgba(130, 175, 95, .18)', '--diff-del-bg': 'rgba(205, 95, 75, .16)',
  };
  for (const [k, v] of Object.entries(map)) root.setProperty(k, v);
}

async function loadSkins() {
  state.skins = await rpc('skins.list');
  const select = $('skin-select');
  select.innerHTML = state.skins.map(s => `<option value="${esc(s.name)}">${esc(s.label)} · ${s.polarity}</option>`).join('');
  // grimdark-first: the Forge is the default face; marble is the light option
  const saved = localStorage.getItem('heph-skin') ?? 'forge';
  select.value = state.skins.some(s => s.name === saved) ? saved : 'forge';
  applySkin(await rpc('skins.get', { name: select.value }));
  select.onchange = async () => {
    localStorage.setItem('heph-skin', select.value);
    applySkin(await rpc('skins.get', { name: select.value }));
  };
}

// ---- models ---------------------------------------------------------------

const shortModel = spec => (spec?.split('/').slice(1).join('/') ?? '—').slice(0, 22);

async function loadModels() {
  try {
    const { models, bindings } = await rpc('models.list');
    state.models = models; state.bindings = bindings;
    $('model-name').textContent = shortModel(bindings.chat);
  } catch { $('model-name').textContent = '—'; }
}

function toggleModelPopup() {
  const popup = $('model-popup');
  if (!popup.classList.contains('hidden')) return popup.classList.add('hidden');
  $('at-popup').classList.add('hidden');
  popup.className = 'popup';
  popup.innerHTML = '<div class="pop-note">CHAT MODEL — NEW EXCHANGES</div>' +
    state.models.map(m => `
      <button class="pop-item${m.spec === state.bindings.chat ? ' current' : ''}" data-spec="${esc(m.spec)}">
        <span class="pop-kind">${esc(m.provider)}</span><span class="pop-label">${esc(m.model)}</span>
      </button>`).join('');
  popup.querySelectorAll('.pop-item').forEach(item =>
    item.addEventListener('click', async () => {
      popup.classList.add('hidden');
      await rpc('config.set', { models: { chat: item.dataset.spec } });
      await loadModels();
    }));
}

// ---- rail: switcher + tree ------------------------------------------------

const folded = name => localStorage.getItem('heph-fold:' + name) === '1';

function armDelete(btn, commit) {
  if (btn.classList.contains('arm')) return commit();
  btn.classList.add('arm'); btn.textContent = 'sure?';
  setTimeout(() => { btn.classList.remove('arm'); btn.textContent = '×'; }, 2500);
}

function renderSwitcher() {
  $('switcher-name').textContent = state.projectFilter ?? 'all';
}

function toggleSwitcherMenu() {
  const menu = $('switcher-menu');
  if (!menu.classList.contains('hidden')) return menu.classList.add('hidden');
  menu.innerHTML = [`<button data-p="">all<span class="kbd">${state.sessions.length}</span></button>`]
    .concat(state.projects.map(pr => {
      const n = state.sessions.filter(s => s.project === pr.name).length;
      return `<button data-p="${esc(pr.name)}">${esc(pr.name)}<span class="kbd">${n}</span></button>`;
    }))
    .concat(['<button data-new="1" style="color:var(--oxblood)">+ new project</button>'])
    .join('');
  menu.classList.remove('hidden');
  menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    menu.classList.add('hidden');
    if (b.dataset.new) return openProjectModal();
    state.projectFilter = b.dataset.p || null;
    renderSwitcher();
    if (state.projectFilter) openProject(state.projectFilter);
    else refreshSessions();
  }));
}

// ---- new-project modal ----------------------------------------------------

let browsePath = null;

async function browseTo(path) {
  const { path: current, parent, dirs } = await rpc('fs.browse', path ? { path } : {});
  browsePath = current;
  $('pm-path').textContent = current;
  const list = $('pm-dirs');
  list.innerHTML = '';
  if (parent) {
    const up = document.createElement('button');
    up.className = 'up'; up.textContent = '‹ up';
    up.onclick = () => browseTo(parent);
    list.appendChild(up);
  }
  for (const dir of dirs) {
    const btn = document.createElement('button');
    btn.textContent = dir + '/';
    btn.onclick = () => browseTo(`${current}/${dir}`);
    list.appendChild(btn);
  }
  // name suggestion from the folder, if the field is untouched
  const nameEl = $('pm-name');
  if (!nameEl.dataset.touched) {
    nameEl.value = current.split('/').pop().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  }
}

function openProjectModal() {
  $('pm-name').value = '';
  delete $('pm-name').dataset.touched;
  openOverlay('project-modal');
  browseTo(null);
}

$('pm-name').addEventListener('input', e => { e.target.dataset.touched = '1'; });
$('pm-mkdir').onclick = async () => {
  const name = $('pm-newdir').value.trim();
  if (!name || !browsePath) return;
  const { path } = await rpc('fs.mkdir', { path: `${browsePath}/${name}` });
  $('pm-newdir').value = '';
  await browseTo(path);
};
$('pm-cancel').onclick = closeOverlay;
$('pm-create').onclick = async () => {
  const name = $('pm-name').value.trim();
  if (!name || !browsePath) return;
  try {
    await rpc('project.add', { name, root: browsePath });
    state.projects = await rpc('project.list');
    closeOverlay();
    state.projectFilter = name;
    renderSwitcher();
    openProject(name);
  } catch (err) {
    $('pm-path').textContent = err.message;
  }
};

async function refreshSessions() {
  state.sessions = await rpc('session.list');
  renderSwitcher();
  const nav = $('rail-nav');
  nav.innerHTML = '';

  const sessionRow = (s, child) => {
    const row = document.createElement('div');
    row.className = 'tree__row' + (child ? ' tree__row--child' : '');
    if (s.id === state.sessionId && state.view === 'chat') row.setAttribute('aria-current', 'true');
    row.title = 'shift-click to pin';
    const working = state.inflight.has(s.id) ? '<span class="working">working</span> · ' : '';
    const pin = s.pinned ? '<span class="pin-mark">⌗</span> ' : '';
    row.innerHTML = `
      <div class="tree__main">
        <div class="tree__title">${pin}${esc(s.title ?? 'untitled')}</div>
        <div class="tree__meta">${working}${esc(s.automaton)} · ${esc(s.created_at.slice(5, 10))}</div>
      </div>
      <button class="del" title="archive">×</button>`;
    row.querySelector('.tree__main').onclick = async ev => {
      if (ev.shiftKey) { await rpc('session.pin', { id: s.id }); refreshSessions(); return; }
      openSession(s.id);
    };
    row.querySelector('.del').onclick = ev => {
      ev.stopPropagation();
      armDelete(ev.target, async () => {
        await rpc('session.archive', { id: s.id });
        if (state.sessionId === s.id) newChat(); else refreshSessions();
      });
    };
    return row;
  };

  // PINNED floats above everything — project membership doesn't matter,
  // the pin is the user saying "keep this at hand" (the Hermes gesture).
  const pinned = state.sessions.filter(s => s.pinned);
  if (pinned.length) {
    const label = document.createElement('div');
    label.className = 'nav-section'; label.textContent = 'PINNED';
    nav.appendChild(label);
    for (const s of pinned) nav.appendChild(sessionRow(s, false));
  }

  const visibleProjects = state.projectFilter
    ? state.projects.filter(pr => pr.name === state.projectFilter)
    : state.projects;

  if (visibleProjects.length) {
    const label = document.createElement('div');
    label.className = 'nav-section'; label.textContent = 'PROJECTS';
    nav.appendChild(label);
    for (const pr of visibleProjects) {
      const sessions = state.sessions.filter(s => s.project === pr.name && !s.pinned);
      const isFolded = folded(pr.name);
      const row = document.createElement('div');
      row.className = 'tree__row';
      if (state.view === 'project' && state.spaceName === pr.name) row.setAttribute('aria-current', 'true');
      row.innerHTML = `
        <span class="tree__chev">${isFolded ? '▸' : '▾'}</span>
        <div class="tree__main"><div class="tree__title">${esc(pr.name)}</div></div>
        <span class="tree__count">${sessions.length}</span>
        <button class="del" title="archive project">×</button>`;
      row.querySelector('.tree__chev').onclick = ev => {
        ev.stopPropagation();
        localStorage.setItem('heph-fold:' + pr.name, isFolded ? '0' : '1');
        refreshSessions();
      };
      row.querySelector('.tree__main').onclick = () => openProject(pr.name);
      row.querySelector('.del').onclick = ev => {
        ev.stopPropagation();
        armDelete(ev.target, async () => {
          await rpc('project.archive', { name: pr.name });
          state.projects = await rpc('project.list');
          if (state.spaceName === pr.name) newChat(); else refreshSessions();
        });
      };
      nav.appendChild(row);
      if (!isFolded) for (const s of sessions.slice(0, 6)) nav.appendChild(sessionRow(s, true));
    }
  }

  const loose = state.sessions.filter(s => !s.project && !s.pinned && !state.projectFilter);
  if (loose.length) {
    const label = document.createElement('div');
    label.className = 'nav-section';
    label.innerHTML = `CHATS <span class="nav-section__count">${loose.length}</span>`;
    nav.appendChild(label);
    for (const s of loose.slice(0, 14)) nav.appendChild(sessionRow(s, false));
  }
}

async function renderCounts() {
  try {
    const artifacts = await rpc('artifacts.list');
    $('count-artifacts').textContent = artifacts.length || '';
    const { facts } = await rpc('memory.list');
    $('count-memory').textContent = facts.length || '';
  } catch { /* cosmetic */ }
}

// ---- toolbar --------------------------------------------------------------

function setCrumb(crumb, title) {
  $('crumb').textContent = crumb;
  $('crumb-sep').classList.toggle('hidden', !title);
  $('crumb-title').textContent = title ?? '';
}

function renderMeter() {
  $('meta-usage').textContent = `${state.meter.calls} calls · ${state.meter.tokens >= 1000 ? (state.meter.tokens / 1000).toFixed(1) + 'k' : state.meter.tokens} tok`;
  $('meta-mode').textContent = state.plan ? 'plan' : 'chat';
}

// ---- views ----------------------------------------------------------------

function resetThread() {
  state.meter = { calls: 0, tokens: 0 };
  state.touched = new Map();
  state.learned = [];
  renderMeter();
}

function newChat() {
  state.view = 'new'; state.sessionId = null; state.spaceName = null;
  liveBody = null; liveTools = null;
  state.scopeProject = state.projectFilter; state.refs = [];
  clearAttachments(); resetThread();
  setCrumb('new chat', null);
  $('view').innerHTML = `
    <div class="hero">
      <div class="hero__label">NEW CHAT</div>
      <div class="hero__h">What are we working on?</div>
      <div class="hero__sub">State the task. Scope it with <span class="mono">@</span> — a project, or a past chat for context.</div>
    </div>
    <div class="column recent">
      <div class="recent__label">PICK UP WHERE YOU LEFT OFF</div>
      <div id="recent-rows"></div>
    </div>`;
  const rows = $('recent-rows');
  for (const s of state.sessions.slice(0, 3)) {
    const row = document.createElement('button');
    row.className = 'list__row';
    row.innerHTML = `<span class="list__title">${esc(s.title ?? 'untitled')}</span><span class="list__meta">${esc(s.automaton)} · ${esc(s.created_at.slice(5, 10))}</span>`;
    row.onclick = () => openSession(s.id);
    rows.appendChild(row);
  }
  renderScopeStrip(); renderInspector(); refreshSessions();
}

async function openSession(id) {
  state.view = 'chat'; state.sessionId = id;
  liveBody = null; liveTools = null;
  const session = state.sessions.find(s => s.id === id);
  state.scopeProject = session?.project ?? null;
  resetThread(); renderScopeStrip();
  setCrumb(session?.project ?? 'chat', session?.title ?? `session ${id}`);
  const messages = await rpc('session.messages', { sessionId: id });
  const view = $('view');
  view.innerHTML = '<div class="column" id="thread"></div>';
  for (const m of messages) appendTurn(m.role, m.content);
  // mid-run? pick the stream back up: replay what we buffered while away,
  // and the next deltas continue right here
  if (state.inflight.has(id)) {
    liveTools = null;
    startLive();
    const buffered = state.streams.get(id);
    if (buffered) {
      liveBody.querySelector('.dots')?.remove();
      const span = document.createElement('span');
      span.textContent = buffered;
      liveBody.appendChild(span);
    }
  }
  view.scrollTop = view.scrollHeight;
  await loadLearned();
  renderInspector(); refreshSessions(); renderSendState();
}

async function openProject(name) {
  state.view = 'project'; state.spaceName = name; state.sessionId = null;
  state.scopeProject = name;
  resetThread(); renderScopeStrip();
  const pr = state.projects.find(x => x.name === name);
  const sessions = state.sessions.filter(s => s.project === name);
  const { facts } = await rpc('memory.list');
  const scoped = facts.filter(f => f.scope === `project:${name}`);
  const artifacts = (await rpc('artifacts.list')).filter(a => a.root === pr?.root);
  setCrumb(name, null);
  $('view').innerHTML = `
    <div class="column">
      <div class="proj__name">${esc(name)}</div>
      <div class="proj__path">${esc(pr?.root ?? '')}</div>
      <div class="statgrid">
        <div><div class="stat__label">CHATS</div><div class="stat__value">${sessions.length}</div></div>
        <div><div class="stat__label">MEMORIES</div><div class="stat__value">${scoped.length}</div></div>
        <div><div class="stat__label">ARTIFACTS</div><div class="stat__value">${artifacts.length}</div></div>
        <div><div class="stat__label">TOKENS</div><div class="stat__value">—</div></div>
      </div>
      <div class="section-head">
        <span class="section-head__label">CHATS</span>
        <button class="section-head__act" id="proj-new">New chat in ${esc(name)}</button>
      </div>
      <div id="proj-chats"></div>
      <div class="section-head"><span class="section-head__label">SCOPED MEMORY</span></div>
      <div id="proj-memos"></div>
    </div>`;
  const chatRows = $('proj-chats');
  for (const s of sessions) {
    const row = document.createElement('button');
    row.className = 'list__row';
    row.innerHTML = `<span class="list__title">${esc(s.title ?? 'untitled')}</span><span class="list__meta">${esc(s.automaton)} · ${esc(s.created_at.slice(0, 16).replace('T', ' '))}</span>`;
    row.onclick = () => openSession(s.id);
    chatRows.appendChild(row);
  }
  const memoRows = $('proj-memos');
  memoRows.innerHTML = scoped.slice(0, 8).map(f => `
    <div class="memo">
      <div class="memo__text">${esc(f.content)}</div>
      <div class="memo__prov">${esc(f.category)} · importance ${f.importance} · ${esc((f.created_at ?? '').slice(0, 10))}</div>
    </div>`).join('') || '<div class="empty">nothing scoped here yet</div>';
  $('proj-new').onclick = () => { newChat(); state.scopeProject = name; renderScopeStrip(); $('input').focus(); };
  renderInspector({ pr, scoped, artifacts, sessions });
  refreshSessions();
}

// ---- transcript turns -----------------------------------------------------

function turnEl(gutter, oxblood) {
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.innerHTML = `<div class="turn__gutter${oxblood ? ' turn__gutter--heph' : ''}">${gutter}</div><div class="turn__body"></div>`;
  ($('thread') ?? $('view')).appendChild(turn);
  return turn.querySelector('.turn__body');
}

function appendTurn(role, content) {
  if (role === 'tool') {
    const m = content.match(/^\[([\w-]+)\] (\{.*?\}|\S*) → ([\s\S]*)$/);
    ensureToolTable().appendChild(toolRowEl({
      name: m?.[1] ?? 'tool', summary: m?.[2] ?? '', ok: true, ms: null, result: m?.[3] ?? content,
    }));
    return null;
  }
  liveTools = null;
  const body = turnEl(role === 'user' ? 'YOU' : 'HEPH', role !== 'user');
  if (role === 'assistant') {
    body.classList.add('md');
    body.innerHTML = md(content);
  } else {
    body.textContent = content;
  }
  return body;
}

function ensureToolTable() {
  if (liveTools) return liveTools;
  const body = turnEl('WORK', false);
  body.classList.remove('turn__body'); body.classList.add('turn__body');
  body.style.whiteSpace = 'normal';
  body.innerHTML = `
    <div class="toolhead"><span class="toolhead__label">TOOL CALLS</span><span class="toolhead__meta" id="toolmeta"></span></div>
    <div class="tool"></div>`;
  liveTools = body.querySelector('.tool');
  return liveTools;
}

function toolRowEl(p) {
  const row = document.createElement('div');
  row.className = 'tool__row';
  let arg = p.summary;
  try { const j = JSON.parse(p.summary); arg = j.path ?? j.command ?? j.query ?? j.url ?? j.text ?? p.summary; } catch { /* raw */ }
  const firstLine = String(p.result ?? '').split('\n')[0].slice(0, 60);
  row.innerHTML = `
    <div class="tool__line">
      <span class="tool__op${p.ok === false ? ' tool__op--failed' : ''}">${esc(opVerb(p.name))}</span>
      <span class="tool__arg">${esc(String(arg))}</span>
      <span class="tool__result">${esc(firstLine)}${p.ms != null ? ` · ${p.ms}ms` : ''}</span>
    </div>
    <pre class="tool__out"></pre>`;
  row.querySelector('.tool__out').textContent = String(p.result ?? '');
  // a write carries its preview — a diff when overwriting, the content
  // itself when the file is new; either way the row arrives open
  if (p.detail) {
    if (p.detail.startsWith('@@diff\n')) {
      const diff = document.createElement('div');
      diff.className = 'tool__diff';
      for (const line of p.detail.slice(7).split('\n')) {
        const span = document.createElement('span');
        if (line.startsWith('+ ')) { span.className = 'dl-add'; span.textContent = line.slice(2); }
        else if (line.startsWith('- ')) { span.className = 'dl-del'; span.textContent = line.slice(2); }
        else if (line.includes('···')) { span.className = 'dl-gap'; span.textContent = line.trim(); }
        else { span.textContent = line.slice(2); }
        diff.appendChild(span);
      }
      row.appendChild(diff);
    } else {
      const code = document.createElement('pre');
      code.className = 'tool__code';
      code.textContent = p.detail;
      row.appendChild(code);
    }
    row.classList.add('open');
  }
  row.onclick = () => row.classList.toggle('open');
  return row;
}

function appendToolRow(p) {
  ensureToolTable().appendChild(toolRowEl(p));
  const meta = document.getElementById('toolmeta');
  if (meta) meta.textContent = `${state.meter.calls} calls`;
  liveBody = null; // next prose is a fresh HEPH turn
  $('view').scrollTop = $('view').scrollHeight;
}

function startLive() {
  liveBody = turnEl('HEPH', true);
  liveBody.appendChild(typingDots());
}

// ---- composer -------------------------------------------------------------

function renderScopeStrip() {
  const strip = $('scope-strip');
  strip.innerHTML = '';
  const chip = (label, title, onRemove, thumb) => {
    const el = document.createElement('button');
    el.className = 'chip'; el.title = title;
    if (thumb) { const t = document.createElement('span'); t.className = 'thumb'; t.style.backgroundImage = `url(${thumb})`; el.appendChild(t); }
    el.appendChild(document.createTextNode(label));
    el.onclick = onRemove;
    strip.appendChild(el);
  };
  if (state.scopeProject) chip(`@${state.scopeProject}`, 'project scope — click to clear', () => { state.scopeProject = null; renderScopeStrip(); renderInspector(); });
  for (const r of state.refs) chip(`@chat ${r.id}`, r.title ?? '', () => { state.refs = state.refs.filter(x => x.id !== r.id); renderScopeStrip(); });
  for (const a of state.attachments) chip(a.name, 'attached image', () => { state.attachments = state.attachments.filter(x => x !== a); renderScopeStrip(); }, a.thumb);
  for (const f of state.fileTexts) chip(f.name, 'attached file', () => { state.fileTexts = state.fileTexts.filter(x => x !== f); renderScopeStrip(); });
  const any = strip.children.length > 0;
  strip.classList.toggle('hidden', !any);
  $('input').style.minHeight = any ? '46px' : '52px';
  renderSendState();
}

function clearAttachments() { state.attachments = []; state.fileTexts = []; renderScopeStrip(); }

function renderSendState() {
  const threadBusy = state.sessionId ? state.inflight.has(state.sessionId) : state.awaitingSession;
  $('send').disabled = threadBusy ||
    (!$('input').value.trim() && !state.attachments.length && !state.fileTexts.length);
}

/** Close out the live turn: dots off, markdown on. Safe to call twice. */
function finalizeLive() {
  if (!liveBody) return;
  liveBody.querySelector('.dots')?.remove();
  if (liveBody.textContent.trim() && !liveBody.classList.contains('md')) {
    const raw = liveBody.textContent;
    liveBody.classList.add('md');
    liveBody.innerHTML = md(raw);
  }
  liveBody = null; liveTools = null;
}

function setPlan(on) {
  state.plan = on;
  $('plan-toggle').setAttribute('aria-pressed', String(on));
  renderMeter();
}

async function send() {
  const input = $('input');
  let text = input.value.trim();
  if (!text && !state.attachments.length && !state.fileTexts.length) return;
  const target = state.sessionId; // null → a new session is being born
  if (target ? state.inflight.has(target) : state.awaitingSession) return; // that thread is mid-run
  if (state.view !== 'chat') {
    $('view').innerHTML = '<div class="column" id="thread"></div>';
    state.view = 'chat';
  }
  for (const f of state.fileTexts) text += `\n\n[file: ${f.name}]\n\`\`\`\n${f.text}\n\`\`\``;
  if (!text) text = '(attached)';

  if (target) state.inflight.add(target); else state.awaitingSession = true;
  renderSendState();
  input.value = ''; input.style.height = 'auto';
  const attachments = state.attachments.map(a => ({ name: a.name, mime: a.mime, data: a.data }));
  const label = attachments.length ? `[attached: ${attachments.map(a => a.name).join(', ')}]\n` : '';
  const refs = state.refs.map(r => r.id);
  state.refs = []; clearAttachments();
  appendTurn('user', label + text);
  liveTools = null;
  startLive();
  $('view').scrollTop = $('view').scrollHeight;

  let resultSession = target;
  try {
    // ONE lane now — chat carries every hand; plan sheathes the changers.
    const result = await rpc('chat.send', {
      text,
      ...(state.plan ? { plan: true } : {}),
      ...(target ? { sessionId: target } : {}),
      ...(state.scopeProject && !target ? { project: state.scopeProject } : {}),
      ...(refs.length ? { refSessions: refs } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    resultSession = result.sessionId;
    if (state.sessionId === null) state.sessionId = result.sessionId;
    // chat.done already finalized the view if we were watching
  } catch (err) {
    if (state.sessionId === resultSession && liveBody) {
      liveBody.querySelector('.dots')?.remove();
      liveBody.textContent += `[${err.message}]`;
    }
  } finally {
    state.awaitingSession = false;
    if (resultSession) { state.inflight.delete(resultSession); state.streams.delete(resultSession); }
    if (target) state.inflight.delete(target);
    if (state.sessionId === resultSession) finalizeLive();
    renderMeter(); renderSendState();
    if (state.view === 'chat') { await loadLearned(); renderInspector(); }
    refreshSessions(); renderCounts();
  }
}

// ---- @ popup --------------------------------------------------------------

let atSelected = 0;

function atCandidates(prefix) {
  const q = prefix.toLowerCase();
  const projects = state.projects.filter(p => p.name.toLowerCase().startsWith(q))
    .map(p => ({ kind: 'project', label: p.name, apply: () => { state.scopeProject = p.name; } }));
  const sessions = state.sessions.filter(s => (s.title ?? '').toLowerCase().includes(q)).slice(0, 6)
    .map(s => ({
      kind: 'chat', label: `${s.title ?? 'session ' + s.id} · ${s.id}`,
      apply: () => {
        if (state.refs.length < 2 && !state.refs.some(r => r.id === s.id)) state.refs.push({ id: s.id, title: s.title });
      },
    }));
  return [...projects, ...sessions].slice(0, 8);
}

function updateAtPopup() {
  const input = $('input');
  const upToCaret = input.value.slice(0, input.selectionStart);
  const match = upToCaret.match(/@([\w-]*)$/);
  const popup = $('at-popup');
  if (!match) return popup.classList.add('hidden');
  const candidates = atCandidates(match[1]);
  if (!candidates.length) return popup.classList.add('hidden');
  $('model-popup').classList.add('hidden');
  atSelected = Math.min(atSelected, candidates.length - 1);
  popup.className = 'popup';
  popup.innerHTML = candidates.map((c, i) => `
    <button class="pop-item${i === atSelected ? ' selected' : ''}" data-i="${i}">
      <span class="pop-kind">${c.kind}</span><span class="pop-label">${esc(c.label)}</span>
    </button>`).join('');
  popup.querySelectorAll('.pop-item').forEach(el =>
    el.addEventListener('mousedown', ev => { ev.preventDefault(); chooseAt(candidates[Number(el.dataset.i)]); }));
  popup._candidates = candidates;
  popup.dataset.count = String(candidates.length);
}

function chooseAt(candidate) {
  const input = $('input');
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret).replace(/@[\w-]*$/, '');
  input.value = before + input.value.slice(caret);
  input.selectionStart = input.selectionEnd = before.length;
  candidate.apply();
  renderScopeStrip(); renderInspector();
  $('at-popup').classList.add('hidden');
  input.focus();
}

// ---- inspector ------------------------------------------------------------

async function loadLearned() {
  if (!state.sessionId) { state.learned = []; return; }
  try {
    const { facts } = await rpc('memory.list');
    state.learned = facts.filter(f => f.sourceSession === state.sessionId || f.source_session === state.sessionId);
  } catch { state.learned = []; }
}

function renderInspector(projectData) {
  const head = $('inspector-head');
  const body = $('inspector-body');
  const kv = (k, v, cls = '') => `<div class="kv${cls}"><span>${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`;

  if (state.view === 'project' && projectData) {
    head.textContent = 'THIS PROJECT';
    const { pr, scoped, artifacts } = projectData;
    body.innerHTML = `
      <div class="insp"><div class="insp__label">LOCATION</div>
        <div class="insp__text" style="font-family:var(--font-mono);font-size:11px">${esc(pr?.root ?? '')}</div></div>
      <div class="insp"><div class="insp__label">SCOPED MEMORY · ${scoped.length}</div>
        ${scoped.slice(0, 3).map(f => `<div class="insp__text">${esc(f.content.slice(0, 140))}</div>`).join('') || '<div class="insp__note">nothing yet</div>'}</div>
      <div class="insp"><div class="insp__label">ARTIFACTS · ${artifacts.length}</div>
        ${artifacts.slice(0, 5).map(a => `<div class="kv"><span>${esc(a.rel)}</span><span class="v">${a.bytes}b</span></div>`).join('') || '<div class="insp__note">nothing forged yet</div>'}</div>`;
    return;
  }

  head.textContent = state.view === 'chat' ? 'THIS CHAT' : 'NEW CHAT';
  const touched = [...state.touched.entries()];
  body.innerHTML = `
    <div class="insp"><div class="insp__label">SCOPE</div>
      <div class="insp__chips">${state.scopeProject ? `<span class="chip">@${esc(state.scopeProject)}</span>` : '<span class="insp__note">no scope — global memory only</span>'}
      ${state.refs.map(r => `<span class="chip">@chat ${r.id}</span>`).join('')}</div></div>
    <div class="insp"><div class="insp__label">TOUCHED</div>
      ${touched.map(([f, how]) => `<div class="kv"><span>${esc(f.length > 26 ? '…' + f.slice(-25) : f)}</span><span class="v${how === 'written' ? ' v--ox' : ''}">${how}</span></div>`).join('') || '<div class="insp__note">nothing touched this thread</div>'}</div>
    <div class="insp"><div class="insp__label">COST</div>
      ${kv('calls', state.meter.calls)}
      ${kv('tokens', state.meter.tokens)}
      ${kv('thread', `${state.meter.tokens} tok`, ' kv--total')}</div>
    <div class="insp"><div class="insp__label">LEARNED HERE</div>
      ${state.learned.slice(0, 4).map(f => `<div class="insp__text">${esc(f.content.slice(0, 120))}</div>`).join('') || '<div class="insp__note">nothing captured yet</div>'}</div>`;
}

// ---- library views --------------------------------------------------------

async function showMemory() {
  state.view = 'memory'; setCrumb('memory', null);
  const { budget, coreUsed, facts } = await rpc('memory.list');
  const core = facts.filter(f => f.core);
  const deep = facts.filter(f => !f.core);
  const pct = Math.min(100, Math.round((coreUsed / budget) * 100));
  const row = f => `
    <div class="memo"><div class="memo__text">${esc(f.content)}</div>
    <div class="memo__prov">${esc(f.scope === 'global' ? 'global' : f.scope.slice(8))} · ${esc(f.category)} · i${f.importance}</div></div>`;
  $('view').innerHTML = `
    <div class="column">
      <div class="section-head"><span class="section-head__label">CORE — ${pct}% OF ${budget} CHARS</span></div>
      <div class="budget"><div class="budget__fill" style="width:${pct}%"></div></div>
      ${core.map(row).join('') || '<div class="empty">core is empty — capture promotes what earns it</div>'}
      <div class="section-head"><span class="section-head__label">DEEP — ${deep.length} FACTS</span></div>
      ${deep.map(row).join('')}
    </div>`;
  renderInspector();
}

async function showReceipts() {
  state.view = 'receipts'; setCrumb('receipts', null);
  const receipts = await rpc('receipts.list', { limit: 120 });
  $('view').innerHTML = `<div class="column">${receipts.map(r => `
    <div class="receipt-row"><span class="t">${r.id} ${esc(r.created_at.slice(5, 19))}</span> <span class="k">${esc(r.kind)}</span> <span class="t">${esc(r.detail)}</span></div>`).join('')}</div>`;
}

async function showArtifacts() {
  state.view = 'artifacts'; setCrumb('artifacts', null);
  const artifacts = await rpc('artifacts.list');
  const view = $('view');
  if (!artifacts.length) { view.innerHTML = '<div class="empty">Nothing yet — dev runs land their files here.</div>'; return; }
  view.innerHTML = '<div class="column" id="artifact-rows"></div>';
  const rows = $('artifact-rows');
  for (const a of artifacts) {
    const row = document.createElement('button');
    row.className = 'list__row';
    row.innerHTML = `<span class="list__title" style="font-family:var(--font-mono);font-size:12.5px">${esc(a.rel)}</span>
      <span class="list__meta">${esc(a.root.split('/').pop() ?? '')} · ${a.bytes}b · ${esc(a.at.slice(5, 16))}</span>`;
    row.onclick = async () => {
      try {
        const { content } = await rpc('artifacts.read', { path: a.path });
        view.innerHTML = `<div class="column preview">
          <div class="preview__head"><span class="preview__back">‹ Artifacts</span><span class="preview__path">${esc(a.path)}</span></div>
          <pre></pre></div>`;
        view.querySelector('pre').textContent = content;
        view.querySelector('.preview__back').onclick = showArtifacts;
      } catch (err) { view.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
    };
    rows.appendChild(row);
  }
}

// ---- connectors & setup ---------------------------------------------------

async function saveSecret(name, input, noteEl, rerender) {
  const value = input.value.trim();
  if (!value) return;
  try {
    const result = await rpc('secrets.set', { name, value });
    input.value = '';
    noteEl.textContent = result.note ?? 'saved';
    setTimeout(rerender, 1200);
  } catch (err) { noteEl.textContent = err.message; }
}

/** One renderer for the Connectors tab and the setup page's wiring section. */
async function buildConnectors(container, rerender) {
  const cfg = await rpc('config.get');
  let mcp = { servers: [], web: false };
  try { mcp = await rpc('mcp.status'); } catch { /* older daemon */ }
  let modelCount = 0;
  try { modelCount = (await rpc('models.list')).models.filter(m => m.provider === 'ollama').length; } catch { /* dark */ }

  const block = (name, status, ok, hintHtml, fieldHtml = '') => `
    <div class="connector">
      <div class="connector__head">
        <span class="connector__name">${name}</span>
        <span class="connector__status ${ok ? 'ok' : 'dark'}">${status}</span>
      </div>
      <div class="connector__hint">${hintHtml}</div>
      ${fieldHtml}
      <div class="keyfield__note"></div>
    </div>`;

  const keyfield = (secret, placeholder) => `
    <div class="keyfield" data-secret="${secret}">
      <input type="password" placeholder="${placeholder}" autocomplete="off">
      <button>Save</button>
    </div>`;

  container.innerHTML =
    block('Ollama engine', modelCount ? `linked · ${modelCount} models` : 'unreachable', modelCount > 0,
      `Local and cloud models via <code>${esc(cfg.connections.ollamaUrl)}</code>. The chat, agent, utility, and embedding lanes all bind here by default.`) +
    block('Web search', cfg.connections.webKey ? 'keyed' : 'dark', !!cfg.connections.webKey,
      'Gives both automata <code>web_search</code> and <code>web_fetch</code>. Mint a key at ollama.com → Settings → API Keys.',
      cfg.connections.webKey ? '' : keyfield('OLLAMA_API_KEY', 'paste your ollama.com API key')) +
    block('Anthropic', cfg.connections.anthropicKey ? 'keyed' : 'not set', !!cfg.connections.anthropicKey,
      'Optional second provider — frontier models for any lane, picked in Settings.',
      cfg.connections.anthropicKey ? '' : keyfield('ANTHROPIC_API_KEY', 'paste an Anthropic API key (optional)')) +
    block('Telegram', cfg.connections.telegramToken ? (cfg.connections.telegramOwner ? `linked · owner ${esc(String(cfg.connections.telegramOwner))}` : 'token set — owner missing') : 'not configured',
      !!(cfg.connections.telegramToken && cfg.connections.telegramOwner),
      'Your workspace in your pocket. Make a bot with @BotFather, paste its token, then your numeric Telegram user id — it answers you and no one else.',
      (cfg.connections.telegramToken ? '' : keyfield('TELEGRAM_BOT_TOKEN', 'paste the bot token from @BotFather')) +
      `<div class="keyfield" data-owner="1" style="margin-top:6px">
        <input type="text" placeholder="your numeric telegram user id" value="${esc(String(cfg.connections.telegramOwner ?? ''))}" autocomplete="off">
        <button>Save</button>
      </div>`) +
    block('MCP servers', mcp.servers.length ? `${mcp.servers.length} connected` : 'none', mcp.servers.length > 0,
      mcp.servers.length
        ? mcp.servers.map(s => `<code>${esc(s.server)}</code> — ${s.tools} tools`).join(' · ')
        : 'External tool servers. Add one under <code>[mcp.servers.&lt;name&gt;]</code> in <code>~/.hephaestus/config.toml</code> (command + args), then restart. Every call still passes the permission broker.');

  container.querySelectorAll('.keyfield[data-secret]').forEach(field => {
    const noteEl = field.parentElement.querySelector('.keyfield__note');
    field.querySelector('button').onclick = () =>
      saveSecret(field.dataset.secret, field.querySelector('input'), noteEl, rerender);
  });
  const ownerField = container.querySelector('.keyfield[data-owner]');
  if (ownerField) {
    ownerField.querySelector('button').onclick = async () => {
      await rpc('config.set', { channels: { telegramOwner: ownerField.querySelector('input').value } });
      ownerField.parentElement.querySelector('.keyfield__note').textContent = 'owner saved';
      setTimeout(rerender, 1000);
    };
  }
}

async function showConnectors() {
  state.view = 'connectors'; setCrumb('connectors', null);
  $('view').innerHTML = `<div class="column">
    <div class="section-head"><span class="section-head__label">CONNECTORS — WHAT THE WORKSHOP IS WIRED TO</span></div>
    <div id="connector-list"></div></div>`;
  await buildConnectors($('connector-list'), showConnectors);
}

async function showSetup() {
  state.view = 'setup'; setCrumb('setup', null);
  const cfg = await rpc('config.get');
  $('view').innerHTML = `<div class="column" style="padding-top:14px">
    <div class="hero__label">SETUP</div>
    <div class="hero__h" style="font-size:22px">Set up the workshop.</div>
    <div class="hero__sub" style="margin-bottom:26px">Name yourself, shape the voice, wire the connections. Everything here can be changed later in Settings and Connectors.</div>
    <div class="section-head"><span class="section-head__label">IDENTITY</span></div>
    <div class="set-row"><label>Your name</label><input id="su-name" value="${esc(cfg.user.name)}"></div>
    <div class="set-row"><label>Voice</label>
      <select id="su-tone">
        ${['plain', 'warm', 'dry'].map(t => `<option value="${t}"${cfg.voice.tone === t ? ' selected' : ''}>${t}</option>`).join('')}
      </select></div>
    <div class="set-row" style="align-items:flex-start"><label style="padding-top:8px">Voice notes</label>
      <textarea id="su-notes" class="voice-notes" placeholder="How should conversation sound? Colors chat only — code, files, and reports always stay neutral.">${esc(cfg.voice.notes)}</textarea></div>
    <div class="section-head"><span class="section-head__label">CONNECTIONS</span></div>
    <div id="setup-connectors"></div>
    <div class="setup-actions"><button class="send" id="setup-done">Enter the workshop</button></div>
  </div>`;
  await buildConnectors($('setup-connectors'), showSetup);
  $('setup-done').onclick = async () => {
    await rpc('config.set', {
      user: { name: $('su-name').value },
      voice: { tone: $('su-tone').value, notes: $('su-notes').value },
    });
    await rpc('setup.complete');
    newChat();
  };
}

// ---- attachments ----------------------------------------------------------

function handleFiles(files) {
  for (const file of files) {
    if (/^image\//.test(file.type)) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        state.attachments.push({ name: file.name, mime: file.type, data: dataUrl.split(',')[1], thumb: dataUrl });
        renderScopeStrip();
      };
      reader.readAsDataURL(file);
    } else if (file.size <= 256 * 1024) {
      const reader = new FileReader();
      reader.onload = () => { state.fileTexts.push({ name: file.name, text: String(reader.result).slice(0, 60_000) }); renderScopeStrip(); };
      reader.readAsText(file);
    }
  }
}

// ---- search overlay -------------------------------------------------------

function openSearch() {
  openOverlay('search-box');
  $('search-input').value = '';
  $('search-results').innerHTML = '';
  $('search-input').focus();
}

async function runSearch(query) {
  const hits = await rpc('search.messages', { query, limit: 8 });
  const out = $('search-results');
  if (!hits.length) { out.innerHTML = '<div class="empty" style="margin:16px 0">Nothing found.</div>'; return; }
  out.innerHTML = '';
  for (const hit of hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    const line = m => `<div class="hit__line"><span class="r">${m.role === 'user' ? '›' : '‹'}</span> ${esc(m.content.slice(0, 130))}</div>`;
    div.innerHTML = `<div class="hit__head">${esc(hit.title ?? 'session ' + hit.sessionId)}</div>${hit.window.map(line).join('')}`;
    div.onclick = () => { closeOverlay(); openSession(hit.sessionId); };
    out.appendChild(div);
  }
}

// ---- settings pane --------------------------------------------------------
// A real view with its own left rail: General / Model lanes / Connectors /
// Receipts. Connectors and receipts live here now; the app rail stays lean.

let settingsTab = 'general';

async function showSettings(tab = settingsTab) {
  state.view = 'settings';
  settingsTab = tab;
  setCrumb('settings', null);
  const view = $('view');
  view.innerHTML = `
    <div class="settings-pane">
      <nav class="set-nav">
        ${[['general', 'General'], ['models', 'Model lanes'], ['connectors', 'Connectors'], ['receipts', 'Receipts']]
          .map(([key, label]) => `<button data-tab="${key}"${key === tab ? ' class="active"' : ''}>${label}</button>`).join('')}
      </nav>
      <div class="set-content" id="set-content"></div>
    </div>`;
  view.querySelectorAll('.set-nav button').forEach(btn =>
    btn.addEventListener('click', () => showSettings(btn.dataset.tab)));
  const content = $('set-content');

  if (tab === 'general') {
    const cfg = await rpc('config.get');
    content.innerHTML = `
      <div class="set-section">IDENTITY</div>
      <div class="set-row"><label>Your name</label><input id="set-name" value="${esc(cfg.user.name)}"></div>
      <div class="set-row"><label>Voice</label>
        <select id="set-tone">${['plain', 'warm', 'dry'].map(t => `<option value="${t}"${cfg.voice.tone === t ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="set-row" style="align-items:flex-start"><label style="padding-top:8px">Voice notes</label>
        <textarea id="set-notes" class="voice-notes" placeholder="Chat register only — work products stay neutral.">${esc(cfg.voice.notes)}</textarea></div>
      <div class="set-section">PERMISSIONS</div>
      <div class="set-row"><label>Mode</label>
        <select id="set-perm">
          ${[['ask', 'ask — everything asks'], ['auto', 'auto — writes flow, commands ask'], ['bypass', 'bypass — everything flows']]
            .map(([v, l]) => `<option value="${v}"${cfg.permissions.mode === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div class="set-row"><label></label><span class="ro">the hardline list blocks in every mode</span></div>
      <div class="set-section">MEMORY</div>
      <div class="set-row"><label>Capture every</label><input id="set-capture" type="number" min="2" value="${cfg.memory.captureEvery}"></div>
      <div class="set-row"><label>Core budget</label><input id="set-budget" type="number" min="500" step="100" value="${cfg.memory.coreBudget}"></div>
      <div class="set-save"><button class="send" id="set-save-general">Save</button></div>`;
    $('set-save-general').onclick = async () => {
      await rpc('config.set', {
        user: { name: $('set-name').value },
        voice: { tone: $('set-tone').value, notes: $('set-notes').value },
        permissions: { mode: $('set-perm').value },
        memory: { captureEvery: Number($('set-capture').value), coreBudget: Number($('set-budget').value) },
      });
      await loadPermMode();
      showSettings('general');
    };
  } else if (tab === 'models') {
    const cfg = await rpc('config.get');
    await loadModels();
    const roleSelect = role => `
      <div class="set-row"><label>${role}</label>
        <select data-role="${role}">
          ${state.models.map(m => `<option value="${esc(m.spec)}"${cfg.models[role] === m.spec ? ' selected' : ''}>${esc(m.spec)}</option>`).join('')}
          ${state.models.some(m => m.spec === cfg.models[role]) ? '' : `<option value="${esc(cfg.models[role])}" selected>${esc(cfg.models[role])}</option>`}
        </select></div>`;
    content.innerHTML = `
      <div class="set-section">MODEL LANES</div>
      ${['chat', 'agent', 'utility', 'embed'].map(roleSelect).join('')}
      <div class="set-save"><button class="send" id="set-save-models">Save</button></div>`;
    $('set-save-models').onclick = async () => {
      const models = {};
      content.querySelectorAll('select[data-role]').forEach(sel => { models[sel.dataset.role] = sel.value; });
      await rpc('config.set', { models });
      await loadModels();
      showSettings('models');
    };
  } else if (tab === 'connectors') {
    content.innerHTML = '<div class="set-section">CONNECTORS</div><div id="connector-list"></div>';
    await buildConnectors($('connector-list'), () => showSettings('connectors'));
  } else if (tab === 'receipts') {
    const receipts = await rpc('receipts.list', { limit: 120 });
    content.innerHTML = '<div class="set-section">RECEIPTS — EVERY ACTION, ACCOUNTED</div>' +
      receipts.map(r => `
        <div class="receipt-row"><span class="t">${r.id} ${esc(r.created_at.slice(5, 19))}</span> <span class="k">${esc(r.kind)}</span> <span class="t">${esc(r.detail)}</span></div>`).join('');
  }
}

// ---- permission mode cycler -----------------------------------------------

const PERM_ORDER = ['ask', 'auto', 'bypass'];
let permMode = 'ask';

function renderPermBtn() {
  const btn = $('perm-btn');
  btn.textContent = permMode;
  btn.classList.toggle('warn', permMode === 'bypass');
}

async function loadPermMode() {
  try {
    const cfg = await rpc('config.get');
    permMode = cfg.permissions?.mode ?? 'ask';
  } catch { permMode = 'ask'; }
  renderPermBtn();
}

$('perm-btn').onclick = async () => {
  permMode = PERM_ORDER[(PERM_ORDER.indexOf(permMode) + 1) % PERM_ORDER.length];
  renderPermBtn();
  await rpc('config.set', { permissions: { mode: permMode } });
};

// ---- overlay plumbing -----------------------------------------------------

function openOverlay(boxId) {
  $('overlay').classList.remove('hidden');
  for (const id of ['search-box', 'approval-modal', 'project-modal']) {
    $(id).classList.toggle('hidden', id !== boxId);
  }
}
function closeOverlay() { $('overlay').classList.add('hidden'); }

document.querySelectorAll('#approval-modal .modal__actions button').forEach(btn =>
  btn.addEventListener('click', () => {
    rpc('approval.respond', { approvalId: $('overlay').dataset.approvalId, decision: btn.dataset.decision });
    closeOverlay();
  }));

// ---- wiring ---------------------------------------------------------------

$('cmd-new').onclick = () => { newChat(); $('input').focus(); };
$('cmd-search').onclick = openSearch;
$('switcher').onclick = toggleSwitcherMenu;
document.querySelectorAll('[data-view]').forEach(btn =>
  btn.addEventListener('click', () =>
    ({ memory: showMemory, artifacts: showArtifacts, settings: showSettings })[btn.dataset.view]()));
$('overlay').addEventListener('click', e => { if (e.target === $('overlay')) closeOverlay(); });

$('rail-toggle').onclick = () => {
  $('app').classList.toggle('rail-hidden');
  localStorage.setItem('heph-rail', $('app').classList.contains('rail-hidden') ? '1' : '0');
};
$('inspector-toggle').onclick = () => {
  $('app').classList.toggle('insp-hidden');
  localStorage.setItem('heph-insp', $('app').classList.contains('insp-hidden') ? '1' : '0');
};
if (localStorage.getItem('heph-rail') === '1') $('app').classList.add('rail-hidden');
if (localStorage.getItem('heph-insp') === '1') $('app').classList.add('insp-hidden');

$('attach').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
$('model-btn').onclick = toggleModelPopup;
$('at-btn').onclick = () => {
  const input = $('input');
  input.focus();
  input.setRangeText('@', input.selectionStart, input.selectionEnd, 'end');
  updateAtPopup();
};
$('plan-toggle').onclick = () => setPlan(!state.plan);

$('send').onclick = send;
$('input').addEventListener('input', () => {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(200, input.scrollHeight) + 'px';
  atSelected = 0; updateAtPopup(); renderSendState();
});
$('input').addEventListener('keydown', e => {
  const popup = $('at-popup');
  if (!popup.classList.contains('hidden')) {
    const count = Number(popup.dataset.count ?? 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); atSelected = (atSelected + 1) % count; return updateAtPopup(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); atSelected = (atSelected - 1 + count) % count; return updateAtPopup(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return chooseAt(popup._candidates[atSelected]); }
    if (e.key === 'Escape') return popup.classList.add('hidden');
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) runSearch(e.target.value.trim());
});

window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); newChat(); $('input').focus(); }
  if (e.key === 'Escape') { $('model-popup').classList.add('hidden'); $('switcher-menu').classList.add('hidden'); closeOverlay(); }
});

setPlan(false);
newChat();
renderInspector();
connect();
