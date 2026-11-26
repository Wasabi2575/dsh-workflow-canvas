import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, orderNodes, upstreamOf, downstreamLabels, parsePayload, clipUpstreamOutput, briefFor, normalizeMaxIterations, extractJsonObjects, parseStrictJsonObject, parseStrictConditionJson, parseConditionDecision, clipSafeSlice, withoutEntry, analyzeCanvasWarnings, normalizeCanvas, applyPatch, inspectPlan, syncPresetsCatalog, handleCanvasPreset, sessionIdFromContext, buildActiveCanvasContext, isPermissionFailure, isTransientFailure, safeSessionFileBase, writeFileAtomic, pruneMapLRU, touchMapLRU, cleanupStaleCanvasFiles, buildRunSummarySnapshot, abortSessionRun, loopMemberIds, validateLoopEdges, executePlan } from '../index.js';

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

test('terminal Lead finishes directly with status done and finalLead without redundant callback', async () => {
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '终审测试',
    nodes: [
      { id: 'a', kind: 'agent', label: '方案', role: '出方案' },
      { id: 'pick', kind: 'lead', label: 'Lead 拍板', role: '二选一' },
      { id: 'exec', kind: 'agent', label: '执行', role: '落地' },
      { id: 'final', kind: 'lead', label: 'Lead 终审', role: '验收交付' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'pick', type: 'prompt' },
      { from: 'pick', to: 'exec', type: 'prompt' },
      { from: 'exec', to: 'final', type: 'prompt' },
      { from: 'exec', to: 'final', type: 'session-ref' },
    ],
  };
  const exec = { agent: { id: 's-term-lead' }, signal: new AbortController().signal };

  // Intermediate Lead MUST pause with need-lead
  const step1 = await executePlan(scope, plan, {}, exec);
  assert.equal(step1.status, 'need-lead');
  assert.equal(step1.node.label, 'Lead 拍板');

  // Resuming runs exec, then terminal Lead finishes directly with status done + finalLead
  const step2 = await executePlan(scope, plan, { leadResult: '选方案 A' }, exec);
  assert.equal(step2.status, 'done');
  assert.equal(step2.finalLead.label, 'Lead 终审');
  assert.equal(step2.sessions[0].childId, 'kid-exec', 'session-ref handover preserved on finalLead');
  assert.equal(inspectPlan('s-term-lead').paused, false, 'run state cleaned up after terminal Lead');
});

test('solo chained Leads and dead-end subagents are warned and skipped cleanly at run time', async () => {
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'a', kind: 'agent', label: 'A', role: 'A' },
    { id: 'dead', kind: 'agent', label: '无出边', role: 'D' },
    { id: 'l1', kind: 'lead', label: 'L1', role: '1' },
    { id: 'l2', kind: 'lead', label: 'L2', role: '' },
  ];
  const edges = [
    { from: 'lead', to: 'a', type: 'prompt' },
    { from: 'lead', to: 'dead', type: 'prompt' },
    { from: 'a', to: 'l1', type: 'prompt' },
    { from: 'l1', to: 'l2', type: 'prompt' },
  ];
  const warns = analyzeCanvasWarnings(nodes, edges);
  assert.ok(warns.some((w) => w.includes('未连入子代理且未填写分工') && w.includes('L2')));
  assert.ok(warns.some((w) => w.includes('没有出边') && w.includes('无出边')));

  const res = await executePlan(
    scope,
    { task: 't', nodes: withoutEntry(nodes), edges },
    {},
    { agent: { id: 's-l2l' }, signal: new AbortController().signal },
  );
  assert.equal(res.status, 'done');
  assert.equal(res.finalLead.label, 'L1');
  assert.deepEqual(spawned, ['a'], 'dead-end subagent is skipped without spawning');
  assert.ok(res.skipped.includes('L2') && res.skipped.includes('无出边'));
});

test('runtime condition pruning cannot traverse skipped Leads, including judge failure fallback', async () => {
  for (const fail of [false, true]) {
    const spawned = [];
    const scope = { subagents: { startActivation: async spec => {
      const id = spec.label.split('#').pop();
      spawned.push(id);
      return { childId: 'kid-barrier-' + id, dispose: async () => {}, result: Promise.resolve(id === 'router'
        ? (fail ? { output: [], diagnostic: 'judge unavailable', stopReason: 'error' } : { output: [], structured: { pass: false, reason: 'false only' }, stopReason: 'completed' })
        : { output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }) };
    } } };
    const nodes = [{ id: 'router', kind: 'condition' }, { id: 'solo', kind: 'lead' }, { id: 'rejected', kind: 'agent' }, { id: 'chosen', kind: 'agent' }, { id: 'final', kind: 'lead' }].map(n => ({ ...n, label: n.id }));
    const edges = [{ from: 'lead', to: 'router' }, { from: 'lead', to: 'solo' }, { from: 'solo', to: 'rejected' }, { from: 'router', to: 'rejected', branch: 'true' }, { from: 'router', to: 'chosen', branch: 'false' }, { from: 'rejected', to: 'final' }, { from: 'chosen', to: 'final' }];
    const result = await executePlan(scope, { task: 't', nodes, edges }, {}, { agent: { id: 's-barrier-' + fail }, signal: new AbortController().signal });
    assert.equal(result.status, 'done');
    assert.deepEqual(spawned, fail ? ['router', 'router'] : ['router', 'chosen'], 'judge schema fallback remains intact; rejected branch never spawns');
    assert.ok(result.branchSkipped.includes('rejected'));
    assert.ok(result.skipped.includes('solo'));
  }
});

test('effective graph rejects loops crossing inactive Leads before spawning', async () => {
  const nodes = [{ id: 'a', kind: 'agent' }, { id: 'stage', kind: 'lead' }, { id: 'solo', kind: 'lead' }, { id: 'c', kind: 'condition' }].map(n => ({ ...n, label: n.id }));
  const edges = [{ from: 'lead', to: 'a' }, { from: 'a', to: 'stage' }, { from: 'stage', to: 'solo' }, { from: 'solo', to: 'c' }, { from: 'lead', to: 'c' }, { from: 'c', to: 'a', loop: true, branch: 'false' }];
  let spawned = 0;
  const scope = { subagents: { startActivation: () => { spawned++; throw Error('must not spawn'); } } };
  const result = await executePlan(scope, { task: 't', nodes, edges }, { clearMemory: true }, { agent: { id: 's-invalid-effective-loop' }, signal: new AbortController().signal });
  assert.match(result.error, /回环.*无效节点/);
  assert.equal(spawned, 0);
});

test('inactive Lead descendants never spawn, alternative paths and role-bearing gates still execute', async () => {
  const spawned = [];
  const scope = { subagents: { startActivation(spec) {
    const id = spec.label.split('#').pop();
    spawned.push(id);
    return Promise.resolve({
      childId: 'kid-validity-' + id,
      result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
      dispose: () => Promise.resolve(),
    });
  } } };
  const nodes = [
    { id: 'solo', kind: 'lead', label: 'Solo', role: '' },
    { id: 'tail', kind: 'agent', label: 'Tail' },
    { id: 'safe', kind: 'agent', label: 'Safe' },
  ];
  const edges = [{ from: 'lead', to: 'solo' }, { from: 'solo', to: 'tail' }, { from: 'lead', to: 'safe' }];
  const run = (plan, id, args = {}) => executePlan(scope, plan, args, { agent: { id }, signal: new AbortController().signal });
  const blocked = await run({ task: 't', nodes, edges }, 's-validity-blocked');
  assert.equal(blocked.status, 'done');
  assert.deepEqual(spawned, ['safe']);
  assert.ok(blocked.skipped.includes('Solo') && blocked.skipped.includes('Tail'));
  const warnings = analyzeCanvasWarnings(nodes, edges);
  assert.ok(warnings.some(w => w.includes('Solo') && w.includes('未填写分工')));
  assert.ok(warnings.some(w => w.includes('Tail') && w.includes('跳过')));
  spawned.length = 0;
  const alternate = await run({ task: 't', nodes, edges: [...edges, { from: 'lead', to: 'tail' }] }, 's-validity-alternate');
  assert.equal(alternate.status, 'done');
  assert.deepEqual([...spawned].sort(), ['safe', 'tail']);
  spawned.length = 0;
  const plan = {
    task: 't', nodes: nodes.slice(0, 2).map(n => n.id === 'solo' ? { ...n, role: 'Confirm' } : n),
    edges: edges.slice(0, 2),
  };
  const paused = await run(plan, 's-validity-role');
  assert.equal(paused.status, 'need-lead');
  assert.deepEqual(spawned, [], 'tail cannot bypass a valid Lead gate');
  const resumed = await run(plan, 's-validity-role', { leadResult: 'approved' });
  assert.equal(resumed.status, 'done');
  assert.deepEqual(spawned, ['tail']);
});

test('clearMemory forgets saved keepSession child sessions and active context prompts memory confirmation', async () => {
  let seq = 0;
  const seenChildIds = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        seenChildIds.push(spec.childId || null);
        const assigned = spec.childId || ('kid-mem-' + (++seq));
        return Promise.resolve({
          childId: assigned,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  let syncHandler = null;
  apply({
    inject(services, cb) {
      if (services.includes('commands')) {
        cb({
          commands: { register(cmd) { if (cmd.name === 'canvas-sync') syncHandler = cmd.handler; } },
          effect(fn) { fn(); },
        });
      }
    },
  });

  const sid = 's-mem-confirm';
  const plan = {
    task: '记忆测试',
    nodes: [{ id: 'm1', kind: 'agent', label: '记忆节点', role: '记住内容', keepSession: true }],
    edges: [{ from: 'lead', to: 'm1', type: 'prompt' }],
  };
  syncHandler({ agent: { id: sid }, rawInput: encodeURIComponent(JSON.stringify({ enabled: true, plan })) });

  // Before first run: no saved memory yet -> no memory confirmation line
  assert.equal(buildActiveCanvasContext(sid).includes('clearMemory'), false);

  // Run 1 creates kid-mem-1
  await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(seenChildIds[0], null);
  assert.equal(buildActiveCanvasContext(sid).includes('clearMemory'), true, 'active context now reminds agent to ask about keeping/clearing memory');

  // Run 2 without clearMemory reuses kid-mem-1
  await executePlan(scope, plan, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(seenChildIds[1], 'kid-mem-1');

  // Run 3 with clearMemory: true starts a fresh session
  await executePlan(scope, plan, { reset: true, clearMemory: true }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(seenChildIds[2], null, 'clearMemory clears prior keepSession childId');
});

test('executePlan circuit-breaks before launching downstream waves on permission/sandbox failure', async () => {
  const launched = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        launched.push(id);
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({
            output: [{ type: 'text', text: '【未完全交付】Error: sandbox-local: windows-acl workspace grant failed (Access is denied)' }],
            stopReason: 'completed',
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  assert.equal(isPermissionFailure({ ok: false, text: 'Permission denied' }), true);
  assert.equal(isPermissionFailure({ ok: true, text: 'normal output' }), false);

  const plan = {
    task: '熔断测试',
    nodes: [
      { id: 'w1', kind: 'agent', label: '第一波', role: '写文件' },
      { id: 'w2', kind: 'agent', label: '第二波', role: '继续干活' },
    ],
    edges: [
      { from: 'lead', to: 'w1', type: 'prompt' },
      { from: 'w1', to: 'w2', type: 'prompt' },
    ],
  };

  const res = await executePlan(scope, plan, {}, { agent: { id: 's-perm-halt' }, signal: new AbortController().signal });
  assert.equal(res.status, 'halted');
  assert.ok(res.error && res.error.includes('熔断'));
  assert.deepEqual(launched, ['w1'], 'downstream wave w2 must not be launched after permission halt');
});

test('memoryChildId pins a specific past session and temporary keepSession=false runs preserve saved memory', async () => {
  let seq = 0;
  const seenChildIds = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        seenChildIds.push(spec.childId || null);
        const assigned = spec.childId || ('kid-pick-' + (++seq));
        return Promise.resolve({
          childId: assigned,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const sid = 's-mem-pick';
  const baseEdges = [{ from: 'lead', to: 'n1', type: 'prompt' }];

  // Run 1: Memory ON -> saves kid-pick-1
  await executePlan(scope, { task: 'r1', nodes: [{ id: 'n1', kind: 'agent', label: 'A', role: 'A', keepSession: true }], edges: baseEdges }, {}, { agent: { id: sid }, signal: new AbortController().signal });
  // Run 2: Temporarily Memory OFF -> creates kid-pick-2 without overwriting kid-pick-1
  await executePlan(scope, { task: 'r2', nodes: [{ id: 'n1', kind: 'agent', label: 'A', role: 'A', keepSession: false }], edges: baseEdges }, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
  // Run 3: Memory ON (latest) -> resumes saved kid-pick-1!
  await executePlan(scope, { task: 'r3', nodes: [{ id: 'n1', kind: 'agent', label: 'A', role: 'A', keepSession: true }], edges: baseEdges }, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
  // Run 4: Memory ON with explicit memoryChildId = kid-pick-2 -> resumes kid-pick-2!
  await executePlan(scope, { task: 'r4', nodes: [{ id: 'n1', kind: 'agent', label: 'A', role: 'A', keepSession: true, memoryChildId: 'kid-pick-2' }], edges: baseEdges }, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });

  assert.deepEqual(seenChildIds, [null, null, 'kid-pick-1', 'kid-pick-2']);
});

test('executePlan honors configurable maxParallel limit from plan or args', async () => {
  let active = 0;
  let peak = 0;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const scope = {
    subagents: {
      startActivation(spec) {
        active += 1;
        peak = Math.max(peak, active);
        return Promise.resolve({
          childId: 'kid-' + spec.label,
          result: delay(20).then(() => {
            active -= 1;
            return { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' };
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const nodes = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'p' + i, kind: 'agent', label: 'P' + i, role: 'r' }));
  const edges = nodes.map((n) => ({ from: 'lead', to: n.id, type: 'prompt' }));

  // maxParallel = 1 -> strictly serial
  await executePlan(scope, { task: 'serial', maxParallel: 1, nodes, edges }, {}, { agent: { id: 's-mp1' }, signal: new AbortController().signal });
  assert.equal(peak, 1);

  // maxParallel = 6 -> all 6 run concurrently
  peak = 0;
  await executePlan(scope, { task: 'wide', maxParallel: 6, nodes, edges }, {}, { agent: { id: 's-mp6' }, signal: new AbortController().signal });
  assert.equal(peak, 6);
});

test('retryFailed and fromNodes reuse succeeded nodes and re-run only failed/target nodes plus downstream', async () => {
  let failB = true;
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'b' && failB) {
          return Promise.reject(new Error('transient error'));
        }
        return Promise.resolve({
          childId: 'kid-' + id + '-' + spawned.length,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id + '#' + spawned.length }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const sid = 's-partial-retry';
  const plan = {
    task: '局部重跑测试',
    nodes: [
      { id: 'a', kind: 'agent', label: '节点A', role: 'A' },
      { id: 'b', kind: 'agent', label: '节点B', role: 'B' },
      { id: 'c', kind: 'agent', label: '下游C', role: 'C' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'lead', to: 'b', type: 'prompt' },
      { from: 'a', to: 'c', type: 'prompt' },
      { from: 'b', to: 'c', type: 'prompt' },
    ],
  };

  // Run 1: a succeeds, b fails, c runs with warning
  const r1 = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r1.status, 'done');
  assert.equal(r1.failed.length, 1);
  assert.equal(r1.failed[0].id, 'b');

  // Run 2: fix b and call retryFailed -> a is REUSED (not spawned), only b and downstream c re-run!
  spawned.length = 0;
  failB = false;
  const r2 = await executePlan(scope, plan, { retryFailed: true }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r2.status, 'done');
  assert.equal(r2.failed.length, 0);
  assert.deepEqual(spawned, ['b', 'c'], 'node a must be reused from cache without re-spawning');
  assert.deepEqual(r2.reused, ['节点A']);

  // Run 3: fromNodes=['下游C'] -> reuses both a and b, re-runs only c!
  spawned.length = 0;
  const r3 = await executePlan(scope, plan, { fromNodes: ['下游C'] }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r3.status, 'done');
  assert.deepEqual(spawned, ['c']);
  assert.deepEqual(r3.reused.sort(), ['节点A', '节点B']);
});

test('parseConditionDecision parses structured, JSON prose, binary, and multi-way switch/case verdicts', () => {
  const b1 = parseConditionDecision({ structured: { pass: true, reason: 'all ok' } }, '');
  assert.equal(b1.pass, true);
  assert.equal(b1.branch, 'true');
  assert.equal(b1.reason, 'all ok');

  const b2 = parseConditionDecision({}, '结论如下：{"pass": false, "reason": "单测失败"}');
  assert.equal(b2.pass, false);
  assert.equal(b2.branch, 'false');
  assert.equal(b2.reason, '单测失败');

  assert.equal(parseConditionDecision({}, 'true - passed').pass, true);
  assert.equal(parseConditionDecision({}, 'failed to build').pass, false);

  const sw = parseConditionDecision(
    { structured: { branch: '小修', reason: '只有一处拼写问题' } },
    '',
    ['通过', '小修', '重做'],
  );
  assert.equal(sw.branch, '小修');
  assert.equal(sw.branchLabel, '小修');
  assert.equal(sw.reason, '只有一处拼写问题');
});

test('condition node routes true/false branches, prunes unchosen path, and converges cleanly into Lead', async () => {
  let verdict = { pass: true, reason: '测试全通过' };
  const spawned = [];
  const specs = new Map();
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        specs.set(id, spec);
        if (id === 'gate') {
          return Promise.resolve({
            childId: 'kid-gate',
            result: Promise.resolve({
              structured: verdict,
              output: [{ type: 'text', text: JSON.stringify(verdict) }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const canvas = normalizeCanvas({
    task: '条件分流测试',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行测试', role: '跑测试' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '判断测试是否全通过' },
      { id: 'yes_node', kind: 'agent', label: '打包发布', role: '整理发布' },
      { id: 'no_node', kind: 'agent', label: '定位修复', role: '修 bug' },
      { id: 'review', kind: 'lead', label: 'Lead 终审', role: '汇总交付' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'yes_node', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'no_node', type: 'prompt', branch: 'false' },
      { from: 'yes_node', to: 'review', type: 'prompt' },
      { from: 'no_node', to: 'review', type: 'prompt' },
    ],
  });
  assert.ok(!canvas.error);
  const plan = { task: canvas.task, nodes: withoutEntry(canvas.nodes), edges: canvas.edges };

  // Branch 1: pass=true -> runs yes_node, skips no_node, converges to terminal Lead
  const rTrue = await executePlan(scope, plan, {}, { agent: { id: 's-cond-true' }, signal: new AbortController().signal });
  assert.equal(rTrue.status, 'done');
  assert.deepEqual(spawned, ['run', 'gate', 'yes_node']);
  assert.equal(specs.get('gate').agentPreset, 'minimal', 'condition node always runs with minimal preset');
  assert.ok(specs.get('gate').outputSchema, 'condition node requests structured boolean outputSchema');
  assert.deepEqual(rTrue.branchSkipped, ['定位修复']);
  assert.equal(rTrue.decisions.length, 1);
  assert.equal(rTrue.decisions[0].pass, true);
  assert.equal(rTrue.finalLead.label, 'Lead 终审');
  assert.deepEqual(rTrue.finalLead.needs, ['打包发布'], 'converging Lead only depends on the active branch');

  // Branch 2: pass=false -> runs no_node, skips yes_node, converges to terminal Lead
  spawned.length = 0;
  verdict = { pass: false, reason: '存在 2 个失败用例' };
  const rFalse = await executePlan(scope, plan, {}, { agent: { id: 's-cond-false' }, signal: new AbortController().signal });
  assert.equal(rFalse.status, 'done');
  assert.deepEqual(spawned, ['run', 'gate', 'no_node']);
  assert.deepEqual(rFalse.branchSkipped, ['打包发布']);
  assert.equal(rFalse.decisions[0].pass, false);
  assert.deepEqual(rFalse.finalLead.needs, ['定位修复']);
});

test('upstream failure feeding a condition node routes to false branch instead of halting', async () => {
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'run') {
          return Promise.resolve({
            childId: 'kid-run',
            result: Promise.resolve({
              output: [{ type: 'text', text: 'Error: EACCES permission denied' }],
              stopReason: 'failed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'gate') {
          const promptText = Array.isArray(spec.prompt) ? spec.prompt.map((b) => b.text || '').join('\n') : String(spec.prompt || '');
          const sawFailure = promptText.includes('执行失败');
          return Promise.resolve({
            childId: 'kid-gate',
            result: Promise.resolve({
              structured: { pass: !sawFailure, reason: sawFailure ? '上游报错' : '成功' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'fallback handled' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '异常兜底分流',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行', role: '执行' },
      { id: 'gate', kind: 'condition', label: '成功了吗', role: '判断是否成功' },
      { id: 'ok_step', kind: 'agent', label: '继续', role: '继续' },
      { id: 'err_step', kind: 'agent', label: '降级方案', role: '降级处理' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'ok_step', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'err_step', type: 'prompt', branch: 'false' },
    ],
  };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-cond-fail-route' }, signal: new AbortController().signal });
  assert.equal(res.status, 'done', 'must not circuit-break when upstream failure feeds a condition node');
  assert.deepEqual(spawned, ['run', 'gate', 'err_step']);
  assert.deepEqual(res.branchSkipped, ['继续']);
  assert.equal(res.decisions[0].pass, false);
});

test('switch/case condition node routes 3+ named branches and blocks ancestor side session-ref bypass', async () => {
  let chosenBranch = '小修';
  const spawned = [];
  const specs = new Map();
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        specs.set(id, spec);
        if (id === 'router') {
          return Promise.resolve({
            childId: 'kid-router',
            result: Promise.resolve({
              structured: { branch: chosenBranch, reason: '命中 ' + chosenBranch },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const canvas = normalizeCanvas({
    task: '三态代码审查分流',
    nodes: [
      { id: 'scan', kind: 'agent', label: '代码实现', role: '实现代码' },
      { id: 'router', kind: 'condition', label: '审查分级', role: '按严重程度分流', branches: ['通过', '小修', '重做'] },
      { id: 'ship', kind: 'agent', label: '直接发布', role: '发布' },
      { id: 'patch', kind: 'agent', label: '局部修复', role: '接着原会话修小问题' },
      { id: 'redo', kind: 'agent', label: '推倒重做', role: '重新设计' },
      { id: 'final', kind: 'lead', label: 'Lead 终审', role: '验收' },
    ],
    edges: [
      { from: 'lead', to: 'scan', type: 'prompt' },
      { from: 'scan', to: 'router', type: 'prompt' },
      { from: 'router', to: 'ship', type: 'prompt', branch: '通过' },
      { from: 'router', to: 'patch', type: 'prompt', branch: '小修' },
      { from: 'scan', to: 'patch', type: 'session-ref' },
      { from: 'router', to: 'redo', type: 'prompt', branch: '重做' },
      { from: 'ship', to: 'final', type: 'prompt' },
      { from: 'patch', to: 'final', type: 'prompt' },
      { from: 'redo', to: 'final', type: 'prompt' },
    ],
  });
  assert.ok(!canvas.error);
  const plan = { task: canvas.task, nodes: withoutEntry(canvas.nodes), edges: canvas.edges };

  // Case 1: picks '小修' -> patch runs AND resumes scan's warm session via side session-ref!
  const rPatch = await executePlan(scope, plan, {}, { agent: { id: 's-switch-patch' }, signal: new AbortController().signal });
  assert.equal(rPatch.status, 'done');
  assert.deepEqual(spawned, ['scan', 'router', 'patch']);
  assert.equal(specs.get('patch').childId, 'kid-scan', 'patch resumes scan warm session when selected');
  const schema = specs.get('router').outputSchema;
  assert.deepEqual(schema.properties.branches.items.enum, ['通过', '小修', '重做']);
  // Guard against DSH's strict JSON schema subset (rejects maxItems/minItems/etc.).
  const ALLOWED_SCHEMA_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description']);
  const checkSchemaKeys = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      assert.ok(ALLOWED_SCHEMA_KEYS.has(key), 'unsupported DSH outputSchema keyword: ' + key);
      if (key === 'properties' && obj.properties) {
        for (const prop of Object.values(obj.properties)) checkSchemaKeys(prop);
      } else if (key === 'items') {
        checkSchemaKeys(obj.items);
      }
    }
  };
  checkSchemaKeys(schema);
  assert.deepEqual(rPatch.branchSkipped.sort(), ['推倒重做', '直接发布']);
  assert.equal(rPatch.decisions[0].branch, '小修');

  // Case 2: picks '通过' -> patch MUST stay pruned even though scan --session-ref--> patch exists!
  spawned.length = 0;
  chosenBranch = '通过';
  const rShip = await executePlan(scope, plan, {}, { agent: { id: 's-switch-ship' }, signal: new AbortController().signal });
  assert.equal(rShip.status, 'done');
  assert.deepEqual(spawned, ['scan', 'router', 'ship'], 'side session-ref from ancestor must not bypass blocked branch');
  assert.deepEqual(rShip.branchSkipped.sort(), ['局部修复', '推倒重做']);
  assert.deepEqual(rShip.finalLead.needs, ['直接发布']);
});

test('condition node handles multiMatch parallel branches and zero-match full skip cleanly', async () => {
  let matched = ['前端', '文档'];
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'router') {
          return Promise.resolve({
            childId: 'kid-router',
            result: Promise.resolve({
              structured: { branches: matched, reason: matched.length ? '命中多个' : '均不满足' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'done:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const canvas = normalizeCanvas({
    task: '多选与零命中测试',
    nodes: [
      { id: 'audit', kind: 'agent', label: '代码体检', role: '体检' },
      { id: 'router', kind: 'condition', label: '分发器', role: '按问题多选分发', branches: ['前端', '后端', '文档'], multiMatch: true },
      { id: 'fe', kind: 'agent', label: '修前端', role: '前端' },
      { id: 'be', kind: 'agent', label: '修后端', role: '后端' },
      { id: 'doc', kind: 'agent', label: '改文档', role: '文档' },
      { id: 'final', kind: 'lead', label: 'Lead 终审', role: '汇总' },
    ],
    edges: [
      { from: 'lead', to: 'audit', type: 'prompt' },
      { from: 'audit', to: 'router', type: 'prompt' },
      { from: 'router', to: 'fe', type: 'prompt', branch: '前端' },
      { from: 'router', to: 'be', type: 'prompt', branch: '后端' },
      { from: 'router', to: 'doc', type: 'prompt', branch: '文档' },
      { from: 'fe', to: 'final', type: 'prompt' },
      { from: 'be', to: 'final', type: 'prompt' },
      { from: 'doc', to: 'final', type: 'prompt' },
    ],
  });
  const plan = { task: canvas.task, nodes: withoutEntry(canvas.nodes), edges: canvas.edges };

  // Multi-match: 前端 + 文档 run in parallel, 后端 is pruned, final Lead receives both!
  const rMulti = await executePlan(scope, plan, {}, { agent: { id: 's-multi' }, signal: new AbortController().signal });
  assert.equal(rMulti.status, 'done');
  assert.ok(spawned.includes('fe') && spawned.includes('doc') && !spawned.includes('be'));
  assert.deepEqual(rMulti.branchSkipped, ['修后端']);
  assert.deepEqual(rMulti.decisions[0].branches, ['前端', '文档']);
  assert.deepEqual(rMulti.finalLead.needs.sort(), ['修前端', '改文档']);

  // Zero-match with downstream terminal Lead: skips intermediate branches and jumps directly to Lead 终审 with status notice!
  spawned.length = 0;
  matched = [];
  const rZero = await executePlan(scope, plan, {}, { agent: { id: 's-zero' }, signal: new AbortController().signal });
  assert.equal(rZero.status, 'done');
  assert.deepEqual(spawned, ['audit', 'router']);
  assert.deepEqual(rZero.decisions[0].branches, []);
  assert.equal(rZero.decisions[0].fallbackLead, 'Lead 终审');
  assert.deepEqual(rZero.branchSkipped.sort(), ['修前端', '修后端', '改文档']);
  assert.equal(rZero.finalLead.label, 'Lead 终审');
  assert.deepEqual(rZero.finalLead.needs, ['分发器']);
  assert.ok(rZero.hint.includes('均未命中') && rZero.hint.includes('直接转交'));

  // Zero-match with intermediate Lead -> pauses at that nearest Lead (`need-lead`) with notice, then runs downstream after leadResult!
  const midCanvas = normalizeCanvas({
    task: '中间 Lead 兜底测试',
    nodes: [
      { id: 'audit', kind: 'agent', label: '体检', role: '体检' },
      { id: 'router', kind: 'condition', label: '分发器', role: '分流', branches: ['前端', '后端'] },
      { id: 'fe', kind: 'agent', label: '修前端', role: '前端' },
      { id: 'be', kind: 'agent', label: '修后端', role: '后端' },
      { id: 'gate', kind: 'lead', label: 'Lead 拍板', role: '人工拍板' },
      { id: 'wrap', kind: 'agent', label: '收尾报告', role: '写报告' },
    ],
    edges: [
      { from: 'lead', to: 'audit', type: 'prompt' },
      { from: 'audit', to: 'router', type: 'prompt' },
      { from: 'router', to: 'fe', type: 'prompt', branch: '前端' },
      { from: 'router', to: 'be', type: 'prompt', branch: '后端' },
      { from: 'fe', to: 'gate', type: 'prompt' },
      { from: 'be', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'wrap', type: 'prompt' },
    ],
  });
  const midPlan = { task: midCanvas.task, nodes: withoutEntry(midCanvas.nodes), edges: midCanvas.edges };
  spawned.length = 0;
  const rMidPause = await executePlan(scope, midPlan, {}, { agent: { id: 's-zero-mid' }, signal: new AbortController().signal });
  assert.equal(rMidPause.status, 'need-lead', 'jumps straight to nearest intermediate Lead instead of pruning it');
  assert.equal(rMidPause.node.label, 'Lead 拍板');
  assert.deepEqual(spawned, ['audit', 'router']);
  assert.deepEqual(rMidPause.branchSkipped.sort(), ['修前端', '修后端']);
  assert.ok(rMidPause.hint.includes('均未命中') && rMidPause.hint.includes('直接转交'));

  // Resume after Lead decision -> downstream 'wrap' executes cleanly!
  spawned.length = 0;
  const rMidDone = await executePlan(scope, midPlan, { leadResult: '无需修复，直接出报告' }, { agent: { id: 's-zero-mid' }, signal: new AbortController().signal });
  assert.equal(rMidDone.status, 'done');
  assert.deepEqual(spawned, ['wrap']);
});

test('failed condition node never guesses a branch, hands off to nearest Lead or halts, and recovers via retryFailed', async () => {
  let crashGate = true;
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'gate') {
          if (crashGate) return Promise.reject(new Error('429 rate limit'));
          return Promise.resolve({
            childId: 'kid-gate-ok',
            result: Promise.resolve({
              structured: { pass: true, reason: '重试后判定通过' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  // Case A: Downstream Lead exists -> skips all branch subagents (never guesses false!), jumps to Lead with failure notice
  const withLead = {
    task: '条件节点崩溃测试',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行', role: '执行' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '判断' },
      { id: 'yes_s', kind: 'agent', label: '发布', role: '发布' },
      { id: 'no_s', kind: 'agent', label: '回滚', role: '回滚' },
      { id: 'final', kind: 'lead', label: 'Lead 终审', role: '终审' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'yes_s', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'no_s', type: 'prompt', branch: 'false' },
      { from: 'yes_s', to: 'final', type: 'prompt' },
      { from: 'no_s', to: 'final', type: 'prompt' },
    ],
  };
  const sidA = 's-cond-crash-lead';
  const rFailLead = await executePlan(scope, withLead, {}, { agent: { id: sidA }, signal: new AbortController().signal });
  assert.equal(rFailLead.status, 'done');
  assert.deepEqual(spawned, ['run', 'gate'], 'neither yes_s nor no_s may run when condition node crashed');
  assert.equal(rFailLead.failed.length, 1);
  assert.equal(rFailLead.failed[0].id, 'gate');
  assert.equal(rFailLead.decisions[0].failed, true);
  assert.equal(rFailLead.finalLead.label, 'Lead 终审');
  assert.ok(rFailLead.hint.includes('自身执行失败') && rFailLead.hint.includes('retryFailed'));

  // Retry failed -> reuses 'run' from cache, re-runs only 'gate' and the newly chosen 'yes_s'!
  spawned.length = 0;
  crashGate = false;
  const rRecovered = await executePlan(scope, withLead, { retryFailed: true }, { agent: { id: sidA }, signal: new AbortController().signal });
  assert.equal(rRecovered.status, 'done');
  assert.deepEqual(spawned, ['gate', 'yes_s'], 'reuses upstream run and executes winning branch');
  assert.deepEqual(rRecovered.reused, ['执行']);
  assert.deepEqual(rRecovered.branchSkipped, ['回滚']);

  // Case B: No downstream Lead -> halts cleanly instead of guessing a branch
  const noLead = {
    task: '无 Lead 条件崩溃测试',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行', role: '执行' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '判断' },
      { id: 'yes_s', kind: 'agent', label: '发布', role: '发布' },
      { id: 'no_s', kind: 'agent', label: '回滚', role: '回滚' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'yes_s', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'no_s', type: 'prompt', branch: 'false' },
    ],
  };
  spawned.length = 0;
  crashGate = true;
  const rHalted = await executePlan(scope, noLead, {}, { agent: { id: 's-cond-crash-nolead' }, signal: new AbortController().signal });
  assert.equal(rHalted.status, 'halted');
  assert.deepEqual(spawned, ['run', 'gate']);
  assert.ok(rHalted.error.includes('自身执行失败') && rHalted.error.includes('retryFailed'));
});

test('executePlan publishes live run-state telemetry (.run.json) with condition verdicts and pruned nodes', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wc-runstate-'));
  try {
    const sid = 's-runstate-telemetry';
    const scope = {
      sessions: {
        get(id) {
          return id === sid ? { header: { cwd: dir } } : null;
        },
      },
      subagents: {
        startActivation(spec) {
          const id = spec.label.split('#')[1];
          if (id === 'gate') {
            return Promise.resolve({
              childId: 'kid-gate',
              result: Promise.resolve({
                status: 'completed',
                structured: { branches: ['minor'], reason: '仅两处小修，无需重写' },
                finalText: '',
              }),
            });
          }
          return Promise.resolve({
            childId: 'kid-' + id,
            result: Promise.resolve({ status: 'completed', finalText: 'done-' + id }),
          });
        },
      },
    };
    const plan = {
      task: 'telemetry test',
      nodes: [
        { id: 'scan', kind: 'agent', label: '扫描', role: '扫描' },
        {
          id: 'gate',
          kind: 'condition',
          label: '分级',
          role: '按严重度分级',
          branches: [
            { id: 'minor', label: '小修' },
            { id: 'rewrite', label: '重写' },
          ],
        },
        { id: 'fix', kind: 'agent', label: '小修执行', role: '小修' },
        { id: 'redo', kind: 'agent', label: '重写执行', role: '重写' },
      ],
      edges: [
        { from: 'lead', to: 'scan', type: 'prompt' },
        { from: 'scan', to: 'gate', type: 'prompt' },
        { from: 'gate', to: 'fix', type: 'prompt', branch: 'minor' },
        { from: 'gate', to: 'redo', type: 'prompt', branch: 'rewrite' },
      ],
    };
    const res = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(res.status, 'done');
    const runFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sid + '.run.json'), 'utf8'));
    assert.equal(runFile.status, 'done');
    assert.deepEqual(runFile.decisions.gate.branchLabels, ['小修']);
    assert.equal(runFile.decisions.gate.reason, '仅两处小修，无需重写');
    assert.deepEqual(runFile.pruned, ['redo']);
    assert.ok(runFile.blockedEdges.some((k) => k.startsWith('gate->redo|')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('briefFor, normalizeCanvas, and applyPatch inject and preserve global and per-node refs', () => {
  const gen = normalizeCanvas({
    task: '代码审查',
    refs: ['README.md', '  README.md  ', 'docs/api.md'],
    nodes: [
      { ref: 'a1', kind: 'agent', label: '审查模块', role: '只读排查', refs: ['src/index.js', 'README.md'] },
    ],
    edges: [{ from: 'lead', to: 'a1', type: 'prompt' }],
  });
  assert.ok(!gen.error);
  const entry = gen.nodes.find((n) => n.id === 'lead');
  assert.deepEqual(entry.refs, ['README.md', 'docs/api.md']);
  const aNode = gen.nodes.find((n) => n.id !== 'lead');
  assert.deepEqual(aNode.refs, ['src/index.js', 'README.md']);

  const prompt = briefFor(
    { task: '代码审查', refs: entry.refs, nodes: withoutEntry(gen.nodes), edges: gen.edges },
    aNode,
    {},
  );
  assert.ok(prompt.includes('【参考资料 / 约束】'));
  assert.ok(prompt.includes('- README.md'));
  assert.ok(prompt.includes('- docs/api.md'));
  assert.ok(prompt.includes('- src/index.js'));
  assert.equal(prompt.match(/README\.md/g).length, 1, 'duplicate refs must be deduplicated');

  const patched = applyPatch(
    { task: '代码审查', refs: entry.refs, nodes: withoutEntry(gen.nodes), edges: gen.edges },
    {
      refs: ['docs/new.md'],
      nodes: [{ id: aNode.id, refs: ['src/client.js'] }],
    },
  );
  assert.equal(patched.refsPatched, true);
  assert.deepEqual(patched.plan.refs, ['docs/new.md']);
  assert.deepEqual(patched.plan.nodes[0].refs, ['src/client.js']);
});

test('Lead -> Lead stage chains execute with zero subagents and pass leadResult downstream', async () => {
  const spawned = [];
  const briefs = {};
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        briefs[id] = (spec.prompt && spec.prompt[0] && spec.prompt[0].text) || '';
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'done:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };

  // Pure Lead -> Lead -> Lead main-conversation stage chain (0 subagents)
  const stageNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'l1', kind: 'lead', label: '方案起草', role: '在主对话起草方案并与用户确认', refs: ['docs/spec.md'] },
    { id: 'l2', kind: 'lead', label: '最终交付', role: '总结变更并给出发布指令' },
  ];
  const stageEdges = [
    { from: 'lead', to: 'l1', type: 'prompt' },
    { from: 'l1', to: 'l2', type: 'prompt' },
  ];
  assert.deepEqual(analyzeCanvasWarnings(stageNodes, stageEdges), []);

  const plan = { task: '重构配置模块', nodes: withoutEntry(stageNodes), edges: stageEdges };
  const sid = 's-lead-stages-' + Date.now();
  const r1 = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r1.status, 'need-lead');
  assert.equal(r1.node.label, '方案起草');
  assert.equal(r1.node.role, '在主对话起草方案并与用户确认');
  assert.deepEqual(r1.node.refs, ['docs/spec.md']);
  assert.equal(spawned.length, 0);

  const r2 = await executePlan(scope, plan, { leadResult: '已确认采用方案 B' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r2.status, 'done');
  assert.equal(r2.finalLead.label, '最终交付');
  assert.equal(r2.finalLead.role, '总结变更并给出发布指令');
  assert.equal(r2.results.l1, '已确认采用方案 B');
  assert.equal(spawned.length, 0, 'pure Lead chain never spawns subagents');

  // Lead -> Lead(stage) -> Subagent passes leadResult into downstream subagent brief
  const mixNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'pre', kind: 'lead', label: '主对话调研', role: '先和用户明确边界' },
    { id: 'impl', kind: 'agent', label: '实现', role: '按确认的边界写代码' },
  ];
  const mixEdges = [
    { from: 'lead', to: 'pre', type: 'prompt' },
    { from: 'pre', to: 'impl', type: 'prompt' },
  ];
  const mixPlan = { task: '新增主题切换', nodes: withoutEntry(mixNodes), edges: mixEdges };
  const sid2 = 's-lead-to-agent-' + Date.now();
  const m1 = await executePlan(scope, mixPlan, {}, { agent: { id: sid2 }, signal: new AbortController().signal });
  assert.equal(m1.status, 'need-lead');
  assert.equal(m1.node.label, '主对话调研');
  assert.equal(spawned.length, 0);

  const m2 = await executePlan(scope, mixPlan, { leadResult: '仅保留深浅双色，不做自定义配色' }, { agent: { id: sid2 }, signal: new AbortController().signal });
  assert.equal(m2.status, 'done');
  assert.deepEqual(spawned, ['impl']);
  assert.ok(briefs.impl.includes('仅保留深浅双色，不做自定义配色'));
});

test('condition node auto-retries without outputSchema on provider error and exposes real error without misleading fallback wording', async () => {
  const gateSpecs = [];
  const scope1 = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        if (id === 'gate') {
          gateSpecs.push(spec);
          if (spec.outputSchema) {
            return Promise.resolve({
              childId: 'kid-gate-schema-err',
              result: Promise.resolve({
                output: [],
                stopReason: 'error',
                error: 'response_format json_schema is not supported by this provider',
              }),
              dispose: () => Promise.resolve(),
            });
          }
          return Promise.resolve({
            childId: 'kid-gate-plain-ok',
            result: Promise.resolve({
              output: [{ type: 'text', text: '{"pass": true, "reason": "自检全部通过"}' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '条件降级重试测试',
    nodes: [
      { id: 'run', kind: 'agent', label: '执行', role: '执行' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '判断', model: 'DeepSeek-V4-Pro' },
      { id: 'yes_s', kind: 'agent', label: '发布', role: '发布' },
      { id: 'final', kind: 'lead', label: '终审', role: '终审' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'yes_s', type: 'prompt', branch: 'true' },
      { from: 'yes_s', to: 'final', type: 'prompt' },
    ],
  };
  const resOk = await executePlan(scope1, plan, {}, { agent: { id: 's-schema-fallback-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(resOk.status, 'done');
  assert.equal(gateSpecs.length, 2, 'retries condition node once without outputSchema');
  assert.ok(gateSpecs[0].outputSchema, 'first attempt requests outputSchema');
  assert.equal(gateSpecs[1].outputSchema, undefined, 'downgrade retry omits outputSchema');
  assert.equal(resOk.failed.length, 0);
  assert.equal(resOk.results.yes_s, 'ok:yes_s', 'downstream true branch runs cleanly after plain-JSON rescue');

  // When both attempts fail without fallbackModel, surface real error detail and NEVER blame "未配置备用模型"
  const scope2 = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        if (id === 'gate') {
          return Promise.resolve({
            childId: 'kid-gate-hard-err',
            result: Promise.resolve({
              output: [],
              stopReason: 'error',
              error: 'upstream gateway 502 bad gateway',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const resFail = await executePlan(scope2, plan, {}, { agent: { id: 's-schema-hardfail-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(resFail.status, 'done');
  assert.equal(resFail.failed.length, 1);
  assert.equal(resFail.failed[0].reason, 'error', 'keeps canonical machine reason code');
  assert.ok(resFail.results.gate.includes('502 bad gateway'), 'surfaces real host error detail in result text');
  assert.ok(resFail.results.gate.includes('DeepSeek-V4-Pro'), 'mentions the actual model that failed');
  assert.ok(!resFail.results.gate.includes('未配置备用模型'), 'must never mislead Lead into blaming missing fallbackModel');
});

test('read-only nodes retry once on transient 503/429 while writable standard agents never auto-retry and AbortSignal cancels backoff', async () => {
  assert.equal(isTransientFailure({ ok: false, reason: 'error', errorDetail: 'HTTP 503 Service Unavailable' }), true);
  assert.equal(isTransientFailure({ ok: false, reason: 'error', text: '429 rate limit exceeded' }), true);
  assert.equal(isTransientFailure({ ok: false, reason: 'error', text: 'permission denied' }), false);
  assert.equal(isTransientFailure({ ok: false, reason: 'aborted', text: '503' }), false);
  assert.equal(isTransientFailure({ ok: false, reason: 'max_tokens', text: 'HTTP 502 error handling review...' }), false, 'max_tokens truncation mentioning 502 must not trigger retry');
  assert.equal(isTransientFailure({ ok: false, reason: 'error', text: 'long prose mentioning timeout '.repeat(30) }), false, 'long non-error prose without errorDetail must not trigger retry');

  // 1) Read-only `minimal` + `condition` nodes each recover on a single transient retry
  const calls = { ro: 0, gate: 0, std: 0 };
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        calls[id] = (calls[id] || 0) + 1;
        if (id === 'ro' && calls.ro === 1) {
          return Promise.resolve({
            childId: 'kid-ro-1',
            result: Promise.resolve({ output: [], stopReason: 'error', error: '503 Service Unavailable' }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'gate' && calls.gate === 1) {
          return Promise.resolve({
            childId: 'kid-gate-1',
            result: Promise.resolve({ output: [], stopReason: 'error', error: '429 Too Many Requests' }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'gate') {
          assert.ok(spec.outputSchema, 'transient retry preserves outputSchema on condition node');
          return Promise.resolve({
            childId: 'kid-gate-2',
            result: Promise.resolve({ structured: { pass: true, reason: 'retry ok' }, output: [{ type: 'text', text: '' }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'std') {
          return Promise.resolve({
            childId: 'kid-std-1',
            result: Promise.resolve({ output: [], stopReason: 'error', error: '503 Service Unavailable' }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id + '-' + calls[id],
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '瞬态重试策略测试',
    __transientDelayMs: 5,
    nodes: [
      { id: 'ro', kind: 'agent', preset: 'minimal', label: '只读分析', role: '分析' },
      { id: 'gate', kind: 'condition', label: '是否继续', role: '判断' },
      { id: 'std', kind: 'agent', preset: 'standard', label: '写文件节点', role: '修改文件' },
    ],
    edges: [
      { from: 'lead', to: 'ro', type: 'prompt' },
      { from: 'ro', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'std', type: 'prompt', branch: 'true' },
    ],
  };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-transient-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(res.status, 'done');
  assert.equal(calls.ro, 2, 'minimal read-only agent retries once after 503');
  assert.equal(calls.gate, 2, 'condition node retries once after 429');
  assert.equal(calls.std, 1, 'writable standard agent must NEVER auto-retry transient errors');
  assert.equal(res.results.ro, 'ok:ro');
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, 'std');

  // 2) AbortSignal fired during backoff cancels cleanly with zero zombie retry spawn
  const abortCtrl = new AbortController();
  let abortCalls = 0;
  const abortScope = {
    subagents: {
      startActivation() {
        abortCalls += 1;
        setTimeout(() => abortCtrl.abort('user-stop'), 15);
        return Promise.resolve({
          childId: 'kid-abort-1',
          result: Promise.resolve({ output: [], stopReason: 'error', error: '504 Gateway Timeout' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const abortPlan = {
    task: '取消退避测试',
    __transientDelayMs: 5000,
    nodes: [{ id: 'ro', kind: 'agent', preset: 'minimal', label: '只读', role: '只读' }],
    edges: [{ from: 'lead', to: 'ro', type: 'prompt' }],
  };
  const t0 = Date.now();
  const abortRes = await executePlan(abortScope, abortPlan, {}, { agent: { id: 's-transient-abort-' + Date.now() }, signal: abortCtrl.signal });
  assert.equal(abortRes.status, 'halted');
  assert.equal(abortCalls, 1, 'must not spawn a second child after abort during backoff');
  assert.ok(Date.now() - t0 < 2000, 'backoff delay aborts immediately instead of waiting 5s');
});

test('executePlan rejects concurrent re-entrant runs on the same session and safeSessionFileBase sanitizes unsafe ids', async () => {
  assert.equal(safeSessionFileBase('session-550e8400-e29b-41d4-a716-446655440000'), 'session-550e8400-e29b-41d4-a716-446655440000');
  assert.equal(safeSessionFileBase('remote:abc/123\\x*?'), 'remote_abc_123_x__');
  assert.ok(!safeSessionFileBase('../../etc/passwd').includes('..'), 'neutralizes path traversal');
  assert.ok(!safeSessionFileBase('../../etc/passwd').includes('/'));
  assert.ok(!safeSessionFileBase('.hidden').startsWith('.'));

  let releaseFirst;
  let spawnCount = 0;
  const scope = {
    subagents: {
      startActivation() {
        spawnCount += 1;
        return Promise.resolve({
          childId: 'kid-lock-' + spawnCount,
          result: new Promise((resolve) => {
            if (spawnCount === 1) {
              releaseFirst = () => resolve({ output: [{ type: 'text', text: 'first-done' }], stopReason: 'completed' });
            } else {
              resolve({ output: [{ type: 'text', text: 'second-done' }], stopReason: 'completed' });
            }
          }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '并发锁测试',
    nodes: [{ id: 'a', kind: 'agent', label: 'A', role: 'r1' }],
    edges: [{ from: 'lead', to: 'a', type: 'prompt' }],
  };
  const sid = 's-reentry-' + Date.now();
  const run1Promise = executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  // Wait a microtask tick so run1 registers in activeRunBySession
  await new Promise((r) => setTimeout(r, 10));

  const concurrentErr = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.ok(concurrentErr.error && concurrentErr.error.includes('正在执行中'), 'blocks overlapping concurrent run on same session');
  assert.equal(spawnCount, 1, 'second overlapping call spawns zero subagents');

  releaseFirst();
  const res1 = await run1Promise;
  assert.equal(res1.status, 'done');
  assert.equal(res1.results.a, 'first-done');

  // Lock is cleanly released once run1 finishes
  const res2 = await executePlan(scope, plan, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(res2.status, 'done');
  assert.equal(res2.results.a, 'second-done');
});

test('DSH 0.2.2 SubagentResult: extracts diagnostic field and rescues strict JSON when activation rewrites completed -> error', async () => {
  // 1) Condition judge answers with valid JSON text without calling `structured_output` tool:
  // DSH activation.ts rewrites `stopReason: 'completed'` -> `'error'` with no `diagnostic`.
  // Executor must rescue the strict JSON verdict on attempt #1 (ZERO wasted retry roundtrip!).
  let gateCalls = 0;
  const scopeRescue = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        if (id === 'gate') {
          gateCalls += 1;
          return Promise.resolve({
            childId: 'kid-gate-text-json',
            result: Promise.resolve({
              output: [{ type: 'text', text: '{"pass": true, "reason": "自检全部通过"}' }],
              stopReason: 'error',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: 'DSH diagnostic 与 JSON 救援测试',
    __transientDelayMs: 5,
    nodes: [
      { id: 'run', kind: 'agent', label: '执行', role: '执行' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '判断', model: 'deepseek-flash' },
      { id: 'yes_s', kind: 'agent', label: '通过交付', role: '交付' },
      { id: 'no_s', kind: 'agent', label: '失败修复', role: '修复' },
    ],
    edges: [
      { from: 'lead', to: 'run', type: 'prompt' },
      { from: 'run', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'yes_s', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'no_s', type: 'prompt', branch: 'false' },
    ],
  };
  const rescued = await executePlan(scopeRescue, plan, {}, { agent: { id: 's-dsh-rescue-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(rescued.status, 'done');
  assert.equal(gateCalls, 1, 'rescued on attempt #1 without wasting a second LLM call');
  assert.equal(rescued.failed.length, 0);
  assert.equal(rescued.results.yes_s, 'ok:yes_s');
  assert.equal(rescued.results.no_s, undefined);

  // 2) Real failure carrying DSH's `diagnostic` field is surfaced & classified as transient for read-only retry
  let diagCalls = 0;
  const scopeDiag = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        if (id === 'gate') {
          diagCalls += 1;
          if (diagCalls === 1) {
            return Promise.resolve({
              childId: 'kid-gate-diag-1',
              result: Promise.resolve({
                output: [],
                stopReason: 'error',
                diagnostic: 'upstream provider HTTP 503 overloaded',
              }),
              dispose: () => Promise.resolve(),
            });
          }
          return Promise.resolve({
            childId: 'kid-gate-diag-2',
            result: Promise.resolve({
              output: [],
              stopReason: 'error',
              diagnostic: 'provider rejected request: invalid model alias',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const diagFail = await executePlan(scopeDiag, plan, {}, { agent: { id: 's-dsh-diag-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(diagCalls, 2, '503 in `diagnostic` triggers 1 safe transient retry on read-only condition node');
  assert.equal(diagFail.failed.length, 1);
  assert.ok(diagFail.results.gate.includes('invalid model alias'), 'surfaces latest `diagnostic` error text');
  assert.equal(isTransientFailure({ ok: false, reason: 'max-tokens', text: '503 error discussion' }), false, 'hyphenated DSH max-tokens never triggers retry');
  assert.equal(isTransientFailure({ ok: false, reason: 'refusal', text: '503' }), false, 'DSH refusal never triggers retry');
});

test('CJK binary condition fallback, multi-JSON prose extraction, and surrogate-safe clipSafeSlice', () => {
  const condNode = { id: 'c1', kind: 'condition', label: '是否通过' };
  // CJK text fallback must work without ASCII \b failing on Chinese characters
  for (const sample of ['是', '通过', '通过，全部完成', '是：没有问题', 'pass']) {
    const res = parseConditionDecision(null, sample, condNode);
    assert.equal(res.pass, true, 'should match positive text: ' + sample);
    assert.deepEqual(res.branches, ['true']);
  }
  const neg = parseConditionDecision(null, '否，发现 2 处错误', condNode);
  assert.equal(neg.pass, false);
  assert.deepEqual(neg.branches, ['false']);

  // Multi-{...} prose: upstream snippet before final verdict must not break JSON parsing
  const prose = '上游输出包含 {"status":"error","code":500}，经核实已恢复，最终判决：{"pass": true, "reason": "全部通过"}';
  assert.equal(extractJsonObjects(prose).length, 2);
  const strictCond = parseStrictConditionJson(prose, condNode);
  assert.ok(strictCond && strictCond.pass === true && strictCond.branches[0] === 'true');
  assert.equal(strictCond.reason, '全部通过');

  const fenced = '说明：\n```json\n{"files": ["a.js"], "ok": true}\n```';
  const strictObj = parseStrictJsonObject(fenced);
  assert.deepEqual(strictObj, { files: ['a.js'], ok: true });

  // Surrogate-safe clipping
  const emoji = 'x' + '🔥'.repeat(30);
  const sliced = clipSafeSlice(emoji, 10, '…');
  assert.equal(sliced.isWellFormed(), true);
  assert.ok(sliced.endsWith('…'));
});

test('structured standard node 1-shot JSON rescue, noSchema guard on writable/max-tokens, and session-ref single-run cold fallback', async () => {
  // 1) Writable standard node with `structured: true` returns JSON text without calling `structured_output`:
  // DSH rewrites completed -> error without diagnostic; executor rescues on attempt #1 (ZERO second spawn!).
  let stdCalls = 0;
  const scopeRescue = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        if (id === 's1') {
          stdCalls += 1;
          return Promise.resolve({
            childId: 'kid-s1',
            result: Promise.resolve({
              output: [{ type: 'text', text: '```json\n{"summary": "done", "files": ["a.js"]}\n```' }],
              stopReason: 'error',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id,
          result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const planStruct = {
    task: 'structured 救援测试',
    nodes: [
      { id: 's1', kind: 'agent', preset: 'standard', label: '实现', role: '改代码', structured: true },
      { id: 's2', kind: 'agent', preset: 'minimal', label: '汇总', role: '读结果' },
    ],
    edges: [
      { from: 'lead', to: 's1', type: 'prompt' },
      { from: 's1', to: 's2', type: 'structured' },
    ],
  };
  const rescued = await executePlan(scopeRescue, planStruct, {}, { agent: { id: 's-std-rescue-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(rescued.status, 'done');
  assert.equal(stdCalls, 1, 'rescued writable structured node in 1 shot without re-running');
  assert.equal(rescued.failed.length, 0);

  // 2) Writable standard node that truly fails with outputSchema MUST NOT retry without outputSchema (avoid double side-effects),
  //    and read-only node with max-tokens MUST NOT retry without outputSchema either.
  let writeFailCalls = 0;
  let maxTokCalls = 0;
  const scopeNoRetry = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        if (id === 'w1') {
          writeFailCalls += 1;
          return Promise.resolve({
            childId: 'kid-w1',
            result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'schema rejected' }),
            dispose: () => Promise.resolve(),
          });
        }
        maxTokCalls += 1;
        return Promise.resolve({
          childId: 'kid-m1',
          result: Promise.resolve({ output: [], stopReason: 'max-tokens', diagnostic: 'token limit' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const planNoRetry = {
    task: 'noSchema guard',
    nodes: [
      { id: 'w1', kind: 'agent', preset: 'standard', label: '写节点', role: '改文件', structured: true },
      { id: 'm1', kind: 'condition', label: '只读条件', role: '判断' },
    ],
    edges: [
      { from: 'lead', to: 'w1', type: 'prompt' },
      { from: 'lead', to: 'm1', type: 'prompt' },
    ],
  };
  await executePlan(scopeNoRetry, planNoRetry, {}, { agent: { id: 's-noretry-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(writeFailCalls, 1, 'writable standard node never retries noSchema');
  assert.equal(maxTokCalls, 1, 'max-tokens never retries noSchema');

  // 3) session-ref failure falls back cold ONCE without double-running primary, and cold fallback has sessionContinued: false
  const callsB = [];
  const scopeRef = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        if (id === 'a') {
          return Promise.resolve({
            childId: 'kid-a-1',
            result: Promise.resolve({ output: [{ type: 'text', text: 'A ok' }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        callsB.push({ childId: spec.childId || null, model: spec.model || '' });
        if (spec.childId === 'kid-a-1') {
          return Promise.reject(new Error('upstream child closed'));
        }
        return Promise.resolve({
          childId: 'kid-b-cold',
          result: Promise.resolve({ output: [{ type: 'text', text: 'B cold ok' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const planRef = {
    task: 'session-ref cold fallback',
    nodes: [
      { id: 'a', kind: 'agent', preset: 'standard', label: 'A', role: 'r1' },
      { id: 'b', kind: 'agent', preset: 'standard', label: 'B', role: 'r2' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'b', type: 'session-ref' },
    ],
  };
  const refRes = await executePlan(scopeRef, planRef, {}, { agent: { id: 's-sref-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(refRes.status, 'done');
  assert.equal(callsB.length, 2, '1 warm attempt (rejected) + 1 cold attempt, never 3');
  assert.equal(callsB[0].childId, 'kid-a-1');
  assert.equal(callsB[1].childId, null);
});
