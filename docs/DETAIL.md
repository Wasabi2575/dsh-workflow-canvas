# Workflow canvas

A Blender-style node canvas for orchestrating DSH agents, docked in the right
Sidebar. Draw a DAG, enable it, and ask the agent to run it — subagent nodes are
spawned for real, Lead nodes pause the run and are performed by the conversation
itself.

## Canvas

- **Subagent node** (green top bar): spawns a child agent with its own
  `provider` / `model` / `reasoning effort` / capability scope. Optional **记忆**
  reuses the node's session; optional **备用** retries once on a fallback model.
- **Lead node** (blue top bar): performed by the conversation, never spawned. The
  entry node carries the task; added Lead nodes carry a role.
- **Sockets are typed** (`prompt` / `structured` / `session`); a link can only
  join the same type, in either direction. Drag a connected input away to detach.
- Nodes the entry cannot reach are drawn dashed and skipped at run time.
- Wheel zooms around the cursor; the percentage button resets and recentres on the
  Lead; `◎ 定位` recentres without changing zoom.
- Marquee selection: press on empty canvas and drag; dragging any selected node
  moves the whole selection.
- Right-drag across links cuts them on release; the swept path and the links about
  to be cut are drawn in red. Toggle it under `⋯`.

## Editing from chat

| Tool | Effect |
|---|---|
| `canvas_generate` | replaces the canvas with a node/edge sketch |
| `canvas_patch` | edits in place: update nodes by id, add/remove nodes and links |

Both publish `<workspace>/.dsh/canvas/<session>.json`, which the panel polls every
1.5s. A patch document is applied in merge mode, so node positions survive.

## Running

Subagent nodes run in parallel waves (up to 4). The run stops at every Lead node
with `status: "need-lead"` and returns the collected results plus, for `session`
links into that Lead, the upstream child session ids so the conversation can keep
talking to those agents.

## Memory

`节点 id → child session id` is remembered on disk, keyed per session. A node with
memory on resumes that child (cold resume after a restart); if the Host refuses,
the record is dropped and the node starts fresh.

## Limits

- Presets live in browser storage: not shared between the Desktop app and
  `dsh web`, not synchronised across machines.
- Lead steps have no tracked state; they show **由对话执行**.
- Up to 4 nodes run at a time.
