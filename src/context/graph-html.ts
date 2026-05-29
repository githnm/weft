/**
 * Self-contained HTML renderer for the decision-trace context graph.
 *
 * Produces ONE static HTML file: trace data is inlined as JSON, the only
 * external resource is cytoscape.js from cdnjs. No server, no fetch, no build
 * — it opens with a double-click. We render only what is in the traces; empty
 * links simply yield isolated nodes.
 */

import type { Trace } from "./trace.js";

const CY_VERSION = "3.30.2";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderContextGraphHtml(modelName: string, traces: Trace[]): string {
  // Inline the data safely: neutralize "</script>" and any stray "<".
  const data = JSON.stringify(traces).replace(/</g, "\\u003c");

  return TEMPLATE
    .replace("__MODEL__", () => escapeHtml(modelName))
    .replace("__COUNT__", () => String(traces.length))
    .replace("__CYVER__", () => CY_VERSION)
    .replace("__DATA__", () => data);
}

// NOTE: the embedded <script> deliberately avoids backticks and ${...} so the
// whole document can live in this template literal. Dynamic values are injected
// via the single-occurrence placeholders above.
const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Context graph — __MODEL__</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/__CYVER__/cytoscape.min.js"></script>
<style>
  :root {
    --bg: #f8fafc; --panel-bg: #ffffff; --ink: #0f172a; --muted: #64748b;
    --line: #e2e8f0; --accent: #0f172a; --code-bg: #f1f5f9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1220; --panel-bg: #111a2e; --ink: #e5e9f0; --muted: #94a3b8;
      --line: #24304a; --accent: #e5e9f0; --code-bg: #0d1526;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--ink); background: var(--bg); display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 16px; padding: 12px 18px;
    border-bottom: 1px solid var(--line); background: var(--panel-bg);
  }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: 0.2px; }
  header .sub { color: var(--muted); font-size: 12px; }
  header .spacer { flex: 1; }
  header input[type=search] {
    width: 240px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--line);
    border-radius: 6px; background: var(--bg); color: var(--ink);
  }
  header button {
    font: inherit; font-size: 12px; padding: 6px 10px; border: 1px solid var(--line);
    border-radius: 6px; background: var(--bg); color: var(--ink); cursor: pointer;
  }
  header button:hover { border-color: var(--muted); }
  main { flex: 1; display: flex; min-height: 0; }
  #controls {
    width: 230px; flex: none; border-right: 1px solid var(--line); background: var(--panel-bg);
    overflow-y: auto; padding: 14px 16px;
  }
  #controls h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted);
    margin: 18px 0 8px; font-weight: 600;
  }
  #controls h2:first-child { margin-top: 0; }
  .flt-item, .lg-item {
    display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 3px 0; cursor: pointer;
  }
  .flt-item input { margin: 0; }
  .sw { width: 12px; height: 12px; border-radius: 50%; flex: none; }
  .lg-border {
    width: 14px; height: 14px; border-radius: 50%; flex: none; background: transparent;
  }
  .lg-note { font-size: 12px; color: var(--muted); margin: 4px 0 0; line-height: 1.45; }
  #cy { flex: 1; min-width: 0; position: relative; }
  #empty {
    position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    color: var(--muted); font-size: 14px; text-align: center; padding: 40px;
  }
  #panel {
    width: 380px; flex: none; border-left: 1px solid var(--line); background: var(--panel-bg);
    display: none; flex-direction: column; min-height: 0;
  }
  #panel.open { display: flex; }
  #panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--line);
  }
  #panel-head span { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted); }
  #panel-close {
    font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--bg);
    color: var(--ink); border-radius: 6px; padding: 4px 9px; cursor: pointer;
  }
  #panel-body { overflow-y: auto; padding: 16px; }
  .p-obs { font-size: 15px; font-weight: 600; line-height: 1.35; margin-bottom: 10px; }
  .p-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .badge { font-size: 11px; font-weight: 600; color: #fff; padding: 2px 8px; border-radius: 999px; }
  .badge.outline { background: transparent; border: 1.5px solid; }
  .p-time { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  #panel-body h3 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted);
    margin: 16px 0 6px; font-weight: 600;
  }
  .p-text { font-size: 13px; line-height: 1.5; margin: 0; white-space: pre-wrap; }
  .p-key { font-size: 11px; color: var(--muted); margin-top: 8px; font-weight: 600; }
  .p-val { font-size: 13px; word-break: break-word; }
  .p-code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px;
    background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px;
    padding: 8px 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 4px 0 0;
  }
  .p-link {
    font-size: 13px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px;
    margin-top: 6px; cursor: pointer; line-height: 1.4;
  }
  .p-link:hover { border-color: var(--muted); }
</style>
</head>
<body>
  <header>
    <h1>Context graph</h1>
    <span class="sub">__MODEL__ &middot; __COUNT__ traces</span>
    <span class="spacer"></span>
    <input type="search" id="search" placeholder="Search observation text" autocomplete="off" />
    <button id="btn-force" title="Force-directed layout">Force</button>
    <button id="btn-timeline" title="Time-ordered layout (older to the left)">Timeline</button>
    <button id="btn-fit" title="Fit to view">Fit</button>
  </header>
  <main>
    <aside id="controls">
      <h2>Filter by type</h2>
      <div id="filters"></div>
      <h2>Legend &mdash; type</h2>
      <div id="legend-type"></div>
      <h2>Legend &mdash; outcome (border)</h2>
      <div id="legend-outcome"></div>
      <p class="lg-note">Node color = decision type. Border = outcome status. Arrows point from a decision to what it influenced (a correction to the asks it affects; a reversal to what it reversed).</p>
    </aside>
    <div id="cy"><div id="empty">No traces yet for this model. Run some questions or corrections, then regenerate the graph.</div></div>
    <div id="panel">
      <div id="panel-head"><span>Trace detail</span><button id="panel-close">Close</button></div>
      <div id="panel-body"></div>
    </div>
  </main>
<script>
var TRACES = __DATA__;

var TYPES = {
  ask: { label: 'Ask', color: '#2563eb' },
  correction: { label: 'Correction', color: '#d97706' },
  term_define: { label: 'Term define', color: '#0d9488' },
  model_design: { label: 'Model design', color: '#7c3aed' },
  model_refine: { label: 'Model refine', color: '#4f46e5' },
  feasibility_refusal: { label: 'Feasibility refusal', color: '#dc2626' }
};
var OUTCOMES = {
  verified: { label: 'Verified', color: '#16a34a', style: 'solid', width: 3 },
  accepted: { label: 'Accepted', color: '#2563eb', style: 'solid', width: 3 },
  reversed: { label: 'Reversed', color: '#9ca3af', style: 'dashed', width: 3 },
  rejected: { label: 'Rejected', color: '#dc2626', style: 'double', width: 4 },
  pending: { label: 'Pending', color: '#d97706', style: 'dashed', width: 3 },
  failed: { label: 'Failed', color: '#991b1b', style: 'solid', width: 4 }
};
var REL = {
  affects: { color: '#d97706', style: 'solid' },
  reverses: { color: '#dc2626', style: 'dashed' },
  links: { color: '#94a3b8', style: 'solid' }
};

function truncate(s, n) { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '\\u2026' : s; }
function byId(id) { for (var i = 0; i < TRACES.length; i++) { if (TRACES[i].id === id) return TRACES[i]; } return null; }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

var laneKeys = Object.keys(TYPES);
var laneIdx = {}; laneKeys.forEach(function(k, i) { laneIdx[k] = i; });

var idset = {}; TRACES.forEach(function(t) { idset[t.id] = true; });
var sorted = TRACES.slice().sort(function(a, b) { return a.timestamp < b.timestamp ? -1 : (a.timestamp > b.timestamp ? 1 : 0); });
var timeIndex = {}; sorted.forEach(function(t, i) { timeIndex[t.id] = i; });

var nodes = TRACES.map(function(t) {
  return { data: { id: t.id, type: t.decision_type, status: (t.outcome && t.outcome.status) || 'pending', label: truncate(t.observation, 40) } };
});
var edges = [];
TRACES.forEach(function(t) {
  var act = t.action || {};
  var rev = act.reversed_trace_id;
  var affected = act.affected_ask_ids || [];
  (t.links || []).forEach(function(to) {
    if (!idset[to]) return; // only render edges to traces present in this store
    var rel = 'links';
    if (t.decision_type === 'correction') {
      if (to === rev) rel = 'reverses';
      else if (affected.indexOf(to) !== -1) rel = 'affects';
    }
    edges.push({ data: { id: t.id + '..' + to, source: t.id, target: to, rel: rel } });
  });
});

function buildControls() {
  var present = {}; TRACES.forEach(function(t) { present[t.decision_type] = (present[t.decision_type] || 0) + 1; });
  var fbox = document.getElementById('filters');
  laneKeys.forEach(function(k) {
    if (!present[k]) return; // only offer filters for types that exist
    var lbl = el('label', 'flt-item');
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'flt'; cb.value = k; cb.checked = true;
    var sw = el('span', 'sw'); sw.style.background = TYPES[k].color;
    lbl.appendChild(cb); lbl.appendChild(sw); lbl.appendChild(el('span', null, TYPES[k].label + ' (' + present[k] + ')'));
    fbox.appendChild(lbl);
  });

  var lt = document.getElementById('legend-type');
  laneKeys.forEach(function(k) {
    var row = el('div', 'lg-item');
    var sw = el('span', 'sw'); sw.style.background = TYPES[k].color;
    row.appendChild(sw); row.appendChild(el('span', null, TYPES[k].label));
    lt.appendChild(row);
  });

  var lo = document.getElementById('legend-outcome');
  Object.keys(OUTCOMES).forEach(function(k) {
    var o = OUTCOMES[k];
    var row = el('div', 'lg-item');
    var b = el('span', 'lg-border'); b.style.border = (o.width) + 'px ' + o.style + ' ' + o.color;
    row.appendChild(b); row.appendChild(el('span', null, o.label));
    lo.appendChild(row);
  });
}

var cy = null;
function initGraph() {
  if (typeof cytoscape === 'undefined') {
    var e = document.getElementById('empty');
    e.style.display = 'flex';
    e.textContent = 'Could not load cytoscape.js from the CDN. Connect to the internet and reopen this file.';
    return;
  }
  if (TRACES.length === 0) { document.getElementById('empty').style.display = 'flex'; }

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: { nodes: nodes, edges: edges },
    wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: {
        'background-color': function(e) { return (TYPES[e.data('type')] || {}).color || '#64748b'; },
        'label': 'data(label)',
        'font-size': '11px',
        'font-family': 'ui-sans-serif, system-ui, sans-serif',
        'color': '#334155',
        'text-wrap': 'wrap',
        'text-max-width': '150px',
        'text-valign': 'bottom',
        'text-margin-y': 5,
        'width': 28, 'height': 28,
        'border-width': function(e) { return (OUTCOMES[e.data('status')] || {}).width || 2; },
        'border-color': function(e) { return (OUTCOMES[e.data('status')] || {}).color || '#cbd5e1'; },
        'border-style': function(e) { return (OUTCOMES[e.data('status')] || {}).style || 'solid'; }
      }},
      { selector: 'edge', style: {
        'width': 1.5,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 1,
        'line-color': function(e) { return (REL[e.data('rel')] || REL.links).color; },
        'target-arrow-color': function(e) { return (REL[e.data('rel')] || REL.links).color; },
        'line-style': function(e) { return (REL[e.data('rel')] || REL.links).style; },
        'opacity': 0.85
      }},
      { selector: 'node.dim', style: { 'opacity': 0.12 } },
      { selector: 'edge.dim', style: { 'opacity': 0.06 } },
      { selector: 'node.match', style: { 'border-color': '#111827', 'border-width': 5 } },
      { selector: 'node:selected', style: { 'border-color': '#111827', 'border-width': 5 } },
      { selector: '.hidden', style: { 'display': 'none' } }
    ],
    layout: layoutOpts()
  });

  cy.ready(function() { cy.fit(undefined, 55); });
  cy.on('tap', 'node', function(evt) { renderPanel(byId(evt.target.id())); });
  cy.on('tap', function(evt) { if (evt.target === cy) { closePanel(); } });
}

function layoutOpts() {
  return { name: 'cose', animate: false, padding: 45, nodeRepulsion: 9000, idealEdgeLength: 120, componentSpacing: 130, randomize: true };
}
function runForce() { if (cy) cy.layout({ name: 'cose', animate: true, padding: 45, nodeRepulsion: 9000, idealEdgeLength: 120, componentSpacing: 130, randomize: true }).run(); }
function runTimeline() {
  if (!cy) return;
  cy.nodes().forEach(function(n) {
    n.position({ x: 120 + (timeIndex[n.id()] || 0) * 210, y: 100 + (laneIdx[n.data('type')] || 0) * 125 });
  });
  cy.layout({ name: 'preset', animate: true, fit: true, padding: 45 }).run();
}

function applyFilters() {
  if (!cy) return;
  var visible = {};
  var boxes = document.querySelectorAll('input.flt');
  for (var i = 0; i < boxes.length; i++) { visible[boxes[i].value] = boxes[i].checked; }
  cy.batch(function() {
    cy.nodes().forEach(function(n) { n.toggleClass('hidden', visible[n.data('type')] === false); });
    cy.edges().forEach(function(ed) { ed.toggleClass('hidden', ed.source().hasClass('hidden') || ed.target().hasClass('hidden')); });
  });
}

function applySearch(q) {
  if (!cy) return;
  q = (q || '').trim().toLowerCase();
  cy.batch(function() {
    if (!q) { cy.elements().removeClass('dim match'); return; }
    cy.nodes().forEach(function(n) {
      var t = byId(n.id());
      var hit = !!(t && (t.observation || '').toLowerCase().indexOf(q) !== -1);
      n.toggleClass('match', hit);
      n.toggleClass('dim', !hit);
    });
    cy.edges().addClass('dim');
  });
}

var CODE_KEYS = { malloy: 1, model_malloy: 1, find_line: 1, replace_line: 1 };
function renderPanel(t) {
  if (!t) return;
  var p = document.getElementById('panel-body');
  p.innerHTML = '';
  p.appendChild(el('div', 'p-obs', t.observation || '(no observation)'));

  var meta = el('div', 'p-meta');
  var ty = el('span', 'badge', (TYPES[t.decision_type] || {}).label || t.decision_type);
  ty.style.background = (TYPES[t.decision_type] || {}).color || '#64748b';
  meta.appendChild(ty);
  var st = (t.outcome && t.outcome.status) || 'pending';
  var stb = el('span', 'badge outline', (OUTCOMES[st] || {}).label || st);
  stb.style.borderColor = (OUTCOMES[st] || {}).color || '#cbd5e1';
  stb.style.color = (OUTCOMES[st] || {}).color || '#475569';
  meta.appendChild(stb);
  p.appendChild(meta);
  if (t.timestamp) p.appendChild(el('div', 'p-time', t.timestamp));

  if (t.reasoning) { p.appendChild(el('h3', null, 'Reasoning')); p.appendChild(el('p', 'p-text', t.reasoning)); }

  var act = t.action || {};
  var keys = Object.keys(act);
  var shown = keys.filter(function(k) {
    var v = act[k];
    return !(v == null || v === '' || (Array.isArray(v) && v.length === 0));
  });
  if (shown.length) {
    p.appendChild(el('h3', null, 'Action'));
    shown.forEach(function(k) {
      var v = act[k];
      p.appendChild(el('div', 'p-key', k));
      if (CODE_KEYS[k] && typeof v === 'string') { p.appendChild(el('pre', 'p-code', v)); }
      else if (typeof v === 'object') { p.appendChild(el('pre', 'p-code', JSON.stringify(v, null, 2))); }
      else { p.appendChild(el('div', 'p-val', String(v))); }
    });
  }

  if (t.outcome) {
    p.appendChild(el('h3', null, 'Outcome'));
    p.appendChild(el('div', 'p-val', 'status: ' + (t.outcome.status || '')));
    if (t.outcome.detail) p.appendChild(el('p', 'p-text', t.outcome.detail));
    if (t.outcome.result_summary) p.appendChild(el('pre', 'p-code', JSON.stringify(t.outcome.result_summary, null, 2)));
  }

  if (t.links && t.links.length) {
    p.appendChild(el('h3', null, 'Links'));
    t.links.forEach(function(id) {
      var lt = byId(id);
      var label = lt ? ((TYPES[lt.decision_type] || {}).label + ': ' + truncate(lt.observation, 50)) : id;
      var a = el('div', 'p-link', label);
      a.title = id;
      if (lt && cy) {
        a.addEventListener('click', function() {
          var n = cy.getElementById(id);
          cy.elements().unselect(); n.select();
          cy.animate({ center: { eles: n }, zoom: 1.1 }, { duration: 300 });
          renderPanel(lt);
        });
      }
      p.appendChild(a);
    });
  }

  document.getElementById('panel').classList.add('open');
}
function closePanel() { document.getElementById('panel').classList.remove('open'); if (cy) cy.elements().unselect(); }

buildControls();
initGraph();
var fbx = document.querySelectorAll('input.flt');
for (var i = 0; i < fbx.length; i++) { fbx[i].addEventListener('change', applyFilters); }
document.getElementById('search').addEventListener('input', function(e) { applySearch(e.target.value); });
document.getElementById('btn-force').addEventListener('click', runForce);
document.getElementById('btn-timeline').addEventListener('click', runTimeline);
document.getElementById('btn-fit').addEventListener('click', function() { if (cy) cy.fit(undefined, 55); });
document.getElementById('panel-close').addEventListener('click', closePanel);
</script>
</body>
</html>`;
