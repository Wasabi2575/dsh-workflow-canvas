import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inactiveNodeSets,
  edgeKey,
  loopMemberIds,
  normalizeRefs,
  normalizeMaxIterations,
  normalizeCanvas,
  withoutEntry,
} from '../lib/graph.js';
import { safeSessionFileBase } from '../lib/telemetry.js';
import { BUILTIN_TEMPLATES } from '../lib/presets.js';
import { loadClientTestExports } from './helpers.mjs';

const client = loadClientTestExports();

test('client/backend classification and projected plans agree across DAGs, node orders and controlled loops', () => {
  const ids = ['lead', 'stage', 'worker', 'gate'];
  const candidates = ids.flatMap((from, i) => ids.slice(i + 1).map(to => ({ from, to })));
  for (const role of ['', 'Confirm']) for (const kind of ['lead', 'agent', 'condition']) {
    for (let mask = 0; mask < (1 << candidates.length); mask += 1) {
      const nodes = [
        { id: 'lead', kind: 'lead', task: 't' }, { id: 'stage', kind: 'lead', role },
        { id: 'worker', kind: 'agent' }, { id: 'gate', kind },
      ];
      const edges = candidates.filter((_, i) => mask & (1 << i));
      if (kind === 'condition' && edges.some(e => e.from === 'worker' && e.to === 'gate')) {
        edges.push({ from: 'gate', to: 'worker', loop: true, branch: 'false' });
      }
      const host = inactiveNodeSets(nodes, edges);
      for (const ordered of [nodes, [...nodes].reverse()]) {
        const ui = client.classifyCanvasNodes(ordered, edges);
        for (const key of ['reachable', 'soloLeads', 'deadEnds', 'noOutgoing']) {
          assert.deepEqual([...ui[key]].sort(), [...host[key]].sort(), key + ':' + mask);
        }
        const built = client.buildPlan(ordered, edges);
        if (built.plan) {
          const projected = inactiveNodeSets(built.plan.nodes, built.plan.edges);
          assert.ok(built.plan.nodes.every(n => projected.reachable.has(n.id) && !projected.deadEnds.has(n.id)), JSON.stringify({ role, kind, mask, edges, plan: built.plan }));
        }
      }
    }
  }
});

test('full client/backend shared-logic parity: edgeKey, safeSessionFileBase, loopMemberIds, normalizeRefs, normalizeMaxIterations & buildPlan vs withoutEntry', () => {
  const c = loadClientTestExports();

  // 1) edgeKeyUI === lib/graph.js:edgeKey
  const edgeSamples = [
    { from: 'lead', to: 'n1', type: 'prompt' },
    { from: 'n1', to: 'n2', type: 'structured' },
    { from: 'n1', to: 'n2', type: 'session-ref' },
    { from: 'gate', to: 'n1', type: 'prompt', branch: 'false', loop: true },
    { from: 'gate', to: 'n3', branch: '小修' },
    { from: 'a', to: 'b' },
  ];
  for (const e of edgeSamples) {
    assert.equal(c.edgeKeyUI(e), edgeKey(e), 'edgeKey parity for ' + JSON.stringify(e));
  }

  // 2) sanitizeSessionFileBaseUI === lib/telemetry.js:safeSessionFileBase
  const sidSamples = [
    'session-abc123_XYZ-01',
    '../evil/../../path',
    'CON',
    'nul.txt',
    'COM9',
    'lpt1.log',
    'a:b*c?d<e>f|g',
    '...leading.dots',
    '',
    '   ',
    'x'.repeat(240),
    'CON.' + 'a'.repeat(200),
  ];
  for (const sid of sidSamples) {
    assert.equal(c.sanitizeSessionFileBaseUI(sid), safeSessionFileBase(sid), 'safeSessionFileBase parity for ' + JSON.stringify(sid));
  }

  // 3) normalizeMaxIterationsUI === lib/graph.js:normalizeMaxIterations
  const iterSamples = [undefined, null, '', true, false, 0, -5, 1, 3, 3.9, 10, 99, '7', '0', 'abc', NaN, Infinity];
  for (const v of iterSamples) {
    assert.equal(c.normalizeMaxIterationsUI(v), normalizeMaxIterations(v), 'normalizeMaxIterations parity for ' + String(v));
  }

  // 4) normalizeRefsUI === (lib/graph.js:normalizeRefs || [])
  const refSamples = [
    undefined,
    [],
    ['  docs/a.md  ', '', 'docs/a.md', { path: 'src/b.js' }, { text: 'rule 1' }, null, 42],
    Array.from({ length: 24 }, (_, i) => 'ref-' + i),
  ];
  for (const r of refSamples) {
    assert.deepEqual([...c.normalizeRefsUI(r)], normalizeRefs(r) || [], 'normalizeRefs parity');
  }

  // 5) loopMemberIdsUI === lib/graph.js:loopMemberIds (diamond loop + outside bypass + invalid entry loop)
  const loopGraphNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'n1', kind: 'agent', label: 'Impl' },
    { id: 'n2', kind: 'agent', label: 'Test' },
    { id: 'bypass', kind: 'agent', label: 'Bypass' },
    { id: 'gate', kind: 'condition', label: 'Gate' },
    { id: 'final', kind: 'lead', label: 'Final', role: 'ship' },
  ];
  const loopGraphEdges = [
    { id: 'e0', from: 'lead', to: 'n1', type: 'prompt' },
    { id: 'e1', from: 'n1', to: 'n2', type: 'prompt' },
    { id: 'e2', from: 'n1', to: 'bypass', type: 'prompt' },
    { id: 'e3', from: 'n2', to: 'gate', type: 'prompt' },
    { id: 'e4', from: 'gate', to: 'final', type: 'prompt', branch: 'true' },
    { id: 'e5', from: 'bypass', to: 'final', type: 'prompt' },
    { id: 'el', from: 'gate', to: 'n1', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
  ];
  for (const le of [loopGraphEdges[6], { from: 'gate', to: 'lead', loop: true }, { from: 'gate', to: 'bypass', loop: true }]) {
    const uiSet = [...c.loopMemberIdsUI(loopGraphNodes, loopGraphEdges, le)].sort();
    const beSet = [...loopMemberIds(loopGraphNodes, loopGraphEdges, le)].sort();
    assert.deepEqual(uiSet, beSet, 'loopMemberIds parity for ' + le.from + '->' + le.to);
  }

  // 6) buildPlan <-> normalizeCanvas + withoutEntry field-by-field parity on a generate doc
  // containing explicit entry `lead` + `lead -> n1` edge (historical entry-Lead leak regression)
  const genDoc = normalizeCanvas({
    task: 'Parity test task',
    refs: ['README.md', 'docs/spec.md'],
    nodes: [
      { id: 'lead', kind: 'lead', label: 'Entry Lead', role: 'ignored-entry-role' },
      { id: 'n1', kind: 'agent', label: 'Implement', role: 'Write code', preset: 'standard', refs: ['src/app.js'] },
      { id: 'gate', kind: 'condition', label: 'Quality Gate', role: 'Check tests', branches: ['Pass', 'Fix'], multiMatch: false },
      { id: 'final', kind: 'lead', label: 'Ship', role: 'Final review' },
    ],
    edges: [
      { from: 'lead', to: 'n1', type: 'prompt' },
      { from: 'n1', to: 'gate', type: 'structured' },
      { from: 'gate', to: 'final', type: 'prompt', branch: 'Pass' },
      { from: 'gate', to: 'n1', type: 'prompt', branch: 'Fix', loop: true, maxIterations: 4 },
    ],
  });
  assert.ok(!genDoc.error, 'normalizeCanvas succeeds on generate doc with explicit entry lead');

  // Client builds its plan from the exact same normalized canvas document
  const uiNodes = genDoc.nodes.map((n) => ({ ...n }));
  const uiEdges = genDoc.edges.map((e, idx) => ({ id: e.id || ('e' + idx), ...e }));
  const clientBuilt = c.buildPlan(uiNodes, uiEdges, { direction: 'lr' });
  assert.ok(!clientBuilt.error, 'client buildPlan succeeds without error');

  // Compare projected runnable plan fields strictly against Host `withoutEntry`
  const hostRunnableNodes = withoutEntry(genDoc.nodes);
  const projectNode = (n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    role: n.role || '',
    preset: n.kind === 'condition' ? 'minimal' : (n.preset || 'standard'),
    branches: n.branches ? n.branches.map((b) => (b && typeof b === 'object' ? { id: b.id, label: b.label } : b)) : null,
    multiMatch: Boolean(n.multiMatch),
    refs: n.refs ? [...n.refs] : [],
  });
  const projectEdge = (e) => ({
    from: e.from,
    to: e.to,
    type: e.type || 'prompt',
    branch: e.branch || '',
    loop: Boolean(e.loop),
    maxIterations: e.loop ? normalizeMaxIterations(e.maxIterations) : null,
  });

  assert.equal(clientBuilt.plan.task, genDoc.task, 'plan.task matches');
  assert.deepEqual([...(clientBuilt.plan.refs || [])], [...(genDoc.nodes.find((n) => n.id === 'lead').refs || [])], 'plan.refs matches entry Lead refs');
  assert.ok(!clientBuilt.plan.nodes.some((n) => n.id === 'lead'), 'client buildPlan strips entry lead');
  assert.ok(!hostRunnableNodes.some((n) => n.id === 'lead'), 'host withoutEntry strips entry lead');
  assert.deepEqual(
    clientBuilt.plan.nodes.map(projectNode),
    hostRunnableNodes.map(projectNode),
    'client buildPlan nodes match host withoutEntry nodes field-by-field',
  );
  assert.deepEqual(
    clientBuilt.plan.edges.map(projectEdge),
    genDoc.edges.map(projectEdge),
    'client buildPlan edges match host normalized edges field-by-field',
  );

  // 7) Built-in starter templates parity: client.js builtinTemplates('zh') === lib/presets.js BUILTIN_TEMPLATES
  const uiTemplates = [...c.builtinTemplates('zh', 'lr')];
  assert.deepEqual(
    uiTemplates.map((tpl) => tpl.id),
    BUILTIN_TEMPLATES.map((tpl) => tpl.id),
    'built-in template ids & order match between client.js and lib/presets.js',
  );
  const normTplNode = (n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    preset: n.kind === 'lead' ? null : (n.preset || 'standard'),
    keepSession: n.kind === 'lead' ? false : Boolean(n.keepSession),
    refs: n.refs ? [...n.refs] : [],
    branches: n.branches ? [...n.branches].map((b) => ({ id: b.id, label: b.label })) : null,
  });
  const normTplEdge = (e) => ({
    from: e.from,
    to: e.to,
    type: e.type || 'prompt',
    branch: e.branch || '',
    loop: Boolean(e.loop),
    maxIterations: e.loop ? normalizeMaxIterations(e.maxIterations) : null,
  });
  for (let i = 0; i < BUILTIN_TEMPLATES.length; i += 1) {
    const be = BUILTIN_TEMPLATES[i];
    const ui = uiTemplates[i];
    assert.equal(ui.name, be.name, 'template zh name matches for ' + be.id);
    assert.deepEqual(
      [...ui.nodes].map(normTplNode),
      be.nodes.map(normTplNode),
      'template nodes match between client.js and lib/presets.js for ' + be.id,
    );
    assert.deepEqual(
      [...ui.edges].map(normTplEdge),
      be.edges.map(normTplEdge),
      'template edges match between client.js and lib/presets.js for ' + be.id,
    );
  }
});
