# Mechanism & Architecture

English | [中文](MECHANISM.zh.md)

This document explains how **DSH Workflow Canvas** works under the hood: how the
sidebar canvas (Client) and the DSH Host stay in sync, how the DAG executor runs
parallel waves and pauses at Lead gates, what the three link types actually do
at run time, and how memory cold-resume, fallbacks, and live status tracking work.

---

## 1. Architecture: Bidirectional Client ↔ Host Bridge

The plugin splits cleanly into two halves:
- **Client (`client.js`)**: Mounted as a right-sidebar `Workflow` tab (`keepMounted: true`, keyed by `sessionId` for isolation, preserving state while collapsed). Owns visual editing, live cross-tab preset sync, global layout preferences, `rAF`-coalesced rendering, visibility-aware adaptive polling, shortcuts, visual effects, and live status rendering.
- **Host (`index.js` + `lib/graph.js` + `lib/telemetry.js`)**: Registers the bundled `workflow-canvas` skill, compact per-session `systemPrompt.context`, two commands (`/canvas-sync` and `/canvas-stop`), and four tools (`canvas_inspect`, `canvas_generate`, `canvas_patch`, `canvas_workflow`). Owns real subagent execution, head+tail upstream output clipping, safe read-only transient backoff retry, unified cancellation, LRU memory/disk hygiene, and atomic state persistence.

```mermaid
flowchart LR
    subgraph Client["Sidebar Canvas (client.js)"]
        UI["Graph Editor / Presets / Pills / Stop"]
        LS["localStorage\n(drafts / presets / prefs)"]
        Poll["workspaceFiles Poll\n(every 1.5s)"]
        Cat["subagentCatalog Observer\n(every 700ms while running)"]
    end

    subgraph Host["Host Plugin (index.js)"]
        Sync["/canvas-sync & /canvas-stop"]
        Store["Atomic Disk Store\n.workflow-canvas-state.json"]
        Tools["canvas_inspect / generate / patch"]
        Exec["canvas_workflow\nDAG Wave Executor"]
        Sub["ctx.subagents\nReal Child Sessions"]
    end

    UI <--> LS
    UI -- "enable / sync / stop\n/canvas-sync & /canvas-stop" --> Sync
    Sync --> Store
    Tools -- "writes .dsh/canvas/<sid>.json" --> Poll
    Poll -- "timestamp guard + merge layout" --> UI
    Exec <--> Store
    Exec -- "startActivation / interrupt" --> Sub
    Sub -- "live status & childId" --> Cat
    Cat --> UI
```

### Sync & Conflict-Free Editing
1. **Canvas → Host (`pushPlan` → `/canvas-sync`)**:
   - Triggered when pressing **● ON**, clicking `↥ Sync`, or starting a chat turn while `enabled && dirty` (suppressed while `runState.status` is `running` or `need-lead` so replying at a Lead gate never wipes paused progress).
   - The Host stores the plan per session in LRU-bounded `canvasBySession` and persists it via `writeFileAtomic` (unique temp file → `renameSync`) to `<DSH_PROFILE_DIR>/.workflow-canvas-state.json` (identical re-syncs preserve any active `waitingLead`).
2. **Host → Canvas (Atomic Bridge + Visibility-Aware `stat` Polling)**:
   - `canvas_generate` and `canvas_patch` update `canvasBySession` immediately and atomically publish `<workspace>/.dsh/canvas/<safeSessionId>.json` with a monotonic `at` timestamp.
   - The client probes `remote.workspaceFiles.stat` first and skips `read` when `value.version` is unchanged or absent (`workspace-file/not-found`). Polling pauses completely while collapsed or hidden (`[data-dockkit-content]` `aria-hidden`/`inert`), wakes on frame 0 via `MutationObserver` on expand, and adapts between 1.5s (active) and 4s (idle disabled).
   - **Local-wins timestamp guard**: local edits record `lastLocalEditAtRef` synchronously and debounce `localStorage` writes (250ms); any bridge file with `effectiveLocalAt >= doc.at` is skipped so manual edits and live node statuses are never clobbered.
   - **In-place `merge` mode**: `canvas_patch` publishes `mode: "merge"` together with `removeNodes` and `removeEdges`, so existing node coordinates and the current viewport remain untouched while newly added nodes are placed neatly relative to their upstream parent.

---

## 2. DAG Wave Execution & Lead Handover

When `canvas_workflow` runs, `executePlan` executes the following pipeline:

1. **Entry stripping & task override**: The entry `lead` node is stripped (`withoutEntry`) and never spawned. If `args.task` is provided, it overrides `plan.task` for this run (allowing blank-task templates to be reused straight from chat).
2. **DAG & controlled-loop validation**: `orderNodes` validates forward edges (`!e.loop`) via Kahn topological sort; `validateLoopEdges` separately verifies controlled retry edges (`e.loop === true`) leave a condition node, target a strict forward ancestor (never entry Lead), and do not overlap/cross.
3. **Reachability & inactive pruning**: Topological traversal over forward edges computes active entry paths, stopping at blank-role Leads without active direct subagent input; independent valid paths preserve shared descendants. Unreachable nodes, inactive Leads, and dangling agent chains beside an active non-ancestor Lead are dashed and listed in `skipped`. Dangling chains are pruned to a fixed point before plan export. Missing-link indications are separate: legal terminal agents still run. Runtime dependencies, branch pruning, fallback traversal and loop handling all use the filtered effective graph. Original forward cycles are rejected before filtering; loops touching active nodes are revalidated on the effective graph and errors are surfaced instead of silently dropping edges. Lead-ancestor bitsets are propagated once in topological order to avoid repeated full-chain scans during leaf pruning. Client classification is memoized by topology/kind/role rather than coordinates.
4. **Event-driven concurrency pool, conditional pruning, retry loops & partial resume**:
   - In-progress state lives in `runBySession`, and each completed or halted run is snapshotted into `lastRunBySession`.
   - Instead of a strict per-wave barrier, the executor runs an **event-driven concurrency pool (`inFlight` + `Promise.race`, default 4, configurable 1–8)**:
     - The instant any running subagent finishes, newly unblocked downstream subagents launch immediately — fast branches never stall waiting for slower siblings.
     - **Condition nodes (`kind: "condition"`)** run as lightweight read-only (`minimal`) judges with a strict structured `outputSchema` (supporting binary `if/else`, multi-way `switch/case`, and `multiMatch` parallel fan-out). Unmatched outgoing edges are blocked and unchosen branches are pruned via ancestor-aware BFS (so an upstream `session-ref` side wire cannot bypass a vetoed branch). If zero branches match or the condition node itself fails, it never guesses a branch — it skips intermediate branches and hands off to the nearest downstream Lead (or halts cleanly if none exists).
     - **Controlled retry loops (`loop: true, maxIterations: 1–10`)**: when a condition matches a loop back-edge (taking priority over forward branches under `multiMatch`), if within per-loop and global safety limits (`20`), the executor resets strictly `descendants(target) ∩ ancestors(source)` (bypass nodes outside the loop never re-run), injects the rejection reason into the entry node (supporting both subagents and Lead nodes), and reuses its healthy warm session with an incremental correction prompt (**interaction with pinned memory `memoryChildId`**: Round 1 enters the pinned/saved memory session; if Round 1 finishes healthy, retry rounds continue that same warm session with incremental feedback; if Round 1 crashes, returns empty, or the warm session is refused, that retry round intentionally skips `memoryChildId`/`keepSession` and opens a clean fresh session with the full brief + feedback so it never loops inside a broken context). At the limit, it circuit-breaks and hands off `1..N` round summaries to the nearest downstream Lead.
     - Intermediate **non-entry Lead nodes** (including `Lead → Lead` stage chains) pause with `status: "need-lead"`; a **terminal Lead** (zero remaining downstream work) finishes in one shot with `status: "done"` and `finalLead`.
   - **`retryFailed: true`** and **`fromNodes: [...]`** reuse succeeded outputs from `lastRunBySession` and re-run only failed/target nodes plus their downstream; `reset: true` discards progress and starts from scratch; **`cancel: true`** or clicking **`⏹ Stop`** via concurrent `/canvas-stop` (as well as DSH's native chat Stop button) immediately calls `subagents.interrupt(cid, { kind: 'user' })`, `drainDescendants([rootAgent])`, and `rootAgent.cancel({ kind: 'user' }, { keepInbox: true })`, races `abortPromise` out of the pool without spawning fallback retries, preserves completed-node cache, and clears `waitingLead` / `.run.json`.

```mermaid
sequenceDiagram
    participant Chat as Main Chat (Lead)
    participant Exec as Host Executor (executePlan)
    participant Sub1 as Subagents Wave 1 (up to 4)
    participant Sub2 as Subagents Wave 2 (up to 4)

    Chat->>Exec: canvas_workflow()
    Exec->>Sub1: Parallel startActivation (Nodes A, B)
    Sub1-->>Exec: Results (text or structured JSON)
    Note over Exec: Reaches Lead node — pauses with state kept
    Exec-->>Chat: status="need-lead" + results + sessions (purple links)
    Note over Chat: Lead decides (can follow up with purple sessions)
    Chat->>Exec: canvas_workflow(leadResult="approved plan")
    Exec->>Sub2: Parallel startActivation (Nodes C, D)
    Sub2-->>Exec: Results
    Exec-->>Chat: status="done" + results + failed + skipped
```

---

## 3. Runtime Semantics of the Three Link Types

The three link types are distinct runtime channels, not just visual colour coding:

| Link Type | Colour | Runtime Behaviour |
|---|---|---|
| `prompt` | grey | Appends upstream text as a labelled section inside the downstream node's `briefFor` prompt. |
| `structured` | blue | `spawnOnce` detects any outgoing `structured` edge and **automatically** injects a JSON `outputSchema` (`type: "object", additionalProperties: true`) into `startActivation`. `textOf` extracts `result.structured` as JSON and wraps it in a `` ```json `` block for downstream consumers. |
| `session` (`session-ref`) | purple | **Into a subagent**: resolves the upstream `childId` (preferring in-process `liveChild`, falling back to disk-persisted `childByNode`) and passes it to `startActivation({ ...spec, childId })`, running the downstream step **inside the upstream child's live conversation**.<br>**Into a Lead**: reports `sessions: [{ label, childId }]` in `need-lead` so the main chat can message that subagent directly for follow-ups or fixes. |

---

## 4. Memory Cold-Resume, Fallback Retry & Failure Isolation

### Memory (`keepSession`) & Cold Resume
- The Host keeps two LRU-bounded maps keyed by `<sessionId>::<nodeId>`: `liveChild` (current process) and `childByNode` (atomically persisted in `.workflow-canvas-state.json`).
- A node with `keepSession: true` resolves its previous session in priority order: **explicitly pinned `memoryChildId` → persisted `childByNode` → in-process `liveChild`**, so temporary `keepSession=false` runs never clobber saved memory.
- After a Host restart, `childByNode` enables **cold resume**; if the Host refuses activation (`activation-failed`), the stale ID is dropped and the node starts a fresh child session automatically.

### Recovery, Transient Retry & Failure Isolation
- Aligned with DSH 0.2.2 `SubagentResult.diagnostic` and `stopReason`:
  1. **1-shot strict JSON rescue**: when a condition or `structured` node replies with valid JSON text without calling `structured_output` (causing DSH to rewrite `completed → error` with no `diagnostic`), the strict JSON payload is rescued on attempt #1 with zero extra LLM calls.
  2. **Read-only transient & plain-JSON retry**: strictly read-only (`minimal` / `condition`) nodes perform 1 abort-aware backoff retry (`600ms`) on transient 429/502/503/504/timeout errors, or 1 `noSchema` retry on schema errors (never on `max-tokens` / `refusal`); **writable `standard` nodes are never auto-retried**.
  3. **Fallback model & circuit breaking**: nodes with `fallbackModel` / `fallbackProvider` retry once on the fallback route; permission denials or 2 consecutive `activation-failed` errors circuit-break downstream waves; remaining single-node failures are recorded in `failed` with explicit downstream warnings without aborting unrelated branches.

---

## 5. Live Status Pills & Click-to-Open Subagent Chats

1. **Node tagging**: `spawnOnce` tags every spawned child with `label: "<node.label>#<node.id>"`.
2. **Catalog & run-state telemetry tracking**: While a turn runs (every 700ms, plus on mount and turn completion), the client reads `subagentCatalog` and `subagentTiming` from `sessions.list`, matching `/#([^\s#]+)$/` to map each child back to its canvas node (`running` takes strict priority over historical rounds) and latest `childId`, while also polling `<workspace>/.dsh/canvas/<sid>.run.json` for condition `decisions`, `pruned` nodes, `blockedEdges`, live retry counts (`loopCounts` / `nodeAttempts`), `waitingLead`, and the zero-token `summary` payload (per-node timestamps/durations, fallback/session badges, loop history — never injected into model prompts).
3. **Authoritative Lead `⏸ Ready` state, unified Stop & Run Summary**: Authoritative `.run.json` status takes precedence (`need-lead` highlights **`⏸ Ready`**; `halted` / `done` / `idle` never re-lock from historical subagent statuses), falling back to forward-edge heuristics only when `.run.json` is absent. Both the top-left **`⏹ Stop`** pill (muted when idle, red when active) and bottom-left **Summary** pill (muted gray before the first run, lighting up live with `⋯ → 📊 Run summary` once execution begins) remain visible with local timing/branch/loop breakdowns and Markdown export.
4. **Jump to live chat**: Clicking any subagent's bottom-left status pill (e.g. `Running ↗`, `Done ↗`) opens `dsh-resource://subagentchat/session/<childId>?parent=<sessionId>&mode=<mode>` via `sidebarRight.openResource(..., { kind: 'subagentchat', preferNewPane: true })`.
5. **Comment frames & standalone notes**: Comment metadata syncs between client and host via `/canvas-sync` and `.dsh/canvas/<sid>.json` (the agent reads/writes semantic fields `id`, `title`, `body`, `color`, `fontSize`, and `nodeIds` only — comments never execute or consume subagent tokens).

---

## 6. Per-Session Context, Skill & Tool Discovery

To keep the agent aligned with an enabled canvas without leaking instructions into disabled chats or subagents, the plugin combines four layers:
1. **Per-session `systemPrompt.context` injection**: Strictly scoped by `sessionId` (never injected into subagents), injecting a live canvas summary on each turn (node overview, controlled retry loop count, global refs count, memory/permission/partial-resume hints; or when paused at a Lead step, the pending Lead role, `leadResult` / `cancel: true` / `reset: true`, and any loop rejection feedback).
2. **Bundled skill provider**: `index.js` registers `workflow-canvas` via `ctx.skills.registerProvider` with bilingual trigger keywords (`画布 / 工作流 / 预设 / 条件分支 / 回环 / 注释`) and all 5 `canvas_*` tool names, serving [skills/workflow-canvas/SKILL.md](../skills/workflow-canvas/SKILL.md).
3. **Tool-level pointers**: `canvas_inspect`, `canvas_preset`, `canvas_generate`, `canvas_patch`, and `canvas_workflow` descriptions work together with the `workflow-canvas` skill while tool schemas stay available in context.
4. **Optional `AGENTS.md` rule**: Adding a single line in a project's `AGENTS.md` guarantees deterministic skill loading in every session.
