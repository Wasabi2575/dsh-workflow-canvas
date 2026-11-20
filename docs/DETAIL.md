# Workflow canvas

A Blender-style node canvas for orchestrating DSH agents, docked in the right
Sidebar. Draw a DAG, enable it, and ask the agent to run it — subagent nodes are
spawned for real, Lead nodes pause the run and are performed by the conversation
itself.

## Canvas

- **Subagent node** (green top bar): spawns a child agent with its own
  `provider` / `model` / `reasoning effort` / `preset`. Optional **记忆** reuses
  the node's previous session inside the same process; optional **备用** retries
  once on a fallback model when the node fails.
- **Lead node** (blue top bar): performed by the conversation, never spawned.
  The entry node also carries the task.
- **Sockets are typed** (`prompt` / `structured` / `session`); a link can only
  join the same type. Drag from a right socket to a left socket to connect, drag
  a connected left socket away to cut it.
- Nodes the entry cannot reach are drawn with a dashed grey border and marked
  **未连线**; they are skipped at run time instead of failing the run.
- Wheel zooms around the cursor (20%–300%); the percentage button resets it.
- Selected node shows a `×` to delete; `↶ 撤销` restores the last 50 structural
  edits.

## Running

1. Type the task into the Lead node.
2. Connect the nodes you want to run.
3. Press `● 启用` (publishes the plan to the Host) and tell the agent to run the
   canvas.

The Host executes subagent nodes in parallel waves (up to 4 at a time), and stops
at every Lead node with `status: "need-lead"` so the conversation can perform
that step and continue with `leadResult`.

## Presets

Name the current canvas and press `☆ 保存` to store it; `☰ 预设` lists saved
workflows and can load or delete them. Presets live in browser storage, are
shared across sessions of the same origin, and are not synchronized across
machines. Duplicate names are refused rather than overwritten.

## Limits

- Presets do not travel between the Desktop app and `dsh web` (different
  origins), nor across machines.
- 记忆 (`keepSession`) only reuses a session created in the same Host process; a
  restart starts fresh.
- Node-level run status is read from the subagent catalog, so Lead steps show
  **由对话执行** rather than a tracked state.
- The Host plan is persisted in the profile, but a stale `childId` is discarded
  after a restart.
