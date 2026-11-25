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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_LOOP_ITERATIONS,
  DEFAULT_LOOP_ITERATIONS,
  MAX_GLOBAL_LOOPS,
  withoutEntry,
  parsePayload,
  normalizeMaxIterations,
  isLoopEdge,
  forwardEdgesOf,
  loopMemberIds,
  orderNodes,
  upstreamOf,
  downstreamLabels,
  normalizeKind,
  normalizeRefs,
  normalizeBranch,
  normalizeBranches,
  conditionBranches,
  edgeKey,
  extractJsonObjects,
  parseStrictJsonObject,
  parseStrictConditionJson,
  parseConditionDecision,
  clipSafeSlice,
  clipUpstreamOutput,
  briefFor,
  extractResultError,
  textOf,
  failed,
  isEmptyOutput,
  buildLoopWarmPrompt,
  formatModelLabel,
  isPermissionFailure,
  isTransientFailure,
  reachableFrom,
  inactiveNodeSets,
  validateLoopEdges,
  analyzeCanvasWarnings,
  normalizeCanvas,
  applyPatch,
} from './lib/graph.js';
import {
  MAX_STORED_SESSIONS,
  MAX_LAST_RUNS,
  MAX_CHILD_SLOTS,
  safeSessionFileBase,
  writeFileAtomic,
  pruneMapLRU,
  touchMapLRU,
  cleanupStaleCanvasFiles,
  buildRunSummarySnapshot,
} from './lib/telemetry.js';
import {
  MAX_STORED_PRESETS,
  BUILTIN_TEMPLATES,
  sanitizePresetCatalog,
  summarizePresetNodes,
  resolvePresetByName,
  presetToPlanAndCanvas,
} from './lib/presets.js';

/** Latest canvas payload per Session id (LRU-bounded). */
const canvasBySession = new Map();
/** Profile-wide user workflow presets synced from the canvas client (`name -> { nodes, edges, direction }`). */
const presetsByName = new Map();
/** Read a session canvas and refresh its LRU recency so active old sessions are never evicted. */
function getCanvasLRU(sid) {
  if (!sid) return undefined;
  const key = String(sid);
  if (!canvasBySession.has(key)) return undefined;
  const val = canvasBySession.get(key);
  canvasBySession.delete(key);
  canvasBySession.set(key, val);
  return val;
}
/** In-flight run progress per Session id. */
const runBySession = new Map();
/** Live AbortController & active child session ids per executing Session id. */
const activeRunBySession = new Map();
/** Snapshot of the last completed/halted run per Session id (LRU-bounded; enables partial retry). */
const lastRunBySession = new Map();
/**
 * Two separate maps by design:
 *   - `childByNode`: persisted memory slot written ONLY when `keepSession` is ON,
 *     so temporary `keepSession=false` runs never overwrite saved memory.
 *   - `liveChild`: latest child id in this process (updated even when Memory is OFF)
 *     so downstream `session-ref` purple links can always continue the upstream run.
 */
const childByNode = new Map();
const liveChild = new Map();
let lastSavedStorePath = '';
let lastSavedStoreJson = '';

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
      for (const [sid, payload] of Object.entries(doc.canvas)) {
        touchMapLRU(canvasBySession, sid, payload, MAX_STORED_SESSIONS);
      }
    }
    if (doc && doc.children && typeof doc.children === 'object') {
      for (const [node, child] of Object.entries(doc.children)) {
        touchMapLRU(childByNode, node, child, MAX_CHILD_SLOTS);
      }
    }
    if (doc && doc.presets && typeof doc.presets === 'object') {
      const cleanPresets = sanitizePresetCatalog(doc.presets);
      presetsByName.clear();
      for (const [name, preset] of Object.entries(cleanPresets)) {
        touchMapLRU(presetsByName, name, preset, MAX_STORED_PRESETS);
      }
    }
    lastSavedStorePath = path;
    lastSavedStoreJson = raw;
  } catch (_e) {
    /* no store yet, or unreadable: start clean */
  }
}

function saveStore() {
  const path = storePath();
  if (!path) return;
  try {
    pruneMapLRU(canvasBySession, MAX_STORED_SESSIONS);
    pruneMapLRU(childByNode, MAX_CHILD_SLOTS);
    pruneMapLRU(presetsByName, MAX_STORED_PRESETS);
    const json = JSON.stringify({
      canvas: Object.fromEntries(canvasBySession),
      children: Object.fromEntries(childByNode),
      presets: Object.fromEntries(presetsByName),
    });
    if (path === lastSavedStorePath && json === lastSavedStoreJson) return;
    writeFileAtomic(path, json);
    lastSavedStorePath = path;
    lastSavedStoreJson = json;
  } catch (_e) {
    /* persistence is best-effort */
  }
}

/** Abort-aware backoff delay for safe read-only transient retries. */
function delayWithSignal(ms, signal) {
  const wait = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (wait <= 0 || (signal && signal.aborted)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', finish); } catch (_e) { /* ignore */ }
      }
      resolve();
    };
    const timer = setTimeout(finish, wait);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', finish, { once: true });
    }
  });
}

async function spawnOnce(scope, plan, node, results, parent, signal, route, forcedChild, sid, failedMap, prunedSet, loopCtx, activeRec) {
  const childKey = (id) => String(sid || '') + '::' + id;
  const isCondition = node.kind === 'condition';
  const fullBrief = briefFor(plan, node, results, failedMap, prunedSet, loopCtx);
  const warmPrompt = (!isCondition && loopCtx && loopCtx.warmChildId && loopCtx.feedback)
    ? buildLoopWarmPrompt(node, loopCtx)
    : null;
  const spec = {
    provider: 'spawn',
    label: node.label + '#' + node.id,
    prompt: [{ type: 'text', text: fullBrief }],
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
  const allowSchema = !(route && route.noSchema);
  const wantsStructured = !isCondition && (Boolean(node.structured)
    || (plan.edges || []).some((e) => e.from === node.id && e.type === 'structured'));
  if (isCondition) {
    const { branches, isDefaultBinary, multiMatch } = conditionBranches(node);
    spec.agentPreset = 'minimal';
    if (allowSchema) {
      spec.outputSchema = isDefaultBinary
        ? {
            type: 'object',
            properties: {
              pass: { type: 'boolean', description: 'true to follow the Yes/Pass branch, false to follow the No/Fail branch.' },
              reason: { type: 'string', description: 'Concise one-sentence explanation for this routing decision.' },
            },
            required: ['pass', 'reason'],
            additionalProperties: false,
          }
        : {
            type: 'object',
            properties: {
              branches: {
                type: 'array',
                items: { type: 'string', enum: branches.map((b) => b.id) },
                description: multiMatch
                  ? 'All matching branch ids to execute in parallel (empty array if none match).'
                  : 'At most one best-matching branch id (empty array if none match).',
              },
              reason: { type: 'string', description: 'Concise one-sentence explanation for this routing decision.' },
            },
            required: ['branches', 'reason'],
            additionalProperties: false,
          };
    }
  } else {
    if (node.preset) spec.agentPreset = node.preset;
    if (wantsStructured && allowSchema) {
      spec.outputSchema = {
        type: 'object',
        additionalProperties: true,
        description: 'Return the result as a JSON object so downstream steps can consume it.',
      };
    }
  }

  const run = async (childId, overridePrompt) => {
    // Guard before every activation so an interrupted run can never spawn fresh/fallback zombies.
    if (signal && signal.aborted) {
      return { ok: false, empty: false, reason: 'aborted', text: '已取消', childId: '' };
    }
    const baseSpec = overridePrompt
      ? { ...spec, prompt: [{ type: 'text', text: overridePrompt }] }
      : spec;
    const withChild = childId ? { ...baseSpec, childId } : baseSpec;
    let activation;
    try {
      activation = await scope.subagents.startActivation(withChild);
    } catch (error) {
      const message = String((error && error.message) || error);
      return { ok: false, text: '启动失败：' + message, reason: 'activation-failed', errorDetail: message };
    }
    let trackedCid = '';
    try {
      const cid = activation && activation.childId ? String(activation.childId) : '';
      // If cancellation fired while `startActivation` was pending, interrupt this child
      // immediately and skip updating memory/live slots so no zombie child can escape.
      if (signal && signal.aborted) {
        if (cid && scope && scope.subagents && typeof scope.subagents.interrupt === 'function') {
          try { scope.subagents.interrupt(cid, { kind: 'user' }); } catch (_e) { /* best-effort */ }
        }
        return { ok: false, empty: false, reason: 'aborted', text: '已取消', childId: '' };
      }
      if (cid) {
        trackedCid = cid;
        touchMapLRU(liveChild, childKey(node.id), cid, MAX_CHILD_SLOTS);
        // Only overwrite the persisted memory slot when Memory is ON, so a
        // temporary keepSession=false experiment never destroys saved memory.
        if (node.keepSession) touchMapLRU(childByNode, childKey(node.id), cid, MAX_CHILD_SLOTS);
        if (activeRec && activeRec.childIds) activeRec.childIds.add(cid);
      }
      let result;
      try {
        result = await activation.result;
      } catch (error) {
        const message = String((error && error.message) || error);
        return { ok: false, text: '运行失败：' + message, reason: 'run-failed', errorDetail: message };
      }
      const outText = textOf(result);
      const errDetail = extractResultError(result);
      // DSH 0.2.2 implements `outputSchema` via a `structured_output` tool; if a child
      // completes with valid JSON text without calling the tool, DSH rewrites
      // `completed -> error` with no `diagnostic`. Rescue strict JSON verdicts/objects
      // directly on attempt #1 instead of burning a second LLM roundtrip or re-running
      // a writable standard node.
      const isRewriteCandidate = Boolean(
        result && result.stopReason === 'error' && !errDetail && result.structured === undefined,
      );
      const rescuedDecision = (isCondition && isRewriteCandidate)
        ? parseStrictConditionJson(outText, node)
        : null;
      const rescuedStructured = (!isCondition && wantsStructured && allowSchema && isRewriteCandidate)
        ? parseStrictJsonObject(outText)
        : null;
      const rescued = Boolean(rescuedDecision || rescuedStructured);
      const finalText = rescuedStructured ? JSON.stringify(rescuedStructured) : outText;
      const outcome = {
        ok: rescued ? true : !failed(result),
        text: finalText,
        reason: rescued ? 'completed' : (result && result.stopReason),
        errorDetail: errDetail,
        empty: rescued ? false : isEmptyOutput(result),
        childId: cid,
      };
      if (isCondition) {
        outcome.decision = rescuedDecision || parseConditionDecision(result, outText, node);
      }
      return outcome;
    } finally {
      if (trackedCid && activeRec && activeRec.childIds) {
        activeRec.childIds.delete(trackedCid);
      }
      try { await activation.dispose(); } catch (_e) { /* ignore */ }
    }
  };

  // On a controlled loop retry where the previous run of this node was healthy,
  // resume its warm child session with a concise incremental correction prompt.
  if (warmPrompt && loopCtx && loopCtx.warmChildId && !forcedChild) {
    const continued = await run(loopCtx.warmChildId, warmPrompt);
    if (signal && signal.aborted) return continued;
    if (continued.ok) {
      touchMapLRU(liveChild, childKey(node.id), continued.childId || loopCtx.warmChildId, MAX_CHILD_SLOTS);
      return { ...continued, warmReused: true };
    }
    if (continued.reason !== 'activation-failed') {
      return continued;
    }
    /* warm session refused: fall through to a fresh session with the full brief + feedback */
  }

  // A `session` edge means "continue the upstream node's conversation": run this
  // step inside that child session instead of starting a fresh one.
  if (forcedChild) {
    const continued = await run(forcedChild);
    if (signal && signal.aborted) return continued;
    if (continued.ok) {
      touchMapLRU(liveChild, childKey(node.id), continued.childId || forcedChild, MAX_CHILD_SLOTS);
      return { ...continued, sessionContinued: true };
    }
    if (continued.reason !== 'activation-failed') {
      return continued;
    }
    /* activation refused (e.g. cold session gone): fall through to a fresh session */
  }

  // Memory: prefer an explicitly pinned `memoryChildId` from the node dropdown,
  // then the saved memory slot (`childByNode`), then this process's live child.
  // A cold resume that the Host refuses falls through to a fresh session.
  if (node.keepSession) {
    const pinned = typeof node.memoryChildId === 'string' ? node.memoryChildId.trim() : '';
    const saved = childByNode.get(childKey(node.id));
    const inProcess = liveChild.get(childKey(node.id));
    const previous = pinned || saved || inProcess;
    if (previous) {
      const resumed = await run(previous);
      if (signal && signal.aborted) return resumed;
      if (resumed.ok) return resumed;
      if (resumed.reason === 'activation-failed') {
        if (previous === inProcess) liveChild.delete(childKey(node.id));
        if (previous === saved) childByNode.delete(childKey(node.id));
      } else {
        return resumed;
      }
    }
  }
  const started = await run(undefined);
  if (node.keepSession && started.ok) {
    const current = childByNode.get(childKey(node.id));
    if (current) touchMapLRU(liveChild, childKey(node.id), current, MAX_CHILD_SLOTS);
  }
  return started;
}

const NO_SCHEMA_RETRY_REASONS = new Set(['', 'error', 'run-failed']);

async function spawnNode(scope, plan, node, results, parent, signal, sid, failedMap, prunedSet, loopCtx, activeRec) {
  const primaryModel = formatModelLabel(node.provider, node.model);
  if (signal && signal.aborted) {
    return { ok: false, empty: false, reason: 'aborted', text: '已取消', childId: '', modelUsed: primaryModel, fallbackUsed: false, sessionContinued: false };
  }
  const continueFrom = forwardEdgesOf(plan.edges || [])
    .filter((e) => e.to === node.id && e.type === 'session-ref' && !(prunedSet && prunedSet.has(e.from)))
    .map((e) => liveChild.get(String(sid || '') + '::' + e.from)
      || childByNode.get(String(sid || '') + '::' + e.from))
    .find((id) => typeof id === 'string');

  // Single primary attempt (continuing upstream session if `continueFrom` is available,
  // with cold-session fallback handled inside `spawnOnce` — never double-running primary).
  let first = await spawnOnce(scope, plan, node, results, parent, signal, undefined, continueFrom || undefined, sid, failedMap, prunedSet, loopCtx, activeRec);
  if (signal && signal.aborted) return first;
  // Safe single transient-error backoff retry strictly for read-only nodes (`minimal` / `condition`)
  // on post-start transient failures (429/502/503/504/timeout). Never auto-retry writable standard
  // agents (which may have side effects) or `activation-failed` (which feeds the circuit breaker).
  const isReadOnly = node.kind === 'condition' || node.preset === 'minimal';
  let transientRetried = false;
  if (!first.ok && isReadOnly && first.reason !== 'activation-failed' && first.reason !== 'aborted' && isTransientFailure(first)) {
    transientRetried = true;
    const retryDelayMs = typeof plan.__transientDelayMs === 'number' ? plan.__transientDelayMs : 600;
    await delayWithSignal(retryDelayMs, signal);
    if (signal && signal.aborted) {
      return { ok: false, empty: false, reason: 'aborted', text: '已取消', childId: first.childId || '', modelUsed: primaryModel, fallbackUsed: false, sessionContinued: false };
    }
    const transientRetry = await spawnOnce(scope, plan, node, results, parent, signal, undefined, undefined, sid, failedMap, prunedSet, loopCtx, activeRec);
    if (signal && signal.aborted) return transientRetry;
    if (transientRetry.ok || transientRetry.errorDetail || !first.errorDetail) {
      first = transientRetry;
    }
  }
  // Many models/proxies reject strict `outputSchema` (`json_schema`) with stopReason='error'.
  // Retry once without outputSchema strictly on read-only nodes (never re-run writable standard
  // agents, and never retry `max-tokens` / `refusal` / `aborted` / `activation-failed`).
  const usedSchema = node.kind === 'condition'
    || Boolean(node.structured)
    || (plan.edges || []).some((e) => e.from === node.id && e.type === 'structured');
  const firstReason = typeof first.reason === 'string' ? first.reason : '';
  if (!first.ok && !transientRetried && isReadOnly && usedSchema && NO_SCHEMA_RETRY_REASONS.has(firstReason) && !isPermissionFailure(first)) {
    const plainRetry = await spawnOnce(scope, plan, node, results, parent, signal, { noSchema: true }, undefined, sid, failedMap, prunedSet, loopCtx, activeRec);
    if (signal && signal.aborted) return plainRetry;
    if (plainRetry.ok) {
      first = plainRetry;
    } else if (plainRetry.errorDetail && !first.errorDetail) {
      first = plainRetry;
    }
  }
  if (first.ok) {
    const continuedUpstream = Boolean(first.sessionContinued);
    const out = {
      ok: true,
      empty: Boolean(first.empty),
      text: continuedUpstream ? (first.text + '\n（已在上游会话中继续）') : first.text,
      childId: first.childId || (continuedUpstream ? continueFrom : '') || '',
      modelUsed: primaryModel,
      fallbackUsed: false,
      sessionContinued: continuedUpstream || Boolean(first.warmReused),
    };
    if (first.decision) out.decision = first.decision;
    return out;
  }
  if (!node.fallbackModel && !node.fallbackProvider) {
    const reason = first.reason || 'unknown';
    const detail = first.errorDetail || '';
    const modelTag = primaryModel ? ('模型 ' + primaryModel) : '默认模型';
    const suffix = detail ? (reason + ' — ' + detail) : reason;
    return {
      ok: false,
      empty: false,
      reason,
      errorDetail: detail,
      text: first.text + '\n（' + modelTag + ' 执行失败：' + suffix + '）',
      childId: first.childId || '',
      modelUsed: primaryModel,
      fallbackUsed: false,
      sessionContinued: false,
    };
  }
  const fallbackLabel = formatModelLabel(node.fallbackProvider || node.provider, node.fallbackModel || node.model);
  let retry = await spawnOnce(scope, plan, node, results, parent, signal, {
    provider: node.fallbackProvider,
    model: node.fallbackModel,
  }, undefined, sid, failedMap, prunedSet, loopCtx, activeRec);
  if (signal && signal.aborted) return retry;
  const retryReason = typeof retry.reason === 'string' ? retry.reason : '';
  if (!retry.ok && isReadOnly && usedSchema && NO_SCHEMA_RETRY_REASONS.has(retryReason) && !isPermissionFailure(retry)) {
    const plainFallback = await spawnOnce(scope, plan, node, results, parent, signal, {
      provider: node.fallbackProvider,
      model: node.fallbackModel,
      noSchema: true,
    }, undefined, sid, failedMap, prunedSet, loopCtx, activeRec);
    if (signal && signal.aborted) return plainFallback;
    if (plainFallback.ok || (plainFallback.errorDetail && !retry.errorDetail)) retry = plainFallback;
  }
  if (retry.ok) {
    const out = {
      ok: true,
      empty: Boolean(retry.empty),
      text: retry.text + '\n（已用备用模型重试成功）',
      childId: retry.childId || '',
      modelUsed: fallbackLabel,
      fallbackUsed: true,
      sessionContinued: Boolean(retry.warmReused),
    };
    if (retry.decision) out.decision = retry.decision;
    return out;
  }
  const reason = retry.reason || 'unknown';
  const retryDetail = retry.errorDetail || '';
  const suffix = retryDetail ? (reason + ' — ' + retryDetail) : reason;
  return {
    ok: false,
    empty: false,
    reason,
    errorDetail: retryDetail,
    text: retry.text + '\n（备用模型 ' + (fallbackLabel || '默认') + ' 重试仍失败：' + suffix + '）',
    childId: retry.childId || first.childId || '',
    modelUsed: fallbackLabel,
    fallbackUsed: true,
    sessionContinued: false,
  };
}

/**
 * Drop a generated canvas where the browser can pick it up. `workspaceFiles`
 * resolves a session's root from its header cwd, so the client reads the same
 * relative path back through the Remote.
 */
/** Resolve a Cordis service safely: prefer `scope.get(name)` so uncommitted services return undefined instead of throwing. */
function resolveService(scope, name) {
  if (!scope) return null;
  if (typeof scope.get === 'function') {
    try {
      const viaGet = scope.get(name);
      if (viaGet) return viaGet;
    } catch (_e) { /* fall through */ }
  }
  try {
    return scope[name] || null;
  } catch (_e) {
    return null;
  }
}

function resolveSessionsService(scope) {
  return resolveService(scope, 'sessions');
}

function activeCanvasIds(extraId) {
  const ids = new Set();
  for (const k of runBySession.keys()) {
    const safe = safeSessionFileBase(k);
    if (safe) ids.add(safe);
  }
  const extraSafe = safeSessionFileBase(extraId);
  if (extraSafe) ids.add(extraSafe);
  return ids;
}

let lastPublishCanvasAt = 0;

function publishCanvas(scope, sessionId, canvas) {
  try {
    const safeId = safeSessionFileBase(sessionId);
    if (!safeId) return false;
    const sessionsSvc = resolveSessionsService(scope);
    const live = sessionsSvc && typeof sessionsSvc.get === 'function' ? sessionsSvc.get(sessionId) : null;
    const root = live && live.header && live.header.cwd;
    if (!root) return false;
    const dir = join(root, '.dsh', 'canvas');
    // Monotonic timestamp so back-to-back generate + patch within 1ms never share the same `at`.
    lastPublishCanvasAt = Math.max(Date.now(), lastPublishCanvasAt + 1);
    writeFileAtomic(join(dir, safeId + '.json'), JSON.stringify({ canvas, at: lastPublishCanvasAt }));
    cleanupStaleCanvasFiles(dir, { activeIds: activeCanvasIds(sessionId) });
    return true;
  } catch (_e) {
    return false;
  }
}

/** Bound per-decision reason text inside `.run.json` so huge error dumps never bloat telemetry writes. */
function compactDecisionsForTelemetry(decisions) {
  if (!decisions || typeof decisions !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(decisions)) {
    if (!v || typeof v !== 'object') { out[k] = v; continue; }
    const reason = typeof v.reason === 'string' && v.reason.length > 1000
      ? clipSafeSlice(v.reason, 999, '…')
      : v.reason;
    out[k] = reason === v.reason ? v : { ...v, reason };
  }
  return out;
}

/**
 * Publish live run-state telemetry (condition decisions, pruned nodes, blocked edges,
 * waitingLead, and zero-token run summary) to `.dsh/canvas/<sessionId>.run.json` so
 * the sidebar canvas can visualize branch routing and execution metrics without touching
 * the canvas definition file or injecting anything into model prompts.
 */
function publishRunState(scope, sessionId, runState) {
  try {
    const safeId = safeSessionFileBase(sessionId);
    if (!safeId) return false;
    const sessionsSvc = resolveSessionsService(scope);
    const live = sessionsSvc && typeof sessionsSvc.get === 'function' ? sessionsSvc.get(sessionId) : null;
    const root = live && live.header && live.header.cwd;
    if (!root) return false;
    const dir = join(root, '.dsh', 'canvas');
    const payload = { ...(runState || {}), at: Date.now() };
    if (payload.decisions) payload.decisions = compactDecisionsForTelemetry(payload.decisions);
    writeFileAtomic(join(dir, safeId + '.run.json'), JSON.stringify(payload));
    cleanupStaleCanvasFiles(dir, { activeIds: activeCanvasIds(sessionId) });
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Force-stop any running or paused (waitingLead) workflow for `sessionId`.
 * Uses DSH 0.2.2 native APIs:
 *   - `scope.subagents.interrupt(childId, { kind: 'user' })` for each live child
 *   - `scope.subagents.drainDescendants([rootAgent])` to tear down the full subtree
 *   - `rootAgent.cancel({ kind: 'user' }, { keepInbox: true })` when a turn is active (`status === 'running'`)
 * Also aborts our local `AbortController`, preserves partial progress in `lastRunBySession`,
 * clears `runBySession` (`waitingLead`), and writes `halted` / `idle` to `.run.json`.
 */
function abortSessionRun(scope, sessionId, rootAgent, opts) {
  const sid = sessionId !== undefined && sessionId !== null ? String(sessionId) : '';
  if (!sid) return { stopped: false, wasRunning: false, wasWaiting: false };
  const allowCancelRoot = !(opts && opts.cancelRootTurn === false);

  const active = activeRunBySession.get(sid);
  const wasRunning = Boolean(active);
  const childIds = active && active.childIds ? Array.from(active.childIds) : [];
  if (active) {
    try { active.ctrl.abort('user-stop'); } catch (_e) { /* ignore */ }
    activeRunBySession.delete(sid);
  }

  // Interrupt every tracked live child immediately via DSH's native subagents.interrupt API.
  const subagents = resolveService(scope, 'subagents');
  if (subagents && typeof subagents.interrupt === 'function') {
    for (const cid of childIds) {
      try { subagents.interrupt(cid, { kind: 'user' }); } catch (_e) { /* best-effort */ }
    }
  }

  // Resolve the exact root Agent (from command invocation or `scope.agents.get(sid)`)
  // to drain the entire descendant subagent tree and cancel any active root turn.
  let targetAgent = rootAgent || null;
  if (!targetAgent) {
    const agentsSvc = resolveService(scope, 'agents');
    if (agentsSvc && typeof agentsSvc.get === 'function') {
      try { targetAgent = agentsSvc.get(sid) || null; } catch (_e) { targetAgent = null; }
    }
  }
  if (targetAgent) {
    if (subagents && typeof subagents.drainDescendants === 'function') {
      try {
        // Fire-and-forget teardown so `/canvas-stop` returns immediately to the UI even if a remote provider stalls.
        Promise.resolve(subagents.drainDescendants([targetAgent])).catch(() => {});
      } catch (_e) { /* best-effort */ }
    }
    const agentActive = targetAgent.status === 'running' || Boolean(targetAgent.running);
    if (allowCancelRoot && (wasRunning || agentActive) && typeof targetAgent.cancel === 'function') {
      try { targetAgent.cancel({ kind: 'user' }, { keepInbox: true }); } catch (_e) { /* best-effort */ }
    }
  }

  const st = runBySession.get(sid);
  const wasWaiting = Boolean(st && st.waitingLead);
  if (st) {
    const haltNow = Date.now();
    st.endedAt = haltNow;
    st.haltedReason = wasWaiting ? '用户结束了等待拍板状态' : '用户主动终止';
    if (st.done && st.done.size > 0) {
      touchMapLRU(lastRunBySession, sid, {
        sig: st.sig,
        done: new Set(st.done),
        results: { ...(st.results || {}) },
        labels: { ...(st.labels || {}) },
        failed: { ...(st.failed || {}) },
        emptyOutputs: { ...(st.emptyOutputs || {}) },
        blockedEdges: new Set(st.blockedEdges || []),
        pruned: new Set(st.pruned || []),
        decisions: { ...(st.decisions || {}) },
        fallbackLinks: Array.isArray(st.fallbackLinks) ? st.fallbackLinks.map((fl) => ({ ...fl })) : [],
        nodeStats: st.nodeStats ? Object.fromEntries(Object.entries(st.nodeStats).map(([k, v]) => [k, { ...v }])) : {},
        halted: true,
      }, MAX_LAST_RUNS);
    }
    const summary = buildRunSummarySnapshot(st, {
      status: 'halted',
      waitingLead: null,
      haltedReason: st.haltedReason,
      now: haltNow,
    });
    runBySession.delete(sid);
    publishRunState(scope, sid, {
      status: 'halted',
      done: Array.from(st.done || []),
      decisions: { ...(st.decisions || {}) },
      pruned: Array.from(st.pruned || []),
      blockedEdges: Array.from(st.blockedEdges || []),
      loopCounts: {},
      nodeAttempts: { ...(st.nodeAttempts || {}) },
      waitingLead: null,
      summary,
    });
    saveStore();
  } else {
    // Even if in-memory state was already gone (e.g. after restart), overwrite any stale `.run.json`
    // so a leftover `need-lead` file can never trap the sidebar UI.
    publishRunState(scope, sid, {
      status: wasRunning ? 'halted' : 'idle',
      done: [],
      decisions: {},
      pruned: [],
      blockedEdges: [],
      loopCounts: {},
      nodeAttempts: {},
      waitingLead: null,
      summary: null,
    });
  }
  return { stopped: true, wasRunning, wasWaiting };
}

async function runPlan(scope, args, exec) {
  const agent = exec && exec.agent;
  const sid = agent && agent.id !== undefined ? String(agent.id) : '';
  if (args && args.cancel === true) {
    // Pass `cancelRootTurn: false` because this tool call runs inside the model's current turn;
    // cancelling the root turn here would cut off the model's own cancellation confirmation reply.
    const res = abortSessionRun(scope, sid, agent, { cancelRootTurn: false });
    return {
      status: 'cancelled',
      wasRunning: res.wasRunning,
      wasWaiting: res.wasWaiting,
      hint: res.wasWaiting
        ? '已终止暂停中的工作流并解除等待拍板状态。'
        : '已终止当前工作流执行。',
    };
  }
  const payload = getCanvasLRU(sid);
  if (!payload) return { error: '当前会话还没有画布数据。请在右侧 Workflow 画布点「启用」。' };
  if (!payload.enabled) return { error: '画布当前是「已禁用」状态。请在画布上点「启用」后再运行。' };
  if (payload.error) return { error: String(payload.error) };
  return executePlan(scope, payload.plan, args, exec);
}

function inspectPlan(sid) {
  const payload = getCanvasLRU(sid);
  if (!payload) {
    return {
      hasCanvas: false,
      enabled: false,
      task: '',
      nodes: [],
      edges: [],
      warnings: [],
      paused: false,
    };
  }
  const plan = payload.plan || {};
  const nodes = withoutEntry(plan.nodes).map((n) => {
    const item = {
      id: String(n.id || ''),
      kind: normalizeKind(n.kind),
      label: String(n.label || n.id || ''),
      role: String(n.role || ''),
      provider: String(n.provider || ''),
      model: String(n.model || ''),
      reasoning: String(n.reasoning || ''),
      preset: (normalizeKind(n.kind) === 'condition' || n.preset === 'minimal') ? 'minimal' : 'standard',
      keepSession: Boolean(n.keepSession),
      structured: Boolean(n.structured),
      fallbackModel: String(n.fallbackModel || ''),
      fallbackProvider: String(n.fallbackProvider || ''),
    };
    if (item.kind === 'condition') {
      const nb = normalizeBranches(n.branches);
      if (nb) item.branches = nb;
      if (n.multiMatch) item.multiMatch = true;
    }
    const nr = normalizeRefs(n.refs);
    if (nr) item.refs = nr;
    return item;
  });
  const edges = Array.isArray(plan.edges) ? plan.edges.map((e) => {
    const out = {
      from: String(e.from || ''),
      to: String(e.to || ''),
      type: String(e.type || 'prompt'),
    };
    const branch = normalizeBranch(e.branch);
    if (branch) out.branch = branch;
    if (e.loop === true) {
      out.loop = true;
      out.maxIterations = normalizeMaxIterations(e.maxIterations);
    }
    return out;
  }) : [];
  const planRefs = normalizeRefs(plan.refs);
  const out = {
    hasCanvas: true,
    enabled: Boolean(payload.enabled),
    task: String(plan.task || ''),
    nodes,
    edges,
    warnings: analyzeCanvasWarnings(nodes, edges),
    paused: Boolean(sid && runBySession.get(sid) && runBySession.get(sid).waitingLead),
  };
  if (typeof payload.presetName === 'string' && payload.presetName.trim()) {
    out.presetName = payload.presetName.trim();
  }
  if (planRefs) out.refs = planRefs;
  // Never attach `error: undefined`: DSH's lossless JSON validator rejects keys with undefined values.
  if (payload.error) out.error = String(payload.error);
  return out;
}

/** Extract the active session id from a DSH `AssembleContext`. */
function sessionIdFromContext(assembleCtx) {
  if (!assembleCtx || typeof assembleCtx !== 'object') return '';
  if (assembleCtx.agent && assembleCtx.agent.id !== undefined) return String(assembleCtx.agent.id);
  if (assembleCtx.sessionId !== undefined) return String(assembleCtx.sessionId);
  return '';
}

/**
 * Per-turn runtime prompt context injected ONLY for the session whose canvas is
 * currently enabled. DSH invokes `systemPrompt.context` for both main chats AND
 * spawned subagents, so strict `sid` matching (returning '' on miss) is required
 * to prevent leaking canvas instructions into subagents and causing recursion.
 */
function buildActiveCanvasContext(sid) {
  if (!sid) return '';
  const payload = canvasBySession.get(String(sid));
  if (!payload || !payload.enabled || payload.error) return '';
  const plan = payload.plan;
  const nodes = withoutEntry(plan && plan.nodes);
  if (!nodes.length) return '';

  const runState = runBySession.get(String(sid));
  if (runState && runState.waitingLead) {
    const wl = runState.waitingLead;
    const loopHint = wl.loopFeedback
      ? ('（↺ ' + wl.loopFeedback.retry + '/' + wl.loopFeedback.max + '：' + (wl.loopFeedback.reason || '未达预期') + '）')
      : '';
    return [
      '[Workflow Canvas Active — Paused at Lead Step]',
      '画布暂停在中间 Lead「' + wl.label + '」（' + (wl.role || wl.label) + '）' + loopHint + '：',
      '- 拍板/继续：整理结论调用 `canvas_workflow({ leadResult: "..." })`。',
      '- 取消：`canvas_workflow({ cancel: true })`；重跑：`canvas_workflow({ reset: true })`。',
      '- 改画布：先 `canvas_inspect` 再 `canvas_patch`。',
    ].join('\n');
  }

  const preview = nodes
    .slice(0, 8)
    .map((n) => (n.kind === 'lead' ? '〔Lead〕' : (n.kind === 'condition' ? '〔条件〕' : '')) + (n.label || n.id))
    .join(' → ') + (nodes.length > 8 ? ' …' : '');
  const hasTask = Boolean(String((plan && plan.task) || '').trim());
  const loopCount = (plan && Array.isArray(plan.edges)) ? plan.edges.filter((e) => isLoopEdge(e)).length : 0;
  const globalRefs = normalizeRefs(plan && plan.refs) || [];
  const prefix = String(sid) + '::';
  const hasMemory = nodes.some((n) => n.keepSession && (liveChild.has(prefix + n.id) || childByNode.has(prefix + n.id)));
  const metaParts = [];
  if (typeof payload.presetName === 'string' && payload.presetName.trim()) {
    metaParts.push('预设「' + payload.presetName.trim() + '」');
  }
  metaParts.push(
    nodes.length + ' 节点：' + preview,
    '总任务' + (hasTask ? '已填' : '未填'),
  );
  if (loopCount > 0) metaParts.push(loopCount + ' 条受控回环（自动按条件重试与超限熔断）');
  if (globalRefs.length > 0) metaParts.push('全局参考 ×' + globalRefs.length);
  const lines = [
    '[Workflow Canvas Active]',
    '右侧画布「● 已启用」（' + metaParts.join('；') + '）。',
    '- 用户布置任务或说「开始/执行/跑一次」：直接调 `canvas_workflow`（'
      + (hasTask ? '沿用入口任务，有新任务则传 task' : '传入 task 参数')
      + '），勿绕过画布直接手做。',
    '- 若画布与本轮需求明显不符，先确认再用 `canvas_preset` 切换或禁用；修改节点/参考清单、条件分支、回环先 `canvas_inspect` 再 `canvas_patch`。',
    '- 仅闲聊或无关问题时不调 `canvas_workflow`。',
  ];
  if (hasMemory) {
    lines.push('- 已有开启「记忆」的子代理会话：若用户要求重跑，先问保留记忆（`reset: true`）或清空记忆（`reset: true, clearMemory: true`）。');
  }
  const stdCount = nodes.filter((n) => n.kind !== 'lead' && n.kind !== 'condition' && n.preset !== 'minimal').length;
  if (stdCount >= 2) {
    lines.push('- 含 ' + stdCount + ' 个可写/命令型（standard）子代理，受主对话权限上限约束；若涉及改文件/跑命令且权限偏严，先简短提醒用户放开权限再跑。');
  }
  const prevRun = lastRunBySession.get(String(sid));
  if (prevRun) {
    const badNames = [
      ...Object.values(prevRun.failed || {}).map((f) => f.label || f.id),
      ...Object.values(prevRun.emptyOutputs || {}).map((e) => e.label || e.id),
    ].filter((v, i, arr) => v && arr.indexOf(v) === i);
    if (prevRun.halted || badNames.length) {
      lines.push('- 上次有失败/熔断节点（' + (badNames.join('、') || '部分未完成')
        + '）：局部续跑调 `canvas_workflow({ retryFailed: true })`（复用成功缓存）或指定 `fromNodes`。');
    }
  }
  return lines.join('\n');
}

/** Replace the profile-wide preset catalog with sanitized entries from the client. */
function syncPresetsCatalog(rawPresets) {
  const clean = sanitizePresetCatalog(rawPresets);
  presetsByName.clear();
  for (const [name, preset] of Object.entries(clean)) {
    touchMapLRU(presetsByName, name, preset, MAX_STORED_PRESETS);
  }
  return presetsByName.size;
}

/**
 * Core handler for `canvas_preset`: list presets/templates, switch the current session
 * canvas to a named preset/template, or enable/disable the current session canvas.
 */
function handleCanvasPreset(scope, sid, args) {
  const opts = args && typeof args === 'object' ? args : {};
  const action = typeof opts.action === 'string' ? opts.action.trim().toLowerCase() : '';
  if (action !== 'list' && action !== 'apply' && action !== 'toggle') {
    return { error: '参数 action 必须是 "list"、"apply" 或 "toggle"。' };
  }

  const key = sid ? String(sid) : '';
  const payload = key ? getCanvasLRU(key) : undefined;
  const isRunning = Boolean(key && activeRunBySession.has(key));
  const isPaused = Boolean(key && runBySession.get(key) && runBySession.get(key).waitingLead);

  if (action === 'list') {
    const curNodes = payload && payload.plan && Array.isArray(payload.plan.nodes) ? payload.plan.nodes : [];
    const curSum = summarizePresetNodes(curNodes);
    const current = {
      hasCanvas: Boolean(payload && payload.plan),
      enabled: Boolean(payload && payload.enabled),
      presetName: (payload && typeof payload.presetName === 'string') ? payload.presetName : '',
      task: String((payload && payload.plan && payload.plan.task) || ''),
      nodeCount: curSum.nodeCount,
      preview: curSum.preview,
      running: isRunning,
      paused: isPaused,
    };
    const compactPresets = presetsByName.size > 20;
    const userPresets = Array.from(presetsByName.entries()).map(([name, preset]) => {
      const sum = summarizePresetNodes(preset.nodes);
      return compactPresets
        ? { name, direction: preset.direction || 'lr', nodeCount: sum.nodeCount }
        : { name, direction: preset.direction || 'lr', nodeCount: sum.nodeCount, preview: sum.preview };
    });
    const builtinTemplates = BUILTIN_TEMPLATES.map((tpl) => {
      const sum = summarizePresetNodes(tpl.nodes);
      return {
        id: tpl.id,
        name: tpl.name,
        nameEn: tpl.nameEn,
        nodeCount: sum.nodeCount,
        preview: sum.preview,
      };
    });
    return { action: 'list', current, userPresets, builtinTemplates };
  }

  if (!key) {
    return { error: '无法识别当前会话 ID，无法操作画布预设或开关。' };
  }

  if (action === 'toggle') {
    if (typeof opts.enabled !== 'boolean') {
      return { error: 'action="toggle" 必须传入布尔参数 enabled（true 启用 / false 禁用）。' };
    }
    if (!opts.enabled && (isRunning || isPaused)) {
      return { error: '当前会话有正在运行或待拍板的工作流，请先调用 canvas_workflow({ cancel: true }) 终止后再禁用画布。' };
    }
    if (!payload || !payload.plan) {
      if (opts.enabled) {
        return { error: '当前会话还没有画布数据，请先用 canvas_preset({ action: "apply", name: "..." }) 载入预设，或用 canvas_generate 生成画布。' };
      }
      return { action: 'toggle', enabled: false, delivered: false, presetName: '' };
    }
    const nextPayload = { ...payload, enabled: opts.enabled };
    touchMapLRU(canvasBySession, key, nextPayload, MAX_STORED_SESSIONS);
    const delivered = publishCanvas(scope, key, {
      mode: 'merge',
      nodes: [],
      edges: [],
      enabled: opts.enabled,
    });
    saveStore();
    return {
      action: 'toggle',
      enabled: opts.enabled,
      delivered,
      presetName: typeof nextPayload.presetName === 'string' ? nextPayload.presetName : '',
    };
  }

  // action === 'apply'
  if (isRunning || isPaused) {
    return { error: '当前会话有正在运行或待拍板的工作流，请先调用 canvas_workflow({ cancel: true }) 终止后再切换预设。' };
  }
  const query = typeof opts.name === 'string' ? opts.name.trim() : '';
  if (!query) {
    return { error: 'action="apply" 必须传入要切换的预设名称或内置模板 ID（可先调 action="list" 查看）。' };
  }
  const match = resolvePresetByName(query, presetsByName);
  if (match.ambiguous) {
    return { error: '名称「' + query + '」匹配到多个预设，请指定更准确的名称：' + match.ambiguous.join('、') };
  }
  if (match.notFound || !match.preset) {
    const avail = [
      ...Array.from(presetsByName.keys()),
      ...BUILTIN_TEMPLATES.map((t) => t.id),
    ];
    return { error: '未找到名为「' + query + '」的预设或内置模板。可用项：' + avail.join('、') };
  }
  const nextEnabled = typeof opts.enabled === 'boolean' ? opts.enabled : true;
  const converted = presetToPlanAndCanvas(match.preset, {
    task: opts.task,
    enabled: nextEnabled,
    presetName: match.name,
    preserveDirection: match.source === 'user',
  });
  if (converted.error) return { error: converted.error };
  const { canvasDoc, plan, warnings } = converted;
  const delivered = publishCanvas(scope, key, canvasDoc);
  touchMapLRU(canvasBySession, key, {
    enabled: nextEnabled,
    presetName: match.name,
    plan,
  }, MAX_STORED_SESSIONS);
  runBySession.delete(key);
  lastRunBySession.delete(key);
  publishRunState(scope, key, { status: 'idle', decisions: {}, pruned: [], blockedEdges: [], waitingLead: null });
  saveStore();
  return {
    action: 'apply',
    name: match.name,
    source: match.source,
    enabled: nextEnabled,
    delivered,
    nodeCount: plan.nodes.length,
    edgeCount: plan.edges.length,
    warnings,
  };
}

/** Takes a plan directly so tests can feed any plan shape (sync, generate, patch). */
async function executePlan(scope, plan, args, exec) {
  const opts = args || {};
  const agent = exec && exec.agent;
  const sid = agent && agent.id !== undefined ? String(agent.id) : '';
  if (opts.cancel === true) {
    const res = abortSessionRun(scope, sid, agent, { cancelRootTurn: false });
    return {
      status: 'cancelled',
      wasRunning: res.wasRunning,
      wasWaiting: res.wasWaiting,
      hint: res.wasWaiting
        ? '已终止暂停中的工作流并解除等待拍板状态。'
        : '已终止当前工作流执行。',
    };
  }
  if (sid && activeRunBySession.has(sid)) {
    return { error: '当前会话已有工作流正在执行中，请等待完成，或先调用 canvas_workflow({ cancel: true }) / 点击「⏹ 终止」。' };
  }
  if (!plan || !Array.isArray(plan.nodes) || !plan.nodes.length) {
    return { error: '画布没有可执行的节点。' };
  }

  const overrideTask = typeof opts.task === 'string' ? opts.task.trim() : '';
  const effectiveTask = overrideTask || String(plan.task || '').trim();
  if (!effectiveTask) {
    return { error: '请先在入口 Lead 节点填写「本次任务」，或在调用 canvas_workflow 时传入 task。' };
  }

  // Backstop: no matter how a plan arrived (sync, generate, patch, a stale store),
  // the entry Lead is never executed.
  plan = { ...plan, task: effectiveTask, nodes: withoutEntry(plan.nodes) };

  const order = orderNodes(plan);
  if (!order) return { error: '存在环，无法执行有向无环图。' };
  const loopErrors = validateLoopEdges(plan.nodes, plan.edges);
  if (loopErrors.length) return { error: '回环配置无效：' + loopErrors[0] };

  // Defense in depth: unreachable orphans, solo chained Leads, and dangling
  // dead-end subagents are skipped instead of wasting tokens or stalling.
  const { reachable, soloLeads, deadEnds } = inactiveNodeSets(plan.nodes, plan.edges);
  const isInactive = (n) => !reachable.has(n.id) || soloLeads.has(n.id) || deadEnds.has(n.id);
  const runnable = order.filter((n) => !isInactive(n));
  const skipped = order.filter((n) => isInactive(n)).map((n) => n.label || n.id);
  if (!runnable.length) return { error: '没有从入口 Lead 连通的有效节点，无法执行。' };

  // Every runtime traversal must use the same effective graph, not raw paths
  // through skipped Leads. Validate loops again before any run state is mutated.
  const runnableIds = new Set(runnable.map((n) => n.id));
  const effectiveEdges = (plan.edges || []).filter((e) => e && (e.from === 'lead' || runnableIds.has(e.from)) && runnableIds.has(e.to));
  const partialLoop = (plan.edges || []).find((e) => e && e.loop === true
    && (runnableIds.has(e.from) || runnableIds.has(e.to))
    && (!runnableIds.has(e.from) || !runnableIds.has(e.to)));
  const effectiveLoopErrors = validateLoopEdges(runnable, effectiveEdges);
  if (partialLoop || effectiveLoopErrors.length) {
    return { error: '回环跨越无效节点或有效祖先路径已断开，请修复连线或显式删除回环：'
      + (partialLoop ? partialLoop.from + ' → ' + partialLoop.to : effectiveLoopErrors[0]) };
  }
  plan = { ...plan, nodes: runnable, edges: effectiveEdges };

  if (opts.clearMemory === true && sid) {
    const prefix = String(sid) + '::';
    for (const key of Array.from(childByNode.keys())) {
      if (key.startsWith(prefix)) childByNode.delete(key);
    }
    for (const key of Array.from(liveChild.keys())) {
      if (key.startsWith(prefix)) liveChild.delete(key);
    }
    saveStore();
  }
  if (opts.reset === true && sid) {
    runBySession.delete(sid);
    lastRunBySession.delete(sid);
  }

  const byId = new Map(runnable.map((n) => [n.id, n]));
  const labelOf = new Map(order.map((n) => [n.id, n.label || n.id]));
  const orderIds = runnable.map((n) => n.id);
  const nodeMeta = Object.fromEntries(runnable.map((n) => [n.id, {
    label: n.label || n.id,
    kind: n.kind || 'agent',
    model: formatModelLabel(n.provider, n.model),
  }]));
  const loopMeta = (plan.edges || [])
    .filter((e) => isLoopEdge(e))
    .map((e) => ({
      key: edgeKey(e),
      fromLabel: labelOf.get(e.from) || e.from,
      toLabel: labelOf.get(e.to) || e.to,
      max: normalizeMaxIterations(e.maxIterations),
    }));
  const rawMaxParallel = opts.maxParallel !== undefined ? opts.maxParallel : plan.maxParallel;
  const parsedMaxParallel = (rawMaxParallel === null || rawMaxParallel === undefined || rawMaxParallel === '' || typeof rawMaxParallel === 'boolean')
    ? NaN
    : Number(rawMaxParallel);
  const MAX_PARALLEL = Number.isFinite(parsedMaxParallel)
    ? Math.max(1, Math.min(8, Math.floor(parsedMaxParallel)))
    : 4;
  const sig = JSON.stringify(plan);
  let state = runBySession.get(sid);
  const wantRetryFailed = opts.retryFailed === true;
  const resolvedFromIds = [];
  if (opts.fromNodes !== undefined) {
    if (!Array.isArray(opts.fromNodes) || opts.fromNodes.length === 0) {
      return { error: '参数 fromNodes 必须是包含至少一个节点 ID 或名称的非空字符串数组，例如 ["n1"]。' };
    }
    const invalidEntries = opts.fromNodes.filter((x) => typeof x !== 'string' || !x.trim());
    if (invalidEntries.length) {
      return { error: '参数 fromNodes 包含非字符串或空白项，请传入有效的节点 ID 或名称字符串数组。' };
    }
    const unmatched = [];
    for (const ref of opts.fromNodes) {
      const trimmed = ref.trim();
      if (byId.has(trimmed)) resolvedFromIds.push(trimmed);
      else {
        const match = runnable.find((n) => n.label === trimmed);
        if (match) resolvedFromIds.push(match.id);
        else unmatched.push(trimmed);
      }
    }
    if (unmatched.length) {
      const validList = runnable.map((n) => n.id + (n.label && n.label !== n.id ? '(' + n.label + ')' : '')).join('、');
      return { error: 'fromNodes 中以下节点不存在或不可达：' + unmatched.join('、') + '。当前可执行节点：' + validList };
    }
  }
  const wantPartial = wantRetryFailed || resolvedFromIds.length > 0;
  let reused = [];
  let reusedIds = [];

  if (wantPartial && sid) {
    const base = state || lastRunBySession.get(sid);
    if (base) {
      const prevStats = base.nodeStats && typeof base.nodeStats === 'object' ? base.nodeStats : {};
      const carriedStats = {};
      for (const [k, v] of Object.entries(prevStats)) {
        if (byId.has(k) && v && typeof v === 'object') carriedStats[k] = { ...v };
      }
      state = {
        sig,
        done: new Set(Array.from(base.done || []).filter((id) => byId.has(id))),
        results: { ...(base.results || {}) },
        labels: { ...(base.labels || {}) },
        failed: { ...(base.failed || {}) },
        emptyOutputs: { ...(base.emptyOutputs || {}) },
        blockedEdges: new Set(Array.from(base.blockedEdges || [])),
        pruned: new Set(Array.from(base.pruned || []).filter((id) => byId.has(id))),
        decisions: { ...(base.decisions || {}) },
        fallbackLinks: Array.isArray(base.fallbackLinks) ? base.fallbackLinks.map((fl) => ({ ...fl })) : [],
        loopCounts: {},
        totalLoops: 0,
        loopHistory: {},
        loopFeedback: {},
        nodeAttempts: {},
        loopWarmChild: {},
        loopExhausted: [],
        waitingLead: null,
        startedAt: Date.now(),
        endedAt: null,
        haltedReason: '',
        maxParallel: MAX_PARALLEL,
        orderIds,
        nodeMeta,
        loopMeta,
        nodeStats: carriedStats,
        reusedIds: [],
      };
      // Build forward adjacency to invalidate seed nodes and all their downstream dependents.
      const fwd = new Map();
      for (const e of forwardEdgesOf(plan.edges || [])) {
        if (!e || !e.from || !e.to) continue;
        if (!fwd.has(e.from)) fwd.set(e.from, []);
        fwd.get(e.from).push(e.to);
      }
      const seeds = new Set();
      if (wantRetryFailed) {
        for (const id of Object.keys(state.failed)) seeds.add(id);
        for (const id of Object.keys(state.emptyOutputs)) seeds.add(id);
      }
      for (const id of resolvedFromIds) seeds.add(id);
      const invalid = new Set(seeds);
      const q = Array.from(seeds);
      for (let i = 0; i < q.length; i += 1) {
        for (const next of fwd.get(q[i]) || []) {
          if (!invalid.has(next)) { invalid.add(next); q.push(next); }
        }
      }
      for (const id of invalid) {
        state.done.delete(id);
        state.pruned.delete(id);
        delete state.results[id];
        delete state.labels[id];
        delete state.failed[id];
        delete state.emptyOutputs[id];
        delete state.decisions[id];
        delete state.nodeStats[id];
      }
      for (const e of plan.edges || []) {
        if (e && invalid.has(e.from)) state.blockedEdges.delete(edgeKey(e));
      }
      state.fallbackLinks = state.fallbackLinks.filter((fl) => !invalid.has(fl.from) && !invalid.has(fl.to));
      reusedIds = Array.from(state.done).filter((id) => !state.pruned.has(id));
      state.reusedIds = reusedIds;
      for (const id of reusedIds) {
        const meta = nodeMeta[id] || {};
        state.nodeStats[id] = {
          ...(state.nodeStats[id] || {
            id,
            label: meta.label || id,
            kind: meta.kind || 'agent',
            startedAt: null,
            endedAt: null,
            durationMs: 0,
            runs: 1,
            model: meta.model || '',
            fallbackUsed: false,
            sessionContinued: false,
            childId: '',
            reason: '',
          }),
          status: 'reused',
        };
      }
      reused = reusedIds.map((id) => labelOf.get(id) || id);
      runBySession.set(sid, state);
    }
  }

  if (!state || state.sig !== sig) {
    state = {
      sig,
      done: new Set(),
      results: {},
      labels: {},
      failed: {},
      emptyOutputs: {},
      blockedEdges: new Set(),
      pruned: new Set(),
      decisions: {},
      fallbackLinks: [],
      loopCounts: {},
      totalLoops: 0,
      loopHistory: {},
      loopFeedback: {},
      nodeAttempts: {},
      loopWarmChild: {},
      loopExhausted: [],
      waitingLead: null,
      startedAt: Date.now(),
      endedAt: null,
      haltedReason: '',
      maxParallel: MAX_PARALLEL,
      orderIds,
      nodeMeta,
      loopMeta,
      nodeStats: {},
      reusedIds: [],
    };
    runBySession.set(sid, state);
  }
  if (!state.emptyOutputs) state.emptyOutputs = {};
  if (!state.blockedEdges) state.blockedEdges = new Set();
  if (!state.pruned) state.pruned = new Set();
  if (!state.decisions) state.decisions = {};
  if (!state.fallbackLinks) state.fallbackLinks = [];
  if (!state.loopCounts) state.loopCounts = {};
  if (typeof state.totalLoops !== 'number') state.totalLoops = 0;
  if (!state.loopHistory) state.loopHistory = {};
  if (!state.loopFeedback) state.loopFeedback = {};
  if (!state.nodeAttempts) state.nodeAttempts = {};
  if (!state.loopWarmChild) state.loopWarmChild = {};
  if (!state.loopExhausted) state.loopExhausted = [];
  if (typeof state.startedAt !== 'number') state.startedAt = Date.now();
  if (!state.nodeStats) state.nodeStats = {};
  state.maxParallel = MAX_PARALLEL;
  state.orderIds = orderIds;
  state.nodeMeta = nodeMeta;
  state.loopMeta = loopMeta;

  const emitRunState = (status, waitingLead, reasonOverride) => {
    if (!sid) return;
    const loopCounts = {};
    for (const e of plan.edges || []) {
      if (!isLoopEdge(e)) continue;
      const k = edgeKey(e);
      const entry = { count: state.loopCounts[k] || 0, max: normalizeMaxIterations(e.maxIterations) };
      loopCounts[k] = entry;
      if (e.id) loopCounts[e.id] = entry;
    }
    const summary = buildRunSummarySnapshot(state, {
      status,
      waitingLead,
      haltedReason: reasonOverride || state.haltedReason || '',
    });
    publishRunState(scope, sid, {
      status,
      done: Array.from(state.done || []),
      decisions: { ...state.decisions },
      pruned: Array.from(state.pruned || []),
      blockedEdges: Array.from(state.blockedEdges || []),
      loopCounts,
      nodeAttempts: { ...state.nodeAttempts },
      waitingLead: waitingLead ? { id: waitingLead.id, label: waitingLead.label } : null,
      summary,
    });
  };
  emitRunState('running', null);

  const snapshotLastRun = (haltedFlag) => {
    if (!sid) return;
    touchMapLRU(lastRunBySession, sid, {
      sig: state.sig,
      done: new Set(state.done),
      results: { ...state.results },
      labels: { ...state.labels },
      failed: { ...state.failed },
      emptyOutputs: { ...state.emptyOutputs },
      blockedEdges: new Set(state.blockedEdges),
      pruned: new Set(state.pruned),
      decisions: { ...state.decisions },
      fallbackLinks: state.fallbackLinks.map((fl) => ({ ...fl })),
      nodeStats: Object.fromEntries(Object.entries(state.nodeStats || {}).map(([k, v]) => [k, { ...v }])),
      halted: Boolean(haltedFlag),
    }, MAX_LAST_RUNS);
  };
  const depsOf = (node) => {
    const out = new Set();
    for (const e of forwardEdgesOf(plan.edges || [])) {
      if (e.to === node.id
        && e.from !== 'lead'
        && !state.blockedEdges.has(edgeKey(e))
        && !state.pruned.has(e.from)
        && byId.has(e.from)) {
        out.add(e.from);
      }
    }
    for (const fl of state.fallbackLinks || []) {
      if (fl.to === node.id && byId.has(fl.from)) out.add(fl.from);
    }
    return Array.from(out);
  };
  const nearestDownstreamLead = (startId) => {
    const fwd = new Map();
    for (const e of forwardEdgesOf(plan.edges || [])) {
      if (!e || !e.from || !e.to) continue;
      if (!fwd.has(e.from)) fwd.set(e.from, []);
      fwd.get(e.from).push(e.to);
    }
    const seen = new Set([startId]);
    const queue = [startId];
    for (let i = 0; i < queue.length; i += 1) {
      const cur = queue[i];
      for (const next of fwd.get(cur) || []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const candidate = byId.get(next);
        if (candidate && candidate.kind === 'lead' && !state.done.has(candidate.id)) {
          return candidate;
        }
        queue.push(next);
      }
    }
    return null;
  };
  const branchSkippedList = () => Array.from(state.pruned).map((id) => labelOf.get(id) || id);
  const ancestorsOf = (targetId) => {
    const parents = new Map();
    for (const e of forwardEdgesOf(plan.edges || [])) {
      if (!e || !e.from || !e.to) continue;
      if (!parents.has(e.to)) parents.set(e.to, []);
      parents.get(e.to).push(e.from);
    }
    const seen = new Set();
    const stack = [targetId];
    while (stack.length) {
      const cur = stack.pop();
      for (const p of parents.get(cur) || []) {
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
    return seen;
  };
  const recomputeBranchPrune = () => {
    // Re-evaluate reachability from entry Lead over non-blocked forward edges so diamond
    // convergence nodes stay active, while side-channel edges from ancestors of a
    // condition node (e.g. A --session-ref--> N) cannot bypass a blocked branch gate.
    const fwdEdges = forwardEdgesOf(plan.edges || []);
    const condAncestors = new Map();
    const blockedSources = new Map();
    for (const e of fwdEdges) {
      if (!e || !e.from || !e.to) continue;
      if (!state.blockedEdges.has(edgeKey(e))) continue;
      if (!blockedSources.has(e.to)) blockedSources.set(e.to, new Set());
      blockedSources.get(e.to).add(e.from);
      if (!condAncestors.has(e.from)) condAncestors.set(e.from, ancestorsOf(e.from));
    }

    const gatedBy = new Map();
    const addGates = (nodeId, condIds) => {
      if (!gatedBy.has(nodeId)) gatedBy.set(nodeId, new Set());
      const set = gatedBy.get(nodeId);
      for (const c of condIds) set.add(c);
    };
    for (const [toId, cSet] of blockedSources.entries()) addGates(toId, cSet);

    const isBypassEdge = (e) => {
      const directGates = blockedSources.get(e.to);
      if (directGates) {
        for (const cId of directGates) {
          if ((condAncestors.get(cId) || new Set()).has(e.from)) return true;
        }
      }
      if (e.type === 'session-ref') {
        const inherited = gatedBy.get(e.to);
        if (inherited) {
          for (const cId of inherited) {
            if ((condAncestors.get(cId) || new Set()).has(e.from)) return true;
          }
        }
      }
      return false;
    };

    for (let pass = 0; pass <= runnable.length; pass += 1) {
      const adj = new Map();
      for (const e of fwdEdges) {
        if (!e || !e.from || !e.to) continue;
        if (state.blockedEdges.has(edgeKey(e))) continue;
        if (state.pruned.has(e.from)) continue;
        if (isBypassEdge(e)) continue;
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
      }
      for (const fl of state.fallbackLinks || []) {
        if (!fl || !fl.from || !fl.to || state.pruned.has(fl.from)) continue;
        if (!adj.has(fl.from)) adj.set(fl.from, []);
        adj.get(fl.from).push(fl.to);
      }
      const active = new Set(['lead']);
      const queue = ['lead'];
      for (let i = 0; i < queue.length; i += 1) {
        const cur = queue[i];
        for (const next of adj.get(cur) || []) {
          if (!active.has(next)) { active.add(next); queue.push(next); }
        }
      }
      let addedAny = false;
      for (const n of runnable) {
        if (!state.done.has(n.id) && !inFlight.has(n.id) && !active.has(n.id)) {
          state.pruned.add(n.id);
          state.done.add(n.id);
          addedAny = true;
          const gates = gatedBy.get(n.id);
          if (gates && gates.size) {
            for (const e of fwdEdges) {
              if (e && e.from === n.id && e.to) addGates(e.to, gates);
            }
          }
        }
      }
      if (!addedAny) break;
    }
  };

  let leadResult = typeof opts.leadResult === 'string' ? opts.leadResult : undefined;
  // Event-driven concurrency pool: as soon as any node finishes, newly unblocked
  // downstream agents start immediately instead of waiting for slower siblings.
  const inFlight = new Map();

  const runCtrl = new AbortController();
  const runSignal = runCtrl.signal;
  const activeRec = { ctrl: runCtrl, childIds: new Set() };
  const parentSignal = exec && exec.signal;
  const onParentAbort = () => {
    try { runCtrl.abort('parent-abort'); } catch (_e) { /* ignore */ }
    // Also interrupt every already-running child via DSH's native subagents.interrupt API,
    // since startActivation({ signal }) only aborts startup, not post-start execution.
    try {
      const subagents = resolveService(scope, 'subagents');
      if (subagents && typeof subagents.interrupt === 'function') {
        for (const cid of activeRec.childIds) {
          try { subagents.interrupt(cid, { kind: 'user' }); } catch (_e) { /* best-effort */ }
        }
      }
    } catch (_e) { /* best-effort */ }
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else if (typeof parentSignal.addEventListener === 'function') {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  if (sid) activeRunBySession.set(sid, activeRec);

  const isAborted = () => Boolean(runSignal.aborted || (parentSignal && parentSignal.aborted));
  // Raced alongside `inFlight` so user cancellation unblocks immediately even if a child activation hangs.
  const abortPromise = new Promise((resolve) => {
    if (isAborted()) { resolve({ __aborted: true }); return; }
    runSignal.addEventListener('abort', () => resolve({ __aborted: true }), { once: true });
  });
  const finishAborted = () => {
    state.endedAt = Date.now();
    state.haltedReason = '工作流执行已取消';
    // Only touch session-level state & `.run.json` if this run still owns `runBySession.get(sid)`.
    // When `abortSessionRun` already finalized synchronously (or a fresh Run 2 has started),
    // skip writing so we never double-write `.run.json` or clobber Run 2.
    if (!sid || runBySession.get(sid) === state) {
      if (state.done && state.done.size > 0) snapshotLastRun(true);
      emitRunState('halted', null, state.haltedReason);
      if (sid) runBySession.delete(sid);
      saveStore();
    }
    return {
      status: 'halted',
      error: '工作流执行已取消。',
      results: state.results,
      labels: state.labels,
      failed: Object.values(state.failed),
      emptyOutputs: Object.values(state.emptyOutputs),
      decisions: Object.values(state.decisions),
      branchSkipped: branchSkippedList(),
      ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
      reused,
      skipped,
    };
  };
  const permBlocked = [];
  let activationFailCount = 0;
  let haltedReason = '';

  const launchReadyAgents = () => {
    if (isAborted() || haltedReason || inFlight.size >= MAX_PARALLEL) return;
    const candidates = runnable.filter((n) => n.kind !== 'lead'
      && !state.done.has(n.id)
      && !inFlight.has(n.id)
      && depsOf(n).every((id) => state.done.has(id)));
    let launched = 0;
    for (const node of candidates) {
      if (isAborted() || haltedReason || inFlight.size >= MAX_PARALLEL) break;
      const fb = state.loopFeedback[node.id] || null;
      const warmChildId = (fb && state.loopWarmChild[node.id]) ? state.loopWarmChild[node.id] : '';
      const loopCtx = fb ? { feedback: fb, warmChildId } : undefined;
      if (fb) delete state.loopFeedback[node.id];
      const launchAt = Date.now();
      const prevStat = state.nodeStats[node.id];
      state.nodeStats[node.id] = {
        id: node.id,
        label: node.label || node.id,
        kind: node.kind || 'agent',
        status: 'running',
        startedAt: launchAt,
        endedAt: null,
        durationMs: prevStat && typeof prevStat.durationMs === 'number' ? prevStat.durationMs : 0,
        runs: (prevStat && typeof prevStat.runs === 'number' ? prevStat.runs : 0) + 1,
        model: formatModelLabel(node.provider, node.model) || (prevStat && prevStat.model) || '',
        fallbackUsed: Boolean(prevStat && prevStat.fallbackUsed),
        sessionContinued: Boolean(prevStat && prevStat.sessionContinued),
        childId: (prevStat && prevStat.childId) || '',
        reason: '',
      };
      const promise = spawnNode(scope, plan, node, state.results, agent, runSignal, sid, state.failed, state.pruned, loopCtx, activeRec)
        .then(
          (outcome) => ({ node, outcome, startedAt: launchAt }),
          (err) => ({ node, startedAt: launchAt, outcome: { ok: false, reason: 'run-failed', text: '运行失败：' + String((err && err.message) || err) } }),
        );
      inFlight.set(node.id, promise);
      launched += 1;
    }
    if (launched > 0) emitRunState('running', null);
  };

  try {
  for (;;) {
    if (isAborted()) {
      return finishAborted();
    }
    // On circuit-break halt, stop launching new downstream waves immediately,
    // but let already in-flight siblings settle so no orphan promises or partial
    // results are dropped before returning the halted report.
    if (haltedReason && inFlight.size === 0) {
      state.endedAt = Date.now();
      state.haltedReason = haltedReason;
      snapshotLastRun(true);
      emitRunState('halted', null, haltedReason);
      if (sid && runBySession.get(sid) === state) runBySession.delete(sid);
      saveStore();
      return {
        status: 'halted',
        error: haltedReason + '（放开权限后可调用 canvas_workflow({ retryFailed: true }) 只重跑失败与未完成节点）',
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
        reused,
        skipped,
      };
    }
    const remaining = runnable.filter((n) => !state.done.has(n.id));
    if (!remaining.length) {
      state.endedAt = Date.now();
      snapshotLastRun(false);
      emitRunState('done', null);
      if (sid && runBySession.get(sid) === state) runBySession.delete(sid);
      saveStore();
      return {
        status: 'done',
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
        reused,
        skipped,
      };
    }

    launchReadyAgents();

    if (inFlight.size > 0) {
      const raceHit = await Promise.race([...inFlight.values(), abortPromise]);
      if ((raceHit && raceHit.__aborted) || isAborted()) {
        return finishAborted();
      }
      const { node, outcome, startedAt } = raceHit;
      inFlight.delete(node.id);
      const doneAt = Date.now();
      const attemptElapsed = typeof startedAt === 'number' ? Math.max(0, doneAt - startedAt) : 0;
      const prevStat = state.nodeStats[node.id] || {
        id: node.id,
        label: node.label || node.id,
        kind: node.kind || 'agent',
        durationMs: 0,
        runs: 1,
      };
      state.nodeStats[node.id] = {
        ...prevStat,
        label: node.label || node.id,
        kind: node.kind || 'agent',
        status: !outcome.ok ? 'failed' : (outcome.empty ? 'empty' : 'done'),
        endedAt: doneAt,
        durationMs: (prevStat.durationMs || 0) + attemptElapsed,
        model: outcome.modelUsed || prevStat.model || formatModelLabel(node.provider, node.model),
        fallbackUsed: Boolean(prevStat.fallbackUsed || outcome.fallbackUsed),
        sessionContinued: Boolean(prevStat.sessionContinued || outcome.sessionContinued),
        childId: outcome.childId || prevStat.childId || '',
        reason: !outcome.ok
          ? ((outcome.reason || 'unknown') + (outcome.errorDetail ? ' — ' + outcome.errorDetail : ''))
          : '',
      };
      state.labels[node.id] = node.label;
      if (node.kind === 'condition') {
        const { branches, isDefaultBinary } = conditionBranches(node);
        if (!outcome.ok) {
          const failReason = outcome.reason || 'unknown';
          state.failed[node.id] = { id: node.id, label: node.label, reason: failReason };
          state.decisions[node.id] = {
            id: node.id,
            label: node.label,
            branches: [],
            branchLabels: [],
            branch: '',
            branchLabel: '',
            pass: false,
            failed: true,
            reason: outcome.text || ('运行失败：' + failReason),
          };
          state.results[node.id] = '【条件节点自身执行失败：' + failReason + '】' + (outcome.text ? ' ' + outcome.text : '');
          state.done.add(node.id);
          // Never guess a branch when the judge itself crashed: block all outgoing branches.
          for (const e of plan.edges || []) {
            if (e && e.from === node.id) state.blockedEdges.add(edgeKey(e));
          }
          const fallbackLead = nearestDownstreamLead(node.id);
          if (fallbackLead) {
            state.fallbackLinks.push({ from: node.id, to: fallbackLead.id, label: node.label, failed: true, reason: failReason });
            state.decisions[node.id].fallbackLead = fallbackLead.label;
            state.results[node.id] += '（未擅自选择分支，已直接转交至最近 Lead「' + fallbackLead.label + '」）';
            recomputeBranchPrune();
            emitRunState('running', null);
          } else {
            recomputeBranchPrune();
            emitRunState('running', null);
            haltedReason = '条件节点「' + node.label + '」自身执行失败（' + failReason
              + '），为避免误走分支已停止下游执行。';
          }
          continue;
        }
        const fallbackBranch = branches[0];
        const dec = outcome.decision || {
          branches: [fallbackBranch.id],
          branchLabels: [fallbackBranch.label],
          branch: fallbackBranch.id,
          branchLabel: fallbackBranch.label,
          pass: isDefaultBinary ? fallbackBranch.id === 'true' : true,
          reason: outcome.text || '',
        };
        const matchedIds = Array.isArray(dec.branches) ? dec.branches : (dec.branch ? [dec.branch] : []);
        const matchedLabels = Array.isArray(dec.branchLabels) ? dec.branchLabels : (dec.branchLabel ? [dec.branchLabel] : matchedIds);
        const pass = Boolean(dec.pass);
        const reason = dec.reason || '';
        state.decisions[node.id] = {
          id: node.id,
          label: node.label,
          branches: matchedIds,
          branchLabels: matchedLabels,
          branch: matchedIds[0] || '',
          branchLabel: matchedLabels[0] || '',
          pass,
          reason,
        };
        state.results[node.id] = (matchedIds.length === 0
          ? '【条件判断：未命中任何分支】'
          : (isDefaultBinary
            ? (pass ? '【条件判断：是 / 通过】' : '【条件判断：否 / 未通过】')
            : ('【条件分支：' + matchedLabels.join('、') + '】')))
          + (reason ? ' ' + reason : '');
        state.done.add(node.id);
        const matchedSet = new Set(matchedIds);
        const outEdges = (plan.edges || []).filter((e) => e && e.from === node.id);
        const matchedEdges = outEdges.filter((e) => {
          const edgeBranch = normalizeBranch(e.branch) || branches[0].id;
          return matchedSet.has(edgeBranch);
        });
        const matchedLoopEdges = matchedEdges.filter((e) => isLoopEdge(e));
        const matchedForwardEdges = matchedEdges.filter((e) => !isLoopEdge(e));

        if (matchedLoopEdges.length > 0) {
          // Loop priority: when a condition matches a controlled loop back-edge,
          // execute the retry reset (if within bounds) instead of advancing forward branches.
          const le = matchedLoopEdges[0];
          const leKey = edgeKey(le);
          const maxIter = normalizeMaxIterations(le.maxIterations);
          const used = state.loopCounts[leKey] || 0;
          const members = loopMemberIds(runnable, plan.edges, le);
          if (!state.loopHistory[leKey]) state.loopHistory[leKey] = [];
          state.loopHistory[leKey].push({
            round: used + 1,
            reason: reason || '未达预期',
            sourceLabel: node.label,
            targetLabel: labelOf.get(le.to) || le.to,
          });
          if (used < maxIter && state.totalLoops < MAX_GLOBAL_LOOPS && members.size > 0) {
            const summaryLines = [];
            for (const mid of members) {
              if (mid === node.id) continue;
              const rawRes = state.results[mid];
              if (typeof rawRes === 'string' && rawRes.trim()) {
                const clipped = clipSafeSlice(rawRes, 500, '…');
                summaryLines.push('[' + (labelOf.get(mid) || mid) + '] ' + clipped);
              }
            }
            const nextRetry = used + 1;
            state.loopCounts[leKey] = nextRetry;
            state.totalLoops += 1;
            for (const mid of members) {
              state.done.delete(mid);
              state.pruned.delete(mid);
              delete state.results[mid];
              delete state.failed[mid];
              delete state.emptyOutputs[mid];
              delete state.decisions[mid];
              state.nodeAttempts[mid] = { retry: nextRetry, max: maxIter };
              // Preserve cumulative durationMs and runs across loop rounds while marking pending for the next launch.
              if (state.nodeStats[mid]) {
                state.nodeStats[mid] = { ...state.nodeStats[mid], status: 'pending', startedAt: null, endedAt: null };
              }
            }
            for (const e of plan.edges || []) {
              if (e && members.has(e.from)) state.blockedEdges.delete(edgeKey(e));
            }
            // Un-prune previously pruned downstream nodes reachable from loop members over
            // non-blocked forward edges so an inner condition picking a different branch on a
            // retry round can still run them without waking branches vetoed by outside conditions.
            if (state.pruned.size > 0) {
              const fwdAdj = new Map();
              for (const e of forwardEdgesOf(plan.edges || [])) {
                if (!e || !e.from || !e.to) continue;
                if (state.blockedEdges.has(edgeKey(e))) continue;
                if (!fwdAdj.has(e.from)) fwdAdj.set(e.from, []);
                fwdAdj.get(e.from).push(e.to);
              }
              const reach = new Set(members);
              const rq = Array.from(members);
              for (let i = 0; i < rq.length; i += 1) {
                for (const nx of fwdAdj.get(rq[i]) || []) {
                  if (!reach.has(nx)) { reach.add(nx); rq.push(nx); }
                }
              }
              for (const rid of reach) {
                if (!members.has(rid) && state.pruned.has(rid)) {
                  state.pruned.delete(rid);
                  state.done.delete(rid);
                }
              }
            }
            state.fallbackLinks = state.fallbackLinks.filter((fl) => !members.has(fl.from) && !members.has(fl.to));
            state.loopFeedback[le.to] = {
              retry: nextRetry,
              max: maxIter,
              reason: reason || '未达预期',
              sourceLabel: node.label,
              lastSummary: summaryLines.join('\n'),
            };
            emitRunState('running', null);
            continue;
          }
          // Loop limit reached: stop jumping back and hand off round history to Lead or exit cleanly.
          const hitGlobalCap = used < maxIter && state.totalLoops >= MAX_GLOBAL_LOOPS;
          const hist = state.loopHistory[leKey].slice();
          state.loopExhausted.push({
            edgeKey: leKey,
            fromLabel: node.label,
            toLabel: labelOf.get(le.to) || le.to,
            iterations: used,
            maxIterations: maxIter,
            ...(hitGlobalCap ? { globalLimit: MAX_GLOBAL_LOOPS } : {}),
            history: hist,
          });
          state.decisions[node.id].loopExhausted = true;
          state.results[node.id] += hitGlobalCap
            ? ('（已达全局最大回环上限 ' + MAX_GLOBAL_LOOPS + ' 次，停止回跳）')
            : ('（已达最大回环重试次数 ' + used + '/' + maxIter + '，停止回跳）');
          for (const e of outEdges) {
            const edgeBranch = normalizeBranch(e.branch) || branches[0].id;
            if (isLoopEdge(e) || !matchedSet.has(edgeBranch)) state.blockedEdges.add(edgeKey(e));
          }
          if (matchedForwardEdges.length === 0) {
            const fallbackLead = nearestDownstreamLead(node.id);
            if (fallbackLead) {
              state.fallbackLinks.push({
                from: node.id,
                to: fallbackLead.id,
                label: node.label,
                loopExhausted: true,
                iterations: used,
                maxIterations: maxIter,
                history: hist,
              });
              state.decisions[node.id].fallbackLead = fallbackLead.label;
              state.results[node.id] += '（已汇总历次反馈转交至最近 Lead「' + fallbackLead.label + '」）';
            }
          }
          recomputeBranchPrune();
          emitRunState('running', null);
          continue;
        }

        for (const e of outEdges) {
          const edgeBranch = normalizeBranch(e.branch) || branches[0].id;
          if (!matchedSet.has(edgeBranch)) state.blockedEdges.add(edgeKey(e));
        }
        if (matchedIds.length === 0) {
          // When no condition branch matched, skip intermediate subagent branches
          // and jump directly to the nearest downstream Lead so the user/Lead is notified.
          const fallbackLead = nearestDownstreamLead(node.id);
          if (fallbackLead) {
            state.fallbackLinks.push({ from: node.id, to: fallbackLead.id, label: node.label });
            state.decisions[node.id].fallbackLead = fallbackLead.label;
            state.results[node.id] += '（已跳过中间分支，直接转交至最近 Lead「' + fallbackLead.label + '」）';
          }
        }
        recomputeBranchPrune();
        emitRunState('running', null);
        continue;
      }
      state.results[node.id] = outcome.text;
      if (!outcome.ok) {
        state.failed[node.id] = { id: node.id, label: node.label, reason: outcome.reason || 'unknown' };
        delete state.loopWarmChild[node.id];
        if (outcome.reason === 'activation-failed') activationFailCount += 1;
      } else if (outcome.empty) {
        state.emptyOutputs[node.id] = { id: node.id, label: node.label };
        delete state.loopWarmChild[node.id];
      } else if (outcome.childId) {
        state.loopWarmChild[node.id] = outcome.childId;
      }
      // If a failing node feeds a condition node, let the condition handle failure routing
      // instead of circuit-breaking the whole run prematurely.
      const routesToCondition = forwardEdgesOf(plan.edges || []).some((e) => e && e.from === node.id
        && byId.get(e.to) && byId.get(e.to).kind === 'condition');
      if (!routesToCondition && isPermissionFailure(outcome)) {
        permBlocked.push(node.label || node.id);
        haltedReason = '检测到权限/沙箱受限导致节点失败（' + permBlocked.join('、')
          + '），已熔断停止启动后续节点以防继续消耗额度。请先检查主对话左下角权限模式，放开后重新运行。';
      } else if (!routesToCondition && activationFailCount >= 2 && !haltedReason) {
        haltedReason = '连续 ' + activationFailCount + ' 个子代理启动失败，已熔断停止后续节点以防继续消耗额度。请检查模型配置或主对话权限后重试。';
      }
      state.done.add(node.id);
      emitRunState('running', null);
      continue;
    }

    const ready = remaining.filter((n) => depsOf(n).every((id) => state.done.has(id)));
    if (!ready.length) return { error: '有节点的依赖无法满足（存在环或悬空依赖）。' };

    const leadNode = ready.find((n) => n.kind === 'lead');
    if (!leadNode) return { error: '没有可执行的节点。' };
    const leadSessions = depsOf(leadNode)
      .filter((id) => (plan.edges || []).some((e) => e.to === leadNode.id && e.from === id && e.type === 'session-ref'))
      .map((id) => ({
        label: labelOf.get(id) || id,
        childId: liveChild.get(String(sid || '') + '::' + id)
          || childByNode.get(String(sid || '') + '::' + id)
          || null,
      }));
    const jumpedEntries = (state.fallbackLinks || []).filter((fl) => fl.to === leadNode.id);
    const failedConds = jumpedEntries.filter((fl) => fl.failed).map((fl) => (fl.label || labelOf.get(fl.from) || fl.from) + '（' + (fl.reason || 'unknown') + '）');
    const exhaustedConds = jumpedEntries.filter((fl) => fl.loopExhausted);
    const unmatchedConds = jumpedEntries.filter((fl) => !fl.failed && !fl.loopExhausted).map((fl) => fl.label || labelOf.get(fl.from) || fl.from);
    const leadFb = state.loopFeedback[leadNode.id] || null;
    const fallbackParts = [];
    if (leadFb) {
      fallbackParts.push('↺ 【第 ' + leadFb.retry + '/' + leadFb.max + ' 次回环修正】下游条件节点「' + (leadFb.sourceLabel || '条件判断') + '」判定未通过，理由：' + (leadFb.reason || '未达预期') + '。请结合最新反馈修正此步骤后再继续。');
    }
    if (exhaustedConds.length) {
      const exLines = exhaustedConds.map((fl) => {
        const rounds = Array.isArray(fl.history)
          ? fl.history.map((h) => '第' + h.round + '轮：' + h.reason).join('；')
          : '';
        return (fl.label || fl.from) + '（已重试 ' + fl.iterations + '/' + fl.maxIterations + ' 次仍未通过' + (rounds ? ' — ' + rounds : '') + '）';
      });
      fallbackParts.push('⚠ 回环达到最大次数上限已熔断：' + exLines.join('；') + '。请由你（Lead）审阅历次失败摘要后决定下一步。');
    }
    if (failedConds.length) {
      fallbackParts.push('⚠ 条件节点（' + failedConds.join('、') + '）自身执行失败，未擅自选择分支，已跳过中间分支直接转交给你处理；也可调用 canvas_workflow({ retryFailed: true }) 复用上游缓存并只重跑该条件节点及其下游。');
    }
    if (unmatchedConds.length) {
      fallbackParts.push('⚠ 条件节点（' + unmatchedConds.join('、') + '）所有分支均未命中，已跳过中间分支直接转交给你处理。');
    }
    const fallbackNotice = fallbackParts.join(' ');
    const mergedLeadRefs = normalizeRefs((normalizeRefs(plan && plan.refs) || []).concat(normalizeRefs(leadNode.refs) || []));
    const hasDownstreamWork = remaining.some((n) => n.id !== leadNode.id);
    if (!hasDownstreamWork && leadResult === undefined) {
      // Terminal Lead: zero downstream nodes remain, so complete the run directly
      // and hand off final review/delivery to the Lead without a redundant extra turn.
      const termNow = Date.now();
      const prevLeadStat = state.nodeStats[leadNode.id];
      state.nodeStats[leadNode.id] = {
        id: leadNode.id,
        label: leadNode.label || leadNode.id,
        kind: 'lead',
        status: 'done',
        startedAt: (prevLeadStat && prevLeadStat.startedAt) || termNow,
        endedAt: termNow,
        durationMs: prevLeadStat && typeof prevLeadStat.durationMs === 'number' ? prevLeadStat.durationMs : 0,
        runs: (prevLeadStat && typeof prevLeadStat.runs === 'number' ? prevLeadStat.runs : 0) + 1,
        model: '',
        fallbackUsed: false,
        sessionContinued: false,
        childId: '',
        reason: '',
      };
      state.endedAt = termNow;
      state.done.add(leadNode.id);
      snapshotLastRun(false);
      emitRunState('done', null);
      if (sid && runBySession.get(sid) === state) runBySession.delete(sid);
      saveStore();
      return {
        status: 'done',
        finalLead: {
          label: leadNode.label,
          role: leadNode.role || leadNode.label,
          needs: depsOf(leadNode).map((id) => byId.get(id).label),
          ...(mergedLeadRefs ? { refs: mergedLeadRefs } : {}),
        },
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
        sessions: leadSessions,
        reused,
        skipped,
        hint: (fallbackNotice ? fallbackNotice + ' ' : '')
          + '所有子代理已完成。最后一步由你（Lead 本体）按要求完成终审/汇总后直接向用户交付即可，无需再次调用 canvas_workflow。',
      };
    }
    if (leadResult === undefined) {
      const pauseNow = Date.now();
      const prevLeadStat = state.nodeStats[leadNode.id];
      state.nodeStats[leadNode.id] = {
        id: leadNode.id,
        label: leadNode.label || leadNode.id,
        kind: 'lead',
        status: 'waiting',
        startedAt: pauseNow,
        endedAt: null,
        durationMs: prevLeadStat && typeof prevLeadStat.durationMs === 'number' ? prevLeadStat.durationMs : 0,
        runs: (prevLeadStat && typeof prevLeadStat.runs === 'number' ? prevLeadStat.runs : 0) + 1,
        model: '',
        fallbackUsed: false,
        sessionContinued: false,
        childId: '',
        reason: '',
      };
      const leadFbSummary = leadFb
        ? { retry: leadFb.retry, max: leadFb.max, sourceLabel: leadFb.sourceLabel, reason: leadFb.reason }
        : null;
      state.waitingLead = {
        id: leadNode.id,
        label: leadNode.label,
        role: leadNode.role || leadNode.label,
        ...(leadFbSummary ? { loopFeedback: leadFbSummary } : {}),
      };
      emitRunState('need-lead', state.waitingLead);
      return {
        status: 'need-lead',
        node: {
          label: leadNode.label,
          role: leadNode.role || leadNode.label,
          needs: depsOf(leadNode).map((id) => byId.get(id).label),
          ...(mergedLeadRefs ? { refs: mergedLeadRefs } : {}),
          ...(leadFbSummary ? { loopFeedback: leadFbSummary } : {}),
        },
        results: state.results,
        labels: state.labels,
        failed: Object.values(state.failed),
        emptyOutputs: Object.values(state.emptyOutputs),
        decisions: Object.values(state.decisions),
        branchSkipped: branchSkippedList(),
        ...(state.loopExhausted.length ? { loopExhausted: state.loopExhausted } : {}),
        sessions: leadSessions,
        hint: (fallbackNotice ? fallbackNotice + ' ' : '')
          + '这一步由你（Lead 本体）完成。完成后再次调用本工具，把结果放进 leadResult 继续；若需取消本次流程可传 cancel: true，若需从头重跑可传 reset: true。',
      };
    }
    const resumeNow = Date.now();
    const prevLeadStat = state.nodeStats[leadNode.id];
    const leadWaitMs = prevLeadStat && typeof prevLeadStat.startedAt === 'number'
      ? Math.max(0, resumeNow - prevLeadStat.startedAt)
      : 0;
    state.nodeStats[leadNode.id] = {
      id: leadNode.id,
      label: leadNode.label || leadNode.id,
      kind: 'lead',
      status: 'done',
      startedAt: (prevLeadStat && prevLeadStat.startedAt) || resumeNow,
      endedAt: resumeNow,
      durationMs: (prevLeadStat && typeof prevLeadStat.durationMs === 'number' ? prevLeadStat.durationMs : 0) + leadWaitMs,
      runs: prevLeadStat && typeof prevLeadStat.runs === 'number' ? prevLeadStat.runs : 1,
      model: '',
      fallbackUsed: false,
      sessionContinued: false,
      childId: '',
      reason: '',
    };
    state.waitingLead = null;
    delete state.loopFeedback[leadNode.id];
    state.results[leadNode.id] = leadResult;
    state.labels[leadNode.id] = leadNode.label;
    state.done.add(leadNode.id);
    leadResult = undefined;
    emitRunState('running', null);
  }
  } finally {
    if (parentSignal && typeof parentSignal.removeEventListener === 'function') {
      try { parentSignal.removeEventListener('abort', onParentAbort); } catch (_e) { /* ignore */ }
    }
    if (sid && activeRunBySession.get(sid) === activeRec) {
      activeRunBySession.delete(sid);
    }
  }
}

/** Agent-facing guide, shipped as a skill so any agent can load it on demand. */
const SKILL_NAME = 'workflow-canvas';
const SKILL_DESCRIPTION = 'Workflow canvas (画布/工作流/预设/条件分支/回环): inspect, switch presets, toggle, draw, edit, run or cancel a DSH subagent graph. Load before using canvas_inspect, canvas_preset, canvas_generate, canvas_patch or canvas_workflow.';
function skillPath() {
  try {
    return fileURLToPath(new URL('./skills/workflow-canvas/SKILL.md', import.meta.url));
  } catch (_e) {
    return undefined;
  }
}

function readSkillGuide() {
  try {
    const location = skillPath();
    if (!location) return fallbackGuide();
    const raw = readFileSync(location, 'utf8');
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
    return match ? raw.slice(match[0].length).trim() : raw.trim();
  } catch (_e) {
    return fallbackGuide();
  }
}

function fallbackGuide() {
  return '# Workflow canvas\n\nThe bundled guide could not be read from this installation.';
}
export function apply(ctx) {
  loadStore();
  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      if (promptCtx.systemPrompt && typeof promptCtx.systemPrompt.context === 'function') {
        promptCtx.effect(() => promptCtx.systemPrompt.context({
          name: 'app:workflow-canvas-active',
          order: 950,
          text: (assembleCtx) => buildActiveCanvasContext(sessionIdFromContext(assembleCtx)),
        }), 'workflow-canvas: active context');
      }
    } catch (_e) {
      /* systemPrompt service unavailable */
    }
  });
  ctx.inject(['skills'], (scope) => {
      try {
        scope.effect(() => scope.skills.registerProvider(() => ({
          name: 'dsh-workflow-canvas',
          async list() {
            return {
              candidates: [{
                name: SKILL_NAME,
                description: SKILL_DESCRIPTION,
                invocation: { modelInvocable: true, userInvocable: true },
                provider: 'dsh-workflow-canvas',
                source: 'bundled',
                rank: 0,
                locator: 'dsh-workflow-canvas/skills/workflow-canvas/SKILL.md',
              }],
              complete: true,
            };
          },
          async get(candidate) {
            const { rank, locator, ...summary } = candidate;
            void rank;
            void locator;
            return { ...summary, content: readSkillGuide() };
          },
        })), 'workflow-canvas: skill');
      } catch (_e) {
        /* skill registry unavailable */
      }
    });
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
              const prev = canvasBySession.get(id);
              const next = parsePayload(rawInput);
              if (next && next.presets && typeof next.presets === 'object' && !Array.isArray(next.presets)) {
                syncPresetsCatalog(next.presets);
                delete next.presets;
              }
              touchMapLRU(canvasBySession, id, next, MAX_STORED_SESSIONS);
              const curRun = runBySession.get(id);
              const sameActivePlan = Boolean(
                prev && prev.enabled === true && next && next.enabled === true && !next.error
                && prev.plan && next.plan && JSON.stringify(prev.plan) === JSON.stringify(next.plan),
              );
              const keepPausedLead = Boolean(curRun && curRun.waitingLead && sameActivePlan);
              if (!activeRunBySession.has(id) && !keepPausedLead) {
                runBySession.delete(id);
                publishRunState(ctx, id, { status: 'idle', decisions: {}, pruned: [], blockedEdges: [], waitingLead: null });
              }
              saveStore();
              return { kind: 'success', text: 'canvas synced' };
            } catch (error) {
              return { kind: 'error', text: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: sync command');
        scope.effect(() => scope.commands.register({
          name: 'canvas-stop',
          description: 'Stop any running or paused workflow canvas execution for this session.',
          recordInput: false,
          handler: ({ agent }) => {
            try {
              const id = agent && agent.id !== undefined ? String(agent.id) : '';
              if (!id) return { kind: 'error', text: 'no session' };
              abortSessionRun(ctx, id, agent);
              return { kind: 'success', text: 'workflow stopped' };
            } catch (error) {
              return { kind: 'error', text: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: stop command');
      } catch (_e) {
        /* command registry unavailable */
      }
    });

    ctx.inject(['tools', 'subagents', 'sessions'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_generate',
          description: 'Build a workflow canvas from a node/edge sketch. Entry Lead (id="lead") is auto-created for task — wire first-wave nodes from "lead". Only non-entry Leads pause. Load `workflow-canvas` skill for full field/link rules.',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Top-level task on entry Lead.' },
              refs: { type: 'array', description: 'Global reference paths/URLs/rules.', items: { type: 'string' } },
              nodes: {
                type: 'array',
                description: 'Non-entry nodes (give each id or ref).',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    ref: { type: 'string' },
                    entry: { type: 'boolean' },
                    kind: { type: 'string', enum: ['agent', 'lead', 'condition'] },
                    label: { type: 'string' },
                    role: { type: 'string' },
                    task: { type: 'string' },
                    provider: { type: 'string' },
                    model: { type: 'string' },
                    reasoning: { type: 'string' },
                    preset: { type: 'string' },
                    structured: { type: 'boolean' },
                    keepSession: { type: 'boolean' },
                    fallbackModel: { type: 'string' },
                    fallbackProvider: { type: 'string' },
                    refs: { type: 'array', items: { type: 'string' } },
                    branches: { type: 'array', description: 'Condition switch/case branches (2+).', items: {} },
                    multiMatch: { type: 'boolean', description: 'Condition: match multiple branches.' },
                  },
                },
              },
              edges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    from: { type: 'string' },
                    to: { type: 'string' },
                    type: { type: 'string', enum: ['prompt', 'structured', 'session-ref'] },
                    branch: { type: 'string', description: 'Condition branch id ("true"/"false" or custom).' },
                    loop: { type: 'boolean', description: 'Condition retry back-edge to strict ancestor.' },
                    maxIterations: { type: 'integer', minimum: 1, maximum: 10 },
                  },
                  required: ['from', 'to'],
                },
              },
            },
            required: ['nodes'],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                canvas: { type: 'object' },
                delivered: { type: 'boolean' },
                warnings: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const v = value || {};
              if (typeof v.error === 'string') return [{ type: 'text', text: v.error }];
              const canvas = v.canvas || {};
              const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
              const edges = Array.isArray(canvas.edges) ? canvas.edges : [];
              const lines = nodes.map((n) => '- [' + n.id + '] '
                + (n.kind === 'lead' ? '〔Lead〕' : (n.kind === 'condition' ? '〔条件〕' : ''))
                + n.label
                + (n.role ? '：' + n.role : ''));
              const warnBlock = Array.isArray(v.warnings) && v.warnings.length
                ? '\n\n⚠ 结构提示：\n' + v.warnings.map((w) => '- ' + w).join('\n')
                : '';
              return [{
                type: 'text',
                text: '已生成画布：' + nodes.length + ' 个节点、' + edges.length + ' 条连线\n'
                  + lines.join('\n')
                  + warnBlock
                  + (v.delivered
                    ? '\n\n画布已经自动同步到右侧画布，直接看即可（若没出现，点画布上的「⊡ 全览」）。'
                    : '\n\n**下一步**：点画布右上角「⋯ → ⇩ 导入」，它会把这段画布数据装进当前画布。')
                  + '\n```json canvas\n'
                  + JSON.stringify(canvas) + '\n```',
              }];
            },
          },
          execute: (args, exec) => {
            try {
              const result = normalizeCanvas(args || {});
              if (result.error) return { error: result.error };
              const warnings = Array.isArray(result.warnings) ? result.warnings : [];
              const agent = exec && exec.agent;
              const sid = agent && agent.id !== undefined ? String(agent.id) : '';
              const previous = sid ? canvasBySession.get(sid) : undefined;
              const nextEnabled = previous ? Boolean(previous.enabled) : true;
              const canvas = { nodes: result.nodes, edges: result.edges, enabled: nextEnabled };
              const delivered = sid ? publishCanvas(scope, sid, canvas) : false;
              if (sid) {
                const entryNode = canvas.nodes.find((n) => n && n.id === 'lead');
                const planObj = {
                  task: String(result.task || (args && args.task) || ''),
                  nodes: withoutEntry(canvas.nodes),
                  edges: canvas.edges,
                };
                const entryRefs = normalizeRefs(entryNode && entryNode.refs);
                if (entryRefs) planObj.refs = entryRefs;
                touchMapLRU(canvasBySession, sid, {
                  enabled: nextEnabled,
                  plan: planObj,
                }, MAX_STORED_SESSIONS);
                runBySession.delete(sid);
                lastRunBySession.delete(sid);
                publishRunState(scope, sid, { status: 'idle', decisions: {}, pruned: [], blockedEdges: [], waitingLead: null });
                saveStore();
              }
              return { canvas, delivered, warnings };
            } catch (error) {
              return { error: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: generate tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });

    ctx.inject(['tools', 'subagents', 'sessions'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_patch',
          description: 'Edit the current canvas in place (keeps layout): update/add/remove nodes and links. Prefer over canvas_generate for edits.',
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Entry Lead task.' },
              refs: { type: 'array', description: 'Replace global refs.', items: { type: 'string' } },
              nodes: { type: 'array', description: 'Nodes to merge by id or add.', items: { type: 'object' } },
              removeNodes: { type: 'array', items: { type: 'string' } },
              edges: { type: 'array', items: { type: 'object' } },
              removeEdges: { type: 'array', description: 'Match by from/to.', items: { type: 'object' } },
            },
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                delivered: { type: 'boolean' },
                summary: { type: 'string' },
                warnings: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
            render: (_a, value) => {
              const v = value || {};
              if (typeof v.error === 'string') return [{ type: 'text', text: v.error }];
              const warnBlock = Array.isArray(v.warnings) && v.warnings.length
                ? '\n⚠ 结构提示：\n' + v.warnings.map((w) => '- ' + w).join('\n')
                : '';
              return [{ type: 'text', text: v.summary + (v.delivered ? '（画布已就地更新）' : '（画布不可达，未应用）') + warnBlock }];
            },
          },
          execute: (args, exec) => {
            try {
              const agent = exec && exec.agent;
              const sid = agent && agent.id !== undefined ? String(agent.id) : '';
              const payload = sid ? canvasBySession.get(sid) : undefined;
              if (!payload || !payload.plan) return { error: '当前会话还没有画布数据，先用「启用」同步一次。' };
              const patched = applyPatch(payload.plan, args);
              const nextPlan = patched.plan;
              touchMapLRU(canvasBySession, sid, { enabled: payload.enabled, plan: nextPlan }, MAX_STORED_SESSIONS);
              runBySession.delete(sid);
              publishRunState(scope, sid, { status: 'idle', decisions: {}, pruned: [], blockedEdges: [], waitingLead: null });
              saveStore();
              const patchDoc = {
                mode: 'merge',
                nodes: nextPlan.nodes,
                edges: nextPlan.edges,
                removeNodes: patched.removed,
                removeEdges: patched.removeEdges,
              };
              if (patched.taskPatched) patchDoc.task = nextPlan.task;
              if (patched.refsPatched) patchDoc.refs = nextPlan.refs || [];
              const delivered = publishCanvas(scope, sid, patchDoc);
              const warnings = [
                ...(Array.isArray(patched.warnings) ? patched.warnings : []),
                ...analyzeCanvasWarnings(nextPlan.nodes, nextPlan.edges),
              ];
              const summary = '已更新 ' + patched.touched.length + ' 个节点'
                + (patched.taskPatched ? '、已更新总任务' : '')
                + '、删除 ' + patched.removed.length + ' 个、连线 ' + nextPlan.edges.length + ' 条';
              return { delivered, summary, warnings };
            } catch (error) {
              return { error: String((error && error.message) || error) };
            }
          },
        }), 'workflow-canvas: patch tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });

    ctx.inject(['tools'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_inspect',
          description: 'Read current session canvas (enabled, presetName, task, nodes, links, paused). Call before canvas_patch.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                hasCanvas: { type: 'boolean' },
                enabled: { type: 'boolean' },
                presetName: { type: 'string' },
                task: { type: 'string' },
                refs: { type: 'array', items: { type: 'string' } },
                nodes: { type: 'array' },
                edges: { type: 'array' },
                warnings: { type: 'array', items: { type: 'string' } },
                paused: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const v = value || {};
              if (!v.hasCanvas) {
                return [{ type: 'text', text: '当前会话尚未同步画布。请让用户在右侧 Workflow 画布点「启用」或「同步」，或直接用 canvas_generate 生成新画布。' }];
              }
              const head = [
                '画布状态：' + (v.enabled ? '● 已启用' : '○ 已禁用')
                  + (v.presetName ? '（预设：' + v.presetName + '）' : '')
                  + (v.paused ? '（当前暂停在 Lead 步骤）' : ''),
                '总任务：' + (v.task || '（未填写，运行时可通过 task 参数指定）'),
              ];
              if (Array.isArray(v.refs) && v.refs.length) {
                head.push('全局参考：' + v.refs.join('；'));
              }
              if (v.error) head.push('校验错误：' + v.error);
              const warnBlock = Array.isArray(v.warnings) && v.warnings.length
                ? '\n\n⚠ 结构提示：\n' + v.warnings.map((w) => '- ' + w).join('\n')
                : '';
              const nodeLines = (v.nodes || []).map((n) => {
                const flags = [];
                if (n.kind === 'lead') flags.push('Lead');
                if (n.kind === 'condition') {
                  flags.push('条件' + (Array.isArray(n.branches) && n.branches.length >= 2
                    ? ':' + n.branches.map((b) => b.label || b.id).join('/')
                    : ''));
                  if (n.multiMatch) flags.push('多选');
                }
                if (Array.isArray(n.refs) && n.refs.length) flags.push('参考×' + n.refs.length);
                if (n.model) flags.push(n.model);
                if (n.reasoning) flags.push('reasoning=' + n.reasoning);
                if (n.preset === 'minimal') flags.push('minimal');
                if (n.keepSession) flags.push('记忆');
                if (n.fallbackModel) flags.push('备用=' + n.fallbackModel);
                return '- [' + n.id + '] ' + n.label
                  + (flags.length ? ' (' + flags.join(', ') + ')' : '')
                  + (n.role ? '：' + n.role : '');
              });
              const edgeLines = (v.edges || []).map((e) => '- ' + e.from
                + ' --(' + e.type + (e.branch ? ':' + e.branch : '')
                + (e.loop ? ', ↺ loop ×' + normalizeMaxIterations(e.maxIterations) : '')
                + ')--> ' + e.to);
              return [{
                type: 'text',
                text: head.join('\n')
                  + warnBlock
                  + '\n\n节点（' + nodeLines.length + '）：\n' + (nodeLines.join('\n') || '（无）')
                  + '\n\n连线（' + edgeLines.length + '）：\n' + (edgeLines.join('\n') || '（无）'),
              }];
            },
          },
          execute: (_args, exec) => {
            const agent = exec && exec.agent;
            const sid = agent && agent.id !== undefined ? String(agent.id) : '';
            return inspectPlan(sid);
          },
        }), 'workflow-canvas: inspect tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });

    ctx.inject(['tools', 'sessions'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_preset',
          description: 'List/apply workflow presets or templates, or toggle the session canvas on/off (works when disabled; confirm before switching mismatched workflows).',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['list', 'apply', 'toggle'] },
              name: { type: 'string', description: 'Preset name or template id (for apply).' },
              enabled: { type: 'boolean', description: 'Enable/disable state (required for toggle; default true for apply).' },
              task: { type: 'string', description: 'Optional entry task override (for apply).' },
            },
            required: ['action'],
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                current: { type: 'object' },
                userPresets: { type: 'array' },
                builtinTemplates: { type: 'array' },
                name: { type: 'string' },
                source: { type: 'string' },
                enabled: { type: 'boolean' },
                delivered: { type: 'boolean' },
                presetName: { type: 'string' },
                nodeCount: { type: 'number' },
                edgeCount: { type: 'number' },
                warnings: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const v = value || {};
              if (typeof v.error === 'string') return [{ type: 'text', text: v.error }];
              if (v.action === 'list') {
                const cur = v.current || {};
                const curLine = cur.hasCanvas
                  ? ((cur.enabled ? '● 已启用' : '○ 已禁用')
                    + (cur.presetName ? ' · 预设「' + cur.presetName + '」' : '')
                    + ' · ' + (cur.nodeCount || 0) + ' 节点'
                    + (cur.preview ? '（' + cur.preview + '）' : '')
                    + (cur.running ? ' [运行中]' : (cur.paused ? ' [待拍板]' : '')))
                  : '当前会话尚未同步画布';
                const uList = Array.isArray(v.userPresets) && v.userPresets.length
                  ? v.userPresets.map((p) => '- ' + p.name + '（' + p.nodeCount + ' 节点' + (p.preview ? '：' + p.preview : '') + '）').join('\n')
                  : '（暂无已同步的用户预设；在右侧画布保存预设并同步一次后即可跨会话列出）';
                const bList = Array.isArray(v.builtinTemplates)
                  ? v.builtinTemplates.map((t) => '- [' + t.id + '] ' + t.name + '（' + t.nodeCount + ' 节点）').join('\n')
                  : '';
                return [{
                  type: 'text',
                  text: '当前画布：' + curLine
                    + '\n\n用户预设（' + ((v.userPresets && v.userPresets.length) || 0) + '）：\n' + uList
                    + '\n\n内置示例模板（' + ((v.builtinTemplates && v.builtinTemplates.length) || 0) + '）：\n' + bList,
                }];
              }
              if (v.action === 'toggle') {
                return [{
                  type: 'text',
                  text: (v.enabled ? '已启用当前会话画布' : '已禁用当前会话画布')
                    + (v.presetName ? '（预设：' + v.presetName + '）' : '')
                    + (v.delivered ? '（右侧画布已同步）' : '（已更新后端状态）'),
                }];
              }
              const warnBlock = Array.isArray(v.warnings) && v.warnings.length
                ? '\n⚠ 结构提示：\n' + v.warnings.map((w) => '- ' + w).join('\n')
                : '';
              return [{
                type: 'text',
                text: '已切换到' + (v.source === 'builtin' ? '内置模板' : '用户预设')
                  + '「' + v.name + '」（' + v.nodeCount + ' 个节点、' + v.edgeCount + ' 条连线，状态：'
                  + (v.enabled ? '● 已启用' : '○ 已禁用') + '）'
                  + (v.delivered ? '，右侧画布已自动更新。' : '。')
                  + warnBlock,
              }];
            },
          },
          execute: (args, exec) => {
            const agent = exec && exec.agent;
            const sid = agent && agent.id !== undefined ? String(agent.id) : '';
            return handleCanvasPreset(scope, sid, args || {});
          },
        }), 'workflow-canvas: preset tool');
      } catch (_e) {
        /* tool registry unavailable */
      }
    });

    ctx.inject(['tools', 'subagents', 'sessions'], (scope) => {
      try {
        scope.effect(() => scope.tools.register({
          name: 'canvas_workflow',
          description: 'Run, resume (leadResult), or cancel the session workflow canvas. Executes parallel waves, condition pruning & retry loops; pauses at intermediate Lead nodes with status "need-lead".',
          parameters: {
            type: 'object',
            properties: {
              leadResult: { type: 'string', description: 'Your output to resume a paused Lead step.' },
              task: { type: 'string', description: 'Optional task override for this run.' },
              cancel: { type: 'boolean', description: 'Abort active or paused run.' },
              reset: { type: 'boolean', description: 'Discard paused state and restart.' },
              retryFailed: { type: 'boolean', description: 'Reuse succeeded nodes; re-run failed/unfinished + downstream.' },
              fromNodes: { type: 'array', items: { type: 'string' }, description: 'Re-run specified node ids/labels + downstream.' },
              clearMemory: { type: 'boolean', description: 'Reset saved keepSession child sessions.' },
              maxParallel: { type: 'integer', minimum: 1, maximum: 8 },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                wasRunning: { type: 'boolean' },
                wasWaiting: { type: 'boolean' },
                node: { type: 'object' },
                finalLead: { type: 'object' },
                results: { type: 'object' },
                labels: { type: 'object' },
                failed: { type: 'array' },
                emptyOutputs: { type: 'array' },
                decisions: { type: 'array' },
                branchSkipped: { type: 'array' },
                loopExhausted: { type: 'array' },
                sessions: { type: 'array' },
                reused: { type: 'array' },
                skipped: { type: 'array' },
                hint: { type: 'string' },
                error: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const v = value || {};
              if (typeof v.error === 'string' && v.status !== 'halted') return [{ type: 'text', text: v.error }];
              if (v.status === 'cancelled') return [{ type: 'text', text: v.hint || '已终止当前工作流执行。' }];
              const results = v.results || {};
              const labels = v.labels || {};
              const blocks = Object.keys(results).map((id) => {
                const text = typeof results[id] === 'string' ? results[id] : JSON.stringify(results[id]);
                return '## ' + (labels[id] || id) + '\n' + text;
              });
              const body = blocks.length ? blocks.join('\n\n') : '（暂无上游结果）';
              const failedList = Array.isArray(v.failed) && v.failed.length
                ? '\n\n⚠ 失败节点：' + v.failed.map((f) => (f.label || f.id) + '（' + (f.reason || 'unknown') + '）').join('、')
                : '';
              const emptyList = Array.isArray(v.emptyOutputs) && v.emptyOutputs.length
                ? '\n\n⚠ 未返回交付文本的节点（请核查其实际产物，切勿直接当作已完成）：'
                  + v.emptyOutputs.map((e) => e.label || e.id).join('、')
                : '';
              const decisionList = Array.isArray(v.decisions) && v.decisions.length
                ? '\n\n条件分支判决：' + v.decisions.map((d) => {
                  if (d.failed) {
                    return (d.label || d.id) + ' → ⚠ 自身执行失败' + (d.reason ? '（' + d.reason + '）' : '');
                  }
                  const ids = Array.isArray(d.branches) ? d.branches : (d.branch ? [d.branch] : []);
                  const labels = Array.isArray(d.branchLabels) ? d.branchLabels : (d.branchLabel ? [d.branchLabel] : ids);
                  if (!ids.length) {
                    return (d.label || d.id) + ' → 未命中任何分支' + (d.reason ? '（' + d.reason + '）' : '');
                  }
                  const isDefault = ids.length === 1
                    && (ids[0] === 'true' || ids[0] === 'false')
                    && (!labels[0] || labels[0] === '是' || labels[0] === '否' || labels[0] === 'Yes' || labels[0] === 'No');
                  const chosen = isDefault ? (d.pass ? '✓ 是' : '✕ 否') : labels.join(' + ');
                  return (d.label || d.id) + ' → ' + chosen + (d.reason ? '（' + d.reason + '）' : '');
                }).join('；')
                : '';
              const branchSkipNote = Array.isArray(v.branchSkipped) && v.branchSkipped.length
                ? '\n\n条件未命中已跳过：' + v.branchSkipped.join('、')
                : '';
              const loopExNote = Array.isArray(v.loopExhausted) && v.loopExhausted.length
                ? '\n\n⚠ 回环达上限熔断：' + v.loopExhausted.map((lx) => (lx.fromLabel || lx.edgeKey) + ' ↺ ' + (lx.toLabel || '') + '（' + lx.iterations + '/' + lx.maxIterations + '）').join('；')
                : '';
              if (v.status === 'halted') {
                const reusedNote = Array.isArray(v.reused) && v.reused.length
                  ? '\n\n已复用缓存：' + v.reused.join('、')
                  : '';
                return [{
                  type: 'text',
                  text: (v.error || '工作流已停止。')
                    + decisionList
                    + failedList
                    + emptyList
                    + loopExNote
                    + (blocks.length ? '\n\n已完成节点结果：\n' + body : '')
                    + branchSkipNote
                    + reusedNote,
                }];
              }
              if (v.status === 'need-lead') {
                const n = v.node || {};
                const refsBlock = Array.isArray(n.refs) && n.refs.length
                  ? '\n参考资料 / 约束：\n' + n.refs.map((r) => '- ' + r).join('\n')
                  : '';
                const handed = Array.isArray(v.sessions) ? v.sessions.filter((s) => s && s.childId) : [];
                const handover = handed.length
                  ? '\n\n可用会话（session 连线）：' + handed.map((s) => s.label + ' → ' + s.childId).join('；')
                    + '\n需要追问时，直接给对应子代理发消息即可，它们仍在上游会话里。'
                  : '';
                return [{
                  type: 'text',
                  text: '需要你（Lead）完成「' + n.label + '」：' + n.role
                    + '\n需要用到：' + ((n.needs && n.needs.length) ? n.needs.join('、') : '（无上游）')
                    + refsBlock
                    + decisionList
                    + failedList
                    + emptyList
                    + '\n\n已完成节点的结果：\n' + body
                    + handover
                    + branchSkipNote
                    + loopExNote
                    + '\n\n' + (v.hint || ''),
                }];
              }
              if (v.status === 'done') {
                const skip = Array.isArray(v.skipped) && v.skipped.length
                  ? '\n\n已跳过（未连线）：' + v.skipped.join('、')
                  : '';
                const reusedNote = Array.isArray(v.reused) && v.reused.length
                  ? '\n\n已复用上次成功缓存（未重复消耗）：' + v.reused.join('、')
                  : '';
                if (v.finalLead) {
                  const fl = v.finalLead;
                  const refsBlock = Array.isArray(fl.refs) && fl.refs.length
                    ? '\n参考资料 / 约束：\n' + fl.refs.map((r) => '- ' + r).join('\n')
                    : '';
                  const handed = Array.isArray(v.sessions) ? v.sessions.filter((s) => s && s.childId) : [];
                  const handover = handed.length
                    ? '\n\n可用会话（session 连线）：' + handed.map((s) => s.label + ' → ' + s.childId).join('；')
                      + '\n如需局部追问或返工，可直接给对应子代理发消息。'
                    : '';
                  return [{
                    type: 'text',
                    text: '所有子代理已完成，现在进入终审 Lead 步骤「' + fl.label + '」：' + fl.role
                      + '\n需要用到：' + ((fl.needs && fl.needs.length) ? fl.needs.join('、') : '（无上游）')
                      + refsBlock
                      + decisionList
                      + failedList
                      + emptyList
                      + '\n\n已完成节点的结果：\n' + body
                      + handover
                      + branchSkipNote
                      + loopExNote
                      + reusedNote
                      + skip
                      + '\n\n' + (v.hint || ''),
                  }];
                }
                return [{ type: 'text', text: '画布执行完成。' + decisionList + failedList + emptyList + loopExNote + '\n\n' + body + branchSkipNote + reusedNote + skip }];
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

export {
  orderNodes,
  upstreamOf,
  downstreamLabels,
  parsePayload,
  clipUpstreamOutput,
  briefFor,
  normalizeBranches,
  normalizeRefs,
  normalizeMaxIterations,
  loopMemberIds,
  validateLoopEdges,
  extractJsonObjects,
  parseStrictJsonObject,
  parseStrictConditionJson,
  parseConditionDecision,
  clipSafeSlice,
  withoutEntry,
  analyzeCanvasWarnings,
  normalizeCanvas,
  applyPatch,
  inspectPlan,
  syncPresetsCatalog,
  handleCanvasPreset,
  sessionIdFromContext,
  buildActiveCanvasContext,
  isPermissionFailure,
  isTransientFailure,
  safeSessionFileBase,
  writeFileAtomic,
  pruneMapLRU,
  touchMapLRU,
  cleanupStaleCanvasFiles,
  buildRunSummarySnapshot,
  abortSessionRun,
  runPlan,
  executePlan,
};
