/**
 * Pure ESM workflow preset catalog, built-in starter templates, and lookup/conversion
 * helpers shared by the Host backend (`index.js`).
 */
import {
  withoutEntry,
  normalizeKind,
  normalizeRefs,
  normalizeBranch,
  normalizeBranches,
  normalizeMaxIterations,
  analyzeCanvasWarnings,
} from './graph.js';

export const MAX_STORED_PRESETS = 100;

/**
 * Built-in starter templates mirrored from `client.js` so the Host agent can inspect
 * and apply them via `canvas_preset` even in a brand-new session before any user preset is saved.
 */
export const BUILTIN_TEMPLATES = [
  {
    id: 'tpl-swe',
    name: '软件工程：摸底 → 拍板 → 并行实现 → 独立审查',
    nameEn: 'SWE Delivery: Scan → Sign-Off → Build → Review',
    direction: 'lr',
    nodes: [
      {
        id: 'lead', kind: 'lead', label: 'Lead',
        task: '给现有项目新增「请求限流中间件」：先并行摸清代码库结构与接口约束，收敛结构化变更方案，我拍板后并行完成核心实现与单测文档，最后独立审查并交我终审交付。',
      },
      {
        id: 'swe_risk', kind: 'agent', label: '约束与风险', preset: 'standard', keepSession: false,
        role: '只读排查相关接口契约、错误码约定、配置方式与测试覆盖缺口，列出绝不能破坏的边界与不变量（不改文件）。',
      },
      {
        id: 'swe_scan', kind: 'agent', label: '代码库摸底', preset: 'standard', keepSession: true,
        role: '只读定位相关模块入口、中间件链路、关键符号和代码风格约定，输出受影响文件清单（不改文件，保留会话供实现复用）。',
      },
      {
        id: 'swe_spec', kind: 'agent', label: '变更方案', preset: 'minimal', keepSession: false,
        role: '纯推理收敛两份摸底结果，输出结构化 JSON 方案（含 filesToChange、publicApi、edgeCases、testPlan 与 nonGoals）。',
      },
      {
        id: 'swe_plan_gate', kind: 'lead', label: 'Lead 拍板',
        role: '评审结构化变更方案，敲定实现边界与不做的事，明确源码与测试/文档的改动范围后放行。',
      },
      {
        id: 'swe_tests', kind: 'agent', label: '单测与文档', preset: 'standard', keepSession: false,
        role: '仅修改测试文件与使用文档（绝不改业务源码）：按拍板方案补齐边界单测用例与配置说明，确保无写冲突。',
      },
      {
        id: 'swe_impl', kind: 'agent', label: '核心实现', preset: 'standard', keepSession: false,
        role: '延续摸底上下文完成核心源码改动与本地自检（绝不改测试/文档文件），交付改动清单与验证结果。',
      },
      {
        id: 'swe_review', kind: 'agent', label: '独立审查', preset: 'standard', keepSession: false,
        role: '独立只读审查核心实现与单测：核对接口契约、边界缺陷、并发/安全隐患并给出放行或返工建议（不改文件）。',
      },
      {
        id: 'swe_final', kind: 'lead', label: 'Lead 终审交付',
        role: '汇总实现、单测与独立审查意见，给出最终验证清单并向用户交付。',
      },
    ],
    edges: [
      { id: 'se1', from: 'lead', to: 'swe_scan', type: 'prompt' },
      { id: 'se2', from: 'lead', to: 'swe_risk', type: 'prompt' },
      { id: 'se3', from: 'swe_scan', to: 'swe_spec', type: 'prompt' },
      { id: 'se4', from: 'swe_risk', to: 'swe_spec', type: 'prompt' },
      { id: 'se5', from: 'swe_spec', to: 'swe_plan_gate', type: 'structured' },
      { id: 'se6', from: 'swe_plan_gate', to: 'swe_impl', type: 'prompt' },
      { id: 'se7', from: 'swe_plan_gate', to: 'swe_tests', type: 'prompt' },
      { id: 'se8', from: 'swe_scan', to: 'swe_impl', type: 'session-ref' },
      { id: 'se9', from: 'swe_impl', to: 'swe_review', type: 'prompt' },
      { id: 'se10', from: 'swe_tests', to: 'swe_review', type: 'prompt' },
      { id: 'se11', from: 'swe_review', to: 'swe_final', type: 'prompt' },
    ],
  },
  {
    id: 'tpl-prd',
    name: 'PRD 调研 → 拍板 → 并行产出 → 终审',
    nameEn: 'PRD Research → Decide → Build → Review',
    direction: 'lr',
    nodes: [
      {
        id: 'lead', kind: 'lead', label: 'Lead',
        task: '规划一个面向团队的知识库检索功能：先并行摸清业务场景与技术约束，我拍板范围后并行产出 PRD 与验收清单，最后我终审定稿。',
      },
      {
        id: 'p_user', kind: 'agent', label: '用户与场景调研', preset: 'minimal', keepSession: false,
        role: '梳理核心用户画像、典型使用路径与关键痛点，输出结构化需求清单。',
      },
      {
        id: 'p_tech', kind: 'agent', label: '技术与边界评估', preset: 'minimal', keepSession: false,
        role: '评估实现可行性、性能/权限约束与潜在风险，给出分阶段建议。',
      },
      {
        id: 'p_gate', kind: 'lead', label: 'Lead 范围拍板',
        role: '汇总调研与技术边界，确定本期范围（In/Out of Scope）和核心指标后放行。',
      },
      {
        id: 'p_prd', kind: 'agent', label: 'PRD 正文撰写', preset: 'minimal', keepSession: false,
        role: '按拍板范围输出完整 PRD（功能流程、交互状态、异常兜底与埋点）。',
      },
      {
        id: 'p_qa', kind: 'agent', label: '验收与风险清单', preset: 'minimal', keepSession: false,
        role: '围绕核心路径与边界条件编写可落地的验收用例与上线检查项。',
      },
      {
        id: 'p_final', kind: 'lead', label: 'Lead 终审定稿',
        role: '核对 PRD 与验收清单的一致性，整合为最终可评审交付稿。',
      },
    ],
    edges: [
      { id: 'pe1', from: 'lead', to: 'p_user', type: 'prompt' },
      { id: 'pe2', from: 'lead', to: 'p_tech', type: 'prompt' },
      { id: 'pe3', from: 'p_user', to: 'p_gate', type: 'structured' },
      { id: 'pe4', from: 'p_tech', to: 'p_gate', type: 'prompt' },
      { id: 'pe5', from: 'p_gate', to: 'p_prd', type: 'prompt' },
      { id: 'pe6', from: 'p_gate', to: 'p_qa', type: 'prompt' },
      { id: 'pe7', from: 'p_prd', to: 'p_final', type: 'prompt' },
      { id: 'pe8', from: 'p_qa', to: 'p_final', type: 'prompt' },
    ],
  },
  {
    id: 'tpl-ab',
    name: '并行方案对比 → 拍板 → 执行 → 验收',
    nameEn: 'Parallel Options → Decide → Execute → Review',
    direction: 'lr',
    nodes: [
      {
        id: 'lead', kind: 'lead', label: 'Lead',
        task: '针对同一目标并行产出稳健与激进两套方案，我拍板选定方向后落地实现并复核。',
      },
      {
        id: 'ab_a', kind: 'agent', label: '方案 A（稳健）', preset: 'minimal', keepSession: false,
        role: '给出低风险、最小改动、最快落地的方案与权衡分析。',
      },
      {
        id: 'ab_b', kind: 'agent', label: '方案 B（彻底）', preset: 'minimal', keepSession: false,
        role: '给出长期扩展性最好、结构更彻底的方案与成本评估。',
      },
      {
        id: 'ab_gate', kind: 'lead', label: 'Lead 选型拍板',
        role: '对比方案 A 与 B 的收益和风险，选定主方案（或吸收双方优点）并明确落地指令。',
      },
      {
        id: 'ab_exec', kind: 'agent', label: '落地执行', preset: 'standard', keepSession: false,
        role: '严格按 Lead 拍板的方案完成实施与自检，交付结果清单。',
      },
      {
        id: 'n_review', kind: 'lead', label: 'Lead 终审验收',
        role: '核对执行结果是否满足拍板目标，整理最终交付结论。',
      },
    ],
    edges: [
      { id: 'ae1', from: 'lead', to: 'ab_a', type: 'prompt' },
      { id: 'ae2', from: 'lead', to: 'ab_b', type: 'prompt' },
      { id: 'ae3', from: 'ab_a', to: 'ab_gate', type: 'prompt' },
      { id: 'ae4', from: 'ab_b', to: 'ab_gate', type: 'prompt' },
      { id: 'ae5', from: 'ab_gate', to: 'ab_exec', type: 'prompt' },
      { id: 'ae6', from: 'ab_exec', to: 'n_review', type: 'prompt' },
    ],
  },
  {
    id: 'tpl-cond',
    name: '条件分支：执行 → 判断分流 → 终审',
    nameEn: 'Conditional: Run → Pass/Fail Branch → Review',
    direction: 'lr',
    nodes: [
      {
        id: 'lead', kind: 'lead', label: 'Lead',
        task: '完成改动并自检；条件裁判判断通过则直接整理交付，未通过则进入定位修复分支，最后汇总给 Lead 终审。',
      },
      {
        id: 'c_run', kind: 'agent', label: '执行与自检', preset: 'standard', keepSession: false,
        role: '完成任务执行并运行验证检查，明确报告是否全部通过以及具体错误信息。',
      },
      {
        id: 'c_gate', kind: 'condition', label: '是否通过？', preset: 'minimal', keepSession: false,
        role: '若上游执行与自检全部通过且无报错，返回 pass=true；否则返回 pass=false 并说明失败点。',
      },
      {
        id: 'c_yes', kind: 'agent', label: '通过：整理交付', preset: 'minimal', keepSession: false,
        role: '将通过验证的结果整理成简洁的交付摘要与变更清单。',
      },
      {
        id: 'c_no', kind: 'agent', label: '失败：定位修复', preset: 'standard', keepSession: false,
        role: '根据上游报错定位根因并尝试修复或给出可执行排查方案。',
      },
      {
        id: 'c_final', kind: 'lead', label: 'Lead 终审',
        role: '根据命中的分支结果完成最终验收并向用户汇报。',
      },
    ],
    edges: [
      { id: 'ce1', from: 'lead', to: 'c_run', type: 'prompt' },
      { id: 'ce2', from: 'c_run', to: 'c_gate', type: 'prompt' },
      { id: 'ce3', from: 'c_gate', to: 'c_yes', type: 'prompt', branch: 'true' },
      { id: 'ce4', from: 'c_gate', to: 'c_no', type: 'prompt', branch: 'false' },
      { id: 'ce5', from: 'c_yes', to: 'c_final', type: 'prompt' },
      { id: 'ce6', from: 'c_no', to: 'c_final', type: 'prompt' },
    ],
  },
  {
    id: 'tpl-loop',
    name: '全功能回环：并行摸底 → 拍板 → 实现 ↺ 门禁 → 终审',
    nameEn: 'Full Showcase: Parallel → Gate → Loop ↺ Fix → Ship',
    direction: 'lr',
    nodes: [
      {
        id: 'lead', kind: 'lead', label: 'Lead',
        task: '端到端交付一个安全配置开关：并行摸底代码与风险，我拍板后核心实现进入受控质量门禁回环（最多自动修复 3 轮），同时并行补齐文档，全部通过后由我终审交付。',
      },
      {
        id: 'lp_scan', kind: 'agent', label: '代码库摸底', preset: 'standard', keepSession: true,
        role: '只读定位配置入口、调用链与测试文件（不改文件，保留会话供后续实现复用）。',
      },
      {
        id: 'lp_risk', kind: 'agent', label: '约束与风险', preset: 'minimal', keepSession: false,
        role: '纯推理梳理兼容性约束、安全红线与验收指标，输出结构化 JSON 检查表。',
      },
      {
        id: 'lp_signoff', kind: 'lead', label: 'Lead 拍板',
        role: '核对摸底与结构化检查表，明确源码与文档职责边界后放行并行阶段。',
      },
      {
        id: 'lp_impl', kind: 'agent', label: '核心实现与单测', preset: 'standard', keepSession: false,
        role: '延续摸底上下文完成核心源码与单测改动并运行测试；若收到门禁打回反馈，按反馈定向修复。',
      },
      {
        id: 'lp_docs', kind: 'agent', label: '文档与验收清单', preset: 'standard', keepSession: false,
        role: '并行补齐配置文档与验收清单（不改业务源码，与回环实现互不干扰）。',
      },
      {
        id: 'lp_gate', kind: 'condition', label: '质量门禁', preset: 'minimal', keepSession: false,
        branches: [
          { id: 'true', label: '通过' },
          { id: 'false', label: '打回修复' },
        ],
        role: '核验测试结果与安全清单；全部通过走「通过」，否则走「打回修复」并附具体修复理由。',
      },
      {
        id: 'lp_final', kind: 'lead', label: 'Lead 终审交付',
        role: '汇聚通过门禁的实现与文档，给出最终交付结论。',
      },
    ],
    edges: [
      { id: 'lp1', from: 'lead', to: 'lp_scan', type: 'prompt' },
      { id: 'lp2', from: 'lead', to: 'lp_risk', type: 'prompt' },
      { id: 'lp3', from: 'lp_scan', to: 'lp_signoff', type: 'prompt' },
      { id: 'lp4', from: 'lp_risk', to: 'lp_signoff', type: 'structured' },
      { id: 'lp5', from: 'lp_signoff', to: 'lp_impl', type: 'prompt' },
      { id: 'lp6', from: 'lp_scan', to: 'lp_impl', type: 'session-ref' },
      { id: 'lp7', from: 'lp_signoff', to: 'lp_docs', type: 'prompt' },
      { id: 'lp8', from: 'lp_impl', to: 'lp_gate', type: 'prompt' },
      { id: 'lp9', from: 'lp_gate', to: 'lp_final', type: 'prompt', branch: 'true' },
      { id: 'lp10', from: 'lp_gate', to: 'lp_impl', type: 'prompt', branch: 'false', loop: true, maxIterations: 3 },
      { id: 'lp11', from: 'lp_docs', to: 'lp_final', type: 'prompt' },
    ],
  },
];

/** Validate and normalize a single preset object (`{ nodes, edges, direction }`). */
export function sanitizePresetEntry(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return null;
  }
  const nodes = [];
  const seen = new Set();
  for (const n of raw.nodes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id.trim()) continue;
    const id = n.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = id === 'lead' ? 'lead' : normalizeKind(n.kind);
    const out = {
      id,
      kind,
      label: String(n.label || (id === 'lead' ? 'Lead' : id)),
      role: String(n.role || ''),
      provider: String(n.provider || ''),
      model: String(n.model || ''),
      reasoning: String(n.reasoning || ''),
      preset: kind === 'condition' ? 'minimal' : (n.preset === 'minimal' ? 'minimal' : 'standard'),
      keepSession: kind === 'condition' ? false : Boolean(n.keepSession),
      fallbackModel: String(n.fallbackModel || ''),
      fallbackProvider: String(n.fallbackProvider || ''),
    };
    if (id === 'lead') out.task = String(n.task || '');
    if (typeof n.x === 'number' && Number.isFinite(n.x)) out.x = n.x;
    if (typeof n.y === 'number' && Number.isFinite(n.y)) out.y = n.y;
    if (n.structured === true) out.structured = true;
    if (typeof n.memoryChildId === 'string' && n.memoryChildId) out.memoryChildId = n.memoryChildId;
    if (n.tbSide === 'left' || n.tbSide === 'right') out.tbSide = n.tbSide;
    if (kind === 'condition') {
      const nb = normalizeBranches(n.branches);
      if (nb) out.branches = nb;
      if (n.multiMatch) out.multiMatch = true;
    }
    const nr = normalizeRefs(n.refs);
    if (nr) out.refs = nr;
    nodes.push(out);
  }
  if (!nodes.some((n) => n.id === 'lead')) {
    nodes.unshift({
      id: 'lead', kind: 'lead', label: 'Lead', task: '',
      role: '', provider: '', model: '', reasoning: '', preset: 'standard',
      keepSession: false, fallbackModel: '', fallbackProvider: '',
    });
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (let i = 0; i < raw.edges.length; i += 1) {
    const e = raw.edges[i];
    if (!e || typeof e !== 'object' || typeof e.from !== 'string' || typeof e.to !== 'string') continue;
    const from = e.from.trim();
    const to = e.to.trim();
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) continue;
    const type = e.type === 'structured' || e.type === 'session-ref' ? e.type : (e.type === 'session' ? 'session-ref' : 'prompt');
    const out = {
      id: typeof e.id === 'string' && e.id.trim() ? e.id.trim() : ('e' + i),
      from,
      to,
      type,
    };
    const branch = normalizeBranch(e.branch);
    if (branch) out.branch = branch;
    if (e.loop === true) {
      out.loop = true;
      out.maxIterations = normalizeMaxIterations(e.maxIterations);
    }
    edges.push(out);
  }
  const COMMENT_COLORS = new Set(['gray', 'blue', 'green', 'amber', 'purple', 'red']);
  const COMMENT_SIZES = new Set(['sm', 'md', 'lg']);
  const comments = [];
  if (Array.isArray(raw.comments)) {
    const seenComments = new Set();
    let autoSeq = 1;
    for (let i = 0; i < raw.comments.length && comments.length < 80; i += 1) {
      const c = raw.comments[i];
      if (!c || typeof c !== 'object') continue;
      let cid = typeof c.id === 'string' && c.id.trim() ? c.id.trim().slice(0, 80) : '';
      if (!cid) {
        while (seenComments.has('cm-' + autoSeq)) autoSeq += 1;
        cid = 'cm-' + autoSeq;
        autoSeq += 1;
      }
      if (seenComments.has(cid)) continue;
      seenComments.add(cid);
      const x = typeof c.x === 'number' && Number.isFinite(c.x) ? Math.round(c.x) : 0;
      const y = typeof c.y === 'number' && Number.isFinite(c.y) ? Math.round(c.y) : 0;
      const w = typeof c.w === 'number' && Number.isFinite(c.w) ? Math.max(180, Math.min(4000, Math.round(c.w))) : 260;
      const h = typeof c.h === 'number' && Number.isFinite(c.h) ? Math.max(96, Math.min(4000, Math.round(c.h))) : 140;
      const item = {
        id: cid,
        x,
        y,
        w,
        h,
        title: typeof c.title === 'string' ? c.title.slice(0, 120) : '',
        body: typeof c.body === 'string' ? c.body.slice(0, 4000) : '',
        color: COMMENT_COLORS.has(c.color) ? c.color : 'gray',
        fontSize: COMMENT_SIZES.has(c.fontSize) ? c.fontSize : 'md',
        zoomScale: c.zoomScale !== false,
      };
      if (Array.isArray(c.nodeIds)) {
        const validIds = Array.from(new Set(c.nodeIds.filter((nid) => typeof nid === 'string' && nodeIds.has(nid.trim())).map((nid) => nid.trim())));
        if (validIds.length) item.nodeIds = validIds;
      }
      comments.push(item);
    }
  }
  const result = {
    nodes,
    edges,
    direction: raw.direction === 'tb' ? 'tb' : 'lr',
  };
  if (comments.length) result.comments = comments;
  return result;
}

/** Normalize a `{ [name]: preset }` dictionary (capped at MAX_STORED_PRESETS). */
export function sanitizePresetCatalog(rawObj) {
  const out = {};
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) return out;
  let count = 0;
  for (const [rawName, rawPreset] of Object.entries(rawObj)) {
    if (count >= MAX_STORED_PRESETS) break;
    const name = String(rawName || '').trim();
    if (!name) continue;
    const clean = sanitizePresetEntry(rawPreset);
    if (!clean) continue;
    out[name] = clean;
    count += 1;
  }
  return out;
}

/** Build a compact one-line node preview and non-entry count for preset listings. */
export function summarizePresetNodes(nodes) {
  const list = withoutEntry(nodes);
  const preview = list
    .slice(0, 6)
    .map((n) => (n.kind === 'lead' ? '〔Lead〕' : (n.kind === 'condition' ? '〔条件〕' : '')) + (n.label || n.id))
    .join(' → ') + (list.length > 6 ? ' …' : '');
  return { nodeCount: list.length, preview };
}

/**
 * Resolve a preset or built-in template by exact name/id, case-insensitive name/id,
 * or unique case-insensitive substring match. User presets always take priority.
 */
export function resolvePresetByName(rawQuery, userPresetsMap) {
  const query = String(rawQuery || '').trim();
  if (!query) return { notFound: true };
  const lower = query.toLowerCase();
  const userEntries = userPresetsMap instanceof Map
    ? Array.from(userPresetsMap.entries())
    : Object.entries(userPresetsMap || {});

  // 1) Exact match in user presets
  for (const [name, preset] of userEntries) {
    if (name === query) return { source: 'user', name, preset };
  }
  // 2) Case-insensitive exact match in user presets
  for (const [name, preset] of userEntries) {
    if (name.toLowerCase() === lower) return { source: 'user', name, preset };
  }
  // 3) Exact match in built-in templates (id / name / nameEn)
  for (const tpl of BUILTIN_TEMPLATES) {
    if (tpl.id === query || tpl.name === query || tpl.nameEn === query) {
      return { source: 'builtin', id: tpl.id, name: tpl.name, preset: sanitizePresetEntry(tpl) };
    }
  }
  // 4) Case-insensitive exact match in built-in templates
  for (const tpl of BUILTIN_TEMPLATES) {
    if (tpl.id.toLowerCase() === lower || tpl.name.toLowerCase() === lower || tpl.nameEn.toLowerCase() === lower) {
      return { source: 'builtin', id: tpl.id, name: tpl.name, preset: sanitizePresetEntry(tpl) };
    }
  }
  // 5) Substring match across user presets first, then built-in templates
  const userSubs = userEntries
    .filter(([name]) => name.toLowerCase().includes(lower))
    .map(([name, preset]) => ({ source: 'user', name, preset }));
  if (userSubs.length === 1) return userSubs[0];
  if (userSubs.length > 1) return { ambiguous: userSubs.map((m) => m.name) };

  const builtinSubs = BUILTIN_TEMPLATES
    .filter((tpl) => tpl.id.toLowerCase().includes(lower)
      || tpl.name.toLowerCase().includes(lower)
      || tpl.nameEn.toLowerCase().includes(lower))
    .map((tpl) => ({ source: 'builtin', id: tpl.id, name: tpl.name, preset: sanitizePresetEntry(tpl) }));
  if (builtinSubs.length === 1) return builtinSubs[0];
  if (builtinSubs.length > 1) return { ambiguous: builtinSubs.map((m) => m.name + ' (' + m.id + ')') };

  return { notFound: true };
}

/**
 * Convert a sanitized preset into a Host execution `plan` + UI `canvasDoc`.
 */
export function presetToPlanAndCanvas(preset, opts = {}) {
  const clean = sanitizePresetEntry(preset);
  if (!clean) return { error: '预设内容无效，缺少可用的节点或连线。' };
  const overrideTask = typeof opts.task === 'string' && opts.task.trim() ? opts.task.trim() : null;
  const nodes = clean.nodes.map((n) => {
    const copy = {
      ...n,
      ...(Array.isArray(n.refs) ? { refs: n.refs.slice() } : null),
      ...(Array.isArray(n.branches) ? { branches: n.branches.map((b) => ({ ...b })) } : null),
    };
    if (copy.id === 'lead' && overrideTask !== null) copy.task = overrideTask;
    return copy;
  });
  const edges = clean.edges.map((e) => ({ ...e }));
  const entry = nodes.find((n) => n.id === 'lead');
  const entryRefs = normalizeRefs(entry && entry.refs);
  const planNodes = withoutEntry(nodes).map((n) => {
    const out = {
      ...n,
      structured: Boolean(n.structured) || edges.some((e) => e.from === n.id && e.type === 'structured'),
    };
    delete out.x;
    delete out.y;
    delete out.tbSide;
    return out;
  });
  const plan = {
    task: String((entry && entry.task) || ''),
    nodes: planNodes,
    edges: edges.map((e) => {
      const item = { from: e.from, to: e.to, type: e.type || 'prompt' };
      if (e.branch) item.branch = e.branch;
      if (e.loop === true) {
        item.loop = true;
        item.maxIterations = normalizeMaxIterations(e.maxIterations);
      }
      return item;
    }),
  };
  if (entryRefs) plan.refs = entryRefs;
  const canvasDoc = {
    nodes,
    edges,
    enabled: opts.enabled !== undefined ? Boolean(opts.enabled) : true,
  };
  if (Array.isArray(clean.comments) && clean.comments.length) {
    const estNodeH = (n) => {
      if (n && n.kind === 'condition') {
        const bc = Array.isArray(n.branches) && n.branches.length >= 2 ? n.branches.length : 2;
        return Math.max(234, 176 + bc * 20 + 24);
      }
      return 234;
    };
    canvasDoc.comments = clean.comments.map((c) => {
      const copy = { ...c, ...(Array.isArray(c.nodeIds) ? { nodeIds: c.nodeIds.slice() } : null) };
      if (!copy.nodeIds && typeof copy.x === 'number' && typeof copy.y === 'number' && typeof copy.w === 'number' && typeof copy.h === 'number') {
        const inside = nodes
          .filter((n) => n && typeof n.x === 'number' && typeof n.y === 'number'
            && (n.x + 108) >= copy.x && (n.x + 108) <= (copy.x + copy.w)
            && (n.y + estNodeH(n) / 2) >= copy.y && (n.y + estNodeH(n) / 2) <= (copy.y + copy.h))
          .map((n) => n.id);
        if (inside.length) copy.nodeIds = inside;
      }
      return copy;
    });
  }
  if (opts.preserveDirection !== false) {
    canvasDoc.direction = clean.direction;
  }
  if (typeof opts.presetName === 'string' && opts.presetName.trim()) {
    canvasDoc.presetName = opts.presetName.trim();
  }
  const warnings = analyzeCanvasWarnings(planNodes, plan.edges);
  return { canvasDoc, plan, warnings };
}
