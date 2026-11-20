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
  const templates = client.builtinTemplates('zh');
  assert.ok(templates.length >= 2);
  for (const tpl of templates) {
    assert.ok(tpl.nodes.some((n) => n.id === 'lead'));
    assert.ok(client.topoOrder(tpl.nodes, tpl.edges), tpl.id + ' is acyclic');
    const built = client.buildPlan(tpl.nodes, tpl.edges);
    assert.ok(!built.error, tpl.id + ' builds cleanly even when task is blank: ' + built.error);
  }
});
