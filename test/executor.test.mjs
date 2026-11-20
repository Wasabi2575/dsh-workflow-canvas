import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderNodes, upstreamOf, downstreamLabels, briefFor, withoutEntry, normalizeCanvas, executePlan } from '../index.js';

test('withoutEntry strips the entry Lead', () => {
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'n1', kind: 'agent', label: '分类' },
  ];
  assert.deepEqual(withoutEntry(nodes).map((n) => n.id), ['n1']);
});

test('normalizeCanvas adds an entry Lead and a stripped plan keeps it out', () => {
  const canvas = normalizeCanvas({
    task: '总任务',
    nodes: [{ ref: 'c', label: '分类', role: '把请求分类' }],
    edges: [{ from: 'lead', to: 'c' }],
  });
  assert.ok(!canvas.error, String(canvas.error));
  assert.ok(canvas.nodes.find((n) => n.id === 'lead'), 'entry lead exists');
  assert.ok(!withoutEntry(canvas.nodes).some((n) => n.id === 'lead'));
});

test('briefFor injects the task into a first-layer node, not a phantom Lead', () => {
  const plan = {
    task: '总任务原始数据',
    nodes: [{ id: 'n1', kind: 'agent', label: '分类', role: '把请求分类' }],
    edges: [{ from: 'lead', to: 'n1' }],
  };
  const brief = briefFor(plan, plan.nodes[0], {});
  assert.ok(brief.includes('【总任务】总任务原始数据'));
  assert.ok(!brief.includes('（没有结果）'));
  assert.ok(!brief.includes('来自【Lead'));
});

test('briefFor passes upstream results downstream', () => {
  const plan = {
    task: 't',
    nodes: [
      { id: 'n1', kind: 'agent', label: '分类', role: 'a' },
      { id: 'n2', kind: 'agent', label: '执行', role: 'b' },
    ],
    edges: [
      { from: 'lead', to: 'n1' },
      { from: 'n1', to: 'n2', type: 'prompt' },
    ],
  };
  const brief = briefFor(plan, plan.nodes[1], { n1: 'ok:分类#n1' });
  assert.ok(brief.includes('ok:分类#n1'));
  assert.ok(brief.includes('来自【分类】'));
});

test('orderNodes yields a topological order and rejects cycles', () => {
  const dag = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  };
  const order = orderNodes(dag).map((n) => n.id);
  assert.deepEqual(order, ['a', 'b', 'c']);

  const cycle = {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  };
  assert.equal(orderNodes(cycle), null);
});

test('upstreamOf drops the entry Lead edge', () => {
  const plan = {
    nodes: [{ id: 'n1', kind: 'agent', label: '分类' }],
    edges: [{ from: 'lead', to: 'n1' }],
  };
  assert.equal(upstreamOf(plan, plan.nodes[0]).length, 0);
});

test('downstreamLabels names what a node feeds', () => {
  const plan = {
    nodes: [
      { id: 'n1', kind: 'agent', label: '分类' },
      { id: 'n2', kind: 'agent', label: '执行' },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };
  assert.deepEqual(downstreamLabels(plan, plan.nodes[0]), ['执行']);
});

// The case both reviewers flagged: generate then run without a client sync. The
// generate-shaped plan still contains the entry Lead; executePlan must strip it.
test('a generate-shaped plan runs without task loss or a redundant Lead pause', async () => {
  const prompts = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        prompts.push(spec.prompt[0].text);
        return Promise.resolve({
          childId: 'kid-' + spec.label,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const canvas = normalizeCanvas({
    task: '总任务原始数据',
    nodes: [{ ref: 'c', label: '分类', role: '把请求分类' }],
    edges: [{ from: 'lead', to: 'c' }],
  });
  // generate stores the plan WITH the entry lead (the bug we fixed)
  const plan = { task: '总任务原始数据', nodes: canvas.nodes, edges: canvas.edges };

  const exec = { agent: { id: 's1' }, signal: new AbortController().signal };
  const result = await executePlan(scope, plan, {}, exec);

  assert.equal(result.status, 'done');
  assert.ok(prompts[0].includes('【总任务】总任务原始数据'), 'task reaches the first node');
  assert.ok(!prompts[0].includes('（没有结果）'));
  assert.ok(!prompts[0].includes('来自【Lead'));
});
