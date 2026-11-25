/**
 * Zero-token run summary snapshots and long-term disk/memory LRU hygiene
 * for dsh-workflow-canvas.
 */
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MAX_STORED_SESSIONS = 100;
export const MAX_LAST_RUNS = 50;
export const MAX_CHILD_SLOTS = 400;
export const STALE_CANVAS_FILE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const STALE_TMP_FILE_MS = 60 * 60 * 1000; // 1 hour for orphaned atomic-write temps
const CLEANUP_THROTTLE_MS = 60 * 60 * 1000; // 1 hour per workspace

const lastCleanupByDir = new Map();
let atomicTmpSeq = 0;

/**
 * Sanitize a sessionId for safe use as a filename stem inside `.dsh/canvas/`.
 * Leaves standard `session-<uuid>` ids untouched while preventing path traversal
 * (`..`, `/`, `\`), Windows-illegal characters (`:`, `*`, `?`, `"`, `<`, `>`, `|`),
 * and Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
 */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
export function safeSessionFileBase(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return '';
  let cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\.+/g, '_').replace(/^\.+/, '_');
  if (WIN_RESERVED_RE.test(cleaned)) cleaned = '_' + cleaned;
  return cleaned.slice(0, 180);
}

/**
 * Atomically write UTF-8 text to `targetPath` via a unique same-directory temp file
 * and `renameSync`, preventing torn JSON reads during concurrent polling or crashes.
 * Falls back to direct write only on Windows transient rename locks (`EPERM`/`EBUSY`/`EACCES`),
 * always cleaning up the temp file on failure.
 */
export function writeFileAtomic(targetPath, content) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  atomicTmpSeq = (atomicTmpSeq + 1) % 1_000_000;
  const tmp = targetPath + '.' + process.pid + '.' + atomicTmpSeq + '.tmp';
  try {
    writeFileSync(tmp, content, 'utf8');
    try {
      renameSync(tmp, targetPath);
    } catch (renameErr) {
      const code = renameErr && renameErr.code;
      try { unlinkSync(tmp); } catch (_u) { /* best-effort cleanup */ }
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        writeFileSync(targetPath, content, 'utf8');
        return;
      }
      throw renameErr;
    }
  } catch (err) {
    try { unlinkSync(tmp); } catch (_u) { /* best-effort cleanup */ }
    throw err;
  }
}

/** Evict oldest insertion-order entries from a Map until size <= limit. */
export function pruneMapLRU(map, limit) {
  if (!(map instanceof Map) || !Number.isFinite(limit) || limit < 0) return 0;
  let evicted = 0;
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
    evicted += 1;
  }
  return evicted;
}

/** Insert or refresh a key at the tail of a Map and enforce the LRU size cap. */
export function touchMapLRU(map, key, value, limit) {
  if (!(map instanceof Map)) return;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (Number.isFinite(limit) && limit >= 0) pruneMapLRU(map, limit);
}

/**
 * Periodically remove orphaned `.dsh/canvas/*.json` and `*.run.json` files older than
 * `maxAgeMs` so workspaces do not accumulate stale telemetry files over months of use.
 * Throttled to once per hour per directory unless `opts.force === true`.
 */
export function cleanupStaleCanvasFiles(dir, opts) {
  if (!dir || typeof dir !== 'string') return 0;
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const maxAgeMs = typeof o.maxAgeMs === 'number' ? o.maxAgeMs : STALE_CANVAS_FILE_MS;
  const activeIds = o.activeIds instanceof Set ? o.activeIds : new Set();
  if (!o.force) {
    const prev = lastCleanupByDir.get(dir) || 0;
    if (now - prev < CLEANUP_THROTTLE_MS) return 0;
  }
  touchMapLRU(lastCleanupByDir, dir, now, 64);
  let removed = 0;
  try {
    const names = readdirSync(dir);
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.isFile() && now - st.mtimeMs > STALE_TMP_FILE_MS) {
            unlinkSync(full);
            removed += 1;
          }
        } catch (_e) { /* best-effort per file */ }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const base = name.endsWith('.run.json')
        ? name.slice(0, -'.run.json'.length)
        : name.slice(0, -'.json'.length);
      if (activeIds.has(base)) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
          unlinkSync(full);
          removed += 1;
        }
      } catch (_e) { /* best-effort per file */ }
    }
  } catch (_e) { /* directory absent or unreadable */ }
  return removed;
}

/**
 * Build a zero-token structured run summary snapshot from in-memory executor state.
 * Published inside `.run.json` for the sidebar UI (never injected into model prompts).
 */
export function buildRunSummarySnapshot(st, opts) {
  if (!st || typeof st !== 'object') return null;
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const status = typeof o.status === 'string' && o.status ? o.status : 'running';
  const waitingLead = o.waitingLead || st.waitingLead || null;
  const haltedReason = typeof o.haltedReason === 'string' && o.haltedReason
    ? o.haltedReason
    : (st.haltedReason || '');
  const isTerminal = status === 'done' || status === 'halted';
  const startedAt = typeof st.startedAt === 'number' ? st.startedAt : now;
  const endedAt = isTerminal ? (typeof st.endedAt === 'number' ? st.endedAt : now) : null;
  const nodeStatsMap = st.nodeStats && typeof st.nodeStats === 'object' ? st.nodeStats : {};
  const prunedSet = st.pruned instanceof Set ? st.pruned : new Set(Array.isArray(st.pruned) ? st.pruned : []);
  const decisions = st.decisions && typeof st.decisions === 'object' ? st.decisions : {};
  const failedMap = st.failed && typeof st.failed === 'object' ? st.failed : {};
  const emptyMap = st.emptyOutputs && typeof st.emptyOutputs === 'object' ? st.emptyOutputs : {};
  const nodeMeta = st.nodeMeta && typeof st.nodeMeta === 'object' ? st.nodeMeta : {};
  const orderIds = Array.isArray(st.orderIds) && st.orderIds.length
    ? st.orderIds
    : Object.keys(nodeStatsMap);

  const nodes = [];
  for (const id of orderIds) {
    const meta = nodeMeta[id] || {};
    const stat = nodeStatsMap[id] || null;
    const dec = decisions[id] || null;
    const fail = failedMap[id] || null;
    const isPruned = prunedSet.has(id);
    const isWaiting = Boolean(status === 'need-lead' && waitingLead && waitingLead.id === id);

    let entryStatus = 'pending';
    let durationMs = stat && typeof stat.durationMs === 'number' ? stat.durationMs : 0;
    let entryStartedAt = stat && typeof stat.startedAt === 'number' ? stat.startedAt : null;
    let entryEndedAt = stat && typeof stat.endedAt === 'number' ? stat.endedAt : null;

    if (isPruned && (!stat || stat.status === 'pending' || stat.status === 'pruned')) {
      entryStatus = 'pruned';
    } else if (isWaiting) {
      entryStatus = 'waiting';
    } else if (stat && stat.status) {
      entryStatus = stat.status;
      if (status === 'halted' && (entryStatus === 'running' || entryStatus === 'waiting')) {
        entryStatus = 'halted';
        if (entryStartedAt && !entryEndedAt) {
          durationMs += Math.max(0, now - entryStartedAt);
          entryEndedAt = now;
        }
      }
    } else if (fail) {
      entryStatus = 'failed';
    } else if (emptyMap[id]) {
      entryStatus = 'empty';
    }

    let reason = (stat && typeof stat.reason === 'string' ? stat.reason : '') || (fail && fail.reason) || '';
    if (!reason && dec) {
      const matched = Array.isArray(dec.branchLabels) && dec.branchLabels.length
        ? dec.branchLabels.join(', ')
        : (dec.branchLabel || dec.branch || '');
      const decReason = typeof dec.reason === 'string' ? dec.reason.trim() : '';
      reason = matched ? (decReason ? matched + ' — ' + decReason : matched) : decReason;
    }
    if (reason.length > 160) reason = reason.slice(0, 159) + '…';

    nodes.push({
      id,
      label: (stat && stat.label) || meta.label || (st.labels && st.labels[id]) || id,
      kind: (stat && stat.kind) || meta.kind || 'agent',
      status: entryStatus,
      startedAt: entryStartedAt,
      endedAt: entryEndedAt,
      durationMs,
      runs: stat && typeof stat.runs === 'number' ? stat.runs : 0,
      model: (stat && stat.model) || meta.model || '',
      fallbackUsed: Boolean(stat && stat.fallbackUsed),
      sessionContinued: Boolean(stat && stat.sessionContinued),
      childId: (stat && stat.childId) || '',
      reason,
    });
  }

  const loopMeta = Array.isArray(st.loopMeta) ? st.loopMeta : [];
  const loopCounts = st.loopCounts && typeof st.loopCounts === 'object' ? st.loopCounts : {};
  const loopHistory = st.loopHistory && typeof st.loopHistory === 'object' ? st.loopHistory : {};
  const exhaustedMap = new Map();
  if (Array.isArray(st.loopExhausted)) {
    for (const x of st.loopExhausted) {
      if (x && x.edgeKey) exhaustedMap.set(x.edgeKey, x);
    }
  }
  const loops = [];
  for (const lm of loopMeta) {
    const used = Number(loopCounts[lm.key]) || 0;
    const max = Math.max(1, Number(lm.max) || 3);
    const rawRounds = Array.isArray(loopHistory[lm.key]) ? loopHistory[lm.key] : [];
    const exInfo = exhaustedMap.get(lm.key) || null;
    const exhausted = Boolean(exInfo);
    const globalLimit = exInfo && typeof exInfo.globalLimit === 'number' && exInfo.globalLimit > 0
      ? exInfo.globalLimit
      : 0;
    const members = Array.isArray(lm.members) ? lm.members : [];
    const active = used > 0 || exhausted || rawRounds.length > 0 || members.some((mid) => {
      const ms = nodeStatsMap[mid];
      return Boolean(ms && ((typeof ms.runs === 'number' && ms.runs > 0) || ms.status === 'running' || ms.status === 'waiting' || ms.status === 'done'));
    });
    loops.push({
      key: lm.key,
      fromLabel: lm.fromLabel,
      toLabel: lm.toLabel,
      used,
      max,
      round: active ? (used + 1) : 0,
      totalRounds: max + 1,
      active,
      exhausted,
      ...(globalLimit ? { globalLimit } : {}),
      rounds: rawRounds.map((r) => ({
        round: r.round,
        reason: typeof r.reason === 'string' && r.reason.length > 140 ? r.reason.slice(0, 139) + '…' : (r.reason || ''),
      })),
    });
  }

  return {
    status,
    startedAt,
    endedAt,
    haltedReason,
    maxParallel: typeof st.maxParallel === 'number' ? st.maxParallel : 4,
    totalLoops: typeof st.totalLoops === 'number' ? st.totalLoops : 0,
    reused: Array.isArray(st.reusedIds) ? st.reusedIds.slice() : [],
    nodes,
    loops,
  };
}
