'use strict';
// PrimeProbe: waveforms and measurements of PrimeSpice runs. Transient and DC sweeps plot on a linear
// axis; AC plots magnitude (dB) and phase on a log frequency axis. Click to place cursor A,
// shift-click for B; drag to zoom; double-click to reset.

const Probe = (() => {
  const COLORS = ['#2f6fde', '#e8590c', '#0b8a5f', '#b42318', '#7c3aed', '#0e7490', '#a16207', '#be185d'];
  const MEASURES = { tran: ['min', 'max', 'pp', 'avg', 'rms', 'rise', 'fall', 'freq', 'at', 'cross'],
                     dc: ['min', 'max', 'at', 'cross'], ac: ['dc_gain', 'bw3db', 'ugf', 'pm'] };
  const S = { runs: [], run: null, info: null, analysis: null, exprs: [], traces: {}, view: null, curA: null, curB: null, meas: [], drag: null };
  let built = false;

  function build() {
    if (built) return;
    built = true;
    $('#probe').replaceChildren(
      h('div', { class: 'probe-side' },
        h('div', { class: 'side-head' }, 'Run'), h('select', { id: 'pr-run' }),
        h('div', { class: 'side-head' }, 'Analysis'), h('select', { id: 'pr-an' }),
        h('div', { class: 'side-head' }, 'Signals'), h('div', { id: 'pr-sigs' }),
        h('div', { class: 'row' }, h('input', { id: 'pr-expr', type: 'text', placeholder: 'v(out)-v(in), db(v(out))', style: { flex: 1, minWidth: 0 } }),
          h('button', { class: 'mini', onclick: () => { const e = $('#pr-expr').value.trim(); if (e) { addExpr(e); $('#pr-expr').value = ''; } } }, '+')),
        h('div', { class: 'side-head' }, 'Measure'),
        h('div', { class: 'meas-row' }, h('select', { id: 'pr-mexpr' }), h('select', { id: 'pr-mkind' }),
          h('input', { id: 'pr-marg', type: 'text', placeholder: 'x / level', size: 6 }),
          h('button', { class: 'mini primary', onclick: measure }, 'Go')),
        h('div', { id: 'pr-mout', class: 'small mono' })),
      h('div', { class: 'probe-main' }, h('canvas', { id: 'pr-canvas' }), h('div', { id: 'pr-read', class: 'probe-read' })));
    $('#pr-run').addEventListener('change', e => load(e.target.value));
    $('#pr-an').addEventListener('change', e => { S.analysis = e.target.value; S.exprs = defaults(); S.view = null; refresh(); });
    $('#pr-expr').addEventListener('keydown', e => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) { addExpr(v); e.target.value = ''; } } });
    const cv = $('#pr-canvas');
    cv.addEventListener('mousedown', e => { S.drag = { x0: e.offsetX, x1: e.offsetX, shift: e.shiftKey }; });
    cv.addEventListener('mousemove', e => { if (S.drag) { S.drag.x1 = e.offsetX; draw(); } });
    cv.addEventListener('mouseup', e => {
      const d = S.drag; S.drag = null;
      if (!d) return;
      const L = layout();
      if (Math.abs(d.x1 - d.x0) > 6) {
        const [a, b] = [L.inv(Math.min(d.x0, d.x1)), L.inv(Math.max(d.x0, d.x1))];
        S.view = [a, b];
      } else if (d.shift) S.curB = L.inv(e.offsetX); else S.curA = L.inv(e.offsetX);
      draw();
    });
    cv.addEventListener('dblclick', () => { S.view = null; draw(); });
    new ResizeObserver(() => draw()).observe(cv);
  }

  async function refreshRuns() {
    try { S.runs = await api('/api/runs'); } catch { return; }
    if (!built) return;
    $('#pr-run').replaceChildren(...S.runs.map(r => h('option', { value: r.id, selected: r.id === S.run },
      `${r.ok ? '' : '✗ '}${r.lib}/${r.cell} · ${r.pdk} ${r.corner} · ${r.id.slice(9, 15)}`)));
  }

  async function open(rid) {
    build();
    await refreshRuns();
    rid = rid || S.run || S.runs[0]?.id;
    Apps.open({ id: 'probe', title: 'PrimeProbe', kind: 'probe', key: rid });
    if (rid) await load(rid);
    else { $('#pr-read').textContent = 'No runs yet. Simulate a testbench in Primate DE or ask a team to.'; draw(); }
  }

  function show() { build(); draw(); }

  async function load(rid) {
    S.run = rid;
    S.info = await api('/api/runs/' + rid);
    const kinds = Object.keys(S.info.analyses);
    S.analysis = kinds.includes(S.analysis) ? S.analysis : kinds.find(k => k !== 'op') || kinds[0];
    $('#pr-run').value = rid;
    $('#pr-an').replaceChildren(...kinds.map(k => h('option', { value: k, selected: k === S.analysis }, k)));
    S.exprs = defaults();
    S.view = null; S.curA = S.curB = null; S.meas = [];
    $('#pr-mout').replaceChildren();
    await refresh();
  }

  function defaults() {
    const a = S.info?.analyses[S.analysis];
    if (!a || S.analysis === 'op') return [];
    const top = a.vectors.filter(n => /^v\(/.test(n) && !n.includes('.'));
    return top.slice(0, 3);
  }

  async function addExpr(e) { if (!S.exprs.includes(e)) S.exprs.push(e); await refresh(); }

  async function refresh() {
    const a = S.info.analyses[S.analysis];
    if (S.analysis === 'op') {
      $('#pr-sigs').replaceChildren();
      $('#pr-read').replaceChildren(h('table', {}, h('tr', {}, h('th', {}, 'node'), h('th', {}, 'value')),
        Object.entries(a.values).filter(([k]) => !k.includes('#')).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, fmt(v))))));
      S.traces = {};
      draw();
      return;
    }
    const sigs = [...new Set([...a.vectors, ...S.exprs])];
    $('#pr-sigs').replaceChildren(...sigs.slice(0, 80).map(n => {
      const on = S.exprs.includes(n);
      const cb = h('input', { type: 'checkbox', checked: on });
      cb.addEventListener('change', () => { if (cb.checked) S.exprs.push(n); else S.exprs = S.exprs.filter(x => x !== n); refresh(); });
      return h('label', { class: 'sig' }, cb, h('i', { style: { background: on ? COLORS[S.exprs.indexOf(n) % COLORS.length] : 'transparent' } }), n);
    }));
    $('#pr-mexpr').replaceChildren(...S.exprs.map(e => h('option', { value: e }, e)));
    $('#pr-mkind').replaceChildren(...(MEASURES[S.analysis] || []).map(k => h('option', { value: k }, k)));
    S.traces = S.exprs.length ? await api('/api/probe', { run: S.run, analysis: S.analysis, exprs: S.exprs }) : {};
    for (const [e, t] of Object.entries(S.traces)) if (t.error) toast(`${e}: ${t.error}`, 5000);
    draw();
  }

  async function measure() {
    const expr = $('#pr-mexpr').value, kind = $('#pr-mkind').value, arg = $('#pr-marg').value.trim();
    if (!expr) return;
    const args = kind === 'at' ? { x: +arg } : kind === 'cross' ? { level: +arg } : {};
    try {
      const r = await api('/api/measure', { run: S.run, analysis: S.analysis, expr, kind, args });
      S.meas.unshift(`${kind}(${expr}${arg ? ', ' + arg : ''}) = ${r.value === null ? '—' : fmt(r.value)}${r.unit && r.unit !== 'x' ? ' ' + r.unit : ''}${r.note ? ' (' + r.note + ')' : ''}`);
    } catch (err) { S.meas.unshift('error: ' + err.message); }
    $('#pr-mout').replaceChildren(...S.meas.slice(0, 12).map(m => h('div', {}, m)));
  }

  // ------------------------------------------------------------ plotting
  function fmt(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const a = Math.abs(v);
    if (a === 0) return '0';
    const units = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
    for (const [k, u] of units) if (a >= k * 0.9995) return (v / k).toPrecision(4).replace(/\.?0+$/, '') + u;
    return v.toExponential(3);
  }

  function layout() {
    const cv = $('#pr-canvas');
    const W = cv.clientWidth, H = cv.clientHeight;
    const ac = S.analysis === 'ac';
    const xs = Object.values(S.traces).filter(t => t.x).map(t => t.x);
    let [x0, x1] = S.view || (xs.length ? [Math.min(...xs.map(x => x[0])), Math.max(...xs.map(x => x[x.length - 1]))] : [0, 1]);
    const tx = v => ac ? Math.log10(Math.max(v, 1e-30)) : v;
    const L = 56, R = 14, T = 12, B = 26;
    const pw = W - L - R;
    const X = v => L + (tx(v) - tx(x0)) / ((tx(x1) - tx(x0)) || 1) * pw;
    const inv = px => { const f = tx(x0) + (px - L) / pw * (tx(x1) - tx(x0)); return ac ? 10 ** f : f; };
    const strips = ac ? [{ key: 'db', T, H: (H - T - B) * 0.6 - 8 }, { key: 'phase', T: T + (H - T - B) * 0.6 + 8, H: (H - T - B) * 0.4 - 8 }]
      : [{ key: 'y', T, H: H - T - B }];
    return { W, H, L, R, T, B, X, inv, x0, x1, strips, ac };
  }

  function draw() {
    const cv = $('#pr-canvas');
    if (!cv || !cv.clientWidth) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    ctx.fillStyle = css('--plot-bg'); ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
    const Lo = layout();
    const traces = Object.entries(S.traces).filter(([, t]) => t.x);
    if (!traces.length) {
      ctx.fillStyle = css('--muted'); ctx.font = '13px system-ui';
      ctx.fillText(S.analysis === 'op' ? 'Operating point: see the table below.' : 'Pick signals on the left.', 20, 30);
      return;
    }
    ctx.font = '11px ui-monospace, Consolas, monospace';
    for (const st of Lo.strips) {
      let lo = Infinity, hi = -Infinity;
      for (const [, t] of traces) {
        const ys = t[st.key] || [];
        t.x.forEach((x, i) => { if (x >= Lo.x0 && x <= Lo.x1) { lo = Math.min(lo, ys[i]); hi = Math.max(hi, ys[i]); } });
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (hi - lo < 1e-15) { hi += 1e-3 + Math.abs(hi) * 0.05; lo -= 1e-3 + Math.abs(lo) * 0.05; }
      const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
      const Y = v => st.T + (1 - (v - lo) / (hi - lo)) * st.H;
      ctx.strokeStyle = css('--plot-grid'); ctx.fillStyle = css('--muted'); ctx.lineWidth = 1;
      for (let k = 0; k <= 4; k++) {
        const v = lo + (hi - lo) * k / 4, y = Y(v);
        ctx.beginPath(); ctx.moveTo(Lo.L, y); ctx.lineTo(Lo.W - Lo.R, y); ctx.stroke();
        ctx.fillText(fmt(v) + (st.key === 'db' ? 'dB' : st.key === 'phase' ? '°' : ''), 4, y + 4);
      }
      traces.forEach(([name], k) => {
        const t = S.traces[name], ys = t[st.key];
        if (!ys) return;
        ctx.strokeStyle = COLORS[S.exprs.indexOf(name) % COLORS.length] || COLORS[k % COLORS.length];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        t.x.forEach((x, i) => {
          if (x < Lo.x0 || x > Lo.x1) return;
          const px = Lo.X(x), py = Y(ys[i]);
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });
    }
    // x axis
    ctx.fillStyle = css('--muted');
    for (let k = 0; k <= 5; k++) {
      const px = Lo.L + (Lo.W - Lo.L - Lo.R) * k / 5;
      ctx.fillText(fmt(Lo.inv(px)) + (Lo.ac ? 'Hz' : S.analysis === 'tran' ? 's' : 'V'), px - 16, Lo.H - 8);
    }
    // zoom box and cursors
    if (S.drag && Math.abs(S.drag.x1 - S.drag.x0) > 6) {
      ctx.fillStyle = 'rgba(106,76,240,0.12)';
      ctx.fillRect(Math.min(S.drag.x0, S.drag.x1), Lo.T, Math.abs(S.drag.x1 - S.drag.x0), Lo.H - Lo.T - Lo.B);
    }
    for (const [c, col] of [[S.curA, '#e11d48'], [S.curB, '#0ea5e9']]) {
      if (c === null) continue;
      ctx.strokeStyle = col; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(Lo.X(c), Lo.T); ctx.lineTo(Lo.X(c), Lo.H - Lo.B); ctx.stroke();
      ctx.setLineDash([]);
    }
    readout(traces, Lo);
  }

  function interp(xs, ys, x) {
    if (!ys) return null;
    let i = xs.findIndex(v => v >= x);
    if (i <= 0) return ys[Math.max(i, 0)];
    return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  }

  function readout(traces, Lo) {
    if (S.analysis === 'op') return;
    const key = Lo.ac ? 'db' : 'y';
    const rows = [h('tr', {}, h('th', {}, 'signal'), h('th', {}, `A ${S.curA === null ? '' : fmt(S.curA)}`), h('th', {}, `B ${S.curB === null ? '' : fmt(S.curB)}`), h('th', {}, 'B−A'))];
    for (const [name, t] of traces) {
      const a = S.curA === null ? null : interp(t.x, t[key], S.curA), b = S.curB === null ? null : interp(t.x, t[key], S.curB);
      rows.push(h('tr', {}, h('td', { style: { color: COLORS[S.exprs.indexOf(name) % COLORS.length] } }, name + (Lo.ac ? ' (dB)' : '')),
        h('td', {}, fmt(a)), h('td', {}, fmt(b)), h('td', {}, a !== null && b !== null ? fmt(b - a) : '')));
    }
    const head = S.info ? `${S.info.lib}/${S.info.cell} · ${S.info.pdk} ${S.info.corner} ${S.info.temp} °C · ${S.info.seconds} s` +
      (S.info.errors?.length ? ' · ' + S.info.errors[0] : '') : '';
    $('#pr-read').replaceChildren(h('div', { class: 'muted' }, head,
      S.curA !== null && S.curB !== null ? `  ·  Δx = ${fmt(S.curB - S.curA)}${Lo.ac ? '' : S.analysis === 'tran' ? 's' : 'V'}` : '',
      '  ·  click: cursor A, shift-click: B, drag: zoom, double-click: reset'), h('table', {}, rows));
  }

  function init() { refreshRuns(); }
  return { init, open, show, refreshRuns };
})();
