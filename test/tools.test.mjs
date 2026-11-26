import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, orderNodes, upstreamOf, downstreamLabels, parsePayload, clipUpstreamOutput, briefFor, normalizeMaxIterations, extractJsonObjects, parseStrictJsonObject, parseStrictConditionJson, parseConditionDecision, clipSafeSlice, withoutEntry, analyzeCanvasWarnings, normalizeCanvas, applyPatch, inspectPlan, syncPresetsCatalog, handleCanvasPreset, sessionIdFromContext, buildActiveCanvasContext, isPermissionFailure, isTransientFailure, safeSessionFileBase, writeFileAtomic, pruneMapLRU, touchMapLRU, cleanupStaleCanvasFiles, buildRunSummarySnapshot, abortSessionRun, loopMemberIds, validateLoopEdges, executePlan } from '../index.js';

test('systemPrompt.context injects active canvas per session and stays silent for disabled/other sessions', async () => {
  let syncHandler = null;
  let contextProvider = null;
  const mockCtx = {
    inject(services, cb) {
      if (services.includes('systemPrompt')) {
        cb({
          systemPrompt: {
            context(entry) { contextProvider = entry; },
          },
          effect(fn) { fn(); },
        });
      }
      if (services.includes('commands')) {
        cb({
          commands: {
            register(cmd) { if (cmd.name === 'canvas-sync') syncHandler = cmd.handler; },
          },
          effect(fn) { fn(); },
        });
      }
    },
  };
  apply(mockCtx);
  assert.ok(contextProvider && typeof contextProvider.text === 'function', 'registers systemPrompt.context');
  assert.ok(syncHandler, 'registers canvas-sync command');

  const sid = 's-ctx-test';
  const plan = {
    task: '',
    nodes: [
      { id: 'a', kind: 'agent', label: '调研', role: '调研' },
      { id: 'pick', kind: 'lead', label: 'Lead 拍板', role: '拍板' },
      { id: 'b', kind: 'agent', label: '执行', role: '执行' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'pick', type: 'prompt' },
      { from: 'pick', to: 'b', type: 'prompt' },
    ],
  };

  // Disabled canvas -> empty string
  syncHandler({ agent: { id: sid }, rawInput: encodeURIComponent(JSON.stringify({ enabled: false, plan })) });
  assert.equal(contextProvider.text({ agent: { id: sid } }), '');

  // Enabled canvas -> injected ONLY for this session, empty for unrelated/subagent sessions
  syncHandler({ agent: { id: sid }, rawInput: encodeURIComponent(JSON.stringify({ enabled: true, plan })) });
  const activeText = contextProvider.text({ agent: { id: sid } });
  assert.ok(activeText.includes('[Workflow Canvas Active]'));
  assert.ok(activeText.includes('canvas_workflow'));
  assert.equal(contextProvider.text({ agent: { id: 'other-session' } }), '');
  assert.equal(contextProvider.text({}), '');
  assert.equal(sessionIdFromContext({ agent: { id: sid } }), sid);

  // When paused at intermediate Lead -> paused reminder names the Lead node
  const scope = {
    subagents: {
      startActivation() {
        return Promise.resolve({
          childId: 'kid-a',
          result: Promise.resolve({ output: [{ type: 'text', text: 'done-a' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        });
      },
    },
  };
  const paused = await executePlan(scope, plan, { task: '新任务' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(paused.status, 'need-lead');
  const pausedText = buildActiveCanvasContext(sid);
  assert.ok(pausedText.includes('Paused at Lead Step'));
  assert.ok(pausedText.includes('Lead 拍板'));

  // Disable canvas -> clears context immediately
  syncHandler({ agent: { id: sid }, rawInput: encodeURIComponent(JSON.stringify({ enabled: false, plan })) });
  assert.equal(contextProvider.text({ agent: { id: sid } }), '');
});

test('abortSessionRun & cancel:true cleanly end waitingLead pause (#13) and instantly abort hanging subagents (#11)', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wc-stop-'));
  try {
    // Part A (#13): Pause at intermediate Lead, then cancel via executePlan({ cancel: true }) / abortSessionRun
    const sidPause = 's-stop-waiting-' + Date.now();
    const scopePause = {
      sessions: {
        get(id) { return id === sidPause ? { header: { cwd: dir } } : null; },
      },
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
    const pausePlan = {
      task: '拍板后取消测试',
      nodes: [
        { id: 'a', kind: 'agent', label: '调研', role: '调研' },
        { id: 'gate', kind: 'lead', label: 'Lead 拍板', role: '人工决策' },
        { id: 'b', kind: 'agent', label: '执行', role: '执行' },
      ],
      edges: [
        { from: 'lead', to: 'a', type: 'prompt' },
        { from: 'a', to: 'gate', type: 'prompt' },
        { from: 'gate', to: 'b', type: 'prompt' },
      ],
    };
    const rPause = await executePlan(scopePause, pausePlan, {}, { agent: { id: sidPause }, signal: new AbortController().signal });
    assert.equal(rPause.status, 'need-lead');
    const pausedRunFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sidPause + '.run.json'), 'utf8'));
    assert.equal(pausedRunFile.status, 'need-lead');
    assert.equal(pausedRunFile.waitingLead.id, 'gate');

    const rCancel = await executePlan(scopePause, pausePlan, { cancel: true }, { agent: { id: sidPause }, signal: new AbortController().signal });
    assert.equal(rCancel.status, 'cancelled');
    assert.equal(rCancel.wasWaiting, true);
    const haltedRunFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sidPause + '.run.json'), 'utf8'));
    assert.equal(haltedRunFile.status, 'halted');
    assert.equal(haltedRunFile.waitingLead, null);

    // After cancelling waitingLead, starting a fresh run works cleanly (no stale waitingLead lock)
    const rFresh = await executePlan(scopePause, pausePlan, {}, { agent: { id: sidPause }, signal: new AbortController().signal });
    assert.equal(rFresh.status, 'need-lead');
    abortSessionRun(scopePause, sidPause);

    // Part B (#11): Active subagent that never resolves on its own -> abortSessionRun aborts signal,
    // invokes DSH native subagents.interrupt(childId, { kind: 'user' }), drainDescendants([rootAgent]),
    // rootAgent.cancel({ kind: 'user' }, { keepInbox: true }), and unblocks executePlan immediately!
    const sidRun = 's-stop-running-' + Date.now();
    const interruptedChildren = [];
    let drainedAgents = null;
    let rootCancelArgs = null;
    let observedSignalAborted = false;
    let startedResolve;
    const started = new Promise((r) => { startedResolve = r; });
    const mockRootAgent = {
      id: sidRun,
      running: true,
      cancel(cause, options) { rootCancelArgs = { cause, options }; },
    };
    const scopeRun = {
      sessions: {
        get(id) { return id === sidRun ? { header: { cwd: dir } } : null; },
      },
      subagents: {
        interrupt(cid, authority) { interruptedChildren.push({ cid, authority }); },
        drainDescendants(agents) { drainedAgents = agents; return Promise.resolve(); },
        startActivation(spec) {
          spec.signal.addEventListener('abort', () => { observedSignalAborted = true; }, { once: true });
          startedResolve();
          return Promise.resolve({
            childId: 'kid-slow',
            // Deliberately never resolves to prove abortPromise unblocks executePlan immediately
            result: new Promise(() => {}),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const slowPlan = {
      task: '运行中一键终止测试',
      nodes: [{ id: 'slow', kind: 'agent', label: '慢节点', role: '慢任务' }],
      edges: [{ from: 'lead', to: 'slow', type: 'prompt' }],
    };
    const runPromise = executePlan(scopeRun, slowPlan, {}, { agent: mockRootAgent, signal: new AbortController().signal });
    await started;
    const stopRes = abortSessionRun(scopeRun, sidRun, mockRootAgent);
    assert.equal(stopRes.wasRunning, true);
    const abortedOut = await runPromise;
    assert.equal(abortedOut.status, 'halted');
    assert.ok(abortedOut.error.includes('已取消'));
    assert.equal(observedSignalAborted, true, 'runSignal aborts in-flight subagent spec.signal');
    assert.deepEqual(interruptedChildren, [{ cid: 'kid-slow', authority: { kind: 'user' } }], 'calls DSH subagents.interrupt with user authority');
    assert.deepEqual(drainedAgents, [mockRootAgent], 'calls DSH subagents.drainDescendants on root agent');
    assert.deepEqual(rootCancelArgs, { cause: { kind: 'user' }, options: { keepInbox: true } }, 'calls rootAgent.cancel with verified signature');
    const stoppedRunFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sidRun + '.run.json'), 'utf8'));
    assert.equal(stoppedRunFile.status, 'halted');
    assert.equal(stoppedRunFile.waitingLead, null);

    // Part C: `/canvas-stop` command is registered by apply(ctx) and succeeds
    const commands = new Map();
    const mockCtx = {
      inject(deps, fn) {
        if (deps.includes('commands')) {
          fn({
            effect(cb) { cb(); },
            commands: { register(cmd) { commands.set(cmd.name, cmd); } },
          });
        }
      },
    };
    apply(mockCtx);
    assert.ok(commands.has('canvas-stop'), 'registers /canvas-stop command');
    const cmdRes = commands.get('canvas-stop').handler({ agent: { id: sidPause } });
    assert.equal(cmdRes.kind, 'success');

    // Part D: Parent AbortSignal (DSH native chat Stop) interrupts live children AND suppresses fallbackModel retry
    const sidNative = 's-native-stop-' + Date.now();
    const nativeInterrupts = [];
    let spawnCount = 0;
    let resolveStart;
    const startedNative = new Promise((r) => { resolveStart = r; });
    const parentCtrl = new AbortController();
    const scopeNative = {
      sessions: { get: () => null },
      subagents: {
        interrupt(cid, authority) { nativeInterrupts.push({ cid, authority }); },
        startActivation(spec) {
          spawnCount += 1;
          resolveStart();
          return Promise.resolve({
            childId: 'kid-fb-1',
            result: new Promise((res) => {
              spec.signal.addEventListener('abort', () => {
                res({ output: [{ type: 'text', text: '' }], stopReason: 'cancelled' });
              }, { once: true });
            }),
            dispose: () => Promise.resolve(),
          });
        },
      },
    };
    const fbPlan = {
      task: '原生停止不触发备用模型重试',
      nodes: [{ id: 'n1', kind: 'agent', label: '编码', role: '编码', fallbackModel: 'backup-m' }],
      edges: [{ from: 'lead', to: 'n1', type: 'prompt' }],
    };
    const nativePromise = executePlan(scopeNative, fbPlan, {}, { agent: { id: sidNative }, signal: parentCtrl.signal });
    await startedNative;
    parentCtrl.abort('user-native-stop');
    const nativeOut = await nativePromise;
    assert.equal(nativeOut.status, 'halted');
    assert.deepEqual(nativeInterrupts, [{ cid: 'kid-fb-1', authority: { kind: 'user' } }], 'native parent AbortSignal interrupts live children');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawnCount, 1, 'aborted node must NEVER spawn its fallbackModel retry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent strong context, canvas_inspect render, and Lead render reflect loops, refs, and cancel', async () => {
  const tools = new Map();
  const commands = new Map();
  const mockCtx = {
    inject(deps, fn) {
      const fakeScope = {
        effect(cb) { cb(); },
        commands: { register(c) { commands.set(c.name, c); } },
        tools: { register(t) { tools.set(t.name, t); } },
        subagents: {
          startActivation(spec) {
            const id = spec.label.split('#')[1];
            return Promise.resolve({
              childId: 'kid-' + id,
              result: Promise.resolve({ output: [{ type: 'text', text: 'ok:' + id }], stopReason: 'completed' }),
              dispose: () => Promise.resolve(),
            });
          },
        },
        sessions: { get: () => null },
      };
      if (deps.includes('commands') || deps.includes('tools')) fn(fakeScope);
    },
  };
  apply(mockCtx);

  const sid = 's-ctx-sync-' + Date.now();
  const plan = {
    task: '带参考与回环的强注入测试',
    refs: ['docs/spec.md'],
    nodes: [
      { id: 'draft', kind: 'agent', label: '实现', role: '编码' },
      { id: 'gate', kind: 'condition', label: '是否通过', role: '检查' },
      { id: 'mid', kind: 'lead', label: '人工拍板', role: '确认', refs: ['docs/review.md'] },
      { id: 'final', kind: 'lead', label: '终审', role: '交付', refs: ['docs/ship.md'] },
    ],
    edges: [
      { from: 'lead', to: 'draft', type: 'prompt' },
      { from: 'draft', to: 'gate', type: 'prompt' },
      { from: 'gate', to: 'mid', type: 'prompt', branch: 'true' },
      { from: 'gate', to: 'draft', type: 'prompt', branch: 'false', loop: true, maxIterations: 4 },
      { from: 'mid', to: 'final', type: 'prompt' },
    ],
  };
  commands.get('canvas-sync').handler({
    agent: { id: sid },
    rawInput: encodeURIComponent(JSON.stringify({ enabled: true, plan })),
  });

  // 1) Active systemPrompt strong context reflects loops + global refs + edit guidance
  const activeCtx = buildActiveCanvasContext(sid);
  assert.ok(activeCtx.includes('1 条受控回环'), 'active context informs agent of controlled loops');
  assert.ok(activeCtx.includes('全局参考 ×1'), 'active context informs agent of global refs');
  assert.ok(activeCtx.includes('参考清单、条件分支、回环'), 'active context includes new edit items');

  // 2) canvas_inspect render shows global refs and loop edge badge
  const inspectVal = tools.get('canvas_inspect').execute({}, { agent: { id: sid } });
  const inspectText = tools.get('canvas_inspect').output.render({}, inspectVal)[0].text;
  assert.ok(inspectText.includes('全局参考：docs/spec.md'), 'canvas_inspect render prints global refs');
  assert.ok(inspectText.includes('↺ loop ×4'), 'canvas_inspect render prints loop edge & maxIterations');

  // 3) Lead steps receive merged global + node refs in rendered tool output & cancel hint
  const wfTool = tools.get('canvas_workflow');
  const scope = {
    subagents: {
      startActivation(spec) {
        const id = spec.label.split('#')[1];
        if (id === 'gate') {
          return Promise.resolve({
            childId: 'kid-gate',
            result: Promise.resolve({ structured: { pass: true, reason: '通过' }, output: [{ type: 'text', text: '' }], stopReason: 'completed' }),
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
  const rMid = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(rMid.status, 'need-lead');
  const midRendered = wfTool.output.render({}, rMid)[0].text;
  assert.ok(midRendered.includes('docs/spec.md') && midRendered.includes('docs/review.md'), 'need-lead render displays merged global + node refs');
  assert.ok(midRendered.includes('cancel: true'), 'need-lead hint mentions cancel: true');

  const pausedCtx = buildActiveCanvasContext(sid);
  assert.ok(pausedCtx.includes('cancel: true'), 'paused strong context mentions cancel: true');

  const rFinal = await executePlan(scope, plan, { leadResult: '放行' }, { agent: { id: sid }, signal: new AbortController().signal });
  assert.equal(rFinal.status, 'done');
  const finalRendered = wfTool.output.render({}, rFinal)[0].text;
  assert.ok(finalRendered.includes('docs/spec.md') && finalRendered.includes('docs/ship.md'), 'finalLead render displays merged global + node refs');

  // 4) Condition nodes always stay `minimal` and never trigger false multi-standard permission warnings
  const condOnlyGen = normalizeCanvas({
    task: '条件只读测试',
    nodes: [
      { id: 'c1', kind: 'condition', label: '判断1', role: 'r1' },
      { id: 'c2', kind: 'condition', label: '判断2', role: 'r2' },
    ],
    edges: [{ from: 'lead', to: 'c1' }, { from: 'c1', to: 'c2', branch: 'true' }],
  });
  assert.equal(condOnlyGen.nodes.find((n) => n.id === 'c1').preset, 'minimal');
  const patchedCond = applyPatch({ task: 't', nodes: withoutEntry(condOnlyGen.nodes), edges: condOnlyGen.edges }, {
    nodes: [{ id: 'c3', kind: 'condition', label: '判断3', role: 'r3' }],
  });
  assert.equal(patchedCond.plan.nodes.find((n) => n.id === 'c3').preset, 'minimal');
  const sidCondOnly = 's-cond-minimal-' + Date.now();
  commands.get('canvas-sync').handler({
    agent: { id: sidCondOnly },
    rawInput: encodeURIComponent(JSON.stringify({ enabled: true, plan: patchedCond.plan })),
  });
  assert.ok(!buildActiveCanvasContext(sidCondOnly).includes('可写/命令型'), 'read-only condition nodes must not trigger standard permission warning');
});

test('executePlan publishes zero-token .run.json summary with timings, fallback, loops & halt finalization', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wc-summary-'));
  try {
    const sid = 's-summary-' + Date.now();
    let implCalls = 0;
    let gateCalls = 0;
    const scope = {
      sessions: {
        get: (id) => (id === sid ? { header: { cwd: dir } } : null),
      },
      subagents: {
        startActivation: (req) => {
          const id = String((req && req.label) || '').split('#').pop();
          if (id === 'impl') {
            implCalls += 1;
            // Fail primary on first attempt so fallbackModel rescues it
            if (implCalls === 1 && !req.model) {
              return Promise.resolve({
                childId: 'kid-impl-fail',
                result: Promise.resolve({ output: [{ type: 'text', text: 'transient error' }], stopReason: 'error' }),
                dispose: () => Promise.resolve(),
              });
            }
            return Promise.resolve({
              childId: 'kid-impl-' + implCalls,
              result: new Promise((r) => setTimeout(() => r({ output: [{ type: 'text', text: 'impl ok #' + implCalls }], stopReason: 'completed' }), 15)),
              dispose: () => Promise.resolve(),
            });
          }
          if (id === 'gate') {
            gateCalls += 1;
            const pass = gateCalls >= 2;
            return Promise.resolve({
              childId: 'kid-gate-' + gateCalls,
              result: Promise.resolve({
                structured: { pass, reason: pass ? 'all green' : 'fix edge case' },
                output: [{ type: 'text', text: '' }],
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
      task: '执行复盘遥测测试',
      maxParallel: 3,
      nodes: [
        { id: 'impl', kind: 'agent', label: '实现', role: '实现', fallbackModel: 'backup-m' },
        { id: 'gate', kind: 'condition', label: '门禁', role: '门禁' },
        { id: 'final', kind: 'lead', label: '终审', role: '终审' },
      ],
      edges: [
        { from: 'lead', to: 'impl', type: 'prompt' },
        { from: 'impl', to: 'gate', type: 'prompt' },
        { from: 'gate', to: 'final', type: 'prompt', branch: 'true' },
        { from: 'gate', to: 'impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
      ],
    };
    const res = await executePlan(scope, plan, {}, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(res.status, 'done');

    const runFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', sid + '.run.json'), 'utf8'));
    assert.equal(runFile.status, 'done');
    assert.ok(runFile.summary, '.run.json must carry structured summary');
    assert.equal(runFile.summary.status, 'done');
    assert.equal(runFile.summary.maxParallel, 3);
    assert.equal(runFile.summary.totalLoops, 1);
    assert.ok(typeof runFile.summary.startedAt === 'number' && typeof runFile.summary.endedAt === 'number');
    assert.ok(runFile.summary.endedAt >= runFile.summary.startedAt);

    const implStat = runFile.summary.nodes.find((n) => n.id === 'impl');
    assert.ok(implStat);
    assert.equal(implStat.status, 'done');
    assert.equal(implStat.runs, 2, 'impl executed across 2 loop rounds');
    assert.equal(implStat.fallbackUsed, true, 'records fallback model rescue');
    assert.ok(implStat.durationMs >= 10, 'records cumulative durationMs');
    assert.ok(implStat.childId, 'records childId for direct chat jump');

    const finalStat = runFile.summary.nodes.find((n) => n.id === 'final');
    assert.equal(finalStat.kind, 'lead');
    assert.equal(finalStat.status, 'done');

    assert.equal(runFile.summary.loops.length, 1);
    assert.equal(runFile.summary.loops[0].used, 1);
    assert.equal(runFile.summary.loops[0].rounds[0].reason, 'fix edge case');

    // Verify halted snapshot finalizes still-running node cleanly
    const haltedSnap = buildRunSummarySnapshot({
      startedAt: 1000,
      orderIds: ['a'],
      nodeMeta: { a: { label: 'A', kind: 'agent', model: 'm1' } },
      nodeStats: { a: { id: 'a', label: 'A', kind: 'agent', status: 'running', startedAt: 2000, endedAt: null, durationMs: 500, runs: 1 } },
      pruned: new Set(),
      decisions: {},
      failed: {},
      emptyOutputs: {},
    }, { status: 'halted', haltedReason: '用户主动终止', now: 3500 });
    assert.equal(haltedSnap.nodes[0].status, 'halted');
    assert.equal(haltedSnap.nodes[0].durationMs, 2000);
    assert.equal(haltedSnap.haltedReason, '用户主动终止');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clipUpstreamOutput and briefFor fold oversized upstream outputs while preserving head conclusion and tail error', () => {
  assert.equal(clipUpstreamOutput('short summary', 1000), 'short summary');
  const head = 'HEAD_CONCLUSION: all modules checked.\n';
  const tail = '\nTAIL_SUMMARY: 1 warning in footer.';
  const huge = head + 'X'.repeat(20000) + tail;
  const clipped = clipUpstreamOutput(huge, 16000);
  assert.ok(clipped.length < huge.length, 'oversized output is compacted');
  assert.ok(clipped.startsWith(head), 'head conclusion preserved');
  assert.ok(clipped.endsWith(tail), 'tail conclusion/error preserved');
  assert.ok(clipped.includes('已折叠中间'), 'omitted char notice included');

  const plan = {
    task: '裁剪测试',
    nodes: [
      { id: 'a', kind: 'agent', label: '日志产出', role: 'r1' },
      { id: 'b', kind: 'agent', label: '下游汇总', role: 'r2' },
    ],
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'b', type: 'prompt' },
    ],
  };
  const prompt = briefFor(plan, plan.nodes[1], { a: huge });
  assert.ok(prompt.includes('HEAD_CONCLUSION'), 'brief keeps upstream head');
  assert.ok(prompt.includes('TAIL_SUMMARY'), 'brief keeps upstream tail');
  assert.ok(prompt.includes('已折叠中间'), 'brief folds oversized prose upstream');
  assert.ok(prompt.length < 18000, 'brief stays bounded well below raw 20K payload');

  // Structured JSON edges receive the larger 24K budget (20K JSON stays intact without corruption)
  const jsonPlan = {
    ...plan,
    edges: [
      { from: 'lead', to: 'a', type: 'prompt' },
      { from: 'a', to: 'b', type: 'structured' },
    ],
  };
  const jsonPrompt = briefFor(jsonPlan, jsonPlan.nodes[1], { a: '{"data":"' + 'y'.repeat(19000) + '"}' });
  assert.ok(!jsonPrompt.includes('已折叠中间'), '20K structured JSON fits within 24K structured budget');
  assert.ok(jsonPrompt.includes('JSON，可直接解析'), 'unclipped structured JSON keeps parseable header');
  const hugeJsonPrompt = briefFor(jsonPlan, jsonPlan.nodes[1], { a: '{"data":"' + 'y'.repeat(30000) + '"}' });
  assert.ok(hugeJsonPrompt.includes('已折叠中间'), '30K structured JSON is head+tail folded');
  assert.ok(hugeJsonPrompt.includes('超长已头尾折叠'), 'folded structured JSON warns downstream not to blindly JSON.parse');
});

test('LRU map helpers evict oldest entries and cleanupStaleCanvasFiles removes >14d orphan files safely', () => {
  const m = new Map();
  touchMapLRU(m, 'a', 1, 3);
  touchMapLRU(m, 'b', 2, 3);
  touchMapLRU(m, 'c', 3, 3);
  touchMapLRU(m, 'a', 10, 3); // refresh 'a' -> 'b' is now oldest
  touchMapLRU(m, 'd', 4, 3);  // evicts 'b'
  assert.deepEqual(Array.from(m.keys()), ['c', 'a', 'd']);
  assert.equal(m.get('a'), 10);
  assert.equal(pruneMapLRU(m, 2), 1);
  assert.deepEqual(Array.from(m.keys()), ['a', 'd']);

  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-cleanup-'));
  try {
    const now = Date.now();
    const oldSec = (now - 20 * 24 * 60 * 60 * 1000) / 1000; // 20 days ago
    const freshSec = (now - 2 * 24 * 60 * 60 * 1000) / 1000; // 2 days ago
    const oldCanvas = join(dir, 'orphan-1.json');
    const oldRun = join(dir, 'orphan-1.run.json');
    const activeOldRun = join(dir, 'active-s.run.json');
    const freshCanvas = join(dir, 'fresh-s.json');
    const otherTxt = join(dir, 'readme.txt');
    for (const f of [oldCanvas, oldRun, activeOldRun, freshCanvas, otherTxt]) writeFileSync(f, '{}', 'utf8');
    utimesSync(oldCanvas, oldSec, oldSec);
    utimesSync(oldRun, oldSec, oldSec);
    utimesSync(activeOldRun, oldSec, oldSec);
    utimesSync(freshCanvas, freshSec, freshSec);
    utimesSync(otherTxt, oldSec, oldSec);

    const removed1 = cleanupStaleCanvasFiles(dir, { activeIds: new Set(['active-s']), now, force: true });
    assert.equal(removed1, 2, 'removes both old orphan .json and .run.json');
    assert.equal(existsSync(oldCanvas), false);
    assert.equal(existsSync(oldRun), false);
    assert.equal(existsSync(activeOldRun), true, 'active session file is protected');
    assert.equal(existsSync(freshCanvas), true, 'fresh (<14d) file is preserved');
    assert.equal(existsSync(otherTxt), true, 'non-json file is untouched');

    // Without force, second call within 1h throttle window is a fast no-op
    const oldCanvas2 = join(dir, 'orphan-2.json');
    writeFileSync(oldCanvas2, '{}', 'utf8');
    utimesSync(oldCanvas2, oldSec, oldSec);
    const removed2 = cleanupStaleCanvasFiles(dir, { activeIds: new Set(), now: now + 5000 });
    assert.equal(removed2, 0, 'throttled within 1 hour per directory');
    assert.equal(existsSync(oldCanvas2), true);

    // Orphaned atomic-write *.tmp files older than 1h are reaped while fresh *.tmp files stay intact
    const oldTmp = join(dir, 'crash.json.123.1.tmp');
    const freshTmp = join(dir, 'writing.json.123.2.tmp');
    writeFileSync(oldTmp, 'partial', 'utf8');
    writeFileSync(freshTmp, 'partial', 'utf8');
    utimesSync(oldTmp, (now - 2 * 60 * 60 * 1000) / 1000, (now - 2 * 60 * 60 * 1000) / 1000);
    utimesSync(freshTmp, (now - 5 * 60 * 1000) / 1000, (now - 5 * 60 * 1000) / 1000);
    const removedTmp = cleanupStaleCanvasFiles(dir, { activeIds: new Set(['active-s']), now, force: true });
    assert.equal(removedTmp, 2, 'removes orphan-2.json (>14d) and oldTmp (>1h)');
    assert.equal(existsSync(oldTmp), false);
    assert.equal(existsSync(freshTmp), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic writes cleanly without leaving temp files, and clipUpstreamOutput preserves UTF-16 surrogate pairs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-atomic-'));
  try {
    const target = join(dir, 'nested', 'state.json');
    writeFileAtomic(target, '{"v":1}');
    assert.equal(readFileSync(target, 'utf8'), '{"v":1}');
    writeFileAtomic(target, '{"v":2,"ok":true}');
    assert.equal(readFileSync(target, 'utf8'), '{"v":2,"ok":true}');
    const entries = readdirSync(join(dir, 'nested'));
    assert.deepEqual(entries, ['state.json'], 'zero leftover .tmp files after atomic writes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Construct an emoji-heavy string where naive UTF-16 slicing hits the middle of a surrogate pair
  const emojiStream = 'a' + '🚀'.repeat(1200); // odd offset guarantees surrogate boundary hits at even maxChars*0.68 / 0.25
  const clipped = clipUpstreamOutput(emojiStream, 1000);
  assert.ok(clipped.includes('已折叠中间'));
  assert.equal(clipped.isWellFormed(), true, 'clipped output must contain zero lone UTF-16 surrogates');
});

test('clear input validation and actionable errors across parsePayload, normalizeCanvas, applyPatch, and fromNodes', async () => {
  const badJson = parsePayload('not%20valid%20json');
  assert.equal(badJson.enabled, false);
  assert.ok(badJson.error && badJson.error.includes('画布数据解析失败'));
  const nonObj = parsePayload(encodeURIComponent('[1,2,3]'));
  assert.equal(nonObj.enabled, false);
  assert.ok(nonObj.error && nonObj.error.includes('JSON 对象'));

  const badNodes = normalizeCanvas({ nodes: 'not-array' });
  assert.ok(badNodes.error && badNodes.error.includes('nodes 必须是包含至少一个节点的数组'));

  const withDroppedAndCycle = normalizeCanvas({
    task: '校验测试',
    nodes: [
      { id: 'a', label: 'A', role: 'r1' },
      { id: 'b', label: 'B', role: 'r2' },
    ],
    edges: [
      { from: 'lead', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },         // forward cycle without loop:true
      { from: 'a', to: 'ghost_99' },  // unknown target
      { from: 'a', to: 'a' },         // self-loop
    ],
  });
  assert.ok(withDroppedAndCycle.warnings.some((w) => w.includes('环路')), 'flags forward cycle early in warnings');
  assert.ok(withDroppedAndCycle.warnings.some((w) => w.includes('ghost_99') && w.includes('a → a')), 'reports dropped invalid edges');

  const patched = applyPatch(
    { task: 't', nodes: [{ id: 'a', kind: 'agent', label: 'A', role: 'r1' }], edges: [{ from: 'lead', to: 'a', type: 'prompt' }] },
    {
      nodes: [{ id: 'lead', task: 'wrong place' }],
      removeNodes: ['lead'],
      edges: [{ from: 'a', to: 'missing_node' }],
    },
  );
  assert.ok(patched.warnings.some((w) => w.includes('入口节点 lead 不可通过 nodes[] 修改')));
  assert.ok(patched.warnings.some((w) => w.includes('入口节点 lead 不能删除')));
  assert.ok(patched.warnings.some((w) => w.includes('missing_node')));

  const scope = { subagents: { startActivation() { throw new Error('should not spawn on invalid input'); } } };
  const validPlan = {
    task: 't',
    nodes: [{ id: 'n1', kind: 'agent', label: '分析', role: 'r1' }],
    edges: [{ from: 'lead', to: 'n1', type: 'prompt' }],
  };
  const badType = await executePlan(scope, validPlan, { fromNodes: 'n1' }, { agent: { id: 's-val-1' } });
  assert.ok(badType.error && badType.error.includes('字符串数组'), 'rejects non-array fromNodes clearly');

  const unknownTarget = await executePlan(scope, validPlan, { fromNodes: ['typo_node'] }, { agent: { id: 's-val-2' } });
  assert.ok(unknownTarget.error && unknownTarget.error.includes('typo_node') && unknownTarget.error.includes('n1(分析)'), 'lists unknown and valid nodes');
});

test('late startActivation abort interrupts child immediately, agent.status === running cancels root, and /canvas-sync preserves paused Lead', async () => {
  // 1) Abort while startActivation is still pending: once it resolves, immediately interrupt the late child
  let resolveStart;
  const interrupted = [];
  let rootCancelled = 0;
  const scopeAbort = {
    subagents: {
      startActivation() {
        return new Promise((resolve) => {
          resolveStart = () => resolve({
            childId: 'kid-late-1',
            result: new Promise(() => {}),
            dispose: () => Promise.resolve(),
          });
        });
      },
      interrupt(cid) { interrupted.push(cid); return Promise.resolve(); },
      drainDescendants() { return Promise.resolve(); },
    },
  };
  const planAbort = {
    task: 'late start abort',
    nodes: [{ id: 'a', kind: 'agent', label: 'A', role: 'r1' }],
    edges: [{ from: 'lead', to: 'a', type: 'prompt' }],
  };
  const sidAbort = 's-late-abort-' + Date.now();
  const rootAgent = {
    id: sidAbort,
    status: 'running', // DSH 0.2.2 verified field (no `.running` boolean)
    cancel() { rootCancelled += 1; },
  };
  const runP = executePlan(scopeAbort, planAbort, {}, { agent: rootAgent, signal: new AbortController().signal });
  await new Promise((r) => setTimeout(r, 10));
  abortSessionRun(scopeAbort, sidAbort, rootAgent);
  assert.equal(rootCancelled, 1, 'abortSessionRun cancels root agent when agent.status === "running"');
  resolveStart();
  const resAbort = await runP;
  assert.equal(resAbort.status, 'halted');
  assert.ok(interrupted.includes('kid-late-1'), 'late-resolving child is interrupted immediately on abort');

  // 2) /canvas-sync with identical enabled plan preserves paused waitingLead (e.g. remount auto-sync)
  const commands = new Map();
  const tools = new Map();
  const fakeCtx = {
    inject(names, fn) {
      const scope = {
        effect: (cb) => cb(),
        commands: { register: (c) => { commands.set(c.name, c); return () => {}; } },
        tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
        subagents: {
          startActivation() {
            return Promise.resolve({
              childId: 'kid-sync-1',
              result: Promise.resolve({ output: [{ type: 'text', text: 'step1 ok' }], stopReason: 'completed' }),
              dispose: () => Promise.resolve(),
            });
          },
        },
        sessions: {},
      };
      fn(scope);
    },
  };
  apply(fakeCtx);
  const sidSync = 's-sync-keep-' + Date.now();
  const syncPayload = encodeURIComponent(JSON.stringify({
    enabled: true,
    plan: {
      task: '保留拍板',
      nodes: [
        { id: 'a', kind: 'agent', label: '摸底', role: 'r1' },
        { id: 'l1', kind: 'lead', label: '拍板', role: '确认' },
        { id: 'b', kind: 'agent', label: '执行', role: 'r2' },
      ],
      edges: [
        { from: 'lead', to: 'a', type: 'prompt' },
        { from: 'a', to: 'l1', type: 'prompt' },
        { from: 'l1', to: 'b', type: 'prompt' },
      ],
    },
  }));
  const syncCmd = commands.get('canvas-sync');
  const wfTool = tools.get('canvas_workflow');
  assert.equal(syncCmd.handler({ agent: { id: sidSync }, rawInput: syncPayload }).kind, 'success');
  const paused = await wfTool.execute({}, { agent: { id: sidSync }, signal: new AbortController().signal });
  assert.equal(paused.status, 'need-lead');
  // Re-sync identical enabled plan -> waitingLead must stay intact!
  assert.equal(syncCmd.handler({ agent: { id: sidSync }, rawInput: syncPayload }).kind, 'success');
  assert.equal(inspectPlan(sidSync).paused, true, 'identical enabled /canvas-sync preserves paused waitingLead');
  // Halted render surfaces completed results & failed nodes
  const renderedHalted = wfTool.output.render({}, {
    status: 'halted',
    error: '权限被拒',
    results: { a: '摸底已完成' },
    labels: { a: '摸底' },
    failed: [{ id: 'b', label: '执行', reason: 'permission denied' }],
  });
  assert.ok(renderedHalted[0].text.includes('权限被拒') && renderedHalted[0].text.includes('摸底已完成') && renderedHalted[0].text.includes('执行'));
});

test('input validation & classifier hardening: null/blank defaults, self-loop, errorDetail, stack-trace 502, Windows reserved names, applyPatch structured preservation', async () => {
  // normalizeMaxIterations & maxParallel reject null / '' / boolean instead of clamping to 1
  assert.equal(normalizeMaxIterations(null), 3);
  assert.equal(normalizeMaxIterations(''), 3);
  assert.equal(normalizeMaxIterations(false), 3);
  assert.equal(normalizeMaxIterations(true), 3);
  assert.equal(normalizeMaxIterations(0), 1);

  // loopMemberIds & validateLoopEdges reject self-loop
  assert.equal(loopMemberIds([{ id: 'c', kind: 'condition' }], [], { from: 'c', to: 'c', loop: true }).size, 0);
  const selfLoopCheck = validateLoopEdges([{ id: 'c', kind: 'condition' }], [{ from: 'c', to: 'c', loop: true }]);
  assert.equal(selfLoopCheck.length, 1);

  // isPermissionFailure inspects errorDetail too
  assert.equal(isPermissionFailure({ ok: false, text: '', errorDetail: 'EACCES: permission denied' }), true);

  // isTransientFailure ignores line numbers like :502: and overly long prose
  assert.equal(isTransientFailure({ ok: false, text: 'TypeError at src/app.js:502:14' }), false);
  assert.equal(isTransientFailure({ ok: false, text: 'HTTP 502 Bad Gateway' }), true);
  assert.equal(isTransientFailure({ ok: false, text: 'x'.repeat(1200) + ' HTTP 503' }), false);

  // Windows reserved device names are prefixed safely
  assert.equal(safeSessionFileBase('CON'), '_CON');
  assert.equal(safeSessionFileBase('nul.txt'), '_nul.txt');
  assert.equal(safeSessionFileBase('COM1'), '_COM1');

  // applyPatch rejects blank / '#' id and preserves explicit terminal structured: true
  const p = applyPatch(
    {
      task: 't',
      nodes: [{ id: 'a', kind: 'agent', label: 'A', role: 'r1', structured: true }],
      edges: [{ from: 'lead', to: 'a', type: 'prompt' }],
    },
    {
      nodes: [{ id: '   ', label: 'bad' }, { id: 'bad#id', label: 'hash' }, { id: 'a', role: 'r2' }],
    },
  );
  assert.ok(p.warnings.some((w) => w.includes('缺少有效字符串 id')));
  assert.ok(p.warnings.some((w) => w.includes('bad#id')));
  assert.equal(p.plan.nodes.length, 1);
  assert.equal(p.plan.nodes[0].structured, true, 'explicit terminal structured: true preserved when no structured edge was removed');

  // fromNodes rejects [] and blank/non-string items; maxParallel: null defaults to 4
  const scope = { subagents: { startActivation() { throw new Error('should not spawn'); } } };
  const basePlan = {
    task: 't',
    nodes: [{ id: 'a', kind: 'agent', label: 'A', role: 'r1' }],
    edges: [{ from: 'lead', to: 'a', type: 'prompt' }],
  };
  const emptyFrom = await executePlan(scope, basePlan, { fromNodes: [] }, { agent: { id: 's-empty-fn' } });
  assert.ok(emptyFrom.error && emptyFrom.error.includes('非空字符串数组'));
  const badItemFrom = await executePlan(scope, basePlan, { fromNodes: ['  ', 123] }, { agent: { id: 's-bad-fn' } });
  assert.ok(badItemFrom.error && badItemFrom.error.includes('非字符串或空白项'));
});

test('canvas_preset (#14): syncs user presets via /canvas-sync, lists/applies presets & built-in templates, toggles enabled in place, and guards paused runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-preset-'));
  try {
    const commands = new Map();
    const tools = new Map();
    const fakeCtx = {
      inject(_names, fn) {
        const scope = {
          effect: (cb) => cb(),
          commands: { register: (c) => { commands.set(c.name, c); return () => {}; } },
          tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
          sessions: { get: () => ({ header: { cwd: dir } }) },
          subagents: {
            startActivation() {
              return Promise.resolve({
                childId: 'kid-preset-1',
                result: Promise.resolve({ output: [{ type: 'text', text: 'step ok' }], stopReason: 'completed' }),
                dispose: () => Promise.resolve(),
              });
            },
          },
        };
        fn(scope);
      },
    };
    apply(fakeCtx);
    const syncCmd = commands.get('canvas-sync');
    const presetTool = tools.get('canvas_preset');
    const wfTool = tools.get('canvas_workflow');
    assert.ok(presetTool, 'canvas_preset tool is registered');

    const sid = 's-preset-' + Date.now();
    // 1) Sync canvas + user presets catalog via /canvas-sync
    const syncPayload = encodeURIComponent(JSON.stringify({
      enabled: true,
      presetName: '代码审查流',
      plan: {
        task: '旧任务',
        nodes: [{ id: 'a', kind: 'agent', label: '扫描', role: 'scan' }],
        edges: [{ from: 'lead', to: 'a', type: 'prompt' }],
      },
      presets: {
        '代码审查流': {
          direction: 'tb',
          nodes: [
            { id: 'lead', kind: 'lead', task: '审查 PR' },
            { id: 'r1', kind: 'agent', label: '安全审计', role: 'audit', preset: 'minimal' },
            { id: 'r2', kind: 'lead', label: 'Lead 终审', role: 'review' },
          ],
          edges: [
            { from: 'lead', to: 'r1', type: 'prompt' },
            { from: 'r1', to: 'r2', type: 'prompt' },
          ],
        },
        '代码发布流': {
          direction: 'lr',
          nodes: [
            { id: 'lead', kind: 'lead', task: '发布版本' },
            { id: 'p1', kind: 'agent', label: '打包检查', role: 'pack' },
          ],
          edges: [{ from: 'lead', to: 'p1', type: 'prompt' }],
          comments: [
            { id: 'cm-rel', x: 20, y: 10, w: 300, h: 200, title: '发布前检查', body: '核对版本号', color: 'green', fontSize: 'md', zoomScale: true },
          ],
        },
      },
    }));
    assert.equal(syncCmd.handler({ agent: { id: sid }, rawInput: syncPayload }).kind, 'success');

    // Active context includes active preset name and mismatch guidance
    const ctxText = buildActiveCanvasContext(sid);
    assert.ok(ctxText.includes('预设「代码审查流」'), 'active context surfaces preset name');
    assert.ok(ctxText.includes('canvas_preset'), 'active context guides mismatch handling via canvas_preset');
    assert.equal(inspectPlan(sid).presetName, '代码审查流');

    // 2) action="list" returns current state + 2 user presets + 5 built-in templates
    const listed = presetTool.execute({ action: 'list' }, { agent: { id: sid } });
    assert.equal(listed.current.enabled, true);
    assert.equal(listed.current.presetName, '代码审查流');
    assert.equal(listed.userPresets.length, 2);
    assert.equal(listed.builtinTemplates.length, 5);
    const listRendered = presetTool.output.render({}, listed)[0].text;
    assert.ok(listRendered.includes('代码审查流') && listRendered.includes('tpl-cond'));

    // 3) Ambiguous substring rejected with candidate list
    const amb = presetTool.execute({ action: 'apply', name: '代码' }, { agent: { id: sid } });
    assert.ok(amb.error && amb.error.includes('代码审查流') && amb.error.includes('代码发布流'));

    // 4) Apply user preset by unique substring + task override; verify .dsh/canvas/<sid>.json written
    const appliedUser = presetTool.execute({ action: 'apply', name: '发布流', task: '发 v1.7.0' }, { agent: { id: sid } });
    assert.equal(appliedUser.source, 'user');
    assert.equal(appliedUser.name, '代码发布流');
    assert.equal(appliedUser.enabled, true);
    assert.equal(appliedUser.delivered, true);
    const published = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', safeSessionFileBase(sid) + '.json'), 'utf8'));
    assert.equal(published.canvas.presetName, '代码发布流');
    assert.equal(published.canvas.direction, 'lr', 'user preset preserves its saved direction');
    assert.equal(published.canvas.enabled, true);
    assert.equal(published.canvas.nodes.find((n) => n.id === 'lead').task, '发 v1.7.0');
    assert.equal(Array.isArray(published.canvas.comments) && published.canvas.comments.length, 1, 'user preset preserves comments on UI canvasDoc');
    assert.equal(published.canvas.comments[0].title, '发布前检查');
    assert.equal(inspectPlan(sid).comments[0].title, '发布前检查', 'canvas_inspect surfaces preset comments for AI awareness');
    assert.equal(buildActiveCanvasContext(sid).includes('发布前检查'), false, 'active prompt context never dumps raw comment text');

    // 5) Toggle disabled in place (preserves nodes, publishes merge toggle)
    const disabledRes = presetTool.execute({ action: 'toggle', enabled: false }, { agent: { id: sid } });
    assert.equal(disabledRes.enabled, false);
    assert.equal(disabledRes.delivered, true);
    assert.equal(inspectPlan(sid).enabled, false);
    assert.equal(buildActiveCanvasContext(sid), '', 'disabled canvas injects empty context');
    const toggleDoc = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', safeSessionFileBase(sid) + '.json'), 'utf8'));
    assert.equal(toggleDoc.canvas.mode, 'merge');
    assert.equal(toggleDoc.canvas.nodes.length, 0);
    assert.equal(toggleDoc.canvas.enabled, false);

    // 6) Works even while disabled: apply built-in template by id (`tpl-cond`) and auto-enable
    const appliedBuiltin = presetTool.execute({ action: 'apply', name: 'tpl-cond' }, { agent: { id: sid } });
    assert.equal(appliedBuiltin.source, 'builtin');
    assert.equal(appliedBuiltin.enabled, true);
    assert.equal(inspectPlan(sid).enabled, true);
    assert.ok(inspectPlan(sid).nodes.some((n) => n.kind === 'condition'));
    const builtinPublished = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', safeSessionFileBase(sid) + '.json'), 'utf8'));
    assert.equal(builtinPublished.canvas.direction, undefined, 'built-in template omits direction so user lr/tb preference is respected');

    // 7) Guard: refuses switching preset or disabling while paused at an intermediate Lead gate
    const syncPaused = encodeURIComponent(JSON.stringify({
      enabled: true,
      plan: {
        task: '暂停保护测试',
        nodes: [
          { id: 'a', kind: 'agent', label: 'A', role: 'r1' },
          { id: 'l1', kind: 'lead', label: '拍板', role: 'confirm' },
          { id: 'b', kind: 'agent', label: 'B', role: 'r2' },
        ],
        edges: [
          { from: 'lead', to: 'a', type: 'prompt' },
          { from: 'a', to: 'l1', type: 'prompt' },
          { from: 'l1', to: 'b', type: 'prompt' },
        ],
      },
    }));
    syncCmd.handler({ agent: { id: sid }, rawInput: syncPaused });
    const paused = await wfTool.execute({}, { agent: { id: sid }, signal: new AbortController().signal });
    assert.equal(paused.status, 'need-lead');
    assert.ok(handleCanvasPreset(null, sid, { action: 'apply', name: 'tpl-swe' }).error.includes('待拍板'));
    assert.ok(handleCanvasPreset(null, sid, { action: 'toggle', enabled: false }).error.includes('待拍板'));
    syncPresetsCatalog({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI comment round-trip (#15 V2): /canvas-sync, canvas_inspect, canvas_generate & canvas_patch with semantic nodeIds and minimal context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-comments-'));
  try {
    const commands = new Map();
    const tools = new Map();
    const fakeCtx = {
      inject(_names, fn) {
        const scope = {
          effect: (cb) => cb(),
          commands: { register: (c) => { commands.set(c.name, c); return () => {}; } },
          tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
          sessions: { get: () => ({ header: { cwd: dir } }) },
          subagents: {},
        };
        fn(scope);
      },
    };
    apply(fakeCtx);
    const syncCmd = commands.get('canvas-sync');
    const inspectTool = tools.get('canvas_inspect');
    const genTool = tools.get('canvas_generate');
    const patchTool = tools.get('canvas_patch');
    const sid = 's-cm-v2-' + Date.now();

    // 1) Client syncs canvas with a comment box via /canvas-sync
    const syncPayload = encodeURIComponent(JSON.stringify({
      enabled: true,
      plan: {
        task: '注释感知测试',
        nodes: [
          { id: 'scan', kind: 'agent', label: '扫描', role: 'scan repo' },
          { id: 'fix', kind: 'agent', label: '修复', role: 'apply fix' },
        ],
        edges: [
          { from: 'lead', to: 'scan', type: 'prompt' },
          { from: 'scan', to: 'fix', type: 'prompt' },
        ],
      },
      comments: [
        { id: 'cm-user', title: '调研段', body: '只读不改文件', color: 'blue', nodeIds: ['scan'] },
      ],
    }));
    assert.equal(syncCmd.handler({ agent: { id: sid }, rawInput: syncPayload }).kind, 'success');

    // Active context stays ultra-compact (just "注释 ×1", never dumping comment bodies)
    const activeCtx = buildActiveCanvasContext(sid);
    assert.ok(activeCtx.includes('注释 ×1'), 'active context hints comment count');
    assert.equal(activeCtx.includes('只读不改文件'), false, 'active context never dumps raw comment body into every turn');

    // 2) canvas_inspect exposes full comment details + renders readable list
    const insp = inspectTool.execute({}, { agent: { id: sid } });
    assert.equal(insp.comments.length, 1);
    assert.equal(insp.comments[0].id, 'cm-user');
    assert.deepEqual(insp.comments[0].nodeIds, ['scan']);
    const inspText = inspectTool.output.render({}, insp)[0].text;
    assert.ok(inspText.includes('注释（1）') && inspText.includes('调研段') && inspText.includes('包裹: scan'));

    // 3) canvas_patch updates existing comment, adds a new comment, removes none -> publishes merge patch
    const patched = patchTool.execute({
      comments: [
        { id: 'cm-user', title: '调研与分析', color: 'green' },
        { id: 'cm-fix', title: '修复段', body: '跑完单测再交付', color: 'amber', nodeIds: ['fix'] },
      ],
    }, { agent: { id: sid } });
    assert.equal(patched.delivered, true);
    assert.ok(patched.summary.includes('更新注释 2 条'));
    const patchFile = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', safeSessionFileBase(sid) + '.json'), 'utf8'));
    assert.equal(patchFile.canvas.mode, 'merge');
    assert.equal(patchFile.canvas.comments.length, 2);
    assert.equal(inspectPlan(sid).comments.length, 2);

    // 4) canvas_patch removes one comment
    const removedRes = patchTool.execute({ removeComments: ['cm-user'] }, { agent: { id: sid } });
    assert.ok(removedRes.summary.includes('删除注释 1 条'));
    assert.equal(inspectPlan(sid).comments.length, 1);
    assert.equal(inspectPlan(sid).comments[0].id, 'cm-fix');

    // 5) canvas_generate supports semantic nodeIds comments and computes bounding boxes
    const genRes = genTool.execute({
      task: '带注释生成',
      nodes: [
        { id: 'entry_lead', ref: 'r0', kind: 'lead', label: '入口', task: '总控' },
        { id: 'a', kind: 'agent', label: 'A', role: 'r1' },
        { id: 'b', kind: 'agent', label: 'B', role: 'r2' },
      ],
      edges: [
        { from: 'entry_lead', to: 'a', type: 'prompt' },
        { from: 'a', to: 'b', type: 'prompt' },
      ],
      comments: [
        { id: 'cm-gen', title: '核心流水线', body: '顺序执行', color: 'purple', nodeIds: ['entry_lead', 'a', 'b'] },
        { id: 'cm-2', title: '显式ID', color: 'gray' },
        { title: '自动ID不撞车', color: 'green' },
      ],
    }, { agent: { id: sid } });
    assert.equal(genRes.delivered, true);
    assert.equal(genRes.canvas.comments.length, 3, 'auto-generated comment id never collides with explicit cm-2');
    assert.equal(genRes.canvas.comments[0].title, '核心流水线');
    assert.deepEqual(genRes.canvas.comments[0].nodeIds, ['lead', 'a', 'b'], 'promoted rootLead id remaps inside comment.nodeIds');
    assert.ok(typeof genRes.canvas.comments[0].x === 'number' && genRes.canvas.comments[0].w >= 180);
    assert.equal(inspectPlan(sid).comments[0].id, 'cm-gen');

    // 6) Metadata-only canvas_patch on existing comment does NOT send stale nodeIds or stale x/y/w/h
    const metaPatch = patchTool.execute({
      comments: [
        { id: 'cm-gen', title: '核心流水线（已改名）', color: 'blue' },
      ],
    }, { agent: { id: sid } });
    assert.equal(metaPatch.delivered, true);
    const metaDoc = JSON.parse(readFileSync(join(dir, '.dsh', 'canvas', safeSessionFileBase(sid) + '.json'), 'utf8'));
    assert.equal(metaDoc.canvas.comments[0].title, '核心流水线（已改名）');
    assert.equal(metaDoc.canvas.comments[0].nodeIds, undefined, 'metadata-only patch omits nodeIds so client preserves manual geometry');
    assert.equal(metaDoc.canvas.comments[0].x, undefined, 'metadata-only patch omits stale x/y');

    // 7) Same-ms auto-IDs never overwrite each other & removeComments+comments collision stays clean
    const multiAuto = patchTool.execute({
      comments: [
        { title: '便签1' },
        { title: '便签2' },
        { id: 'cm-temp', title: '即删' },
      ],
      removeComments: ['cm-temp', 'non-existent-id'],
    }, { agent: { id: sid } });
    assert.ok(multiAuto.summary.includes('更新注释 2 条') && !multiAuto.summary.includes('删除注释'), 'net-deleted brand-new comment and nonexistent id are not counted as removed');
    assert.equal(inspectPlan(sid).comments.length, 5);

    // 8) Removing node 'b' prunes 'b' out of untouched comment's nodeIds in canvas_inspect
    patchTool.execute({ removeNodes: ['b'] }, { agent: { id: sid } });
    assert.deepEqual(inspectPlan(sid).comments.find((c) => c.id === 'cm-gen').nodeIds, ['lead', 'a']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
