/**
 * Host half of the workflow-canvas bundle.
 *
 * The browser canvas owns editing. This half executes the canvas plan:
 *   - `canvas-sync` publishes the plan for its Session (client → Host);
 *   - the `canvas_workflow` tool runs the DAG in parallel waves. Subagent nodes
 *     are spawned through `ctx.subagents` (per-node model, reasoning effort and
 *     preset all work); a Lead node pauses the run and hands control back to the
 *     conversation, which resumes it with `leadResult`.
 *
 * Extra behavior, all optional per node:
 *   - `keepSession` re-uses the node's previous child session (memory);
 *   - `fallbackModel` retries a failed node once on another model;
 *   - plans survive a Host restart through a JSON file in the profile.
 *
 * Everything is defensive: a missing service disables one piece instead of
 * failing the plugin load.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Latest canvas payload per Session id. */
const canvasBySession = new Map();
/** In-flight run progress per Session id. */
const runBySession = new Map();
/** node id → child session id, so `keepSession` can resume previous work. */
const childByNode = new Map();
/** node id → child id created in this process, safe to resume. */
const liveChild = new Map();

function storePath() {
  const home = process.env.DSH_PROFILE_DIR;
  if (!home) return undefined;
  return join(home, '.workflow-canvas-state.json');
}

function loadStore() {
  const path = storePath();
  if (!path) return;
  try {
    const raw = readFileSync(path, 'utf8');
    const doc = JSON.parse(raw);
    if (doc && doc.canvas && typeof doc.canvas === 'object') {
      for (const [sid, payload] of Object.entries(doc.canvas)) canvasBySession.set(sid, payload);
    }
    if (doc && doc.children && typeof doc.children === 'object') {
      for (const [node, child] of Object.entries(doc.children)) childByNode.set(node, child);
    }
  } catch (_e) {
    /* no store yet, or unreadable: start clean */
  }
}

function saveStore() {
  const path = storePath();
  if (!path) return;
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      canvas: Object.fromEntries(canvasBySession),
      children: Object.fromEntries(childByNode),
    }), 'utf8');
  } catch (_e) {
    /* persistence is best-effort */
  }
}

function parsePayload(rawInput) {
  const text = String(rawInput || '').trim();
  if (!text) return { enabled: false };
  try {
    return JSON.parse(decodeURIComponent(text));
  } catch (_e) {
    return { enabled: false, error: '画布数据解析失败' };
  }
}

/** Kahn topological order over every plan node. */
function orderNodes(plan) {
  const nodes = plan.nodes || [];
  const edges = plan.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e.from === 'lead') continue;
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    indeg.set(e.to, indeg.get(e.to) + 1);
    adj.get(e.from).push(e.to);
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const out = [];
  while (queue.length) {
    const id = queue.shift();
    out.push(byId.get(id));
    for (const next of adj.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return out.length === nodes.length ? out : null;
}

function upstreamOf(plan, node) {
  const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
  return (plan.edges || [])
    .filter((e) => e.to === node.id)
    .map((e) => ({ edge: e, from: byId.get(e.from) }))
    .filter((x) => x.from);
}

function downstreamLabels(plan, node) {
  const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
  return (plan.edges || [])
    .filter((e) => e.from === node.id)
    .map((e) => (byId.get(e.to) || {}).label)
    .filter(Boolean);
}

function briefFor(plan, node, results) {
  const ups = upstreamOf(plan, node);
  const downs = downstreamLabels(plan, node);
  const head = [];
  head.push('【工作流节点】你在一个多步工作流里负责「' + node.label + '」这一步（子代理）。');
  if (ups.length === 0) head.push('【总任务】' + plan.task);
  head.push('【职责】' + (node.role || node.label));
  if (ups.length) head.push('【上游】' + ups.map((u) => u.from.label).join('、') + ' 已交付结果给你（见下文）。');
  head.push('【下游】' + (downs.length ? downs.join('、') + ' 会使用你的输出。' : '你是终点，结果会直接交付给用户。'));
  head.push('【要求】只完成你这一步；输出要能被下游直接使用，不要重复上游已完成的工作。');
  let text = head.join('\n') + '\n';
  for (const u of ups) {
    const value = results[u.from.label];
    text += '\n## 来自【' + u.from.label + '】(' + (u.edge.type || 'prompt') + ')\n'
      + (typeof value === 'string' ? value : '（没有结果）') + '\n';
  }
  return text;
}

function textOf(result) {
  const blocks = (result && result.output) || [];
  const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return text || '[' + ((result && result.stopReason) || 'no-output') + ']';
}

function failed(result) {
  const reason = result && result.stopReason;
  return reason !== undefined && reason !== 'completed';
}

async function spawnOnce(scope, plan, node, results, parent, signal, route) {
  const spec = {
    provider: 'spawn',
    label: node.label + '#' + node.id,
    prompt: [{ type: 'text', text: briefFor(plan, node, results) }],
    parent,
    signal,
    delivery: 'caller',
  };
  const agentOptions = {};
  const provider = (route && route.provider) || node.provider;
  const model = (route && route.model) || node.model;
  if (provider) agentOptions.provider = provider;
  if (model) agentOptions.model = model;
  if (node.reasoning) agentOptions.reasoningEffort = node.reasoning;
  if (Object.keys(agentOptions).length) spec.agentOptions = agentOptions;
  if (node.preset) spec.agentPreset = node.preset;

  const run = async (childId) => {
    const withChild = childId ? { ...spec, childId } : spec;
    const activation = await scope.subagents.startActivation(withChild);
    try {
      if (activation && activation.childId) childByNode.set(node.id, activation.childId);
      const result = await activation.result;
      return { ok: !failed(result), text: textOf(result), reason: result && result.stopReason };
    } finally {
      try { await activation.dispose(); } catch (_e) { /* ignore */ }
    }
  };

  // Reusing a previous child only works while that identity is still ours; a
  // stale one is dropped and the node starts fresh instead of failing.
  if (node.keepSession) {
    const previous = liveChild.get(node.id);
    if (previous) {
      try {
        return await run(previous);
      } catch (_e) {
        liveChild.delete(node.id);
      }
    }
  }
  const started = await run(undefined);
  if (node.keepSession && started.ok) {
    const current = childByNode.get(node.id);
    if (current) liveChild.set(node.id, current);
  }
  return started;
}

async function spawnNode(scope, plan, node, results, parent, signal) {
  const first = await spawnOnce(scope, plan, node, results, parent, signal, undefined);
  if (first.ok) return first.text;
  if (!node.fallbackModel && !node.fallbackProvider) {
    return first.text + '\n（失败原因：' + (first.reason || 'unknown') + '，未配置备用模型）';
  }
  const retry = await spawnOnce(scope, plan, node, results, parent, signal, {
    provider: node.fallbackProvider,
    model: node.fallbackModel,
  });
  if (retry.ok) return retry.text + '\n（已用备用模型重试成功）';
  return retry.text + '\n（重试仍失败：' + (retry.reason || 'unknown') + '）';
}

async function runPlan(scope, args, exec) {
  const agent = exec && exec.agent;
  const sid = agent && agent.id !== undefined ? String(agent.id) : '';
  const payload = sid ? canvasBySession.get(sid) : undefined;
  if (!payload) return { error: '当前会话还没有画布数据。请在右侧 Workflow 画布点「启用」。' };
  if (!payload.enabled) return { error: '画布当前是「已禁用」状态。请在画布上点「启用」后再运行。' };
  if (payload.error) return { error: String(payload.error) };
  const plan = payload.plan;
  if (!plan || !Array.isArray(plan.nodes) || !plan.nodes.length) {
    return { error: '画布没有可执行的节点。' };
  }

  const order = orderNodes(plan);
  if (!order) return { error: '存在环，无法执行有向无环图。' };

  // Defense in depth: unreachable nodes are skipped, never spawned.
  const reachable = new Set(['lead']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of plan.edges || []) {
      if (reachable.has(e.from) && !reachable.has(e.to)) { reachable.add(e.to); grew = true; }
    }
  }
  const runnable = order.filter((n) => reachable.has(n.id));
  const skipped = order.filter((n) => !reachable.has(n.id)).map((n) => n.label || n.id);
  if (!runnable.length) return { error: '没有从入口 Lead 连通的节点，无法执行。' };

  const sig = JSON.stringify(plan);
  let state = runBySession.get(sid);
  if (!state || state.sig !== sig) {
    state = { sig, done: new Set(), results: {} };
    runBySession.set(sid, state);
  }

  const byId = new Map(runnable.map((n) => [n.id, n]));
  const depsOf = (node) => (plan.edges || [])
    .filter((e) => e.to === node.id && e.from !== 'lead')
    .map((e) => e.from)
    .filter((id) => byId.has(id));

  let leadResult = typeof args.leadResult === 'string' ? args.leadResult : undefined;
  const MAX_PARALLEL = 4;

  for (;;) {
    const remaining = runnable.filter((n) => !state.done.has(n.id));
    if (!remaining.length) {
      runBySession.delete(sid);
      saveStore();
      return { status: 'done', results: state.results, skipped };
    }

    const ready = remaining.filter((n) => depsOf(n).every((id) => state.done.has(id)));
    if (!ready.length) return { error: '有节点的依赖无法满足（存在环或悬空依赖）。' };

    const agentReady = ready.filter((n) => n.kind !== 'lead');
    if (agentReady.length) {
      const batch = agentReady.slice(0, MAX_PARALLEL);
      const texts = await Promise.all(
        batch.map((node) => spawnNode(scope, plan, node, state.results, agent, exec.signal)),
      );
      batch.forEach((node, i) => {
        state.results[node.label] = texts[i];
        state.done.add(node.id);
      });
      continue;
    }

    const leadNode = ready.find((n) => n.kind === 'lead');
    if (!leadNode) return { error: '没有可执行的节点。' };
    if (leadResult === undefined) {
      return {
        status: 'need-lead',
        node: {
          label: leadNode.label,
          role: leadNode.role || leadNode.label,
          needs: depsOf(leadNode).map((id) => byId.get(id).label),
        },
        results: state.results,
        hint: '这一步由你（Lead 本体）完成。完成后再次调用本工具，把结果放进 leadResult 继续。',
      };
    }
    state.results[leadNode.label] = leadResult;
    state.done.add(leadNode.id);
    leadResult = undefined;
  }
}

export function apply(ctx) {
  loadStore();
  try {
    ctx.inject(['commands'], (scope) => {
      try {
        scope.effect(() => scope.commands.register({
          name: 'canvas-sync',
          description: 'Publish the workflow canvas plan for this session.',
          recordInput: false,
          handler: ({ agent, rawInput }) => {
            try {
              const id = agent && agent.id !== undefined ? String(agent.id) : '';
              if (!id) return { kind: 'error', text: 'no session' };
              canvasBySession.set(id, parsePayload(rawInput));
              runBySession.delete(id);
              saveStore();
              return { kind: 'success', text: 'canvas synced' };
            } catch (error) {
              return { kind: 'error', text: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: sync command');
      } catch (_e) {
        /* command registry unavailable */
      }
    });

    ctx.inject(['tools', 'subagents'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_workflow',
          description: 'Run the workflow canvas of the current session. Executes subagent nodes in parallel waves; when a Lead node is reached it returns status "need-lead" and expects a follow-up call carrying leadResult.',
          parameters: {
            type: 'object',
            properties: {
              leadResult: { type: 'string', description: 'Your own output for the Lead step that was just requested.' },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                node: { type: 'object' },
                results: { type: 'object' },
                skipped: { type: 'array' },
                hint: { type: 'string' },
                error: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const v = value || {};
              if (typeof v.error === 'string') return [{ type: 'text', text: v.error }];
              const results = v.results || {};
              const blocks = Object.keys(results).map((label) => {
                const text = typeof results[label] === 'string' ? results[label] : JSON.stringify(results[label]);
                return '## ' + label + '\n' + text;
              });
              const body = blocks.length ? blocks.join('\n\n') : '（暂无上游结果）';
              if (v.status === 'need-lead') {
                const n = v.node || {};
                return [{
                  type: 'text',
                  text: '需要你（Lead）完成「' + n.label + '」：' + n.role
                    + '\n需要用到：' + ((n.needs && n.needs.length) ? n.needs.join('、') : '（无上游）')
                    + '\n\n已完成节点的结果：\n' + body
                    + '\n\n' + (v.hint || ''),
                }];
              }
              if (v.status === 'done') {
                const skip = Array.isArray(v.skipped) && v.skipped.length
                  ? '\n\n已跳过（未连线）：' + v.skipped.join('、')
                  : '';
                return [{ type: 'text', text: '画布执行完成。\n\n' + body + skip }];
              }
              return [{ type: 'text', text: JSON.stringify(v) }];
            },
          },
          execute: (args, exec) => runPlan(scope, args || {}, exec),
        }), 'workflow-canvas: run tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });
  } catch (_e) {
    /* never fail the plugin load because of the bridge */
  }
}
