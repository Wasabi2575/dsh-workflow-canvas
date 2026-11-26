import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, orderNodes, upstreamOf, downstreamLabels, parsePayload, clipUpstreamOutput, briefFor, normalizeMaxIterations, extractJsonObjects, parseStrictJsonObject, parseStrictConditionJson, parseConditionDecision, clipSafeSlice, withoutEntry, analyzeCanvasWarnings, normalizeCanvas, applyPatch, inspectPlan, syncPresetsCatalog, handleCanvasPreset, sessionIdFromContext, buildActiveCanvasContext, isPermissionFailure, isTransientFailure, safeSessionFileBase, writeFileAtomic, pruneMapLRU, touchMapLRU, cleanupStaleCanvasFiles, buildRunSummarySnapshot, abortSessionRun, loopMemberIds, validateLoopEdges, executePlan } from '../index.js';

test('controlled loop retries with feedback & warm session reuse, isolates bypass nodes, and exits on pass', async () => {
  const calls = [];
  let codeRound = 0;
  let checkRound = 0;
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        const prompt = (spec.prompt && spec.prompt[0] && spec.prompt[0].text) || '';
        calls.push({ id, childId: spec.childId || null, prompt });
        if (id === 'code') {
          codeRound += 1;
          return Promise.resolve({
            childId: spec.childId || ('kid-code-' + codeRound),
            result: Promise.resolve({ output: [{ type: 'text', text: 'code-v' + codeRound }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'check') {
          checkRound += 1;
          const decision = checkRound === 1
            ? { pass: false, reason: 'auth.js 缺少空值校验' }
            : { pass: true, reason: '所有单测通过' };
          return Promise.resolve({
            childId: 'kid-check-' + checkRound,
            result: Promise.resolve({ structured: decision, output: [{ type: 'text', text: JSON.stringify(decision) }], stopReason: 'completed' }),
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

  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'code', kind: 'agent', label: '编写代码', role: '实现登录接口' },
    { id: 'test', kind: 'agent', label: '跑单测', role: '执行测试套件' },
    { id: 'check', kind: 'condition', label: '是否通过？', role: '全部通过走是，否则走否' },
    { id: 'docs', kind: 'agent', label: '旁路文档', role: '补充说明文档' },
    { id: 'ship', kind: 'agent', label: '交付汇总', role: '整理发布清单' },
  ];
  const edges = [
    { from: 'lead', to: 'code', type: 'prompt' },
    { from: 'lead', to: 'docs', type: 'prompt' },
    { from: 'code', to: 'test', type: 'prompt' },
    { from: 'test', to: 'check', type: 'prompt' },
    { from: 'check', to: 'ship', type: 'prompt', branch: 'true' },
    { from: 'check', to: 'code', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
    { from: 'docs', to: 'ship', type: 'prompt' },
  ];
  assert.deepEqual(validateLoopEdges(nodes, edges), []);
  assert.deepEqual(Array.from(loopMemberIds(nodes, edges, edges[5])).sort(), ['check', 'code', 'test']);

  const plan = { task: '上线登录功能', nodes: withoutEntry(nodes), edges };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-loop-pass-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(res.status, 'done');
  assert.equal(res.loopExhausted, undefined);
  assert.equal(calls.filter((c) => c.id === 'docs').length, 1, 'bypass node outside loop runs only once');
  assert.equal(calls.filter((c) => c.id === 'ship').length, 1, 'downstream ship runs once after loop exits');
  const codeCalls = calls.filter((c) => c.id === 'code');
  assert.equal(codeCalls.length, 2, 'code ran initial + 1 retry');
  assert.equal(codeCalls[0].childId, null);
  assert.equal(codeCalls[1].childId, 'kid-code-1', 'retry reuses healthy warm session');
  assert.ok(codeCalls[1].prompt.includes('auth.js 缺少空值校验'), 'retry prompt carries condition feedback');
  assert.ok(codeCalls[1].prompt.includes('1/3'), 'retry prompt carries round ratio');
});

test('loop exhaustion stops at maxIterations, drops crashed warm session, and hands off history to Lead', async () => {
  const calls = [];
  let codeRound = 0;
  let checkRound = 0;
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        const prompt = (spec.prompt && spec.prompt[0] && spec.prompt[0].text) || '';
        calls.push({ id, childId: spec.childId || null, prompt });
        if (id === 'code') {
          codeRound += 1;
          // Round 1 crashes so round 2 must NOT reuse its crashed child session
          const crashed = codeRound === 1;
          return Promise.resolve({
            childId: 'kid-c-' + codeRound,
            result: Promise.resolve({ output: [{ type: 'text', text: crashed ? 'boom' : 'attempt-' + codeRound }], stopReason: crashed ? 'error' : 'completed' }),
            dispose: () => Promise.resolve(),
          });
        }
        checkRound += 1;
        const dec = { pass: false, reason: '失败原因#' + checkRound };
        return Promise.resolve({
          childId: 'kid-j-' + checkRound,
          result: Promise.resolve({ structured: dec, output: [{ type: 'text', text: JSON.stringify(dec) }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'code', kind: 'agent', label: '实现', role: '写代码' },
    { id: 'check', kind: 'condition', label: '验收？', role: '是否通过' },
    { id: 'final', kind: 'lead', label: '终审拍板', role: '决定如何收尾' },
  ];
  const edges = [
    { from: 'lead', to: 'code', type: 'prompt' },
    { from: 'code', to: 'check', type: 'prompt' },
    { from: 'check', to: 'final', type: 'prompt', branch: 'true' },
    { from: 'check', to: 'code', type: 'prompt', branch: 'false', loop: true, maxIterations: 2 },
  ];
  const plan = { task: '修 bug', nodes: withoutEntry(nodes), edges };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-loop-ex-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(res.status, 'done');
  assert.equal(res.finalLead.label, '终审拍板');
  const codeCalls = calls.filter((c) => c.id === 'code');
  assert.equal(codeCalls.length, 3, 'initial + 2 retries = 3 total runs, never spawns a 4th');
  assert.equal(codeCalls[1].childId, null, 'crashed round 1 session is NOT reused');
  assert.equal(codeCalls[2].childId, 'kid-c-2', 'healthy round 2 session IS reused on round 3');
  assert.equal(res.loopExhausted.length, 1);
  assert.equal(res.loopExhausted[0].iterations, 2);
  assert.equal(res.loopExhausted[0].history.length, 3);
  assert.ok(res.hint.includes('失败原因#1') && res.hint.includes('失败原因#3'), 'Lead hint summarizes every failed round');
});

test('loop targeting a Lead passes loopFeedback via need-lead and crossing loops are rejected', async () => {
  let judgeCount = 0;
  const scope = {
    subagents: {
      startActivation() {
        judgeCount += 1;
        const dec = judgeCount === 1
          ? { pass: false, reason: '方案缺少回滚步骤' }
          : { pass: true, reason: '方案完整' };
        return Promise.resolve({
          childId: 'kid-jl-' + judgeCount,
          result: Promise.resolve({ structured: dec, output: [{ type: 'text', text: JSON.stringify(dec) }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const nodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'draft', kind: 'lead', label: '主对话起草', role: '撰写迁移方案' },
    { id: 'judge', kind: 'condition', label: '方案完备？', role: '检查是否含回滚步骤' },
    { id: 'end', kind: 'lead', label: '最终确认', role: '批准发布' },
  ];
  const edges = [
    { from: 'lead', to: 'draft', type: 'prompt' },
    { from: 'draft', to: 'judge', type: 'prompt' },
    { from: 'judge', to: 'end', type: 'prompt', branch: 'true' },
    { from: 'judge', to: 'draft', type: 'prompt', branch: 'false', loop: true, maxIterations: 2 },
  ];
  const plan = { task: '数据库迁移', nodes: withoutEntry(nodes), edges };
  const sid = 's-loop-lead-' + Date.now();
  const r1 = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r1.status, 'need-lead');
  assert.equal(r1.node.label, '主对话起草');
  assert.equal(r1.node.loopFeedback, undefined);

  const r2 = await executePlan(scope, plan, { leadResult: '初版方案（无回滚）' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r2.status, 'need-lead');
  assert.equal(r2.node.label, '主对话起草');
  assert.equal(r2.node.loopFeedback.retry, 1);
  assert.equal(r2.node.loopFeedback.reason, '方案缺少回滚步骤');
  assert.ok(r2.hint.includes('方案缺少回滚步骤'));

  const r3 = await executePlan(scope, plan, { leadResult: '修订方案（含回滚）' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(r3.status, 'done');
  assert.equal(r3.finalLead.label, '最终确认');

  // Crossing loops are rejected by validateLoopEdges & normalizeCanvas/applyPatch preserve loop metadata
  const crossNodes = [
    { id: 'a', kind: 'agent' },
    { id: 'b', kind: 'agent' },
    { id: 'c1', kind: 'condition' },
    { id: 'c2', kind: 'condition' },
  ];
  const crossEdges = [
    { from: 'lead', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c1' },
    { from: 'c1', to: 'c2' },
    { from: 'c1', to: 'a', branch: 'false', loop: true, maxIterations: 2 },
    { from: 'c2', to: 'b', branch: 'false', loop: true, maxIterations: 2 },
  ];
  assert.ok(validateLoopEdges(crossNodes, crossEdges).some((e) => e.includes('交叉')));

  const gen = normalizeCanvas({
    task: 't',
    nodes: [{ ref: 'a', label: 'A' }, { ref: 'c', kind: 'condition', label: 'C' }],
    edges: [
      { from: 'lead', to: 'a' },
      { from: 'a', to: 'c' },
      { from: 'c', to: 'a', branch: 'false', loop: true, maxIterations: 5 },
    ],
  });
  const le = gen.edges.find((e) => e.loop);
  assert.ok(le && le.maxIterations === 5);
  const patched = applyPatch({ task: 't', nodes: withoutEntry(gen.nodes), edges: gen.edges }, {
    edges: [{ from: le.from, to: le.to, branch: 'false', loop: true, maxIterations: 7 }],
  });
  assert.equal(patched.plan.edges.find((e) => e.loop).maxIterations, 7);

  // Mid-loop bypass leak warning
  const leakNodes = [
    { id: 'lead', kind: 'lead', label: 'Lead' },
    { id: 'a', kind: 'agent', label: '编码' },
    { id: 'b', kind: 'condition', label: '验收' },
    { id: 'side', kind: 'agent', label: '旁路' },
    { id: 'end', kind: 'lead', label: '终审', role: '汇总' },
  ];
  const leakEdges = [
    { from: 'lead', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'a', to: 'side' },
    { from: 'side', to: 'end' },
    { from: 'b', to: 'end', branch: 'true' },
    { from: 'b', to: 'a', branch: 'false', loop: true, maxIterations: 2 },
  ];
  const leakWarns = analyzeCanvasWarnings(leakNodes, leakEdges);
  assert.ok(leakWarns.some((w) => w.includes('绕过条件裁判的旁路连线') && w.includes('编码 → 旁路')));
});

test('loop retry un-prunes outside branch pruned by an inner condition on round 1', async () => {
  let innerRound = 0;
  let outerRound = 0;
  const spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        spawned.push(id);
        if (id === 'c_in') {
          innerRound += 1;
          // Round 1 picks `work` (pruning `alt_exit`); round 2 picks `alt_exit`!
          return Promise.resolve({
            childId: 'kid-cin-' + innerRound,
            result: Promise.resolve({
              structured: { pass: innerRound === 1, reason: innerRound === 1 ? '先走主路' : '改走备路' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'c_out') {
          outerRound += 1;
          return Promise.resolve({
            childId: 'kid-cout-' + outerRound,
            result: Promise.resolve({
              structured: { pass: false, reason: '第1轮失败，回环重来' },
              output: [{ type: 'text', text: '' }],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id + '-' + spawned.length,
          result: Promise.resolve({ output: [{ type: 'text', text: 'out:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: '环内分支解剪测试',
    nodes: [
      { id: 'start', kind: 'agent', label: '准备', role: '准备' },
      { id: 'c_in', kind: 'condition', label: '选路', role: '选路' },
      { id: 'work', kind: 'agent', label: '主路', role: '主路' },
      { id: 'c_out', kind: 'condition', label: '验收', role: '验收' },
      { id: 'alt_exit', kind: 'agent', label: '备路出口', role: '备路' },
      { id: 'final', kind: 'lead', label: '终审', role: '终审' },
    ],
    edges: [
      { from: 'lead', to: 'start', type: 'prompt' },
      { from: 'start', to: 'c_in', type: 'prompt' },
      { from: 'c_in', to: 'work', type: 'prompt', branch: 'true' },
      { from: 'c_in', to: 'alt_exit', type: 'prompt', branch: 'false' },
      { from: 'work', to: 'c_out', type: 'prompt' },
      { from: 'c_out', to: 'final', type: 'prompt', branch: 'true' },
      { from: 'c_out', to: 'start', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
      { from: 'alt_exit', to: 'final', type: 'prompt' },
    ],
  };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-loop-unprune-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(res.status, 'done');
  assert.ok(spawned.includes('alt_exit'), 'outside branch pruned on round 1 must un-prune and run when chosen on round 2');
  assert.equal(res.results.alt_exit, 'out:alt_exit');
});

test('loop retry un-prune BFS skips outside blockedEdges and never wakes rejected outside branch', async () => {
  let gateCount = 0;
  let spawned = [];
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = String(spec.label || '').split('#').pop();
        spawned.push(id);
        if (id === 'outer_cond') {
          // Outer condition picks branch "a" (blocking edge outer_cond -> outside_rejected)
          return Promise.resolve({
            childId: 'kid-outer',
            result: Promise.resolve({
              structured: { branch: 'a', reason: 'go to loop' },
              output: [],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        if (id === 'gate') {
          gateCount += 1;
          return Promise.resolve({
            childId: 'kid-gate-' + gateCount,
            result: Promise.resolve({
              structured: { pass: gateCount >= 2, reason: gateCount >= 2 ? 'ok' : 'retry once' },
              output: [],
              stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          });
        }
        return Promise.resolve({
          childId: 'kid-' + id + '-' + spawned.length,
          result: Promise.resolve({ output: [{ type: 'text', text: 'done:' + id }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const plan = {
    task: 'blockedEdges isolation on loop retry',
    nodes: [
      { id: 'outer_cond', kind: 'condition', label: '外层分流', role: '选 a', branches: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'worker', kind: 'agent', label: '工作', role: '干活' },
      { id: 'gate', kind: 'condition', label: '质检', role: '是否通过' },
      { id: 'ship', kind: 'agent', label: '交付', role: '收尾' },
      { id: 'rejected_b', kind: 'agent', label: 'B分支', role: '不应执行' },
    ],
    edges: [
      { from: 'lead', to: 'outer_cond', type: 'prompt' },
      { from: 'outer_cond', to: 'worker', type: 'prompt', branch: 'a' },
      { from: 'outer_cond', to: 'rejected_b', type: 'prompt', branch: 'b' },
      { from: 'worker', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'ship', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'worker', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
      // Even if a side edge connects gate -> rejected_b on a non-taken branch, rejected_b stays pruned!
    ],
  };
  const res = await executePlan(scope, plan, {}, { agent: { id: 's-loop-blocked-' + Date.now() }, signal: new AbortController().signal });
  assert.equal(res.status, 'done');
  assert.equal(gateCount, 2);
  assert.ok(!spawned.includes('rejected_b'), 'outside rejected branch must never wake during loop retry');
  assert.equal(res.results.ship, 'done:ship');
});

test('loop progress telemetry (#17): emits Round 1 progress, exhaustion flag, canvas_workflow loops, and retains final counts on abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-loop-prog-'));
  try {
    const sid = 's-lp-prog-' + Date.now();
    const runFilePath = join(dir, '.dsh', 'canvas', safeSessionFileBase(sid) + '.run.json');
    let round1Snapshot = null;
    const plan = {
      task: '循环轮次遥测测试',
      nodes: [
        { id: 'impl', kind: 'agent', label: '实现', role: 'code' },
        { id: 'gate', kind: 'condition', label: '门禁', role: 'check' },
        { id: 'final', kind: 'lead', label: '终审', role: 'ship' },
      ],
      edges: [
        { id: 'e0', from: 'lead', to: 'impl', type: 'prompt' },
        { id: 'e1', from: 'impl', to: 'gate', type: 'prompt' },
        { id: 'e2', from: 'gate', to: 'final', type: 'prompt', branch: 'true' },
        { id: 'el', from: 'gate', to: 'impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 2 },
      ],
    };

    // 1) Round 1 pass: snapshot captured mid-Round-1 already exposes count=0, round=1/3, active=true
    const scopePass = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          const txt = id === 'gate' ? '{"pass": true, "reason": "首轮即通过"}' : 'done:' + id;
          const result = (id === 'impl' && !round1Snapshot)
            ? new Promise((resolve) => setTimeout(() => {
              // Capture .run.json while Round 1 impl is actually in-flight (after launchReadyAgents emits running state)
              round1Snapshot = JSON.parse(readFileSync(runFilePath, 'utf8'));
              resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' });
            }, 0))
            : Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' });
          return Promise.resolve({
            childId: 'kid-' + id,
            result,
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const resPass = await executePlan(scopePass, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(resPass.status, 'done');
    assert.ok(round1Snapshot && round1Snapshot.loopCounts && round1Snapshot.loopCounts.el, 'Round 1 .run.json includes loopCounts immediately');
    assert.equal(round1Snapshot.loopCounts.el.count, 0);
    assert.equal(round1Snapshot.loopCounts.el.round, 1);
    assert.equal(round1Snapshot.loopCounts.el.totalRounds, 3);
    assert.equal(round1Snapshot.loopCounts.el.active, true);
    assert.equal(round1Snapshot.loopCounts.el.exhausted, false);
    assert.equal(round1Snapshot.nodeAttempts.impl.round, 1);
    assert.equal(round1Snapshot.summary.loops.length, 1, 'summary.loops visible during Round 1');
    assert.equal(round1Snapshot.summary.loops[0].round, 1);
    assert.equal(resPass.loops.length, 1, 'canvas_workflow returns loops progress on Round 1 pass');
    assert.equal(resPass.loops[0].used, 0);
    assert.equal(resPass.loops[0].round, 1);
    assert.equal(resPass.loops[0].exhausted, false);

    // 2) Exhausted loop sets exhausted=true on loopCounts, nodeAttempts, summary.loops, and return payload
    const sidEx = sid + '-ex';
    const exFilePath = join(dir, '.dsh', 'canvas', safeSessionFileBase(sidEx) + '.run.json');
    const scopeExhaust = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          const txt = id === 'gate' ? '{"pass": false, "reason": "仍未通过"}' : 'attempt:' + id;
          return Promise.resolve({
            childId: 'kid-ex-' + id,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const resEx = await executePlan(scopeExhaust, plan, {}, { agent: { id: sidEx }, signal: new AbortController().signal });
    assert.equal(resEx.status, 'done');
    assert.equal(resEx.loops[0].used, 2);
    assert.equal(resEx.loops[0].round, 3);
    assert.equal(resEx.loops[0].exhausted, true);
    const exRunFile = JSON.parse(readFileSync(exFilePath, 'utf8'));
    assert.equal(exRunFile.loopCounts.el.count, 2);
    assert.equal(exRunFile.loopCounts.el.exhausted, true);
    assert.equal(exRunFile.nodeAttempts.impl.exhausted, true);
    assert.equal(exRunFile.summary.loops[0].exhausted, true);

    // 3) User abort mid-retry retains final loopCounts & nodeAttempts in .run.json (never wipes to {})
    const sidAbort = sid + '-abort';
    const abortFilePath = join(dir, '.dsh', 'canvas', safeSessionFileBase(sidAbort) + '.run.json');
    let implCalls = 0;
    let resolveBlockedImpl;
    const scopeAbort = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        interrupt() {},
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          if (id === 'impl') {
            implCalls += 1;
            if (implCalls === 2) {
              return Promise.resolve({
                childId: 'kid-hang',
                result: new Promise((resolve) => { resolveBlockedImpl = resolve; }),
                dispose: () => Promise.resolve(),
              });
            }
          }
          const txt = id === 'gate' ? '{"pass": false, "reason": "打回一次"}' : 'first-ok';
          return Promise.resolve({
            childId: 'kid-ab-' + id + '-' + implCalls,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const runPromise = executePlan(scopeAbort, plan, {}, { agent: { id: sidAbort }, signal: new AbortController().signal });
    for (let i = 0; i < 40 && !resolveBlockedImpl; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(resolveBlockedImpl, 'reached retry round 2');
    abortSessionRun(scopeAbort, sidAbort, null, { cancelRootTurn: false });
    resolveBlockedImpl({ output: [], stopReason: 'aborted' });
    await runPromise;
    const haltedFile = JSON.parse(readFileSync(abortFilePath, 'utf8'));
    assert.equal(haltedFile.status, 'halted');
    assert.equal(haltedFile.loopCounts.el.count, 1, 'abort preserves final loop retry count (1/2) instead of wiping to {}');
    assert.equal(haltedFile.loopCounts.el.round, 2);
    assert.equal(haltedFile.nodeAttempts.impl.retry, 1);

    // 4) Pruned / unentered loop reports active=false & round=0 (never falsely claims Round 1)
    const sidPruned = sid + '-pruned';
    const prunedPlan = {
      task: '剪枝回环测试',
      nodes: [
        { id: 'router', kind: 'condition', label: '分流', role: 'route' },
        { id: 'fast', kind: 'agent', label: '快速路径', role: 'fast' },
        { id: 'impl', kind: 'agent', label: '实现', role: 'code' },
        { id: 'gate', kind: 'condition', label: '门禁', role: 'check' },
      ],
      edges: [
        { id: 'e0', from: 'lead', to: 'router', type: 'prompt' },
        { id: 'ef', from: 'router', to: 'fast', type: 'prompt', branch: 'true' },
        { id: 'es', from: 'router', to: 'impl', type: 'prompt', branch: 'false' },
        { id: 'e1', from: 'impl', to: 'gate', type: 'prompt' },
        { id: 'el', from: 'gate', to: 'impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
      ],
    };
    const scopePruned = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          const txt = id === 'router' ? '{"pass": true, "reason": "走快速路径"}' : 'fast-ok';
          return Promise.resolve({
            childId: 'kid-p-' + id,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const resPruned = await executePlan(scopePruned, prunedPlan, {}, { agent: { id: sidPruned }, signal: new AbortController().signal });
    assert.equal(resPruned.status, 'done');
    assert.equal(resPruned.loops.length, 1);
    assert.equal(resPruned.loops[0].active, false);
    assert.equal(resPruned.loops[0].round, 0);
    assert.equal(resPruned.loops[0].used, 0);

    // 5) canvas_workflow output.render() surfaces loop progress for Round 1 pass, exhausted, and unentered loops
    const regTools = new Map();
    const mockCtx = {
      inject(deps, fn) {
        if (deps.includes('tools')) {
          fn({
            effect: (d) => d(),
            tools: { register: (t) => { regTools.set(t.name, t); return () => {}; } },
            subagents: {},
            sessions: {},
          });
        }
      },
    };
    apply(mockCtx);
    const wfTool = regTools.get('canvas_workflow');
    assert.ok(wfTool && wfTool.output && typeof wfTool.output.render === 'function');
    const renderedPass = wfTool.output.render({}, resPass)[0].text;
    assert.ok(renderedPass.includes('回环进度：门禁 ↺ 实现（第 1/3 轮 · 重试 0/2）'), 'render includes Round 1 loop progress');
    const renderedPruned = wfTool.output.render({}, resPruned)[0].text;
    assert.ok(renderedPruned.includes('回环进度：门禁 ↺ 实现（未执行 · 重试 0/3）'), 'render marks unentered loop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interaction matrix: in-flight condition cancel -> retryFailed leaves zero partial verdict and reuses upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-im-cond-'));
  try {
    const sid = 's-im-cond-' + Date.now();
    const runFilePath = join(dir, '.dsh', 'canvas', safeSessionFileBase(sid) + '.run.json');
    const plan = {
      task: '条件在飞取消测试',
      nodes: [
        { id: 'prep', kind: 'agent', label: '前置', role: 'prepare' },
        { id: 'gate', kind: 'condition', label: '门禁', role: 'check' },
        { id: 'ok', kind: 'agent', label: '通过分支', role: 'pass-step' },
      ],
      edges: [
        { id: 'e0', from: 'lead', to: 'prep', type: 'prompt' },
        { id: 'e1', from: 'prep', to: 'gate', type: 'prompt' },
        { id: 'e2', from: 'gate', to: 'ok', type: 'prompt', branch: 'true' },
      ],
    };
    const spawned1 = [];
    let resolveHangingGate;
    const scope1 = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        interrupt() {},
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          spawned1.push(id);
          if (id === 'gate') {
            return Promise.resolve({
              childId: 'kid-gate-hang',
              result: new Promise((resolve) => { resolveHangingGate = resolve; }),
              dispose: () => Promise.resolve(),
            });
          }
          return Promise.resolve({
            childId: 'kid-' + id,
            result: Promise.resolve({ output: [{ type: 'text', text: 'prep-ready' }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const run1 = executePlan(scope1, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
    for (let i = 0; i < 40 && !resolveHangingGate; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(resolveHangingGate, 'condition judge reached in-flight state');
    abortSessionRun(scope1, sid, null, { cancelRootTurn: false });
    resolveHangingGate({ output: [{ type: 'text', text: '{"pass": false, "reason": "stale"}' }], stopReason: 'aborted' });
    const res1 = await run1;
    assert.equal(res1.status, 'halted');
    assert.equal(res1.decisions.length, 0, 'cancelled in-flight condition leaves zero decisions in return payload');
    const haltedRun = JSON.parse(readFileSync(runFilePath, 'utf8'));
    assert.deepEqual(haltedRun.decisions, {}, 'cancelled in-flight condition leaves zero half-verdict in .run.json');

    // Follow-up retryFailed reuses prep, re-runs gate cleanly, and finishes ok branch
    const spawned2 = [];
    const scope2 = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          spawned2.push(id);
          const txt = id === 'gate' ? '{"pass": true, "reason": "通过"}' : 'ok-done';
          return Promise.resolve({
            childId: 'kid2-' + id,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const res2 = await executePlan(scope2, plan, { retryFailed: true }, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(res2.status, 'done');
    assert.ok(!spawned2.includes('prep'), 'retryFailed reuses succeeded upstream prep');
    assert.deepEqual(spawned2, ['gate', 'ok']);
    assert.equal(res2.decisions.length, 1);
    assert.equal(res2.decisions[0].pass, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interaction matrix: Run 1 late cancellation cleanup never clobbers Run 2 ownership or .run.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-im-race-'));
  try {
    const sid = 's-im-race-' + Date.now();
    const runFilePath = join(dir, '.dsh', 'canvas', safeSessionFileBase(sid) + '.run.json');
    const plan = {
      task: '竞态所有权测试',
      nodes: [{ id: 'a', kind: 'agent', label: 'A', role: 'work' }],
      edges: [{ id: 'e0', from: 'lead', to: 'a', type: 'prompt' }],
    };

    let resolveRun1Child;
    const scope1 = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        interrupt() {},
        startActivation() {
          return Promise.resolve({
            childId: 'kid-r1',
            result: new Promise((resolve) => { resolveRun1Child = resolve; }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const run1 = executePlan(scope1, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
    for (let i = 0; i < 40 && !resolveRun1Child; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(resolveRun1Child, 'Run 1 child started');

    // Cancel Run 1 synchronously (clears activeRunBySession & runBySession) BEFORE its child promise settles
    abortSessionRun(scope1, sid, null, { cancelRootTurn: false });

    // Start Run 2 on the exact same sessionId while Run 1's child is still dangling
    let resolveRun2Child;
    const scope2 = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        interrupt() {},
        startActivation() {
          return Promise.resolve({
            childId: 'kid-r2',
            result: new Promise((resolve) => { resolveRun2Child = resolve; }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const run2 = executePlan(scope2, plan, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
    for (let i = 0; i < 40 && !resolveRun2Child; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(resolveRun2Child, 'Run 2 started cleanly on same session');

    // Now let Run 1's delayed child resolve so Run 1's finishAborted + finally execute while Run 2 is live
    resolveRun1Child({ output: [], stopReason: 'aborted' });
    const res1 = await run1;
    assert.equal(res1.status, 'halted');

    // Verify Run 1 did NOT overwrite Run 2's `.run.json` to halted AND did NOT release Run 2's re-entrancy lock
    const midRunFile = JSON.parse(readFileSync(runFilePath, 'utf8'));
    assert.equal(midRunFile.status, 'running', 'Run 1 late cleanup must not overwrite Run 2 running .run.json');
    const reentrantRes = await executePlan(scope2, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
    assert.ok(typeof reentrantRes.error === 'string' && reentrantRes.error.includes('正在执行中'), 'Run 2 still holds activeRunBySession ownership lock');

    // Finally finish Run 2 cleanly
    resolveRun2Child({ output: [{ type: 'text', text: 'run2-ok' }], stopReason: 'completed' });
    const res2 = await run2;
    assert.equal(res2.status, 'done');
    assert.equal(res2.results.a, 'run2-ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interaction matrix: pinned memoryChildId x loop retry reuses warm session when healthy, starts fresh when Round 1 crashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-im-memloop-'));
  try {
    // Part A: Healthy Round 1 on pinned memoryChildId -> Round 2 continues that same warm session with incremental prompt
    const sidA = 's-im-memloop-ok-' + Date.now();
    const callsA = [];
    let implRoundA = 0;
    const planA = {
      task: '钉选记忆健康回环',
      nodes: [
        { id: 'impl', kind: 'agent', label: '实现', role: 'code', keepSession: true, memoryChildId: 'kid-pinned-2' },
        { id: 'gate', kind: 'condition', label: '门禁', role: 'check' },
      ],
      edges: [
        { id: 'e0', from: 'lead', to: 'impl', type: 'prompt' },
        { id: 'e1', from: 'impl', to: 'gate', type: 'prompt' },
        { id: 'el', from: 'gate', to: 'impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 2 },
      ],
    };
    const promptTextOf = (spec) => Array.isArray(spec.prompt)
      ? spec.prompt.map((p) => (p && p.text) || '').join('\n')
      : String(spec.prompt || '');
    const scopeA = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          if (id === 'impl') {
            implRoundA += 1;
            callsA.push({ childId: spec.childId || null, prompt: promptTextOf(spec) });
            return Promise.resolve({
              childId: spec.childId || 'kid-fresh-a',
              result: Promise.resolve({ output: [{ type: 'text', text: 'impl-r' + implRoundA }], stopReason: 'completed' }),
              dispose: () => Promise.resolve(),
            });
          }
          const txt = implRoundA === 1 ? '{"pass": false, "reason": "补一个边界判断"}' : '{"pass": true, "reason": "通过"}';
          return Promise.resolve({
            childId: 'kid-gate-' + implRoundA,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const resA = await executePlan(scopeA, planA, {}, { agent: { id: sidA }, signal: new AbortController().signal });
    assert.equal(resA.status, 'done');
    assert.equal(callsA.length, 2);
    assert.equal(callsA[0].childId, 'kid-pinned-2', 'Round 1 enters pinned memoryChildId');
    assert.equal(callsA[1].childId, 'kid-pinned-2', 'Round 2 continues healthy warm session');
    assert.ok(callsA[1].prompt.includes('补一个边界判断'), 'Round 2 passes rejection feedback incrementally');

    // Part B: Crashed Round 1 on pinned memoryChildId -> Round 2 skips memoryChildId and starts a clean fresh session
    const sidB = 's-im-memloop-crash-' + Date.now();
    const callsB = [];
    let implRoundB = 0;
    const planB = {
      task: '钉选记忆崩溃回环',
      nodes: [
        { id: 'impl', kind: 'agent', label: '实现', role: 'code', keepSession: true, memoryChildId: 'kid-pinned-bad' },
        { id: 'gate', kind: 'condition', label: '门禁', role: 'check' },
      ],
      edges: [
        { id: 'e0', from: 'lead', to: 'impl', type: 'prompt' },
        { id: 'e1', from: 'impl', to: 'gate', type: 'prompt' },
        { id: 'el', from: 'gate', to: 'impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 2 },
      ],
    };
    const scopeB = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          if (id === 'impl') {
            implRoundB += 1;
            callsB.push({ childId: spec.childId || null, prompt: promptTextOf(spec) });
            if (implRoundB === 1) {
              return Promise.resolve({
                childId: spec.childId || 'kid-pinned-bad',
                result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'corrupted context' }),
                dispose: () => Promise.resolve(),
              });
            }
            return Promise.resolve({
              childId: 'kid-fresh-clean',
              result: Promise.resolve({ output: [{ type: 'text', text: 'fixed-in-fresh' }], stopReason: 'completed' }),
              dispose: () => Promise.resolve(),
            });
          }
          const txt = implRoundB === 1 ? '{"pass": false, "reason": "上轮崩溃请重做"}' : '{"pass": true, "reason": "新会话已修复"}';
          return Promise.resolve({
            childId: 'kid-gate-b-' + implRoundB,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const resB = await executePlan(scopeB, planB, {}, { agent: { id: sidB }, signal: new AbortController().signal });
    assert.equal(resB.status, 'done');
    assert.equal(callsB.length, 2);
    assert.equal(callsB[0].childId, 'kid-pinned-bad', 'Round 1 attempts pinned memoryChildId');
    assert.equal(callsB[1].childId, null, 'Round 2 skips crashed pinned memoryChildId and starts a clean fresh session');
    assert.ok(callsB[1].prompt.includes('上轮崩溃请重做'), 'Fresh retry session still receives full brief + feedback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interaction matrix: loop mid-retry cancel -> retryFailed/fromNodes, exhaustion -> Lead pause -> reset, and canvas_preset guard while running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-im-combo-'));
  try {
    // 1) Loop mid-retry cancel -> retryFailed reuses outside prep node
    const sid = 's-im-combo-' + Date.now();
    const plan = {
      task: '组合矩阵',
      nodes: [
        { id: 'prep', kind: 'agent', label: '准备', role: 'prep' },
        { id: 'impl', kind: 'agent', label: '实现', role: 'code' },
        { id: 'gate', kind: 'condition', label: '门禁', role: 'check' },
        { id: 'mid', kind: 'lead', label: '中审', role: 'review' },
        { id: 'ship', kind: 'agent', label: '发布', role: 'deploy' },
      ],
      edges: [
        { id: 'e0', from: 'lead', to: 'prep', type: 'prompt' },
        { id: 'e1', from: 'prep', to: 'impl', type: 'prompt' },
        { id: 'e2', from: 'impl', to: 'gate', type: 'prompt' },
        { id: 'e3', from: 'gate', to: 'mid', type: 'prompt', branch: 'true' },
        { id: 'el', from: 'gate', to: 'impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 1 },
        { id: 'e4', from: 'mid', to: 'ship', type: 'prompt' },
      ],
    };

    let implCalls = 0;
    let resolveR2;
    const scopeRun1 = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        interrupt() {},
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          if (id === 'impl') {
            implCalls += 1;
            if (implCalls === 2) {
              return Promise.resolve({
                childId: 'kid-r2-hang',
                result: new Promise((resolve) => { resolveR2 = resolve; }),
                dispose: () => Promise.resolve(),
              });
            }
          }
          const txt = id === 'gate' ? '{"pass": false, "reason": "需要返工"}' : ('ok:' + id);
          return Promise.resolve({
            childId: 'kid-' + id + '-' + implCalls,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const pRun1 = executePlan(scopeRun1, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
    for (let i = 0; i < 40 && !resolveR2; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(resolveR2, 'reached retry round 2');

    // While actively running, canvas_preset list still works, while apply/toggle are blocked cleanly
    const listWhileRunning = handleCanvasPreset(scopeRun1, sid, { action: 'list' });
    assert.ok(!listWhileRunning.error && Array.isArray(listWhileRunning.builtinTemplates), 'canvas_preset list works during active run');
    const applyWhileRunning = handleCanvasPreset(scopeRun1, sid, { action: 'apply', name: '标准流水线' });
    assert.ok(typeof applyWhileRunning.error === 'string' && applyWhileRunning.error.includes('正在运行'), 'canvas_preset apply blocked during active run');
    const toggleWhileRunning = handleCanvasPreset(scopeRun1, sid, { action: 'toggle', enabled: false });
    assert.ok(typeof toggleWhileRunning.error === 'string' && toggleWhileRunning.error.includes('正在运行'), 'canvas_preset toggle blocked during active run');

    // Cancel mid-retry
    abortSessionRun(scopeRun1, sid, null, { cancelRootTurn: false });
    resolveR2({ output: [], stopReason: 'aborted' });
    const r1 = await pRun1;
    assert.equal(r1.status, 'halted');

    // 2) retryFailed reuses `prep`, then exhausts loop (maxIterations: 1) and hands off to intermediate Lead `mid`
    const spawnedAfterCancel = [];
    const scopeExhaust = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          spawnedAfterCancel.push(id);
          const txt = id === 'gate' ? '{"pass": false, "reason": "仍不达标"}' : ('done:' + id);
          return Promise.resolve({
            childId: 'kid-ex-' + id + '-' + spawnedAfterCancel.length,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const r2 = await executePlan(scopeExhaust, plan, { retryFailed: true }, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(r2.status, 'need-lead');
    assert.equal(r2.node.label, '中审');
    assert.ok(!spawnedAfterCancel.includes('prep'), 'retryFailed after loop cancel reuses completed prep outside loop');
    assert.equal(r2.loops[0].exhausted, true);

    // 3) Resuming paused Lead after exhaustion with leadResult completes downstream `ship`
    const r3 = await executePlan(scopeExhaust, plan, { leadResult: 'Lead 人工拍板放行' }, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(r3.status, 'done');
    assert.equal(r3.results.ship, 'done:ship');

    // 4) fromNodes: ['impl'] reuses `prep` again and passes on Round 1
    const spawnedFrom = [];
    const scopePass = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          spawnedFrom.push(id);
          const txt = id === 'gate' ? '{"pass": true, "reason": "全部通过"}' : ('pass:' + id);
          return Promise.resolve({
            childId: 'kid-from-' + id,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const r4 = await executePlan(scopePass, plan, { fromNodes: ['impl'] }, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(r4.status, 'need-lead');
    assert.ok(!spawnedFrom.includes('prep'), 'fromNodes reuses prep outside target segment');
    assert.deepEqual(spawnedFrom, ['impl', 'gate']);
    assert.equal(r4.loops[0].used, 0);
    assert.equal(r4.loops[0].exhausted, false);

    // 5) reset: true from paused Lead discards pause and starts cleanly from prep
    const spawnedReset = [];
    const scopeReset = {
      sessions: { get: () => ({ header: { cwd: dir } }) },
      subagents: {
        startActivation(spec) {
          const id = String(spec.label || '').split('#').pop();
          spawnedReset.push(id);
          const txt = id === 'gate' ? '{"pass": true, "reason": "重置后通过"}' : ('reset:' + id);
          return Promise.resolve({
            childId: 'kid-reset-' + id,
            result: Promise.resolve({ output: [{ type: 'text', text: txt }], stopReason: 'completed' }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const r5 = await executePlan(scopeReset, plan, { reset: true }, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(r5.status, 'need-lead');
    assert.deepEqual(spawnedReset, ['prep', 'impl', 'gate']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
