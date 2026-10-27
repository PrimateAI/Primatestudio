'use strict';
// Primate Studio shell: sessions, teams, memory, the team chat (server-sent events) and the app pane
// that hosts Primate DE (de.js) and PrimeProbe (probe.js).

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function h(tag, attrs = {}, ...kids) {
  const e = tag.startsWith('svg:') ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.setAttribute('class', v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) e.style.setProperty(sk.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), sv);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(3)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('ps.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ps.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const API = (window.PRIMATE_API || '').replace(/\/$/, '');   // '' = same server; see config.js

async function api(path, body) {
  const r = await fetch(API + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (r.headers.get('Content-Type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// a small modal: fields = nodes; resolves with true (OK) / false
function modal(title, body, okLabel = 'OK', cancel = 'Cancel') {
  return new Promise(res => {
    const m = $('#modal'), card = m.querySelector('.modal-card');
    const done = v => { m.hidden = true; document.removeEventListener('keydown', key); res(v); };
    const key = e => { if (e.key === 'Escape') done(false); };
    card.replaceChildren(h('h3', {}, title), ...[].concat(body),
      h('div', { class: 'btns' }, cancel ? h('button', { onclick: () => done(false) }, cancel) : null,
        okLabel ? h('button', { class: 'primary', onclick: () => done(true) }, okLabel) : null));
    m.hidden = false;
    document.addEventListener('keydown', key);
    (card.querySelector('input, textarea, select') || card.querySelector('.primary'))?.focus();
  });
}

// ---------------------------------------------------------------- markdown
function mdInline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}
function mdRender(md) {
  const out = [];
  md.split(/```/).forEach((part, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(part.replace(/^[\w+-]*\n/, ''))}</code></pre>`); return; }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter(l => l.trim());
      if (!lines.length) continue;
      if (lines.length > 1 && lines.every(l => /^\s*\|/.test(l))) {
        const rows = lines.filter(l => !/^\s*\|?\s*:?-{3,}/.test(l)).map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
        out.push('<table><tr>' + rows[0].map(c => `<th>${mdInline(c)}</th>`).join('') + '</tr>' +
          rows.slice(1).map(r => '<tr>' + r.map(c => `<td>${mdInline(c)}</td>`).join('') + '</tr>').join('') + '</table>');
      } else if (lines.every(l => /^\s*[-*] /.test(l))) out.push('<ul>' + lines.map(l => `<li>${mdInline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>');
      else if (lines.every(l => /^\s*\d+[.)] /.test(l))) out.push('<ol>' + lines.map(l => `<li>${mdInline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('') + '</ol>');
      else out.push('<p>' + lines.map(l => /^#+\s/.test(l) ? `<strong>${mdInline(l.replace(/^#+\s*/, ''))}</strong>` : mdInline(l)).join('<br>') + '</p>');
    }
  });
  return out.join('');
}

// ---------------------------------------------------------------- state
const P = { state: null, sid: store.get('session', null), session: null, controller: null };
const teamOf = id => P.state?.teams.find(t => t.id === id) || { id, name: id, color: '#888' };
const COMMANDS = [
  ['/help', 'list commands'], ['/teams', 'list the teams'], ['/team <id>', 'talk to a team by default'],
  ['/memory [scope]', 'show memory'], ['/remember [scope] <text>', 'save a memory'], ['/forget <scope> <name>', 'delete a memory'],
  ['/open <lib>/<cell> [view]', 'open a view in Primate DE'], ['/sim <lib>/<cell> [pdk] [corner]', 'run PrimeSpice'],
  ['/clear', 'start a fresh context'],
];
const SUGGEST = [
  'Create a CMOS inverter in sky130 and simulate its DC transfer curve',
  '@analog-schematic Design a 5-transistor OTA in ptm45 with a 50 fF load and report its gain and UGF',
  '@digital-logic Write a PRBS7 generator with a self-checking testbench and run it',
  '@ms-verification What should we verify on the SerDes TX before tape-out?',
];

// ---------------------------------------------------------------- app pane
const Apps = {
  tabs: [],          // {id, title, kind: 'de' | 'probe', key}
  active: null,
  open(tab) {
    if (!this.tabs.some(t => t.id === tab.id)) this.tabs.push(tab);
    $('#app-pane').hidden = false;
    this.activate(tab.id);
  },
  activate(id) {
    const tab = this.tabs.find(t => t.id === id);
    if (!tab) return;
    this.active = id;
    $('#de').hidden = tab.kind !== 'de';
    $('#probe').hidden = tab.kind !== 'probe';
    if (tab.kind === 'de') DE.show(tab.key);
    else Probe.show(tab.key);
    this.render();
  },
  close(id) {
    this.tabs = this.tabs.filter(t => t.id !== id);
    if (this.active === id) {
      const last = this.tabs[this.tabs.length - 1];
      if (last) this.activate(last.id); else { $('#app-pane').hidden = true; this.active = null; }
    }
    this.render();
  },
  render() {
    $('#app-tab-list').replaceChildren(...this.tabs.map(t => h('button', {
      class: 'app-tab' + (t.id === this.active ? ' active' : ''), onclick: () => this.activate(t.id) },
      t.title, h('button', { class: 'x', title: 'Close', onclick: e => { e.stopPropagation(); this.close(t.id); } }, '✕'))));
  },
};
$('#app-close').addEventListener('click', () => { $('#app-pane').hidden = true; });
$('#app-max').addEventListener('click', () => $('#app-pane').classList.toggle('max'));
$('#app-de').addEventListener('click', () => DE.openLauncher());
$('#app-probe').addEventListener('click', () => Probe.open(null));

// ---------------------------------------------------------------- sidebar
async function loadSessions() {
  const list = await api('/api/sessions');
  $('#session-list').replaceChildren(...list.map(s => h('button', {
    class: 'session' + (s.id === P.sid ? ' active' : ''), title: s.title, onclick: () => openSession(s.id) },
    h('span', { class: 'dot', style: { background: teamOf(s.team).color } }), h('span', { class: 't' }, s.title),
    h('button', { class: 'x', title: 'Delete this chat', onclick: async e => {
      e.stopPropagation();
      if (!await modal('Delete chat?', h('p', {}, s.title), 'Delete')) return;
      await api('/api/sessions/delete', { id: s.id });
      if (s.id === P.sid) await newSession(); else loadSessions();
    } }, '✕'))));
  return list;
}

function renderTeams() {
  const cur = P.session?.team;
  $('#team-list').replaceChildren(...P.state.teams.map(t => h('button', {
    class: 'team' + (t.id === cur ? ' active' : ''), title: t.mission, onclick: () => send(`/team ${t.id}`) },
    h('span', { class: 'dot', style: { background: t.color } }), t.name)));
  $('#team-select').replaceChildren(...P.state.teams.map(t => h('option', { value: t.id, selected: t.id === cur }, t.name)));
}

async function loadMemory() {
  const scopes = await api('/api/memory');
  const box = $('#memory-list');
  box.replaceChildren();
  let any = false;
  for (const [scope, entries] of Object.entries(scopes)) {
    if (!entries.length) continue;
    any = true;
    box.append(h('div', { class: 'mem-scope' }, scope.startsWith('team:') ? teamOf(scope.slice(5)).name : scope));
    for (const e of entries) box.append(h('button', { class: 'mem', title: e.description, onclick: () => showMemory(scope, e.name) },
      e.name, h('span', { class: 'd' }, e.description)));
  }
  if (!any) box.append(h('p', { class: 'muted small' }, 'No memories yet. Teams save decisions here; you can too with /remember.'));
}

async function showMemory(scope, name) {
  const m = await api(`/api/memory/read?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`);
  const ok = await modal(`${scope} / ${name}`, [h('p', { class: 'muted small' }, `${m.type || 'fact'} · ${m.team || ''} · ${m.updated || ''}`),
    h('p', {}, h('strong', {}, m.description)), h('pre', { class: 'mono', style: { whiteSpace: 'pre-wrap' } }, m.body)],
    'Delete', 'Close');
  if (ok) { await api('/api/memory/delete', { scope, name }); loadMemory(); toast('Memory deleted'); }
}

$('#mem-add').addEventListener('click', async () => {
  const scope = h('select', {}, ['project', 'user', ...P.state.teams.map(t => `team:${t.id}`)].map(s => h('option', { value: s }, s)));
  const desc = h('input', { type: 'text', placeholder: 'One-line description' });
  const body = h('textarea', { rows: 5, placeholder: 'The fact, decision or spec' });
  if (!await modal('New memory', [h('div', { class: 'row' }, 'Scope', scope), desc, body], 'Save')) return;
  try { await api('/api/memory', { scope: scope.value, description: desc.value, body: body.value }); loadMemory(); }
  catch (err) { toast(err.message, 6000); }
});

// ---------------------------------------------------------------- sessions
async function newSession() {
  const s = await api('/api/sessions', { team: P.session?.team || 'lead' });
  await openSession(s.id);
}

async function openSession(sid) {
  P.session = await api('/api/sessions/' + sid);
  P.sid = sid;
  store.set('session', sid);
  renderTeams();
  loadSessions();
  replay(P.session);
}
$('#new-session').addEventListener('click', newSession);
$('#team-select').addEventListener('change', e => send(`/team ${e.target.value}`));

// ---------------------------------------------------------------- chat rendering
const R = { turns: [], segment: null, tools: {}, thinking: null };

function welcome() {
  $('#chat-log').replaceChildren(h('div', { class: 'welcome' },
    h('h2', {}, 'What are we designing?'),
    h('p', { class: 'muted' }, 'Talk to the Lead, or address a team with @analog-schematic, @digital-logic, @analog-layout, ' +
      '@digital-layout, @chip-layout or @ms-verification. Teams edit designs in Primate DE, simulate with PrimeSpice and keep ' +
      'what they learn in memory. Everything runs on this PC.'),
    h('div', { class: 'suggest' }, SUGGEST.map(s => h('button', { onclick: () => send(s) }, s)))));
}

function scrollDown() { const l = $('#chat-log'); l.scrollTop = l.scrollHeight; }

function userBubble(text, team) {
  $('.welcome')?.remove();
  $('#chat-log').append(h('div', { class: 'msg-user' }, h('span', { class: 'to' }, 'to ' + teamOf(team).name), text));
}

function turnBlock(team, depth) {
  const t = teamOf(team);
  const el = h('div', { class: 'turn' + (depth ? ' nested' : ''), style: { '--team': t.color } },
    h('div', { class: 'turn-head' }, h('span', { class: 'dot', style: { background: t.color } }), t.name));
  const parent = depth && R.turns.length ? R.turns[0].el : $('#chat-log');
  parent.append(el);
  const turn = { team, depth, el };
  R.turns = depth ? [R.turns[0], turn] : [turn];
  R.segment = null;
  return turn;
}

function currentTurn(team, depth) {
  const t = R.turns.find(x => x.depth === depth && x.team === team);
  return t || turnBlock(team, depth);
}

function addText(team, depth, delta) {
  const t = currentTurn(team, depth);
  if (!R.segment || R.segment.turn !== t) {
    R.segment = { turn: t, text: '', el: h('div', { class: 'md cursor' }) };
    t.el.append(R.segment.el);
  }
  R.segment.text += delta;
  R.segment.el.innerHTML = mdRender(R.segment.text);
}

function endSegment() { if (R.segment) R.segment.el.classList.remove('cursor'); R.segment = null; }

function fmtArgs(args) {
  return Object.entries(args || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

function addTool(team, depth, id, name, args) {
  endSegment();
  const t = currentTurn(team, depth);
  const st = h('span', { class: 'st run' }, '…');
  const out = h('div', { class: 'out' }, 'running');
  const row = h('details', { class: 'tool' }, h('summary', {}, h('span', { class: 'name' }, name), h('span', { class: 'args' }, fmtArgs(args)), st), out);
  t.el.append(row);
  R.tools[id] = { st, out };
}

function toolDone(id, ok, summary, seconds) {
  const t = R.tools[id];
  if (!t) return;
  t.st.className = 'st ' + (ok ? 'ok' : 'bad');
  t.st.textContent = (ok ? '✓' : '✗') + (seconds ? ` ${seconds}s` : '');
  t.out.textContent = summary;
}

function note(text) { endSegment(); $('#chat-log').append(h('div', { class: 'note' }, text)); }
function eventLine(...kids) {
  endSegment();
  const parent = R.turns.length ? R.turns[R.turns.length - 1].el : $('#chat-log');
  parent.append(h('div', { class: 'event' }, ...kids));
}

function permissionCard(ev) {
  endSegment();
  const card = h('div', { class: 'perm' }, h('span', { class: 'q' }, h('strong', {}, ev.tool), ' — ', ev.reason));
  const decide = async allow => {
    card.querySelectorAll('button').forEach(b => (b.disabled = true));
    card.append(h('span', { class: 'muted small' }, allow ? 'allowed' : 'denied'));
    try { await api('/api/permission', { id: ev.id, allow }); } catch (err) { toast(err.message); }
  };
  card.append(h('button', { class: 'primary', onclick: () => decide(true) }, 'Allow'), h('button', { onclick: () => decide(false) }, 'Deny'));
  (R.turns.length ? R.turns[R.turns.length - 1].el : $('#chat-log')).append(card);
}

function handle(ev) {
  switch (ev.type) {
    case 'turn': endSegment(); turnBlock(ev.team, ev.depth); break;
    case 'text': addText(ev.team, ev.depth, ev.delta); break;
    case 'retract':                       // the model wrote a tool call as text: show the text without it
      if (R.segment) { R.segment.text = ev.text; R.segment.el.innerHTML = mdRender(ev.text); if (!ev.text) R.segment.el.remove(); }
      endSegment();
      break;
    case 'thinking': {
      const t = currentTurn(ev.team, ev.depth);
      if (!R.thinking || R.thinking.turn !== t) {
        R.thinking = { turn: t, text: '', el: h('details', { class: 'thinking' }, h('summary', {}, 'thinking'), h('div')) };
        t.el.append(R.thinking.el);
      }
      R.thinking.text += ev.delta;
      R.thinking.el.lastChild.textContent = R.thinking.text;
      break;
    }
    case 'tool': addTool(ev.team, ev.depth, ev.id, ev.name, ev.args); break;
    case 'tool_result': toolDone(ev.id, ev.ok, ev.summary, ev.seconds); break;
    case 'permission': permissionCard(ev); break;
    case 'system': note(ev.text); break;
    case 'handoff': eventLine(`→ handed to ${teamOf(ev.to).name}: ${ev.task}`); break;
    case 'design_changed': DE.changed(ev.lib, ev.cell); break;
    case 'open_view': DE.open(ev.lib, ev.cell, ev.view); break;
    case 'run': eventLine(`PrimeSpice run ${ev.ok ? 'finished' : 'failed'}: ${ev.lib}/${ev.cell}`,
      h('button', { onclick: () => Probe.open(ev.run) }, 'Open in PrimeProbe')); Probe.refreshRuns(); break;
    case 'memory': eventLine(`💾 ${ev.action} ${ev.scope}/${ev.name}${ev.description ? ' — ' + ev.description : ''}`); loadMemory(); break;
    case 'session': if (P.session) { P.session.team = ev.team; renderTeams(); } break;
    case 'status': $('#status').textContent = ev.text; break;
    case 'error': note('⚠ ' + ev.message); break;
    case 'done': endSegment(); $('#status').textContent = ''; break;
  }
  scrollDown();
}

function replay(s) {
  R.turns = []; R.segment = null; R.tools = {}; R.thinking = null;
  const log = $('#chat-log');
  log.replaceChildren();
  if (!s.messages.length) { welcome(); return; }
  for (const m of s.messages) {
    if (m.role === 'user') { R.turns = []; userBubble(m.content, m.team); }
    else if (m.role === 'system_note') note(m.content);
    else if (m.role === 'assistant') {
      const t = R.turns.find(x => x.depth === (m.depth || 0) && x.team === m.team) || turnBlock(m.team, m.depth || 0);
      if (m.content) { R.segment = null; addText(m.team, m.depth || 0, m.content); endSegment(); }
      for (const c of m.tool_calls || []) { let a = {}; try { a = JSON.parse(c.arguments); } catch { /* raw */ } addTool(m.team, m.depth || 0, c.id, c.name, a); }
      void t;
    } else if (m.role === 'tool') {
      let summary = m.content;
      try { const o = JSON.parse(m.content); summary = o.error ? 'error: ' + o.error : m.content.slice(0, 220); } catch { /* text */ }
      toolDone(m.tool_call_id, m.ok !== false, summary);
    }
  }
  scrollDown();
}

// ---------------------------------------------------------------- send
async function send(text) {
  text = (text ?? $('#input').value).trim();
  if (!text || P.controller) return;
  if (!P.sid) await newSession();
  $('#input').value = '';
  autosize();
  hideHint();
  const m = text.match(/^@([a-z-]+)\s/);
  if (!text.startsWith('/')) userBubble(m ? text.slice(m[0].length) : text, m ? m[1] : P.session.team);
  R.turns = [];
  P.controller = new AbortController();
  $('#send').textContent = 'Stop';
  $('#send').classList.remove('primary');
  try {
    const r = await fetch(API + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: P.controller.signal,
      body: JSON.stringify({ session: P.sid, text, think: $('#think').checked, open: DE.currentLabel() }) });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const p of parts) if (p.startsWith('data: ')) { try { handle(JSON.parse(p.slice(6))); } catch (err) { console.error(err); } }
    }
  } catch (err) {
    if (err.name !== 'AbortError') note('⚠ ' + (err.message === 'Failed to fetch' ? 'Primate Studio server is not reachable.' : err.message));
  } finally {
    endSegment();
    P.controller = null;
    $('#send').textContent = 'Send';
    $('#send').classList.add('primary');
    $('#status').textContent = '';
    P.session = await api('/api/sessions/' + P.sid).catch(() => P.session);
    renderTeams();
    loadSessions();
    $('#input').focus();
  }
}

// ---------------------------------------------------------------- composer
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
  t.style.overflowY = t.scrollHeight > 220 ? 'auto' : 'hidden';
}
let hintItems = [], hintIndex = 0;
function hideHint() { $('#hint').hidden = true; hintItems = []; }
function showHint() {
  const v = $('#input').value;
  if (/^\/\S*$/.test(v)) hintItems = COMMANDS.filter(([c]) => c.startsWith(v.split(' ')[0])).map(([c, d]) => ({ k: c, d, ins: c.split(' ')[0] + ' ' }));
  else if (/^@[a-z-]*$/.test(v)) hintItems = P.state.teams.filter(t => ('@' + t.id).startsWith(v)).map(t => ({ k: '@' + t.id, d: t.name, ins: '@' + t.id + ' ' }));
  else return hideHint();
  if (!hintItems.length) return hideHint();
  hintIndex = Math.min(hintIndex, hintItems.length - 1);
  $('#hint').replaceChildren(...hintItems.map((it, i) => h('button', { type: 'button', class: i === hintIndex ? 'hl' : '',
    onclick: () => pickHint(i) }, h('span', { class: 'k' }, it.k), h('span', { class: 'muted' }, it.d))));
  $('#hint').hidden = false;
}
function pickHint(i) { $('#input').value = hintItems[i].ins; hideHint(); $('#input').focus(); }

$('#input').addEventListener('input', () => { autosize(); hintIndex = 0; showHint(); });
$('#input').addEventListener('keydown', e => {
  if (hintItems.length && !$('#hint').hidden) {
    if (e.key === 'ArrowDown') { hintIndex = (hintIndex + 1) % hintItems.length; showHint(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { hintIndex = (hintIndex + hintItems.length - 1) % hintItems.length; showHint(); e.preventDefault(); return; }
    if (e.key === 'Tab') { pickHint(hintIndex); e.preventDefault(); return; }
    if (e.key === 'Escape') { hideHint(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#composer').addEventListener('submit', e => { e.preventDefault(); if (P.controller) P.controller.abort(); else send(); });

async function pollLLM() {
  const pill = $('#llm-pill');
  try {
    const s = await api('/api/llm');
    pill.className = 'pill ' + (s.status === 'online' ? 'ok' : s.status === 'loading' ? 'warn' : 'bad');
    pill.textContent = s.status === 'online' ? (s.model || 'model').replace(/\.gguf$/i, '').replace(/-Q\d.*$/i, '') : 'model ' + s.status;
  } catch { pill.className = 'pill bad'; pill.textContent = 'studio offline'; }
}

// ---------------------------------------------------------------- boot
(async () => {
  try {
    P.state = await api('/api/state');
    $('#ws-path').textContent = 'workspace ' + P.state.workspace;
    const list = await loadSessions();
    if (P.sid && list.some(s => s.id === P.sid)) await openSession(P.sid);
    else if (list.length) await openSession(list[0].id);
    else await newSession();
    loadMemory();
    DE.init();
    Probe.init();
    pollLLM();
    setInterval(pollLLM, 20000);
  } catch (err) {
    $('#llm-pill').className = 'pill bad';
    $('#llm-pill').textContent = 'engine offline';
    $('#chat-log').replaceChildren(h('div', { class: 'welcome' },
      h('h2', {}, "Can't reach your Primate Studio engine"),
      h('p', { class: 'muted' }, API
        ? `This page talks to the engine on your PC at ${API}, which only devices on your Tailscale network can reach. ` +
          'Turn Tailscale on here, and check that the PC is on and Primate Studio is running.'
        : 'The Primate Studio server is not answering. Start it from the Primate Studio icon.'),
      h('p', { class: 'muted small' }, err.message),
      h('div', { class: 'suggest' }, h('button', { onclick: () => location.reload() }, 'Retry'))));
  }
})();
