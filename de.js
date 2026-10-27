'use strict';
// Primate DE: library manager, schematic editor, symbol / Verilog / netlist views, testbench settings
// and PrimeSpice runs. Every edit goes through /api/cell/op, the same operations the teams' tools use,
// so a cell edited from the chat refreshes here and vice versa.

const DE = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const S = { libs: [], views: {}, active: null, history: [], mode: 'select', place: null, sel: new Set(), drag: null };
  const GLOBAL_GND = n => ['0', 'gnd'].includes(n.toLowerCase());
  const GLOBAL_SUP = n => /^(vdd|vcc|avdd|dvdd|vss|avss|dvss)/i.test(n);
  const VIEW_SHORT = { schematic: 'sch', symbol: 'sym', verilog: 'v', netlist: 'net' };

  const s = (tag, attrs = {}, ...kids) => h('svg:' + tag, attrs, ...kids);
  const append = (el, ...kids) => el.append(...kids.flat(3).filter(k => k != null && k !== false));   // DOM append turns null into "null"
  const view = () => S.views[S.active];
  const devs = () => P.state.devices;

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
  const snap = v => Math.round(v / 10) * 10;

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
    const lib = h('select', {}, S.libs.map(l => h('option', { value: l.name }, l.name)));
    const name = h('input', { type: 'text', placeholder: 'ota5t' });
    const kind = h('select', {}, h('option', { value: 'schematic' }, 'schematic'), h('option', { value: 'testbench' }, 'testbench (schematic + analyses)'),
      h('option', { value: 'verilog' }, 'verilog'));
    if (!await modal('New cell', [h('div', { class: 'row' }, 'Library', lib), h('div', { class: 'row' }, 'Name', name), h('div', { class: 'row' }, 'Kind', kind)], 'Create')) return;
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

  // ------------------------------------------------------------ views
  async function fetchCell(lib, cell) { return api(`/api/cell?lib=${encodeURIComponent(lib)}&cell=${encodeURIComponent(cell)}`); }

  async function open(lib, cell, kind = 'schematic', push = false) {
    const key = `${lib}/${cell}:${kind}`;
    try {
      const data = await fetchCell(lib, cell);
      if (push && S.active) S.history.push(S.active);
      const fresh = !S.views[key];
      S.views[key] = { ...(S.views[key] || {}), lib, cell, kind, data };
      Apps.open({ id: 'de:' + key, title: `${cell} · ${VIEW_SHORT[kind] || kind}`, kind: 'de', key });
      if (fresh && kind === 'schematic') fit();
    } catch (err) { toast(err.message, 6000); }
  }

  function show(key) {
    S.active = key;
    S.sel.clear();
    S.mode = 'select';
    S.place = null;
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
        const refit = v.kind === 'schematic' && v.data?.schematic && v.data.schematic.instances.length !== before;
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
    } catch (err) { toast(err.message, 6000); }
  }

  function render() {
    const v = view();
    if (!v) return;
    renderToolbar(v);
    const body = $('#de-body');
    if (v.kind === 'schematic') renderSchematic(v, body);
    else if (v.kind === 'symbol') renderSymbol(v, body);
    else if (v.kind === 'verilog') renderVerilog(v, body);
    else if (v.kind === 'netlist') renderNetlist(v, body);
  }

  function renderToolbar(v) {
    const tb = $('#de-toolbar');
    const btn = (label, title, fn, cls = '') => h('button', { class: 'mini ' + cls, title, onclick: fn }, label);
    const items = [h('span', { class: 'crumb' }, `${v.lib}/${v.cell}`)];
    if (S.history.length) items.push(btn('↑ Up', 'Back to the parent cell', () => { const k = S.history.pop(); const [lc, kind] = k.split(':'); const [l, c] = lc.split('/'); open(l, c, kind); }));
    items.push(h('span', { class: 'sep' }));
    for (const kind of ['schematic', 'symbol', 'verilog', 'netlist'])
      items.push(btn(kind, `Open the ${kind} view`, () => open(v.lib, v.cell, kind), v.kind === kind ? 'on' : ''));
    if (v.kind === 'schematic' && v.data.schematic) {
      items.push(h('span', { class: 'sep' }),
        btn('Select', 'Select and move (Esc)', () => setMode('select'), S.mode === 'select' ? 'on' : ''),
        btn('Wire', 'Drag from one terminal to another to connect (W)', () => setMode('wire'), S.mode === 'wire' ? 'on' : ''),
        btn('⟳', 'Rotate the selection (R)', rotateSel), btn('⇋', 'Mirror the selection (M)', mirrorSel),
        btn('🗑', 'Delete the selection (Del)', deleteSel), btn('↶', 'Undo (Ctrl+Z)', () => op('undo')),
        btn('Fit', 'Fit to window (F)', fit), btn('Auto-place', 'Re-arrange the drawing', () => op('auto_place')),
        h('span', { class: 'sep' }),
        btn('Testbench…', 'Analyses, PDK, corner, temperature', testbenchDialog),
        btn('▶ Simulate', 'Run PrimeSpice on this cell', simulateDialog, 'primary'));
    }
    tb.replaceChildren(...items);
  }

  function setMode(m) { S.mode = m; S.place = null; render(); }

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
    svg.append(s('defs', {}, s('pattern', { id: 'dots', width: 10, height: 10, patternUnits: 'userSpaceOnUse' },
      s('circle', { cx: 0, cy: 0, r: 0.8, fill: 'var(--grid)' }))));
    svg.append(s('rect', { x: v.vb.x - 5000, y: v.vb.y - 5000, width: v.vb.w + 10000, height: v.vb.h + 10000, fill: 'url(#dots)', class: 'bg' }));
    const sch = data.schematic;
    const placed = sch.instances.filter(i => i.x !== null && i.y !== null);
    drawNets(svg, placed, data);
    for (const inst of placed) svg.append(drawInstance(inst, data));
    if (S.place) svg.append(s('g', { class: 'ghost', id: 'ghost' }));
    const wrap = h('div', { class: 'canvas-wrap' }, svg,
      h('div', { class: 'mode' }, S.place ? `placing ${S.place.master}: click to place, Esc to stop` :
        S.mode === 'wire' ? 'wire: drag from a terminal to another' : 'select: drag devices, drag a terminal to wire, wheel to zoom, drag empty space to pan'));
    body.replaceChildren(wrap, inspector(v));
    wireEvents(svg, v);
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
    else g.append(s('text', { class: 'lbl name', x: x1 + 5, y: y0 + 10 }, inst.name),
      s('text', { class: 'lbl', x: x1 + 5, y: y0 + 22 }, paramText(inst) || ''));
    for (const t of def.terminals) {
      const [tx, ty] = xform(inst, [t.x, t.y]);
      const net = inst.conn?.[t.name];
      g.append(s('rect', { class: 'term', x: tx - 2.5, y: ty - 2.5, width: 5, height: 5, 'data-term': `${inst.name}.${t.name}` },
        s('title', {}, `${inst.name}.${t.name}${net ? ' = ' + net : ' (unconnected)'}`)));
    }
    return g;
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
        svg.append(s('polyline', { class: 'wire', points: `${a[0]},${a[1]} ${b[0]},${a[1]} ${b[0]},${b[1]}` }));
      }
      pts.forEach((p, k) => { if (degree[k] >= 3) svg.append(s('circle', { class: 'dotj', cx: p[0], cy: p[1], r: 2.5 })); });
      if (pts.length === 1) svg.append(s('line', { class: 'wire', x1: pts[0][0], y1: pts[0][1], x2: pts[0][0] + 12, y2: pts[0][1] }));
      if (!/^n_/.test(net)) {
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

  // ------------------------------------------------------------ interaction
  function wireEvents(svg, v) {
    const insts = () => v.data.schematic.instances;
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const p = svgPoint(svg, e), k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      v.vb = { x: p.x - (p.x - v.vb.x) * k, y: p.y - (p.y - v.vb.y) * k, w: v.vb.w * k, h: v.vb.h * k };
      svg.setAttribute('viewBox', `${v.vb.x} ${v.vb.y} ${v.vb.w} ${v.vb.h}`);
    }, { passive: false });

    svg.addEventListener('mousemove', e => {
      const p = svgPoint(svg, e);
      if (S.place) {
        const ghost = svg.querySelector('#ghost');
        const def = S.place.master.includes('/') ? v.data.symbols?.[S.place.master] : devs()[S.place.master];
        if (ghost && def) ghost.replaceChildren(drawInstance({ name: '', master: S.place.master, x: snap(p.x), y: snap(p.y), rot: 0, params: {}, conn: {} },
          { symbols: { [S.place.master]: def } }));
        return;
      }
      if (!S.drag) return;
      const d = S.drag;
      if (d.kind === 'pan') {
        const k = v.vb.w / svg.clientWidth;
        v.vb.x = d.vb.x - (e.clientX - d.cx) * k;
        v.vb.y = d.vb.y - (e.clientY - d.cy) * k;
        svg.setAttribute('viewBox', `${v.vb.x} ${v.vb.y} ${v.vb.w} ${v.vb.h}`);
      } else if (d.kind === 'move') {
        d.dx = snap(p.x - d.x0); d.dy = snap(p.y - d.y0);
        d.moved = d.moved || Math.abs(d.dx) + Math.abs(d.dy) > 0;
        for (const n of S.sel) svg.querySelector(`[data-inst="${CSS.escape(n)}"]`)?.setAttribute('transform', `translate(${d.dx} ${d.dy})`);
      } else if (d.kind === 'wire') {
        d.line.setAttribute('x2', p.x); d.line.setAttribute('y2', p.y);
      }
    });

    svg.addEventListener('mousedown', async e => {
      if (e.button !== 0 && e.button !== 1) return;
      svg.focus();
      const p = svgPoint(svg, e);
      if (S.place) { await placeAt(v, snap(p.x), snap(p.y)); return; }
      const term = e.target.closest('[data-term]');
      if (term && e.button === 0) {
        const [x, y] = [+term.getAttribute('x') + 2.5, +term.getAttribute('y') + 2.5];
        const line = s('line', { class: 'rubber', x1: x, y1: y, x2: x, y2: y });
        svg.append(line);
        S.drag = { kind: 'wire', from: term.dataset.term, line };
        return;
      }
      const g = e.target.closest('[data-inst]');
      if (g && e.button === 0 && S.mode === 'select') {
        const name = g.dataset.inst;
        if (e.shiftKey) S.sel.has(name) ? S.sel.delete(name) : S.sel.add(name);
        else if (!S.sel.has(name)) { S.sel.clear(); S.sel.add(name); }
        S.drag = { kind: 'move', x0: p.x, y0: p.y, dx: 0, dy: 0 };
        svg.querySelectorAll('.inst').forEach(el => el.classList.toggle('sel', S.sel.has(el.dataset.inst)));
        return;
      }
      if (!e.shiftKey && S.sel.size) { S.sel.clear(); render(); }
      S.drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, vb: { ...v.vb } };
    });

    window.onmouseup = async e => {
      const d = S.drag;
      S.drag = null;
      if (!d) return;
      if (d.kind === 'move') {
        if (!d.moved) { render(); return; }
        for (const n of [...S.sel]) {
          const inst = insts().find(i => i.name === n);
          if (inst) await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: 'move', args: { name: n, x: inst.x + d.dx, y: inst.y + d.dy } }).catch(err => toast(err.message));
        }
        v.data = await fetchCell(v.lib, v.cell);
        render();
      } else if (d.kind === 'wire') {
        d.line.remove();
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-term]');
        if (target && target.dataset.term !== d.from) await op('connect', { a: d.from, b: target.dataset.term });
      }
    };

    svg.addEventListener('dblclick', e => {
      const g = e.target.closest('[data-inst]');
      if (!g) return;
      const inst = insts().find(i => i.name === g.dataset.inst);
      if (inst?.master.includes('/')) { const [l, c] = inst.master.split('/'); open(l, c, 'schematic', true); }
    });

    svg.addEventListener('keydown', e => {
      if (e.target !== svg) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSel(); e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') rotateSel();
      else if (e.key === 'm' || e.key === 'M') mirrorSel();
      else if (e.key === 'f' || e.key === 'F') fit();
      else if (e.key === 'w' || e.key === 'W') setMode('wire');
      else if (e.key === 'Escape') { S.place = null; S.sel.clear(); setMode('select'); }
      else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { op('undo'); e.preventDefault(); }
    });
  }

  async function placeAt(v, x, y) {
    const m = S.place.master;
    let name = null;
    if (devs()[m]?.pin) {
      const inp = h('input', { type: 'text', placeholder: 'net name, e.g. vin' });
      if (!await modal(`Name this ${devs()[m].pin} pin`, [inp], 'Place') || !inp.value.trim()) return;
      name = inp.value.trim();
    }
    await op('add', { master: m, name, x, y });
  }

  function selected() { return [...S.sel].map(n => view().data.schematic.instances.find(i => i.name === n)).filter(Boolean); }
  async function rotateSel() { for (const i of selected()) await api('/api/cell/op', { lib: view().lib, cell: view().cell, op: 'move', args: { name: i.name, rot: ((i.rot || 0) + 90) % 360 } }).catch(e => toast(e.message)); await changed(view().lib, view().cell); }
  async function mirrorSel() { for (const i of selected()) await api('/api/cell/op', { lib: view().lib, cell: view().cell, op: 'move', args: { name: i.name, mirror: !i.mirror } }).catch(e => toast(e.message)); await changed(view().lib, view().cell); }
  async function deleteSel() { if (!S.sel.size) return; await op('remove', { names: [...S.sel] }); S.sel.clear(); render(); }

  function fit() {
    const v = view();
    if (!v || v.kind !== 'schematic' || !v.data.schematic) return;
    const insts = v.data.schematic.instances.filter(i => i.x !== null);
    if (!insts.length) { v.vb = { x: -100, y: -100, w: 800, h: 500 }; render(); return; }
    const boxes = insts.map(i => bbox(i, defOf(i, v.data)));
    const x0 = Math.min(...boxes.map(b => b[0])) - 60, y0 = Math.min(...boxes.map(b => b[1])) - 50;
    const x1 = Math.max(...boxes.map(b => b[2])) + 90, y1 = Math.max(...boxes.map(b => b[3])) + 50;
    const wrap = $('#de-body .canvas-wrap') || { clientWidth: 800, clientHeight: 500 };
    const aspect = (wrap.clientWidth || 800) / (wrap.clientHeight || 500);
    let w = x1 - x0, hgt = y1 - y0;
    if (w / hgt < aspect) w = hgt * aspect; else hgt = w / aspect;
    v.vb = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - hgt / 2, w, h: hgt };
    render();
  }

  // ------------------------------------------------------------ inspector
  function inspector(v) {
    const box = h('aside', { class: 'inspector' });
    const sch = v.data.schematic;
    const sel = selected();
    if (sel.length === 1) {
      const inst = sel[0];
      const def = defOf(inst, v.data);
      const name = h('input', { type: 'text', value: inst.name });
      const params = Object.keys(devs()[inst.master]?.params || {}).map(k => [k, h('input', { type: 'text', value: inst.params?.[k] ?? '',
        title: devs()[inst.master]?.units?.[k] || '' })]);
      const conns = def.terminals.map(t => [t.name, h('input', { type: 'text', value: inst.conn?.[t.name] ?? '', placeholder: 'net' })]);
      const apply = async () => {
        const newParams = Object.fromEntries(params.filter(([k, i]) => i.value !== String(inst.params?.[k] ?? '')).map(([k, i]) => [k, i.value]));
        if (Object.keys(newParams).length) await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: 'set_params', args: { name: inst.name, params: newParams } }).catch(e => toast(e.message));
        for (const [t, i] of conns) if (i.value !== (inst.conn?.[t] ?? ''))
          await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: 'set_conn', args: { name: inst.name, term: t, net: i.value.trim() } }).catch(e => toast(e.message));
        if (name.value.trim() && name.value.trim() !== inst.name) {
          await api('/api/cell/op', { lib: v.lib, cell: v.cell, op: 'rename', args: { name: inst.name, new: name.value.trim() } }).catch(e => toast(e.message));
          S.sel = new Set([name.value.trim()]);
        }
        await changed(v.lib, v.cell);
      };
      append(box, h('h4', {}, inst.master), h('label', {}, 'name', name),
        params.length ? h('h4', {}, 'parameters') : null, ...params.map(([k, i]) => h('label', {}, k, i)),
        h('h4', {}, 'terminals'), ...conns.map(([k, i]) => h('label', {}, k, i)),
        h('div', { class: 'row' }, h('button', { class: 'primary mini', onclick: apply }, 'Apply'),
          inst.master.includes('/') ? h('button', { class: 'mini', onclick: () => { const [l, c] = inst.master.split('/'); open(l, c, 'schematic', true); } }, 'Descend') : null));
      box.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
      return box;
    }
    const prims = Object.entries(devs());
    const cells = S.libs.flatMap(l => l.cells.filter(c => c.views.includes('schematic') && !(l.name === v.lib && c.name === v.cell)).map(c => `${l.name}/${c.name}`));
    const cellPick = h('select', {}, h('option', { value: '' }, 'place a cell…'), cells.map(c => h('option', { value: c }, c)));
    cellPick.addEventListener('change', () => { if (cellPick.value) { S.place = { master: cellPick.value }; render(); } });
    append(box, h('h4', {}, 'place'), h('div', { class: 'palette' }, prims.map(([k, d]) => h('button', { title: d.label,
      class: S.place?.master === k ? 'on' : '', onclick: () => { S.place = { master: k }; render(); } }, k))), cellPick,
      h('h4', {}, `${v.lib}/${v.cell}`), h('div', { class: 'small muted' }, `PDK ${v.data.pdk} · ${sch.instances.length} instances`),
      sch.sim ? h('div', { class: 'small' }, 'testbench: ' + (sch.sim.analyses || []).map(a => a.type).join(', ') +
        (sch.sim.pdk ? ` · ${sch.sim.pdk}` : '') + (sch.sim.corner ? ` ${sch.sim.corner}` : '')) : null,
      h('h4', {}, 'check'), v.data.issues?.length ? h('div', { class: 'issues' }, v.data.issues.map(i => h('div', {}, '• ' + i))) : h('div', { class: 'small muted' }, 'no issues'),
      h('h4', {}, 'keys'), h('div', { class: 'small muted' }, 'R rotate · M mirror · Del delete · F fit · W wire · Ctrl+Z undo · Esc cancel · double-click a cell to descend'));
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
    const run = async () => {
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
      h('button', { class: 'mini', onclick: save }, 'Save (Ctrl+S)'), h('button', { class: 'mini primary', onclick: run }, '▶ Run Icarus')), ta, log));
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
    if (!sim.analyses) toast('No analyses set: running an operating point. Use Testbench… to add tran/ac/dc.', 5000);
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
  function init() {
    $('#de-new-lib').addEventListener('click', newLib);
    $('#de-new-cell').addEventListener('click', newCell);
    loadLibs();
  }
  function openLauncher() {
    const first = S.libs.flatMap(l => l.cells.map(c => [l.name, c.name]))[0];
    if (S.active) Apps.open({ id: 'de:' + S.active, title: S.active.split(':')[0].split('/')[1] + ' · ' + VIEW_SHORT[S.active.split(':')[1]], kind: 'de', key: S.active });
    else if (first) open(first[0], first[1]);
    else { $('#app-pane').hidden = false; $('#de').hidden = false; $('#probe').hidden = true; loadLibs(); newCell(); }
  }
  function currentLabel() { const v = view(); return v && !$('#app-pane').hidden ? `${v.lib}/${v.cell} (${v.kind} view)` : null; }
  return { init, open, show, changed, currentLabel, openLauncher, refresh: loadLibs };
})();

async function waitJob(id) {
  for (;;) {
    const j = await api('/api/jobs/' + id);
    if (j.state === 'done') return j.result;
    if (j.state === 'error') throw new Error(j.error);
    await new Promise(r => setTimeout(r, 700));
  }
}
