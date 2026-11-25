/**
 * Pure graph, prompt, condition-routing, loop-validation, and schema helpers
 * for dsh-workflow-canvas. Zero filesystem or host-runtime dependencies.
 */

export const MAX_LOOP_ITERATIONS = 10;
export const DEFAULT_LOOP_ITERATIONS = 3;
export const MAX_GLOBAL_LOOPS = 20;
export const MAX_UPSTREAM_CHARS = 16000;
export const MAX_UPSTREAM_JSON_CHARS = 24000;

/** The entry Lead is a task container, never a runnable node. */
export function withoutEntry(nodes) {
  return (nodes || []).filter((n) => n.id !== 'lead');
}

export function parsePayload(rawInput) {
  const text = String(rawInput || '').trim();
  if (!text) return { enabled: false };
  try {
    const parsed = JSON.parse(decodeURIComponent(text));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { enabled: false, error: '画布数据格式无效：顶层必须是 JSON 对象' };
    }
    return parsed;
  } catch (err) {
    const detail = err && err.message ? '：' + String(err.message).slice(0, 120) : '';
    return { enabled: false, error: '画布数据解析失败' + detail };
  }
}

export function normalizeMaxIterations(val) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
    return DEFAULT_LOOP_ITERATIONS;
  }
  const n = Number(val);
  if (!Number.isFinite(n)) return DEFAULT_LOOP_ITERATIONS;
  return Math.max(1, Math.min(MAX_LOOP_ITERATIONS, Math.floor(n)));
}

export function isLoopEdge(e) {
  return Boolean(e && e.loop === true);
}

export function forwardEdgesOf(edges) {
  return (Array.isArray(edges) ? edges : []).filter((e) => e && !e.loop);
}

/**
 * Compute the set of node ids strictly inside a controlled loop edge (from target -> ... -> source)
 * over forward edges: `descendants(loopEdge.to) ∩ ancestors(loopEdge.from)` (inclusive).
 * Returns an empty Set if `loopEdge.from` is not a strict descendant of `loopEdge.to` over forward edges.
 */
export function loopMemberIds(nodes, edges, loopEdge) {
  if (!loopEdge || !loopEdge.from || !loopEdge.to || loopEdge.to === 'lead' || loopEdge.from === loopEdge.to) {
    return new Set();
  }
  const fwd = new Map();
  const rev = new Map();
  for (const e of forwardEdgesOf(edges)) {
    if (!e.from || !e.to) continue;
    if (!fwd.has(e.from)) fwd.set(e.from, []);
    fwd.get(e.from).push(e.to);
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to).push(e.from);
  }
  const desc = new Set([loopEdge.to]);
  const q1 = [loopEdge.to];
  for (let i = 0; i < q1.length; i += 1) {
    for (const next of fwd.get(q1[i]) || []) {
      if (!desc.has(next)) { desc.add(next); q1.push(next); }
    }
  }
  if (!desc.has(loopEdge.from)) return new Set();
  const anc = new Set([loopEdge.from]);
  const q2 = [loopEdge.from];
  for (let i = 0; i < q2.length; i += 1) {
    for (const prev of rev.get(q2[i]) || []) {
      if (!anc.has(prev)) { anc.add(prev); q2.push(prev); }
    }
  }
  const members = new Set();
  for (const id of desc) {
    if (anc.has(id)) members.add(id);
  }
  return members;
}

/** Kahn topological order over every plan node (ignoring controlled loop back-edges). */
export function orderNodes(plan) {
  const nodes = plan.nodes || [];
  const edges = forwardEdgesOf(plan.edges || []);
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
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    out.push(byId.get(id));
    for (const next of adj.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return out.length === nodes.length ? out : null;
}

export function upstreamOf(plan, node) {
  const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
  return forwardEdgesOf(plan.edges || [])
    .filter((e) => e.to === node.id)
    .map((e) => ({ edge: e, from: byId.get(e.from) }))
    .filter((x) => x.from);
}

export function downstreamLabels(plan, node) {
  const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
  return forwardEdgesOf(plan.edges || [])
    .filter((e) => e.from === node.id)
    .map((e) => (byId.get(e.to) || {}).label)
    .filter(Boolean);
}

export function normalizeKind(rawKind) {
  if (rawKind === 'lead') return 'lead';
  if (rawKind === 'condition') return 'condition';
  return 'agent';
}

/**
 * Normalize a reference list (paths, URLs, or rules attached to a node or entry Lead).
 * Accepts string arrays or `{ text | path }` objects; capped at 16 unique non-empty items.
 */
export function normalizeRefs(rawRefs) {
  if (!Array.isArray(rawRefs) || !rawRefs.length) return null;
  const out = [];
  const seen = new Set();
  for (const raw of rawRefs) {
    if (out.length >= 16) break;
    let s = '';
    if (typeof raw === 'string') s = raw.trim();
    else if (raw && typeof raw === 'object') {
      s = String(raw.text !== undefined ? raw.text : (raw.path !== undefined ? raw.path : '')).trim();
    }
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length ? out : null;
}

export function normalizeBranch(rawBranch) {
  if (rawBranch === true) return 'true';
  if (rawBranch === false) return 'false';
  if (typeof rawBranch !== 'string') return '';
  return rawBranch.trim();
}

const DEFAULT_BINARY_BRANCHES = [
  { id: 'true', label: '是' },
  { id: 'false', label: '否' },
];

/**
 * Normalize a condition node's branch list (2–16 entries).
 * Accepts either string arrays (e.g. `['通过', '小修', '重做']`) or `{ id, label }` objects.
 * Returns `null` when the node uses the default binary `true`/`false` pair.
 */
export function normalizeBranches(rawBranches) {
  if (!Array.isArray(rawBranches) || rawBranches.length < 2) return null;
  const out = [];
  const used = new Set();
  for (let i = 0; i < Math.min(16, rawBranches.length); i += 1) {
    const item = rawBranches[i];
    let id = '';
    let label = '';
    if (typeof item === 'string') {
      label = item.trim();
      id = label;
    } else if (item && typeof item === 'object') {
      id = typeof item.id === 'string' ? item.id.trim() : '';
      label = typeof item.label === 'string' ? item.label.trim() : '';
      if (!id) id = label;
      if (!label) label = id;
    }
    if (!id) id = 'case_' + (i + 1);
    if (!label) label = '分支 ' + (i + 1);
    let uniq = id;
    let suffix = 2;
    while (used.has(uniq)) { uniq = id + '_' + suffix; suffix += 1; }
    used.add(uniq);
    out.push({ id: uniq, label });
  }
  return out.length >= 2 ? out : null;
}

export function conditionBranches(node) {
  const custom = normalizeBranches(node && node.branches);
  const multiMatch = Boolean(node && node.multiMatch);
  if (custom) return { branches: custom, isDefaultBinary: false, multiMatch };
  return { branches: DEFAULT_BINARY_BRANCHES, isDefaultBinary: !multiMatch, multiMatch };
}

export function edgeKey(e) {
  return String(e.from) + '->' + String(e.to) + '|' + String(e.type || 'prompt') + '|' + String(e.branch || '');
}

/**
 * Scan text for valid top-level JSON objects: fenced ```json blocks first, then
 * balanced `{...}` spans (skipping string literals and escapes). Handles multi-JSON
 * prose where an upstream JSON snippet precedes the final verdict object.
 */
export function extractJsonObjects(text) {
  const raw = String(text || '');
  const out = [];
  if (!raw.includes('{')) return out;
  const fencedRe = /```(?:json(?:\s+canvas)?)?\s*\r?\n([\s\S]*?)```/gi;
  let fm;
  while ((fm = fencedRe.exec(raw)) !== null) {
    const body = fm[1].trim();
    if (!body.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
    } catch (_e) { /* ignore malformed fence */ }
  }
  const balanced = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) balanced.push(parsed);
        } catch (_e) { /* ignore non-JSON brace pair */ }
        start = -1;
      }
    }
  }
  // Prefer later balanced objects (final verdict usually appears after quoted upstream snippets).
  for (let i = balanced.length - 1; i >= 0; i -= 1) out.push(balanced[i]);
  return out;
}

/**
 * Extract a strict JSON object from plain text (used to rescue DSH 0.2.2 `completed -> error`
 * rewrites on structured-output nodes that replied with valid JSON text directly).
 */
export function parseStrictJsonObject(text) {
  const objs = extractJsonObjects(text);
  return objs.length ? objs[0] : null;
}

/**
 * Parse ONLY an explicit JSON verdict (`{ pass }`, `{ branches }`, or `{ branch }`) from text.
 * Returns `null` if no strict JSON verdict object is found (no loose natural-language fallback).
 * Used to rescue DSH 0.2.2 `activation.ts` `completed -> error` rewrites when a minimal judge
 * answered with valid JSON text directly instead of calling the `structured_output` tool.
 */
export function parseStrictConditionJson(text, nodeOrBranches) {
  const { branches, isDefaultBinary, multiMatch } = Array.isArray(nodeOrBranches)
    ? { branches: normalizeBranches(nodeOrBranches) || DEFAULT_BINARY_BRANCHES, isDefaultBinary: !normalizeBranches(nodeOrBranches), multiMatch: false }
    : conditionBranches(nodeOrBranches);

  const resolveByToken = (token) => {
    const t = String(token || '').trim();
    if (!t) return null;
    const exactId = branches.find((b) => b.id === t);
    if (exactId) return exactId;
    const exactLabel = branches.find((b) => b.label === t);
    if (exactLabel) return exactLabel;
    const lower = t.toLowerCase();
    return branches.find((b) => b.id.toLowerCase() === lower || b.label.toLowerCase() === lower) || null;
  };

  const makeDecision = (pickedList, reason) => {
    const seen = new Set();
    const uniq = [];
    for (const item of pickedList) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      uniq.push(item);
    }
    const finalList = multiMatch ? uniq : uniq.slice(0, 1);
    const first = finalList[0] || null;
    return {
      branches: finalList.map((b) => b.id),
      branchLabels: finalList.map((b) => b.label),
      branch: first ? first.id : '',
      branchLabel: first ? first.label : '',
      pass: isDefaultBinary ? Boolean(first && first.id === 'true') : finalList.length > 0,
      reason: String(reason || ''),
    };
  };

  for (const obj of extractJsonObjects(text)) {
    if (Array.isArray(obj.branches)) {
      return makeDecision(obj.branches.map(resolveByToken).filter(Boolean), obj.reason);
    }
    if (typeof obj.branch === 'string') {
      const trimmed = obj.branch.trim();
      if (!trimmed || /^(none|null|无|都不满足|未命中)$/i.test(trimmed)) {
        return makeDecision([], obj.reason);
      }
      const hit = resolveByToken(trimmed);
      if (hit) return makeDecision([hit], obj.reason);
    }
    if (typeof obj.pass === 'boolean') {
      const picked = obj.pass ? branches[0] : branches[branches.length - 1];
      return makeDecision([picked], obj.reason);
    }
  }
  return null;
}

/**
 * Parse a condition node's structured or text output into
 * `{ branches, branchLabels, branch, branchLabel, pass, reason }`.
 */
export function parseConditionDecision(result, fallbackText, nodeOrBranches) {
  const { branches, isDefaultBinary, multiMatch } = Array.isArray(nodeOrBranches)
    ? { branches: normalizeBranches(nodeOrBranches) || DEFAULT_BINARY_BRANCHES, isDefaultBinary: !normalizeBranches(nodeOrBranches), multiMatch: false }
    : conditionBranches(nodeOrBranches);

  const resolveByToken = (token) => {
    const t = String(token || '').trim();
    if (!t) return null;
    const exactId = branches.find((b) => b.id === t);
    if (exactId) return exactId;
    const exactLabel = branches.find((b) => b.label === t);
    if (exactLabel) return exactLabel;
    const lower = t.toLowerCase();
    const ci = branches.find((b) => b.id.toLowerCase() === lower || b.label.toLowerCase() === lower);
    return ci || null;
  };

  const makeDecision = (pickedList, reason) => {
    const seen = new Set();
    const uniq = [];
    for (const item of pickedList) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      uniq.push(item);
    }
    const finalList = multiMatch ? uniq : uniq.slice(0, 1);
    const first = finalList[0] || null;
    return {
      branches: finalList.map((b) => b.id),
      branchLabels: finalList.map((b) => b.label),
      branch: first ? first.id : '',
      branchLabel: first ? first.label : '',
      pass: isDefaultBinary ? Boolean(first && first.id === 'true') : finalList.length > 0,
      reason: String(reason || ''),
    };
  };

  const tryObj = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj.branches)) {
      const hits = obj.branches.map(resolveByToken).filter(Boolean);
      return makeDecision(hits, obj.reason);
    }
    if (typeof obj.branch === 'string') {
      const trimmed = obj.branch.trim();
      if (!trimmed || /^(none|null|无|都不满足|未命中)$/i.test(trimmed)) {
        return makeDecision([], obj.reason);
      }
      const hit = resolveByToken(trimmed);
      if (hit) return makeDecision([hit], obj.reason);
    }
    if (typeof obj.pass === 'boolean') {
      const picked = obj.pass ? branches[0] : branches[branches.length - 1];
      return makeDecision([picked], obj.reason);
    }
    return null;
  };

  const fromStructured = tryObj(result && result.structured);
  if (fromStructured) return fromStructured;

  const raw = String(fallbackText || '').trim();
  for (const obj of extractJsonObjects(raw)) {
    const fromJson = tryObj(obj);
    if (fromJson) return fromJson;
  }

  if (isDefaultBinary) {
    // Separate ASCII and CJK boundary checks because JS `\b` only matches ASCII word boundaries.
    if (/^(?:(?:true|yes|pass)(?![a-z0-9_])|(?:通过|是)(?=$|[\s，。、：:！!,.\-—]))/i.test(raw)) {
      return makeDecision([branches[0]], clipSafeSlice(raw, 200));
    }
    return makeDecision([branches[1]], clipSafeSlice(raw, 200) || '未能解析布尔判断，默认走「否」分支');
  }

  // Multi-way text fallback: collect matching branch ids/labels; return empty [] if none match.
  const lowerRaw = raw.toLowerCase();
  const matched = [];
  for (const b of branches) {
    if (lowerRaw.includes(b.id.toLowerCase()) || lowerRaw.includes(b.label.toLowerCase())) {
      matched.push(b);
      if (!multiMatch) break;
    }
  }
  return makeDecision(matched, clipSafeSlice(raw, 200) || (matched.length ? '' : '未命中任何分支，已跳过后续分支'));
}

/** UTF-16 surrogate-safe prefix truncation (never splits emoji / CJK Ext-B surrogate pairs). */
export function clipSafeSlice(text, maxLen, suffix = '') {
  const s = typeof text === 'string' ? text : '';
  if (!Number.isFinite(maxLen) || maxLen <= 0 || s.length <= maxLen) return s;
  let end = Math.floor(maxLen);
  if (end > 0 && end < s.length) {
    const hi = s.charCodeAt(end - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) end -= 1;
  }
  return s.slice(0, end) + suffix;
}

/**
 * Guard downstream context budgets against verbose upstream logs by preserving both
 * the head (conclusions/summary) and tail (final errors/results) when exceeding maxChars.
 */
export function clipUpstreamOutput(body, maxChars = MAX_UPSTREAM_CHARS) {
  const text = typeof body === 'string' ? body : '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  let headEnd = Math.floor(maxChars * 0.68);
  let tailStart = text.length - Math.floor(maxChars * 0.25);
  // Never slice through a UTF-16 surrogate pair (emoji / CJK Ext-B); strict UTF-8 gateways reject lone surrogates.
  if (headEnd > 0 && headEnd < text.length) {
    const hi = text.charCodeAt(headEnd - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) headEnd -= 1;
  }
  if (tailStart > 0 && tailStart < text.length) {
    const lo = text.charCodeAt(tailStart);
    if (lo >= 0xdc00 && lo <= 0xdfff) tailStart += 1;
  }
  const omitted = tailStart - headEnd;
  const minOmit = Math.min(200, Math.max(60, Math.floor(maxChars * 0.25)));
  if (omitted <= minOmit) return text;
  return text.slice(0, headEnd)
    + '\n\n…[已折叠中间 ' + omitted + ' 字以节省 Token，完整内容可查看上游子代理会话]…\n\n'
    + text.slice(tailStart);
}

export function briefFor(plan, node, results, failedMap, prunedSet, loopCtx) {
  const ups = upstreamOf(plan, node).filter((u) => !(prunedSet && prunedSet.has(u.from.id)));
  const downs = downstreamLabels(plan, node);
  const head = [];
  if (node.kind === 'condition') {
    const outEdges = (plan.edges || []).filter((e) => e.from === node.id);
    const byId = new Map((plan.nodes || []).map((n) => [n.id, n]));
    const { branches, isDefaultBinary, multiMatch } = conditionBranches(node);
    const fmtTarget = (e) => {
      const lbl = (byId.get(e.to) || {}).label || e.to;
      return e.loop ? (lbl + '（↺ 回环重做，最多 ' + normalizeMaxIterations(e.maxIterations) + ' 次）') : lbl;
    };
    head.push('【工作流条件判断节点】你负责判断当前工作流接下来走哪条分支（「' + node.label + '」）。');
    head.push('【总任务】' + plan.task);
    if (isDefaultBinary) {
      const yesTargets = outEdges.filter((e) => (normalizeBranch(e.branch) || 'true') === 'true').map(fmtTarget);
      const noTargets = outEdges.filter((e) => normalizeBranch(e.branch) === 'false').map(fmtTarget);
      head.push('【判断条件】' + (node.role || '判断上游步骤是否执行成功并达到预期；成功返回 true，失败或未达标返回 false。'));
      head.push('【分支去向】pass=true（是）→ ' + (yesTargets.join('、') || '（无）') + '；pass=false（否）→ ' + (noTargets.join('、') || '（无）'));
      head.push('【要求】严格依据上游实际输出（含成功/失败状态与【未完全交付】标记）做出客观判断，只返回 JSON 对象 {"pass": true/false, "reason": "一句话理由"}。');
    } else {
      const branchLines = branches.map((b, idx) => {
        const targets = outEdges
          .filter((e) => {
            const eb = normalizeBranch(e.branch);
            return eb ? eb === b.id : idx === 0;
          })
          .map(fmtTarget);
        const tag = b.label === b.id ? '"' + b.id + '"' : '"' + b.id + '"（' + b.label + '）';
        return '- ' + tag + ' → ' + (targets.join('、') || '（无下游）');
      });
      head.push('【判断规则】' + (node.role || (multiMatch
        ? '根据上游结果选出所有满足条件的分支（可多选并行）；若均不满足返回空数组。'
        : '根据上游结果选出最匹配的一条分支；若均不满足返回空数组（如有「其他/兜底」分支则选它）。')));
      head.push('【匹配模式】' + (multiMatch
        ? '多选并行（可返回 0 条、1 条或多条分支 id）'
        : '单选分流（最多返回 1 条最匹配的分支 id；均不满足返回空数组 []）'));
      head.push('【可选分支】\n' + branchLines.join('\n'));
      head.push('【要求】严格依据上游实际输出（含成功/失败状态与【未完全交付】标记）做出客观判断，只返回 JSON 对象 {"branches": ["<分支id>"], "reason": "一句话理由"}；若没有任何分支满足，返回 {"branches": [], "reason": "..."}。');
    }
  } else {
    head.push('【工作流节点】你在一个多步工作流里负责「' + node.label + '」这一步（子代理）。');
    if (ups.length === 0) head.push('【总任务】' + plan.task);
    head.push('【职责】' + (node.role || node.label));
    if (ups.length) head.push('【上游】' + ups.map((u) => u.from.label).join('、') + ' 已交付结果给你（见下文）。');
    head.push('【下游】' + (downs.length ? downs.join('、') + ' 会使用你的输出。' : '你是终点，结果会直接交付给用户。'));
    head.push('【要求】只完成你这一步；最终回复只输出简洁、可直接被下游或 Lead 消费的交付报告（结论、改动清单、关键接口/路径），不要包含思考独白、过程叙述或对其他并行节点的评价。若因环境或权限受限未能生成预期产物，必须在开头显式标注「【未完全交付】」并列出缺失项，不得把仅写脚本汇报为已完成。');
  }
  const mergedRefs = [];
  const seenRefs = new Set();
  for (const r of (normalizeRefs(plan && plan.refs) || []).concat(normalizeRefs(node && node.refs) || [])) {
    if (!seenRefs.has(r)) { seenRefs.add(r); mergedRefs.push(r); }
  }
  if (mergedRefs.length) {
    head.push('【参考资料 / 约束】\n' + mergedRefs.map((r) => '- ' + r).join('\n'));
  }
  if (loopCtx && loopCtx.feedback) {
    const fb = loopCtx.feedback;
    const lines = [
      '【第 ' + fb.retry + '/' + fb.max + ' 次回环修正反馈】下游条件节点「' + (fb.sourceLabel || '条件判断') + '」判定上一轮未通过，请针对以下问题修正后输出最新结果：',
      '- 打回理由：' + (fb.reason || '未达预期'),
    ];
    if (fb.lastSummary) lines.push('- 上一轮环内参考摘要：\n' + fb.lastSummary);
    head.push(lines.join('\n'));
  }
  let text = head.join('\n') + '\n';
  for (const u of ups) {
    const value = results[u.from.id];
    const type = u.edge.type || 'prompt';
    const rawBody = typeof value === 'string' ? value : '（没有结果）';
    const body = clipUpstreamOutput(rawBody, type === 'structured' ? MAX_UPSTREAM_JSON_CHARS : MAX_UPSTREAM_CHARS);
    const failInfo = failedMap && failedMap[u.from.id];
    const warn = failInfo
      ? '【警告：该上游节点执行失败（' + (failInfo.reason || 'unknown') + '），请勿将其报错当作正常结论，必要时说明受阻情况】\n'
      : '';
    if (type === 'structured') {
      const jsonNote = body !== rawBody
        ? '（JSON，超长已头尾折叠，完整数据见上游会话）'
        : '（JSON，可直接解析）';
      text += '\n## 来自【' + u.from.label + '】的数据' + jsonNote + '\n' + warn + '```json\n'
        + body + '\n```\n';
    } else if (type === 'session-ref') {
      text += '\n## 来自【' + u.from.label + '】的会话引用（当前按文本传递）\n' + warn
        + body + '\n';
    } else {
      text += '\n## 来自【' + u.from.label + '】\n' + warn + body + '\n';
    }
  }
  return text;
}

export function extractResultError(result) {
  if (!result || typeof result !== 'object') return '';
  // DSH 0.2.2 SubagentResult stores failure details in `diagnostic` (<=4096 UTF-8 bytes);
  // keep legacy/custom candidates as fallback for third-party providers or tests.
  const candidates = [result.diagnostic, result.error, result.errorMessage, result.message, result.failureReason];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (raw && typeof raw === 'object') {
      const msg = raw.message || raw.detail || raw.code;
      if (typeof msg === 'string' && msg.trim()) return msg.trim();
      try {
        const s = JSON.stringify(raw);
        if (s && s !== '{}') return s.slice(0, 240);
      } catch (_e) { /* ignore */ }
    }
  }
  return '';
}

export function textOf(result) {
  // A structured node's canonical value is its parsed object, not the prose.
  if (result && result.structured !== undefined) {
    try {
      return JSON.stringify(result.structured);
    } catch (_e) {
      /* fall through to prose */
    }
  }
  const blocks = (result && result.output) || [];
  const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  if (text) return text;
  const errDetail = extractResultError(result);
  const stop = (result && result.stopReason) || (errDetail ? 'error' : 'no-output');
  return errDetail ? '[' + stop + '] ' + errDetail : '[' + stop + ']';
}

export function failed(result) {
  const reason = result && result.stopReason;
  return reason !== undefined && reason !== 'completed';
}

export function isEmptyOutput(result) {
  if (result && result.structured !== undefined) return false;
  const blocks = (result && result.output) || [];
  const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return text.trim().length === 0;
}

export function buildLoopWarmPrompt(node, loopCtx) {
  const fb = loopCtx && loopCtx.feedback;
  if (!fb) return null;
  const lines = [
    '【第 ' + fb.retry + '/' + fb.max + ' 次回环修正】下游条件节点「' + (fb.sourceLabel || '条件判断') + '」判定上一轮未通过，请结合以下反馈直接在当前会话上下文中修正并输出最新交付结果（无需重复叙述过程）：',
    '- 打回理由：' + (fb.reason || '未达预期'),
  ];
  if (fb.lastSummary) lines.push('- 上一轮环内参考摘要：\n' + fb.lastSummary);
  if (node.role) lines.push('- 你的职责提醒：' + node.role);
  return lines.join('\n');
}

export function formatModelLabel(provider, model) {
  const p = typeof provider === 'string' ? provider.trim() : '';
  const m = typeof model === 'string' ? model.trim() : '';
  if (p && m) return p + '/' + m;
  return m || p || '';
}

/** Detect permission / sandbox denial outcomes so we can circuit-break before burning downstream tokens. */
const PERMISSION_ERR_RE = /permission denied|access is denied|sandbox-local|windows-acl|win32error|eacces|eperm|approval required|not permitted|拒绝访问|权限不足|无权执行|沙箱拒绝/i;
export function isPermissionFailure(outcome) {
  if (!outcome) return false;
  const text = String(outcome.text || '');
  const detail = String(outcome.errorDetail || '');
  if (!outcome.ok && (PERMISSION_ERR_RE.test(text) || PERMISSION_ERR_RE.test(detail))) return true;
  if (text.includes('【未完全交付】') && PERMISSION_ERR_RE.test(text)) return true;
  return false;
}

/**
 * Detect clearly transient network / upstream gateway / rate-limit errors suitable
 * for a single short backoff retry on strictly read-only (`minimal` / `condition`) nodes.
 * Aligned with DSH 0.2.2-rc.5 stopReason enum ('completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'):
 * excludes max-tokens/refusal/aborted and requires HTTP/status context around 429/502/503/504
 * so stack-trace line numbers (e.g. `app.js:502:10`) never false-trigger.
 */
const TRANSIENT_ERR_RE = /(?:http[\s/]*|status[\s:=]*|code[\s:=]*|error[\s:=]*|^)(429|502|503|504)\b|rate[\s_-]?limit|too many requests|timed?\s*out|econnreset|etimedout|econnrefused|socket hang up|overloaded|temporarily unavailable|bad gateway|service unavailable|network error|请求过于频繁|限流|超时|网关错误/i;
const TRANSIENT_ELIGIBLE_REASONS = new Set(['', 'error', 'run-failed', 'timeout']);
export function isTransientFailure(outcome) {
  if (!outcome || outcome.ok) return false;
  const reason = typeof outcome.reason === 'string' ? outcome.reason.trim().toLowerCase() : '';
  if (!TRANSIENT_ELIGIBLE_REASONS.has(reason) || isPermissionFailure(outcome)) return false;
  const detail = typeof outcome.errorDetail === 'string' ? outcome.errorDetail.trim() : '';
  if (detail) return detail.length <= 1000 && TRANSIENT_ERR_RE.test(detail);
  const text = typeof outcome.text === 'string' ? outcome.text.trim() : '';
  if (!text || text.length > 500) return false;
  return TRANSIENT_ERR_RE.test(text);
}

/** Ids reachable from the entry Lead via O(V + E) BFS over forward edges; every other node is skipped at run time. */
export function reachableFrom(plan) {
  const adj = new Map();
  for (const e of forwardEdgesOf(plan && plan.edges)) {
    if (!e || !e.from || !e.to) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const set = new Set(['lead']);
  const queue = ['lead'];
  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i];
    for (const next of adj.get(cur) || []) {
      if (!set.has(next)) { set.add(next); queue.push(next); }
    }
  }
  return set;
}

/**
 * Classify inactive nodes that are rendered dashed on the canvas and skipped at run time:
 *   - unreachable orphans
 *   - solo chained Leads (zero reachable subagent upstream and blank role)
 *   - dangling dead-end subagents (zero outgoing edges while an active non-ancestor downstream Lead exists)
 */
export function inactiveNodeSets(nodes, edges) {
  const list = withoutEntry(nodes);
  const linkList = Array.isArray(edges) ? edges : [];
  const fwdLinks = forwardEdgesOf(linkList);
  const reachable = reachableFrom({ edges: fwdLinks });
  const byId = new Map(list.map((n) => [n.id, n]));

  const soloLeads = new Set();
  for (const n of list) {
    if (n.kind !== 'lead' || !reachable.has(n.id)) continue;
    const hasAgentUp = fwdLinks.some((e) => {
      if (!e || e.to !== n.id || !reachable.has(e.from) || e.from === 'lead') return false;
      const src = byId.get(e.from);
      return Boolean(src && src.kind !== 'lead');
    });
    const hasRole = Boolean(String(n.role || '').trim());
    if (!hasAgentUp && !hasRole) soloLeads.add(n.id);
  }

  const deadEnds = new Set();
  const activeLeads = list.filter((n) => n.kind === 'lead' && reachable.has(n.id) && !soloLeads.has(n.id));
  if (activeLeads.length) {
    const hasOut = new Set(linkList.map((e) => e.from));
    const parents = new Map();
    for (const e of fwdLinks) {
      if (!parents.has(e.to)) parents.set(e.to, []);
      parents.get(e.to).push(e.from);
    }
    const ancestorsOf = (id) => {
      const seen = new Set();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const p of parents.get(cur) || []) {
          if (!seen.has(p)) { seen.add(p); stack.push(p); }
        }
      }
      return seen;
    };
    for (const n of list) {
      if (n.kind === 'lead' || !reachable.has(n.id) || hasOut.has(n.id)) continue;
      const anc = ancestorsOf(n.id);
      if (activeLeads.some((ln) => !anc.has(ln.id))) deadEnds.add(n.id);
    }
  }
  return { reachable, soloLeads, deadEnds };
}

/**
 * Validate controlled loop edges: each loop edge must leave a condition node, target a strict
 * forward-path ancestor (never entry Lead), and not overlap/cross another loop edge's body.
 */
export function validateLoopEdges(nodes, edges) {
  const list = withoutEntry(nodes);
  const byId = new Map(list.map((n) => [n.id, n]));
  const linkList = Array.isArray(edges) ? edges : [];
  const loopEdges = linkList.filter((e) => isLoopEdge(e));
  const errors = [];
  const seenMembers = new Map();
  for (const le of loopEdges) {
    const src = byId.get(le.from);
    const dst = byId.get(le.to);
    if (!src || src.kind !== 'condition') {
      errors.push('回环边起点必须是条件判断节点（' + le.from + ' → ' + le.to + '）。');
      continue;
    }
    if (!dst || le.to === 'lead') {
      errors.push('回环边不能指向入口 Lead 或不存在的节点（' + le.from + ' → ' + le.to + '）。');
      continue;
    }
    const members = loopMemberIds(list, linkList, le);
    if (!members.size) {
      errors.push('回环边目标「' + (dst.label || dst.id) + '」不是「' + (src.label || src.id) + '」的上游祖先节点。');
      continue;
    }
    let overlap = false;
    for (const mid of members) {
      if (seenMembers.has(mid)) { overlap = true; break; }
    }
    if (overlap) {
      errors.push('检测到交叉或嵌套回环（涉及节点「' + (dst.label || dst.id) + '」），暂不支持交叉回环。');
      continue;
    }
    for (const mid of members) seenMembers.set(mid, le);
  }
  return errors;
}

/**
 * Detect structural warnings on a canvas plan (all classes are rendered
 * dashed on the canvas and skipped at run time).
 */
export function analyzeCanvasWarnings(nodes, edges) {
  const list = withoutEntry(nodes);
  const linkList = Array.isArray(edges) ? edges : [];
  const warnings = [];
  if (!list.length) return warnings;

  const { reachable, soloLeads, deadEnds } = inactiveNodeSets(list, linkList);
  const orphans = list.filter((n) => !reachable.has(n.id));
  if (orphans.length) {
    warnings.push('以下节点未从入口 Lead 连通，运行时会被跳过：'
      + orphans.map((n) => (n.label || n.id) + '(' + n.id + ')').join('、'));
  }
  const soloList = list.filter((n) => soloLeads.has(n.id));
  if (soloList.length) {
    warnings.push('以下 Lead 节点未连入子代理且未填写分工（role），运行时不生效：'
      + soloList.map((n) => (n.label || n.id) + '(' + n.id + ')').join('、'));
  }
  const deadList = list.filter((n) => deadEnds.has(n.id));
  if (deadList.length) {
    warnings.push('以下子代理节点没有出边，产出未连入下游或终审 Lead，运行时不生效：'
      + deadList.map((n) => (n.label || n.id) + '(' + n.id + ')').join('、'));
  }
  if (orderNodes({ nodes: list, edges: linkList }) === null) {
    warnings.push('检测到前向连线存在环路，运行时会拒绝执行；如需条件打回重试，请在条件出边设置 loop: true。');
  }
  for (const err of validateLoopEdges(list, linkList)) warnings.push(err);
  // Warn if a non-exit node inside a loop has a forward edge leaking outside the loop
  // (that outside branch starts on round 1 and will not re-run on retry rounds).
  const fwdLinks = forwardEdgesOf(linkList);
  const byId = new Map(list.map((n) => [n.id, n]));
  for (const le of linkList) {
    if (!isLoopEdge(le)) continue;
    const members = loopMemberIds(list, linkList, le);
    if (!members.size) continue;
    const leaked = [];
    for (const e of fwdLinks) {
      if (e.from !== le.from && members.has(e.from) && !members.has(e.to)) {
        const src = byId.get(e.from);
        const dst = byId.get(e.to);
        leaked.push(((src && src.label) || e.from) + ' → ' + ((dst && dst.label) || e.to));
      }
    }
    if (leaked.length) {
      warnings.push('回环内部节点存在绕过条件裁判的旁路连线（' + leaked.join('、') + '），回环重试时这些环外节点不会重跑。');
    }
  }
  return warnings;
}

/**
 * Turn a model-authored sketch into a canvas document: assign ids, ensure one
 * connected entry Lead, and lay the graph out in columns by depth.
 */
export function normalizeCanvas(args) {
  if (!args || !Array.isArray(args.nodes) || !args.nodes.length) {
    return { error: 'nodes 必须是包含至少一个节点的数组。' };
  }
  const rawNodes = args.nodes;
  const rawEdges = Array.isArray(args.edges) ? args.edges : [];

  const nodes = [];
  const idByRef = new Map();
  const usedIds = new Set();
  const extraWarnings = [];
  let counter = 0;
  let hasExplicitLead = false;
  let badNodes = 0;
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') { badNodes += 1; continue; }
    counter += 1;
    const kind = normalizeKind(raw.kind);
    const wantsEntry = !hasExplicitLead && (raw.id === 'lead' || (raw.entry === true && kind === 'lead'));
    const rawIdStr = typeof raw.id === 'string' ? raw.id.trim() : '';
    let id = wantsEntry
      ? 'lead'
      : (rawIdStr && rawIdStr !== 'lead' ? rawIdStr : 'n' + counter);
    // Avoid whitespace or `#` inside node ids so frontend `NODE_MARK = /#([^\s#]+)$/` never breaks.
    if (id !== 'lead' && /[\s#]/.test(id)) {
      const sanitized = id.replace(/[\s#]+/g, '_').replace(/^_+|_+$/g, '') || ('n' + counter);
      extraWarnings.push('节点 ID「' + id + '」含空白或 #，已自动规范化为「' + sanitized + '」。');
      id = sanitized;
    }
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(id + '_' + suffix)) suffix += 1;
      id = id + '_' + suffix;
    }
    usedIds.add(id);
    if (id === 'lead') hasExplicitLead = true;
    const defaultLabel = kind === 'lead'
      ? 'Lead 步骤 ' + counter
      : (kind === 'condition' ? '条件判断 ' + counter : 'Node ' + counter);
    const label = String(raw.label || defaultLabel);
    const nodeObj = {
      id,
      kind: id === 'lead' ? 'lead' : kind,
      label,
      role: String(raw.role || ''),
      task: String(raw.task || ''),
      provider: String(raw.provider || ''),
      model: String(raw.model || ''),
      reasoning: String(raw.reasoning || ''),
      preset: (id === 'lead' ? '' : (kind === 'condition' ? 'minimal' : (raw.preset === 'minimal' ? 'minimal' : (raw.preset ? 'standard' : '')))),
      structured: Boolean(raw.structured),
      keepSession: Boolean(raw.keepSession),
      fallbackModel: String(raw.fallbackModel || ''),
      fallbackProvider: String(raw.fallbackProvider || ''),
      x: 0,
      y: 0,
    };
    const normRefs = normalizeRefs(raw.refs);
    if (normRefs) nodeObj.refs = normRefs;
    if (nodeObj.kind === 'condition') {
      const customBranches = normalizeBranches(raw.branches);
      if (customBranches) nodeObj.branches = customBranches;
      if (raw.multiMatch === true) nodeObj.multiMatch = true;
    }
    nodes.push(nodeObj);
    if (raw.ref && !idByRef.has(String(raw.ref))) idByRef.set(String(raw.ref), id);
    if (raw.id && !idByRef.has(String(raw.id))) idByRef.set(String(raw.id), id);
    if (rawIdStr && !idByRef.has(rawIdStr)) idByRef.set(rawIdStr, id);
    idByRef.set(id, id);
  }
  if (badNodes > 0) extraWarnings.push('已忽略 ' + badNodes + ' 个非对象节点项。');
  if (!nodes.length) return { error: '节点都无效' };

  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  const droppedEdges = [];
  for (const raw of rawEdges) {
    if (!raw || typeof raw !== 'object') { droppedEdges.push('(无效连线项)'); continue; }
    const from = idByRef.get(String(raw.from)) || String(raw.from);
    const to = idByRef.get(String(raw.to)) || String(raw.to);
    if ((from !== 'lead' && !ids.has(from)) || !ids.has(to) || from === to || to === 'lead') {
      droppedEdges.push(String(raw.from || '?') + ' → ' + String(raw.to || '?'));
      continue;
    }
    const rawType = typeof raw.type === 'string' ? raw.type.trim() : '';
    let type = 'prompt';
    if (rawType === 'prompt' || rawType === 'structured' || rawType === 'session-ref') {
      type = rawType;
    } else if (rawType === 'session') {
      type = 'session-ref';
    } else if (rawType) {
      extraWarnings.push('连线 ' + from + ' → ' + to + ' 的未知类型「' + rawType + '」已按 prompt 处理。');
    }
    const branch = normalizeBranch(raw.branch);
    const edgeObj = { id: 'e' + edges.length, from, to, type };
    if (branch) edgeObj.branch = branch;
    if (raw.loop === true) {
      edgeObj.loop = true;
      edgeObj.maxIterations = normalizeMaxIterations(raw.maxIterations);
    }
    edges.push(edgeObj);
  }

  let entry = nodes.find((n) => n.id === 'lead');
  if (!entry) {
    // If the caller hand-authored a root Lead node (no incoming edges, has outgoing edges)
    // and didn't wire from id='lead', promote it to entry Lead instead of duplicating it.
    const hasLeadEdge = edges.some((e) => e.from === 'lead');
    const inSet = new Set(edges.map((e) => e.to));
    const outSet = new Set(edges.map((e) => e.from));
    const rootLead = !hasLeadEdge
      ? nodes.find((n) => n.kind === 'lead' && !inSet.has(n.id) && outSet.has(n.id))
      : null;
    if (rootLead) {
      const oldId = rootLead.id;
      rootLead.id = 'lead';
      rootLead.task = rootLead.task || String(args.task || '') || rootLead.role;
      rootLead.role = '';
      for (const e of edges) {
        if (e.from === oldId) e.from = 'lead';
      }
      entry = rootLead;
    } else {
      entry = {
        id: 'lead', kind: 'lead', label: 'Lead（本对话）', role: '',
        task: String(args.task || ''), provider: '', model: '', reasoning: '',
        preset: '', structured: false, keepSession: false, fallbackModel: '', fallbackProvider: '',
        x: 0, y: 0,
      };
      nodes.unshift(entry);
    }
  } else if (!entry.task) {
    entry.task = String(args.task || '') || entry.role;
  }
  const topRefs = normalizeRefs(args && args.refs);
  if (topRefs && !entry.refs) entry.refs = topRefs;

  // If entry Lead still has no outgoing edges, auto-wire it to all root nodes so
  // a freshly generated canvas is never dead/unreachable on arrival.
  if (!edges.some((e) => e.from === 'lead')) {
    const hasIn = new Set(edges.map((e) => e.to));
    const roots = nodes.filter((n) => n.id !== 'lead' && !hasIn.has(n.id));
    for (const root of roots) {
      edges.push({ id: 'e' + edges.length, from: 'lead', to: root.id, type: 'prompt' });
    }
  }

  const structuredSources = new Set(edges.filter((e) => e.type === 'structured').map((e) => e.from));
  for (const node of nodes) {
    if (structuredSources.has(node.id)) node.structured = true;
  }

  // Layout: depth of the longest path from the entry (ignoring controlled loop back-edges),
  // stacking each column by estimated card height so tall multi-branch condition nodes never overlap.
  const depth = new Map(nodes.map((n) => [n.id, n.id === 'lead' ? 0 : 1]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const e of forwardEdgesOf(edges)) {
      if (e.to === 'lead') continue;
      const next = Math.min(nodes.length, depth.get(e.from) + 1);
      if (next > depth.get(e.to)) { depth.set(e.to, next); changed = true; }
    }
    if (!changed) break;
  }
  const estHeight = (n) => {
    if (n.kind === 'condition') {
      const bc = Array.isArray(n.branches) && n.branches.length >= 2 ? n.branches.length : 2;
      return Math.max(234, 176 + bc * 20 + 24);
    }
    return 220;
  };
  const colCursorY = new Map();
  for (const node of nodes) {
    const level = depth.get(node.id) || 0;
    const y = colCursorY.has(level) ? colCursorY.get(level) : 80;
    node.x = 60 + level * 300;
    node.y = y;
    colCursorY.set(level, y + estHeight(node) + 40);
  }

  const warnings = [...extraWarnings, ...analyzeCanvasWarnings(nodes, edges)];
  if (droppedEdges.length) {
    warnings.push('以下连线因节点 ID 不存在、自环或指向入口 Lead 已被忽略：' + droppedEdges.join('、'));
  }

  return {
    nodes,
    edges,
    task: String(entry.task || args.task || ''),
    warnings,
  };
}

/**
 * Apply an in-place patch to an existing plan: update/add/remove nodes and
 * edges without losing untouched nodes. Preserves `'lead'` as a valid edge
 * source so newly added branches can wire directly from the entry Lead.
 */
export function applyPatch(plan, args) {
  const nodes = withoutEntry(plan.nodes).map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const STR_FIELDS = ['label', 'role', 'provider', 'model', 'reasoning', 'memoryChildId', 'fallbackModel', 'fallbackProvider'];
  const BOOL_FIELDS = ['keepSession', 'structured'];
  const touched = [];
  const patchWarnings = [];
  const explicitStructured = new Map();
  const coerceBool = (val) => (typeof val === 'string' ? !/^(false|0|off|no|)$/i.test(val.trim()) : Boolean(val));
  for (const patch of args && Array.isArray(args.nodes) ? args.nodes : []) {
    if (!patch || typeof patch !== 'object' || typeof patch.id !== 'string' || !patch.id.trim()) {
      patchWarnings.push('已忽略缺少有效字符串 id 的节点补丁项。');
      continue;
    }
    const pid = patch.id.trim();
    // 'lead' is the reserved entry node and is never edited here.
    if (pid === 'lead') {
      patchWarnings.push('入口节点 lead 不可通过 nodes[] 修改，请改用顶层 task / refs 参数。');
      continue;
    }
    if (/[\s#]/.test(pid)) {
      patchWarnings.push('节点 ID「' + pid + '」不能包含空白或 #，已忽略该节点补丁。');
      continue;
    }
    const existing = byId.get(pid);
    if (existing) {
      for (const key of STR_FIELDS) {
        if (patch[key] !== undefined) existing[key] = String(patch[key] === null ? '' : patch[key]);
      }
      for (const key of BOOL_FIELDS) {
        if (patch[key] !== undefined) existing[key] = coerceBool(patch[key]);
      }
      if (patch.structured !== undefined) explicitStructured.set(pid, existing.structured);
      if (patch.preset !== undefined) {
        existing.preset = patch.preset === 'minimal' ? 'minimal' : 'standard';
      }
      if (patch.kind !== undefined) existing.kind = normalizeKind(patch.kind);
      if (existing.kind === 'condition') existing.preset = 'minimal';
      if (patch.branches !== undefined) {
        const nb = normalizeBranches(patch.branches);
        if (nb) existing.branches = nb;
        else delete existing.branches;
      }
      if (patch.multiMatch !== undefined) {
        if (coerceBool(patch.multiMatch)) existing.multiMatch = true;
        else delete existing.multiMatch;
      }
      if (patch.refs !== undefined) {
        const nr = normalizeRefs(patch.refs);
        if (nr) existing.refs = nr;
        else delete existing.refs;
      }
      touched.push(pid);
    } else {
      const created = {
        id: pid,
        kind: normalizeKind(patch.kind),
        label: String(patch.label || pid),
        role: '', provider: '', model: '', reasoning: '', preset: 'standard',
        structured: false, keepSession: false, fallbackModel: '', fallbackProvider: '',
      };
      for (const key of STR_FIELDS) {
        if (patch[key] !== undefined) created[key] = String(patch[key] === null ? '' : patch[key]);
      }
      for (const key of BOOL_FIELDS) {
        if (patch[key] !== undefined) created[key] = coerceBool(patch[key]);
      }
      if (patch.structured !== undefined) explicitStructured.set(pid, created.structured);
      created.preset = (created.kind === 'condition' || patch.preset === 'minimal') ? 'minimal' : 'standard';
      if (created.kind === 'condition' && patch.branches !== undefined) {
        const nb = normalizeBranches(patch.branches);
        if (nb) created.branches = nb;
      }
      if (created.kind === 'condition' && coerceBool(patch.multiMatch)) {
        created.multiMatch = true;
      }
      if (patch.refs !== undefined) {
        const nr = normalizeRefs(patch.refs);
        if (nr) created.refs = nr;
      }
      nodes.push(created);
      byId.set(created.id, created);
      touched.push(created.id);
    }
  }
  const removed = new Set(Array.isArray(args && args.removeNodes) ? args.removeNodes : []);
  if (removed.has('lead')) {
    patchWarnings.push('入口节点 lead 不能删除，已自动忽略。');
    removed.delete('lead');
  }
  const keptNodes = nodes.filter((n) => !removed.has(n.id));
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const rawRemoveEdges = Array.isArray(args && args.removeEdges) ? args.removeEdges : [];
  const matchesRemovedEdge = (edge) => rawRemoveEdges.some((r) => {
    if (!r || String(r.from) !== edge.from || String(r.to) !== edge.to) return false;
    if (r.type && r.type !== edge.type) return false;
    const rb = normalizeBranch(r.branch);
    if (rb && rb !== normalizeBranch(edge.branch)) return false;
    return true;
  });
  const removedStructuredFrom = new Set();
  const prevEdges = Array.isArray(plan.edges) ? plan.edges : [];
  let edges = [];
  for (const e of prevEdges) {
    if (matchesRemovedEdge(e) || removed.has(e.from) || removed.has(e.to)) {
      if (e && e.type === 'structured') removedStructuredFrom.add(e.from);
      continue;
    }
    edges.push({ ...e });
  }
  const droppedEdges = [];
  for (const edge of Array.isArray(args && args.edges) ? args.edges : []) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      droppedEdges.push('(无效连线项)');
      continue;
    }
    const validFrom = edge.from === 'lead' || keptIds.has(edge.from);
    const validTo = keptIds.has(edge.to);
    if (edge.from === edge.to || edge.to === 'lead' || !validFrom || !validTo) {
      droppedEdges.push(edge.from + ' → ' + edge.to);
      continue;
    }
    const rawType = typeof edge.type === 'string' ? edge.type.trim() : '';
    let type = 'prompt';
    if (rawType === 'prompt' || rawType === 'structured' || rawType === 'session-ref') {
      type = rawType;
    } else if (rawType === 'session') {
      type = 'session-ref';
    } else if (rawType) {
      patchWarnings.push('新增连线 ' + edge.from + ' → ' + edge.to + ' 的未知类型「' + rawType + '」已按 prompt 处理。');
    }
    const branch = normalizeBranch(edge.branch);
    const existingEdge = edges.find((e) => e.from === edge.from && e.to === edge.to && e.type === type && normalizeBranch(e.branch) === branch);
    if (existingEdge) {
      if (edge.loop === true) {
        existingEdge.loop = true;
        existingEdge.maxIterations = normalizeMaxIterations(edge.maxIterations !== undefined ? edge.maxIterations : existingEdge.maxIterations);
      } else if (edge.loop === false) {
        delete existingEdge.loop;
        delete existingEdge.maxIterations;
      }
      continue;
    }
    const nextEdge = { from: edge.from, to: edge.to, type };
    if (branch) nextEdge.branch = branch;
    if (edge.loop === true) {
      nextEdge.loop = true;
      nextEdge.maxIterations = normalizeMaxIterations(edge.maxIterations);
    }
    edges.push(nextEdge);
  }
  if (droppedEdges.length) {
    patchWarnings.push('以下新增连线因节点 ID 不存在、自环或指向入口 Lead 已被忽略：' + droppedEdges.join('、'));
  }
  const structuredSources = new Set(edges.filter((e) => e.type === 'structured').map((e) => e.from));
  for (const node of keptNodes) {
    if (structuredSources.has(node.id)) {
      node.structured = true;
    } else if (removedStructuredFrom.has(node.id) && explicitStructured.get(node.id) !== true) {
      node.structured = false;
    }
  }
  const taskPatched = typeof (args && args.task) === 'string';
  const nextTask = taskPatched ? args.task : String(plan.task || '');
  const refsPatched = args && args.refs !== undefined;
  const nextRefs = refsPatched ? normalizeRefs(args.refs) : normalizeRefs(plan.refs);
  const nextPlan = { ...plan, task: nextTask, nodes: keptNodes, edges };
  if (nextRefs) nextPlan.refs = nextRefs;
  else delete nextPlan.refs;
  return {
    plan: nextPlan,
    touched,
    taskPatched,
    refsPatched,
    warnings: patchWarnings,
    removed: Array.from(removed),
    removeEdges: rawRemoveEdges
      .filter((r) => r && typeof r.from === 'string' && typeof r.to === 'string')
      .map((r) => {
        const item = { from: r.from, to: r.to };
        if (r.type) item.type = r.type;
        const rb = normalizeBranch(r.branch);
        if (rb) item.branch = rb;
        return item;
      }),
  };
}
