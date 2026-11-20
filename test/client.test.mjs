import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadClientTestExports() {
  let loaded = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) { loaded = mod; },
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
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
  vm.runInNewContext(code, sandbox);
  assert.ok(loaded, 'client module registered');
  assert.equal(loaded.id, 'dsh-workflow-canvas', 'module id matches published package name');
  const mod = loaded.factory((name) => {
    if (name === 'react') {
      return {
        createElement: () => null,
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
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
    }
  }
});

test('nextEffectLevel cycles minimal -> standard -> vivid -> minimal', () => {
  assert.equal(client.nextEffectLevel('minimal'), 'standard');
  assert.equal(client.nextEffectLevel('standard'), 'vivid');
  assert.equal(client.nextEffectLevel('vivid'), 'minimal');
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
