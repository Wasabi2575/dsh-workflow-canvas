import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderNodes, upstreamOf, downstreamLabels, briefFor, withoutEntry, analyzeCanvasWarnings, normalizeCanvas, applyPatch, inspectPlan, executePlan } from '../index.js';

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

test('applyPatch allows wiring new branches from entry Lead and reports removed edges', () => {
  const base = {
    task: '总任务',
    nodes: [
      { id: 'n1', kind: 'agent', label: '调研A', role: 'A' },
      { id: 'n2', kind: 'agent', label: '汇总', role: '汇总' },
    ],
    edges: [
      { from: 'lead', to: 'n1', type: 'prompt' },
      { from: 'n1', to: 'n2', type: 'prompt' },
    ],
  };

  const patched = applyPatch(base, {
    nodes: [{ id: 'n3', kind: 'agent', label: '调研B', role: 'B' }],
    edges: [
      { from: 'lead', to: 'n3', type: 'prompt' },
      { from: 'n3', to: 'n2', type: 'structured' },
      { from: 'n3', to: 'lead', type: 'prompt' }, // invalid: cannot point into entry lead
    ],
    removeEdges: [{ from: 'n1', to: 'n2' }],
  });

  assert.equal(patched.plan.nodes.length, 3);
  assert.ok(patched.plan.edges.some((e) => e.from === 'lead' && e.to === 'n3'), 'edge from lead is preserved');
  assert.ok(!patched.plan.edges.some((e) => e.from === 'n1' && e.to === 'n2'), 'removed edge is dropped');
  assert.ok(!patched.plan.edges.some((e) => e.to === 'lead'), 'edge into lead is rejected');
  assert.deepEqual(patched.removeEdges, [{ from: 'n1', to: 'n2' }]);
  assert.equal(patched.plan.nodes.find((n) => n.id === 'n3').structured, true, 'structured edge marks source node');
});

test('structured edge automatically requests outputSchema even when node.structured is omitted', async () => {
  const specs = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        specs.push(spec);
        return Promise.resolve({
          childId: 'kid-' + spec.label,
          result: Promise.resolve(spec.outputSchema
            ? { structured: { summary: 'ok' }, output: [], stopReason: 'completed' }
            : { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const canvas = normalizeCanvas({
    task: '总任务',
    nodes: [
      { id: 'a', label: '结构化产出', role: '产 JSON' },
      { id: 'b', label: '消费者', role: '读 JSON' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'b', type: 'structured' },
    ],
  });
  // Simulate a plan where structured flag was not pre-set on node 'a'
  const plan = {
    task: '总任务',
    nodes: canvas.nodes.map((n) => ({ ...n, structured: false })),
    edges: canvas.edges,
  };

  const exec = { agent: { id: 's2' }, signal: new AbortController().signal };
  const result = await executePlan(scope, plan, {}, exec);

  assert.equal(result.status, 'done');
  assert.ok(specs[0].outputSchema, 'upstream of structured edge gets outputSchema');
  assert.equal(specs[1].outputSchema, undefined, 'downstream without structured out-edge has no outputSchema');
  assert.ok(specs[1].prompt[0].text.includes('{"summary":"ok"}'), 'structured JSON reaches downstream');
});

test('executePlan supports task override and reset across paused Lead runs', async () => {
  const runs = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        runs.push(spec.prompt[0].text);
        return Promise.resolve({
          childId: 'kid-' + runs.length,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out-' + runs.length }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '',
    nodes: [
      { id: 'n1', kind: 'agent', label: '调研', role: '做调研' },
      { id: 'l1', kind: 'lead', label: '拍板', role: '决定路线' },
      { id: 'n2', kind: 'agent', label: '落地', role: '执行' },
    ],
    edges: [
      { from: 'lead', to: 'n1', type: 'prompt' },
      { from: 'n1', to: 'l1', type: 'prompt' },
      { from: 'l1', to: 'n2', type: 'prompt' },
    ],
  };
  const exec = { agent: { id: 's-reset' }, signal: new AbortController().signal };

  // Empty task without override is rejected
  const missing = await executePlan(scope, plan, {}, exec);
  assert.ok(missing.error);

  // Override task pauses at Lead
  const paused = await executePlan(scope, plan, { task: '新任务 A' }, exec);
  assert.equal(paused.status, 'need-lead');
  assert.ok(runs[0].includes('【总任务】新任务 A'));

  // Reset discards paused progress and re-runs n1 from scratch
  const restarted = await executePlan(scope, plan, { task: '新任务 A', reset: true }, exec);
  assert.equal(restarted.status, 'need-lead');
  assert.equal(runs.length, 2, 'n1 ran a second time after reset');

  // Resume with leadResult finishes n2
  const done = await executePlan(scope, plan, { task: '新任务 A', leadResult: '选方案 A' }, exec);
  assert.equal(done.status, 'done');
  assert.equal(runs.length, 3);
  assert.ok(runs[2].includes('选方案 A'));
});

test('session-ref continues upstream session on repeated runs', async () => {
  const calls = [];
  let seq = 0;
  const scope = {
    subagents: {
      startActivation(spec) {
        const assigned = spec.childId || ('child-' + (++seq));
        calls.push({ label: spec.label, childId: spec.childId || null, assigned });
        return Promise.resolve({
          childId: assigned,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '持续会话任务',
    nodes: [
      { id: 'u1', kind: 'agent', label: '上游', role: '准备', keepSession: true },
      { id: 'd1', kind: 'agent', label: '下游', role: '继续' },
    ],
    edges: [
      { from: 'lead', to: 'u1', type: 'prompt' },
      { from: 'u1', to: 'd1', type: 'session-ref' },
    ],
  };
  const exec = { agent: { id: 's-sess' }, signal: new AbortController().signal };

  const run1 = await executePlan(scope, plan, {}, exec);
  assert.equal(run1.status, 'done');
  assert.equal(calls[1].childId, calls[0].assigned, 'first run continues upstream session');

  const run2 = await executePlan(scope, plan, {}, exec);
  assert.equal(run2.status, 'done');
  assert.equal(calls[2].childId, calls[0].assigned, 'upstream resumes via keepSession');
  assert.equal(calls[3].childId, calls[0].assigned, 'second run still continues upstream session');
});

test('failed subagent is reported in failed list and warns downstream prompt', async () => {
  const prompts = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        prompts.push(spec.prompt[0].text);
        if (spec.label.endsWith('#bad')) {
          return Promise.reject(new Error('model not found'));
        }
        return Promise.resolve({
          childId: 'kid-ok',
          result: Promise.resolve({ output: [{ type: 'text', text: 'handled' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '容错测试',
    nodes: [
      { id: 'bad', kind: 'agent', label: '出错节点', role: '会失败' },
      { id: 'next', kind: 'agent', label: '下游节点', role: '收尾' },
    ],
    edges: [
      { from: 'lead', to: 'bad', type: 'prompt' },
      { from: 'bad', to: 'next', type: 'prompt' },
    ],
  };
  const exec = { agent: { id: 's-fail' }, signal: new AbortController().signal };
  const result = await executePlan(scope, plan, {}, exec);

  assert.equal(result.status, 'done');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'bad');
  assert.equal(result.failed[0].reason, 'activation-failed');
  assert.ok(prompts[1].includes('该上游节点执行失败'), 'downstream prompt warns about upstream failure');
});

test('inspectPlan returns empty snapshot for unknown session', () => {
  const snap = inspectPlan('non-existent-session');
  assert.equal(snap.hasCanvas, false);
  assert.equal(snap.enabled, false);
  assert.deepEqual(snap.nodes, []);
  assert.deepEqual(snap, JSON.parse(JSON.stringify(snap)), 'inspectPlan output is lossless JSON');
});

test('executePlan starts newly unblocked children immediately without waiting for slow siblings', async () => {
  const events = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        events.push('start:' + id);
        const waitMs = id === 'slow' ? 70 : 10;
        return Promise.resolve({
          childId: 'kid-' + id,
          result: delay(waitMs).then(() => {
            events.push('end:' + id);
            return { output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' };
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '并发池测试',
    nodes: [
      { id: 'fast', kind: 'agent', label: '脚手架', role: '快节点' },
      { id: 'slow', kind: 'agent', label: '回响系统', role: '慢节点' },
      { id: 'child', kind: 'agent', label: '美术', role: '只依赖脚手架' },
    ],
    edges: [
      { from: 'lead', to: 'fast', type: 'prompt' },
      { from: 'lead', to: 'slow', type: 'prompt' },
      { from: 'fast', to: 'child', type: 'prompt' },
    ],
  };

  const exec = { agent: { id: 's-pool' }, signal: new AbortController().signal };
  const result = await executePlan(scope, plan, {}, exec);

  assert.equal(result.status, 'done');
  const childStart = events.indexOf('start:child');
  const slowEnd = events.indexOf('end:slow');
  assert.ok(childStart >= 0 && slowEnd >= 0);
  assert.ok(childStart < slowEnd, 'child started before slow sibling finished: ' + events.join(', '));
});

test('normalizeCanvas promotes hand-authored root Lead and auto-wires missing lead edges', () => {
  const promoted = normalizeCanvas({
    task: '回声塔',
    nodes: [
      { id: 'n1', kind: 'lead', label: '总控·策划', role: '总控' },
      { id: 'n2', kind: 'agent', label: '脚手架', role: '搭框架' },
      { id: 'n3', kind: 'lead', label: '集成交付', role: '收尾' },
    ],
    edges: [
      { from: 'n1', to: 'n2', type: 'prompt' },
      { from: 'n2', to: 'n3', type: 'prompt' },
    ],
  });
  assert.equal(promoted.nodes.filter((n) => n.id === 'lead').length, 1);
  assert.equal(promoted.nodes.filter((n) => n.kind === 'lead').length, 2, 'no duplicate entry Lead created');
  assert.ok(promoted.edges.some((e) => e.from === 'lead' && e.to === 'n2'), 'promoted Lead edges rewritten to lead');

  const autoWired = normalizeCanvas({
    task: '自动连线测试',
    nodes: [
      { id: 'a', label: '步骤A', role: 'A' },
      { id: 'b', label: '步骤B', role: 'B' },
    ],
    edges: [{ from: 'a', to: 'b', type: 'prompt' }],
  });
  assert.ok(autoWired.edges.some((e) => e.from === 'lead' && e.to === 'a'), 'entry Lead auto-wired to root node');
});

test('analyzeCanvasWarnings flags dead-end subagents when a downstream Lead exists', () => {
  const warnings = analyzeCanvasWarnings(
    [
      { id: 'lead', kind: 'lead', label: 'Lead' },
      { id: 'n2', kind: 'agent', label: '脚手架' },
      { id: 'n3', kind: 'agent', label: '玩家控制器' },
      { id: 'n9', kind: 'lead', label: '集成交付' },
    ],
    [
      { from: 'lead', to: 'n2' },
      { from: 'lead', to: 'n3' },
      { from: 'n2', to: 'n9' },
    ],
  );
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('玩家控制器'));

  // No false warning in a simple chain with no downstream Lead
  const noWarn = analyzeCanvasWarnings(
    [{ id: 'lead', kind: 'lead', label: 'Lead' }, { id: 'a', kind: 'agent', label: 'A' }],
    [{ from: 'lead', to: 'a' }],
  );
  assert.equal(noWarn.length, 0);

  // No false warning when the only downstream Lead is already an ancestor of the terminal agent
  const afterLead = analyzeCanvasWarnings(
    [
      { id: 'lead', kind: 'lead', label: 'Lead' },
      { id: 'a', kind: 'agent', label: '方案' },
      { id: 'pick', kind: 'lead', label: 'Lead 拍板' },
      { id: 'exec', kind: 'agent', label: '执行落地' },
    ],
    [
      { from: 'lead', to: 'a' },
      { from: 'a', to: 'pick' },
      { from: 'pick', to: 'exec' },
    ],
  );
  assert.equal(afterLead.length, 0);
});

test('briefFor forbids process monologue and requires incomplete delivery marker', () => {
  const brief = briefFor(
    { task: '测试', nodes: [{ id: 'a', kind: 'agent', label: '美术', role: '画图' }], edges: [{ from: 'lead', to: 'a' }] },
    { id: 'a', kind: 'agent', label: '美术', role: '画图' },
    {},
  );
  assert.ok(brief.includes('不要包含思考独白'));
  assert.ok(brief.includes('【未完全交付】'));
});

test('executePlan stops immediately on AbortSignal without launching downstream nodes', async () => {
  const launched = [];
  const ac = new AbortController();
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        launched.push(id);
        return Promise.resolve({
          childId: 'kid-' + id,
          result: new Promise((resolve) => {
            setTimeout(() => {
              ac.abort();
              resolve({ output: [{ type: 'text', text: 'cancelled' }], stopReason: 'aborted' });
            }, 15);
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '取消测试',
    nodes: [
      { id: 'n1', kind: 'agent', label: '第一步', role: '1' },
      { id: 'n2', kind: 'agent', label: '第二步', role: '2' },
    ],
    edges: [
      { from: 'lead', to: 'n1', type: 'prompt' },
      { from: 'n1', to: 'n2', type: 'prompt' },
    ],
  };

  const result = await executePlan(scope, plan, {}, { agent: { id: 's-abort' }, signal: ac.signal });
  assert.ok(result.error && result.error.includes('取消'));
  assert.deepEqual(launched, ['n1'], 'downstream n2 must never start after abort');
});

test('applyPatch clears structured flag when structured edge is removed and updates task', () => {
  const base = {
    task: '旧任务',
    nodes: [
      { id: 'a', kind: 'agent', label: '上游', role: 'A', structured: true },
      { id: 'b', kind: 'agent', label: '下游', role: 'B', structured: false },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'b', type: 'structured' },
    ],
  };
  const patched = applyPatch(base, {
    task: '新任务',
    removeEdges: [{ from: 'a', to: 'b', type: 'structured' }],
    edges: [{ from: 'a', to: 'b', type: 'prompt' }],
  });
  assert.equal(patched.taskPatched, true);
  assert.equal(patched.plan.task, '新任务');
  assert.equal(patched.plan.nodes.find((n) => n.id === 'a').structured, false);
});

test('normalizeCanvas deduplicates duplicate node ids so DAG stays valid', () => {
  const canvas = normalizeCanvas({
    task: '去重测试',
    nodes: [
      { id: 'n1', label: '节点A', role: 'A' },
      { id: 'n1', label: '节点B', role: 'B' },
    ],
    edges: [],
  });
  const ids = canvas.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'all node ids are unique');
  assert.ok(orderNodes({ nodes: withoutEntry(canvas.nodes), edges: canvas.edges }), 'deduplicated graph is acyclic');
});

test('executePlan flags subagents that return empty prose without structured output', async () => {
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        if (id === 'silent') {
          return Promise.resolve({
            childId: 'kid-silent',
            result: Promise.resolve({ output: [], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-json',
          result: Promise.resolve({ structured: { ok: true }, output: [], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  const plan = {
    task: '空输出检查',
    nodes: [
      { id: 'silent', kind: 'agent', label: '静默节点', role: '无文本' },
      { id: 'json', kind: 'agent', label: '结构化节点', role: '产 JSON' },
    ],
    edges: [
      { from: 'lead', to: 'silent', type: 'prompt' },
      { from: 'lead', to: 'json', type: 'prompt' },
      { from: 'json', to: 'silent', type: 'structured' },
    ],
  };

  const result = await executePlan(scope, plan, {}, { agent: { id: 's-empty' }, signal: new AbortController().signal });
  assert.equal(result.status, 'done');
  assert.deepEqual(result.emptyOutputs, [{ id: 'silent', label: '静默节点' }]);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)), 'result is lossless JSON');
});
