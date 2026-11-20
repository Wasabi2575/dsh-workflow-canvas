# DSH Workflow Canvas

[![npm version](https://img.shields.io/npm/v/dsh-workflow-canvas)](https://www.npmjs.com/package/dsh-workflow-canvas)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.2-2f81f7)](https://github.com/Wasabi2575/dsh-workflow-canvas)
[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950.svg)](LICENSE)

English | [中文](README.zh.md)

Orchestrate subagent workflows from the DSH sidebar. Draw each step as a node, wire
the data flow with three link types, enable it, and run it from chat — subagent nodes
are spawned for real, Lead nodes pause the run and are performed by the conversation
itself.

Describe a workflow in one sentence and the agent sketches the whole canvas for you;
tweak it in place afterwards with `canvas_patch`. Links make the flow obvious at a
glance — grey carries text, blue carries JSON, purple continues the upstream session.

![workflow canvas](docs/images/canvas-demo.png)

## Installation

Requires DeepSeek Harness **0.2.2** or newer (the package declares
`engines.dsh: ">=0.2.2-rc.1 <0.3.0-0"`).

- **From the plugin market** — open **Plugins → Discover**, search
  *"workflow canvas"*, and install. The dshmarket entry is still awaiting
  review; see the
  [catalog PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/17180).
- **From npm** — install the published package `dsh-workflow-canvas` from the
  **Plugins** panel, or via the `plugin_manager` tool / `dsh` CLI with
  `install_bundle` and `target: dsh-workflow-canvas`.
- **From source** — clone the repository and install it as a local directory
  with **Plugins → Add plugin**, pointing at the checkout.

After installing, enable the plugin and the `workflow` tab appears in the right
sidebar.

## Quick start (30 seconds)

- **Zero-setup tryout**: open the right-sidebar `Workflow` tab → load a starter
  template from `☰ Presets` → press **● ON** at top-left → ask in chat to run the
  canvas.
- **Prompts you can copy right into chat**:
  - **Sketch from one sentence**: *"Build a parallel research workflow on the canvas: two subagents investigate competitors and technical feasibility in parallel, pause for me (Lead) to decide, then hand off to a writer subagent."*
  - **Patch in place**: *"Inspect the current canvas, turn Memory on for the feasibility node, and add a read-only cost-estimate node wired in parallel into plan synthesis."*
  - **Reuse a template with a new task**: *"Run the current canvas with the task: evaluate adding a local knowledge base to this project."*

## How this differs from other canvas plugins

DSH has more than one "workflow canvas". This one orchestrates **subagents** from
the sidebar, performs Lead steps in the conversation itself, and lets the agent
sketch a whole canvas from one sentence. For tool-call / condition / output
pipelines compiled to `ctx.workflows`, see
[`@piedpiper911/dsh-workflow-canvas`](https://github.com/PiedPiper911/dsh-workflow-canvas).

## Nodes

- **Subagent node** (green top bar) — spawns a child agent. Each node sets its own
  model, reasoning effort, capability scope (`standard` / `minimal`), fallback
  model, memory and role.
- **Lead node** (blue top bar) — performed by the conversation, never spawned. The
  entry Lead carries the overall task; the run stops at every Lead step and resumes
  with your answer.

## Links

| Type | Colour | Carries |
|---|---|---|
| `prompt` | grey | plain text |
| `structured` | blue | a JSON object; the upstream node is asked for structured output automatically |
| `session` | purple | the upstream child session, so the downstream runs **inside it** |

Drag from a right socket to a left socket, or from a left socket to a right one
(cycles are blocked immediately). Drag a connected left socket away to detach.

## Canvas controls & shortcuts

| Control / Shortcut | Action |
|---|---|
| `Shift+A` | Open the Add Node menu at the cursor (`1` / `2` to drop immediately) |
| Middle-drag / `Space` + left-drag | Pan the canvas (works even when starting over a node) |
| Wheel / `⊡ Fit` / `100%` | Cursor-anchored zoom / fit all nodes in view / reset to 100% on Lead |
| Marquee drag + `Ctrl+D` / `Delete` | Multi-select move, duplicate (preserving settings), or batch delete |
| `Ctrl+Z` / `Esc` | Undo structural edits / close open popups and menus |
| Right-drag across links | Cut swept links (toggle under `⋯`); `⋯` also has `⊞ Auto layout`, `⇧ Copy JSON`, and `Visual effects` (Minimal / Standard / Vivid) |

## Running

1. Write the task in the entry Lead, and a role for each node (or leave the task
   blank and pass `task` from chat when reusing a template).
2. Connect the nodes — unlinked nodes are dashed and skipped.
3. Press the **● ON / ○ OFF** pill at the top-left of the canvas, then ask in chat
   to run it (pass `reset: true` to restart from scratch).
4. The run proceeds in parallel waves (up to 4 at a time) and pauses at each Lead
   node with the results collected so far. Click a subagent's status pill (e.g.
   `Done ↗`) to jump straight to its live chat pane.

## Lead handover

When a `session` link points into a Lead node, the run reports that child session
id at the Lead step, so the conversation can keep talking to that agent instead of
only receiving its text.

## Inspecting, generating and editing the canvas from chat

- `canvas_inspect` — read the current canvas (enabled state, task, node ids/models/roles
  and links), so the agent can safely patch manually edited or preset graphs.
- `canvas_generate` — build a whole canvas from a node/edge sketch (replaces it).
- `canvas_patch` — edit it in place: update nodes by id, add or remove nodes and
  links, leaving positions and everything else untouched.

Generate and patch both write the canvas to the workspace, and the panel picks it
up within ~1.5s.

## Presets & sharing

`☰ Presets` ships with ready-to-run starter templates; name any canvas and press
`☆ Save` to keep your own. Presets live in browser storage; to share across
machines or between Desktop and `dsh web`, use `⋯ → ⇧ Copy JSON` and `⇩ Import`.

## Memory

A node with memory on reuses its child session: within a run, across runs in the
same session, and — through the persisted child id — after a restart, where the
Host cold-resumes it. A resume the Host refuses is forgotten and the node starts
fresh.

## Limits

- Saved presets live in browser storage and do not auto-sync between the Desktop
  app and `dsh web`, nor across machines (use `⋯ → ⇧ Copy JSON` and `⇩ Import`
  to move or share them).
- Node status is read from the subagent catalog, so Lead steps show **Runs in chat**
  instead of a tracked state.
- Up to 4 nodes run at a time.

## Making the agent use this plugin

The bundled guide ships as a skill named `workflow-canvas`. DSH has no "auto-load"
switch: the model sees each skill's **name and description** in its catalogue and
loads the body on demand. Three things make it reliable:

1. **A description that names the trigger words** — canvas, workflow, pipeline,
   node graph, 画布, 工作流, 编排.
2. **Pointers from the tools** — every `canvas_*` tool description tells the model
   to load the skill first, and tools are always in context.
3. **A line in your project's `AGENTS.md`** — the strongest option, because it is
   always loaded:

```markdown
When a task involves the workflow canvas or the canvas_* tools, call the `skill`
tool with name `workflow-canvas` first.
```

## Development

Edit `client.js` / `index.js` and reload the app; client changes hot-reload, Host
changes need a restart. Run `npm test` for the test suite. See
[docs/DETAIL.md](docs/DETAIL.md) for the internals.

## License

MIT — see [LICENSE](LICENSE).
