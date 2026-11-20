window.__ModuleLoader__.load({
  id: '@local/dsh-workflow-canvas',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useRef = React.useRef;
    const useEffect = React.useEffect;
    const Component = React.Component;

    /** Resolved lazily so a missing namespace can never fail plugin load. */
    let workspaceFilesService = null;
    function resolveWorkspaceFiles(ctx) {
      if (workspaceFilesService) return workspaceFilesService;
      try {
        if (ctx && typeof ctx.get === 'function') {
          workspaceFilesService = ctx.get('remote.workspaceFiles') || null;
        }
      } catch (_e) { /* service absent */ }
      if (!workspaceFilesService) {
        try {
          workspaceFilesService = (ctx && ctx.remote && ctx.remote.workspaceFiles) || null;
        } catch (_e) { /* proxy refuses unknown namespaces */ }
      }
      return workspaceFilesService;
    }

    const TAB_ID = '@local/dsh-workflow-canvas';
    const KIND = 'workflow';
    const STORAGE_PREFIX = 'dsh-workflow-canvas:v1:';
    const PRESET_KEY = STORAGE_PREFIX + 'presets';

    const NODE_W = 216;
    const NODE_H = 224;
    const PORT = 12;
    const SOCKET_BAND_TOP = 168;
    const ROW_H = 18;
    const CONTENT_W = 2400;
    const CONTENT_H = 1600;
    /** World origin offset: keeps negative node coordinates inside the scroll area. */
    const WORLD_PAD = 2000;

    // One socket per channel type: a link can only join the same type.
    const SOCKET_TYPES = [
      { id: 'prompt', label: 'prompt', color: '#8a8f98' },
      { id: 'structured', label: 'structured', color: '#2f81f7' },
      { id: 'session-ref', label: 'session', color: '#a371f7' },
    ];

    /** Fallback effort ids when the model catalog carries no reasoning metadata. */
    const REASONING_FALLBACK = ['low', 'medium', 'high'];

    const LANG_KEY = STORAGE_PREFIX + 'lang';
    const I18N = {
      zh: {
        addAgent: '+ 子代理', addLead: '+ Lead', undo: '↶ 撤销', sync: '↥ 同步',
        enabled: '● 已启用', disabled: '○ 已禁用', presetName: '预设名', save: '☆ 保存',
        presets: '☰ 预设', unsaved: '有未同步改动', synced: '已同步',
        pickModel: '选择模型', defaultEffort: '默认',
        leadThis: 'Lead（本对话）',
        tipSocketOut: '拖出可断开 / 拖入可连接',
        tipSocketIn: '从这里拖出连线 / 也可以把输入口拖到这里',
        delNodeTip: '删除节点（可用 ↶ 撤销 找回）',
        deletedNode: '节点已删除，可点「撤销」找回',
        orphanTip: '未连线：运行时会被跳过',
        syncOff: '自动同步不可用',
        syncNoSession: '无会话 id',
        syncReadFail: '读取失败: ',
        syncApplied: '已应用生成结果',
        syncBadFile: '文件内容无效',
        generated: '已从对话生成画布',
        dupName: '已存在，请换一个名字',
        guideDesc: '画一张子代理流程图',
        model: '模型', reason: '推理', role: '分工', task: '任务', taskPh: '本次任务：例如把这批反馈归类并给出建议',
        rolePhLead: '我自己这一步做什么', rolePhAgent: '这个子代理做什么',
        memory: '记忆', scope: '能力', retry: '重试', jsonOut: 'JSON 输出',
        sep: ': ', on: '开', off: '关', allTools: '默认（全部工具）', none: '无',
        scopeMinimal: 'minimal（只读、少工具）', scopeStandard: 'standard（标准工具集）',
        fallbackModel: '备用',
        stPending: '未执行', stRunning: '进行中', stDone: '已完成', stFailed: '失败',
        stOrphan: '未连线', stLead: '由对话执行',
        presetEmpty: '还没有保存过预设', del: '删除这个预设',
        needName: '请先给预设起个名字', duplicate: '已存在，请换一个名字',
        savedPreset: '已保存预设', saveFailed: '保存失败（存储不可用）',
        loadedPreset: '已载入预设', invalidPreset: '预设内容无效', deletedPreset: '已删除预设',
        syncFailed: '同步失败', upToDate: '已是最新', syncedToHost: '已同步到 Host',
        cannotOpen: '无法打开会话', undoDone: '已撤销', undoNone: '没有可撤销的操作',
        leadLocked: '入口 Lead 不能删除', modelsMissing: '模型列表未加载',
        tipLead: 'Lead 步骤在对话里执行，画布不追踪其状态',
        tipOrphan: '未连线：运行时会被跳过', tipStatus: '子代理节点的运行状态',
        tipZoom: '滚轮缩放（以光标为中心）',
        tipResetZoom: '回到 100% 并把画面中心拉到 Lead 节点',
        tipLocate: '把画面中心拉到 Lead（本对话）节点',
        locate: '◎ 定位',
        importBtn: '⇩ 导入',
        tipImport: '从剪贴板导入模型生成的画布（先复制聊天里的画布 JSON）',
        importOk: '已导入画布，共 ',
        tipMore: '更多',
        help: '使用说明',
        helpTitle: '怎么用这个画布',
        close: '关闭',
        cutLinks: '右键划断连线',
        linkCut: '已断开一条连线',
        tipToggle: '启用/禁用此画布（启用后我才能执行它）',
        helpBody: [
          '1. 在入口 Lead 里写「本次任务」，这是整张图的总目标。',
          '2. 点「+ 子代理」加节点，从右侧输出口拖到另一个节点左侧输入口即可连线。',
          '3. 连线有三种：prompt 传文本，structured 传 JSON，session 让下游接着上游的会话跑。',
          '4. 端口颜色即类型，只能同色相连；拖已连接的左口可以断开。',
          '5. 每个节点可设模型、推理强度、能力范围、备用模型、是否记忆。',
          '6. 连好后点「● 已启用」，然后对对话说「跑一次」，由我调用执行。',
          '7. 遇到 Lead 节点会暂停，我做完再把结果交回去继续。',
          '8. 没连线的节点显示为虚线，运行时会被跳过。',
          '9. 右键按住划过一条连线可以切断；可在「⋯」里关掉这个手势。',
          '10. 预设名 + ☆ 保存 可以把整张图存下来，新对话里从「☰ 预设」载入。',
        ].join('\n'),
        importNone: '剪贴板里没有可识别的画布数据',
        importBad: '画布数据格式不对',
        tipSync: '把当前画布同步给 Host（会在对话里留一条同步记录）',
        tipUndo: '撤销上一步结构改动', tipSave: '把当前画布保存为预设',
        tipPresets: '载入已保存的预设', tipModel: '推理等级（默认 = 该模型声明的 defaultEffort）',
        tipMemory: '记忆：复用这个节点上一次的会话（仅同一进程内有效）',
        tipPreset: '能力范围：standard 标准工具集（含子代理/工作流/网页/办公）；minimal 只读少工具（无子代理、无工作流）',
        tipFallback: '失败重试：该节点出错时自动换一个模型再跑一次',
        tipStructured: 'JSON 输出：要求该节点返回 JSON 对象，structured 连线会把结果作为 JSON 传给下游',
        lang: 'ZH',
      },
      en: {
        addAgent: '+ Subagent', addLead: '+ Lead', undo: '↶ Undo', sync: '↥ Sync',
        enabled: '● ON', disabled: '○ OFF', presetName: 'Preset name', save: '☆ Save',
        presets: '☰ Presets', unsaved: 'Unsaved changes', synced: 'Synced',
        pickModel: 'Pick a model', defaultEffort: 'default',
        leadThis: 'Lead (this chat)',
        tipSocketOut: 'Drag to detach / drop to connect',
        tipSocketIn: 'Drag out to link, or drop an input here',
        delNodeTip: 'Delete this node (undo with ↶)',
        deletedNode: 'Node deleted, use Undo to restore it',
        orphanTip: 'Unlinked: skipped when the canvas runs',
        syncOff: 'Auto-sync unavailable',
        syncNoSession: 'No session id',
        syncReadFail: 'Read failed: ',
        syncApplied: 'Generated canvas applied',
        syncBadFile: 'File content is invalid',
        generated: 'Canvas generated from chat',
        dupName: 'already exists, pick another name',
        guideDesc: 'Sketch a subagent workflow',
        model: 'Model', reason: 'Reasoning', role: 'Role', task: 'Task', taskPh: 'Task, e.g. classify these reports and suggest actions',
        rolePhLead: 'What I do in this step', rolePhAgent: 'What this subagent does',
        memory: 'Memory', scope: 'Scope', retry: 'Retry', jsonOut: 'JSON out',
        sep: ': ', on: 'on', off: 'off', allTools: 'default (all tools)', none: 'none',
        scopeMinimal: 'minimal (read-only)', scopeStandard: 'standard (usual tools)',
        fallbackModel: 'Fallback',
        stPending: 'Pending', stRunning: 'Running', stDone: 'Done', stFailed: 'Failed',
        stOrphan: 'Unlinked', stLead: 'Runs in chat',
        presetEmpty: 'No presets saved yet', del: 'Delete this preset',
        needName: 'Name the preset first', duplicate: 'already exists, pick another name',
        savedPreset: 'Saved preset', saveFailed: 'Save failed (storage unavailable)',
        loadedPreset: 'Loaded preset', invalidPreset: 'Preset content is invalid', deletedPreset: 'Deleted preset',
        syncFailed: 'Sync failed', upToDate: 'Already up to date', syncedToHost: 'Synced to host',
        cannotOpen: 'Cannot open the session', undoDone: 'Undone', undoNone: 'Nothing to undo',
        leadLocked: 'The entry Lead cannot be deleted', modelsMissing: 'Model list is not loaded',
        tipLead: 'Lead steps run in the chat; the canvas does not track them',
        tipOrphan: 'Unlinked: skipped when the canvas runs', tipStatus: 'Subagent run status',
        tipZoom: 'Wheel zooms around the cursor',
        tipResetZoom: 'Reset to 100% and centre the view on the Lead node',
        tipLocate: 'Centre the view on the Lead (this conversation) node',
        locate: '◎ Locate',
        importBtn: '⇩ Import',
        tipImport: 'Import a model-generated canvas from the clipboard (copy the canvas JSON from chat first)',
        importOk: 'Canvas imported, ',
        tipMore: 'More',
        help: 'How to use',
        helpTitle: 'Using this canvas',
        close: 'Close',
        cutLinks: 'Right-drag to cut links',
        linkCut: 'Link cut',
        tipToggle: 'Enable or disable this canvas (I can only run it while enabled)',
        helpBody: [
          '1. Write the overall task in the entry Lead node.',
          '2. Add nodes with the + buttons, then drag from a right socket to a left socket.',
          '3. Links carry text (prompt), JSON (structured), or continue the upstream session (session).',
          '4. Socket colour is the type; only matching types connect. Drag a connected input to detach.',
          '5. Each node sets model, reasoning, capability scope, fallback model and memory.',
          '6. Press ● ON, then ask in chat to run the canvas.',
          '7. The run pauses at every Lead node so the conversation can do that step.',
          '8. Unlinked nodes are dashed and skipped at run time.',
          '9. Hold the right button and sweep across a link to cut it; turn the gesture off under ⋯.',
          '10. Name a preset and press ☆ Save to keep the canvas for other sessions.',
        ].join('\n'),
        importNone: 'No canvas data found in the clipboard',
        importBad: 'Canvas data is malformed',
        tipSync: 'Publish this canvas to the host (leaves one sync record in the chat)',
        tipUndo: 'Undo the last structural change', tipSave: 'Save this canvas as a preset',
        tipPresets: 'Load a saved preset', tipModel: 'Reasoning effort (default = the model\'s defaultEffort)',
        tipMemory: 'Memory: reuse this node\'s previous session (same process only)',
        tipPreset: 'Capability: standard = full tool set (subagents, workflow, web, office); minimal = read-only, few tools',
        tipFallback: 'Retry: when this node fails, rerun it once on another model',
        tipStructured: 'JSON output: require an object result; structured links pass it downstream as JSON',
        lang: 'EN',
      },
    };

    /** Bilingual string for text read outside the component (tab titles, guide). */
    function pick(zh, en) {
      return loadLang() === 'en' ? en : zh;
    }

    function loadLang() {
      try {
        const v = window.localStorage.getItem(LANG_KEY);
        return v === 'en' ? 'en' : 'zh';
      } catch (_e) {
        return 'zh';
      }
    }

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      dim: 'var(--dsw-alias-label-tertiary, rgba(140,140,140,0.95))',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
      raised: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.10))',
      elevated: 'var(--dsw-alias-bg-elevated, #2a2b2f)',
      base: 'var(--dsw-alias-bg-base, transparent)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.18))',
      accent: 'var(--dsw-alias-brand-primary, #2f81f7)',
    };

    const S = {
      root: {
        boxSizing: 'border-box', height: '100%', width: '100%',
        display: 'flex', flexDirection: 'column',
        background: C.base, color: C.text, fontSize: '13px',
      },
      toolbar: {
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '8px 10px', borderBottom: '1px solid ' + C.border, flex: '0 0 auto',
      },
      btn: {
        padding: '5px 10px', borderRadius: '6px', border: '1px solid ' + C.border,
        background: C.raised, color: C.text, fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      toggleOn: {
        padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + C.accent,
        background: 'transparent', color: C.accent, fontSize: '12px', fontWeight: 600,
        cursor: 'pointer', whiteSpace: 'nowrap',
      },
      toggleOff: {
        padding: '5px 12px', borderRadius: '6px', border: '1px solid ' + C.border,
        background: 'transparent', color: C.dim, fontSize: '12px',
        cursor: 'pointer', whiteSpace: 'nowrap',
      },
      status: {
        fontSize: '11px', color: C.dim,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
      },
      floatOn: {
        position: 'absolute', top: '10px', right: '10px', zIndex: 30,
        padding: '5px 10px', borderRadius: '999px', border: '1px solid ' + C.accent,
        background: C.elevated, color: C.accent, fontSize: '11px', fontWeight: 600,
        cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      },
      floatOff: {
        position: 'absolute', top: '10px', right: '10px', zIndex: 30,
        padding: '5px 10px', borderRadius: '999px', border: '1px solid ' + C.border,
        background: C.elevated, color: C.dim, fontSize: '11px', fontWeight: 600,
        cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
      },
      moreBar: { position: 'relative', flex: '0 0 auto' },
      moreMenu: {
        position: 'absolute', right: 0, top: '100%', marginTop: '4px', minWidth: '190px',
        background: C.elevated, border: '1px solid ' + C.border, borderRadius: '6px',
        zIndex: 80, padding: '4px', boxShadow: '0 10px 26px rgba(0,0,0,0.45)',
      },
      moreRow: {
        padding: '5px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer',
        whiteSpace: 'nowrap', color: C.text,
      },
      helpOverlay: {
        position: 'absolute', inset: '0', background: 'rgba(0,0,0,0.45)', zIndex: 90,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px',
      },
      helpCard: {
        width: '100%', maxWidth: '420px', maxHeight: '100%', overflow: 'auto',
        background: C.elevated, border: '1px solid ' + C.border, borderRadius: '8px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.5)', padding: '12px',
      },
      helpHead: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
      helpTitle: { flex: '1 1 auto', fontSize: '13px', fontWeight: 600, color: C.text },
      helpBody: { fontSize: '11px', lineHeight: '17px', color: C.dim },
      helpLine: { whiteSpace: 'pre-wrap' },
      presetBar: {
        marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: '3px', position: 'relative', flex: '0 0 auto',
      },
      presetRowTop: { display: 'flex', alignItems: 'center', gap: '5px' },
      presetMenu: {
        position: 'absolute', right: 0, top: '100%', marginTop: '4px', minWidth: '190px',
        maxHeight: '260px', overflowY: 'auto', background: C.elevated,
        border: '1px solid ' + C.border, borderRadius: '6px', zIndex: 60, padding: '4px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      },
      presetRow: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px',
        borderRadius: '4px', fontSize: '11px', cursor: 'pointer',
      },
      presetRowText: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      presetDel: {
        flex: '0 0 auto', padding: '0 4px', borderRadius: '3px', border: 'none',
        background: 'transparent', color: '#e5534b', fontSize: '11px', cursor: 'pointer',
      },
      presetInput: {
        width: '92px', padding: '3px 6px', borderRadius: '5px', border: '1px solid ' + C.border,
        background: C.base, color: C.text, fontSize: '11px', outline: 'none', userSelect: 'text',
      },
      presetEmpty: { padding: '6px', fontSize: '10px', color: C.dim },
      syncNote: { fontSize: '10px', color: C.dim, maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      canvas: { position: 'relative', flex: '1 1 auto', overflow: 'auto', minHeight: '0', userSelect: 'none' },
      content: { position: 'relative', width: CONTENT_W, height: CONTENT_H },

      node: {
        position: 'absolute', width: NODE_W, height: NODE_H, boxSizing: 'border-box',
        borderRadius: '10px', border: '1px solid ' + C.border,
        background: C.raised, color: C.text, cursor: 'grab',
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      },
      nodeSel: { border: '2px solid ' + C.accent },
      leadNode: {},
      orphanNode: { border: '1px dashed ' + C.dim, opacity: 0.65 },

      title: {
        position: 'absolute', left: '10px', right: '10px', top: '10px', height: '18px',
        fontWeight: 600, fontSize: '13px', lineHeight: '18px',
        border: 'none', background: 'transparent', color: C.text, padding: 0, margin: 0,
        outline: 'none', boxSizing: 'border-box', userSelect: 'text',
      },
      titleReadonly: {
        position: 'absolute', left: '10px', right: '10px', top: '10px', height: '18px',
        fontWeight: 600, fontSize: '13px', lineHeight: '18px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      topBar: {
        position: 'absolute', left: 0, right: 0, top: 0, height: '4px',
        borderRadius: '10px 10px 0 0', zIndex: 2, pointerEvents: 'none',
      },
      statusChip: {
        position: 'absolute', right: '10px', bottom: '3px', fontSize: '9px', lineHeight: '14px',
        color: C.dim, pointerEvents: 'none', zIndex: 3, whiteSpace: 'nowrap',
      },

      fieldModel: { position: 'absolute', left: '10px', right: '10px', top: '28px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldReason: { position: 'absolute', left: '10px', right: '10px', top: '50px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldScope: { position: 'absolute', left: '10px', right: '10px', top: '72px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldFallback: { position: 'absolute', left: '10px', right: '10px', top: '94px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldMemory: { position: 'absolute', left: '10px', right: '10px', top: '116px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldRole: { position: 'absolute', left: '10px', right: '10px', top: '138px', height: '22px', display: 'flex', alignItems: 'center', gap: '6px' },
      fieldRoleTop: { position: 'absolute', left: '10px', right: '10px', top: '34px', height: '24px', display: 'flex', alignItems: 'center', gap: '6px' },
      optRow: {
        position: 'absolute', left: '10px', right: '10px', top: '114px', height: '18px',
        display: 'flex', alignItems: 'center', gap: '5px', fontSize: '9px', color: C.dim,
        overflow: 'hidden',
      },

      toggleSwitch: {
        flex: '1 1 auto', width: '100%', height: '18px', boxSizing: 'border-box', padding: '0 5px', borderRadius: '4px',
        border: '1px solid ' + C.border, background: C.base, color: C.text,
        fontSize: '10px', cursor: 'pointer', outline: 'none', textAlign: 'center', lineHeight: '14px',
      },
      toggleSwitchOn: {
        flex: '1 1 auto', width: '100%', height: '18px', boxSizing: 'border-box', padding: '0 5px', borderRadius: '4px',
        border: '1px solid ' + C.accent, background: C.base, color: C.accent,
        fontSize: '10px', cursor: 'pointer', outline: 'none', textAlign: 'center', lineHeight: '14px',
      },
      optChip: {
        flex: '0 0 auto', padding: '2px 6px', borderRadius: '4px',
        border: '1px solid ' + C.border, background: 'transparent', color: C.dim,
        fontSize: '9px', cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: '12px',
        outline: 'none',
      },
      optChipOn: {
        flex: '0 0 auto', padding: '2px 6px', borderRadius: '4px',
        border: '1px solid ' + C.accent, background: C.hover, color: C.accent,
        fontSize: '9px', cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: '12px',
        outline: 'none',
      },
      fieldLabel: { flex: '0 0 30px', width: '30px', fontSize: '9px', color: C.dim },

      input: {
        flex: '1 1 auto', minWidth: '0', padding: '3px 6px', borderRadius: '5px',
        border: '1px solid ' + C.border, background: C.base, color: C.text, fontSize: '12px',
        outline: 'none', userSelect: 'text',
      },
      rolePopover: {
        position: 'absolute', left: '100%', top: '0', marginLeft: '8px', width: '230px',
        background: C.elevated, border: '1px solid ' + C.border, borderRadius: '8px',
        boxShadow: '0 10px 26px rgba(0,0,0,0.45)', padding: '8px', zIndex: 70,
      },
      roleArea: {
        width: '100%', height: '96px', boxSizing: 'border-box', resize: 'none',
        background: C.base, color: C.text, fontSize: '11px', lineHeight: '15px',
        border: '1px solid ' + C.border, borderRadius: '5px', padding: '5px 6px',
        outline: 'none', userSelect: 'text',
      },
      leadLabel: { position: 'absolute', left: '10px', right: '10px', top: '26px', height: '16px', display: 'flex', alignItems: 'center' },
      task: {
        position: 'absolute', left: '10px', right: '10px', top: '44px', height: '118px',
        padding: '4px 6px', borderRadius: '5px', border: '1px solid ' + C.border,
        background: C.base, color: C.text, fontSize: '11px', resize: 'none', outline: 'none',
        lineHeight: '14px', boxSizing: 'border-box', userSelect: 'text',
      },

      selectBtn: {
        flex: '1 1 auto', minWidth: '0', width: '100%', height: '18px', boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '0 5px', borderRadius: '4px', border: '1px solid ' + C.border,
        background: C.base, color: C.text, fontSize: '10px', cursor: 'pointer', textAlign: 'left',
        lineHeight: '14px',
      },
      reasonChip: {
        flex: '0 0 auto', maxWidth: '44px', padding: '3px 4px', borderRadius: '5px',
        border: '1px solid ' + C.border, background: 'transparent', color: C.dim,
        fontSize: '9px', cursor: 'pointer', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      },
      selectText: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      caret: { flex: '0 0 auto', color: C.dim, fontSize: '9px' },
      menu: {
        position: 'absolute', left: 0, right: 0, top: '100%', marginTop: '4px',
        maxHeight: '220px', overflowY: 'auto', background: C.elevated,
        border: '1px solid ' + C.border, borderRadius: '6px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)', zIndex: 50, padding: '4px',
      },
      menuRow: {
        padding: '6px 8px', borderRadius: '4px', fontSize: '12px', cursor: 'pointer',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      menuRow: {
        padding: '3px 7px', borderRadius: '4px', fontSize: '10px', cursor: 'pointer',
      },
      menuHead: { padding: '6px 8px 2px', fontSize: '10px', color: C.dim, textTransform: 'uppercase', letterSpacing: '0.04em' },

      band: { position: 'absolute', left: 0, right: 0, top: SOCKET_BAND_TOP + 'px' },
      row: { position: 'relative', height: ROW_H + 'px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      rowLabel: { fontSize: '9px', color: C.dim, letterSpacing: '0.02em' },
      socket: {
        position: 'absolute', top: (ROW_H - PORT) / 2, width: PORT, height: PORT,
        borderRadius: '50%', background: C.raised, border: '2px solid ' + C.border,
        boxSizing: 'border-box', cursor: 'crosshair', zIndex: 6,
        /* a little extra grab area without changing the drawn dot */
        padding: 0, margin: -3, boxShadow: '0 0 0 3px transparent',
      },
      nodeDelete: {
        position: 'absolute', right: '-8px', top: '-8px', width: '18px', height: '18px',
        borderRadius: '50%', background: C.elevated, border: '1px solid ' + C.border,
        color: '#e5534b', fontSize: '12px', lineHeight: '16px', textAlign: 'center',
        cursor: 'pointer', zIndex: 8, userSelect: 'none',
      },
      runsBadge: {
        position: 'absolute', right: '10px', bottom: '2px', fontSize: '9px',
        color: C.accent, cursor: 'pointer', userSelect: 'none', zIndex: 4,
      },
      statusBar: {
        position: 'absolute', left: '2px', top: '10px', bottom: '10px', width: '3px',
        borderRadius: '2px', zIndex: 3,
      },
    };

    let hostCtx = null;

    function socketCenterY(i) {
      return SOCKET_BAND_TOP + i * ROW_H + ROW_H / 2;
    }

    function defaultNodes() {
      return [
        { id: 'lead', kind: 'lead', x: 30, y: 30, label: 'Lead', task: '', provider: '', model: '', role: '' },
        { id: 'n1', kind: 'agent', x: 40, y: 230, label: 'Classifier', provider: '', model: 'deepseek-v4-flash', role: '把请求分类' },
        { id: 'n2', kind: 'agent', x: 340, y: 420, label: 'Executor', provider: '', model: 'deepseek-v4-pro', role: '执行方案' },
      ];
    }

    function defaultEdges() {
      return [
        { id: 'e-lead-n1', from: 'lead', to: 'n1', type: 'prompt' },
        { id: 'e-n1-n2', from: 'n1', to: 'n2', type: 'prompt' },
      ];
    }

    /**
     * Older docs used an `output` node as the exit. Its meaning is now "another
     * lead step", so migrate the kind instead of dropping the user's graph.
     */
    function ensureEntry(doc) {
      if (!doc || !Array.isArray(doc.nodes)) return doc;
      for (const n of doc.nodes) {
        if (!n) continue;
        if (n.kind === 'output') {
          n.kind = 'lead';
          if (!n.label || n.label === '输出') n.label = 'Lead';
        } else if (!n.kind) {
          n.kind = n.id === 'lead' ? 'lead' : 'agent';
        }
      }
      if (!doc.nodes.some((n) => n && n.id === 'lead')) {
        doc.nodes.unshift({ id: 'lead', kind: 'lead', x: 30, y: 30, label: 'Lead', task: '', provider: '', model: '', role: '' });
      }
      for (const n of doc.nodes) {
        if (n && n.id === 'lead') n.kind = 'lead';
      }
      return doc;
    }

    /** Control points of one link, in canvas coordinates. */
    function edgeCurve(from, to, type) {
      const idx = Math.max(0, SOCKET_TYPES.findIndex((t) => t.id === type));
      const y = socketCenterY(idx);
      const x1 = from.x + WORLD_PAD + NODE_W, y1 = from.y + WORLD_PAD + y;
      const x2 = to.x + WORLD_PAD, y2 = to.y + WORLD_PAD + y;
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
      return { x1, y1, c1x: x1 + dx, c1y: y1, c2x: x2 - dx, c2y: y2, x2, y2 };
    }

    function edgePath(from, to, type) {
      const c = edgeCurve(from, to, type);
      return 'M ' + c.x1 + ' ' + c.y1 + ' C ' + c.c1x + ' ' + c.c1y + ', ' + c.c2x + ' ' + c.c2y + ', ' + c.x2 + ' ' + c.y2;
    }

    /** Shortest distance between a point and one link, sampled along the curve. */
    function distanceToEdge(point, from, to, type) {
      const c = edgeCurve(from, to, type);
      let best = Infinity;
      let prevX = c.x1;
      let prevY = c.y1;
      for (let i = 1; i <= 18; i += 1) {
        const t = i / 18;
        const u = 1 - t;
        const bx = u * u * u * c.x1 + 3 * u * u * t * c.c1x + 3 * u * t * t * c.c2x + t * t * t * c.x2;
        const by = u * u * u * c.y1 + 3 * u * u * t * c.c1y + 3 * u * t * t * c.c2y + t * t * t * c.y2;
        best = Math.min(best, distanceToSegment(point, prevX, prevY, bx, by));
        prevX = bx;
        prevY = by;
      }
      return best;
    }

    function distanceToSegment(p, ax, ay, bx, by) {
      const vx = bx - ax;
      const vy = by - ay;
      const len = vx * vx + vy * vy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.y - ay) * vy) / len));
      const dx = p.x - (ax + t * vx);
      const dy = p.y - (ay + t * vy);
      return Math.hypot(dx, dy);
    }

    function topoOrder(nodes, edges) {
      const indeg = new Map(nodes.map((n) => [n.id, 0]));
      const adj = new Map(nodes.map((n) => [n.id, []]));
      for (const e of edges) {
        if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
        indeg.set(e.to, indeg.get(e.to) + 1);
        adj.get(e.from).push(e.to);
      }
      const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
      const out = [];
      while (queue.length) {
        const id = queue.shift();
        out.push(id);
        for (const next of adj.get(id)) {
          indeg.set(next, indeg.get(next) - 1);
          if (indeg.get(next) === 0) queue.push(next);
        }
      }
      return out.length === nodes.length ? out : null;
    }

    function varOf(id) {
      return 'n_' + String(id).replace(/[^a-zA-Z0-9_]/g, '_');
    }

    function buildWorkflowScript(nodes, edges) {
      const entry = nodes.find((n) => n.id === 'lead');
      if (!entry) return { error: '缺少入口 Lead 节点' };
      const rest = nodes.filter((n) => n.id !== 'lead');
      if (!rest.length) return { error: '画布上还没有可执行的节点' };
      const task = String(entry.task || '').trim();
      if (!task) return { error: '请先在 Lead 节点填写「本次任务」' };

      const byIdAll = new Map(rest.map((n) => [n.id, n]));

      const reachable = new Set([entry.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const e of edges) {
          if (reachable.has(e.from) && !reachable.has(e.to)) { reachable.add(e.to); grew = true; }
        }
      }
      const orphan = rest.filter((n) => !reachable.has(n.id));
      if (orphan.length) {
        return { error: '这些节点没有从入口 Lead 连过来：' + orphan.map((n) => n.label).join('、') };
      }

      const dataEdgesAll = edges.filter((e) => e.from !== entry.id && byIdAll.has(e.from) && byIdAll.has(e.to));

      // Lead-kind nodes are executed by the conversation itself, which can only
      // happen after the script returns — so they must be terminal.
      const leadNodes = rest.filter((n) => n.kind === 'lead');
      for (const ln of leadNodes) {
        if (dataEdgesAll.some((e) => e.from === ln.id)) {
          return {
            error: '中间 Lead 节点暂不支持（「' + ln.label + '」后面还有步骤）。'
              + '把中间这一步换成子代理，或把它移到流程末尾。',
          };
        }
      }

      const agentNodes = rest.filter((n) => n.kind !== 'lead');
      if (!agentNodes.length) return { error: '需要至少一个子代理节点来执行' };

      const byId = new Map(agentNodes.map((n) => [n.id, n]));
      const dataEdges = dataEdgesAll.filter((e) => byId.has(e.from) && byId.has(e.to));
      const order = topoOrder(agentNodes, dataEdges);
      if (!order) return { error: '存在环，无法生成有向无环图的脚本' };

      const upstream = new Map(agentNodes.map((n) => [n.id, []]));
      for (const e of dataEdges) upstream.get(e.to).push(e);
      const hasDownstream = new Set(dataEdges.map((e) => e.from));

      // Hand back everything a lead step consumes, plus every terminal agent.
      const delivered = [];
      const deliver = (id) => { if (byId.has(id) && !delivered.includes(id)) delivered.push(id); };
      for (const ln of leadNodes) {
        for (const e of dataEdgesAll) if (e.to === ln.id) deliver(e.from);
      }
      for (const n of agentNodes) if (!hasDownstream.has(n.id)) deliver(n.id);

      const lines = [];
      lines.push('// meta: ' + JSON.stringify({ name: 'workflow-canvas', description: 'Canvas-generated agent DAG', phases: [{ title: 'run' }] }));
      for (const id of order) {
        const node = byId.get(id);
        const ups = upstream.get(id);
        const isRoot = ups.length === 0;
        const upsLabels = ups.map((e) => (byId.get(e.from) || {}).label).filter(Boolean);
        const downs = dataEdgesAll.filter((e) => e.from === id).map((e) => (byIdAll.get(e.to) || {}).label).filter(Boolean);
        const head = [];
        head.push('【工作流节点】你在一个多步工作流里负责「' + node.label + '」这一步（子代理）。');
        if (isRoot) head.push('【总任务】' + task);
        head.push('【职责】' + (node.role || node.label || id));
        if (upsLabels.length) head.push('【上游】' + upsLabels.join('、') + ' 已交付结果给你（见下文）。');
        head.push('【下游】' + (downs.length ? downs.join('、') + ' 会使用你的输出。' : '你是终点，结果会直接交付给用户。'));
        head.push('【要求】只完成你这一步；输出要能被下游直接使用，不要重复上游已完成的工作。');
        const pieces = [JSON.stringify(head.join('\n') + '\n')];
        for (const e of ups) {
          const from = byId.get(e.from);
          pieces.push(JSON.stringify('\n## 来自【' + from.label + '】(' + (e.type || 'prompt') + ')\n'));
          pieces.push(varOf(e.from));
        }
        // The label carries the canvas node id so the client can match the
        // spawned subagent session back to its node through the catalog.
        const opts = ["label: " + JSON.stringify((node.label || id) + '#' + id), "phase: 'run'"];
        if (node.provider) opts.push('provider: ' + JSON.stringify(node.provider));
        if (node.model) opts.push('model: ' + JSON.stringify(node.model));
        lines.push('const ' + varOf(id) + ' = await agent(' + pieces.join(' + ') + ', { ' + opts.join(', ') + ' });');
      }
      lines.push('// 交付给 Lead：' + delivered.map((id) => byId.get(id).label).join('、'));
      const rets = delivered.map((id) => JSON.stringify(byId.get(id).label) + ': ' + varOf(id));
      lines.push('return { ' + rets.join(', ') + ' };');

      // These run in the conversation after the script returns.
      const leadSteps = leadNodes.map((ln) => ({
        label: ln.label,
        role: ln.role || ln.label,
        needs: dataEdgesAll.filter((e) => e.to === ln.id).map((e) => (byIdAll.get(e.from) || {}).label).filter(Boolean),
      }));

      return { script: lines.join('\n'), leadSteps };
    }

    /** Ids reachable from the entry Lead; every other node is skipped at run time. */
    function reachableFrom(nodes, edges) {
      const set = new Set(['lead']);
      let grew = true;
      while (grew) {
        grew = false;
        for (const e of edges) {
          if (set.has(e.from) && !set.has(e.to)) { set.add(e.to); grew = true; }
        }
      }
      return set;
    }

    /** Everything the Host executor needs; no prompts are pre-rendered here. */
    function buildPlan(nodes, edges) {
      const entry = nodes.find((n) => n.id === 'lead');
      if (!entry) return { error: '缺少入口 Lead 节点' };
      const task = String(entry.task || '').trim();
      if (!task) return { error: '请先在 Lead 节点填写「本次任务」' };
      const rest = nodes.filter((n) => n.id !== 'lead');
      if (!rest.length) return { error: '画布上还没有可执行的节点' };
      // Nodes the entry Lead cannot reach are skipped rather than refused; the
      // canvas marks them so the user can see what will not run.
      const reachableIds = reachableFrom(nodes, edges);

      const ids = new Set(rest.map((n) => n.id));
      const planEdges = edges
        .filter((e) => (e.from === 'lead' || ids.has(e.from)) && ids.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, type: e.type || 'prompt' }));

      // Unconnected nodes are left out of the plan instead of blocking the run.
      const skipped = rest.filter((n) => !reachableIds.has(n.id));
      const active = rest.filter((n) => reachableIds.has(n.id));
      if (!active.length) {
        return { error: '没有从入口 Lead 连通的节点，无法执行' };
      }

      return {
        plan: {
          task,
          skipped: skipped.map((n) => n.label || n.id),
          nodes: active.map((n) => ({
            id: n.id,
            kind: n.kind === 'lead' ? 'lead' : 'agent',
            label: n.label || n.id,
            role: n.role || '',
            provider: n.provider || '',
            model: n.model || '',
            reasoning: n.reasoning || '',
            preset: n.preset === 'minimal' ? 'minimal' : 'standard',
            keepSession: Boolean(n.keepSession),
            // A structured link is the only thing that decides this: no separate switch.
            structured: planEdges.some((e) => e.from === n.id && e.type === 'structured'),
            fallbackModel: n.fallbackModel || '',
            fallbackProvider: n.fallbackProvider || '',
          })),
          edges: planEdges,
        },
      };
    }

    function loadCutMode() {
      try {
        return window.localStorage.getItem(STORAGE_PREFIX + 'cut') !== 'off';
      } catch (_e) {
        return true;
      }
    }

    function saveCutMode(on) {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + 'cut', on ? 'on' : 'off');
      } catch (_e) { /* ignore */ }
    }

    function loadPresets() {
      try {
        const raw = window.localStorage.getItem(PRESET_KEY);
        if (!raw) return {};
        const doc = JSON.parse(raw);
        return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
      } catch (_e) {
        return {};
      }
    }

    function savePresets(presets) {
      try {
        window.localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
        return true;
      } catch (_e) {
        return false;
      }
    }

    function storageKey(sessionId) {      return STORAGE_PREFIX + (sessionId || '__global__');
    }

    function loadDoc(sessionId) {
      try {
        const raw = window.localStorage.getItem(storageKey(sessionId));
        if (!raw) return null;
        const doc = JSON.parse(raw);
        if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return null;
        return ensureEntry(doc);
      } catch (_e) {
        return null;
      }
    }

    function saveDoc(sessionId, doc) {
      try {
        window.localStorage.setItem(storageKey(sessionId), JSON.stringify(doc));
      } catch (_e) {
        /* storage unavailable */
      }
    }

    function sessionFace(sessionId) {
      try {
        const sessions = hostCtx && hostCtx.sessions;
        if (!sessions || typeof sessions.binding !== 'function' || !sessionId) return undefined;
        const binding = sessions.binding(sessionId);
        return binding && binding.session;
      } catch (_e) {
        return undefined;
      }
    }

    /**
     * Keeps a rendering failure visible: without this the whole tab renders as
     * an empty box and the reason is lost.
     */
    class CanvasBoundary extends Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        try {
          console.error('[workflow-canvas] render failed', error, info);
        } catch (_e) { /* ignore */ }
      }

      render() {
        const error = this.state.error;
        if (!error) return this.props.children;
        const message = String((error && error.message) || error);
        const stack = String((error && error.stack) || '').slice(0, 900);
        return h('div', {
          style: {
            padding: '12px', fontFamily: 'ui-monospace, monospace', fontSize: '11px',
            color: '#e5534b', whiteSpace: 'pre-wrap', overflow: 'auto', height: '100%',
          },
        }, '画布渲染出错：\n' + message + '\n\n' + stack);
      }
    }

    function WorkflowCanvas(props) {
      const sessionId = props && props.sessionId;
      const stored = useRef(loadDoc(sessionId));
      const initial = stored.current;

      const [nodes, setNodes] = useState(() => (initial ? initial.nodes : defaultNodes()));
      const [edges, setEdges] = useState(() => (initial ? initial.edges : defaultEdges()));
      const [selectedIds, setSelectedIds] = useState([]);
      const [marquee, setMarquee] = useState(null);
      const [dragging, setDragging] = useState(false);
      const [syncNote, setSyncNote] = useState('');
      const [roleEditFor, setRoleEditFor] = useState(null);
      const [menuOpen, setMenuOpen] = useState(false);
      const [helpOpen, setHelpOpen] = useState(false);
      const [cutMode, setCutMode] = useState(loadCutMode);
      const cutRef = useRef(null);
      const [cutPath, setCutPath] = useState([]);
      const [cutVictims, setCutVictims] = useState([]);
      const cutHits = useRef(new Set());
      const [pending, setPending] = useState(null);
      const [status, setStatus] = useState('');
      const [models, setModels] = useState([]);
      const [openModelFor, setOpenModelFor] = useState(null);
      const [enabled, setEnabled] = useState(() => Boolean(initial && initial.enabled));

      const contentRef = useRef(null);
      const canvasElRef = useRef(null);
      const nodeDrag = useRef(null);      const statusTimer = useRef(null);
      const dropdownRef = useRef(null);
      const syncTimer = useRef(null);
      const lastSync = useRef('');
      const historyRef = useRef([]);
      const [dirty, setDirty] = useState(() => Boolean(initial && initial.enabled));
      const [view, setView] = useState({ k: 1, x: 0, y: 0 });
      const viewRef = useRef(view);
      viewRef.current = view;
      const [statusById, setStatusById] = useState({});
      const [presets, setPresets] = useState(loadPresets);
      const [presetOpen, setPresetOpen] = useState(null);
      const [presetName, setPresetName] = useState('');
      const [lang, setLang] = useState(loadLang);
      const t = (key) => (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key;
      const toggleLang = () => {
        const next = lang === 'zh' ? 'en' : 'zh';
        setLang(next);
        try { window.localStorage.setItem(LANG_KEY, next); } catch (_e) { /* ignore */ }
      };
      const nodesRef = useRef(nodes);
      nodesRef.current = nodes;

      useEffect(() => {
        saveDoc(sessionId, { nodes, edges, enabled });
      }, [sessionId, nodes, edges, enabled]);

      // Any structural edit after enabling leaves the Host copy stale.
      useEffect(() => {
        if (enabled) setDirty(true);
      }, [nodes, edges]);

      // A disabled canvas shows no run status at all.
      useEffect(() => {
        if (!enabled) setStatusById({});
      }, [enabled]);

      useEffect(() => {
        let alive = true;
        const remote = hostCtx && hostCtx.remote && hostCtx.remote.session;
        if (!remote || typeof remote.modelCatalog !== 'function') return undefined;
        remote.modelCatalog().then((res) => {
          if (!alive || !res || !res.ok) return;
          const flat = [];
          for (const group of (res.value && res.value.groups) || []) {
            for (const model of group.models || []) {
              flat.push({
                provider: group.id,
                providerName: group.name,
                model: model.id,
                modelName: model.name,
                efforts: (model.reasoning && model.reasoning.efforts) || [],
                defaultEffort: model.reasoning && model.reasoning.defaultEffort,
              });
            }
          }
          setModels(flat);
        }).catch(() => {});
        return () => { alive = false; };
      }, []);

      useEffect(() => {
        if (!openModelFor) return undefined;
        const onDown = (ev) => {
          if (dropdownRef.current && !dropdownRef.current.contains(ev.target)) setOpenModelFor(null);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [openModelFor]);

      // Publishing costs one visible command row in the conversation, so it only
      // happens when the user enables the canvas or asks for it explicitly.
      const pushPlan = (nextEnabled) => {
        try {
          const face = sessionFace(sessionId);
          if (!face || typeof face.command !== 'function') { flash(t('syncFailed')); return; }
          const res = buildPlan(nodes, edges);
          const payload = res.error
            ? { enabled: nextEnabled, error: res.error }
            : { enabled: nextEnabled, plan: res.plan };
          const sig = JSON.stringify(payload);
          if (sig === lastSync.current) { flash(t('upToDate')); return; }
          const line = '/canvas-sync ' + encodeURIComponent(sig);
          face.command(line).then((ack) => {
            if (ack && ack.ok) {
              lastSync.current = sig;
              setDirty(false);
              setStatusById({});
              flash(t('syncedToHost'));
            } else {
              flash(t('syncFailed'));
            }
          }, () => flash(t('syncFailed')));
        } catch (_e) {
          flash(t('syncFailed'));
        }
      };

      // Sync the moment a user message starts a turn, so this turn's tool call
      // already sees the latest canvas. Falls back to the turn end if the start
      // edge was missed; `dirty` clears on success so only one fires.
      const liveRef = useRef({ enabled, dirty, pushPlan });
      liveRef.current = { enabled, dirty, pushPlan };

      useEffect(() => {
        const face = sessionFace(sessionId);
        if (!face || typeof face.subscribe !== 'function' || typeof face.getSnapshot !== 'function') return undefined;
        let wasRunning = false;
        try { wasRunning = Boolean(face.getSnapshot().running); } catch (_e) { wasRunning = false; }
        const onSnapshot = () => {
          let running = false;
          try { running = Boolean(face.getSnapshot().running); } catch (_e) { running = false; }
          if (running !== wasRunning) {
            const live = liveRef.current;
            if (live.enabled && live.dirty) live.pushPlan(true);
          }
          wasRunning = running;
        };
        let unsub;
        try { unsub = face.subscribe(onSnapshot); } catch (_e) { unsub = undefined; }
        return () => {
          if (typeof unsub === 'function') { try { unsub(); } catch (_e) { /* ignore */ } }
        };
      }, [sessionId]);

      const flash = (msg) => {
        setStatus(msg);
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus(''), 3200);
      };

      // Live node status for subagent nodes only: the catalog lists children by
      // `label#nodeId`. Lead steps run inside the conversation, so the canvas
      // cannot observe them and must not pretend to.
      useEffect(() => {
        const sessions = hostCtx && hostCtx.sessions;
        const face = sessionFace(sessionId);
        if (!sessions || !sessionId || !face || typeof face.subscribe !== 'function') return undefined;
        let timer = null;
        const read = () => {
          try {
            const state = sessions.list.getSnapshot();
            const proj = state && state.projectionsBySession && state.projectionsBySession[sessionId];
            const catalog = proj && proj.values && proj.values.subagentCatalog;
            if (!Array.isArray(catalog)) return;
            const known = new Set(nodesRef.current.map((n) => n.id));
            const next = {};
            for (const entry of catalog) {
              const m = NODE_MARK.exec(String(entry.label || ''));
              if (!m || !known.has(m[1])) continue;
              const child = state.byId && state.byId[entry.id];
              const timingProj = state.projectionsBySession && state.projectionsBySession[entry.id];
              const timing = timingProj && timingProj.values && timingProj.values.subagentTiming;
              if (child && child.running) next[m[1]] = 'running';
              else if (timing && timing.lastTurnCompleted === false) next[m[1]] = 'failed';
              else next[m[1]] = 'done';
            }
            setStatusById(next);
          } catch (_e) { /* ignore */ }
        };
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
        let wasRunning = false;
        try { wasRunning = Boolean(face.getSnapshot().running); } catch (_e) { wasRunning = false; }
        if (wasRunning) { read(); timer = setInterval(read, 700); }
        const onSnapshot = () => {
          let running = false;
          try { running = Boolean(face.getSnapshot().running); } catch (_e) { running = false; }
          // A new turn means a new run: drop the previous run's statuses first.
          if (running && !wasRunning) setStatusById({});
          wasRunning = running;
          if (running && !timer) { read(); timer = setInterval(read, 700); }
          if (!running && timer) { stop(); read(); }
        };
        let unsub;
        try { unsub = face.subscribe(onSnapshot); } catch (_e) { unsub = undefined; }
        return () => {
          stop();
          if (typeof unsub === 'function') { try { unsub(); } catch (_e) { /* ignore */ } }
        };
      }, [sessionId]);

      // Zoom with the wheel, anchored on the cursor: the content point under the
      // pointer stays under it while the scale changes.
      useEffect(() => {
        const el = canvasElRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const cur = viewRef.current;
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          const k = Math.min(3, Math.max(0.2, cur.k * factor));
          if (k === cur.k) return;
          const lx = (mx - cur.x) / cur.k;
          const ly = (my - cur.y) / cur.k;
          setView({ k, x: mx - lx * k, y: my - ly * k });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, []);

      const pointTo = (e) => {
        const rect = contentRef.current.getBoundingClientRect();
        const k = viewRef.current.k || 1;
        return {
          x: (e.clientX - rect.left) / k - WORLD_PAD,
          y: (e.clientY - rect.top) / k - WORLD_PAD,
        };
      };

      /** Put a world point at the middle of the visible canvas. */
      const centerOn = (wx, wy, nextK) => {
        const el = canvasElRef.current;
        if (!el) return;
        const k = nextK || viewRef.current.k || 1;
        const cw = el.clientWidth || 1;
        const chh = el.clientHeight || 1;
        setView({
          k,
          x: cw / 2 - (wx + WORLD_PAD) * k,
          y: chh / 2 - (wy + WORLD_PAD) * k,
        });
        el.scrollLeft = 0;
        el.scrollTop = 0;
      };

      /** World coordinate currently sitting in the middle of the viewport. */
      const viewportCenterWorld = () => {
        const el = canvasElRef.current;
        const k = viewRef.current.k || 1;
        const cw = (el && el.clientWidth) || 800;
        const chh = (el && el.clientHeight) || 600;
        return {
          x: (cw / 2 - viewRef.current.x) / k - WORLD_PAD,
          y: (chh / 2 - viewRef.current.y) / k - WORLD_PAD,
        };
      };

      const focusLead = () => {
        const lead = nodes.find((n) => n.id === 'lead');
        if (!lead) return;
        centerOn(lead.x + NODE_W / 2, lead.y + NODE_H / 2);
      };

      // The world origin is padded, so the initial viewport would otherwise show
      // empty space. Centre on the entry Lead the first time the pane mounts.
      const didCenter = useRef(false);
      useEffect(() => {
        if (didCenter.current) return;
        const lead = nodesRef.current.find((n) => n.id === 'lead');
        if (!lead) return;
        didCenter.current = true;
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => centerOn(lead.x + NODE_W / 2, lead.y + NODE_H / 2))
          : setTimeout(() => centerOn(lead.x + NODE_W / 2, lead.y + NODE_H / 2), 0);
        return () => {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
          else clearTimeout(raf);
        };
      }, []);

      // Snapshot before every structural change so a mis-click can be undone.
      const pushSnapshot = () => {
        historyRef.current.push({ nodes, edges });
        if (historyRef.current.length > 50) historyRef.current.shift();
      };

      const undo = () => {
        const prev = historyRef.current.pop();
        if (!prev) { flash(t('undoNone')); return; }
        setNodes(prev.nodes);
        setEdges(prev.edges);
        setSelectedIds([]);
        flash(t('undoDone'));
      };

      const NODE_MARK = /#([A-Za-z0-9_]+)/;

      /** Match this canvas's spawned subagent sessions back to their nodes. */
      const refreshRuns = async () => {
        try {
          const sessions = hostCtx && hostCtx.sessions;
          if (!sessions || !sessionId) { flash('没有会话上下文'); return; }
          try { await sessions.refreshProjections(sessionId); } catch (_e) { /* ignore */ }
          const state = sessions.list.getSnapshot();
          const proj = state && state.projectionsBySession && state.projectionsBySession[sessionId];
          const values = proj && (proj.values || (proj.state === 'ready' ? proj.values : undefined));
          const catalog = values && values.subagentCatalog;
          if (!Array.isArray(catalog)) {
            flash('读不到子代理目录（' + (proj ? '没有 subagentCatalog' : '没有该会话投影') + '）');
            return;
          }
          if (!catalog.length) { flash('子代理目录是空的（这次运行可能没产生子会话）'); return; }
          const known = new Set(nodes.map((n) => n.id));
          const byNode = new Map();
          const samples = [];
          for (const entry of catalog) {
            const label = String(entry.label || entry.name || entry.description || '');
            if (samples.length < 2) samples.push(label || '(无 label)');
            const m = NODE_MARK.exec(label);
            if (!m) continue;
            const nodeId = m[1];
            if (!known.has(nodeId)) continue;
            if (!byNode.has(nodeId)) byNode.set(nodeId, []);
            byNode.get(nodeId).push({ childId: entry.id, label, mode: entry.mode || 'continuable' });
          }
          if (!byNode.size) {
            flash('目录 ' + catalog.length + ' 项但没有带 #节点id 的，示例：' + samples.join(' / '));
            return;
          }
          setNodes((ns) => ns.map((n) => (byNode.has(n.id) ? { ...n, runs: byNode.get(n.id) } : n)));
          flash('已同步 ' + byNode.size + ' 个节点的运行记录');
        } catch (_e) {
          flash('同步运行记录失败：' + String((_e && _e.message) || _e));
        }
      };

      const openRun = (node, run) => {
        try {
          const sr = hostCtx && hostCtx.sidebarRight;
          if (!sr || typeof sr.openResource !== 'function') { flash('无法打开会话'); return; }
          const addr = 'dsh-resource://subagentchat/session/' + encodeURIComponent(run.childId)
            + '?parent=' + encodeURIComponent(sessionId)
            + '&mode=' + encodeURIComponent(run.mode || 'continuable');
          sr.openResource(addr, { kind: 'subagentchat', preferNewPane: true });
        } catch (_e) {
          flash('打开会话失败');
        }
      };

      const addNode = (kind) => {
        pushSnapshot();
        setNodes((ns) => {
          const i = ns.length;
          const center = viewportCenterWorld();
          return [...ns, {
            id: 'n' + Date.now().toString(36),
            kind: kind === 'lead' ? 'lead' : 'agent',
            // New nodes land near the middle of the viewport, nudged right.
            x: center.x + 40 + (ns.length % 3) * 30,
            y: center.y - NODE_H / 2 + (ns.length % 3) * 40,
            label: kind === 'lead' ? 'Lead 步骤 ' + i : 'Node ' + i,
            provider: '',
            model: '',
            role: '',
          }];
        });
      };

      const updateNode = (id, patch) => {
        setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
      };

      const deleteNode = (id) => {
        if (id === 'lead') { flash(t('leadLocked')); return; }
        pushSnapshot();
        setNodes((ns) => ns.filter((n) => n.id !== id));
        setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
        setSelectedIds([]);
        flash(t('deletedNode'));
      };

      /** Dragging any selected node moves the whole selection together. */
      const onNodeDown = (e, id) => {
        if (!contentRef.current) return;
        const node = nodes.find((n) => n.id === id);
        if (!node) return;
        const p = pointTo(e);
        const group = selectedIds.includes(id) ? selectedIds : [id];
        if (!selectedIds.includes(id)) setSelectedIds([id]);
        const origins = group
          .map((nid) => nodes.find((n) => n.id === nid))
          .filter(Boolean)
          .map((n) => ({ id: n.id, x: n.x, y: n.y }));
        nodeDrag.current = { origins, startX: p.x, startY: p.y, moved: false };
        setDragging(true);
        setOpenModelFor(null);
        e.preventDefault();
        e.stopPropagation();
      };

      const onOutputDown = (e, id, type) => {
        const node = nodes.find((n) => n.id === id);
        if (!node) return;
        const idx = SOCKET_TYPES.findIndex((t) => t.id === type);
        const sx = node.x + NODE_W;
        const sy = node.y + socketCenterY(idx);
        setPending({ dir: 'out', fromId: id, type, sx, sy, x: sx, y: sy });
        setDragging(true);
        e.preventDefault();
        e.stopPropagation();
      };

      /** Release over an output socket: completes a drag that started at an input. */
      const onOutputUp = (e, id, type) => {
        if (!pending || pending.dir !== 'in' || pending.type !== type) return;
        e.preventDefault();
        e.stopPropagation();
        const toId = pending.toId;
        if (toId && toId !== id) {
          pushSnapshot();
          setEdges((es) => {
            if (es.some((x) => x.from === id && x.to === toId && x.type === type)) return es;
            return [...es, { id: 'e' + Date.now().toString(36), from: id, to: toId, type }];
          });
        }
        setPending(null);
        setDragging(false);
      };

      // Dragging a connected input detaches it; dragging a free input starts a
      // link that finishes on an output socket of the same type.
      const onInputDown = (e, id, type) => {
        e.preventDefault();
        e.stopPropagation();
        const link = edges.find((x) => x.to === id && x.type === type);
        const idx = SOCKET_TYPES.findIndex((t) => t.id === type);
        if (!link) {
          const node = nodes.find((n) => n.id === id);
          if (!node) return;
          const sx = node.x;
          const sy = node.y + socketCenterY(idx);
          setPending({ dir: 'in', toId: id, type, sx, sy, x: sx, y: sy });
          setDragging(true);
          return;
        }
        pushSnapshot();
        setEdges((es) => es.filter((x) => !(x.to === id && x.type === type)));
        const from = nodes.find((n) => n.id === link.from);
        if (!from) return;
        const sx = from.x + NODE_W;
        const sy = from.y + socketCenterY(idx);
        setPending({ dir: 'out', fromId: link.from, type, sx, sy, x: sx, y: sy });
        setDragging(true);
      };

      const onInputUp = (e, id, type) => {
        if (!pending || pending.dir !== 'out' || pending.type !== type) return;
        e.preventDefault();
        e.stopPropagation();
        if (pending.fromId !== id) {
          const fromId = pending.fromId;
          pushSnapshot();
          setEdges((es) => {
            if (es.some((x) => x.from === fromId && x.to === id && x.type === type)) return es;
            return [...es, { id: 'e' + Date.now().toString(36), from: fromId, to: id, type }];
          });
        }
        setPending(null);
        setDragging(false);
      };

      // Suppress the host context menu over the canvas while cutting is on.
      useEffect(() => {
        if (!cutMode) return undefined;
        const inside = (ev) => {
          const el = canvasElRef.current;
          return Boolean(el) && ev.target instanceof Node && el.contains(ev.target);
        };
        const onCtx = (ev) => { if (inside(ev)) ev.preventDefault(); };
        const onDown = (ev) => {
          if (ev.button !== 2 || !inside(ev) || ev.target.closest('[data-node]')) return;
          ev.preventDefault();
          const start = pointTo(ev);
          cutRef.current = start;
          setCutPath([start]);
          setDragging(true);
        };
        window.addEventListener('contextmenu', onCtx, true);
        window.addEventListener('mousedown', onDown, true);
        return () => {
          window.removeEventListener('contextmenu', onCtx, true);
          window.removeEventListener('mousedown', onDown, true);
        };
      }, [cutMode, sessionId]);

      useEffect(() => {
        if (!dragging) return undefined;
        const move = (ev) => onCanvasMove(ev);
        const up = () => onCanvasUp();
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        return () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
      }, [dragging, marquee, pending]);

      const onCanvasDown = (e) => {
        if (e.button === 2) {
          if (!cutMode) return;
          e.preventDefault();
          try { window.getSelection().removeAllRanges(); } catch (_sel) { /* ignore */ }
          const start = pointTo(e);
          cutRef.current = start;
          cutHits.current = new Set();
          setCutPath([start]);
          setCutVictims([]);
          setDragging(true);
          return;
        }
        if (e.button !== 0) return;
        if (roleEditFor) setRoleEditFor(null);
        if (menuOpen) setMenuOpen(false);
        e.preventDefault();
        try { window.getSelection().removeAllRanges(); } catch (_sel) { /* ignore */ }
        const p = pointTo(e);
        setMarquee({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
        setDragging(true);
        if (selectedIds.length) setSelectedIds([]);
        setOpenModelFor(null);
      };

      const onCanvasMove = (e) => {
        if (nodeDrag.current) {
          const p = pointTo(e);
          const drag = nodeDrag.current;
          const dx = p.x - drag.startX;
          const dy = p.y - drag.startY;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) drag.moved = true;
          const byId = new Map(drag.origins.map((o) => [o.id, o]));
          setNodes((ns) => ns.map((n) => {
            const origin = byId.get(n.id);
            return origin ? { ...n, x: origin.x + dx, y: origin.y + dy } : n;
          }));
        } else if (cutRef.current) {
          const p = pointTo(e);
          const threshold = 12 / (viewRef.current.k || 1);
          const from = cutRef.current;
          const steps = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / 6));
          for (let step = 1; step <= steps; step += 1) {
            const t = step / steps;
            const canvasSpot = {
              x: from.x + (p.x - from.x) * t + WORLD_PAD,
              y: from.y + (p.y - from.y) * t + WORLD_PAD,
            };
            for (const edge of edges) {
              if (cutHits.current.has(edge.id)) continue;
              const source = nodes.find((n) => n.id === edge.from);
              const target = nodes.find((n) => n.id === edge.to);
              if (!source || !target) continue;
              if (distanceToEdge(canvasSpot, source, target, edge.type) <= threshold) {
                cutHits.current.add(edge.id);
              }
            }
          }
          setCutPath((path) => path.concat([{ x: p.x, y: p.y }]).slice(-60));
          setCutVictims(Array.from(cutHits.current));
          cutRef.current = p;
        } else if (marquee) {
          const p = pointTo(e);
          const next = { x1: marquee.x1, y1: marquee.y1, x2: p.x, y2: p.y };
          setMarquee(next);
          // Live preview: highlight what the band currently covers.
          setSelectedIds(hitTest(next));
        } else if (pending) {
          const p = pointTo(e);
          setPending((prev) => (prev ? { ...prev, x: p.x, y: p.y } : prev));
        }
      };

      const onCanvasUp = () => {
        if (cutRef.current) {
          cutRef.current = null;
          setDragging(false);
          const victims = Array.from(cutHits.current);
          const victimIds = new Set(victims);
          cutHits.current = new Set();
          if (victims.length) {
            pushSnapshot();
            setEdges((es) => es.filter((x) => !victimIds.has(x.id)));
            flash(t('linkCut') + ' ×' + victims.length);
          }
        }
        if (cutPath.length) { setCutPath([]); setCutVictims([]); }
        if (marquee) {
          setSelectedIds(hitTest(marquee));
          setMarquee(null);
        }
        nodeDrag.current = null;
        setPending(null);
        setDragging(false);
      };

      const savePresetNow = () => {
        const name = presetName.trim();
        if (!name) { flash(t('needName')); return; }
        if (Object.prototype.hasOwnProperty.call(presets, name)) {
          flash('"' + name + '" ' + t('dupName'));
          return;
        }
        const next = { ...presets, [name]: { nodes, edges } };
        if (!savePresets(next)) { flash(t('saveFailed')); return; }
        setPresets(next);
        setPresetName('');
        setPresetOpen(null);
        flash(t('savedPreset') + ': ' + name);
      };

      /** Load a canvas document produced by the model. */
      const applyCanvasDoc = (doc) => {
        if (!doc || !Array.isArray(doc.nodes) || !doc.nodes.length) return false;
        pushSnapshot();
        setNodes(doc.nodes.map((n, i) => ({
          ...n,
          x: typeof n.x === 'number' ? n.x : 60 + i * 300,
          y: typeof n.y === 'number' ? n.y : 80,
        })));
        setEdges(Array.isArray(doc.edges) ? doc.edges.map((e, i) => ({
          id: e.id || 'e' + i,
          from: e.from,
          to: e.to,
          type: e.type || 'prompt',
        })) : []);
        setSelectedIds([]);
        setStatusById({});
        const lead = doc.nodes.find((n) => n.id === 'lead') || doc.nodes[0];
        if (lead) {
          const lx = typeof lead.x === 'number' ? lead.x : 60;
          const ly = typeof lead.y === 'number' ? lead.y : 80;
          setTimeout(() => centerOn(lx + NODE_W / 2, ly + NODE_H / 2), 0);
        }
        return true;
      };

      // The Host writes generated canvases where the workspace Remote can read
      // them; polling that file is the only Host -> canvas channel available.
      const AUTO_CANVAS = true;
      useEffect(() => {
        if (!AUTO_CANVAS) return undefined;
        let remote;
        try { remote = hostCtx && hostCtx.remote; } catch (_e) { remote = undefined; }
        let wf = resolveWorkspaceFiles(hostCtx);
        if (!wf) {
          try { wf = remote && remote.workspaceFiles; } catch (_e) { wf = undefined; }
        }
        if (!wf || typeof wf.read !== 'function') { setSyncNote(t('syncOff')); return undefined; }
        if (!sessionId) { setSyncNote(t('syncNoSession')); return undefined; }
        // The Host names the file after the agent id (session-<uuid>); the
        // pane prop may carry either form, so try both.
        const bare = String(sessionId).replace(/^session-/, '');
        const paths = [
          '.dsh/canvas/' + String(sessionId) + '.json',
          '.dsh/canvas/session-' + bare + '.json',
          '.dsh/canvas/' + bare + '.json',
        ].filter((v, i, all) => all.indexOf(v) === i);
        let alive = true;
        let lastText = '';
        const tick = async () => {
          try {
            let text = '';
            for (const path of paths) {
              try {
                const res = await wf.read(sessionId, path, {}, new AbortController().signal);
                if (!alive) return;
                const payload = res && res.ok === false ? null : (res && res.value !== undefined ? res.value : res);
                const read = payload && (typeof payload.text === 'string' ? payload.text : '');
                if (read) { text = read; break; }
              } catch (err) {
                setSyncNote(t('syncReadFail') + String((err && err.message) || err).slice(0, 80));
              }
            }
            if (!text) return;
            if (text === lastText) return;
            lastText = text;
            const doc = JSON.parse(text);
            const canvas = doc && doc.canvas;
            const valid = canvas && Array.isArray(canvas.nodes) && canvas.nodes.length
              && canvas.nodes.every((n) => n && typeof n.id === 'string');
            if (valid && applyCanvasDoc(canvas)) {
              flash(t('generated'));
              setSyncNote(t('syncApplied'));
              setTimeout(() => setSyncNote(''), 4000);
            }
            else setSyncNote(t('syncBadFile'));
          } catch (_e) { /* file absent or not readable yet */ }
        };
        const timer = setInterval(tick, 1500);
        tick();
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId]);

      const importFromClipboard = () => {
        const finish = (text) => {
          if (!text) { flash(t('importNone')); return; }
          let doc;
          try {
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            doc = JSON.parse(text.slice(start, end + 1));
          } catch (_e) { flash(t('importBad')); return; }
          if (!applyCanvasDoc(doc.canvas || doc)) { flash(t('importBad')); return; }
          flash(t('importOk') + (doc.canvas || doc).nodes.length);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(finish, () => flash(t('importNone')));
            return;
          }
        } catch (_e) { /* fall through */ }
        flash(t('importNone'));
      };

      const applyPreset = (name) => {
        const preset = presets[name];
        if (!preset || !Array.isArray(preset.nodes) || !Array.isArray(preset.edges)) { flash(t('invalidPreset')); return; }
        pushSnapshot();
        setNodes(preset.nodes);
        setEdges(preset.edges);
        setSelectedIds([]);
        setStatusById({});
        setPresetOpen(null);
        flash(t('loadedPreset') + ': ' + name);
      };

      const deletePreset = (name) => {
        const next = { ...presets };
        delete next[name];
        savePresets(next);
        setPresets(next);
        flash(t('deletedPreset') + ': ' + name);
      };

      const toggleEnabled = () => {
        const next = !enabled;
        setEnabled(next);
        setDirty(false);
        pushPlan(next);
      };

      const modelValue = (node) => (node.provider ? node.provider + '::' : '') + (node.model || '');
      const modelEntry = (node) => models.find((m) => m.provider + '::' + m.model === modelValue(node));
      const modelLabel = (node) => {
        const hit = modelEntry(node);
        return hit ? hit.modelName : (node.model || t('pickModel'));
      };
      // Reasoning ids are adapter-declared per model; '' means "use the model default".
      const reasoningOptions = (node) => {
        const hit = modelEntry(node);
        const ids = ((hit && hit.efforts) || []).map((e) => e.id);
        return ['', ...(ids.length ? ids : REASONING_FALLBACK)];
      };
      const reasoningLabel = (node) => {
        if (!node.reasoning) return t('defaultEffort');
        const hit = modelEntry(node);
        const found = hit && hit.efforts ? hit.efforts.find((e) => e.id === node.reasoning) : undefined;
        return (found && (found.name || found.id)) || node.reasoning;
      };

      const scopeToggle = (node) => {
        const wide = (node.preset || 'standard') !== 'minimal';
        return h('button', {
          style: wide ? S.toggleSwitchOn : S.toggleSwitch,
          type: 'button',
          title: t('tipPreset'),
          onMouseDown: (e) => e.stopPropagation(),
          onClick: () => updateNode(node.id, { preset: wide ? 'minimal' : 'standard' }),
        }, wide ? 'standard' : 'minimal');
      };
      const fallbackControl = (node) => {
        const key = 'f:' + node.id;
        const isOpen = openModelFor === key;
        const current = node.fallbackModel;
        const shown = models.find((m) => m.model === current);
        const rows = [];
        rows.push(h('div', {
          key: 'none',
          style: current ? S.menuRow : { ...S.menuRow, background: C.hover, color: C.accent },
          onClick: () => { updateNode(node.id, { fallbackModel: '', fallbackProvider: '' }); setOpenModelFor(null); },
        }, t('none')));
        let lastProvider = null;
        for (const m of models) {
          if (m.provider !== lastProvider) {
            rows.push(h('div', { key: 'h-' + m.provider, style: S.menuHead }, m.providerName || m.provider));
            lastProvider = m.provider;
          }
          const picked = m.model === current;
          rows.push(h('div', {
            key: m.provider + '::' + m.model,
            style: picked ? { ...S.menuRow, background: C.hover, color: C.accent } : S.menuRow,
            onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = picked ? C.hover : 'transparent'; },
            onClick: () => { updateNode(node.id, { fallbackModel: m.model, fallbackProvider: m.provider }); setOpenModelFor(null); },
          }, m.modelName || m.model));
        }
        return h('div', { ref: isOpen ? dropdownRef : undefined, style: { position: 'relative', flex: '1 1 auto', minWidth: 0 } },
          h('button', {
            style: S.selectBtn,
            type: 'button',
            title: t('tipFallback'),
            onMouseDown: (e) => e.stopPropagation(),
            onClick: () => setOpenModelFor(isOpen ? null : key),
          },
            h('span', { style: S.selectText }, shown ? (shown.modelName || shown.model) : t('none')),
            h('span', { style: S.caret }, '▾'),
          ),
          isOpen && h('div', { style: S.menu, onMouseDown: (e) => e.stopPropagation() }, rows),
        );
      };
      const memoryToggle = (node) => h('button', {
        style: node.keepSession ? S.toggleSwitchOn : S.toggleSwitch,
        type: 'button',
        title: t('tipMemory'),
        onMouseDown: (e) => e.stopPropagation(),
        onClick: () => updateNode(node.id, { keepSession: !node.keepSession }),
      }, node.keepSession ? t('on') : t('off'));

      const reasoningControl = (node) => {
        const key = 'r:' + node.id;
        const isOpen = openModelFor === key;
        const entry = modelEntry(node);
        const labelOf = (id) => {
          if (!id) return t('defaultEffort');
          const found = entry && entry.efforts ? entry.efforts.find((e) => e.id === id) : undefined;
          return (found && (found.name || found.id)) || id;
        };
        const rows = reasoningOptions(node).map((id, i) => h('div', {
          key: 'r' + i,
          style: node.reasoning === id ? { ...S.menuRow, background: C.hover, color: C.accent } : S.menuRow,
          onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
          onClick: () => { updateNode(node.id, { reasoning: id }); setOpenModelFor(null); },
        }, labelOf(id)));
        return h('div', { ref: isOpen ? dropdownRef : undefined, style: { position: 'relative', flex: '1 1 auto', minWidth: 0 } },
          h('button', {
            style: S.selectBtn,
            type: 'button',
            title: t('tipModel'),
            onMouseDown: (e) => e.stopPropagation(),
            onClick: () => setOpenModelFor(isOpen ? null : key),
          },
            h('span', { style: S.selectText }, labelOf(node.reasoning)),
            h('span', { style: S.caret }, '▾'),
          ),
          isOpen && h('div', { style: S.menu, onMouseDown: (e) => e.stopPropagation() }, rows),
        );
      };

      const modelControl = (node) => {
        if (!models.length) {
          return h('input', {
            style: S.input,
            value: node.model || '',
            placeholder: 'model id',
            onMouseDown: (e) => e.stopPropagation(),
            onChange: (e) => updateNode(node.id, { model: e.target.value }),
          });
        }
        const current = modelValue(node);
        const isOpen = openModelFor === node.id;
        const rows = [];
        let lastProvider = null;
        for (const m of models) {
          if (m.provider !== lastProvider) {
            rows.push(h('div', { key: 'h-' + m.provider, style: S.menuHead }, m.providerName || m.provider));
            lastProvider = m.provider;
          }
          const selectedRow = m.provider + '::' + m.model === current;
          rows.push(h('div', {
            key: m.provider + '::' + m.model,
            style: selectedRow ? { ...S.menuRow, background: C.hover, color: C.accent } : S.menuRow,
            onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
            onMouseLeave: (e) => { e.currentTarget.style.background = selectedRow ? C.hover : 'transparent'; },
            onClick: () => { updateNode(node.id, { provider: m.provider, model: m.model }); setOpenModelFor(null); },
          }, m.modelName || m.model));
        }
        return h('div', { ref: isOpen ? dropdownRef : undefined, style: { position: 'relative', flex: '1 1 auto', minWidth: 0 } },
          h('button', {
            style: S.selectBtn,
            type: 'button',
            onMouseDown: (e) => e.stopPropagation(),
            onClick: () => setOpenModelFor(isOpen ? null : node.id),
          },
            h('span', { style: S.selectText }, modelLabel(node)),
            h('span', { style: S.caret }, '▾'),
          ),
          isOpen && h('div', {
            style: S.menu,
            onMouseDown: (e) => e.stopPropagation(),
          }, rows),
        );
      };

      const edgeEls = edges.map((edge) => {
        const from = nodes.find((n) => n.id === edge.from);
        const to = nodes.find((n) => n.id === edge.to);
        if (!from || !to) return null;
        const color = (SOCKET_TYPES.find((t) => t.id === edge.type) || SOCKET_TYPES[0]).color;
        const d = edgePath(from, to, edge.type);
        const highlighted = cutVictims.includes(edge.id);
        return h('path', {
          key: edge.id,
          d,
          stroke: highlighted ? '#e5534b' : color,
          strokeWidth: highlighted ? 3 : 2,
          fill: 'none',
          style: { pointerEvents: 'none' },
        });
      });

      const renderBand = (node) => {
        const isEntry = node.id === 'lead';
        return h('div', { style: S.band },
          SOCKET_TYPES.map((sock) => h('div', { key: sock.id, style: S.row },
            h('span', { style: S.rowLabel }, sock.label),
            !isEntry && h('div', {
              style: { ...S.socket, left: -PORT / 2, borderColor: sock.color },
              title: t('tipSocketOut'),
              onMouseDown: (e) => onInputDown(e, node.id, sock.id),
              onMouseUp: (e) => onInputUp(e, node.id, sock.id),
            }),
            h('div', {
              style: { ...S.socket, right: -PORT / 2, borderColor: sock.color },
              title: t('tipSocketIn'),
              onMouseDown: (e) => onOutputDown(e, node.id, sock.id),
              onMouseUp: (e) => onOutputUp(e, node.id, sock.id),
            }),
          )),
        );
      };

      const reachableIds = reachableFrom(nodes, edges);

      // The canvas grows with its nodes so links past the original size are
      // still painted instead of being clipped by the SVG viewport.
      const contentW = Math.max(CONTENT_W, WORLD_PAD + Math.max(0, ...nodes.map((n) => n.x + NODE_W)) + 400);
      const contentH = Math.max(CONTENT_H, WORLD_PAD + Math.max(0, ...nodes.map((n) => n.y + NODE_H)) + 400);

      const hitTest = (m) => {
        const left = Math.min(m.x1, m.x2);
        const right = Math.max(m.x1, m.x2);
        const top = Math.min(m.y1, m.y2);
        const bottom = Math.max(m.y1, m.y2);
        return nodes
          .filter((n) => n.x + NODE_W >= left && n.x <= right && n.y + NODE_H >= top && n.y <= bottom)
          .map((n) => n.id);
      };

      return h('div', { style: S.root },
        h('div', { style: S.toolbar },
          h('button', { style: S.btn, onClick: () => addNode('agent'), type: 'button' }, t('addAgent')),
          h('button', { style: S.btn, onClick: () => addNode('lead'), type: 'button' }, t('addLead')),
          h('button', { style: S.btn, onClick: undo, type: 'button', title: t('tipUndo') }, t('undo')),
          h('button', {
            style: S.btn,
            onClick: () => pushPlan(enabled),
            type: 'button',
            title: t('tipSync'),
          }, t('sync')),

          h('button', {
            style: S.btn,
            onClick: focusLead,
            type: 'button',
            title: t('tipLocate'),
          }, t('locate')),
          h('button', {
            style: S.btn,
            onClick: () => focusLead(),
            type: 'button',
            title: t('tipResetZoom'),
          }, Math.round(view.k * 100) + '%'),
          syncNote ? h('span', { style: S.syncNote, title: syncNote }, syncNote) : null,
          h('button', {
            style: S.btn,
            onClick: toggleLang,
            type: 'button',
            title: 'Switch language / 切换语言',
          }, t('lang')),
          h('div', { style: S.moreBar },
            h('button', {
              style: S.btn,
              type: 'button',
              title: t('tipMore'),
              onMouseDown: (e) => e.stopPropagation(),
              onClick: () => setMenuOpen(!menuOpen),
            }, '⋯'),
            menuOpen && h('div', { style: S.moreMenu, onMouseDown: (e) => e.stopPropagation() },
              h('div', {
                style: S.moreRow,
                onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                onClick: () => { setMenuOpen(false); importFromClipboard(); },
              }, t('importBtn')),
              h('div', {
                style: S.moreRow,
                onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                onClick: () => { setMenuOpen(false); setHelpOpen(true); },
              }, t('help')),
              h('div', {
                style: S.moreRow,
                onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                onClick: () => {
                  const next = !cutMode;
                  setCutMode(next);
                  saveCutMode(next);
                },
              }, t('cutLinks') + t('sep') + (cutMode ? t('on') : t('off'))),
            ),
          ),
          h('div', { style: S.presetBar },
            h('div', { style: S.presetRowTop },
              h('input', {
                style: S.presetInput,
                value: presetName,
                placeholder: t('presetName'),
                onMouseDown: (e) => e.stopPropagation(),
                onChange: (e) => setPresetName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') savePresetNow(); },
              }),
              h('button', { style: S.btn, onClick: savePresetNow, type: 'button', title: t('tipSave') }, t('save')),
              (() => {
                const names = Object.keys(presets);
                return h('button', {
                  style: S.btn,
                  onClick: () => setPresetOpen(presetOpen === 'menu' ? null : 'menu'),
                  type: 'button',
                  title: t('tipPresets'),
                }, t('presets') + (names.length ? ' (' + names.length + ')' : ''));
              })(),
            ),
            // Feedback for saving / loading / syncing sits right under the name field.
            h('span', { style: S.status },
              status || (enabled ? (dirty ? t('unsaved') : t('synced')) : '')),
            presetOpen === 'menu' && (() => {
              const names = Object.keys(presets);
              return h('div', { style: S.presetMenu, onMouseDown: (e) => e.stopPropagation() },
                names.length
                  ? names.map((name) => h('div', {
                      key: name,
                      style: S.presetRow,
                      onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
                      onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                    },
                      h('span', { style: S.presetRowText, onClick: () => applyPreset(name) }, name),
                      h('button', { style: S.presetDel, type: 'button', title: t('del'), onClick: () => deletePreset(name) }, '×'),
                    ))
                  : h('div', { style: S.presetEmpty }, t('presetEmpty')),
              );
            })(),
          ),
        ),
        helpOpen && h('div', { style: S.helpOverlay, onMouseDown: (e) => e.stopPropagation() },
          h('div', { style: S.helpCard },
            h('div', { style: S.helpHead },
              h('span', { style: S.helpTitle }, t('helpTitle')),
              h('button', { style: S.btn, type: 'button', onClick: () => setHelpOpen(false) }, t('close')),
            ),
            h('div', { style: S.helpBody }, t('helpBody').split('\n').map((line, i) => h('div', { key: i, style: S.helpLine }, line))),
          ),
        ),
        h('div', { ref: canvasElRef, style: S.canvas, onMouseDown: onCanvasDown },
          h('button', {
            style: enabled ? S.floatOn : S.floatOff,
            type: 'button',
            onMouseDown: (e) => e.stopPropagation(),
            onClick: toggleEnabled,
            title: t('tipToggle'),
          }, enabled ? t('enabled') : t('disabled')),
          h('div', {
            ref: contentRef,
            style: {
              ...S.content, width: contentW, height: contentH, overflow: 'visible',
              transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')',
              transformOrigin: '0 0',
            },
          },
            h('svg', { width: contentW, height: contentH, style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' } },
              h('g', null, edgeEls),
              cutPath.length > 1 && h('polyline', {
                points: cutPath.map((pt) => (pt.x + WORLD_PAD) + ',' + (pt.y + WORLD_PAD)).join(' '),
                fill: 'none',
                stroke: '#e5534b',
                strokeWidth: 1.5,
                strokeDasharray: '5 4',
              }),
              marquee && h('rect', {
                x: Math.min(marquee.x1, marquee.x2) + WORLD_PAD,
                y: Math.min(marquee.y1, marquee.y2) + WORLD_PAD,
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
                fill: 'rgba(47,129,247,0.12)',
                stroke: C.accent,
                strokeWidth: 1,
                strokeDasharray: '4 3',
              }),
              pending && (() => {
                const color = (SOCKET_TYPES.find((t) => t.id === pending.type) || SOCKET_TYPES[0]).color;
                const d = 'M ' + (pending.sx + WORLD_PAD) + ' ' + (pending.sy + WORLD_PAD) + ' L ' + (pending.x + WORLD_PAD) + ' ' + (pending.y + WORLD_PAD);
                return h('path', { d, stroke: color, strokeWidth: 2, strokeDasharray: '4 4', fill: 'none' });
              })(),
            ),
            nodes.map((node) => {
              const isEntry = node.id === 'lead';
              const isLeadKind = node.kind === 'lead';
              const roleInput = (style) => h('div', { style },
                h('span', { style: S.fieldLabel }, t('role')),
                h('input', {
                  style: S.input,
                  value: node.role || '',
                  placeholder: isLeadKind ? t('rolePhLead') : t('rolePhAgent'),
                  onMouseDown: (e) => e.stopPropagation(),
                  onFocus: () => setSelectedIds([node.id]),
                  onChange: (e) => updateNode(node.id, { role: e.target.value }),
                }),
              );
              const isOrphan = node.id !== 'lead' && !reachableIds.has(node.id);
              return h('div', {
                key: node.id,
                'data-node': node.id,
                style: selectedIds.includes(node.id)
                  ? { ...S.node, left: node.x + WORLD_PAD, top: node.y + WORLD_PAD, ...(isLeadKind ? S.leadNode : null), ...(isOrphan ? S.orphanNode : null), ...S.nodeSel }
                  : { ...S.node, left: node.x + WORLD_PAD, top: node.y + WORLD_PAD, ...(isLeadKind ? S.leadNode : null), ...(isOrphan ? S.orphanNode : null) },
                title: isOrphan ? t('orphanTip') : undefined,
                onMouseDown: (e) => onNodeDown(e, node.id),
              },
                h('div', {
                  style: {
                    ...S.topBar,
                    background: isLeadKind ? '#2f81f7' : '#3fb950',
                  },
                }),
                enabled && h('div', {
                  style: {
                    ...S.statusChip,
                    color: isLeadKind ? C.dim
                      : statusById[node.id] === 'running' ? '#2f81f7'
                        : statusById[node.id] === 'failed' ? '#e5534b'
                          : statusById[node.id] === 'done' ? '#3fb950' : C.dim,
                  },
                  title: isLeadKind ? t('tipLead') : (isOrphan ? t('tipOrphan') : t('tipStatus')),
                }, isOrphan ? t('stOrphan')
                  : isLeadKind ? t('stLead')
                    : statusById[node.id] === 'running' ? t('stRunning')
                      : statusById[node.id] === 'failed' ? t('stFailed')
                        : statusById[node.id] === 'done' ? t('stDone') : t('stPending')),
                isEntry
                  ? h('div', { style: S.titleReadonly }, t('leadThis'))
                  : h('input', {
                      style: S.title,
                      value: node.label,
                      onMouseDown: (e) => e.stopPropagation(),
                      onFocus: () => setSelectedIds([node.id]),
                      onChange: (e) => updateNode(node.id, { label: e.target.value }),
                    }),
                isEntry
                  ? h(React.Fragment, null,
                    h('div', { style: S.leadLabel }, h('span', { style: S.fieldLabel }, t('task'))),
                    h('textarea', {
                      style: S.task,
                      value: node.task || '',
                      placeholder: t('taskPh'),
                      onMouseDown: (e) => e.stopPropagation(),
                      onFocus: () => setSelectedIds([node.id]),
                      onChange: (e) => updateNode(node.id, { task: e.target.value }),
                    }),
                  )
                  : isLeadKind
                    ? h(React.Fragment, null,
                      h('div', { style: S.leadLabel }, h('span', { style: S.fieldLabel }, t('role'))),
                      h('textarea', {
                        style: S.task,
                        value: node.role || '',
                        placeholder: t('rolePhLead'),
                        onMouseDown: (e) => e.stopPropagation(),
                        onFocus: () => setSelectedIds([node.id]),
                        onChange: (e) => updateNode(node.id, { role: e.target.value }),
                      }),
                    )
                    : h(React.Fragment, null,
                      h('div', { style: S.fieldModel },
                        h('span', { style: S.fieldLabel }, t('model')),
                        modelControl(node),
                      ),
                      h('div', { style: S.fieldReason },
                        h('span', { style: S.fieldLabel }, t('reason')),
                        reasoningControl(node),
                      ),
                      h('div', { style: S.fieldScope },
                        h('span', { style: S.fieldLabel }, t('scope')),
                        scopeToggle(node),
                      ),
                      h('div', { style: S.fieldFallback },
                        h('span', { style: S.fieldLabel }, t('fallbackModel')),
                        fallbackControl(node),
                      ),
                      h('div', { style: S.fieldMemory },
                        h('span', { style: S.fieldLabel }, t('memory')),
                        memoryToggle(node),
                      ),
                      h('div', { style: S.fieldRole },
                        h('span', { style: S.fieldLabel }, t('role')),
                        h('button', {
                          style: S.selectBtn,
                          type: 'button',
                          title: t('rolePhAgent'),
                          onMouseDown: (e) => e.stopPropagation(),
                          onClick: () => setRoleEditFor(roleEditFor === node.id ? null : node.id),
                        },
                          h('span', { style: S.selectText }, node.role || t('rolePhAgent')),
                          h('span', { style: S.caret }, '✎'),
                        ),
                      ),
                      roleEditFor === node.id && h('div', {
                        style: S.rolePopover,
                        onMouseDown: (e) => e.stopPropagation(),
                      },
                        h('textarea', {
                          style: S.roleArea,
                          value: node.role || '',
                          placeholder: t('rolePhAgent'),
                          autoFocus: true,
                          onChange: (e) => updateNode(node.id, { role: e.target.value }),
                        }),
                      ),
                    ),
                selectedIds.includes(node.id) && node.id !== 'lead' && h('div', {
                  style: S.nodeDelete,
                  title: t('delNodeTip'),
                  onMouseDown: (e) => e.stopPropagation(),
                  onClick: () => deleteNode(node.id),
                }, '×'),
                renderBand(node),
              );
            }),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'remote.session', 'sidebarRight'],
      apply(ctx) {
        try {
        hostCtx = ctx;
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            // Keep the tab (and its canvas state) alive while the pane is closed.
            keepMounted: true,
            title: () => 'Workflow',
            guide: [{
              id: 'workflow-canvas',
              order: 100,
              title: () => 'Workflow canvas',
              description: () => pick('画一张子代理流程图', 'Sketch a subagent workflow'),
            }],
          }), 'workflow-canvas: tab type');

          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
          }, (props) => h(CanvasBoundary, null, h(WorkflowCanvas, props)))), 'workflow-canvas: tab body');
        });
        } catch (error) {
          try { console.error('[workflow-canvas] apply failed', error); } catch (_e) { /* ignore */ }
        }
      },
      __test: { topoOrder, buildWorkflowScript, buildPlan, loadDoc, saveDoc, storageKey, socketCenterY, distanceToEdge, edgeCurve },
    };
  },
});
