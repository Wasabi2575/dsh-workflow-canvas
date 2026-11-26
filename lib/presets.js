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
        id: 'swe_impl', kind: 'agent', label: '核心实现', preset: 'standard', keepSession: true,
        role: '延续「代码库摸底」热会话直接动手（免重复扫库）：仅修改业务源码落实拍板方案，自测并汇报改动清单。',
      },
      {
        id: 'swe_review', kind: 'agent', label: '独立审查', preset: 'standard', keepSession: false,
        role: '全新上下文独立审查（不改代码）：运行完整测试套件并审查 diff，排查回归风险与边界遗漏，输出结构化审查结论。',
      },
      {
        id: 'swe_ship_gate', kind: 'lead', label: 'Lead 终审',
        role: '依据结构化审查结论拍板是否交付；若有小问题，直接通过交接的「核心实现」紫线会话下达就地修复。',
      },
    ],
    edges: [
      { id: 's1', from: 'lead', to: 'swe_risk', type: 'prompt' },
      { id: 's2', from: 'lead', to: 'swe_scan', type: 'prompt' },
      { id: 's3', from: 'swe_risk', to: 'swe_spec', type: 'prompt' },
      { id: 's4', from: 'swe_scan', to: 'swe_spec', type: 'prompt' },
      { id: 's5', from: 'swe_spec', to: 'swe_plan_gate', type: 'structured' },
      { id: 's6', from: 'swe_plan_gate', to: 'swe_tests', type: 'prompt' },
      { id: 's7', from: 'swe_plan_gate', to: 'swe_impl', type: 'prompt' },
      { id: 's8', from: 'swe_scan', to: 'swe_impl', type: 'session-ref' },
      { id: 's9', from: 'swe_tests', to: 'swe_review', type: 'prompt' },
      { id: 's10', from: 'swe_impl', to: 'swe_review', type: 'prompt' },
      { id: 's11', from: 'swe_review', to: 'swe_ship_gate', type: 'structured' },
      { id: 's12', from: 'swe_impl', to: 'swe_ship_gate', type: 'session-ref' },
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
        task: '把这份 PRD 变成可实施方案：先并行做三项调研（竞品、技术可行性、成本），合成一份结构化方案，我拍板后并行产出代码与文档、并按方案生成测试清单，最后我终审。',
      },
      {
        id: 'n_comp', kind: 'agent', label: '竞品调研', preset: 'standard', keepSession: false,
        role: '调研同类产品的做法，列出优缺点与差异化机会。',
      },
      {
        id: 'n_tech', kind: 'agent', label: '技术可行性', preset: 'standard', keepSession: true,
        role: '评估现有技术栈能否实现，指出核心难点与依赖。',
      },
      {
        id: 'n_cost', kind: 'agent', label: '成本估算', preset: 'minimal', keepSession: false,
        role: '估算人力、时间与依赖，给出保守与乐观两档评估。',
      },
      {
        id: 'n_synth', kind: 'agent', label: '方案合成', preset: 'standard', keepSession: false,
        role: '合并三份调研为一份可执行的结构化方案（含备选路线、steps 与 risks）。',
      },
      {
        id: 'n_decide', kind: 'lead', label: 'Lead 拍板',
        role: '从合成方案里选定一条路线，写清实施边界与不做的事。',
      },
      {
        id: 'n_tests', kind: 'agent', label: '测试清单', preset: 'standard', keepSession: false,
        role: '基于方案中的 steps 与 risks 生成可验证的验收测试清单。',
      },
      {
        id: 'n_code', kind: 'agent', label: '写代码', preset: 'standard', keepSession: false,
        role: '按拍板后的方案实现核心改动并自测。',
      },
      {
        id: 'n_docs', kind: 'agent', label: '写文档', preset: 'standard', keepSession: false,
        role: '写使用说明与变更记录，面向使用者而非开发者。',
      },
      {
        id: 'n_final', kind: 'lead', label: 'Lead 终审',
        role: '核对代码、文档、测试清单三者是否对齐方案，给出能否交付的结论。',
      },
    ],
    edges: [
      { id: 't1', from: 'lead', to: 'n_comp', type: 'prompt' },
      { id: 't2', from: 'lead', to: 'n_tech', type: 'prompt' },
      { id: 't3', from: 'lead', to: 'n_cost', type: 'prompt' },
      { id: 't4', from: 'n_comp', to: 'n_synth', type: 'prompt' },
      { id: 't5', from: 'n_tech', to: 'n_synth', type: 'prompt' },
      { id: 't6', from: 'n_cost', to: 'n_synth', type: 'prompt' },
      { id: 't7', from: 'n_synth', to: 'n_decide', type: 'structured' },
      { id: 't8', from: 'n_synth', to: 'n_tests', type: 'session-ref' },
      { id: 't9', from: 'n_decide', to: 'n_code', type: 'prompt' },
      { id: 't10', from: 'n_decide', to: 'n_docs', type: 'prompt' },
      { id: 't11', from: 'n_code', to: 'n_final', type: 'prompt' },
      { id: 't12', from: 'n_tests', to: 'n_final', type: 'prompt' },
      { id: 't13', from: 'n_docs', to: 'n_final', type: 'prompt' },
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
        task: '',
      },
      {
        id: 'n_a', kind: 'agent', label: '方案 A（稳健）', preset: 'minimal', keepSession: false,
        role: '提出低风险、改动最小的稳健方案。',
      },
      {
        id: 'n_b', kind: 'agent', label: '方案 B（创新）', preset: 'minimal', keepSession: false,
        role: '提出上限更高、长期收益更大的进阶方案。',
      },
      {
        id: 'n_pick', kind: 'lead', label: 'Lead 拍板',
        role: '对比两份方案，选定最终路线并补充约束。',
      },
      {
        id: 'n_exec', kind: 'agent', label: '执行落地', preset: 'standard', keepSession: false,
        role: '按照拍板路线完成最终交付。',
      },
      {
        id: 'n_review', kind: 'lead', label: 'Lead 验收',
        role: '核对最终产出是否符合拍板方向，确认无误后交付。',
      },
    ],
    edges: [
      { id: 'a1', from: 'lead', to: 'n_a', type: 'prompt' },
      { id: 'a2', from: 'lead', to: 'n_b', type: 'prompt' },
      { id: 'a3', from: 'n_a', to: 'n_pick', type: 'prompt' },
      { id: 'a4', from: 'n_b', to: 'n_pick', type: 'prompt' },
      { id: 'a5', from: 'n_pick', to: 'n_exec', type: 'prompt' },
      { id: 'a6', from: 'n_exec', to: 'n_review', type: 'prompt' },
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
        task: '先运行项目测试与构建自检，再根据结果自动分流：全部通过则整理发布说明；存在失败则定位根因并给出修复方案，最后由我终审。',
      },
      {
        id: 'c_run', kind: 'agent', label: '执行与自检', preset: 'standard', keepSession: false,
        role: '执行测试或验证命令，如实汇报通过/失败状态、报错日志与受影响文件。',
      },
      {
        id: 'c_gate', kind: 'condition', label: '是否通过？', preset: 'minimal', keepSession: false,
        role: '判断上游执行与自检是否全部通过且无报错；全部通过返回 true，存在失败或未完全交付返回 false。',
      },
      {
        id: 'c_yes', kind: 'agent', label: '通过：整理交付', preset: 'minimal', keepSession: false,
        role: '汇总已验证的改动内容，起草简洁清晰的发布说明与交付清单。',
      },
      {
        id: 'c_no', kind: 'agent', label: '失败：定位修复', preset: 'standard', keepSession: false,
        role: '排查失败日志、定位根因，并完成或给出最小范围的修复补丁。',
      },
      {
        id: 'c_final', kind: 'lead', label: 'Lead 终审',
        role: '查看命中的分支产出，确认可直接交付或安排下一轮修复。',
      },
    ],
    edges: [
      { id: 'cd1', from: 'lead', to: 'c_run', type: 'prompt' },
      { id: 'cd2', from: 'c_run', to: 'c_gate', type: 'prompt' },
      { id: 'cd3', from: 'c_gate', to: 'c_yes', type: 'prompt', branch: 'true' },
      { id: 'cd4', from: 'c_gate', to: 'c_no', type: 'prompt', branch: 'false' },
      { id: 'cd5', from: 'c_yes', to: 'c_final', type: 'prompt' },
      { id: 'cd6', from: 'c_no', to: 'c_final', type: 'prompt' },
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
        task: '端到端交付 OAuth 登录模块：先并行摸底代码库与安全约束，我拍板后并行开发实现与文档用例；质量门禁未通过则带反馈自动回环修复（最多 3 轮），通过后直达终审交付。',
        refs: ['AGENTS.md', 'docs/auth-spec.md'],
      },
      {
        id: 'lp_scan', kind: 'agent', label: '代码库摸底', preset: 'standard', keepSession: true,
        role: '定位鉴权路由、会话中间件与工程约定，保留热会话供核心实现无缝续接。',
      },
      {
        id: 'lp_risk', kind: 'agent', label: '安全与约束', preset: 'minimal', keepSession: false,
        refs: ['docs/security.md'],
        role: '只读梳理 CSRF、PKCE 与令牌轮换约束，输出结构化 JSON 方案。',
      },
      {
        id: 'lp_signoff', kind: 'lead', label: 'Lead 拍板',
        role: '评审结构化安全方案，锁定改动边界与不做的事，放行并行实现。',
      },
      {
        id: 'lp_impl', kind: 'agent', label: '核心实现与自测', preset: 'standard', keepSession: true,
        role: '沿用摸底热会话实现 OAuth 流程并跑测试；若被打回则按反馈定点修复。',
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
