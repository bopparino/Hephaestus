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
  models: [],            // installed catalog from models.list
  bindings: {},          // role -> "provider/model"
  view: 'chat',          // chat | search | memory | receipts | artifacts | space
  sessionId: null,
  spaceName: null,
  project: null,         // @project chip — scopes new conversations
  refs: [],              // @session chips — [{id, title}], max 2
  attachments: [],       // [{name, mime, data, thumb?}] images; text files fold into the message
  fileTexts: [],         // [{name, text}]
  busy: false,
};

// ---- rpc ------------------------------------------------------------------

let ws = null;
let nextId = 1;
const pending = new Map();

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${token}`);
  ws.onopen = async () => {
    setConn('linked', 'ok');
    await loadSkins();
    state.projects = await rpc('project.list'); // before the sidebar renders groups
    await refreshSessions();
    await loadModels();
  };
  ws.onclose = () => {
    setConn('relinking…', 'bad');
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

function typingDots() {
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.innerHTML = '<i></i><i></i><i></i>';
  return dots;
}

function onEvent(event, p) {
  if (event === 'chat.delta' || event === 'agent.delta') {
    if (!liveBody) return;
    liveBody.querySelector('.dots')?.remove();
    const tok = document.createElement('span');
    tok.className = 'tok';
    tok.textContent = p.text;
    liveBody.appendChild(tok);
    $('view').scrollTop = $('view').scrollHeight;
  } else if (event === 'agent.tool') {
    const row = document.createElement('div');
    row.className = 'tool-row' + (p.ok ? '' : ' failed');
    row.innerHTML = `<span class="mark">›</span> ${esc(p.name)} ${esc(p.summary)} <span style="opacity:.6">${p.ms}ms</span>`;
    liveBody?.parentElement?.before(row);
    liveBody && startLiveMessage(); // tool output splits the stream — new block
  } else if (event === 'approval.request') {
    $('approval-tool').textContent = `${p.tool} [${p.risk}]`;
    $('approval-summary').textContent = p.summary;
    $('settings-modal').classList.add('hidden');
    $('approval-modal').classList.remove('hidden');
    $('modal-backdrop').classList.remove('hidden');
    $('modal-backdrop').dataset.approvalId = p.approvalId;
  } else if (event === 'skin.changed') {
    applySkin(p.skin);
  }
}

document.querySelectorAll('#approval-modal .modal-actions button').forEach(btn =>
  btn.addEventListener('click', () => {
    const approvalId = $('modal-backdrop').dataset.approvalId;
    rpc('approval.respond', { approvalId, decision: btn.dataset.decision });
    closeModals();
  }));

function closeModals() {
  $('modal-backdrop').classList.add('hidden');
  $('approval-modal').classList.add('hidden');
  $('settings-modal').classList.add('hidden');
}

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

// ---- models ---------------------------------------------------------------

function shortModel(spec) {
  const model = spec?.split('/').slice(1).join('/') ?? spec ?? '?';
  return model.length > 18 ? model.slice(0, 17) + '…' : model;
}

async function loadModels() {
  try {
    const { models, bindings } = await rpc('models.list');
    state.models = models;
    state.bindings = bindings;
    $('model-btn').textContent = '^ ' + shortModel(bindings.chat);
  } catch {
    $('model-btn').textContent = '^ —';
  }
}

function toggleModelPopup() {
  const popup = $('model-popup');
  if (!popup.classList.contains('hidden')) { popup.classList.add('hidden'); return; }
  $('at-popup').classList.add('hidden');
  popup.innerHTML = '<div class="pop-note">CHAT MODEL — APPLIES TO NEW EXCHANGES</div>' +
    state.models.map(m => `
      <div class="pop-item${m.spec === state.bindings.chat ? ' current' : ''}" data-spec="${esc(m.spec)}">
        <span class="pop-kind">${esc(m.provider)}</span>
        <span class="pop-label">${esc(m.model)}</span>
      </div>`).join('');
  popup.classList.remove('hidden');
  popup.querySelectorAll('.pop-item').forEach(item =>
    item.addEventListener('mousedown', async ev => {
      ev.preventDefault();
      popup.classList.add('hidden');
      await rpc('config.set', { models: { chat: item.dataset.spec } });
      await loadModels();
    }));
}

// ---- sidebar --------------------------------------------------------------

const folded = name => localStorage.getItem('heph-fold:' + name) === '1';

// Two-stage delete: first click arms ("sure?"), second within 2.5s commits.
// Archive is soft — nothing is ever destroyed (directive #4).
function armDelete(btn, commit) {
  if (btn.classList.contains('arm')) { commit(); return; }
  btn.classList.add('arm');
  btn.textContent = 'sure?';
  setTimeout(() => { btn.classList.remove('arm'); btn.textContent = '×'; }, 2500);
}

async function refreshSessions() {
  state.sessions = await rpc('session.list');
  const nav = $('side-nav');
  nav.innerHTML = '';

  const sessionItem = (s, nested) => {
    const item = document.createElement('div');
    item.className = 'session-item' + (nested ? '' : ' loose') + (s.id === state.sessionId && state.view === 'chat' ? ' active' : '');
    item.innerHTML = `
      <div class="s-main">
        <div class="session-title">${esc(s.title ?? 'untitled')}</div>
        <div class="session-meta">${esc(s.automaton)} · ${esc(s.created_at.slice(5, 10))}</div>
      </div>
      <button class="del" title="archive chat">×</button>`;
    item.querySelector('.s-main').onclick = () => openSession(s.id);
    item.querySelector('.del').onclick = ev => {
      ev.stopPropagation();
      armDelete(ev.target, async () => {
        await rpc('session.archive', { id: s.id });
        if (state.sessionId === s.id) newChat();
        else refreshSessions();
      });
    };
    return item;
  };

  if (state.projects.length) {
    const label = document.createElement('div');
    label.className = 'nav-section';
    label.textContent = 'PROJECTS';
    nav.appendChild(label);
    for (const proj of state.projects) {
      const sessions = state.sessions.filter(s => s.project === proj.name);
      const isFolded = folded(proj.name);
      const row = document.createElement('div');
      row.className = 'proj-row' + (state.view === 'space' && state.spaceName === proj.name ? ' active' : '');
      row.innerHTML = `
        <span class="chev">${isFolded ? '▸' : '▾'}</span>
        <span class="n">${esc(proj.name)}</span>
        <span class="c">${sessions.length}</span>
        <button class="del" title="archive project">×</button>`;
      row.querySelector('.chev').onclick = ev => {
        ev.stopPropagation();
        localStorage.setItem('heph-fold:' + proj.name, isFolded ? '0' : '1');
        refreshSessions();
      };
      row.querySelector('.n').onclick = () => openProjectSpace(proj.name);
      row.querySelector('.del').onclick = ev => {
        ev.stopPropagation();
        armDelete(ev.target, async () => {
          await rpc('project.archive', { name: proj.name });
          state.projects = await rpc('project.list');
          if (state.spaceName === proj.name) newChat();
          else refreshSessions();
        });
      };
      nav.appendChild(row);
      if (!isFolded) for (const s of sessions.slice(0, 8)) nav.appendChild(sessionItem(s, true));
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

// ---- project space --------------------------------------------------------

async function openProjectSpace(name) {
  state.view = 'space';
  state.spaceName = name;
  const proj = state.projects.find(p => p.name === name);
  const sessions = state.sessions.filter(s => s.project === name);
  const { facts } = await rpc('memory.list');
  const scoped = facts.filter(f => f.scope === `project:${name}`);
  setHead(`project · ${name}`);
  $('main').classList.remove('hero');
  const view = $('view');
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
      <div class="s-main">
        <div class="session-title">${esc(s.title ?? 'untitled')}</div>
        <div class="session-meta">${esc(s.automaton)} · ${esc(s.created_at.slice(0, 16).replace('T', ' '))}</div>
      </div>`;
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

// ---- transcript -----------------------------------------------------------

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
  state.spaceName = null;
  state.project = null;
  state.refs = [];
  clearAttachments();
  renderChips();
  setHead('new chat');
  $('main').classList.add('hero');
  $('view').innerHTML = `
    <div class="hero-mark">
      <div class="g">ΗΦΑΙΣΤΟΣ</div>
      <div class="t">the forge is lit — state the work</div>
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
  liveBody.appendChild(typingDots());
}

// ---- send -----------------------------------------------------------------

async function send() {
  const input = $('input');
  let text = input.value.trim();
  if ((!text && !state.attachments.length && !state.fileTexts.length) || state.busy) return;
  if (state.view !== 'chat') { state.view = 'chat'; $('view').innerHTML = ''; }
  $('main').classList.remove('hero');
  if ($('view').querySelector('.hero-mark')) $('view').innerHTML = '';

  // Text files fold into the message as fenced reference blocks.
  for (const f of state.fileTexts) {
    text += `\n\n[file: ${f.name}]\n\`\`\`\n${f.text}\n\`\`\``;
  }
  if (!text) text = '(attached)';

  state.busy = true;
  $('send').disabled = true;
  input.value = '';
  const attachments = state.attachments.map(a => ({ name: a.name, mime: a.mime, data: a.data }));
  const label = state.attachments.length ? `[attached: ${state.attachments.map(a => a.name).join(', ')}]\n` : '';
  clearAttachments();
  appendMessage('user', label + text);
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
        ...(attachments.length ? { attachments } : {}),
      });
      state.sessionId = result.sessionId;
    }
  } catch (err) {
    if (liveBody) {
      liveBody.querySelector('.dots')?.remove();
      liveBody.textContent += `[${err.message}]`;
    }
  } finally {
    state.busy = false;
    state.refs = [];
    renderChips();
    $('send').disabled = false;
    liveBody?.querySelector('.dots')?.remove();
    liveBody = null;
    refreshSessions();
  }
}

// ---- attachments ----------------------------------------------------------

function clearAttachments() {
  state.attachments = [];
  state.fileTexts = [];
  renderChips();
}

function handleFiles(files) {
  for (const file of files) {
    if (/^image\//.test(file.type)) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        state.attachments.push({
          name: file.name, mime: file.type,
          data: dataUrl.split(',')[1], thumb: dataUrl,
        });
        renderChips();
      };
      reader.readAsDataURL(file);
    } else if (file.size <= 256 * 1024) {
      const reader = new FileReader();
      reader.onload = () => {
        state.fileTexts.push({ name: file.name, text: String(reader.result).slice(0, 60_000) });
        renderChips();
      };
      reader.readAsText(file);
    }
  }
}

// ---- chips + @ popup ------------------------------------------------------

function renderChips() {
  const chips = $('chips');
  chips.innerHTML = '';
  const chip = (label, title, onRemove, thumb) => {
    const el = document.createElement('span');
    el.className = 'chip';
    el.title = title;
    if (thumb) {
      const t = document.createElement('span');
      t.className = 'thumb';
      t.style.backgroundImage = `url(${thumb})`;
      el.appendChild(t);
    }
    el.appendChild(document.createTextNode(label));
    el.onclick = onRemove;
    chips.appendChild(el);
  };
  if (state.project) {
    chip(`@${state.project}`, 'project scope — click to clear', () => { state.project = null; renderChips(); });
  }
  for (const ref of state.refs) {
    chip(`ref ${ref.title ?? 'session ' + ref.id}`, 'referenced session — click to remove',
      () => { state.refs = state.refs.filter(x => x.id !== ref.id); renderChips(); });
  }
  for (const a of state.attachments) {
    chip(a.name, 'attached image — click to remove',
      () => { state.attachments = state.attachments.filter(x => x !== a); renderChips(); }, a.thumb);
  }
  for (const f of state.fileTexts) {
    chip(f.name, 'attached file — click to remove',
      () => { state.fileTexts = state.fileTexts.filter(x => x !== f); renderChips(); });
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
      label: `${s.title ?? 'session ' + s.id} · ${s.id}`,
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
  $('model-popup').classList.add('hidden');
  atSelected = Math.min(atSelected, candidates.length - 1);
  popup.className = 'popup';
  popup.innerHTML = candidates.map((c, i) =>
    `<div class="pop-item${i === atSelected ? ' selected' : ''}" data-i="${i}">
       <span class="pop-kind">${c.kind}</span><span class="pop-label">${esc(c.label)}</span>
     </div>`).join('');
  popup.querySelectorAll('.pop-item').forEach(eln =>
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
  setHead(`search · ${query}`);
  $('main').classList.remove('hero');
  const view = $('view');
  view.innerHTML = '<div class="empty">searching…</div>';
  const hits = await rpc('search.messages', { query, limit: 8 });
  view.innerHTML = '';
  if (!hits.length) {
    view.innerHTML = '<div class="empty">nothing in the transcripts</div>';
    return;
  }
  for (const hit of hits) {
    const div = document.createElement('div');
    div.className = 'hit';
    const line = m => `<div class="hit-line"><span class="r">${m.role === 'user' ? '›' : '‹'}</span> ${esc(m.content.slice(0, 140))}</div>`;
    div.innerHTML = `
      <div class="hit-head">session ${hit.sessionId} <span class="muted">${esc(hit.title ?? '')}</span></div>
      <div class="hit-body">
        ${hit.opening.map(line).join('')}
        ${hit.opening.length ? '<div class="hit-gap">···</div>' : ''}
        ${hit.window.map(line).join('')}
        ${hit.closing.length ? '<div class="hit-gap">···</div>' : ''}
        ${hit.closing.map(line).join('')}
      </div>`;
    div.onclick = () => openSession(hit.sessionId);
    view.appendChild(div);
  }
}

// ---- artifacts ------------------------------------------------------------

async function showArtifacts() {
  state.view = 'artifacts';
  setHead('artifacts — what the automata have made');
  $('main').classList.remove('hero');
  const artifacts = await rpc('artifacts.list');
  const view = $('view');
  view.innerHTML = '';
  if (!artifacts.length) {
    view.innerHTML = '<div class="empty">nothing forged yet — dev runs land their files here</div>';
    return;
  }
  for (const a of artifacts) {
    const row = document.createElement('div');
    row.className = 'artifact';
    row.innerHTML = `
      <span class="a-path">${esc(a.rel)}</span>
      <span class="a-meta">${esc(a.root.split('/').pop() ?? '')} · ${a.bytes}b · ${esc(a.at.slice(5, 16))}</span>`;
    row.onclick = () => previewArtifact(a);
    view.appendChild(row);
  }
}

async function previewArtifact(artifact) {
  const view = $('view');
  view.innerHTML = '<div class="empty">reading…</div>';
  try {
    const { content } = await rpc('artifacts.read', { path: artifact.path });
    view.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'preview';
    wrap.innerHTML = `
      <div class="preview-head">
        <span class="preview-back">‹ artifacts</span>
        <span class="preview-path">${esc(artifact.path)}</span>
      </div>
      <pre></pre>`;
    wrap.querySelector('pre').textContent = content;
    wrap.querySelector('.preview-back').onclick = showArtifacts;
    view.appendChild(wrap);
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

// ---- memory & receipts ----------------------------------------------------

async function showMemory() {
  state.view = 'memory';
  setHead('memory');
  $('main').classList.remove('hero');
  const { budget, coreUsed, facts } = await rpc('memory.list');
  const core = facts.filter(f => f.core);
  const deep = facts.filter(f => !f.core);
  const pct = Math.min(100, Math.round((coreUsed / budget) * 100));
  const factRow = f => `
    <div class="fact">
      <span class="fid">${f.id} ${esc(f.scope === 'global' ? '' : f.scope.slice(8))}</span>
      <span class="fbody">${esc(f.content)} <span class="fmeta">${esc(f.category)} · i${f.importance}</span></span>
    </div>`;
  $('view').innerHTML = `
    <div class="mem-section">
      <div class="mem-title">MEMORY CORE — ${pct}% OF ${budget} CHARS</div>
      <div class="budget-bar"><div class="budget-fill" style="width:${pct}%"></div></div>
      ${core.map(factRow).join('') || '<div class="empty">core is empty — the capture pass promotes what earns the budget</div>'}
    </div>
    <div class="mem-section">
      <div class="mem-title">DEEP MEMORY — ${deep.length} FACTS</div>
      ${deep.map(factRow).join('')}
    </div>`;
}

async function showReceipts() {
  state.view = 'receipts';
  setHead('receipts — every action, accounted');
  $('main').classList.remove('hero');
  const receipts = await rpc('receipts.list', { limit: 100 });
  $('view').innerHTML = receipts.map(r => `
    <div class="receipt"><span class="rt">${r.id} ${esc(r.created_at.slice(5, 19))}</span> <span class="rk">${esc(r.kind)}</span> ${esc(r.detail)}</div>`,
  ).join('');
}

// ---- settings -------------------------------------------------------------

async function openSettings() {
  const cfg = await rpc('config.get');
  await loadModels();
  const roleSelect = role => `
    <div class="set-row">
      <label>${role}</label>
      <select data-role="${role}">
        ${state.models.map(m => `<option value="${esc(m.spec)}"${cfg.models[role] === m.spec ? ' selected' : ''}>${esc(m.spec)}</option>`).join('')}
        ${state.models.some(m => m.spec === cfg.models[role]) ? '' : `<option value="${esc(cfg.models[role])}" selected>${esc(cfg.models[role])}</option>`}
      </select>
    </div>`;
  $('settings-body').innerHTML = `
    <div class="set-section">MODEL LANES</div>
    ${['chat', 'agent', 'utility', 'embed'].map(roleSelect).join('')}
    <div class="set-section">BEHAVIOR</div>
    <div class="set-row"><label>your name</label><input id="set-name" value="${esc(cfg.user.name)}"></div>
    <div class="set-row"><label>capture every</label><input id="set-capture" type="number" min="2" value="${cfg.memory.captureEvery}"></div>
    <div class="set-row"><label>core budget</label><input id="set-budget" type="number" min="500" step="100" value="${cfg.memory.coreBudget}"></div>
    <div class="set-section">CONNECTIONS</div>
    <div class="set-row"><label>ollama</label><span class="ro">${esc(cfg.connections.ollamaUrl)}</span></div>
    <div class="set-row"><label>anthropic key</label><span class="ro">${cfg.connections.anthropicKey ? 'present' : 'not set — $ANTHROPIC_API_KEY or ~/.hephaestus/secrets'}</span></div>
    <div class="set-row"><label>telegram</label><span class="ro">${cfg.connections.telegramOwner ? 'owner ' + esc(cfg.connections.telegramOwner) : 'not configured — token in secrets, owner_id in config'}</span></div>`;
  $('approval-modal').classList.add('hidden');
  $('settings-modal').classList.remove('hidden');
  $('modal-backdrop').classList.remove('hidden');
}

async function saveSettings() {
  const models = {};
  document.querySelectorAll('#settings-body select[data-role]').forEach(sel => {
    models[sel.dataset.role] = sel.value;
  });
  await rpc('config.set', {
    models,
    user: { name: $('set-name').value },
    memory: { captureEvery: Number($('set-capture').value), coreBudget: Number($('set-budget').value) },
  });
  await loadModels();
  closeModals();
}

// ---- wiring ---------------------------------------------------------------

$('new-chat').onclick = newChat;
document.querySelectorAll('[data-view]').forEach(btn =>
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    if (v === 'memory') showMemory();
    else if (v === 'receipts') showReceipts();
    else if (v === 'artifacts') showArtifacts();
  }));
$('open-settings').onclick = openSettings;
$('settings-cancel').onclick = closeModals;
$('settings-save').onclick = saveSettings;
$('modal-backdrop').addEventListener('click', e => { if (e.target === $('modal-backdrop')) closeModals(); });

$('side-toggle').onclick = () => {
  $('app').classList.toggle('side-collapsed');
  localStorage.setItem('heph-side', $('app').classList.contains('side-collapsed') ? '1' : '0');
};
if (localStorage.getItem('heph-side') === '1') $('app').classList.add('side-collapsed');

$('attach').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
$('model-btn').onclick = toggleModelPopup;

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

window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('search').focus(); $('search').select(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); newChat(); $('input').focus(); }
  if (e.key === 'Escape') { $('model-popup').classList.add('hidden'); closeModals(); }
});

newChat();
connect();
