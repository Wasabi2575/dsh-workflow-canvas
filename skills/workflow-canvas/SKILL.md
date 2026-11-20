---
name: workflow-canvas
description: Workflow canvas (画布 / 工作流 / 编排): inspect, draw, edit or run a node graph of DSH subagents — add or re-role nodes, wire typed links, run in parallel waves, handle Lead steps, presets and memory. Load before using canvas_inspect, canvas_generate, canvas_patch or canvas_workflow.
---

# Workflow canvas

A canvas is a DAG of agents the user can see and edit.

## Node kinds

- **Lead** (blue top bar) — performed by the conversation itself, never spawned. The entry Lead holds the overall task; any other Lead node holds a role and pauses the run so you can do that step.
- **Subagent** (green top bar) — spawned as a child agent with its own model, reasoning effort, capability scope, fallback model and memory switch.

## Which tool to call

| The user asks for | Call |
|---|---|
| inspecting or editing a manually drawn / preset canvas | `canvas_inspect` first to read node ids, models and links |
| a visual workflow, pipeline, or graph of agents | `canvas_generate` (replaces the canvas) |
| a change to the existing canvas | `canvas_patch` (edits in place, keeps the layout) |
| running the canvas | `canvas_workflow` (supports `leadResult`, `task` override, `reset: true`) |

Prefer `canvas_patch` for edits: it merges by node id, so renamed, re-roled or re-modelled nodes keep their position and untouched nodes stay as they are. Call `canvas_inspect` first if you do not already know the current node ids. Regenerating throws the layout away.

## Node fields

`id` (stable handle, never reuse it for a different node), `kind` (`lead` or `agent`), `label` (display name), `role` (what this step must do — this is the instruction the node actually follows), `provider` / `model`, `reasoning` (an effort id declared by that model), `preset` (`standard` or `minimal`), `keepSession`, `fallbackModel` / `fallbackProvider`.

Fill `role` for every node. A node with an empty role still runs, but it invents its own task and may wander.

Capability (`preset`) is a two-state switch:

| value | means | useful for |
|---|---|---|
| `standard` | all tools — filesystem read/write/edit, shells, jobs, schedule, skills, subagents, workflow, web, present, office | steps that actually do work |
| `minimal` | read-only thinking — file read/write/edit disabled, no subagents, no workflow, no web; only image reading, persistent shells and compaction | steps that should only reason: review, classify, estimate, summarise |

## Links

| type | colour | carries |
|---|---|---|
| `prompt` | grey | the upstream result as plain text |
| `structured` | blue | a JSON object; the upstream node is asked for structured output automatically, so do not set that by hand |
| `session-ref` | purple | the upstream child session; the downstream step runs inside it |

Links only join matching types. Nodes the entry Lead cannot reach are skipped at run time and drawn dashed.

## Running

1. The canvas must be enabled (the pill over the canvas); `canvas_workflow` refuses while it is disabled.
2. You may pass `task` to override the entry Lead's task (handy when reusing a preset), or `reset: true` to discard a paused run and start from scratch.
3. Subagent nodes run in parallel waves of up to four; the run stops at every Lead node and returns `status: "need-lead"`.
4. Do that Lead step yourself, then call `canvas_workflow` again with `leadResult` — do not spawn an agent for it.
5. When a `session-ref` link points into that Lead node the result lists `sessions: [{ label, childId }]`; you may message those agents directly to follow up.

## Failures

A failing node (unknown model, provider error, a stop reason other than completed) does not abort the run. Its result carries the reason, a node with `fallbackModel` is retried once on that model, and unrecovered failures are listed in `failed: [{ id, label, reason }]` while downstream nodes are warned not to treat the error as valid output. Failed nodes show red in the canvas.

## Memory

`keepSession: true` reuses that node's child session — across runs, and after a restart through a persisted id (cold resume). If the Host refuses the resume the record is dropped and the node starts fresh.

## Style

Keep labels short and distinct; ids must be unique even when labels repeat. Describe each step by its outcome, not by the tool it uses.
