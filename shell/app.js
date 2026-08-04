// Hephaestus shell — a thin client. The daemon owns everything; this renders.
// Auth: `heph ui` opens this page with the daemon token in the URL fragment
// (fragments never hit server logs); same trust boundary as the CLI.

'use strict';

const token = location.hash.slice(1);
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  sessions: [],
  projects: [],
  skins: [],
  view: 'chat',          // chat | search | memory | receipts
  sessionId: null,
  project: null,         // @project chip — scopes new conversations
  refs: [],              // @session chips — [{id, title}], max 2
  busy: false,
};

// ---- rpc ------------------------------------------------------------------

let ws = null;
let nextId = 1;
const pending = new Map();

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${token}`);
  ws.onopen = async () => {
    setConn('forge linked', 'ok');
    await loadSkins();
    state.projects = await rpc('project.list'); // before the sidebar renders groups
    await refreshSessions();
  };
  ws.onclose = () => {
    setConn('link lost — rekindling…', 'bad');
    setTimeout(connect, 1500);
  };
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

function setConn(text, cls) {
  const conn = $('conn');
  conn.textContent = text;
  conn.className = 'conn ' + (cls ?? '');
}

// ---- events ---------------------------------------------------------------

let liveBody = null; // the streaming message's .body element

function onEvent(event, p) {
  if (event === 'chat.delta' || event === 'agent.delta') {
    if (liveBody) {
      liveBody.textContent += p.text;
      $('view').scrollTop = $('view').scrollHeight;
    }
  } else if (event === 'agent.tool') {
    const row = document.createElement('div');
    row.className = 'tool-row' + (p.ok ? '' : ' failed');
    row.innerHTML = `<span class="mark">›</span> ${esc(p.name)} ${esc(p.summary)} <span style="opacity:.6">${p.ms}ms</span>`;
    liveBody?.parentElement?.before(row);
    liveBody && startLiveMessage(); // tool output splits the stream — new block
  } else if (event === 'approval.request') {
    $('approval-tool').textContent = `${p.tool} [${p.risk}]`;
    $('approval-summary').textContent = p.summary;
    $('modal-backdrop').classList.remove('hidden');
    $('modal-backdrop').dataset.approvalId = p.approvalId;
  } else if (event === 'skin.changed') {
    applySkin(p.skin);
  }
}

document.querySelectorAll('.modal-actions button').forEach(btn =>
  btn.addEventListener('click', () => {
    const approvalId = $('modal-backdrop').dataset.approvalId;
    rpc('approval.respond', { approvalId, decision: btn.dataset.decision });
    $('modal-backdrop').classList.add('hidden');
  }));

// ---- skins ----------------------------------------------------------------

async function loadSkins() {
  state.skins = await rpc('skins.list');
  const select = $('skin-select');
  select.innerHTML = state.skins
    .map(s => `<option value="${esc(s.name)}">${esc(s.label)} · ${s.polarity}</option>`)
    .join('');
  const saved = localStorage.getItem('heph-skin') ?? 'forge';
  select.value = state.skins.some(s => s.name === saved) ? saved : 'forge';
  applySkinByName(select.value);
  select.onchange = () => {
    localStorage.setItem('heph-skin', select.value);
    applySkinByName(select.value);
  };
}

async function applySkinByName(name) {
  applySkin(await rpc('skins.get', { name }));
}

function applySkin(skin) {
  const p = skin.palette;
  const root = document.documentElement.style;
  const map = {
    '--bg': p.bg, '--bg-alt': p.bgAlt, '--surface': p.surface, '--border': p.border,
    '--fg': p.fg, '--fg-muted': p.fgMuted, '--accent': p.accent, '--accent-alt': p.accentAlt,
    '--positive': p.positive, '--warning': p.warning, '--danger': p.danger, '--info': p.info,
    '--fg-on-accent': skin.resolved?.fgOnAccent ?? '#000',
  };
  for (const [k, v] of Object.entries(map)) root.setProperty(k, v);
}

// ---- sessions / transcript ------------------------------------------------

// Sidebar: PROJECTS (each a space, its chats nested) then CHATS (loose).
// Metadata is plain muted text — no badges, no pills (AESTHETIC §5).
async function refreshSessions() {
  state.sessions = await rpc('session.list');
  const nav = $('side-nav');
  nav.innerHTML = '';

  const sessionItem = (s, nested) => {
    const item = document.createElement('div');
    item.className = 'session-item' + (nested ? '' : ' loose') + (s.id === state.sessionId && state.view === 'chat' ? ' active' : '');
    item.innerHTML = `
      <div class="session-title">${esc(s.title ?? 'untitled')}</div>
      <div class="session-meta">${esc(s.automaton)} · ${esc(s.created_at.slice(5, 10))}</div>`;
    item.onclick = () => openSession(s.id);
    return item;
  };

  if (state.projects.length) {
    const label = document.createElement('div');
    label.className = 'nav-section';
    label.textContent = 'PROJECTS';
    nav.appendChild(label);
    for (const proj of state.projects) {
      const sessions = state.sessions.filter(s => s.project === proj.name);
      const row = document.createElement('div');
      row.className = 'proj-row' + (state.view === 'space' && state.spaceName === proj.name ? ' active' : '');
      row.innerHTML = `<span class="n">${esc(proj.name)}</span><span class="c">${sessions.length}</span>`;
      row.onclick = () => openProjectSpace(proj.name);
      nav.appendChild(row);
      for (const s of sessions.slice(0, 6)) nav.appendChild(sessionItem(s, true));
    }
  }

  const loose = state.sessions.filter(s => !s.project);
  if (loose.length) {
    const label = document.createElement('div');
    label.className = 'nav-section';
    label.textContent = 'CHATS';
    nav.appendChild(label);
    for (const s of loose) nav.appendChild(sessionItem(s, false));
  }
}

// A project's dedicated space: identity, its chats, its memory footprint.
async function openProjectSpace(name) {
  state.view = 'space';
  state.spaceName = name;
  const proj = state.projects.find(p => p.name === name);
  const sessions = state.sessions.filter(s => s.project === name);
  const { facts } = await rpc('memory.list');
  const scoped = facts.filter(f => f.scope === `project:${name}`);
  setHead(`project · ${name}`);
  const view = $('view');
  $('main').classList.remove('hero');
  view.innerHTML = '';
  const space = document.createElement('div');
  space.className = 'space';
  space.innerHTML = `
    <div class="space-name">${esc(name)}</div>
    <div class="space-root">${esc(proj?.root ?? '')}</div>
    <div class="space-stats">${sessions.length} chat${sessions.length === 1 ? '' : 's'} · ${scoped.length} scoped memor${scoped.length === 1 ? 'y' : 'ies'}</div>
    <div class="space-actions"><button id="space-new" class="row-btn" style="width:auto"><span>new chat in ${esc(name)}</span></button></div>
    <div class="space-list"></div>`;
  view.appendChild(space);
  const list = space.querySelector('.space-list');
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML = `
      <div class="session-title">${esc(s.title ?? 'untitled')}</div>
      <div class="session-meta">${esc(s.automaton)} · ${esc(s.created_at.slice(0, 16).replace('T', ' '))}</div>`;
    item.onclick = () => openSession(s.id);
    list.appendChild(item);
  }
  space.querySelector('#space-new').onclick = () => {
    newChat();
    state.project = name;
    renderChips();
    $('input').focus();
  };
  refreshSessions();
}

async function openSession(id) {
  state.view = 'chat';
  state.sessionId = id;
  const session = state.sessions.find(s => s.id === id);
  state.project = session?.project ?? null;
  renderChips();
  setHead(session?.title ?? `session ${id}`);
  $('main').classList.remove('hero');
  const messages = await rpc('session.messages', { sessionId: id });
  const view = $('view');
  view.innerHTML = '';
  for (const m of messages) appendMessage(m.role, m.content);
  view.scrollTop = view.scrollHeight;
  refreshSessions();
}

function newChat() {
  state.view = 'chat';
  state.sessionId = null;
  state.project = null;
  state.refs = [];
  renderChips();
  setHead('new chat');
  // the Grok move: empty chat centers the input and gets out of the way
  $('main').classList.add('hero');
  $('view').innerHTML = `
    <div class="hero-mark">
      <div class="g">ΗΦΑΙΣΤΟΣ</div>
      <div class="t">what are we forging?</div>
    </div>`;
  refreshSessions();
}

function setHead(title) {
  $('head-title').textContent = title;
}

function appendMessage(role, content) {
  const who = role === 'user' ? 'you' : role === 'tool' ? 'tool' : 'hephaestus';
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  msg.innerHTML = `<div class="who">${who}</div><div class="body"></div>`;
  msg.querySelector('.body').textContent = content;
  $('view').appendChild(msg);
  return msg.querySelector('.body');
}

function startLiveMessage() {
  liveBody = appendMessage('assistant', '');
}

// ---- send -----------------------------------------------------------------

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.busy) return;
  if (state.view !== 'chat') { state.view = 'chat'; $('view').innerHTML = ''; }
  $('main').classList.remove('hero');
  if ($('view').querySelector('.hero-mark')) $('view').innerHTML = '';
  state.busy = true;
  $('send').disabled = true;
  input.value = '';
  appendMessage('user', text);
  startLiveMessage();
  $('view').scrollTop = $('view').scrollHeight;

  const automaton = $('automaton').value;
  try {
    if (automaton === 'dev') {
      const project = state.projects.find(pr => pr.name === state.project);
      if (!project) throw new Error('dev needs a project — type @ and pick one');
      const result = await rpc('agent.run', { task: text, project: project.name });
      state.sessionId = result.sessionId;
    } else {
      const result = await rpc('chat.send', {
        text,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        ...(state.project && !state.sessionId ? { project: state.project } : {}),
        ...(state.refs.length ? { refSessions: state.refs.map(r => r.id) } : {}),
      });
      state.sessionId = result.sessionId;
    }
  } catch (err) {
    if (liveBody) { liveBody.textContent += `\n[${err.message}]`; }
  } finally {
    state.busy = false;
    state.refs = [];
    renderChips();
    $('send').disabled = false;
    liveBody = null;
    refreshSessions();
  }
}

// ---- chips + @ popup ------------------------------------------------------

function renderChips() {
  const chips = $('chips');
  chips.innerHTML = '';
  if (state.project) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `@${state.project}`;
    chip.title = 'project scope — click to clear';
    chip.onclick = () => { state.project = null; renderChips(); };
    chips.appendChild(chip);
  }
  for (const ref of state.refs) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `↩ ${ref.title ?? 'session ' + ref.id}`;
    chip.title = 'referenced session — click to remove';
    chip.onclick = () => { state.refs = state.refs.filter(x => x.id !== ref.id); renderChips(); };
    chips.appendChild(chip);
  }
}

let atSelected = 0;

function atCandidates(prefix) {
  const lower = prefix.toLowerCase();
  const projects = state.projects
    .filter(p => p.name.toLowerCase().startsWith(lower))
    .map(p => ({ kind: 'project', label: p.name, apply: () => { state.project = p.name; } }));
  const sessions = state.sessions
    .filter(s => (s.title ?? '').toLowerCase().includes(lower))
    .slice(0, 6)
    .map(s => ({
      kind: 'session',
      label: `${s.title ?? 'session ' + s.id} · #${s.id}`,
      apply: () => {
        if (state.refs.length < 2 && !state.refs.some(r => r.id === s.id)) {
          state.refs.push({ id: s.id, title: s.title });
        }
      },
    }));
  return [...projects, ...sessions].slice(0, 8);
}

function updateAtPopup() {
  const input = $('input');
  const upToCaret = input.value.slice(0, input.selectionStart);
  const match = upToCaret.match(/@([\w-]*)$/);
  const popup = $('at-popup');
  if (!match) { popup.classList.add('hidden'); return; }
  const candidates = atCandidates(match[1]);
  if (!candidates.length) { popup.classList.add('hidden'); return; }
  atSelected = Math.min(atSelected, candidates.length - 1);
  popup.innerHTML = candidates.map((c, i) =>
    `<div class="at-item${i === atSelected ? ' selected' : ''}" data-i="${i}">
       <span class="at-kind">${c.kind}</span><span class="at-label">${esc(c.label)}</span>
     </div>`).join('');
  popup.classList.remove('hidden');
  popup.querySelectorAll('.at-item').forEach(eln =>
    eln.addEventListener('mousedown', ev => { ev.preventDefault(); chooseAt(candidates[Number(eln.dataset.i)]); }));
  popup.dataset.count = String(candidates.length);
  popup._candidates = candidates;
}

function chooseAt(candidate) {
  const input = $('input');
  const caret = input.selectionStart;
  const upToCaret = input.value.slice(0, caret).replace(/@[\w-]*$/, '');
  input.value = upToCaret + input.value.slice(caret);
  input.selectionStart = input.selectionEnd = upToCaret.length;
  candidate.apply();
  renderChips();
  $('at-popup').classList.add('hidden');
  input.focus();
}

// ---- search ---------------------------------------------------------------

async function runSearch(query) {
  state.view = 'search';
  setHead(`search — "${query}"`);
  const view = $('view');
  view.innerHTML = '<div class="empty">searching the transcripts…</div>';
  const hits = await rpc('search.messages', { query, limit: 8 });
  view.innerHTML = '';
  if (!hits.length) {
    view.innerHTML = '<div class="empty">nothing in the transcripts — this is evidence about past conversations, not the world</div>';
    return;
  }
  for (const hit of hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    const line = m => `<div class="hit-line"><span class="r">${m.role === 'user' ? '❯' : '⏵'}</span> ${esc(m.content.slice(0, 140))}</div>`;
    div.innerHTML = `
      <div class="hit-head">session ${hit.sessionId} <span class="muted">${esc(hit.title ?? '')}</span></div>
      <div class="hit-body">
        ${hit.opening.map(line).join('')}
        ${hit.opening.length ? '<div class="hit-gap">⋯</div>' : ''}
        ${hit.window.map(line).join('')}
        ${hit.closing.length ? '<div class="hit-gap">⋯</div>' : ''}
        ${hit.closing.map(line).join('')}
      </div>`;
    div.onclick = () => openSession(hit.sessionId);
    view.appendChild(div);
  }
}

// ---- memory & receipts views ----------------------------------------------

async function showMemory() {
  state.view = 'memory';
  setHead('memory');
  const { budget, coreUsed, facts } = await rpc('memory.list');
  const core = facts.filter(f => f.core);
  const deep = facts.filter(f => !f.core);
  const pct = Math.min(100, Math.round((coreUsed / budget) * 100));
  const factRow = f => `
    <div class="fact">
      <span class="fid">#${f.id} ${esc(f.scope === 'global' ? '' : f.scope.slice(8))}</span>
      <span class="fbody">${esc(f.content)} <span class="fmeta">${esc(f.category)} · i${f.importance}</span></span>
    </div>`;
  $('view').innerHTML = `
    <div class="mem-section">
      <div class="mem-title">MEMORY CORE — ${pct}% of ${budget} chars</div>
      <div class="budget-bar"><div class="budget-fill" style="width:${pct}%"></div></div>
      ${core.map(factRow).join('') || '<div class="empty">core is empty — the capture pass promotes what earns the budget</div>'}
    </div>
    <div class="mem-section">
      <div class="mem-title">DEEP MEMORY — ${deep.length} facts</div>
      ${deep.map(factRow).join('')}
    </div>`;
}

async function showReceipts() {
  state.view = 'receipts';
  setHead('receipts — every finger lifted');
  const receipts = await rpc('receipts.list', { limit: 100 });
  $('view').innerHTML = receipts.map(r => `
    <div class="receipt"><span class="rt">#${r.id} ${esc(r.created_at.slice(5, 19))}</span> <span class="rk">${esc(r.kind)}</span> ${esc(r.detail)}</div>`,
  ).join('');
}

// ---- wiring ---------------------------------------------------------------

$('new-chat').onclick = newChat;
document.querySelectorAll('[data-view]').forEach(btn =>
  btn.addEventListener('click', () => (btn.dataset.view === 'memory' ? showMemory() : showReceipts())));

// keyboard: the 2026-hub basics — search and new chat from anywhere
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('search').focus(); $('search').select(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); newChat(); $('input').focus(); }
});

$('send').onclick = send;
$('input').addEventListener('keydown', e => {
  const popup = $('at-popup');
  if (!popup.classList.contains('hidden')) {
    const count = Number(popup.dataset.count ?? 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); atSelected = (atSelected + 1) % count; updateAtPopup(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); atSelected = (atSelected - 1 + count) % count; updateAtPopup(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseAt(popup._candidates[atSelected]); return; }
    if (e.key === 'Escape') { popup.classList.add('hidden'); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('input').addEventListener('input', () => { atSelected = 0; updateAtPopup(); });

$('search').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) runSearch(e.target.value.trim());
});

newChat();
connect();
