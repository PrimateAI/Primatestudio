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
// screen: 'main' (the session chat) or a team id (that member's own chat); liveScreen: where the
// running turn was sent from
const P = { state: null, sid: store.get('session', null), session: null, controller: null,
  screen: store.get('screen', 'main'), liveScreen: null };
const teamOf = id => P.state?.teams.find(t => t.id === id) || { id, name: id, color: '#888' };
const COMMANDS = [
  ['/help', 'list commands'], ['/teams', 'list the teams'], ['/team <id>', 'who answers the session chat'],
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
// Sessions: block sessions (tied to one circuit) carry a ▣ and sit under the session that started
// them; a spinner marks one that is working on its own.
async function loadSessions() {
  const list = await api('/api/sessions');
  P.running = new Set(list.filter(s => s.running).map(s => s.id));
  const ids = new Set(list.map(s => s.id)), kids = {};
  for (const s of list) if (s.parent && ids.has(s.parent)) (kids[s.parent] ||= []).push(s);
  const row = (s, nested) => h('button', {
    class: 'session' + (s.id === P.sid ? ' active' : '') + (nested ? ' nested' : ''),
    title: s.block ? `Block session: ${s.block.lib}/${s.block.cell}` : s.title, onclick: () => openSession(s.id) },
    s.running ? h('span', { class: 'spin', title: 'working' }) : h('span', { class: 'dot', style: { background: teamOf(s.team).color } }),
    s.block ? h('span', { class: 'blk', title: `${s.block.lib}/${s.block.cell}` }, '▣') : null,
    h('span', { class: 't' }, s.title),
    h('button', { class: 'x', title: 'Delete this chat', onclick: async e => {
      e.stopPropagation();
      if (!await modal('Delete chat?', h('p', {}, s.title), 'Delete')) return;
      await api('/api/sessions/delete', { id: s.id });
      if (s.id === P.sid) await newSession(); else loadSessions();
    } }, '✕'));
  const rows = [];
  for (const s of list) {
    if (s.parent && ids.has(s.parent)) continue;
    rows.push(row(s, false), ...(kids[s.id] || []).map(k => row(k, true)));
  }
  $('#session-list').replaceChildren(...rows);
  return list;
}

// A session for one block or circuit (from Primate DE's library tree or menu): its team, model and
// an optional first task, which it starts on at once.
async function newBlockSession(lib, cell) {
  const team = h('select', {}, P.state.teams.map(t => h('option', { value: t.id, selected: t.id === 'analog-schematic' }, t.name)));
  const llm = h('select', {}, h('option', { value: '' }, 'team default'), (P.llms?.llms || []).map(m => h('option', { value: m.id }, `${m.name} (${m.status})`)));
  const brief = h('textarea', { rows: 4, placeholder: 'Optional first task, e.g. "Size the tail for 4 mA and check the swing at tt"; the session starts on it right away' });
  if (!await modal(`New session for ${lib}/${cell}`, [h('label', { class: 'kv' }, 'team', team), h('label', { class: 'kv' }, 'model', llm), brief], 'Start')) return;
  try {
    const s = await api('/api/sessions', { team: team.value, block: { lib, cell }, llm: llm.value || undefined,
      brief: brief.value.trim() || undefined, parent: undefined });
    await openSession(s.id);
    if (brief.value.trim()) toast(`The session is working on it; it shows ⟳ until done.`);
  } catch (err) { toast(err.message, 6000); }
}
window.Studio = { newBlockSession };
$('#llm-menu').addEventListener('click', e => { e.stopPropagation(); modelMenu(); });
$('#llm-pill').addEventListener('click', e => { e.stopPropagation(); modelMenu(); });
document.addEventListener('click', e => { if (!e.target.closest?.('#llm-pop')) $('#llm-pop').hidden = true; });

// ---------------------------------------------------------------- screens
// A message shows on the screen it was typed on; a member's chat also shows everything addressed to
// that member (@tags from other screens, tasks handed to it), from where its chat was last cleared.
function onScreen(m, i, scr, s = P.session) {
  if (m.role === 'proposal_status') return false;
  const where = m.screen || 'main';
  if (scr === 'main') return where === 'main' && m.role !== 'handoff';
  if (i < (s.cleared?.[scr] || 0)) return false;
  if (m.role === 'handoff') return m.team === scr;
  return where === scr || m.team === scr;
}

// replies on a chat's own screen that arrived while the designer was looking at another chat (a
// reply to a message typed elsewhere was already read where it was typed)
function unread(scr) {
  const s = P.session;
  if (!s || scr === P.screen) return 0;
  const seen = store.get(`seen.${s.id}`, {})[scr] ?? s.messages.length;
  return s.messages.reduce((n, m, i) => n + (i >= seen && m.role === 'assistant' && m.content &&
    (m.screen || 'main') === scr && onScreen(m, i, scr) ? 1 : 0), 0);
}

function markSeen() {
  if (!P.session) return;
  const seen = store.get(`seen.${P.session.id}`, {}), n = P.session.messages.length;
  for (const scr of ['main', ...P.state.teams.map(t => t.id)]) seen[scr] ??= n;    // first visit: nothing is new
  seen[P.screen] = n;
  store.set(`seen.${P.session.id}`, seen);
}

function switchScreen(scr) {
  if (scr !== 'main' && !P.state.teams.some(t => t.id === scr)) scr = 'main';
  P.screen = scr;
  store.set('screen', scr);
  markSeen();
  renderTeams();
  if (P.session) replay(P.session);
  $('#input').focus();
}

function renderTeams() {
  const cur = P.session?.team || 'lead';
  const item = (id, label, color, title) => {
    const n = unread(id);
    return h('button', { class: 'team' + (id === P.screen ? ' active' : ''), title, onclick: () => switchScreen(id) },
      h('span', { class: 'dot', style: { background: color } }), h('span', { class: 't' }, label),
      n ? h('span', { class: 'badge', title: `${n} new` }, n) : null);
  };
  $('#team-list').replaceChildren(
    item('main', 'Session chat', 'var(--muted)', `The session's own chat, answered by ${teamOf(cur).name}; @tag a team to bring it in`),
    ...P.state.teams.map(t => item(t.id, t.name, t.color, `${t.name}'s own chat. ${t.mission}`)));
  $('#team-select').replaceChildren(...P.state.teams.map(t => h('option', { value: t.id, selected: t.id === cur }, t.name)));
  const main = P.screen === 'main', t = teamOf(P.screen);
  $('#team-select').closest('label').hidden = !main;
  $('#chat-head').replaceChildren(h('span', { class: 'dot', style: { background: main ? 'var(--muted)' : t.color } }),
    h('strong', {}, main ? 'Session chat' : t.name),
    h('span', { class: 'muted small' }, main
      ? ` · answered by ${teamOf(cur).name}; @team brings one team in, and only that team sees the message`
      : ' · private chat; this team sees only what is sent here, @tagged to it, or handed to it'));
  $('#input').placeholder = main ? 'Message the session…  (@team to address one, @ for files and cells, / for commands)'
    : `Message ${t.name}…  (@team to send to another team instead, @ for files and cells)`;
  renderModel();
}

// ---------------------------------------------------------------- model menu
// Like Claude's model menu: the session's choice wins, else the answering team's default, else the
// studio default. Models are the local llama-servers listed in studio.json.
function effectiveModel() {
  const st = P.llms;
  if (!st) return null;
  const team = P.screen === 'main' ? P.session?.team || 'lead' : P.screen;
  const id = P.session?.llm || st.team_llms[team] || st.default;
  const why = P.session?.llm ? 'this session' : st.team_llms[team] ? `${teamOf(team).name}'s default` : 'studio default';
  return { m: st.llms.find(x => x.id === id) || st.llms[0], why, team };
}

function renderModel() {
  const e = effectiveModel(), b = $('#llm-menu');
  if (!e || !b) return;
  b.replaceChildren(h('span', { class: 'dot ' + e.m.status }), e.m.name, h('span', { class: 'muted' }, ' ▾'));
  b.title = `${e.m.name} (${e.m.status}), from ${e.why}. Click to choose the model for this session.`;
}

async function loadLLMs() {
  try { P.llms = await api('/api/llms'); renderModel(); } catch { /* engine offline */ }
}

function modelMenu() {
  const pop = $('#llm-pop');
  if (!pop.hidden) { pop.hidden = true; return; }
  const e = effectiveModel();
  const pick = async id => {
    pop.hidden = true;
    try { P.session = { ...P.session, ...(await api('/api/sessions/llm', { session: P.sid, llm: id })) }; renderModel(); }
    catch (err) { toast(err.message, 6000); }
  };
  pop.replaceChildren(h('div', { class: 'pop-head' }, 'Model for this session'),
    ...P.llms.llms.map(m => h('button', { type: 'button', class: 'pop-item' + (m.id === e.m.id ? ' on' : ''), onclick: () => pick(m.id),
      title: m.note || '' }, h('span', { class: 'dot ' + m.status }), h('span', { class: 't' }, m.name),
      h('span', { class: 'muted small' }, m.status === 'online' ? m.file || 'online' : m.status), m.id === e.m.id ? ' ✓' : null)),
    h('button', { type: 'button', class: 'pop-item' + (P.session?.llm ? '' : ' on'), onclick: () => pick(null) },
      h('span', { class: 't' }, `Use the team default`), h('span', { class: 'muted small' }, P.session?.llm ? '' : 'in use')),
    h('button', { type: 'button', class: 'pop-item link', onclick: () => { pop.hidden = true; teamModelsDialog(); } }, 'Team defaults…'));
  pop.hidden = false;
}

async function teamModelsDialog() {
  const st = await api('/api/llms');
  const opts = (sel, extra) => [extra ? h('option', { value: '' }, extra) : null,
    ...st.llms.map(m => h('option', { value: m.id, selected: m.id === sel }, `${m.name} (${m.status})`))];
  const def = h('select', {}, opts(st.default));
  const rows = P.state.teams.map(t => [t.id, h('select', {}, opts(st.team_llms[t.id], `studio default`))]);
  rows.forEach(([id, sel]) => { sel.value = st.team_llms[id] || ''; });
  if (!await modal('Models per team', [h('label', { class: 'kv' }, 'studio default', def),
    ...rows.map(([id, sel]) => h('label', { class: 'kv' }, teamOf(id).name, sel)),
    h('p', { class: 'muted small' }, 'A session can still pick its own model from the menu in the message box. Qwen3-14B and the 9B ' +
      'do not fit in memory together on this PC: start the 14B from the Start menu first.')], 'Save')) return;
  try {
    await api('/api/llms/default', { llm: def.value });
    for (const [id, sel] of rows) if ((st.team_llms[id] || '') !== sel.value) await api('/api/llms/team', { team: id, llm: sel.value || null });
    await loadLLMs();
  } catch (err) { toast(err.message, 6000); }
}

// Memory panel. "Learned from chats" is the unified memory the local model fills quietly after each
// turn (learner.py); every team reads it. The designer can pause learning, edit or delete an entry,
// or wipe it all. Everything stays on this PC.
async function loadMemory() {
  const [scopes, learning] = await Promise.all([api('/api/memory'), api('/api/learning').catch(() => ({ enabled: false }))]);
  const box = $('#memory-list');
  box.replaceChildren();
  const learned = scopes.learned || [];
  box.append(h('div', { class: 'mem-scope learned' }, 'Learned from chats',
    h('label', { class: 'switch', title: 'Learn from chats: after each turn the local model files lasting facts here, quietly' },
      h('input', { type: 'checkbox', checked: learning.enabled, onchange: async e => {
        await api('/api/learning', { enabled: e.target.checked }); toast(e.target.checked ? 'Learning from chats is on' : 'Learning paused');
      } }), learning.enabled ? ' on' : ' paused'),
    learned.length ? h('button', { class: 'mini', title: 'Delete everything learned from chats', onclick: async () => {
      if (!await modal('Wipe learned memory?', h('p', {}, `Deletes all ${learned.length} entries learned from chats. Your own and the teams' saved memories stay.`), 'Wipe')) return;
      await api('/api/memory/wipe', { scope: 'learned' }); loadMemory();
    } }, 'wipe') : null));
  if (!learned.length) box.append(h('p', { class: 'muted small' }, learning.enabled
    ? 'Nothing learned yet. Lasting facts from your chats will show here.' : 'Learning is paused.'));
  for (const [scope, entries] of Object.entries(scopes)) {
    if (!entries.length) continue;
    if (scope !== 'learned') box.append(h('div', { class: 'mem-scope' }, scope.startsWith('team:') ? teamOf(scope.slice(5)).name : scope));
    for (const e of entries) box.append(h('button', { class: 'mem', title: e.description, onclick: () => showMemory(scope, e.name) },
      e.name, h('span', { class: 'd' }, e.description)));
  }
}

async function showMemory(scope, name) {
  const m = await api(`/api/memory/read?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`);
  const desc = h('input', { type: 'text', value: m.description || '' });
  const body = h('textarea', { rows: 8 }, m.body);
  let remove = false;
  const del = h('button', { class: 'mini', onclick: () => { remove = true; $('#modal .btns button')?.click(); } }, 'Delete');
  const ok = await modal(`${scope === 'learned' ? 'Learned' : scope} / ${name}`, [
    h('p', { class: 'muted small' }, `${m.type || 'fact'} · ${m.team || ''} · ${m.updated || ''}`), desc, body, del], 'Save', 'Close');
  try {
    if (remove) { await api('/api/memory/delete', { scope, name }); toast('Memory deleted'); }
    else if (ok) { await api('/api/memory', { scope, name, description: desc.value, body: body.value, type: m.type }); toast('Saved'); }
  } catch (err) { toast(err.message, 6000); }
  loadMemory();
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
  const s = await api('/api/sessions', { team: 'lead' });       // a new session always starts with the Lead
  P.screen = 'main';
  store.set('screen', 'main');
  await openSession(s.id);
}

async function openSession(sid) {
  P.session = await api('/api/sessions/' + sid);
  P.sid = sid;
  store.set('session', sid);
  // land on a chat that has something: the one the session's latest message was typed in
  const msgs = P.session.messages;
  if (msgs.length && !msgs.some((m, i) => onScreen(m, i, P.screen))) {
    const last = [...msgs].reverse().find(m => m.role === 'user');
    P.screen = last ? last.screen || 'main' : 'main';
    store.set('screen', P.screen);
  }
  markSeen();
  renderTeams();
  loadSessions();
  replay(P.session);
}
$('#new-session').addEventListener('click', newSession);

// Turns also run from other pages (the hosted copy, another device, an agent), so while idle the
// page re-reads the session list and the open session and redraws when something changed.
async function refresh() {
  if (P.controller || !P.sid || document.hidden) return;
  try {
    const was = P.running?.has(P.sid);
    await loadSessions();
    const s = await api('/api/sessions/' + P.sid);
    if (P.controller || (s.messages.length === P.session?.messages.length && was === P.running.has(P.sid))) return;
    P.session = s;
    replay(s);
    markSeen();
    renderTeams();
  } catch { /* engine offline: the model pill says so */ }
}
window.addEventListener('focus', refresh);
$('#team-select').addEventListener('change', e => send(`/team ${e.target.value}`));

// ---------------------------------------------------------------- chat rendering
const R = { turns: [], segment: null, tools: {}, thinking: null };

function welcome() {
  if (P.screen !== 'main') {
    const t = teamOf(P.screen);
    $('#chat-log').replaceChildren(h('div', { class: 'welcome' },
      h('h2', {}, t.name), h('p', { class: 'muted' }, t.mission),
      h('p', { class: 'muted small' }, `Messages you send here go to ${t.name} only. Messages @tagged to ` +
        `@${t.id} from the session chat or another team's chat, and tasks other teams hand to it, show up here too.`)));
    return;
  }
  $('#chat-log').replaceChildren(h('div', { class: 'welcome' },
    h('h2', {}, 'What are we designing?'),
    h('p', { class: 'muted' }, 'Talk to the Lead, or address a team with @analog-schematic, @digital-logic, @analog-layout, ' +
      '@digital-layout, @chip-layout or @ms-verification. Teams edit designs in Primate DE, simulate with PrimeSpice and keep ' +
      'what they learn in memory. Everything runs on this PC.'),
    h('div', { class: 'suggest' }, SUGGEST.map(s => h('button', { onclick: () => send(s) }, s)))));
}

function scrollDown() { const l = $('#chat-log'); l.scrollTop = l.scrollHeight; }

// a user message as seen on the current screen: "to X" where it was typed, "from <screen>" elsewhere
function userBubble(text, team, where = P.screen, atts = []) {
  $('.welcome')?.remove();
  const label = where !== P.screen ? `@${team} from ${where === 'main' ? 'the session chat' : teamOf(where).name + "'s chat"}`
    : P.screen !== 'main' && team === P.screen ? null : 'to ' + teamOf(team).name;
  if (atts?.length && text === '(see the attached files)') text = '';
  $('#chat-log').append(h('div', { class: 'msg-user' }, label ? h('span', { class: 'to' }, label) : null, ...withMentions(text),
    atts?.length ? h('div', { class: 'msg-atts' }, atts.map(attachmentView)) : null));
}

// @references and [Image #N] tags in a sent message, shown as chips
function withMentions(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(/@"[^"]+"|@[^\s@"]+|\[Image #\d+\]/g)) {
    if (m.index === 0 && P.state.teams.some(t => '@' + t.id === m[0])) continue;
    out.push(text.slice(last, m.index), h('span', { class: 'mention' }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------- attachments
// Files wait in P.pending until Send; each can also go to the paper library (PDFs) and, with a
// label, to the training dataset (uploads.py on the engine).
P.pending = [];
const fileUrl = att => `${API}/api/upload?file=${encodeURIComponent(att.file)}`;
const typeOf = name => /\.pdf$/i.test(name) ? 'pdf' : /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name) ? 'image' : 'text';
const kb = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;

function attachmentView(att) {
  const tags = [att.library ? 'library' : null, att.dataset ? 'dataset' : null].filter(Boolean).join(' · ');
  if (att.type === 'image') return h('a', { class: 'att img', href: fileUrl(att), target: '_blank', title: att.name },
    h('img', { src: fileUrl(att), alt: att.name }), tags ? h('span', { class: 'tag' }, tags) : null);
  return h('a', { class: 'att', href: fileUrl(att), target: '_blank', title: att.name },
    att.type === 'pdf' ? '📕 ' : '📄 ', att.name, h('span', { class: 'muted' }, ` ${kb(att.size)}${tags ? ' · ' + tags : ''}`));
}

function addFiles(list) {
  const el = $('#input');
  for (const file of list) {
    if (file.size > 50 * 1024 * 1024) { toast(`${file.name} is larger than 50 MB`); continue; }
    const name = file.name && file.name !== 'image.png' ? file.name : `pasted-${Date.now()}.png`;
    const p = { file, name, type: typeOf(name), library: typeOf(name) === 'pdf', dataset: null };
    if (p.type === 'image') {                    // like Claude Code: a [Image #N] tag where it was pasted
      p.tag = `[Image #${P.pending.filter(x => x.tag).length + 1}]`;
      const at = el.selectionStart ?? el.value.length;
      el.value = el.value.slice(0, at) + p.tag + ' ' + el.value.slice(at);
      el.selectionStart = el.selectionEnd = at + p.tag.length + 1;
    }
    P.pending.push(p);
  }
  autosize();
  renderPending();
}

function removePending(i) {
  const [p] = P.pending.splice(i, 1);
  if (p?.tag) $('#input').value = $('#input').value.replace(p.tag + ' ', '').replace(p.tag, '');
  renderPending();
}

function renderPending() {
  const box = $('#attachments');
  box.hidden = !P.pending.length;
  box.replaceChildren(...P.pending.map((p, i) => h('div', { class: 'chip' },
    p.type === 'image' ? h('img', { src: p.url ||= URL.createObjectURL(p.file), alt: '' }) : h('span', {}, p.type === 'pdf' ? '📕' : '📄'),
    h('span', { class: 'n', title: p.name }, p.tag ? `${p.tag} ${p.name}` : p.name), h('span', { class: 'muted small' }, kb(p.file.size)),
    p.type === 'pdf' ? h('button', { type: 'button', class: 'mini' + (p.library ? ' on' : ''), title: 'Also file it in the paper library (the Lead cites its passages)',
      onclick: () => { p.library = !p.library; renderPending(); } }, '📚 library') : null,
    h('button', { type: 'button', class: 'mini' + (p.dataset ? ' on' : ''), title: 'Also save it to the training dataset with a label',
      onclick: () => datasetDialog(p) }, p.dataset ? `🧪 ${p.dataset.block} · ${p.dataset.label}` : '🧪 dataset'),
    h('button', { type: 'button', class: 'x', title: 'Remove', onclick: () => removePending(i) }, '✕'))));
}

async function datasetDialog(p) {
  const ds = P.state.dataset, cur = p.dataset || {};
  const guess = p.type === 'image' ? 'schematic' : p.type === 'pdf' ? 'paper' : /\.(sp|spice|cir|net|scs|cdl)$/i.test(p.name) ? 'netlist' : 'other';
  const sel = (opts, v) => h('select', {}, opts.map(o => h('option', { value: o, selected: o === v }, o)));
  const block = sel(ds.blocks, cur.block || 'other'), kind = sel(ds.kinds, cur.kind || guess), label = sel(ds.labels, cur.label || 'unknown');
  const notes = h('textarea', { rows: 3, placeholder: 'What it is, the spec it meets or misses, results…' }, cur.notes || '');
  const ok = await modal(`Training dataset: ${p.name}`, [h('label', { class: 'kv' }, 'block', block), h('label', { class: 'kv' }, 'kind', kind),
    h('label', { class: 'kv' }, 'label', label), notes,
    h('p', { class: 'muted small' }, 'Saved with your label for training AMSChat. Remove it from the dataset by leaving this form with "Not in dataset".')],
  'Save label', 'Not in dataset');
  p.dataset = ok ? { block: block.value, kind: kind.value, label: label.value, notes: notes.value } : null;
  renderPending();
}

async function uploadAll(files, message) {
  const out = [];
  for (const p of files) {
    const q = new URLSearchParams({ session: P.sid, name: p.name, message: message.slice(0, 500) });
    if (p.library) q.set('library', '1');
    if (p.dataset) q.set('dataset', JSON.stringify(p.dataset));
    const r = await fetch(`${API}/api/upload?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: p.file });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p.name}: ${data.error || 'upload failed (HTTP ' + r.status + ')'}`);
    out.push(p.tag ? { ...data, tag: p.tag } : data);
  }
  return out;
}

$('#attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
$('#input').addEventListener('paste', e => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
const chatEl = $('main.chat');
chatEl.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); chatEl.classList.add('drop'); } });
chatEl.addEventListener('dragleave', e => { if (!chatEl.contains(e.relatedTarget)) chatEl.classList.remove('drop'); });
chatEl.addEventListener('drop', e => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); chatEl.classList.remove('drop'); addFiles(e.dataTransfer.files); });

function handoffBubble(m) {
  $('.welcome')?.remove();
  $('#chat-log').append(h('div', { class: 'msg-handoff' },
    h('span', { class: 'to' }, `handed off by ${teamOf(m.from).name}`), m.task));
}

// A Lead's offer of a session for one block, started with a click; status comes from the session's
// proposal_status notes.
function proposalCard(p, status) {
  const card = h('div', { class: 'proposal' });
  const draw = st => card.replaceChildren(
    h('div', { class: 'p-head' }, h('span', { class: 'blk' }, '▣'), h('strong', {}, `New session: ${p.title}`),
      h('span', { class: 'muted small' }, ` · ${p.block.lib}/${p.block.cell} · ${teamOf(p.target_team).name}`)),
    h('details', {}, h('summary', { class: 'muted small' }, 'brief'), h('div', { class: 'small' }, p.brief)),
    st?.status === 'started' ? h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Started.'),
      h('button', { class: 'mini', onclick: () => openSession(st.child) }, 'Open session'))
      : st?.status === 'dismissed' ? h('div', { class: 'muted small' }, 'Dismissed.')
      : h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          try {
            const child = await api('/api/proposals/start', { session: P.sid, id: p.id });
            draw({ status: 'started', child: child.id });
            loadSessions();
            toast(`Started ${child.title}; it reports back here when done.`);
          } catch (err) { toast(err.message, 6000); }
        } }, 'Start session'),
        h('button', { onclick: async () => {
          try { await api('/api/proposals/dismiss', { session: P.sid, id: p.id }); draw({ status: 'dismissed' }); }
          catch (err) { toast(err.message, 6000); }
        } }, 'Dismiss')));
  draw(status);
  return card;
}

function reportCard(m) {
  $('.welcome')?.remove();
  const body = h('div', { class: 'md' });
  body.innerHTML = mdRender(m.content || '');
  $('#chat-log').append(h('div', { class: 'report' },
    h('div', { class: 'p-head' }, h('span', { class: 'blk' }, '▣'), h('strong', {}, `Report from ${m.title}`),
      h('button', { class: 'mini', onclick: () => openSession(m.session) }, 'Open session')), body));
}

function turnBlock(team, depth, llm) {
  const t = teamOf(team);
  const el = h('div', { class: 'turn' + (depth ? ' nested' : ''), style: { '--team': t.color } },
    h('div', { class: 'turn-head' }, h('span', { class: 'dot', style: { background: t.color } }), t.name,
      llm ? h('span', { class: 'llm-tag' }, llm) : null));
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

const DRAWN = new Set(['turn', 'text', 'retract', 'thinking', 'tool', 'tool_result', 'system', 'handoff', 'error', 'proposal']);

function handle(ev) {
  if (P.screen !== P.liveScreen) {
    // the designer moved to another chat while this turn runs: it is redrawn from the session when done
    if (ev.type === 'permission') { switchScreen(P.liveScreen); toast('A team is asking for approval here.'); }
    else if (DRAWN.has(ev.type)) { if (ev.type === 'turn') renderTeams(); return; }
  }
  switch (ev.type) {
    case 'turn': endSegment(); turnBlock(ev.team, ev.depth, ev.llm); break;
    case 'proposal': endSegment(); (R.turns.length ? R.turns[R.turns.length - 1].el : $('#chat-log')).append(proposalCard(ev)); break;
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
  const shown = s.messages.filter((m, i) => onScreen(m, i, P.screen, s));
  if (!shown.length) { welcome(); return; }
  for (const m of shown) {
    // work a team did on a task handed to it is its own top-level turn in its own chat
    const depth = m.depth && P.screen === m.team ? 0 : (m.depth || 0);
    if (m.role === 'user') { R.turns = []; userBubble(m.content, m.team, m.screen || 'main', m.attachments); }
    else if (m.role === 'handoff') { R.turns = []; handoffBubble(m); }
    else if (m.role === 'report') { R.turns = []; reportCard(m); }
    else if (m.role === 'proposal') {
      const st = s.messages.find(x => x.role === 'proposal_status' && x.id === m.id);
      (R.turns.length ? R.turns[R.turns.length - 1].el : $('#chat-log')).append(proposalCard(m, st));
    }
    else if (m.role === 'system_note') note(m.content);
    else if (m.role === 'assistant') {
      if (!R.turns.some(x => x.depth === depth && x.team === m.team)) turnBlock(m.team, depth, m.llm);
      if (m.content) { R.segment = null; addText(m.team, depth, m.content); endSegment(); }
      for (const c of m.tool_calls || []) { let a = {}; try { a = JSON.parse(c.arguments); } catch { /* raw */ } addTool(m.team, depth, c.id, c.name, a); }
    } else if (m.role === 'tool') {
      let summary = m.content;
      try { const o = JSON.parse(m.content); summary = o.error ? 'error: ' + o.error : m.content.slice(0, 220); } catch { /* text */ }
      toolDone(m.tool_call_id, m.ok !== false, summary);
    }
  }
  if (!P.controller && P.running?.has(s.id))    // a turn started elsewhere (another tab, device, or a block brief)
    $('#chat-log').append(h('div', { class: 'working' }, h('span', { class: 'spin' }),
      ' Working… the local model is reading and thinking; this chat fills in as each step finishes.'));
  scrollDown();
}

// ---------------------------------------------------------------- send
async function send(text) {
  text = (text ?? $('#input').value).trim();
  const files = text.startsWith('/') ? [] : P.pending;
  if ((!text && !files.length) || P.controller || P.uploading) return;
  if (!P.sid) await newSession();
  let atts = [];
  if (files.length) {
    $('#status').textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`;
    P.uploading = true;
    try { atts = await uploadAll(files, text); }
    catch (err) { toast(err.message, 6000); $('#status').textContent = ''; return; }
    finally { P.uploading = false; }
    P.pending = [];
    renderPending();
  }
  $('#input').value = '';
  autosize();
  hideHint();
  const m = text.match(/^@([a-z-]+)\s/);
  const here = P.screen === 'main' ? P.session.team || 'lead' : P.screen;
  if (!text.startsWith('/')) userBubble(m ? text.slice(m[0].length) : text, m ? m[1] : here, P.screen, atts);
  R.turns = [];
  P.liveScreen = P.screen;
  P.controller = new AbortController();
  $('#send').textContent = 'Stop';
  $('#send').classList.remove('primary');
  try {
    const r = await fetch(API + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: P.controller.signal,
      body: JSON.stringify({ session: P.sid, text, think: $('#think').checked, open: DE.currentLabel(), screen: P.screen,
        attachments: atts }) });
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
    if (P.screen !== P.liveScreen) replay(P.session);
    P.liveScreen = null;
    markSeen();
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
// Hints under the message box: /commands at the start, and @ anywhere, like Claude Code: teams (at
// the start), cells, this chat's uploads and recent runs. Picking one replaces the @word being typed.
let hintItems = [], hintIndex = 0, hintSpan = null, mentionSeq = 0;
function hideHint() { $('#hint').hidden = true; hintItems = []; }
function drawHint() {
  if (!hintItems.length) return hideHint();
  hintIndex = Math.min(hintIndex, hintItems.length - 1);
  $('#hint').replaceChildren(...hintItems.map((it, i) => h('button', { type: 'button', class: i === hintIndex ? 'hl' : '',
    onclick: () => pickHint(i) }, h('span', { class: 'k' }, it.k), h('span', { class: 'muted' }, it.d))));
  $('#hint').hidden = false;
}
async function showHint() {
  const el = $('#input'), v = el.value, cur = el.selectionStart ?? v.length;
  if (/^\/\S*$/.test(v)) {
    hintSpan = [0, v.length];
    hintItems = COMMANDS.filter(([c]) => c.startsWith(v.split(' ')[0])).map(([c, d]) => ({ k: c, d, ins: c.split(' ')[0] + ' ' }));
    return drawHint();
  }
  const m = v.slice(0, cur).match(/(^|\s)@("[^"]*|[^\s@"]*)$/);
  if (!m) return hideHint();
  const q = m[2].replace(/^"/, ''), start = cur - m[2].length - 1;
  hintSpan = [start, cur];
  const seq = ++mentionSeq;
  const teams = start === 0 ? P.state.teams.filter(t => t.id.startsWith(q)).map(t => ({ k: '@' + t.id, d: `send to ${t.name}`, ins: '@' + t.id + ' ' })) : [];
  let found = [];
  try { found = await api(`/api/mentions?session=${encodeURIComponent(P.sid || '')}&q=${encodeURIComponent(q)}`); } catch { /* offline */ }
  if (seq !== mentionSeq) return;                // a newer keystroke already asked
  hintItems = [...teams, ...found.map(f => ({ k: f.label, d: `${f.kind} · ${f.detail || ''}`, ins: f.insert + ' ' }))];
  drawHint();
}
function pickHint(i) {
  const el = $('#input'), [a, b] = hintSpan || [0, el.value.length];
  el.value = el.value.slice(0, a) + hintItems[i].ins + el.value.slice(b);
  el.selectionStart = el.selectionEnd = a + hintItems[i].ins.length;
  hideHint();
  el.focus();
}

$('#input').addEventListener('input', () => { autosize(); hintIndex = 0; showHint(); });
$('#input').addEventListener('keydown', e => {
  if (hintItems.length && !$('#hint').hidden) {
    if (e.key === 'ArrowDown') { hintIndex = (hintIndex + 1) % hintItems.length; showHint(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { hintIndex = (hintIndex + hintItems.length - 1) % hintItems.length; showHint(); e.preventDefault(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && $('#input').value.slice(0, $('#input').selectionStart).match(/@\S*$/))) {
      pickHint(hintIndex); e.preventDefault(); return;
    }
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
    if (P.screen !== 'main' && !P.state.teams.some(t => t.id === P.screen)) P.screen = 'main';
    await loadLLMs();
    const list = await loadSessions();
    if (P.sid && list.some(s => s.id === P.sid)) await openSession(P.sid);
    else if (list.length) await openSession(list[0].id);
    else await newSession();
    loadMemory();
    DE.init();
    Probe.init();
    pollLLM();
    setInterval(pollLLM, 20000);
    setInterval(loadLLMs, 20000);
    setInterval(refresh, 10000);
  } catch (err) {
    $('#llm-pill').className = 'pill bad';
    $('#llm-pill').textContent = 'engine offline';
    $('#chat-log').replaceChildren(h('div', { class: 'welcome' },
      h('h2', {}, "Can't reach your Primate Studio engine"),
      h('p', { class: 'muted' }, API
        ? `This page talks to the engine on your PC at ${API}, which only devices on your Tailscale network can reach. ` +
          'Turn Tailscale on here, and check that the PC is on and Primate Studio is running. Chrome and Edge also ' +
          'ask once whether this site may access devices on your local network: choose Allow (or set it in the ' +
          'site settings, the icon left of the address).'
        : 'The Primate Studio server is not answering. Start it from the Primate Studio icon.'),
      h('p', { class: 'muted small' }, err.message),
      h('div', { class: 'suggest' }, h('button', { onclick: () => location.reload() }, 'Retry'))));
  }
})();
