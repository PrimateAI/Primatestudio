'use strict';
// Primate DE: library manager, schematic editor, symbol / Verilog / netlist views, testbench settings
// and PrimeSpice runs. Every edit goes through /api/cell/op, the same operations the teams' tools use,
// so a cell edited from the chat refreshes here and vice versa.
//
// Commands work like Virtuoso's: menus (File, Edit, View, Create, Check, Options, Simulation, Window)
// and bindkeys (i instance, w wire, p pin, l wire name, q properties, m stretch, c copy, u/U undo/redo,
// Shift+X check and save, e/Shift+E descend, Ctrl+E return, ...) all run named commands; the keymap
// comes from the server (Virtuoso-style defaults, the designer's overrides, .cdsinit imports).

const DE = (() => {
  const S = {
    libs: [], views: {}, active: null, history: [], sel: new Set(), selNotes: new Set(), drag: null,
    cmd: null,                      // active command mode: place, label, move, stretch, copy, note, zoom_area
    keymap: {}, defaults: {}, commands: {}, menuOpen: null,
    display: store.get('de.display', { grid: true, labels: true, netnames: true, snap: 10, library: true, inspector: true }),
    editor: store.get('de.editor', { autofit: true }),
  };
  const GLOBAL_GND = n => ['0', 'gnd'].includes(n.toLowerCase());
  const GLOBAL_SUP = n => /^(vdd|vcc|avdd|dvdd|vss|avss|dvss)/i.test(n);
  const VIEW_SHORT = { schematic: 'sch', symbol: 'sym', verilog: 'v', netlist: 'net' };
  const MENUS = ['File', 'Edit', 'View', 'Create', 'Check', 'Options', 'Simulation', 'Window'];
  const EDITS = new Set(['copy', 'move', 'stretch', 'rotate', 'mirror', 'delete', 'create_instance', 'create_wire',
    'create_wire_name', 'create_pin', 'create_note', 'wire_stubs', 'make_symbol', 'undo', 'redo', 'align_left',
    'align_right', 'align_top', 'align_bottom', 'align_hcenter', 'align_vcenter', 'testbench']);

  const s = (tag, attrs = {}, ...kids) => h('svg:' + tag, attrs, ...kids);
  const append = (el, ...kids) => el.append(...kids.flat(3).filter(k => k != null && k !== false));   // DOM append turns null into "null"
  const view = () => S.views[S.active];
  const devs = () => P.state.devices;
  const sch = () => view()?.data?.schematic;
  const snap = v => Math.round(v / S.display.snap) * S.display.snap;
  const saveDisplay = () => { store.set('de.display', S.display); store.set('de.editor', S.editor); };

  // ------------------------------------------------------------ geometry
  function defOf(inst, data) {
    return devs()[inst.master] || data.symbols?.[inst.master] || { terminals: [], draw: [{ t: 'circle', c: [0, 0], r: 10 }] };
  }
  function xform(inst, [x, y]) {
    if (inst.mirror) x = -x;
    const r = ((inst.rot || 0) * Math.PI) / 180, c = Math.round(Math.cos(r)), sn = Math.round(Math.sin(r));
    return [inst.x + x * c - y * sn, inst.y + x * sn + y * c];
  }
  function bbox(inst, def) {
    const pts = [];
    for (const d of def.draw) {
      if (d.t === 'circle') pts.push([d.c[0] - d.r, d.c[1] - d.r], [d.c[0] + d.r, d.c[1] + d.r]);
      else if (d.p && typeof d.p[0] === 'number') pts.push(d.p);
      else if (d.p) pts.push(...d.p);
    }
    for (const t of def.terminals) pts.push([t.x, t.y]);
    const xs = pts.map(p => xform(inst, p));
    return [Math.min(...xs.map(p => p[0])), Math.min(...xs.map(p => p[1])), Math.max(...xs.map(p => p[0])), Math.max(...xs.map(p => p[1]))];
  }
  function svgPoint(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function paramText(inst) {
    const p = inst.params || {};
    switch (inst.master) {
      case 'nmos': case 'pmos': return `${p.w ?? 1}/${p.l ?? 'Lmin'}`;
      case 'res': return p.r; case 'cap': return p.c; case 'ind': return p.l;
      case 'vsrc': case 'isrc': return [p.dc !== undefined && p.dc !== '' ? `dc ${p.dc}` : '', p.ac ? `ac ${p.ac}` : '', p.tran ? p.tran.split('(')[0] : ''].filter(Boolean).join(' ');
      case 'opamp': return `A=${p.gain}`;
      default: return inst.master.includes('/') ? inst.master.split('/')[1] : '';
    }
  }

  // ------------------------------------------------------------ library manager
  async function loadLibs() {
    S.libs = await api('/api/libs');
    const tree = $('#de-tree');
    tree.replaceChildren();
    if (!S.libs.length) tree.append(h('p', { class: 'muted small' }, 'No libraries yet. Ask a team, or press + Lib.'));
    for (const lib of S.libs) {
      tree.append(h('div', { class: 'lib' }, lib.name, h('span', { class: 'pdk' }, lib.pdk)));
      for (const c of lib.cells) {
        const key = `${lib.name}/${c.name}`;
        tree.append(h('button', { class: 'cell' + (S.active?.startsWith(key + ':') ? ' active' : ''), title: c.views.join(', '),
          onclick: () => open(lib.name, c.name, c.views.includes('schematic') ? 'schematic' : c.views[0] || 'schematic') },
          c.name, h('span', { class: 'v' }, [c.testbench ? 'tb' : null, ...c.views.map(v => VIEW_SHORT[v])].filter(Boolean).join(' '))));
      }
    }
  }

  async function newLib() {
    const name = h('input', { type: 'text', placeholder: 'mylib' });
    const pdk = h('select', {}, P.state.pdks.filter(p => p.installed).map(p => h('option', { value: p.id }, `${p.id} · ${p.vdd} V`)));
    if (!await modal('New library', [h('div', { class: 'row' }, 'Name', name), h('div', { class: 'row' }, 'PDK', pdk)], 'Create')) return;
    try { await api('/api/libs', { name: name.value.trim(), pdk: pdk.value }); loadLibs(); } catch (err) { toast(err.message, 6000); }
  }

  async function newCell() {
    if (!S.libs.length) { await newLib(); if (!S.libs.length) return; }
    const lib = h('select', {}, S.libs.map(l => h('option', { value: l.name, selected: l.name === view()?.lib }, l.name)));
    const name = h('input', { type: 'text', placeholder: 'ota5t' });
    const kind = h('select', {}, h('option', { value: 'schematic' }, 'schematic'), h('option', { value: 'testbench' }, 'testbench (schematic + analyses)'),
      h('option', { value: 'verilog' }, 'verilog'));
    if (!await modal('New cellview', [h('div', { class: 'row' }, 'Library', lib), h('div', { class: 'row' }, 'Cell', name), h('div', { class: 'row' }, 'View', kind)], 'Create')) return;
    try {
      if (kind.value === 'verilog') {
        await api('/api/verilog', { lib: lib.value, cell: name.value.trim(), code: `module ${name.value.trim()} ();\nendmodule\n` });
        await loadLibs(); open(lib.value, name.value.trim(), 'verilog');
      } else {
        await api('/api/cell/new', { lib: lib.value, cell: name.value.trim(), testbench: kind.value === 'testbench' });
        await loadLibs(); open(lib.value, name.value.trim(), 'schematic');
      }
    } catch (err) { toast(err.message, 6000); }
  }

  async function openDialog() {
    const filter = h('input', { type: 'text', placeholder: 'filter cells' });
    const list = h('div', { class: 'pick-list' });
    let choice = null;
    const draw = () => list.replaceChildren(...S.libs.flatMap(l => l.cells.filter(c => (`${l.name}/${c.name}`).includes(filter.value.trim()))
      .map(c => h('button', { class: 'pick' + (choice === `${l.name}/${c.name}` ? ' on' : ''), onclick: () => { choice = `${l.name}/${c.name}`; draw(); },
        ondblclick: () => $('#modal .primary').click() }, `${l.name}/${c.name}`, h('span', { class: 'muted small' }, ' ' + c.views.join(', '))))));
    filter.addEventListener('input', draw);
    draw();
    if (!await modal('Open cellview', [filter, list], 'Open') || !choice) return;
    const [l, c] = choice.split('/');
    open(l, c, 'schematic');
  }

  // ------------------------------------------------------------ views
  async function fetchCell(lib, cell) { return api(`/api/cell?lib=${encodeURIComponent(lib)}&cell=${encodeURIComponent(cell)}`); }

  let opening = Promise.resolve();            // a key pressed while a cellview loads waits for it
  function open(...args) { return (opening = openNow(...args)); }

  async function openNow(lib, cell, kind = 'schematic', push = false, readOnly = false) {
    const key = `${lib}/${cell}:${kind}`;
    try {
      const data = await fetchCell(lib, cell);
      if (push && S.active) S.history.push(S.active);
      const fresh = !S.views[key];
      S.views[key] = { ...(S.views[key] || {}), lib, cell, kind, data, readOnly };
      Apps.open({ id: 'de:' + key, title: `${cell} · ${VIEW_SHORT[kind] || kind}${readOnly ? ' (read)' : ''}`, kind: 'de', key });
      if (fresh && kind === 'schematic') fit();
    } catch (err) { toast(err.message, 6000); }
  }

  function show(key) {
    S.active = key;
    S.sel.clear(); S.selNotes.clear();
    S.cmd = null;
    render();
    loadLibs();
  }

  async function changed(lib, cell) {
    await loadLibs();
    for (const [key, v] of Object.entries(S.views)) {
      if (v.lib === lib && v.cell === cell) {
        const before = v.data?.schematic?.instances.length;
        try { v.data = await fetchCell(lib, cell); } catch { /* deleted */ }
        // a team added or removed devices: re-fit so new parts are not off screen
        const refit = S.editor.autofit && v.kind === 'schematic' && v.data?.schematic && v.data.schematic.instances.length !== before;
        if (key === S.active) refit ? fit() : render();
        else if (refit) v.vb = null;
      }
    }
  }

  async function op(name, args = {}) {
    const v = view();
    try {
      v.data = await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: name, args });
      render();
      return true;
    } catch (err) { toast(err.message, 6000); return false; }
  }

  function render() {
    const v = view();
    if (!v) return;
    $('.de-lib').hidden = !S.display.library;
    renderMenubar(v);
    const body = $('#de-body');
    if (v.kind === 'schematic') renderSchematic(v, body);
    else if (v.kind === 'symbol') renderSymbol(v, body);
    else if (v.kind === 'verilog') renderVerilog(v, body);
    else if (v.kind === 'netlist') renderNetlist(v, body);
  }

  // ------------------------------------------------------------ menus and toolbar
  const keyOf = id => Object.entries(S.keymap).find(([, c]) => c === id)?.[0] || '';

  function renderMenubar(v) {
    const tb = $('#de-toolbar');
    const btn = (label, cmd, cls = '') => h('button', { class: 'mini ' + cls, title: `${S.commands[cmd]?.label || cmd}${keyOf(cmd) ? '  (' + keyOf(cmd) + ')' : ''}`,
      onclick: () => run(cmd) }, label);
    const menubar = h('div', { class: 'menubar' }, MENUS.map(m => h('button', { class: 'menu' + (S.menuOpen === m ? ' on' : ''),
      onclick: e => { e.stopPropagation(); S.menuOpen = S.menuOpen === m ? null : m; renderMenubar(v); },
      onmouseenter: () => { if (S.menuOpen && S.menuOpen !== m) { S.menuOpen = m; renderMenubar(v); } } }, m,
      S.menuOpen === m ? menuDrop(m) : null)));
    const items = [h('span', { class: 'crumb' }, `${v.lib}/${v.cell}`), v.readOnly ? h('span', { class: 'ro-tag' }, 'read-only') : null];
    if (S.history.length) items.push(btn('↑ Return', 'return'));
    items.push(h('span', { class: 'sep' }));
    for (const kind of ['schematic', 'symbol', 'verilog', 'netlist'])
      items.push(h('button', { class: 'mini ' + (v.kind === kind ? 'on' : ''), onclick: () => open(v.lib, v.cell, kind) }, kind));
    if (v.kind === 'schematic' && v.data.schematic) {
      items.push(h('span', { class: 'sep' }), btn('Inst', 'create_instance'), btn('Wire', 'create_wire', S.cmd?.id === 'wire' ? 'on' : ''),
        btn('Pin', 'create_pin'), btn('Label', 'create_wire_name'), btn('↶', 'undo'), btn('↷', 'redo'), btn('Fit', 'zoom_fit'),
        btn('Check&Save', 'check_and_save'), h('span', { class: 'sep' }), btn('Testbench…', 'testbench'), btn('▶ Simulate', 'simulate', 'primary'));
    }
    tb.replaceChildren(menubar, h('div', { class: 'toolrow' }, items.filter(Boolean)));
  }

  function menuDrop(menu) {
    const groups = {};
    for (const [id, c] of Object.entries(S.commands)) {
      if (c.menu.split('/')[0] !== menu || id === 'cancel') continue;
      (groups[c.menu.split('/')[1] || ''] ||= []).push([id, c]);
    }
    return h('div', { class: 'menu-drop', onclick: e => e.stopPropagation() }, Object.entries(groups).map(([sub, list]) => [
      sub ? h('div', { class: 'menu-sub' }, sub) : null,
      list.map(([id, c]) => h('button', { class: 'menu-item', onclick: () => { S.menuOpen = null; renderMenubar(view()); run(id); } },
        h('span', {}, c.label), h('span', { class: 'menu-key' }, keyOf(id))))]));
  }
  document.addEventListener('click', () => { if (S.menuOpen) { S.menuOpen = null; if (view()) renderMenubar(view()); } });

  // ------------------------------------------------------------ commands
  function needSel(what = 'objects') {
    if (S.sel.size || S.selNotes.size) return true;
    toast(`Select ${what} first (click, Shift+click, or drag a box), then run the command.`);
    return false;
  }
  const names = () => [...S.sel];
  const hierSel = () => {
    const sel = selected().filter(i => i.master.includes('/'));
    if (sel.length !== 1) { toast('Select one instance of a cell first.'); return null; }
    return sel[0].master.split('/');
  };
  const align = mode => needSel() && op('align', { names: names(), mode });

  const CMD = {
    new_cellview: newCell, open_cellview: openDialog, close_view: () => Apps.close(Apps.active),
    check_and_save: () => checkCell(true), export_svg: exportSvg,
    undo: () => op('undo'), redo: () => op('redo'),
    copy: () => needSel() && startMove('copy'), move: () => needSel() && startMove('move'), stretch: () => needSel() && startMove('stretch'),
    rotate: rotateSel, mirror: mirrorSel, delete: deleteSel, properties: propertiesDialog,
    select_all: () => { sch().instances.forEach(i => S.sel.add(i.name)); (sch().notes || []).forEach(n => S.selNotes.add(n.id)); render(); },
    deselect_all: () => { S.sel.clear(); S.selNotes.clear(); render(); }, search: searchDialog,
    align_left: () => align('left'), align_right: () => align('right'), align_top: () => align('top'),
    align_bottom: () => align('bottom'), align_hcenter: () => align('hcenter'), align_vcenter: () => align('vcenter'),
    descend_edit: () => { const lc = hierSel(); if (lc) open(lc[0], lc[1], 'schematic', true, false); },
    descend_read: () => { const lc = hierSel(); if (lc) open(lc[0], lc[1], 'schematic', true, true); },
    return: () => { const k = S.history.pop(); if (!k) return toast('Already at the top.'); goTo(k); },
    return_top: () => { if (!S.history.length) return toast('Already at the top.'); const k = S.history[0]; S.history = []; goTo(k); },
    print_tree: printTree,
    zoom_fit: fit, zoom_in: () => zoomBy(0.5), zoom_out: () => zoomBy(2), zoom_area: () => { S.cmd = { id: 'zoom_area' }; render(); },
    pan_left: () => pan(-0.25, 0), pan_right: () => pan(0.25, 0), pan_up: () => pan(0, -0.25), pan_down: () => pan(0, 0.25),
    redraw: render, toggle_labels: () => { S.display.labels = !S.display.labels; saveDisplay(); render(); },
    toggle_netnames: () => { S.display.netnames = !S.display.netnames; saveDisplay(); render(); },
    create_instance: instanceDialog, create_wire: () => { S.cmd = { id: 'wire' }; render(); }, create_wire_name: wireNameDialog,
    create_pin: pinDialog, create_note: noteDialog, wire_stubs: () => needSel('instances') && op('wire_stubs', { names: names() }),
    make_symbol: async () => { if (await op('make_symbol')) toast('Symbol generated from the pins.'); },
    check: () => checkCell(false), check_hierarchy: checkHierarchy,
    display_options: displayDialog, editor_options: editorDialog, bindkeys: bindkeyDialog,
    testbench: testbenchDialog, simulate: simulateDialog, netlist: () => { const v = view(); open(v.lib, v.cell, 'netlist'); },
    results: () => Probe.open(null),
    toggle_library: () => { S.display.library = !S.display.library; saveDisplay(); render(); },
    toggle_inspector: () => { S.display.inspector = !S.display.inspector; saveDisplay(); render(); },
    cancel: () => { S.cmd = null; S.sel.clear(); S.selNotes.clear(); S.menuOpen = null; render(); },
    command_options: commandOptions,
  };
  const SCHEMATIC_ONLY = new Set(Object.keys(CMD).filter(k => !['new_cellview', 'open_cellview', 'close_view', 'display_options',
    'editor_options', 'bindkeys', 'results', 'toggle_library', 'toggle_inspector', 'cancel', 'return', 'return_top', 'netlist'].includes(k)));

  async function run(id) {
    await opening;
    const v = view();
    if (!CMD[id]) return toast(`${id} is not available yet.`);
    if (SCHEMATIC_ONLY.has(id) && !(v?.kind === 'schematic' && v.data.schematic)) return toast('Open a schematic view first.');
    if (v?.readOnly && EDITS.has(id)) return toast('This view is read-only (Descend Read). Use Descend Edit (Shift+E) to change it.');
    return CMD[id]();
  }

  function goTo(key) { const [lc, kind] = key.split(':'); const [l, c] = lc.split('/'); open(l, c, kind); }

  function keyString(e) {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
    let key = e.key === ' ' ? 'Space' : e.key;
    const letter = key.length === 1 && /[a-z]/i.test(key);
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey && (letter || key.length > 1)) mods.push('Shift');     // "!" already carries its Shift
    if (letter) key = e.shiftKey ? key.toUpperCase() : key.toLowerCase();
    return [...mods, key].join('+');
  }

  function onKey(e) {
    if ($('#app-pane').hidden || $('#de').hidden || !view()) return;
    const t = e.target;
    if (!$('#modal').hidden || t.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.target.closest?.('#composer')) return;
    const id = S.keymap[keyString(e)];
    if (!id) return;
    e.preventDefault();
    run(id);
  }

  // ------------------------------------------------------------ schematic canvas
  function renderSchematic(v, body) {
    const data = v.data;
    if (!data.schematic) {
      body.replaceChildren(h('div', { class: 'empty' }, 'No schematic view yet. ', h('button', { onclick: async () => {
        await api('/api/cell/new', { lib: v.lib, cell: v.cell }); v.data = await fetchCell(v.lib, v.cell); render(); } }, 'Create schematic')));
      return;
    }
    if (!v.vb) { v.vb = { x: -100, y: -100, w: 800, h: 500 }; setTimeout(fit, 0); }
    const svg = s('svg', { viewBox: `${v.vb.x} ${v.vb.y} ${v.vb.w} ${v.vb.h}`, tabindex: 0 });
    const g = S.display.snap;
    svg.append(s('defs', {}, s('pattern', { id: 'dots', width: g, height: g, patternUnits: 'userSpaceOnUse' },
      s('circle', { cx: 0, cy: 0, r: 0.8, fill: 'var(--grid)' }))));
    svg.append(s('rect', { x: v.vb.x - 5000, y: v.vb.y - 5000, width: v.vb.w + 10000, height: v.vb.h + 10000,
      fill: S.display.grid ? 'url(#dots)' : 'transparent', class: 'bg' }));
    const placed = data.schematic.instances.filter(i => i.x !== null && i.y !== null);
    drawNets(svg, placed, data);
    for (const inst of placed) svg.append(drawInstance(inst, data));
    for (const nt of data.schematic.notes || []) svg.append(drawNote(nt));
    svg.append(s('g', { class: 'ghost', id: 'ghost' }));
    const wrap = h('div', { class: 'canvas-wrap' }, svg, h('div', { class: 'mode' }, statusLine()));
    body.replaceChildren(wrap, S.display.inspector ? inspector(v) : null);
    canvasEvents(svg, v);
  }

  function statusLine() {
    const c = S.cmd;
    if (!c) return 'select: click / Shift+click / drag a box · drag a terminal to wire · middle-drag pans · right-drag zooms · menus or bindkeys for commands';
    if (c.id === 'place') return c.queue?.length ? `placing pin ${c.queue[0]} (${c.queue.length} left): click to place, Esc to stop`
      : `placing ${c.master}: click to place, r rotates, Esc to stop`;
    if (c.id === 'label') return `wire name ${c.queue[0]} (${c.queue.length} left): click a terminal, Esc to stop`;
    if (c.id === 'note') return 'note: click where it goes';
    if (c.id === 'wire') return 'wire: drag from a terminal to another, Esc to stop';
    if (c.id === 'zoom_area') return 'zoom to area: drag a box';
    return `${c.id}: ${c.ref ? 'click the destination' : 'click a reference point'}, Esc to cancel`;
  }

  function drawInstance(inst, data) {
    const def = defOf(inst, data);
    const isPin = !!devs()[inst.master]?.pin;
    const g = s('g', { class: 'inst' + (S.sel.has(inst.name) ? ' sel' : '') + (isPin ? ' pin' : ''), 'data-inst': inst.name });
    const body = s('g', { class: 'sym', transform: `translate(${inst.x} ${inst.y}) rotate(${inst.rot || 0}) scale(${inst.mirror ? -1 : 1} 1)` });
    for (const d of def.draw) {
      if (d.t === 'line') body.append(s('polyline', { points: d.p.map(p => p.join(',')).join(' ') }));
      else if (d.t === 'poly') body.append(s('polygon', { class: 'fill', points: d.p.map(p => p.join(',')).join(' ') }));
      else if (d.t === 'circle') body.append(s('circle', { cx: d.c[0], cy: d.c[1], r: d.r }));
      else if (d.t === 'text') body.append(s('text', { x: d.p[0], y: d.p[1], 'font-size': d.cls === 'cellname' ? 11 : 9 }, d.s));
    }
    const [x0, y0, x1, y1] = bbox(inst, def);
    g.append(s('rect', { class: 'hit', x: x0 - 3, y: y0 - 3, width: x1 - x0 + 6, height: y1 - y0 + 6 }), body);
    if (isPin) g.append(s('text', { class: 'lbl name', x: inst.x + (inst.master === 'ipin' ? -16 : 16), y: inst.y - 9,
      'text-anchor': inst.master === 'ipin' ? 'end' : 'start' }, inst.name));
    else if (S.display.labels) g.append(s('text', { class: 'lbl name', x: x1 + 5, y: y0 + 10 }, inst.name),
      s('text', { class: 'lbl', x: x1 + 5, y: y0 + 22 }, paramText(inst) || ''));
    for (const t of def.terminals) {
      const [tx, ty] = xform(inst, [t.x, t.y]);
      const net = inst.conn?.[t.name];
      g.append(s('rect', { class: 'term', x: tx - 2.5, y: ty - 2.5, width: 5, height: 5, 'data-term': `${inst.name}.${t.name}` },
        s('title', {}, `${inst.name}.${t.name}${net ? ' = ' + net : ' (unconnected)'}`)));
    }
    return g;
  }

  function drawNote(nt) {
    return s('text', { class: 'note' + (S.selNotes.has(nt.id) ? ' sel' : ''), x: nt.x, y: nt.y, 'data-note': nt.id },
      String(nt.text).split('\n').map((line, k) => s('tspan', { x: nt.x, dy: k ? 13 : 0 }, line)));
  }

  function drawNets(svg, insts, data) {
    const nets = {}, pinPts = {};
    for (const inst of insts) {
      const def = defOf(inst, data);
      for (const t of def.terminals) {
        const net = inst.conn?.[t.name];
        if (!net) continue;
        (nets[net] ||= []).push(xform(inst, [t.x, t.y]));
        if (devs()[inst.master]?.pin) (pinPts[net] ||= new Set()).add(nets[net].length - 1);
      }
    }
    for (const [net, pts] of Object.entries(nets)) {
      if (GLOBAL_GND(net) || GLOBAL_SUP(net)) {          // a glyph at each device terminal; pins draw themselves
        pts.forEach((p, k) => { if (!pinPts[net]?.has(k)) svg.append(glyph(net, p)); });
        continue;
      }
      // Manhattan minimum spanning tree (Prim), each edge drawn as an L
      const inTree = [0], degree = new Array(pts.length).fill(0);
      while (inTree.length < pts.length) {
        let best = null;
        for (const i of inTree) for (let j = 0; j < pts.length; j++) {
          if (inTree.includes(j)) continue;
          const d = Math.abs(pts[i][0] - pts[j][0]) + Math.abs(pts[i][1] - pts[j][1]);
          if (!best || d < best.d) best = { i, j, d };
        }
        inTree.push(best.j);
        degree[best.i]++; degree[best.j]++;
        const [a, b] = [pts[best.i], pts[best.j]];
        svg.append(s('polyline', { class: 'wire', 'data-net': net, points: `${a[0]},${a[1]} ${b[0]},${a[1]} ${b[0]},${b[1]}` }));
      }
      pts.forEach((p, k) => { if (degree[k] >= 3) svg.append(s('circle', { class: 'dotj', cx: p[0], cy: p[1], r: 2.5 })); });
      if (pts.length === 1) svg.append(s('line', { class: 'wire', x1: pts[0][0], y1: pts[0][1], x2: pts[0][0] + 12, y2: pts[0][1] }));
      if (S.display.netnames && !/^n_/.test(net)) {
        const p = pts.reduce((a, b) => (a[1] < b[1] || (a[1] === b[1] && a[0] < b[0]) ? a : b));
        svg.append(s('text', { class: 'netlbl', x: p[0] + 4, y: p[1] - 4 }, net));
      }
    }
  }

  function glyph(net, [x, y]) {
    const g = s('g', {});
    if (GLOBAL_GND(net) || /^(vss|avss|dvss)/i.test(net)) {
      g.append(s('polyline', { class: 'glyph', points: `${x},${y} ${x},${y + 8}` }),
        s('polyline', { class: 'glyph', points: `${x - 8},${y + 8} ${x + 8},${y + 8}` }),
        s('polyline', { class: 'glyph', points: `${x - 5},${y + 11} ${x + 5},${y + 11}` }),
        s('polyline', { class: 'glyph', points: `${x - 2},${y + 14} ${x + 2},${y + 14}` }));
      if (!GLOBAL_GND(net)) g.append(s('text', { class: 'glyph-t', x: x + 10, y: y + 12 }, net));
    } else {
      g.append(s('polyline', { class: 'glyph', points: `${x},${y} ${x},${y - 8}` }),
        s('polyline', { class: 'glyph', points: `${x - 7},${y - 8} ${x + 7},${y - 8}` }),
        s('text', { class: 'glyph-t', x: x, y: y - 11, 'text-anchor': 'middle' }, net));
    }
    return g;
  }

  // ------------------------------------------------------------ canvas interaction
  function setVb(svg, v) { svg.setAttribute('viewBox', `${v.vb.x} ${v.vb.y} ${v.vb.w} ${v.vb.h}`); }

  function ghostSelection(svg, dx, dy) {
    const ghost = svg.querySelector('#ghost');
    ghost.replaceChildren(...[...S.sel].map(n => svg.querySelector(`[data-inst="${CSS.escape(n)}"]`)?.cloneNode(true)).filter(Boolean),
      ...[...S.selNotes].map(id => svg.querySelector(`[data-note="${id}"]`)?.cloneNode(true)).filter(Boolean));
    ghost.setAttribute('transform', `translate(${dx} ${dy})`);
  }

  function canvasEvents(svg, v) {
    const ghost = svg.querySelector('#ghost');
    svg.addEventListener('contextmenu', e => e.preventDefault());
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const p = svgPoint(svg, e), k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      v.vb = { x: p.x - (p.x - v.vb.x) * k, y: p.y - (p.y - v.vb.y) * k, w: v.vb.w * k, h: v.vb.h * k };
      setVb(svg, v);
    }, { passive: false });

    svg.addEventListener('mousemove', e => {
      const p = svgPoint(svg, e);
      const c = S.cmd;
      if (c?.id === 'place') {
        const master = c.master;
        const def = master.includes('/') ? v.data.symbols?.[master] || c.symbol : devs()[master];
        if (def) ghost.replaceChildren(drawInstance({ name: c.queue?.[0] || '', master, x: snap(p.x), y: snap(p.y), rot: c.rot || 0,
          mirror: c.mirror, params: c.params || {}, conn: {} }, { symbols: { [master]: def } }));
        return;
      }
      if (c && ['move', 'stretch', 'copy'].includes(c.id) && c.ref) { ghostSelection(svg, snap(p.x - c.ref.x), snap(p.y - c.ref.y)); return; }
      const d = S.drag;
      if (!d) return;
      if (d.kind === 'pan') {
        const k = v.vb.w / svg.clientWidth;
        v.vb.x = d.vb.x - (e.clientX - d.cx) * k;
        v.vb.y = d.vb.y - (e.clientY - d.cy) * k;
        setVb(svg, v);
      } else if (d.kind === 'drag') {
        d.dx = snap(p.x - d.x0); d.dy = snap(p.y - d.y0);
        d.moved = d.moved || Math.abs(d.dx) + Math.abs(d.dy) > 0;
        if (d.moved) ghostSelection(svg, d.dx, d.dy);
      } else if (d.kind === 'wire') {
        d.line.setAttribute('x2', p.x); d.line.setAttribute('y2', p.y);
      } else if (d.kind === 'box' || d.kind === 'zoombox') {
        d.x1 = p.x; d.y1 = p.y;
        d.rect.setAttribute('x', Math.min(d.x0, d.x1)); d.rect.setAttribute('y', Math.min(d.y0, d.y1));
        d.rect.setAttribute('width', Math.abs(d.x1 - d.x0)); d.rect.setAttribute('height', Math.abs(d.y1 - d.y0));
      }
    });

    svg.addEventListener('mousedown', async e => {
      svg.focus();
      const p = svgPoint(svg, e);
      const c = S.cmd;
      if (e.button === 1) { e.preventDefault(); S.drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, vb: { ...v.vb } }; return; }
      if (e.button === 2 || c?.id === 'zoom_area') {
        const rect = s('rect', { class: 'zoombox', x: p.x, y: p.y, width: 0, height: 0 });
        svg.append(rect);
        S.drag = { kind: 'zoombox', x0: p.x, y0: p.y, x1: p.x, y1: p.y, rect };
        return;
      }
      if (e.button !== 0) return;
      if (c?.id === 'place') { await placeAt(v, snap(p.x), snap(p.y)); return; }
      if (c?.id === 'note') { S.cmd = null; await op('add_note', { x: snap(p.x), y: snap(p.y), text: c.text }); return; }
      if (c && ['move', 'stretch', 'copy'].includes(c.id)) {
        if (!c.ref) { c.ref = { x: snap(p.x), y: snap(p.y) }; render(); return; }
        const dx = snap(p.x) - c.ref.x, dy = snap(p.y) - c.ref.y;
        S.cmd = null;
        if (c.id === 'copy') await op('copy', { names: names(), dx, dy });
        else await op('move_many', { names: names(), notes: [...S.selNotes], dx, dy });
        return;
      }
      const term = e.target.closest('[data-term]');
      if (c?.id === 'label') {
        if (term) await nameTerminal(term.dataset.term);
        return;
      }
      if (term) {
        const [x, y] = [+term.getAttribute('x') + 2.5, +term.getAttribute('y') + 2.5];
        const line = s('line', { class: 'rubber', x1: x, y1: y, x2: x, y2: y });
        svg.append(line);
        S.drag = { kind: 'wire', from: term.dataset.term, line };
        return;
      }
      const g = e.target.closest('[data-inst]'), noteEl = e.target.closest('[data-note]');
      if (g || noteEl) {
        const toggle = (set, k) => (e.shiftKey ? (set.has(k) ? set.delete(k) : set.add(k)) : (!set.has(k) && (S.sel.clear(), S.selNotes.clear(), set.add(k))));
        if (g) toggle(S.sel, g.dataset.inst); else toggle(S.selNotes, +noteEl.dataset.note);
        svg.querySelectorAll('.inst').forEach(el => el.classList.toggle('sel', S.sel.has(el.dataset.inst)));
        svg.querySelectorAll('.note').forEach(el => el.classList.toggle('sel', S.selNotes.has(+el.dataset.note)));
        if (!v.readOnly) S.drag = { kind: 'drag', x0: p.x, y0: p.y, dx: 0, dy: 0 };
        return;
      }
      const rect = s('rect', { class: 'selbox', x: p.x, y: p.y, width: 0, height: 0 });
      svg.append(rect);
      S.drag = { kind: 'box', x0: p.x, y0: p.y, x1: p.x, y1: p.y, rect, add: e.shiftKey };
    });

    window.onmouseup = async e => {
      const d = S.drag;
      S.drag = null;
      if (!d) return;
      if (d.kind === 'drag') {
        if (!d.moved) { render(); return; }
        await op('move_many', { names: names(), notes: [...S.selNotes], dx: d.dx, dy: d.dy });
      } else if (d.kind === 'wire') {
        d.line.remove();
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-term]');
        if (target && target.dataset.term !== d.from && !v.readOnly) await op('connect', { a: d.from, b: target.dataset.term });
      } else if (d.kind === 'box') {
        d.rect.remove();
        const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)], [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
        if (!d.add) { S.sel.clear(); S.selNotes.clear(); }
        if (x1 - x0 > 2 || y1 - y0 > 2) {
          for (const inst of sch().instances.filter(i => i.x !== null)) {
            const [a, b, c2, d2] = bbox(inst, defOf(inst, v.data));
            if (a >= x0 && c2 <= x1 && b >= y0 && d2 <= y1) S.sel.add(inst.name);
          }
          for (const nt of sch().notes || []) if (nt.x >= x0 && nt.x <= x1 && nt.y >= y0 && nt.y <= y1) S.selNotes.add(nt.id);
        }
        render();
      } else if (d.kind === 'zoombox') {
        d.rect.remove();
        if (S.cmd?.id === 'zoom_area') S.cmd = null;
        const w = Math.abs(d.x1 - d.x0), hh = Math.abs(d.y1 - d.y0);
        if (w > 5 && hh > 5) {
          const aspect = svg.clientWidth / svg.clientHeight;
          let W = w, H = hh;
          if (W / H < aspect) W = H * aspect; else H = W / aspect;
          v.vb = { x: (d.x0 + d.x1) / 2 - W / 2, y: (d.y0 + d.y1) / 2 - H / 2, w: W, h: H };
        }
        render();
      }
    };

    svg.addEventListener('dblclick', async e => {
      const noteEl = e.target.closest('[data-note]');
      if (noteEl && !v.readOnly) {
        const nt = sch().notes.find(n => n.id === +noteEl.dataset.note);
        const ta = h('textarea', { rows: 4 }, nt.text);
        if (await modal('Edit note', [ta], 'Save')) await op('edit_note', { id: nt.id, text: ta.value });
        return;
      }
      const g = e.target.closest('[data-inst]');
      if (!g) return;
      const inst = sch().instances.find(i => i.name === g.dataset.inst);
      if (inst?.master.includes('/')) { const [l, c] = inst.master.split('/'); open(l, c, 'schematic', true, v.readOnly); }
      else if (inst) { S.sel = new Set([inst.name]); propertiesDialog(); }
    });
  }

  async function placeAt(v, x, y) {
    const c = S.cmd;
    const name = c.queue?.length ? c.queue.shift() : c.name || null;
    const ok = await op('add', { master: c.master, name, params: c.params, x, y, rot: c.rot || 0, mirror: !!c.mirror });
    if (!ok && c.queue && name) c.queue.unshift(name);
    if (c.queue && !c.queue.length) { S.cmd = null; render(); }
    if (c.name) c.name = null;                // a fixed name is used once; later placements auto-name
  }

  async function nameTerminal(ref) {
    const c = S.cmd;
    const [n, t] = ref.split('.');
    const inst = sch().instances.find(i => i.name === n);
    const net = c.queue.shift();
    const old = inst?.conn?.[t];
    const ok = old ? await op('rename_net', { old, new: net }) : await op('set_conn', { name: n, term: t, net });
    if (!ok) c.queue.unshift(net);
    if (!c.queue.length) S.cmd = null;
    render();
  }

  function startMove(id) { S.cmd = { id, ref: null }; render(); }

  function selected() { return [...S.sel].map(n => sch()?.instances.find(i => i.name === n)).filter(Boolean); }
  async function rotateSel() {
    if (S.cmd?.id === 'place') { S.cmd.rot = ((S.cmd.rot || 0) + 90) % 360; return; }
    if (!needSel('instances')) return;
    for (const i of selected()) await api('/api/cell/op', { lib: view().lib, cell: view().cell, op: 'move', args: { name: i.name, rot: ((i.rot || 0) + 90) % 360 } }).catch(e => toast(e.message));
    await changed(view().lib, view().cell);
  }
  async function mirrorSel() {
    if (S.cmd?.id === 'place') { S.cmd.mirror = !S.cmd.mirror; return; }
    if (!needSel('instances')) return;
    for (const i of selected()) await api('/api/cell/op', { lib: view().lib, cell: view().cell, op: 'move', args: { name: i.name, mirror: !i.mirror } }).catch(e => toast(e.message));
    await changed(view().lib, view().cell);
  }
  async function deleteSel() {
    if (!needSel()) return;
    if (S.sel.size) await op('remove', { names: [...S.sel] });
    for (const id of S.selNotes) await op('remove_note', { id });
    S.sel.clear(); S.selNotes.clear(); render();
  }

  function zoomBy(k) {
    const v = view();
    if (!v.vb) return;
    const cx = v.vb.x + v.vb.w / 2, cy = v.vb.y + v.vb.h / 2;
    v.vb = { x: cx - v.vb.w * k / 2, y: cy - v.vb.h * k / 2, w: v.vb.w * k, h: v.vb.h * k };
    render();
  }
  function pan(fx, fy) { const v = view(); v.vb.x += v.vb.w * fx; v.vb.y += v.vb.h * fy; render(); }

  function fit() {
    const v = view();
    if (!v || v.kind !== 'schematic' || !v.data.schematic) return;
    const insts = v.data.schematic.instances.filter(i => i.x !== null);
    const notes = v.data.schematic.notes || [];
    if (!insts.length && !notes.length) { v.vb = { x: -100, y: -100, w: 800, h: 500 }; render(); return; }
    const boxes = insts.map(i => bbox(i, defOf(i, v.data))).concat(notes.map(n => [n.x, n.y - 12, n.x + 8 * Math.min(40, n.text.length), n.y + 4]));
    const x0 = Math.min(...boxes.map(b => b[0])) - 60, y0 = Math.min(...boxes.map(b => b[1])) - 50;
    const x1 = Math.max(...boxes.map(b => b[2])) + 90, y1 = Math.max(...boxes.map(b => b[3])) + 50;
    const wrap = $('#de-body .canvas-wrap') || { clientWidth: 800, clientHeight: 500 };
    const aspect = (wrap.clientWidth || 800) / (wrap.clientHeight || 500);
    let w = x1 - x0, hgt = y1 - y0;
    if (w / hgt < aspect) w = hgt * aspect; else hgt = w / aspect;
    v.vb = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - hgt / 2, w, h: hgt };
    render();
  }

  // ------------------------------------------------------------ forms (Create, Edit)
  function paramInputs(master, values = {}) {
    const d = devs()[master];
    return Object.keys(d?.params || {}).map(k => [k, h('input', { type: 'text', value: values[k] ?? d.params[k] ?? '',
      placeholder: k === 'l' ? 'PDK minimum' : '', title: d.units?.[k] || '' })]);
  }

  async function instanceDialog() {
    const v = view();
    const libs = ['basic', ...S.libs.map(l => l.name)];
    const lib = h('select', {}, libs.map(l => h('option', { value: l, selected: l === (S.lastLib || 'basic') }, l)));
    const filter = h('input', { type: 'text', placeholder: 'filter' });
    const list = h('div', { class: 'pick-list' });
    const paramBox = h('div', { class: 'param-box' });
    const nameIn = h('input', { type: 'text', placeholder: 'auto' });
    let choice = S.lastMaster || null, params = [];
    const cellsOf = l => l === 'basic' ? Object.keys(devs()).filter(k => !devs()[k].pin)
      : (S.libs.find(x => x.name === l)?.cells || []).filter(c => c.views.includes('schematic') && !(l === v.lib && c.name === v.cell)).map(c => `${l}/${c.name}`);
    const drawParams = () => {
      params = choice && !choice.includes('/') ? paramInputs(choice) : [];
      paramBox.replaceChildren(...params.map(([k, i]) => h('label', { class: 'kv' }, k, i)));
    };
    const draw = () => {
      list.replaceChildren(...cellsOf(lib.value).filter(c => c.includes(filter.value.trim())).map(c => h('button', {
        class: 'pick' + (choice === c ? ' on' : ''), onclick: () => { choice = c; draw(); drawParams(); }, ondblclick: () => $('#modal .primary').click() },
        c, !c.includes('/') ? h('span', { class: 'muted small' }, ' ' + devs()[c].label) : null)));
    };
    lib.addEventListener('change', () => { choice = null; draw(); drawParams(); });
    filter.addEventListener('input', draw);
    draw(); drawParams();
    if (!await modal('Create Instance', [h('div', { class: 'row' }, 'Library', lib, filter), list, paramBox,
      h('div', { class: 'row' }, 'Name', nameIn, h('span', { class: 'muted small' }, 'click to place, repeat until Esc'))], 'Place') || !choice) return;
    S.lastLib = lib.value; S.lastMaster = choice;
    let symbol = null;
    if (choice.includes('/')) {
      try { const [l, c] = choice.split('/'); symbol = (await fetchCell(l, c)).symbol; } catch { /* generated on place */ }
    }
    S.cmd = { id: 'place', master: choice, params: Object.fromEntries(params.map(([k, i]) => [k, i.value]).filter(([, x]) => x !== '')),
      name: nameIn.value.trim() || null, symbol };
    render();
  }

  async function pinDialog() {
    const namesIn = h('input', { type: 'text', placeholder: 'vin vip out  (several, space-separated)' });
    const dir = h('select', {}, ['input', 'output', 'inout'].map(d => h('option', { value: d }, d)));
    if (!await modal('Create Pin', [h('div', { class: 'row' }, 'Names', namesIn), h('div', { class: 'row' }, 'Direction', dir)], 'Place')) return;
    const queue = namesIn.value.split(/[\s,]+/).filter(Boolean);
    if (!queue.length) return;
    S.cmd = { id: 'place', master: { input: 'ipin', output: 'opin', inout: 'iopin' }[dir.value], queue };
    render();
  }

  async function wireNameDialog() {
    const namesIn = h('input', { type: 'text', placeholder: 'out tail bias  (several, space-separated)' });
    if (!await modal('Create Wire Name', [h('div', { class: 'row' }, 'Names', namesIn),
      h('p', { class: 'muted small' }, 'Then click terminals in order: a connected terminal renames its whole net; an open one joins the named net.')], 'Start')) return;
    const queue = namesIn.value.split(/[\s,]+/).filter(Boolean);
    if (queue.length) { S.cmd = { id: 'label', queue }; render(); }
  }

  async function noteDialog() {
    const ta = h('textarea', { rows: 4, placeholder: 'Note text' });
    if (!await modal('Create Note', [ta], 'Place') || !ta.value.trim()) return;
    S.cmd = { id: 'note', text: ta.value.trim() };
    render();
  }

  async function propertiesDialog() {
    const v = view();
    const sel = selected();
    if (!sel.length) return needSel('an instance');
    if (sel.length > 1) {                       // common parameters of a group (Property Editor style)
      const master = sel[0].master;
      if (!sel.every(i => i.master === master)) return toast('Select instances of one kind to edit them together, or one instance.');
      const params = paramInputs(master, {});
      params.forEach(([, i]) => { i.value = ''; i.placeholder = 'unchanged'; });
      if (!await modal(`Properties: ${sel.length} × ${master}`, params.map(([k, i]) => h('label', { class: 'kv' }, k, i)), 'Apply')) return;
      const change = Object.fromEntries(params.filter(([, i]) => i.value !== '').map(([k, i]) => [k, i.value]));
      for (const inst of sel) if (Object.keys(change).length)
        await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: 'set_params', args: { name: inst.name, params: change } }).catch(e => toast(e.message));
      return changed(v.lib, v.cell);
    }
    const inst = sel[0], def = defOf(inst, v.data);
    const name = h('input', { type: 'text', value: inst.name });
    const params = paramInputs(inst.master, inst.params);
    const conns = def.terminals.map(t => [t.name, h('input', { type: 'text', value: inst.conn?.[t.name] ?? '', placeholder: 'net' })]);
    const body = [h('label', { class: 'kv' }, 'name', name), params.length ? h('h4', {}, 'parameters') : null,
      ...params.map(([k, i]) => h('label', { class: 'kv' }, k, i)), h('h4', {}, 'terminals'), ...conns.map(([k, i]) => h('label', { class: 'kv' }, k, i))];
    if (v.readOnly) { [name, ...params.map(x => x[1]), ...conns.map(x => x[1])].forEach(i => (i.disabled = true)); }
    if (!await modal(`Properties: ${inst.name} (${inst.master})`, body.filter(Boolean), v.readOnly ? null : 'Apply', 'Close') || v.readOnly) return;
    await applyProps(v, inst, name, params, conns);
  }

  async function applyProps(v, inst, name, params, conns) {
    const newParams = Object.fromEntries(params.filter(([k, i]) => i.value !== String(inst.params?.[k] ?? '')).map(([k, i]) => [k, i.value]));
    if (Object.keys(newParams).length) await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: 'set_params', args: { name: inst.name, params: newParams } }).catch(e => toast(e.message));
    for (const [t, i] of conns) if (i.value !== (inst.conn?.[t] ?? ''))
      await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: 'set_conn', args: { name: inst.name, term: t, net: i.value.trim() } }).catch(e => toast(e.message));
    if (name.value.trim() && name.value.trim() !== inst.name) {
      await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: 'rename', args: { name: inst.name, new: name.value.trim() } }).catch(e => toast(e.message));
      S.sel = new Set([name.value.trim()]);
    }
    await changed(v.lib, v.cell);
  }

  async function searchDialog() {
    const q = h('input', { type: 'text', placeholder: 'instance, cell or net name (e.g. M1, nmos, out)' });
    if (!await modal('Search', [q], 'Find') || !q.value.trim()) return;
    const term = q.value.trim().toLowerCase();
    const hits = sch().instances.filter(i => i.name.toLowerCase().includes(term) || i.master.toLowerCase().includes(term) ||
      Object.values(i.conn).some(n => n.toLowerCase() === term));
    S.sel = new Set(hits.map(i => i.name));
    toast(hits.length ? `${hits.length} found and selected` : 'Nothing found');
    render();
  }

  async function commandOptions() {
    const c = S.cmd;
    if (c?.id !== 'place') return toast('This command has no options. (F3 works while placing an instance or pin.)');
    const rot = h('select', {}, [0, 90, 180, 270].map(r => h('option', { value: r, selected: r === (c.rot || 0) }, `R${r}`)));
    const mir = h('input', { type: 'checkbox', checked: !!c.mirror });
    if (!await modal(`Options: placing ${c.master}`, [h('div', { class: 'row' }, 'Rotation', rot), h('label', { class: 'row' }, mir, 'Mirror (sideways)')], 'OK')) return;
    c.rot = +rot.value; c.mirror = mir.checked;
  }

  // ------------------------------------------------------------ check, hierarchy, export
  async function checkCell(andSave) {
    const v = view();
    v.data = await fetchCell(v.lib, v.cell);
    render();
    const issues = v.data.issues || [];
    const head = andSave ? 'Check and Save' : 'Check';
    if (!issues.length) return toast(`${head}: no errors or warnings${andSave ? ' (saved)' : ''}.`);
    await modal(`${head}: ${issues.length} warning${issues.length > 1 ? 's' : ''}`, [h('ul', { class: 'issue-list' }, issues.map(i => h('li', {}, i))),
      andSave ? h('p', { class: 'muted small' }, 'The cellview is saved; fix these before simulating.') : null].filter(Boolean), null, 'Close');
  }

  async function checkHierarchy() {
    const v = view();
    const res = await api(`/api/check_hierarchy?lib=${encodeURIComponent(v.lib)}&cell=${encodeURIComponent(v.cell)}`);
    const rows = Object.entries(res);
    const bad = rows.filter(([, i]) => i.length);
    await modal(`Check Hierarchy: ${rows.length} cell${rows.length > 1 ? 's' : ''}, ${bad.length} with warnings`,
      [h('div', { class: 'issue-list' }, rows.map(([c, i]) => h('div', {}, h('strong', {}, c), i.length ? h('ul', {}, i.map(x => h('li', {}, x))) : h('span', { class: 'muted' }, ' clean'))))], null, 'Close');
  }

  async function printTree() {
    const v = view();
    const t = await api(`/api/tree?lib=${encodeURIComponent(v.lib)}&cell=${encodeURIComponent(v.cell)}`);
    const node = (n, label) => h('li', {}, h('span', { class: 'mono' }, label),
      n.devices && Object.keys(n.devices).length ? h('span', { class: 'muted small' }, '  ' + Object.entries(n.devices).map(([k, c]) => `${c}×${k}`).join(' ')) : null,
      n.children?.length ? h('ul', {}, n.children.map(ch => node(ch, `${ch.name}  ${ch.cell}${ch.recursive ? ' (recursive)' : ''}`))) : null);
    await modal('Hierarchy Tree', [h('ul', { class: 'tree-list' }, node(t, t.cell))], null, 'Close');
  }

  function exportSvg() {
    const svg = $('#de-body svg');
    if (!svg) return;
    const clone = svg.cloneNode(true);
    clone.querySelector('.bg')?.remove();
    clone.querySelector('#ghost')?.remove();
    const css = getComputedStyle(document.documentElement);
    const color = n => css.getPropertyValue(n).trim();
    clone.insertBefore(h('svg:style', {}, `.sym{stroke:${color('--dev')};fill:none;stroke-width:1.6}.sym .fill,.sym text{fill:${color('--dev')};stroke:none}
.wire{stroke:${color('--wire')};fill:none;stroke-width:1.6}.dotj{fill:${color('--wire')}}.glyph{stroke:${color('--glyph')};fill:none}
.glyph-t{fill:${color('--glyph')};font:10px monospace}.lbl,.note{fill:${color('--label')};font:10.5px monospace}.netlbl{fill:${color('--wire')};font:10px monospace}
.term,.hit{display:none}.inst.pin .sym{stroke:${color('--pin')}}`), clone.firstChild);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('style', `background:${color('--canvas')}`);
    const a = h('a', { href: URL.createObjectURL(new Blob([clone.outerHTML], { type: 'image/svg+xml' })), download: `${view().cell}.svg` });
    document.body.append(a); a.click(); a.remove();
  }

  // ------------------------------------------------------------ options
  async function displayDialog() {
    const grid = h('input', { type: 'checkbox', checked: S.display.grid });
    const labels = h('input', { type: 'checkbox', checked: S.display.labels });
    const netnames = h('input', { type: 'checkbox', checked: S.display.netnames });
    const snapSel = h('select', {}, [5, 10, 20, 50].map(g => h('option', { value: g, selected: g === S.display.snap }, `${g}`)));
    if (!await modal('Display Options', [h('label', { class: 'row' }, grid, 'Grid dots'), h('label', { class: 'row' }, labels, 'Instance labels (name, W/L, value)'),
      h('label', { class: 'row' }, netnames, 'Net names'), h('div', { class: 'row' }, 'Snap spacing', snapSel)], 'OK')) return;
    Object.assign(S.display, { grid: grid.checked, labels: labels.checked, netnames: netnames.checked, snap: +snapSel.value });
    saveDisplay(); render();
  }

  async function editorDialog() {
    const autofit = h('input', { type: 'checkbox', checked: S.editor.autofit });
    if (!await modal('Editor Options', [h('label', { class: 'row' }, autofit, 'Zoom to fit when a team adds or removes devices')], 'OK')) return;
    S.editor.autofit = autofit.checked;
    saveDisplay();
  }

  async function bindkeyDialog() {
    let keymap = { ...S.keymap };
    const table = h('div', { class: 'bk-table' });
    const draw = () => {
      const byCmd = {};
      for (const [k, c] of Object.entries(keymap)) (byCmd[c] ||= []).push(k);
      table.replaceChildren(...Object.entries(S.commands).map(([id, c]) => {
        const keys = byCmd[id] || [];
        const set = h('button', { class: 'mini', onclick: () => {
          set.textContent = 'press a key…';
          const grab = e => {
            const k = keyString(e);
            if (!k) return;
            e.preventDefault(); e.stopPropagation();
            document.removeEventListener('keydown', grab, true);
            if (k !== 'Escape') { if (keymap[k] && keymap[k] !== id) toast(`${k} moved from ${S.commands[keymap[k]]?.label}`); keymap[k] = id; }
            draw();
          };
          document.addEventListener('keydown', grab, true);
        } }, 'set');
        return h('div', { class: 'bk-row' }, h('span', { class: 'muted small' }, c.menu), h('span', {}, c.label),
          h('span', { class: 'bk-keys' }, keys.map(k => h('span', { class: 'kbd' }, k, h('button', { class: 'x', title: 'Unbind', onclick: () => { delete keymap[k]; draw(); } }, '✕')))), set);
      }));
    };
    draw();
    const imp = h('textarea', { rows: 4, placeholder: 'Paste hiSetBindKey(...) / hiSetBindKeys(...) lines from your .cdsinit; "Schematics" bindings are imported' });
    const reset = h('button', { class: 'mini', onclick: () => { keymap = { ...S.defaults }; draw(); } }, 'Reset to Virtuoso defaults');
    const doImport = h('button', { class: 'mini', onclick: async () => {
      try {
        const r = await api('/api/bindkeys/import', { text: imp.value });
        S.keymap = r.keymap; keymap = { ...r.keymap }; draw();
        toast(`Imported ${Object.keys(r.imported).length} bindkeys` + (r.unmapped.length ? `; ${r.unmapped.length} had no Primate DE command` : ''), 6000);
        if (r.unmapped.length) imp.value = 'Not mapped:\n' + r.unmapped.join('\n');
      } catch (err) { toast(err.message, 6000); }
    } }, 'Import from .cdsinit');
    if (!await modal('Bindkeys (Schematics)', [table, h('div', { class: 'row' }, reset), imp, h('div', { class: 'row' }, doImport)], 'Save')) return;
    const overrides = {};
    for (const [k, c] of Object.entries(keymap)) if (S.defaults[k] !== c) overrides[k] = c;
    for (const k of Object.keys(S.defaults)) if (!(k in keymap)) overrides[k] = null;
    try { const r = await api('/api/bindkeys', { keymap: overrides }); S.keymap = r.keymap; toast('Bindkeys saved'); render(); }
    catch (err) { toast(err.message, 6000); }
  }

  // ------------------------------------------------------------ inspector (Property Assistant)
  function inspector(v) {
    const box = h('aside', { class: 'inspector' });
    const data = v.data.schematic;
    const sel = selected();
    if (sel.length === 1 && !v.readOnly) {
      const inst = sel[0];
      const def = defOf(inst, v.data);
      const name = h('input', { type: 'text', value: inst.name });
      const params = paramInputs(inst.master, inst.params);
      const conns = def.terminals.map(t => [t.name, h('input', { type: 'text', value: inst.conn?.[t.name] ?? '', placeholder: 'net' })]);
      const apply = () => applyProps(v, inst, name, params, conns);
      append(box, h('h4', {}, inst.master), h('label', {}, 'name', name),
        params.length ? h('h4', {}, 'parameters') : null, ...params.map(([k, i]) => h('label', {}, k, i)),
        h('h4', {}, 'terminals'), ...conns.map(([k, i]) => h('label', {}, k, i)),
        h('div', { class: 'row' }, h('button', { class: 'primary mini', onclick: apply }, 'Apply'),
          inst.master.includes('/') ? h('button', { class: 'mini', onclick: () => run('descend_edit') }, 'Descend') : null));
      box.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
      return box;
    }
    const prims = Object.entries(devs());
    const keys = ['create_instance', 'create_wire', 'create_pin', 'create_wire_name', 'properties', 'stretch', 'copy', 'undo', 'redo',
      'rotate', 'mirror', 'delete', 'zoom_fit', 'zoom_in', 'zoom_out', 'descend_edit', 'return', 'check_and_save', 'display_options',
      'command_options'].filter(keyOf);
    append(box, v.readOnly ? null : [h('h4', {}, 'place'), h('div', { class: 'palette' }, prims.map(([k, d]) => h('button', { title: d.label,
      class: S.cmd?.master === k ? 'on' : '', onclick: () => {
        if (d.pin) return run('create_pin');
        S.cmd = { id: 'place', master: k, params: Object.fromEntries(Object.entries(d.params).filter(([, x]) => x !== null && x !== '')) }; render();
      } }, k)))],
      h('h4', {}, `${v.lib}/${v.cell}`), h('div', { class: 'small muted' }, `PDK ${v.data.pdk} · ${data.instances.length} instances` + (sel.length > 1 ? ` · ${sel.length} selected` : '')),
      data.sim ? h('div', { class: 'small' }, 'testbench: ' + (data.sim.analyses || []).map(a => a.type).join(', ') +
        (data.sim.pdk ? ` · ${data.sim.pdk}` : '') + (data.sim.corner ? ` ${data.sim.corner}` : '')) : null,
      h('h4', {}, 'check'), v.data.issues?.length ? h('div', { class: 'issues' }, v.data.issues.map(i => h('div', {}, '• ' + i))) : h('div', { class: 'small muted' }, 'no issues'),
      h('h4', {}, 'bindkeys'), h('div', { class: 'keys' }, keys.map(id => h('div', {}, h('span', { class: 'kbd' }, keyOf(id)), ' ', S.commands[id]?.label))),
      h('button', { class: 'link', onclick: () => run('bindkeys') }, 'Options › Bindkeys…'));
    return box;
  }

  // ------------------------------------------------------------ other views
  function renderSymbol(v, body) {
    const sym = v.data.symbol;
    const wrap = h('div', { class: 'canvas-wrap' });
    if (!sym) wrap.append(h('div', { class: 'empty' }, 'No symbol yet.'));
    else {
      const svg = s('svg', { viewBox: '-150 -110 300 220' });
      const inst = { name: v.cell, master: `${v.lib}/${v.cell}`, x: 0, y: 0, rot: 0, params: {}, conn: {} };
      svg.append(drawInstance(inst, { symbols: { [inst.master]: sym } }));
      wrap.append(svg);
    }
    body.replaceChildren(wrap, h('aside', { class: 'inspector' }, h('h4', {}, 'symbol'),
      h('div', { class: 'small muted' }, 'Generated from the schematic pins: inputs left, outputs right, supplies top and bottom.'),
      h('button', { class: 'primary', onclick: async () => { await op('make_symbol'); v.data = await fetchCell(v.lib, v.cell); render(); } }, 'Regenerate from pins'),
      sym ? h('div', { class: 'small' }, sym.pins.map(p => h('div', {}, `${p.name} (${p.dir})`))) : null));
  }

  function renderVerilog(v, body) {
    const ta = h('textarea', { spellcheck: 'false' }, v.data.verilog ?? `module ${v.cell} ();\nendmodule\n`);
    const log = h('pre', { class: 'code-log' }, v.log || 'Save, then Run to compile and simulate with Icarus Verilog.');
    const save = async () => { await api('/api/verilog', { lib: v.lib, cell: v.cell, code: ta.value }); v.data = await fetchCell(v.lib, v.cell); toast('Saved'); };
    const runIcarus = async () => {
      await save();
      log.textContent = 'Running Icarus Verilog…';
      try {
        const { job } = await api('/api/verilog/run', { lib: v.lib, cell: v.cell });
        const r = await waitJob(job);
        v.log = (r.ok ? 'PASS (exit 0)\n' : `FAILED at ${r.stage}\n`) + r.log;
        log.textContent = v.log;
      } catch (err) { log.textContent = err.message; }
    };
    ta.addEventListener('keydown', e => { if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });
    body.replaceChildren(h('div', { class: 'code-edit' }, h('div', { class: 'de-toolbar' },
      h('button', { class: 'mini', onclick: save }, 'Save (Ctrl+S)'), h('button', { class: 'mini primary', onclick: runIcarus }, '▶ Run Icarus')), ta, log));
  }

  async function renderNetlist(v, body) {
    body.replaceChildren(h('div', { class: 'empty' }, 'Netlisting…'));
    try {
      const pdk = v.netPdk || v.data.pdk;
      const nl = await api(`/api/netlist?lib=${encodeURIComponent(v.lib)}&cell=${encodeURIComponent(v.cell)}&pdk=${pdk}`);
      const pick = h('select', {}, P.state.pdks.filter(p => p.installed).map(p => h('option', { value: p.id, selected: p.id === nl.pdk }, p.id)));
      pick.addEventListener('change', () => { v.netPdk = pick.value; render(); });
      body.replaceChildren(h('div', { class: 'code-edit' }, h('div', { class: 'de-toolbar' }, 'PDK ', pick,
        h('span', { class: 'muted small' }, ` cells: ${nl.cells.join(', ')}`)), h('textarea', { readonly: true, spellcheck: 'false' }, nl.text)));
    } catch (err) { body.replaceChildren(h('div', { class: 'empty error' }, err.message)); }
  }

  // ------------------------------------------------------------ testbench + simulate
  const FIELDS = { op: [], tran: ['step', 'stop', 'start'], ac: ['sweep', 'points', 'fstart', 'fstop'], dc: ['source', 'start', 'stop', 'step'] };
  const DEFAULTS = { tran: { step: '1p', stop: '10n' }, ac: { sweep: 'dec', points: 20, fstart: '1', fstop: '10g' }, dc: { start: '0', stop: '1.8', step: '0.01' }, op: {} };

  async function testbenchDialog() {
    const v = view();
    const sim = JSON.parse(JSON.stringify(v.data.schematic.sim || { analyses: [{ type: 'op' }] }));
    const list = h('div', {});
    const draw = () => list.replaceChildren(...sim.analyses.map((a, i) => {
      const type = h('select', {}, Object.keys(FIELDS).map(t => h('option', { value: t, selected: t === a.type }, t)));
      type.addEventListener('change', () => { sim.analyses[i] = { type: type.value, ...DEFAULTS[type.value] }; draw(); });
      return h('div', { class: 'row' }, type, ...FIELDS[a.type].map(f => {
        const inp = h('input', { type: 'text', value: a[f] ?? '', placeholder: f, size: 7, title: f });
        inp.addEventListener('input', () => { a[f] = inp.value; });
        return inp;
      }), h('button', { class: 'mini', onclick: () => { sim.analyses.splice(i, 1); draw(); } }, '✕'));
    }));
    draw();
    const pdk = h('select', {}, h('option', { value: '' }, `library PDK (${v.data.pdk})`), P.state.pdks.filter(p => p.installed).map(p => h('option', { value: p.id, selected: p.id === sim.pdk }, p.id)));
    const corner = h('select', {}, P.state.corners.map(c => h('option', { value: c, selected: c === (sim.corner || 'tt') }, c)));
    const temp = h('input', { type: 'number', value: sim.temp ?? 27, style: { width: '70px' } });
    if (!await modal(`Testbench: ${v.lib}/${v.cell}`, [list, h('button', { class: 'mini', onclick: () => { sim.analyses.push({ type: 'tran', ...DEFAULTS.tran }); draw(); } }, '+ analysis'),
      h('div', { class: 'row' }, 'PDK', pdk, 'corner', corner, 'temp °C', temp)], 'Save')) return;
    await op('set_sim', { analyses: sim.analyses, pdk: pdk.value || undefined, corner: corner.value, temp: +temp.value });
  }

  async function simulateDialog() {
    const v = view();
    const sim = v.data.schematic.sim || {};
    const pdk = h('select', {}, P.state.pdks.filter(p => p.installed).map(p => h('option', { value: p.id, selected: p.id === (sim.pdk || v.data.pdk) }, `${p.id} · ${p.vdd} V`)));
    const corner = h('select', {}, P.state.corners.map(c => h('option', { value: c, selected: c === (sim.corner || 'tt') }, c)));
    const temp = h('input', { type: 'number', value: sim.temp ?? 27, style: { width: '70px' } });
    if (!sim.analyses) toast('No analyses set: running an operating point. Use Simulation › Setup to add tran/ac/dc.', 5000);
    if (!await modal(`PrimeSpice: ${v.lib}/${v.cell}`, [h('div', { class: 'row' }, 'PDK', pdk, 'corner', corner, 'temp °C', temp),
      h('p', { class: 'muted small' }, 'Analyses: ' + (sim.analyses || [{ type: 'op' }]).map(a => a.type).join(', '))], 'Run')) return;
    try {
      const { job } = await api('/api/simulate', { lib: v.lib, cell: v.cell, pdk: pdk.value, corner: corner.value, temp: +temp.value });
      toast('PrimeSpice running…', 2500);
      const r = await waitJob(job);
      toast(r.ok ? `Done in ${r.seconds} s` : 'Simulation failed: ' + (r.errors || []).join('; '), 6000);
      Probe.refreshRuns();
      Probe.open(r.run);
    } catch (err) { toast(err.message, 8000); }
  }

  // ------------------------------------------------------------ public
  async function loadBindkeys() {
    try {
      const b = await api('/api/bindkeys');
      Object.assign(S, { keymap: b.keymap, defaults: b.defaults, commands: b.commands });
    } catch (err) { toast('Bindkeys not loaded: ' + err.message); }
  }
  function init() {
    $('#de-new-lib').addEventListener('click', newLib);
    $('#de-new-cell').addEventListener('click', newCell);
    document.addEventListener('keydown', onKey);
    loadBindkeys();
    loadLibs();
  }
  function openLauncher() {
    const first = S.libs.flatMap(l => l.cells.map(c => [l.name, c.name]))[0];
    if (S.active) Apps.open({ id: 'de:' + S.active, title: S.active.split(':')[0].split('/')[1] + ' · ' + VIEW_SHORT[S.active.split(':')[1]], kind: 'de', key: S.active });
    else if (first) open(first[0], first[1]);
    else { $('#app-pane').hidden = false; $('#de').hidden = false; $('#probe').hidden = true; loadLibs(); newCell(); }
  }
  function currentLabel() { const v = view(); return v && !$('#app-pane').hidden ? `${v.lib}/${v.cell} (${v.kind} view)` : null; }
  return { init, open, show, changed, currentLabel, openLauncher, refresh: loadLibs, run };
})();

async function waitJob(id) {
  for (;;) {
    const j = await api('/api/jobs/' + id);
    if (j.state === 'done') return j.result;
    if (j.state === 'error') throw new Error(j.error);
    await new Promise(r => setTimeout(r, 700));
  }
}
