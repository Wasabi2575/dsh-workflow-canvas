import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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

function loadClientTestExports(storageMap, stateOverrides = {}) {
  let loaded = null;
  const store = storageMap instanceof Map ? storageMap : null;
  const mockLocalStorage = store
    ? {
        get length() { return store.size; },
        key: (i) => Array.from(store.keys())[i] ?? null,
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(String(k), String(v)); },
        removeItem: (k) => { store.delete(String(k)); },
      }
    : {
        getItem: () => null,
        setItem: () => {},
      };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) { loaded = mod; },
      },
      localStorage: mockLocalStorage,
    },
    console,
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Infinity,
    encodeURIComponent,
    decodeURIComponent,
  };
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // Seed real component state by hook declaration order, without rewriting the
  // renderer or mocking graph decisions. Each fixture gets a fresh component.
  const stateNames = [...code.slice(code.indexOf('function WorkflowCanvas(')).matchAll(/const \[(\w+),\s*\w+\] = useState\(/g)].map(m => m[1]);
  for (const key of Object.keys(stateOverrides)) assert.ok(stateNames.includes(key), 'known state fixture: ' + key);
  let stateIndex = 0;
  vm.runInNewContext(code, sandbox);
  assert.ok(loaded, 'client module registered');
  assert.equal(loaded.id, 'dsh-workflow-canvas', 'module id matches published package name');
  const mod = loaded.factory((name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (v) => {
          const name = stateNames[stateIndex++];
          return [Object.hasOwn(stateOverrides, name) ? stateOverrides[name] : (typeof v === 'function' ? v() : v), () => {}];
        },
        useRef: (v) => ({ current: v }),
        useEffect: () => {},
        Component: class {},
        Fragment: Symbol('Fragment'),
      };
    }
    throw new Error('unexpected require: ' + name);
  });
  return mod.__test;
}

const client = loadClientTestExports();

test('wouldCycle blocks cycles and edges pointing into entry Lead', () => {
  const nodes = [{ id: 'lead' }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
  const edges = [
    { from: 'lead', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ];
  assert.equal(client.wouldCycle(nodes, edges, 'c', 'a'), true);
  assert.equal(client.wouldCycle(nodes, edges, 'a', 'lead'), true);
  assert.equal(client.wouldCycle(nodes, edges, 'a', 'a'), true);
  assert.equal(client.wouldCycle(nodes, edges, 'a', 'c'), false);
});

test('soloLeadNodeIds skips blank-role solo chained Leads while keeping role-bearing or subagent-fed Leads active', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't' },
    { id: 'a1', kind: 'agent', label: 'Agent 1' },
    { id: 'a2', kind: 'agent', label: 'Agent 2' },
    { id: 'l1', kind: 'lead', label: 'Lead 1' },
    { id: 'l2', kind: 'lead', label: 'Lead 2', role: '' },
  ];
  // Solo chain l1 -> l2 with empty role and no subagent into l2: l2 is inactive/skipped
  const soloEdges = [
    { from: 'lead', to: 'a1', type: 'prompt' },
    { from: 'a1', to: 'l1', type: 'prompt' },
    { from: 'l1', to: 'l2', type: 'prompt' },
  ];
  assert.deepEqual(Array.from(client.soloLeadNodeIds(nodes, soloEdges)), ['l2']);
  const builtSolo = client.buildPlan(nodes, soloEdges);
  assert.ok(!builtSolo.error);
  assert.ok(builtSolo.plan.skipped.includes('Lead 2'));
  assert.ok(!builtSolo.plan.nodes.some((n) => n.id === 'l2'));

  // Chained Lead with non-empty role (main-conversation stage) stays active
  const stageNodes = nodes.map((n) => (n.id === 'l2' ? { ...n, role: '确认发布' } : n));
  assert.equal(client.soloLeadNodeIds(stageNodes, soloEdges).size, 0);
  const builtStage = client.buildPlan(stageNodes, soloEdges);
  assert.ok(!builtStage.error);
  assert.ok(builtStage.plan.nodes.some((n) => n.id === 'l2'));

  // Mixed chain l1 -> l2 AND a2 -> l2: l2 has a subagent upstream so it is active even without role
  const mixedEdges = [
    { from: 'lead', to: 'a1', type: 'prompt' },
    { from: 'a1', to: 'l1', type: 'prompt' },
    { from: 'l1', to: 'a2', type: 'prompt' },
    { from: 'l1', to: 'l2', type: 'prompt' },
    { from: 'a2', to: 'l2', type: 'prompt' },
  ];
  assert.equal(client.soloLeadNodeIds(nodes, mixedEdges).size, 0);
  const builtMixed = client.buildPlan(nodes, mixedEdges);
  assert.ok(!builtMixed.error);
  assert.ok(builtMixed.plan.nodes.some((n) => n.id === 'l2'));
});

test('layoutGraph lays out DAG columns cleanly without overlapping nodes', () => {
  const nodes = [
    { id: 'lead', x: 0, y: 0 },
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 0, y: 10 },
    { id: 'c', x: 0, y: 0 },
    { id: 'orphan', x: 0, y: 0 },
  ];
  const edges = [
    { from: 'lead', to: 'a' },
    { from: 'lead', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'c' },
  ];
  const laid = client.layoutGraph(nodes, edges);
  const byId = new Map(laid.map((n) => [n.id, n]));
  assert.ok(byId.get('lead').x < byId.get('a').x);
  assert.equal(byId.get('a').x, byId.get('b').x);
  assert.notEqual(byId.get('a').y, byId.get('b').y);
  assert.ok(byId.get('a').x < byId.get('c').x);
  assert.ok(byId.get('c').x < byId.get('orphan').x);
});

test('builtinTemplates returns valid acyclic templates and buildPlan accepts blank task', () => {
  for (const lang of ['zh', 'en']) {
    const templates = client.builtinTemplates(lang);
    assert.ok(templates.length >= 3);
    const swe = templates.find((t) => t.id === 'tpl-swe');
    assert.ok(swe, 'includes SWE delivery template in ' + lang);
    const types = new Set(swe.edges.map((e) => e.type));
    assert.ok(types.has('prompt') && types.has('structured') && types.has('session-ref'), 'SWE template showcases all 3 link types');
    const byId = new Map(swe.nodes.map((n) => [n.id, n]));
    assert.ok(byId.get('swe_scan').y > byId.get('swe_risk').y, 'scan sits on bottom channel for unobstructed session arc');
    assert.ok(byId.get('swe_impl').y > byId.get('swe_tests').y, 'impl sits on bottom channel for unobstructed session arc');
    for (const tpl of templates) {
      assert.ok(tpl.nodes.some((n) => n.id === 'lead'));
      assert.ok(client.topoOrder(tpl.nodes, tpl.edges), tpl.id + ' is acyclic');
      const built = client.buildPlan(tpl.nodes, tpl.edges);
      assert.ok(!built.error, tpl.id + ' builds cleanly even when task is blank: ' + built.error);
      assert.equal(client.deadEndNodeIds(tpl.nodes, tpl.edges).size, 0, tpl.id + ' has no dead-end warnings');
    }
    const ab = templates.find((t) => t.id === 'tpl-ab');
    assert.ok(ab && ab.nodes.some((n) => n.id === 'n_review' && n.kind === 'lead'), 'AB template ends with a terminal Lead');
  }
});

test('deadEndNodeIds warns on unlinked agents before/beside a Lead, but not on terminal agents after a Lead', () => {
  const withDeadEnd = client.deadEndNodeIds(
    [
      { id: 'lead', kind: 'lead' },
      { id: 'a', kind: 'agent' },
      { id: 'b', kind: 'agent' },
      { id: 'final', kind: 'lead' },
    ],
    [
      { from: 'lead', to: 'a' },
      { from: 'lead', to: 'b' },
      { from: 'a', to: 'final' },
    ],
  );
  assert.deepEqual(Array.from(withDeadEnd), ['b']);

  const leafAfterLead = client.deadEndNodeIds(
    [
      { id: 'lead', kind: 'lead' },
      { id: 'a', kind: 'agent' },
      { id: 'pick', kind: 'lead' },
      { id: 'exec', kind: 'agent' },
    ],
    [
      { from: 'lead', to: 'a' },
      { from: 'a', to: 'pick' },
      { from: 'pick', to: 'exec' },
    ],
  );
  assert.equal(leafAfterLead.size, 0, 'terminal agent strictly downstream of an intermediate Lead is not a dead-end');
});

test('no-outgoing warnings survive sequential cuts without disabling legal terminal agents', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't' },
    { id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' },
    { id: 'review', kind: 'lead' },
  ];
  const roots = [{ from: 'lead', to: 'a' }, { from: 'lead', to: 'b' }];
  for (const first of ['a', 'b']) {
    const other = first === 'a' ? 'b' : 'a';
    const oneCut = client.classifyCanvasNodes(nodes, [...roots, { from: other, to: 'review' }]);
    assert.deepEqual([...oneCut.noOutgoing], [first]);
    assert.deepEqual([...oneCut.deadEnds], [first]);
    const bothCut = client.classifyCanvasNodes(nodes, roots);
    assert.deepEqual([...bothCut.noOutgoing].sort(), ['a', 'b']);
    assert.equal(bothCut.deadEnds.size, 0, 'terminal-agent execution remains compatible');
    assert.deepEqual([...client.buildPlan(nodes, roots).plan.nodes].map(n => n.id), ['a', 'b']);
    const last = client.classifyCanvasNodes(nodes, [{ from: 'lead', to: other }]);
    assert.deepEqual([...last.noOutgoing], [other]);
  }
});

test('inactive Leads block descendants but independent paths and role-bearing Lead stages remain valid', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't' }, { id: 'solo', kind: 'lead' },
    { id: 'tail', kind: 'agent' }, { id: 'review', kind: 'lead' },
  ];
  const edges = [{ from: 'lead', to: 'solo' }, { from: 'solo', to: 'tail' }, { from: 'tail', to: 'review' }];
  const blocked = client.classifyCanvasNodes(nodes, edges);
  assert.deepEqual([...blocked.soloLeads], ['solo']);
  assert.deepEqual([...blocked.reachable], ['lead']);
  assert.ok(client.buildPlan(nodes, edges).error, 'never exports an orphan tail');
  const roleNodes = nodes.map(n => n.id === 'solo' ? { ...n, role: 'Confirm' } : n);
  assert.equal(client.buildPlan(roleNodes, edges).plan.nodes.length, 3);
  const alternate = [...edges, { from: 'lead', to: 'tail' }];
  const plan = client.buildPlan(nodes, alternate).plan;
  assert.deepEqual([...plan.nodes].map(n => n.id), ['tail', 'review']);
  assert.ok(!plan.edges.some(e => e.from === 'solo' || e.to === 'solo'));
  assert.ok(inactiveNodeSets(plan.nodes, plan.edges).reachable.has('review'));
});

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

test('inactive border stays dashed over selection, warning and historical run borders', () => {
  for (const state of [null, client.S.nodeSel, { border: '1px solid orange' }, { border: '1.5px solid blue' }, { border: '1px solid green' }]) {
    const style = client.nodeActivityStyle(state, true);
    assert.match(style.border, /\bdashed\b/);
    assert.equal(style.borderStyle, undefined, 'no shorthand/longhand conflicts on React updates');
    assert.equal(style.opacity, 0.65);
    if (state?.border) assert.equal(style.border, state.border.replace('solid', 'dashed'), 'state color/width preserved');
    assert.deepEqual({ ...client.nodeActivityStyle(state, false) }, { ...(state || {}) });
  }
});

test('rendered warning and inactive cards agree in zh/en, lr/tb, enabled and disabled canvases', () => {
  const descendants = (tree) => {
    if (Array.isArray(tree)) return tree.flatMap(descendants);
    if (tree && typeof tree === 'object') return [tree, ...descendants(tree.children)];
    return [];
  };
  const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf(tree.children) : typeof tree === 'string' ? tree : '';
  for (const lang of ['zh', 'en']) for (const direction of ['lr', 'tb']) for (const enabled of [false, true]) {
    const sid = 'render-validity';
    const nodes = [
      { id: 'lead', kind: 'lead', task: 't', x: 0, y: 0 },
      { id: 'solo', kind: 'lead', x: 300, y: 0 },
      { id: 'blocked', kind: 'agent', x: 600, y: 0 },
      { id: 'a', kind: 'agent', x: 300, y: 300 },
      { id: 'b', kind: 'agent', x: 300, y: 600 },
    ];
    const edges = [
      { from: 'lead', to: 'solo' }, { from: 'solo', to: 'blocked' },
      { from: 'lead', to: 'a' }, { from: 'lead', to: 'b' },
    ];
    const store = new Map([[client.storageKey(sid), JSON.stringify({ nodes, edges, direction, enabled })]]);
    store.set('dsh-workflow-canvas:v1:lang', lang);
    const c = loadClientTestExports(store);
    const tree = c.WorkflowCanvas({ sessionId: sid });
    const cards = new Map(descendants(tree).filter(el => el.props['data-node']).map(el => [el.props['data-node'], el]));
    assert.equal(cards.size, 5);
    for (const id of ['solo', 'blocked']) assert.match(cards.get(id).props.style.border, /\bdashed\b/);
    for (const id of ['a', 'b']) {
      assert.match(cards.get(id).props.style.border, /\bdashed\b/);
      assert.ok(textOf(cards.get(id)).includes(c.I18N[lang].stDeadEnd));
      const chip = descendants(cards.get(id)).find(el => el.props.title === c.I18N[lang].tipTerminal && el.props.style?.bottom);
      assert.ok(chip, 'terminal warning chip rendered');
      for (const key of ['border', 'background', 'color', 'borderRadius', 'fontSize', 'padding']) {
        assert.equal(chip.props.style[key], c.S.warnChip[key], 'original yellow warning style: ' + key);
      }
      assert.equal(chip.props.style.bottom, direction === 'tb' ? '28px' : '5px');
    }
  }
});

test('entry -> agent -> agent always renders the original yellow no-outgoing badge and dashed terminal border', () => {
  const all = tree => Array.isArray(tree) ? tree.flatMap(all) : tree && typeof tree === 'object' ? [tree, ...all(tree.children)] : [];
  const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.children) : typeof tree === 'string' ? tree : '';
  for (const lang of ['zh', 'en']) for (const direction of ['lr', 'tb']) for (const enabled of [false, true]) {
    for (const historical of [undefined, 'running', 'done', 'failed']) {
      const sid = 'no-outgoing-chain';
      const nodes = [
        { id: 'lead', kind: 'lead', task: 't', x: 0, y: 0 },
        { id: 'a', kind: 'agent', x: 300, y: 0 },
        { id: 'b', kind: 'agent', x: 600, y: 0 },
      ];
      const edges = [{ from: 'lead', to: 'a' }, { from: 'a', to: 'b' }];
      const store = new Map([
        [client.storageKey(sid), JSON.stringify({ nodes, edges, direction, enabled })],
        ['dsh-workflow-canvas:v1:lang', lang],
      ]);
      const c = loadClientTestExports(store, {
        selectedIds: ['b'], statusById: historical ? { b: historical } : {},
        runsById: historical ? { b: { childId: 'kid-b' } } : {},
      });
      const tree = c.WorkflowCanvas({ sessionId: sid });
      const cards = new Map(all(tree).filter(el => el.props['data-node']).map(el => [el.props['data-node'], el]));
      const b = cards.get('b');
      assert.match(b.props.style.border, /\bdashed\b/);
      assert.equal(b.props.style.opacity, undefined, 'legal terminal stays full brightness (opacity: 1), only dashed border + yellow badge');
      assert.ok(!text(cards.get('a')).includes(c.I18N[lang].stDeadEnd), 'a has an outgoing link');
      const badges = all(b).filter(el => el.props.style?.border === c.S.warnChip.border);
      assert.equal(badges.length, 1, 'exactly one original yellow warning, even with historical state');
      const badge = badges[0];
      const runtimeKey = enabled && historical ? { running: 'stRunning', done: 'stDone', failed: 'stFailed' }[historical] : null;
      assert.equal(text(badge), '⚠ ' + c.I18N[lang].stDeadEnd + (runtimeKey ? ' · ' + c.I18N[lang][runtimeKey] : '') + (historical ? ' ↗' : ''));
      if (runtimeKey) assert.ok(badge.props.title.includes(c.I18N[lang][runtimeKey]));
      assert.equal(badge.props.style.color, c.S.warnChip.color);
      assert.equal(badge.props.style.background, c.S.warnChip.background);
      assert.equal(badge.props.style.bottom, direction === 'tb' ? '28px' : '5px');
      if (historical) {
        assert.equal(badge.type, 'button');
        assert.equal(badge.props.style.outline, 'none');
        assert.equal(typeof badge.props.onClick, 'function', 'history remains accessible');
      }
      assert.deepEqual([...c.buildPlan(nodes, edges).plan.nodes].map(n => n.id), ['a', 'b'], 'execution compatibility preserved');
    }
  }
});

test('terminal and skipped no-outgoing nodes use identical yellow badges, not two status styles', () => {
  const all = tree => Array.isArray(tree) ? tree.flatMap(all) : tree && typeof tree === 'object' ? [tree, ...all(tree.children)] : [];
  const sid = 'no-outgoing-two-styles';
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't' },
    { id: 'review', kind: 'lead', role: 'Confirm' },
    { id: 'terminal', kind: 'agent' }, { id: 'dangling', kind: 'agent' },
  ].map((n, i) => ({ ...n, x: i * 300, y: 0 }));
  const edges = [{ from: 'lead', to: 'review' }, { from: 'review', to: 'terminal' }, { from: 'lead', to: 'dangling' }];
  const c = loadClientTestExports(new Map([[client.storageKey(sid), JSON.stringify({ nodes, edges, enabled: true })]]));
  const activity = c.classifyCanvasNodes(nodes, edges);
  assert.deepEqual([...activity.deadEnds], ['dangling']);
  const cards = new Map(all(c.WorkflowCanvas({ sessionId: sid })).filter(el => el.props['data-node']).map(el => [el.props['data-node'], el]));
  const styles = ['terminal', 'dangling'].map(id => {
    assert.match(cards.get(id).props.style.border, /\bdashed\b/);
    return all(cards.get(id)).find(el => el.props.style?.border === c.S.warnChip.border).props.style;
  });
  assert.equal(cards.get('terminal').props.style.opacity, undefined, 'executable terminal stays full brightness');
  assert.equal(cards.get('dangling').props.style.opacity, 0.65, 'truly skipped dead-end is dimmed');
  assert.deepEqual({ ...styles[0] }, { ...styles[1] });
});


test('buildPlan rejects raw forward cycles before inactive-node filtering', () => {
  const nodes = [{ id: 'lead', kind: 'lead', task: 't' }, { id: 'a' }, { id: 'b' }, { id: 'safe', kind: 'lead', role: 'Confirm' }];
  const edges = [{ from: 'lead', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'lead', to: 'safe' }];
  const built = client.buildPlan(nodes, edges);
  assert.match(built.error, /前向环/);
  assert.equal(built.plan, undefined);
});

test('buildPlan reports loops broken only by inactive Lead barriers, never silently drops them', () => {
  const nodes = [{ id: 'lead', kind: 'lead', task: 't' }, { id: 'a', kind: 'agent' }, { id: 'stage', kind: 'lead' }, { id: 'solo', kind: 'lead' }, { id: 'c', kind: 'condition' }];
  const edges = [{ from: 'lead', to: 'a' }, { from: 'a', to: 'stage' }, { from: 'stage', to: 'solo' }, { from: 'solo', to: 'c' }, { from: 'lead', to: 'c' }, { from: 'c', to: 'a', loop: true, branch: 'false' }];
  assert.match(client.buildPlan(nodes, edges).error, /回环.*无效节点/);
  const fixed = nodes.map(n => n.id === 'solo' ? { ...n, role: 'Review' } : n);
  assert.equal(client.buildPlan(fixed, edges).plan.edges.filter(e => e.loop).length, 1);
});

test('classification cache ignores geometry but invalidates roles, kinds, endpoints and loops', () => {
  const nodes = [{ id: 'lead', kind: 'lead' }, { id: 'a', kind: 'agent' }];
  const edges = [{ from: 'lead', to: 'a' }];
  const key = client.canvasActivityKey(nodes, edges);
  assert.equal(client.canvasActivityKey(nodes.map(n => ({ ...n, x: 4, y: 7, label: 'Renamed', task: 'Changed' })), edges), key);
  assert.notEqual(client.canvasActivityKey(nodes.map(n => ({ ...n, role: 'Review' })), edges), key);
  assert.notEqual(client.canvasActivityKey(nodes.map(n => ({ ...n, kind: 'lead' })), edges), key);
  assert.notEqual(client.canvasActivityKey(nodes, [{ from: 'a', to: 'lead' }]), key);
  assert.notEqual(client.canvasActivityKey(nodes, [{ ...edges[0], loop: true }]), key);
});

test('Lead ancestry bitsets support many Leads, preserve terminals and prune long chains', () => {
  const leads = Array.from({ length: 80 }, (_, i) => ({ id: 'l' + i, kind: 'lead', role: 'Review' }));
  const chain = Array.from({ length: 8000 }, (_, i) => ({ id: 'a' + i, kind: 'agent' }));
  const nodes = [{ id: 'lead', kind: 'lead' }, ...leads, { id: 'terminal', kind: 'agent' }, { id: 'beforeLast', kind: 'agent' }, ...chain];
  const edges = [{ from: 'lead', to: 'l0' }, ...leads.slice(1).map((n, i) => ({ from: 'l' + i, to: n.id })), { from: 'l79', to: 'terminal' }, { from: 'l78', to: 'beforeLast' }, { from: 'lead', to: 'a0' }, ...chain.slice(1).map((n, i) => ({ from: 'a' + i, to: n.id }))];
  for (const classify of [client.classifyCanvasNodes, inactiveNodeSets]) {
    const result = classify(nodes, edges);
    assert.equal(result.deadEnds.size, chain.length + 1);
    assert.ok(result.deadEnds.has('beforeLast'), 'missing even one Lead bit above bit 64 prevents terminal exemption');
    assert.ok(!result.deadEnds.has('terminal'), 'all 80 Leads are terminal ancestors');
    assert.ok(result.deadEnds.has('a0') && result.deadEnds.has('a7999'));
  }
});


test('optimized Lead ancestry matches independent full ancestor walks on seeded DAGs', () => {
  let seed = 91;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let sample = 0; sample < 200; sample++) {
    const nodes = [{ id: 'lead', kind: 'lead' }, ...Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i, kind: rnd() < 0.4 ? 'lead' : 'agent', role: rnd() < 0.5 ? 'Review' : '' }))];
    const edges = nodes.flatMap((n, i) => nodes.slice(i + 1).filter(() => rnd() < 0.22).map(to => ({ from: n.id, to: to.id })));
    const result = inactiveNodeSets(nodes, edges);
    const activeLeads = nodes.filter(n => n.id !== 'lead' && n.kind === 'lead' && result.reachable.has(n.id));
    const expected = new Set();
    let changed;
    do {
      changed = false;
      for (const n of nodes) {
        if (n.kind === 'lead' || !result.reachable.has(n.id) || expected.has(n.id)) continue;
        if (edges.some(e => e.from === n.id && result.reachable.has(e.to) && !expected.has(e.to))) continue;
        const ancestors = new Set(), stack = [n.id];
        while (stack.length) {
          const id = stack.pop();
          for (const e of edges) if (e.to === id && result.reachable.has(e.from) && !ancestors.has(e.from)) {
            ancestors.add(e.from); stack.push(e.from);
          }
        }
        if (activeLeads.some(l => !ancestors.has(l.id))) { expected.add(n.id); changed = true; }
      }
    } while (changed);
    assert.deepEqual([...result.deadEnds].sort(), [...expected].sort(), 'sample ' + sample);
    assert.deepEqual([...client.classifyCanvasNodes(nodes, edges).deadEnds].sort(), [...expected].sort());
  }
});

test('yellow warnings retain pruned runtime state and never claim a skipped node will execute', () => {
  const all = tree => Array.isArray(tree) ? tree.flatMap(all) : tree && typeof tree === 'object' ? [tree, ...all(tree.children)] : [];
  const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.children) : typeof tree === 'string' ? tree : '';
  for (const lang of ['zh', 'en']) for (const direction of ['lr', 'tb']) {
    const sid = 'pruned-warning';
    const doc = { enabled: true, direction, nodes: [{ id: 'lead', kind: 'lead', task: 't', x: 0, y: 0 }, { id: 'b', kind: 'agent', x: 300, y: 0 }], edges: [{ from: 'lead', to: 'b' }] };
    const c = loadClientTestExports(new Map([[client.storageKey(sid), JSON.stringify(doc)], ['dsh-workflow-canvas:v1:lang', lang]]), { statusById: { b: 'done' }, runState: { status: 'done', pruned: ['b'] }, runsById: { b: { childId: 'old' } } });
    const card = all(c.WorkflowCanvas({ sessionId: sid })).find(el => el.props['data-node'] === 'b');
    const badge = all(card).find(el => el.props.style?.border === c.S.warnChip.border);
    assert.ok(text(badge).includes(c.I18N[lang].stPruned));
    assert.ok(!text(badge).includes(c.I18N[lang].stDone));
    assert.ok(badge.props.title.includes(c.I18N[lang].tipPruned));
    assert.ok(!badge.props.title.includes(c.I18N[lang].tipTerminal));
    assert.equal(card.props.style.opacity, 0.65, 'pruned node is dimmed');
    assert.equal(badge.props.style.maxWidth, direction === 'tb' ? 'calc(100% - 20px)' : 'calc(100% - 72px)', 'reserve socket-label room in lr and use full width in tb');
    assert.equal(badge.type, 'button', 'old history stays accessible without implying this run executed');
    assert.ok(text(badge).endsWith(' ↗'), 'clickable yellow history badge shows open-chat arrow');
  }
});

test('buildPlan rejects overlapping/non-condition loops, dead loop islands peel cleanly, and null/duplicate nodes never crash', () => {
  // 1) Non-condition loop source rejected in buildPlan
  const nonCond = client.buildPlan(
    [{ id: 'lead', kind: 'lead', task: 't' }, { id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }],
    [{ from: 'lead', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a', loop: true }],
  );
  assert.match(nonCond.error, /条件判断节点/);

  // 2) Overlapping loops rejected in buildPlan
  const overlap = client.buildPlan(
    [
      { id: 'lead', kind: 'lead', task: 't' },
      { id: 'a', kind: 'agent' },
      { id: 'b', kind: 'agent' },
      { id: 'c1', kind: 'condition' },
      { id: 'c2', kind: 'condition' },
      { id: 'end', kind: 'lead', role: 'Done' },
    ],
    [
      { from: 'lead', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c1' },
      { from: 'c1', to: 'c2', branch: 'true' }, { from: 'c2', to: 'end', branch: 'true' },
      { from: 'c1', to: 'a', branch: 'false', loop: true },
      { from: 'c2', to: 'b', branch: 'false', loop: true },
    ],
  );
  assert.match(overlap.error, /交叉或重叠/);

  // 3) Loop-only dead island beside an active Lead is caught by both noOutgoing and deadEnds (client & backend)
  const islandNodes = [
    { id: 'lead', kind: 'lead', task: 't' },
    { id: 'review', kind: 'lead', role: 'Confirm' },
    { id: 'w', kind: 'agent' },
    { id: 'g', kind: 'condition' },
  ];
  const islandEdges = [
    { from: 'lead', to: 'review' },
    { from: 'lead', to: 'w' },
    { from: 'w', to: 'g' },
    { from: 'g', to: 'w', branch: 'false', loop: true },
  ];
  for (const fn of [client.classifyCanvasNodes, inactiveNodeSets]) {
    const cls = fn(islandNodes, islandEdges);
    assert.deepEqual([...cls.noOutgoing], ['g'], 'condition with only a loop back-edge has no forward exit');
    assert.deepEqual([...cls.deadEnds].sort(), ['g', 'w'], 'dead loop island beside active Lead peels cleanly');
  }
  const builtIsland = client.buildPlan(islandNodes, islandEdges);
  assert.ok(!builtIsland.error);
  assert.deepEqual([...builtIsland.plan.nodes].map((n) => n.id), ['review']);

  // 4) Null elements & duplicate Lead IDs never crash or corrupt allLeadBits
  const dirtyNodes = [
    null,
    { id: 'lead', kind: 'lead' },
    { id: 'l1', kind: 'lead', role: 'R' },
    { id: 'l1', kind: 'lead', role: 'R' },
    { id: 'term', kind: 'agent' },
  ];
  const dirtyEdges = [null, { from: 'lead', to: 'l1' }, { from: 'l1', to: 'term' }];
  for (const fn of [client.classifyCanvasNodes, inactiveNodeSets]) {
    const cls = fn(dirtyNodes, dirtyEdges);
    assert.equal(cls.deadEnds.size, 0, 'duplicate Lead ID must not corrupt allLeadBits and misclassify terminal');
    assert.deepEqual([...cls.noOutgoing], ['term']);
  }

  // 5) nodeActivityStyle supports dashed-without-dimming and handles missing border safely
  const brightDashed = client.nodeActivityStyle({ boxShadow: '0 0 4px gold' }, true, false);
  assert.match(brightDashed.border, /\bdashed\b/);
  assert.equal(brightDashed.opacity, undefined);
});

test('findNearestInputSnap magnetically captures nearby input sockets in lr/tb and ignores self or entry Lead', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', x: 0, y: 0 },
    { id: 'a', kind: 'agent', x: 300, y: 100 },
    { id: 'b', kind: 'agent', x: 600, y: 100 },
  ];
  // Horizontal (lr): input socket of `b` is at (600, 100 + socketCenterY(0))
  const inB = client.inputSocketPos(nodes[2], 'lr');
  const hitLR = client.findNearestInputSnap({ x: inB.x - 16, y: inB.y + 12 }, nodes, 'a', 'lr', 1);
  assert.ok(hitLR && hitLR.nodeId === 'b' && hitLR.x === inB.x && hitLR.y === inB.y);

  // Outside 23px radius at 100% zoom -> returns null so blank-space drag stays crisp
  assert.equal(client.findNearestInputSnap({ x: inB.x - 30, y: inB.y }, nodes, 'a', 'lr', 1), null);

  // Never snaps to entry Lead or to source node itself
  const inA = client.inputSocketPos(nodes[1], 'lr');
  assert.equal(client.findNearestInputSnap({ x: inA.x, y: inA.y }, nodes, 'a', 'lr', 1), null);
  const inLead = client.inputSocketPos(nodes[0], 'lr');
  assert.equal(client.findNearestInputSnap({ x: inLead.x, y: inLead.y }, nodes, 'a', 'lr', 1), null);

  // Vertical (tb) + zoomed out (0.5x expands snap radius gently up to 36px)
  const inBTB = client.inputSocketPos(nodes[2], 'tb');
  const hitZoomedOut = client.findNearestInputSnap({ x: inBTB.x + 32, y: inBTB.y }, nodes, 'a', 'tb', 0.5);
  assert.ok(hitZoomedOut && hitZoomedOut.nodeId === 'b' && hitZoomedOut.x === inBTB.x && hitZoomedOut.y === inBTB.y);
  assert.equal(client.findNearestInputSnap({ x: inBTB.x + 42, y: inBTB.y }, nodes, 'a', 'tb', 0.5), null);
});

test('nextEffectLevel cycles minimal -> standard -> vivid -> minimal', () => {
  assert.equal(client.nextEffectLevel('minimal'), 'standard');
  assert.equal(client.nextEffectLevel('standard'), 'vivid');
  assert.equal(client.nextEffectLevel('vivid'), 'minimal');
});

test('nextMaxParallel cycles 1 -> 2 -> 4 -> 6 -> 8 -> 1 and buildPlan carries maxParallel', () => {
  assert.equal(client.nextMaxParallel(1), 2);
  assert.equal(client.nextMaxParallel(2), 4);
  assert.equal(client.nextMaxParallel(4), 6);
  assert.equal(client.nextMaxParallel(6), 8);
  assert.equal(client.nextMaxParallel(8), 1);
  const built = client.buildPlan(
    [{ id: 'lead', kind: 'lead', task: 't' }, { id: 'a', kind: 'agent', label: 'A' }],
    [{ from: 'lead', to: 'a', type: 'prompt' }],
    { maxParallel: 6 },
  );
  assert.equal(built.plan.maxParallel, 6);
});

test('zoomAroundPoint keeps the content point under cursor pinned across rapid ticks', () => {
  const start = { k: 0.75, x: -1200, y: -1100 };
  const mx = 340;
  const my = 220;
  const worldXBefore = (mx - start.x) / start.k;
  const worldYBefore = (my - start.y) / start.k;

  // deltaY === 0 must be a no-op (must not zoom out)
  assert.equal(client.zoomAroundPoint(start, mx, my, 0, 0), start);

  // Simulate 5 rapid consecutive ticks before a React paint
  let cur = start;
  for (let i = 0; i < 5; i += 1) {
    cur = client.zoomAroundPoint(cur, mx, my, -100, 0);
  }
  assert.ok(cur.k > start.k);
  const screenXAfter = cur.x + worldXBefore * cur.k;
  const screenYAfter = cur.y + worldYBefore * cur.k;
  assert.ok(Math.abs(screenXAfter - mx) < 1e-6, 'x stays locked under cursor');
  assert.ok(Math.abs(screenYAfter - my) < 1e-6, 'y stays locked under cursor');

  // Trackpad tiny delta zooms gently rather than jumping 12%
  const gentle = client.zoomAroundPoint(start, mx, my, -6, 0);
  assert.ok(gentle.k > start.k && gentle.k < start.k * 1.02);
});

test('scrubZoom scales smoothly right/left around viewport center and stays clamped', () => {
  const start = { k: 1, x: -1600, y: -1500 };
  const cx = 400;
  const cy = 300;
  const worldX = (cx - start.x) / start.k;
  const worldY = (cy - start.y) / start.k;

  const zoomedIn = client.scrubZoom(start, cx, cy, 140);
  const zoomedOut = client.scrubZoom(start, cx, cy, -140);
  assert.ok(zoomedIn.k > 1.9 && zoomedIn.k < 2.1);
  assert.ok(zoomedOut.k > 0.45 && zoomedOut.k < 0.55);
  assert.ok(Math.abs(zoomedIn.x + worldX * zoomedIn.k - cx) < 1e-6);
  assert.ok(Math.abs(zoomedIn.y + worldY * zoomedIn.k - cy) < 1e-6);
  assert.equal(client.scrubZoom(start, cx, cy, 2000).k, 3);
  assert.equal(client.scrubZoom(start, cx, cy, -2000).k, 0.2);
});

test('vivid edge glow does not use an objectBoundingBox SVG filter (which clips horizontal edges to 0px)', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /url\(#dsh-wc-glow\)/, 'edges must not depend on an objectBoundingBox SVG filter');
  const swe = client.builtinTemplates('zh').find((t) => t.id === 'tpl-swe');
  const byId = new Map(swe.nodes.map((n) => [n.id, n]));
  const blue = swe.edges.find((e) => e.type === 'structured');
  assert.ok(blue, 'SWE template has a structured blue edge');
  const curve = client.edgeCurve(byId.get(blue.from), byId.get(blue.to), blue);
  assert.equal(curve.y1, byId.get(blue.from).y + 2000 + client.socketCenterY(1), 'structured exits Row 1');
  assert.equal(curve.y2, byId.get(blue.to).y + 2000 + client.socketCenterY(0), 'unified left input enters Row 0');
});

test('condition template, switch/case branches, edgeCurve geometry, and buildPlan preserve kind and branches', () => {
  const condTpl = client.builtinTemplates('zh').find((t) => t.id === 'tpl-cond');
  assert.ok(condTpl, 'includes conditional branching starter template');
  const condNode = condTpl.nodes.find((n) => n.kind === 'condition');
  assert.ok(condNode, 'conditional template contains a condition node');
  const trueEdge = condTpl.edges.find((e) => e.from === condNode.id && e.branch === 'true');
  const falseEdge = condTpl.edges.find((e) => e.from === condNode.id && e.branch === 'false');
  assert.ok(trueEdge && falseEdge, 'condition node has both true and false branch edges');

  const from = { x: 100, y: 100 };
  const to = { x: 400, y: 100 };
  const cTrue = client.edgeCurve(from, to, { type: 'prompt', branch: 'true' });
  const cFalse = client.edgeCurve(from, to, { type: 'prompt', branch: 'false' });
  const cSession = client.edgeCurve(from, to, { type: 'session-ref' });
  assert.equal(cTrue.y1, from.y + 2000 + 176 + 10, 'true branch exits Row 0 center (COND_ROW_H=20)');
  assert.equal(cFalse.y1, from.y + 2000 + 176 + 20 + 10, 'false branch exits Row 1 center (COND_ROW_H=20)');
  assert.equal(cTrue.y2, to.y + 2000 + client.socketCenterY(0), 'true branch enters unified input Row 0');
  assert.equal(cFalse.y2, to.y + 2000 + client.socketCenterY(0), 'false branch enters unified input Row 0');
  assert.equal(cSession.y1, from.y + 2000 + client.socketCenterY(2), 'session exits Row 2');
  assert.equal(cSession.y2, to.y + 2000 + client.socketCenterY(0), 'session enters unified input Row 0');

  const switchNode = {
    id: 'sw',
    kind: 'condition',
    label: '多路分流',
    multiMatch: true,
    x: 100,
    y: 100,
    branches: [
      { id: 'c1', label: '前端' },
      { id: 'c2', label: '后端' },
      { id: 'c3', label: '单测' },
      { id: 'c4', label: '文档' },
      { id: 'c5', label: '性能' },
      { id: 'c6', label: '安全' },
    ],
  };
  assert.equal(client.nodeHeight(switchNode), 176 + 6 * 20 + 24, '6-branch switch/case node scales smoothly past 5');
  const cRedo = client.edgeCurve(switchNode, to, { type: 'prompt', branch: 'c3' });
  assert.equal(cRedo.y1, switchNode.y + 2000 + 176 + 2 * 20 + 10, '3rd branch exits Row 2 center');

  const built = client.buildPlan(
    [
      { id: 'lead', kind: 'lead', task: 'switch test' },
      switchNode,
      { id: 'n1', kind: 'agent', label: 'A' },
    ],
    [
      { from: 'lead', to: 'sw', type: 'prompt' },
      { from: 'sw', to: 'n1', type: 'prompt', branch: 'c2' },
    ],
  );
  assert.ok(!built.error);
  const planSw = built.plan.nodes.find((n) => n.id === 'sw');
  assert.equal(planSw.kind, 'condition');
  assert.equal(planSw.branches.length, 6);
  assert.equal(planSw.multiMatch, true);
  assert.equal(built.plan.edges.find((e) => e.from === 'sw').branch, 'c2');
});

test('dropdownAlign flips to left-anchored when trigger wraps to the left edge of the pane', () => {
  const pane = { left: 100, right: 420 };
  // Trigger wrapped to left edge of row 2 (only 42px from pane left -> right-align would clip)
  assert.equal(client.dropdownAlign({ left: 110, right: 142 }, pane, 204), 'left');
  // Trigger sitting near right edge (310px from pane left -> right-align fits cleanly)
  assert.equal(client.dropdownAlign({ left: 378, right: 410 }, pane, 204), 'right');
});

test('compatibleTargetsForWire allows Lead -> Lead stage chains as well as Subagent/Condition targets', () => {
  const fromLead = client.compatibleTargetsForWire({ id: 'lead', kind: 'lead' }, 'prompt');
  assert.deepEqual({ ...fromLead }, { agent: true, lead: true, condition: true, leadBlockedReason: '' });

  const fromAgent = client.compatibleTargetsForWire({ id: 'n1', kind: 'agent' }, 'structured');
  assert.deepEqual({ ...fromAgent }, { agent: true, lead: true, condition: true, leadBlockedReason: '' });

  const fromCond = client.compatibleTargetsForWire({ id: 'c1', kind: 'condition' }, 'prompt');
  assert.deepEqual({ ...fromCond }, { agent: true, lead: true, condition: true, leadBlockedReason: '' });
});

test('conditionVerdictSummary formats matched, unmatched, and failed verdicts in zh/en', () => {
  assert.equal(client.conditionVerdictSummary(null, 'zh'), null);
  assert.deepEqual(
    { ...client.conditionVerdictSummary({ branches: ['c1', 'c2'], branchLabels: ['前端', '单测'], reason: '需同步改' }, 'zh') },
    { tone: 'ok', text: '→ 前端 · 单测' },
  );
  assert.deepEqual(
    { ...client.conditionVerdictSummary({ branches: [], branchLabels: [], fallbackLead: '终审' }, 'zh') },
    { tone: 'warn', text: '⚠ 未命中 → 终审' },
  );
  assert.deepEqual(
    { ...client.conditionVerdictSummary({ branches: [], branchLabels: [], failed: true, fallbackLead: 'Final Lead' }, 'en') },
    { tone: 'failed', text: '⚠ Judge failed → Final Lead' },
  );
});

test('entryRunButtonState covers ready, disabled (off/empty), running, and waitingLead states', () => {
  const off = client.entryRunButtonState({ enabled: false, task: 'do x', sessionRunning: false, waitingLead: null, triggering: false, lang: 'zh' });
  assert.equal(off.state, 'disabled');
  assert.equal(off.disabled, true);
  assert.ok(off.title.includes('ON'));

  const empty = client.entryRunButtonState({ enabled: true, task: '   ', sessionRunning: false, waitingLead: null, triggering: false, lang: 'en' });
  assert.equal(empty.state, 'disabled');
  assert.equal(empty.disabled, true);
  assert.ok(empty.title.includes('task'));

  const ready = client.entryRunButtonState({ enabled: true, task: 'review code', sessionRunning: false, waitingLead: null, triggering: false, lang: 'zh' });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.disabled, false);
  assert.ok(ready.title.includes('retryFailed') && ready.title.includes('reset'));

  const running = client.entryRunButtonState({ enabled: true, task: 'review code', sessionRunning: true, waitingLead: null, triggering: false, lang: 'zh' });
  assert.equal(running.state, 'running');
  assert.equal(running.disabled, true);

  const waiting = client.entryRunButtonState({ enabled: true, task: 'review code', sessionRunning: false, waitingLead: { id: 'l2', label: '中审' }, triggering: false, lang: 'zh' });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.disabled, true);
  assert.ok(waiting.title.includes('中审'));
});

test('popup surfaces do not hardcode dark hex fallbacks and explicitly inherit theme foreground color', () => {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /#2a2b2f/i, 'C.elevated must not hardcode a dark hex fallback that breaks light themes');
  assert.match(src, /elevated:\s*'var\(--dsw-alias-bg-elevated,\s*var\(--dsw-alias-bg-popover,/, 'C.elevated chains through host surface tokens');
  assert.match(src, /menu:\s*\{[^}]*background:\s*C\.elevated,\s*color:\s*C\.text/s, 'dropdown menu sets explicit foreground color');
  assert.match(src, /menuRow:\s*\{[^}]*color:\s*C\.text/s, 'dropdown menu rows set explicit foreground color');
});

test('vertical (tb) layout stacks layers top-to-bottom and connects bottom-to-top curves', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', x: 0, y: 0 },
    { id: 'a', kind: 'agent', x: 0, y: 0 },
    { id: 'b', kind: 'agent', x: 100, y: 0 },
    { id: 'c', kind: 'condition', x: 0, y: 0 },
  ];
  const edges = [
    { from: 'lead', to: 'a', type: 'prompt' },
    { from: 'lead', to: 'b', type: 'prompt' },
    { from: 'a', to: 'c', type: 'prompt' },
    { from: 'b', to: 'c', type: 'prompt' },
  ];
  const laid = client.layoutGraph(nodes, edges, 'tb');
  const byId = new Map(laid.map((n) => [n.id, n]));
  assert.ok(byId.get('lead').y < byId.get('a').y, 'layer 1 sits below entry Lead');
  assert.equal(byId.get('a').y, byId.get('b').y, 'parallel siblings share the same vertical layer');
  assert.ok(byId.get('a').x < byId.get('b').x, 'parallel siblings spread horizontally without overlap');
  assert.ok(byId.get('c').y > byId.get('a').y + 230, 'layer 2 clears layer 1 node height');

  const curve = client.edgeCurve(byId.get('lead'), byId.get('a'), { type: 'prompt' }, 'tb');
  assert.equal(curve.c1x, curve.x1, 'vertical curve exits straight downward');
  assert.equal(curve.c2x, curve.x2, 'vertical curve enters straight from above');
  assert.ok(curve.c1y > curve.y1 && curve.c2y < curve.y2, 'vertical control points bend along Y axis');

  const inPos = client.inputSocketPos(byId.get('a'), 'tb');
  assert.equal(inPos.y, byId.get('a').y, 'tb input socket sits on top border');
  const outPos = client.outputSocketPos(byId.get('lead'), 'prompt', '', 'tb');
  assert.equal(outPos.y, byId.get('lead').y + client.nodeHeight(byId.get('lead')), 'tb output socket sits on bottom border');

  const condR = { ...byId.get('c'), tbSide: 'right' };
  const condL = { ...byId.get('c'), tbSide: 'left' };
  const condOutR = client.outputSocketPos(condR, 'prompt', 'true', 'tb');
  const condOutL = client.outputSocketPos(condL, 'prompt', 'true', 'tb');
  assert.equal(condOutR.x, condR.x + 216, 'tb condition right side exits on right border');
  assert.equal(condOutL.x, condL.x, 'tb condition left side exits on left border');
  const curveL = client.edgeCurve(condL, { id: 't', x: condL.x - 100, y: condL.y + 320 }, { type: 'prompt', branch: 'true' }, 'tb');
  assert.ok(curveL.c1x < curveL.x1 && curveL.c2y < curveL.y2, 'tb left-side condition curve exits left then bends downward');
});

test('buildPlan normalizes and serializes global and per-node refs', () => {
  const built = client.buildPlan(
    [
      { id: 'lead', kind: 'lead', task: '审查代码', refs: ['docs/spec.md', '  ', 'docs/spec.md', 'README.md'] },
      { id: 'n1', kind: 'agent', label: '审查', role: '只读检查', refs: ['src/shared.js', 'src/shared.js'] },
    ],
    [{ from: 'lead', to: 'n1', type: 'prompt' }],
  );
  assert.ok(!built.error);
  assert.deepEqual([...built.plan.refs], ['docs/spec.md', 'README.md']);
  const planN = built.plan.nodes.find((n) => n.id === 'n1');
  assert.deepEqual([...planN.refs], ['src/shared.js']);
});

test('clampMenuPos keeps context menus inside canvas bounds and flips near right/bottom edges', () => {
  assert.deepEqual({ ...client.clampMenuPos(60, 80, 400, 500, 180, 160) }, { sx: 60, sy: 80 });
  // Near right & bottom edge -> flips left and up
  const flipped = client.clampMenuPos(380, 470, 400, 500, 180, 160);
  assert.equal(flipped.sx, 200);
  assert.equal(flipped.sy, 310);
  // Tiny viewport -> clamps to safe 8px inset
  const tiny = client.clampMenuPos(20, 20, 160, 120, 180, 160);
  assert.equal(tiny.sx, 8);
  assert.equal(tiny.sy, 8);
});

test('cloneSelection duplicates selected nodes together with internal edges (including type & branch)', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't', x: 0, y: 0 },
    { id: 'a', kind: 'agent', label: 'A', x: 100, y: 100, refs: ['doc.md'] },
    { id: 'c', kind: 'condition', label: 'C', x: 320, y: 100, branches: [{ id: 'true', label: '是' }, { id: 'false', label: '否' }] },
    { id: 'b', kind: 'agent', label: 'B', x: 540, y: 100 },
    { id: 'outside', kind: 'agent', label: 'Out', x: 760, y: 100 },
  ];
  const edges = [
    { id: 'e0', from: 'lead', to: 'a', type: 'prompt' },
    { id: 'e1', from: 'a', to: 'c', type: 'structured' },
    { id: 'e2', from: 'c', to: 'b', type: 'prompt', branch: 'true' },
    { id: 'e3', from: 'b', to: 'outside', type: 'session-ref' },
  ];
  const { clones, clonedEdges } = client.cloneSelection(nodes, edges, ['lead', 'a', 'c', 'b'], 't1');
  assert.equal(clones.length, 3, 'entry Lead is never cloned');
  assert.equal(clonedEdges.length, 2, 'only internal edges between cloned nodes are copied');
  const byLabel = new Map(clones.map((n) => [n.label, n]));
  const eAC = clonedEdges.find((e) => e.from === byLabel.get('A').id && e.to === byLabel.get('C').id);
  const eCB = clonedEdges.find((e) => e.from === byLabel.get('C').id && e.to === byLabel.get('B').id);
  assert.ok(eAC && eAC.type === 'structured');
  assert.ok(eCB && eCB.branch === 'true');
  // Mutating clone refs/branches does not mutate originals
  byLabel.get('A').refs.push('extra.md');
  byLabel.get('C').branches[0].label = '改名';
  assert.equal(nodes[1].refs.length, 1);
  assert.equal(nodes[2].branches[0].label, '是');
});

test('configurable shortcuts default duplicate to Shift+D, match KeyboardEvents, and clear conflicts', () => {
  assert.equal(client.DEFAULT_SHORTCUTS.duplicate, 'Shift+D');
  assert.equal(client.DEFAULT_SHORTCUTS.addNode, 'Shift+A');
  assert.equal(client.DEFAULT_SHORTCUTS.undo, 'Ctrl+Z');
  assert.equal(client.DEFAULT_SHORTCUTS.redo, 'Ctrl+Shift+Z');
  assert.equal(client.DEFAULT_SHORTCUTS.delete, 'Delete');

  assert.equal(client.normalizeShortcut('shift+d'), 'Shift+D');
  assert.equal(client.normalizeShortcut('cmd+shift+z'), 'Ctrl+Shift+Z');
  assert.equal(client.normalizeShortcut('Escape'), '');

  assert.equal(client.formatShortcutFromEvent({ key: 'Shift', shiftKey: true }), null);
  assert.equal(client.formatShortcutFromEvent({ key: 'Escape' }), null);
  assert.equal(client.formatShortcutFromEvent({ key: 'D', code: 'KeyD', shiftKey: true }), 'Shift+D');
  assert.equal(client.matchesShortcut({ key: 'D', code: 'KeyD', shiftKey: true }, 'Shift+D'), true);
  assert.equal(client.matchesShortcut({ key: 'd', code: 'KeyD', ctrlKey: true }, 'Shift+D'), false);
  assert.equal(client.matchesShortcut({ key: 'z', code: 'KeyZ', metaKey: true }, 'Ctrl+Z'), true);

  // Rebinding fitView to Shift+D automatically clears the conflict on duplicate
  const { next, clearedConflict } = client.applyShortcutBinding(client.DEFAULT_SHORTCUTS, 'fitView', 'shift+d');
  assert.equal(clearedConflict, true);
  assert.equal(next.fitView, 'Shift+D');
  assert.equal(next.duplicate, '');
});

test('nextSelectionOnNodeClick supports Shift/Ctrl additive toggle and normal single-click', () => {
  const s1 = client.nextSelectionOnNodeClick(['a'], 'b', true);
  assert.deepEqual([...s1.next], ['a', 'b']);
  assert.equal(s1.toggledOff, false);

  const s2 = client.nextSelectionOnNodeClick(['a', 'b'], 'a', true);
  assert.deepEqual([...s2.next], ['b']);
  assert.equal(s2.toggledOff, true);

  const s3 = client.nextSelectionOnNodeClick(['a', 'b'], 'a', false);
  assert.deepEqual([...s3.next], ['a', 'b'], 'plain click on already-selected node preserves group for drag');
  assert.equal(s3.toggledOff, false);

  const s4 = client.nextSelectionOnNodeClick(['a', 'b'], 'c', false);
  assert.deepEqual([...s4.next], ['c']);
  assert.equal(s4.toggledOff, false);
});

test('controlled loop helpers: membership, validation, multi-select analysis, bypass arc, buildPlan & cloneSelection', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', task: 't', x: 0, y: 100 },
    { id: 'a', kind: 'agent', label: 'A', x: 300, y: 100 },
    { id: 'b', kind: 'agent', label: 'B', x: 600, y: 100 },
    { id: 'c', kind: 'condition', label: 'C', x: 900, y: 100 },
    { id: 'bypass', kind: 'agent', label: 'Bypass', x: 300, y: 400 },
  ];
  const fwdEdges = [
    { id: 'e0', from: 'lead', to: 'a', type: 'prompt' },
    { id: 'e1', from: 'a', to: 'b', type: 'prompt' },
    { id: 'e2', from: 'b', to: 'c', type: 'prompt' },
    { id: 'e3', from: 'lead', to: 'bypass', type: 'prompt' },
  ];

  // canLinkAsLoop allows condition -> strict ancestor, blocks non-condition / entry Lead / non-ancestor
  assert.equal(client.canLinkAsLoop(nodes, fwdEdges, 'c', 'a').ok, true);
  assert.equal(client.canLinkAsLoop(nodes, fwdEdges, 'b', 'a').ok, false);
  assert.equal(client.canLinkAsLoop(nodes, fwdEdges, 'c', 'lead').ok, false);
  assert.equal(client.canLinkAsLoop(nodes, fwdEdges, 'c', 'bypass').ok, false);

  // analyzeLoopSelection: single subagent auto-inserts condition; multi-select ending in condition reuses it
  const singleAgent = client.analyzeLoopSelection(nodes, fwdEdges, ['a']);
  assert.equal(singleAgent.ok, true);
  assert.equal(singleAgent.needsAutoCondition, true);
  assert.equal(client.analyzeLoopSelection(nodes, fwdEdges, ['c']).ok, false);

  const twoAgents = client.analyzeLoopSelection(nodes, fwdEdges, ['a', 'b']);
  assert.equal(twoAgents.ok, true);
  assert.equal(twoAgents.entryId, 'a');
  assert.equal(twoAgents.exitId, 'b');
  assert.equal(twoAgents.needsAutoCondition, true);

  const withCond = client.analyzeLoopSelection(nodes, fwdEdges, ['a', 'b', 'c']);
  assert.equal(withCond.ok, true);
  assert.equal(withCond.entryId, 'a');
  assert.equal(withCond.exitId, 'c');
  assert.equal(withCond.needsAutoCondition, false);

  // Disconnected selection rejected
  assert.equal(client.analyzeLoopSelection(nodes, fwdEdges, ['a', 'bypass']).ok, false);

  // With loop edge added: membership excludes bypass, crossing loop is rejected, bypass arc clears cards
  const loopEdge = { id: 'el', from: 'c', to: 'a', type: 'prompt', branch: 'false', loop: true, maxIterations: 4 };
  const allEdges = fwdEdges.concat([loopEdge]);
  assert.deepEqual(Array.from(client.loopMemberIdsUI(nodes, allEdges, loopEdge)).sort(), ['a', 'b', 'c']);
  assert.equal(client.canLinkAsLoop(nodes, allEdges, 'c', 'b').reason, 'loopOverlap');
  assert.ok(client.topoOrder(nodes, allEdges), 'topoOrder ignores controlled loop back-edges');

  const arcLR = client.loopEdgeArc(nodes[3], nodes[1], loopEdge, 'lr', nodes, allEdges);
  assert.ok(arcLR.midY < nodes[1].y + 2000, 'horizontal loop bypass rail routes above loop cards');
  assert.ok(client.distanceToEdge({ x: arcLR.midX, y: arcLR.midY }, nodes[3], nodes[1], loopEdge, 'lr', nodes, allEdges) <= 1);

  const arcTB = client.loopEdgeArc(nodes[3], nodes[1], loopEdge, 'tb', nodes, allEdges);
  assert.ok(arcTB.midX > nodes[3].x + 2000 + 216, 'vertical loop bypass rail routes outside loop cards');

  const built = client.buildPlan(nodes, allEdges);
  assert.ok(!built.error);
  const builtLoop = built.plan.edges.find((e) => e.loop);
  assert.ok(builtLoop && builtLoop.maxIterations === 4);

  // cloneSelection preserves loop metadata when duplicating the whole loop block
  const { clonedEdges } = client.cloneSelection(nodes, allEdges, ['a', 'b', 'c'], 'lp1');
  const clonedLoop = clonedEdges.find((e) => e.loop);
  assert.ok(clonedLoop && clonedLoop.maxIterations === 4 && clonedLoop.branch === 'false');

  // Breaking an internal forward edge prunes the now-invalid loop edge cleanly
  const brokenEdges = allEdges.filter((e) => e.id !== 'e1');
  const pruned = client.pruneInvalidLoopEdges(nodes, brokenEdges);
  assert.equal(pruned.removedCount, 1);
  assert.equal(pruned.edges.some((e) => e.loop), false);
  const builtBroken = client.buildPlan(nodes, brokenEdges);
  assert.match(builtBroken.error, /回环/, 'stale/imported broken loops must not silently disappear at run time');
  assert.ok(!client.buildPlan(nodes, pruned.edges).error, 'explicit editor pruning still works');

  // Built-in full-showcase retry loop starter template is valid in both zh/en and lr/tb
  for (const lang of ['zh', 'en']) {
    for (const dir of ['lr', 'tb']) {
      const loopTpl = client.builtinTemplates(lang, dir).find((t) => t.id === 'tpl-loop');
      assert.ok(loopTpl, `includes retry loop template in ${lang}/${dir}`);
      const le = loopTpl.edges.find((e) => e.loop === true);
      assert.ok(le && le.maxIterations === 3 && le.branch === 'false');
      const members = client.loopMemberIdsUI(loopTpl.nodes, loopTpl.edges, le);
      assert.equal(members.size, 2, 'loop wraps Core Implement + Quality Gate while bypassing Docs');
      assert.equal(members.has('lp_docs'), false, 'parallel bypass node stays outside loop');
      const byId = new Map(loopTpl.nodes.map((n) => [n.id, n]));
      if (dir === 'lr') {
        assert.ok(byId.get('lp_docs').y > byId.get('lp_gate').y + client.nodeHeight(byId.get('lp_gate')), 'lr: docs clears loop box vertically');
      } else {
        assert.equal(byId.get('lp_impl').x, byId.get('lp_gate').x, 'tb: loop nodes share right lane');
        assert.ok(byId.get('lp_docs').x < byId.get('lp_impl').x, 'tb: docs sits left of loop rail');
      }
    }
  }
});

test('applyPanStep + zoomAroundPoint compose cleanly without viewport snap-back (#10)', () => {
  const client = loadClientTestExports();
  let view = { k: 1, x: 100, y: 80 };
  let pan = { lastX: 300, lastY: 200 };

  // Step 1: pan +20, +10
  let s1 = client.applyPanStep(view, pan, 320, 210);
  view = s1.view;
  pan = s1.pan;
  assert.deepEqual({ ...view }, { k: 1, x: 120, y: 90 });

  // Step 2: wheel zoom around cursor (320, 210) while still panning
  const worldBeforeX = (320 - view.x) / view.k;
  const worldBeforeY = (210 - view.y) / view.k;
  view = client.zoomAroundPoint(view, 320, 210, -120, 0);
  assert.ok(view.k > 1, 'zoomed in');
  assert.ok(Math.abs((320 - view.x) / view.k - worldBeforeX) < 1e-6);
  assert.ok(Math.abs((210 - view.y) / view.k - worldBeforeY) < 1e-6);

  // Step 3: next pan mousemove (+5, -3) applies ONLY the delta on top of post-zoom view (zero jump!)
  const afterZoomX = view.x;
  const afterZoomY = view.y;
  const s3 = client.applyPanStep(view, pan, 325, 207);
  assert.ok(Math.abs(s3.view.x - (afterZoomX + 5)) < 1e-6, 'preserves zoom anchor x');
  assert.ok(Math.abs(s3.view.y - (afterZoomY - 3)) < 1e-6, 'preserves zoom anchor y');
  assert.equal(s3.view.k, view.k);
});

test('default direction persistence (#9) and preset change event dispatch (#12)', () => {
  const store = new Map();
  const events = [];
  let loaded = null;
  const sandbox = {
    window: {
      __ModuleLoader__: { load(mod) { loaded = mod; } },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
      },
      dispatchEvent: (ev) => { events.push(ev && ev.type); },
    },
    console, Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, RegExp, Infinity,
    encodeURIComponent, decodeURIComponent,
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
  const c = loaded.factory((name) => (name === 'react'
    ? { createElement: () => null, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, Component: class {} }
    : {}
  )).__test;

  assert.equal(c.loadDefaultDirection(), 'lr');
  c.saveDefaultDirection('tb');
  assert.equal(c.loadDefaultDirection(), 'tb');
  c.saveDefaultDirection('invalid');
  assert.equal(c.loadDefaultDirection(), 'lr');

  assert.equal(c.savePresets({ demo: { nodes: [], edges: [], direction: 'tb' } }), true);
  assert.ok(events.includes('dsh-wc-presets-changed'), 'notifies other mounted tabs on preset save');
  assert.equal(c.loadPresets().demo.direction, 'tb');
});

test('stopButtonState & deriveLeadStatuses unlock waitingLead cleanly on halted (#11 & #13)', () => {
  const client = loadClientTestExports();
  const idle = client.stopButtonState({ sessionRunning: false, runningNodesCount: 0, waitingLead: null, triggering: false, stopping: false, lang: 'zh' });
  assert.equal(idle.visible, true);
  assert.equal(idle.active, false);
  assert.equal(idle.disabled, true);
  assert.equal(idle.mode, 'idle');
  assert.equal(idle.label, '⏹ 终止');

  const running = client.stopButtonState({ sessionRunning: true, runningNodesCount: 1, waitingLead: null, triggering: false, stopping: false, lang: 'zh' });
  assert.equal(running.visible, true);
  assert.equal(running.active, true);
  assert.equal(running.disabled, false);
  assert.equal(running.mode, 'running');
  assert.equal(running.label, '⏹ 终止');

  const waiting = client.stopButtonState({ sessionRunning: false, runningNodesCount: 0, waitingLead: { id: 'gate', label: 'Lead 拍板' }, triggering: false, stopping: false, lang: 'en' });
  assert.equal(waiting.visible, true);
  assert.equal(waiting.active, true);
  assert.equal(waiting.disabled, false);
  assert.equal(waiting.mode, 'waiting');
  assert.equal(waiting.label, '⏹ Stop');

  // Authoritative `halted` runState prevents stale child statusById from falsely re-locking Lead as Ready!
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'a', kind: 'agent', label: '调研' },
    { id: 'gate', kind: 'lead', label: 'Lead 拍板', role: '决策' },
    { id: 'b', kind: 'agent', label: '执行' },
  ];
  const edges = [
    { id: 'e1', from: 'lead', to: 'a', type: 'prompt' },
    { id: 'e2', from: 'a', to: 'gate', type: 'prompt' },
    { id: 'e3', from: 'gate', to: 'b', type: 'prompt' },
  ];
  const paused = client.deriveLeadStatuses({
    enabled: true,
    nodes,
    edges,
    statusById: { a: 'done' },
    sessionRunning: false,
    runState: { status: 'need-lead', waitingLead: { id: 'gate', label: 'Lead 拍板' }, done: ['a'] },
  });
  assert.equal(paused.leadReadyIds.has('gate'), true);

  const halted = client.deriveLeadStatuses({
    enabled: true,
    nodes,
    edges,
    statusById: { a: 'done' },
    sessionRunning: false,
    runState: { status: 'halted', waitingLead: null, done: ['a'] },
  });
  assert.equal(halted.leadReadyIds.size, 0, 'halted runState must never re-enter awaiting Lead');
});

test('analyzeLoopSelection rejects full-graph overlap & layoutGraph(lr) spaces tall condition nodes without overlap', () => {
  const client = loadClientTestExports();
  // Full-graph overlap: A -> B -> C and A -> X -> C; X already belongs to another loop (X -> X_cond -> X)
  const nodes = [
    { id: 'lead', kind: 'lead', x: 0, y: 0 },
    { id: 'a', kind: 'agent', x: 100, y: 0 },
    { id: 'b', kind: 'agent', x: 200, y: 0 },
    { id: 'x', kind: 'agent', x: 200, y: 200 },
    { id: 'xc', kind: 'condition', x: 300, y: 200 },
    { id: 'c', kind: 'condition', x: 400, y: 0 },
  ];
  const edges = [
    { id: 'e0', from: 'lead', to: 'a' },
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'b', to: 'c' },
    { id: 'e3', from: 'a', to: 'x' },
    { id: 'e4', from: 'x', to: 'xc' },
    { id: 'e5', from: 'xc', to: 'c', branch: 'true' },
    { id: 'elx', from: 'xc', to: 'x', branch: 'false', loop: true, maxIterations: 2 },
  ];
  // Selecting only {a, b, c} would implicitly pull x & xc into descendants(a) ∩ ancestors(c)
  const check = client.analyzeLoopSelection(nodes, edges, ['a', 'b', 'c']);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'loopOverlap');

  // Horizontal layoutGraph('lr') must not overlap a tall 10-branch condition node with its column sibling
  const tallNodes = [
    { id: 'lead', kind: 'lead', x: 0, y: 0 },
    {
      id: 'tall', kind: 'condition', x: 100, y: 0,
      branches: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10'],
    },
    { id: 'sib', kind: 'agent', x: 100, y: 50 },
  ];
  const tallEdges = [
    { id: 't1', from: 'lead', to: 'tall' },
    { id: 't2', from: 'lead', to: 'sib' },
  ];
  const laid = client.layoutGraph(tallNodes, tallEdges, 'lr');
  const tallOut = laid.find((n) => n.id === 'tall');
  const sibOut = laid.find((n) => n.id === 'sib');
  assert.ok(sibOut.y >= tallOut.y + client.nodeHeight(tallOut) + 20, 'tall condition card must not overlap sibling below it');
});

test('formatDurationMs, buildRunSummaryView & formatRunSummaryMarkdown cover v1.6 summary and legacy .run.json', () => {
  const client = loadClientTestExports();
  assert.equal(client.formatDurationMs(null), '—');
  assert.equal(client.formatDurationMs(-5), '—');
  assert.equal(client.formatDurationMs(420), '420ms');
  assert.equal(client.formatDurationMs(4250), '4.3s');
  assert.equal(client.formatDurationMs(84000), '1m 24s');
  assert.equal(client.formatDurationMs(3720000), '1h 2m');

  assert.equal(client.buildRunSummaryView({ runState: null, nodes: [] }).hasData, false);
  assert.equal(client.buildRunSummaryView({ runState: { status: 'idle' }, nodes: [] }).hasData, false);

  const canvasNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'impl', kind: 'agent', label: '核心实现' },
    { id: 'gate', kind: 'condition', label: '质量门禁' },
    { id: 'skip', kind: 'agent', label: '备选分支' },
    { id: 'final', kind: 'lead', label: '终审' },
  ];

  // Live running summary computes elapsed & active node live duration
  const liveView = client.buildRunSummaryView({
    runState: {
      status: 'running',
      summary: {
        status: 'running',
        startedAt: 1000,
        endedAt: null,
        maxParallel: 4,
        totalLoops: 1,
        nodes: [
          { id: 'impl', label: '核心实现', kind: 'agent', status: 'running', startedAt: 2000, endedAt: null, durationMs: 3000, runs: 2, model: 'DeepSeek-V4-Pro', fallbackUsed: true, sessionContinued: true, childId: 'c1', reason: '' },
          { id: 'gate', label: '质量门禁', kind: 'condition', status: 'pending', startedAt: null, endedAt: null, durationMs: 500, runs: 1, model: '', fallbackUsed: false, sessionContinued: false, childId: 'c2', reason: '打回修复 — 单测未过' },
          { id: 'skip', label: '备选分支', kind: 'agent', status: 'pruned', startedAt: null, endedAt: null, durationMs: 0, runs: 0, model: '', fallbackUsed: false, sessionContinued: false, childId: '', reason: '' },
        ],
        loops: [
          { fromLabel: '质量门禁', toLabel: '核心实现', used: 1, max: 3, exhausted: false, rounds: [{ round: 1, reason: '单测未过' }] },
        ],
      },
    },
    nodes: canvasNodes,
    runsById: { skip: { childId: 'stale-old-run-kid' } },
    now: 4500,
  });
  assert.equal(liveView.hasData, true);
  assert.equal(liveView.isLive, true);
  assert.equal(liveView.elapsedMs, 3500);
  assert.equal(liveView.nodes[0].durationMs, 5500, 'accumulates previous round 3000ms + live 2500ms');
  assert.equal(liveView.nodes[2].durationMs, null, 'pruned node shows no duration');
  assert.equal(liveView.nodes[2].childId, '', 'pruned node must not inherit stale childId from an earlier run');
  assert.equal(liveView.totalLoops, 1);

  const mdZh = client.formatRunSummaryMarkdown(liveView, 'zh');
  assert.ok(mdZh.includes('### 执行复盘摘要'));
  assert.ok(mdZh.includes('| 核心实现 | 子代理 | 运行中 | 5.5s | 2 |'));
  assert.ok(mdZh.includes('备用回退') && mdZh.includes('续接会话'));
  assert.ok(mdZh.includes('质量门禁 ↺ 核心实现'));

  const mdEn = client.formatRunSummaryMarkdown(liveView, 'en');
  assert.ok(mdEn.includes('### Run Summary'));
  assert.ok(mdEn.includes('| Node | Type | Status | Duration | Runs | Notes |'));
  assert.ok(mdEn.includes('Fallback') && mdEn.includes('Continued'));

  // Backward compatibility: older .run.json without `summary` field still builds cleanly
  // and derives elapsedMs from client-side fallbackTiming when available
  const legacyView = client.buildRunSummaryView({
    runState: {
      status: 'done',
      done: ['impl', 'gate'],
      pruned: ['skip'],
      decisions: { gate: { branchLabels: ['通过'], reason: 'ok' } },
    },
    nodes: canvasNodes,
    runsById: { impl: { childId: 'legacy-kid' } },
    fallbackTiming: { startedAt: 10000, endedAt: 22400 },
  });
  assert.equal(legacyView.hasData, true);
  assert.equal(legacyView.doneCount, 2);
  assert.equal(legacyView.prunedCount, 1);
  assert.equal(legacyView.elapsedMs, 12400);
  assert.equal(legacyView.nodes.find((n) => n.id === 'impl').childId, 'legacy-kid');

  // Regression: opening an old finished legacy .run.json (no `summary`, no observed live start)
  // must return elapsedMs=null ('—'), NEVER fabricate `now - runState.at` (e.g. 10m 0s).
  const staleLegacyView = client.buildRunSummaryView({
    runState: {
      status: 'done',
      at: 1000,
      done: ['impl'],
      pruned: [],
      decisions: {},
    },
    nodes: canvasNodes,
    now: 601000,
    fallbackTiming: { startedAt: null, endedAt: null },
  });
  assert.equal(staleLegacyView.elapsedMs, null);
  assert.equal(client.formatDurationMs(staleLegacyView.elapsedMs), '—');
});

test('pruneSessionStorage evicts oldest session canvas docs while preserving reserved settings keys and keepKey', () => {
  const store = new Map();
  const c = loadClientTestExports(store);
  const prefix = c.storageKey('x').slice(0, -1);
  // Reserved settings keys + unrelated host key must never be evicted
  const reserved = ['presets', 'direction', 'shortcuts', 'lang', 'cut', 'fx', 'maxParallel'];
  for (const r of reserved) store.set(prefix + r, JSON.stringify({ v: r }));
  store.set('unrelated-host-key', 'keep-me');

  // Seed 6 session canvas entries with distinct timestamps
  store.set(c.storageKey('s-old-1'), JSON.stringify({ at: 100, nodes: [] }));
  store.set(c.storageKey('s-corrupt'), '{not-json');
  store.set(c.storageKey('s-old-2'), JSON.stringify({ at: 200, nodes: [] }));
  store.set(c.storageKey('s-mid'), JSON.stringify({ at: 300, nodes: [] }));
  store.set(c.storageKey('s-new'), JSON.stringify({ at: 400, nodes: [] }));
  store.set(c.storageKey('s-keep'), JSON.stringify({ at: 50, nodes: [] })); // oldest, but explicitly protected by keepKey

  // Cap at 3 sessions total -> keepKey ('s-keep') + 2 newest others ('s-new', 's-mid') survive; 3 oldest evicted
  const dropped = c.pruneSessionStorage(c.storageKey('s-keep'), 3);
  assert.equal(dropped, 3);
  assert.equal(store.has(c.storageKey('s-keep')), true, 'keepKey must survive even if oldest');
  assert.equal(store.has(c.storageKey('s-new')), true);
  assert.equal(store.has(c.storageKey('s-mid')), true);
  assert.equal(store.has(c.storageKey('s-corrupt')), false, 'corrupt entry treated as at=0 and evicted first');
  assert.equal(store.has(c.storageKey('s-old-1')), false);
  assert.equal(store.has(c.storageKey('s-old-2')), false);
  for (const r of reserved) {
    assert.equal(store.has(prefix + r), true, 'reserved key ' + r + ' must never be evicted');
  }
  assert.equal(store.get('unrelated-host-key'), 'keep-me');

  // Long-running Electron session: saveDoc re-prunes automatically once localStorage.length > 96
  c.saveDoc('s-trigger-first', { nodes: [], edges: [], enabled: false }, 500);
  for (let i = 0; i < 100; i += 1) {
    store.set(c.storageKey('bulk-' + i), JSON.stringify({ at: 1000 + i, nodes: [] }));
  }
  assert.ok(store.size > 96);
  c.saveDoc('s-latest', { nodes: [], edges: [], enabled: false }, 999999);
  assert.ok(store.size <= 90, 'saveDoc re-triggers prune when session count grows over cap in long-lived process');
  assert.equal(store.has(c.storageKey('s-latest')), true);
});

test('isDockElementHidden detects collapsed DSH right sidebar (aria-hidden/inert even when offsetParent !== null)', () => {
  const c = loadClientTestExports();
  // 1) Visible dockkit pane
  const visibleEl = {
    offsetParent: {},
    closest: (sel) => (sel === '[data-dockkit-content]' ? { getAttribute: () => 'false', inert: false } : null),
    checkVisibility: () => true,
  };
  assert.equal(c.isDockElementHidden(visibleEl), false);

  // 2) Collapsed right sidebar: DSH uses transform + visibility:hidden so offsetParent is non-null,
  //    but [data-dockkit-content] sets aria-hidden="true" and inert=true.
  const collapsedSidebarEl = {
    offsetParent: {},
    closest: (sel) => (sel === '[data-dockkit-content]' ? { getAttribute: () => 'true', inert: true } : null),
    checkVisibility: () => false,
  };
  assert.equal(c.isDockElementHidden(collapsedSidebarEl), true, 'detects collapsed right sidebar via dockkit aria-hidden');

  // 3) Tab/session hidden via display:none (offsetParent === null)
  assert.equal(c.isDockElementHidden({ offsetParent: null }), true);

  // 4) checkVisibility fallback when outside dockkit shell
  assert.equal(c.isDockElementHidden({ offsetParent: {}, closest: () => null, checkVisibility: () => false }), true);

  // 5) Frame-0 dockkit contract: when [data-dockkit-content] reports visible, do NOT let CSS transition checkVisibility lag override it
  const expandingSidebarEl = {
    offsetParent: {},
    closest: (sel) => (sel === '[data-dockkit-content]' ? { getAttribute: () => null, inert: false, hidden: false } : null),
    checkVisibility: () => false,
  };
  assert.equal(c.isDockElementHidden(expandingSidebarEl), false, 'trusts dockkit aria-hidden/inert directly on frame 0');
});

test('client hardening: null/blank defaults, Windows reserved id sanitizer, multi-object clipboard extraction, and legacy summary runs/reason', () => {
  const c = loadClientTestExports();
  assert.equal(c.normalizeMaxIterationsUI(null), 3);
  assert.equal(c.normalizeMaxIterationsUI(''), 3);
  assert.equal(c.normalizeMaxIterationsUI(false), 3);

  const planRes = c.buildPlan(
    [
      { id: 'lead', kind: 'lead', task: 't', x: 0, y: 0 },
      { id: 'n1', kind: 'agent', label: 'A', role: 'r', x: 200, y: 0 },
    ],
    [{ id: 'e1', from: 'lead', to: 'n1', type: 'prompt' }],
    { maxParallel: null },
  );
  assert.equal(planRes.plan.maxParallel, 4, 'null maxParallel defaults to 4 instead of clamping to 1');

  // Windows reserved names prefixed identically to backend safeSessionFileBase
  assert.equal(c.sanitizeSessionFileBaseUI('CON'), '_CON');
  assert.equal(c.sanitizeSessionFileBaseUI('nul.txt'), '_nul.txt');
  assert.equal(c.sanitizeSessionFileBaseUI('   '), '');

  // Clipboard extraction handles prose with earlier `{...}` snippets + fenced json canvas block
  const pasted = '节点说明里包含 { filesToChange } 示例。\n```json canvas\n{"nodes":[{"id":"lead","kind":"lead"},{"id":"n1","kind":"agent"}],"edges":[{"from":"lead","to":"n1"}]}\n```';
  const extracted = c.extractCanvasJsonFromText(pasted);
  assert.ok(extracted && Array.isArray(extracted.nodes) && extracted.nodes.length === 2);

  // Legacy .run.json fallback: pruned node gets runs: 0 and empty branchLabels has no leading ' — '
  const legacyView = c.buildRunSummaryView({
    runState: {
      status: 'done',
      done: ['c1', 'skipped_n'],
      pruned: ['skipped_n'],
      decisions: { c1: { branchLabels: [], reason: '条件执行失败' } },
    },
    nodes: [
      { id: 'lead', kind: 'lead', label: 'Lead' },
      { id: 'c1', kind: 'condition', label: '判断' },
      { id: 'skipped_n', kind: 'agent', label: '跳过节点' },
    ],
  });
  const condRow = legacyView.nodes.find((n) => n.id === 'c1');
  const skippedRow = legacyView.nodes.find((n) => n.id === 'skipped_n');
  assert.equal(condRow.reason, '条件执行失败', 'no leading em-dash when branchLabels is empty');
  assert.equal(skippedRow.runs, 0, 'pruned node reports 0 runs even if present in done');
});

test('comment box helpers: normalizeCommentsUI, geometric membership, layout refit, header zoom scale & WorkflowCanvas render (#15)', () => {
  const store = new Map();
  const c = loadClientTestExports(store);

  assert.equal(c.DEFAULT_SHORTCUTS.addComment, 'C');
  assert.equal(c.COMMENT_COLORS.length, 6);

  // Sanitization & clamping
  const normalized = c.normalizeCommentsUI([
    null,
    { id: 'c1', x: 10.4, y: -20.6, w: 50, h: 20, title: '第一阶段', body: '并行调研', color: 'invalid', fontSize: 'xl', zoomScale: false },
    { id: 'c1', x: 99, y: 99, w: 300, h: 200 }, // duplicate id skipped
    { id: 'c2', x: 500, y: 500, w: 260, h: 148, title: '独立便签', body: '记得检查权限', color: 'amber', fontSize: 'lg' },
  ]);
  assert.equal(normalized.length, 2);
  assert.deepEqual({ ...normalized[0] }, {
    id: 'c1',
    x: 10,
    y: -21,
    w: 180,
    h: 96,
    title: '第一阶段',
    body: '并行调研',
    color: 'gray',
    fontSize: 'md',
    zoomScale: false,
  });
  assert.equal(normalized[1].color, 'amber');
  assert.equal(normalized[1].fontSize, 'lg');
  assert.equal(normalized[1].zoomScale, true);

  // Real-time geometric membership + boundsForNodes + refitCommentsAfterLayout
  const nodesLR = [
    { id: 'lead', kind: 'lead', x: 40, y: 100, label: 'Lead', task: 'demo' },
    { id: 'a', kind: 'agent', x: 340, y: 40, label: 'A', role: 'r1' },
    { id: 'b', kind: 'agent', x: 340, y: 320, label: 'B', role: 'r2' },
    { id: 'out', kind: 'agent', x: 700, y: 180, label: 'Out', role: 'r3' },
  ];
  const edges = [
    { id: 'e1', from: 'lead', to: 'a', type: 'prompt' },
    { id: 'e2', from: 'lead', to: 'b', type: 'prompt' },
    { id: 'e3', from: 'a', to: 'out', type: 'prompt' },
    { id: 'e4', from: 'b', to: 'out', type: 'prompt' },
  ];
  const groupBox = c.boundsForNodes([nodesLR[1], nodesLR[2]]);
  assert.ok(groupBox.x < 340 && groupBox.y < 40 - 40, 'boundsForNodes adds side + header padding');
  assert.ok(groupBox.x + groupBox.w > 340 + 216 && groupBox.y + groupBox.h > 320 + 234);

  const groupComment = { id: 'cg', ...groupBox, title: '并行阶段', body: '互不依赖', color: 'blue', fontSize: 'md', zoomScale: true };
  const noteComment = { id: 'cn', x: -300, y: -200, w: 240, h: 140, title: '备忘', body: '仅作说明', color: 'amber', fontSize: 'sm', zoomScale: true };

  assert.deepEqual(c.nodesInsideComment(groupComment, nodesLR).map((n) => n.id), ['a', 'b']);
  assert.deepEqual(c.nodesInsideComment(noteComment, nodesLR).map((n) => n.id), []);

  // Flip to vertical (tb) layout -> group comment refits around new positions of [a, b], standalone note stays put
  const nodesTB = c.layoutGraph(nodesLR, edges, 'tb');
  const refitted = c.refitCommentsAfterLayout([groupComment, noteComment], nodesLR, nodesTB);
  assert.deepEqual(c.nodesInsideComment(refitted[0], nodesTB).map((n) => n.id).sort(), ['a', 'b'], 'refitted group still contains a & b after tb layout');
  assert.equal(refitted[1].x, -300, 'standalone note keeps original x');
  assert.equal(refitted[1].y, -200, 'standalone note keeps original y');

  // Zoom readability scaling
  assert.equal(c.commentHeaderScale(1.2, true), 1);
  assert.equal(c.commentHeaderScale(0.5, false), 1);
  assert.equal(c.commentHeaderScale(0.5, true), 2);
  assert.ok(Math.abs(c.commentHeaderScale(0.2, true) - (1 / 0.38)) < 1e-6, 'caps extreme zoom-out scale cleanly');

  // 3-edge + 4-corner window-style resizing (clamping pins opposite edge without sliding)
  const baseRect = { x: 100, y: 200, w: 300, h: 200 };
  assert.deepEqual({ ...c.resizeCommentBox(baseRect, 'w', -40, 0) }, { x: 60, y: 200, w: 340, h: 200 });
  assert.deepEqual({ ...c.resizeCommentBox(baseRect, 'w', 250, 0) }, { x: 220, y: 200, w: 180, h: 200 }, 'west clamp pins right edge at 400');
  assert.deepEqual({ ...c.resizeCommentBox(baseRect, 'nw', -30, -50) }, { x: 70, y: 150, w: 330, h: 250 });
  assert.deepEqual({ ...c.resizeCommentBox(baseRect, 'ne', 20, 200) }, { x: 100, y: 304, w: 320, h: 96 }, 'north clamp pins bottom edge at 400');
  assert.deepEqual({ ...c.resizeCommentBox(baseRect, 'sw', 50, 40) }, { x: 150, y: 200, w: 250, h: 240 });
  assert.deepEqual({ ...c.resizeCommentBox(baseRect, 's', 99, 60) }, { x: 100, y: 200, w: 300, h: 260 });

  // Render WorkflowCanvas with both a group comment and a standalone note in localStorage
  c.saveDoc('s-cm-render', { nodes: nodesLR, edges, comments: [groupComment, noteComment], enabled: false, direction: 'lr' }, 1000);
  const tree = c.WorkflowCanvas({ sessionId: 's-cm-render' });
  const collectComments = (el, acc = []) => {
    if (!el || typeof el !== 'object') return acc;
    if (Array.isArray(el)) {
      for (const item of el) collectComments(item, acc);
      return acc;
    }
    if (el.props && el.props['data-comment-id']) acc.push(el);
    if (el.children) collectComments(el.children, acc);
    return acc;
  };
  const renderedComments = collectComments(tree);
  assert.equal(renderedComments.length, 2, 'renders both comment boxes');
  const byCid = new Map(renderedComments.map((el) => [el.props['data-comment-id'], el]));
  assert.equal(byCid.get('cg').props['data-comment-mode'], 'group');
  assert.equal(byCid.get('cg').props.style.pointerEvents, 'none', 'group box body stays click-through');
  assert.equal(byCid.get('cg').props.style.border, undefined, 'outer box draws no top border that would slice through a zoomed-out scaled header');
  const bodyEl = byCid.get('cg').children.find((ch) => ch && ch.props && ch.props['data-comment-body'] === 'cg');
  assert.ok(bodyEl && bodyEl.props.style.top === '30px' && bodyEl.props.style.borderTop === 'none', 'body frame starts cleanly below header seam');
  assert.equal(byCid.get('cn').props['data-comment-mode'], 'note');

  // AI mergeCommentsForDoc: generate + tb relayout resolves nodeIds; merge patch updates/adds/removes cleanly
  const genComments = c.mergeCommentsForDoc(
    [],
    [
      { id: 'ai-g', title: '并行阶段', body: '只读调研', color: 'blue', nodeIds: ['a', 'b'] },
      { id: 'ai-n', title: '全局备注', body: '勿动锁文件', color: 'amber' },
    ],
    [],
    nodesTB,
    false,
    true,
  );
  assert.equal(genComments.length, 2);
  assert.deepEqual(c.nodesInsideComment(genComments[0], nodesTB).map((n) => n.id).sort(), ['a', 'b'], 'generated comment refits onto tb-laid-out nodeIds');
  assert.ok(genComments[1].y < nodesTB[0].y, 'standalone AI note places cleanly above graph without overlapping nodes');

  const patchedComments = c.mergeCommentsForDoc(
    genComments,
    [
      { id: 'ai-g', title: '并行调研（更新）', color: 'green' }, // no nodeIds -> preserves geometry
      { id: 'ai-new', title: '终审区', nodeIds: ['out'], color: 'purple' },
    ],
    ['ai-n'],
    nodesTB,
    true,
    false,
  );
  assert.equal(patchedComments.length, 2);
  const updG = patchedComments.find((x) => x.id === 'ai-g');
  const addNew = patchedComments.find((x) => x.id === 'ai-new');
  assert.equal(updG.title, '并行调研（更新）');
  assert.equal(updG.color, 'green');
  assert.equal(updG.x, genComments[0].x, 'updating title/color without nodeIds preserves existing box position');
  assert.deepEqual(c.nodesInsideComment(addNew, nodesTB).map((n) => n.id), ['out'], 'new AI patch comment wraps target nodeIds');

  // Even when a merge patch echoes the same nodeIds, a manually resized box is preserved instead of snapping back
  const manualWide = [{ ...genComments[0], w: genComments[0].w + 140, h: genComments[0].h + 90 }];
  const keptManual = c.mergeCommentsForDoc(
    manualWide,
    [{ id: 'ai-g', title: '保留手动大小', nodeIds: ['a', 'b'] }],
    [],
    nodesTB,
    true,
    false,
  );
  assert.equal(keptManual[0].w, manualWide[0].w, 'same nodeIds set preserves user manual resize');
  assert.equal(keptManual[0].h, manualWide[0].h);
});

test('loopProgressDisplay & WorkflowCanvas unify round/retry/exhausted progress across pill, badge & summary (#17)', () => {
  const c = loadClientTestExports();

  // 1) Idle / legacy `.run.json` without `loopCounts` -> falls back cleanly to design limit `↺ ×3` / `↺1`
  const idle = c.loopProgressDisplay({ maxIterations: 3, live: null, runStatus: 'running', index: 1, lang: 'zh' });
  assert.equal(idle.isLive, false);
  assert.equal(idle.pillText, '↺ ×3');
  assert.equal(idle.nodeTagText, '↺1');

  const idleStatus = c.loopProgressDisplay({ maxIterations: 3, live: { count: 0, max: 3 }, runStatus: 'idle', index: 2, lang: 'en' });
  assert.equal(idleStatus.pillText, '↺ ×3');
  assert.equal(idleStatus.nodeTagText, '↺2');

  // 2) Round 1 in progress -> immediately shows `↺ 0/3` + dual-metric tooltip in zh & en
  const r1Zh = c.loopProgressDisplay({
    maxIterations: 3,
    live: { count: 0, max: 3, round: 1, totalRounds: 4, active: true, exhausted: false },
    runStatus: 'running',
    index: 1,
    lang: 'zh',
  });
  assert.equal(r1Zh.pillText, '↺ 0/3');
  assert.equal(r1Zh.nodeTagText, '↺ 0/3');
  assert.ok(r1Zh.pillTip.includes('当前第 1/4 轮（已重试 0/3 次）'));
  assert.equal(r1Zh.nodeTip, '当前第 1/4 轮（已重试 0/3 次）');

  const r1En = c.loopProgressDisplay({
    maxIterations: 3,
    live: { count: 0, max: 3, round: 1, totalRounds: 4, active: true, exhausted: false },
    runStatus: 'running',
    index: 1,
    lang: 'en',
  });
  assert.equal(r1En.pillText, '↺ 0/3');
  assert.ok(r1En.pillTip.includes('Round 1/4 (0/3 retries)'));

  // 3) Exhausted circuit-break -> explicit exhausted label on pill & `!` on compact node badge
  const exZh = c.loopProgressDisplay({
    maxIterations: 3,
    live: { count: 3, max: 3, round: 4, totalRounds: 4, active: true, exhausted: true },
    runStatus: 'done',
    index: 1,
    lang: 'zh',
  });
  assert.equal(exZh.pillText, '↺ 已用尽 3/3');
  assert.equal(exZh.nodeTagText, '↺ 3/3!');
  assert.ok(exZh.pillTip.includes('已达上限熔断'));

  const exEn = c.loopProgressDisplay({
    maxIterations: 10,
    live: { count: 10, max: 10, round: 11, totalRounds: 11, active: true, exhausted: true },
    runStatus: 'done',
    index: 1,
    lang: 'en',
  });
  assert.equal(exEn.pillText, '↺ Exhausted 10/10');
  assert.equal(exEn.nodeTagText, '↺ 10/10!');

  // 3b) Global-cap exhaustion (< max) explains global cap in tooltip
  const exGlobalZh = c.loopProgressDisplay({
    maxIterations: 3,
    live: { count: 1, max: 3, round: 2, totalRounds: 4, active: true, exhausted: true, globalLimit: 20 },
    runStatus: 'done',
    index: 1,
    lang: 'zh',
  });
  assert.ok(exGlobalZh.pillTip.includes('全局上限（20 次）'));

  // 3c) Unentered / pruned loop on terminal run shows Not entered (round=0) instead of falsely claiming Round 1
  const prunedZh = c.loopProgressDisplay({
    maxIterations: 3,
    live: { count: 0, max: 3, round: 0, totalRounds: 4, active: false, exhausted: false },
    runStatus: 'done',
    index: 2,
    lang: 'zh',
  });
  assert.equal(prunedZh.round, 0);
  assert.equal(prunedZh.pillText, '↺ ×3');
  assert.equal(prunedZh.nodeTagText, '↺2');
  assert.ok(prunedZh.nodeTip.includes('未执行'));
  assert.ok(!prunedZh.nodeTip.includes('第 1/4 轮'));

  // 3d) Editing maxIterations after a terminal run immediately reflects the new design limit instead of locking to stale live.max
  const editedAfterDone = c.loopProgressDisplay({
    maxIterations: 5,
    live: { count: 1, max: 3, round: 2, totalRounds: 4, active: true, exhausted: false },
    runStatus: 'done',
    index: 1,
    lang: 'zh',
  });
  assert.equal(editedAfterDone.isLive, false);
  assert.equal(editedAfterDone.pillText, '↺ ×5');
  assert.equal(editedAfterDone.nodeTagText, '↺1');

  // 4) Run Summary view & Markdown show round + retry consistently even at used=0 (Round 1) and mark unentered loops
  const sumView = c.buildRunSummaryView({
    runState: {
      status: 'running',
      summary: {
        status: 'running',
        startedAt: 1000,
        nodes: [{ id: 'a', label: 'A', kind: 'agent', status: 'running', startedAt: 1000, durationMs: 0, runs: 1 }],
        loops: [
          { fromLabel: '门禁', toLabel: 'A', used: 0, max: 3, round: 1, totalRounds: 4, active: true, exhausted: false, rounds: [] },
          { fromLabel: '旁路门禁', toLabel: 'B', used: 0, max: 2, round: 0, totalRounds: 3, active: false, exhausted: false, rounds: [] },
        ],
      },
    },
    nodes: [{ id: 'lead', kind: 'lead' }, { id: 'a', kind: 'agent', label: 'A' }],
    now: 2000,
  });
  assert.equal(sumView.loops.length, 2);
  assert.equal(sumView.loops[0].round, 1);
  assert.equal(sumView.loops[0].totalRounds, 4);
  assert.equal(sumView.loops[1].round, 0);
  assert.equal(sumView.loops[1].active, false);
  const mdZh = c.formatRunSummaryMarkdown(sumView, 'zh');
  const mdEn = c.formatRunSummaryMarkdown(sumView, 'en');
  assert.ok(mdZh.includes('第 1/4 轮 · 重试 0/3'));
  assert.ok(mdZh.includes('未执行 · 重试 0/2'));
  assert.ok(mdEn.includes('Round 1/4 · 0/3 retries'));
  assert.ok(mdEn.includes('Not entered · 0/2 retries'));

  // 5) Rendered WorkflowCanvas shows matching pill & node tag during Round 1 and on Exhausted in lr & tb
  const loopNodes = [
    { id: 'lead', kind: 'lead', x: 40, y: 100, label: 'Lead', task: 'loop ui' },
    { id: 'impl', kind: 'agent', x: 340, y: 100, label: '实现', role: 'code' },
    { id: 'gate', kind: 'condition', x: 640, y: 100, label: '门禁', role: 'check' },
  ];
  const loopEdges = [
    { id: 'e0', from: 'lead', to: 'impl', type: 'prompt' },
    { id: 'e1', from: 'impl', to: 'gate', type: 'prompt' },
    { id: 'el', from: 'gate', to: 'impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
  ];
  const findByAttr = (el, attr, val) => {
    if (!el || typeof el !== 'object') return null;
    if (Array.isArray(el)) {
      for (const ch of el) { const hit = findByAttr(ch, attr, val); if (hit) return hit; }
      return null;
    }
    if (el.props && el.props[attr] === val) return el;
    return el.children ? findByAttr(el.children, attr, val) : null;
  };
  for (const dir of ['lr', 'tb']) {
    const storeR1 = new Map();
    const cR1 = loadClientTestExports(storeR1, {
      enabled: true,
      direction: dir,
      runState: {
        status: 'running',
        loopCounts: { el: { count: 0, max: 3, round: 1, totalRounds: 4, active: true, exhausted: false } },
        nodeAttempts: { impl: { retry: 0, max: 3, round: 1, totalRounds: 4, active: true, exhausted: false } },
      },
    });
    cR1.saveDoc('s-lp-r1', { nodes: loopNodes, edges: loopEdges, enabled: true, direction: dir }, 1000);
    const treeR1 = cR1.WorkflowCanvas({ sessionId: 's-lp-r1' });
    const pillEl = findByAttr(treeR1, 'data-loop-pill', 'el');
    const tagEl = findByAttr(treeR1, 'data-loop-tag', 'impl');
    assert.ok(pillEl && pillEl.children[0].children[0] === '↺ 0/3', `Round 1 pill shows ↺ 0/3 in ${dir}`);
    assert.ok(tagEl && tagEl.children[0] === '↺ 0/3', `Round 1 node badge shows ↺ 0/3 in ${dir}`);
  }

  // 6) Run Summary pill stays visible and muted (idle) before the canvas has been run
  const storeIdle = new Map();
  const cIdle = loadClientTestExports(storeIdle, { enabled: true });
  cIdle.saveDoc('s-sum-idle', { nodes: loopNodes, edges: loopEdges, enabled: true }, 1000);
  const treeIdle = cIdle.WorkflowCanvas({ sessionId: 's-sum-idle' });
  const idleSumPill = findByAttr(treeIdle, 'data-summary-pill', 'idle');
  assert.ok(idleSumPill, 'Run Summary pill renders in muted idle state before any run');
  assert.equal(idleSumPill.props.style.opacity, 0.6);
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
});

test('interaction matrix (UI): comment frame wrapping loop & condition nodes survives lr <-> tb auto-layout refit and plan serialization', () => {
  const c = loadClientTestExports();
  const baseNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead', task: 'comment+loop matrix', x: 0, y: 0 },
    { id: 'impl', kind: 'agent', label: '实现', role: 'code', x: 0, y: 0 },
    { id: 'gate', kind: 'condition', label: '门禁', role: 'check', x: 0, y: 0 },
    { id: 'final', kind: 'lead', label: '终审', role: 'ship', x: 0, y: 0 },
  ];
  const baseEdges = [
    { id: 'e0', from: 'lead', to: 'impl', type: 'prompt' },
    { id: 'e1', from: 'impl', to: 'gate', type: 'prompt' },
    { id: 'e2', from: 'gate', to: 'final', type: 'prompt', branch: 'true' },
    { id: 'el', from: 'gate', to: 'impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
  ];

  // Layout in lr and wrap loop members (`impl`, `gate`) with a comment frame
  const lrNodes = [...c.layoutGraph(baseNodes, baseEdges, 'lr')];
  const bLr = c.boundsForNodes(lrNodes.filter((n) => n.id === 'impl' || n.id === 'gate'));
  const cmLr = [{ id: 'cm_loop', title: '回环修复区', body: '最多 3 次', color: 'amber', fontSize: 'md', x: bLr.x, y: bLr.y, w: bLr.w, h: bLr.h }];
  assert.deepEqual([...c.nodesInsideComment(cmLr[0], lrNodes)].map((n) => n.id).sort(), ['gate', 'impl']);

  // Flip to vertical (`tb`) and refit comments: wrapped loop nodes stay strictly inside, final stays outside
  const tbNodes = [...c.layoutGraph(lrNodes, baseEdges, 'tb')];
  const cmTb = [...c.refitCommentsAfterLayout(cmLr, lrNodes, tbNodes)];
  assert.deepEqual([...c.nodesInsideComment(cmTb[0], tbNodes)].map((n) => n.id).sort(), ['gate', 'impl']);

  // Flip back to `lr` and verify buildPlan keeps the loop edge while mergeCommentsForDoc preserves comment bounds
  const lrNodes2 = [...c.layoutGraph(tbNodes, baseEdges, 'lr')];
  const cmLr2 = [...c.refitCommentsAfterLayout(cmTb, tbNodes, lrNodes2)];
  assert.deepEqual([...c.nodesInsideComment(cmLr2[0], lrNodes2)].map((n) => n.id).sort(), ['gate', 'impl']);
  const built = c.buildPlan(lrNodes2, baseEdges, { direction: 'lr' });
  assert.ok(!built.error);
  assert.equal(built.plan.edges.filter((e) => e.loop).length, 1);
  const merged = [...c.mergeCommentsForDoc(cmLr2, [{ id: 'cm_loop', title: '回环修复区 v2', nodeIds: ['impl', 'gate'] }], [], lrNodes2, true, true)];
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, '回环修复区 v2');
  assert.deepEqual([...c.nodesInsideComment(merged[0], lrNodes2)].map((n) => n.id).sort(), ['gate', 'impl']);
});
