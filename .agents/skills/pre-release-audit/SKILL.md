---
name: pre-release-audit
description: >-
  Three-way parallel adversarial engineering audit for dsh-workflow-canvas covering
  concurrency/persistence races, input/platform/UI edge cases, and DSH host contract
  alignment with proactive app.asar verification prompts. Use before cutting a release,
  after completing major features or multi-issue fixes, or when the user asks to
  deep-audit, hunt for hidden bugs, check regressions, or review before release.
---

# Pre-Release Adversarial Audit

Run a rigorous, evidence-backed audit of pending changes in `dsh-workflow-canvas` using **3 parallel read-only adversarial `research` subagents** so each lens runs in a fresh context free of author confirmation bias.

## Operating Principle

- **Launch all 3 adversarial `research` subagents in parallel** (`invoke_subagent` with `TypeName: "research"`) in a single turn, passing each subagent the scope (`git diff` / changed files) and its dedicated checklist below.
- Require **concrete `file:line` evidence** for every finding.
- After all 3 subagents report back, triage and fix every confirmed bug cleanly, add regression tests, and run the Final Verification Gate.
- If a DSH host API signature or Electron runtime behavior is not confirmed in `AGENTS.md` Section 3, **never guess** — include the exact copy-pasteable verification prompt for the user's DSH agent in the final report.

---

## Subagent A — Concurrency, State & Persistence Adversary

Hunt for async races, state corruption, and durability hazards:

1. **Re-entrancy & cancellation**:
   - Single-session re-entrancy lock in `executePlan` (`activeRunBySession`), while `cancel: true` always succeeds.
   - `AbortSignal` checked before every spawn, warm retry, `session-ref` / `keepSession` fallback, read-only transient backoff (`delayWithSignal`), and `fallbackModel` retry.
   - `Promise.race` unblocks immediately on abort; partial results preserve into `lastRunBySession`; stale `.run.json` cannot trap the UI after abort or restart.
2. **Client ↔ Host sync & debounce races**:
   - Auto-sync on turn start suppressed while `runState.status` is `running` or `need-lead`.
   - Debounced `saveDoc` tracks synchronous edit timestamp (`lastLocalEditAtRef`) so concurrent polling never clobbers unflushed edits; initial mount skips redundant write; local imports/presets never inherit stale remote `at`.
   - `rAF`-coalesced drag `mouseup` resolves drop coordinates directly from the event (never stale React state for `marquee` / `pending`); `window.blur` clears active drags.
3. **Atomic writes, LRU & cleanup**:
   - All disk writes (`saveStore`, `publishCanvas`, `publishRunState`) use `writeFileAtomic` (no raw `writeFileSync`) and `safeSessionFileBase`.
   - All in-memory maps (`canvasBySession`, `lastRunBySession`, `liveChild`, `childByNode`, `lastCleanupByDir`) are LRU-bounded (including read-refresh on active old sessions) and `localStorage` pruning stays active in long-lived Electron sessions.
   - Poller only updates `lastText` / `lastRunText` / stat fingerprints after `JSON.parse` succeeds.

---

## Subagent B — Input Boundaries, Platform & UI Adversary

Hunt for silent drops, encoding/OS hazards, backward-compatibility breaks, and UI regressions:

1. **Input validation & no silent drops**:
   - Every invalid-input branch in `parsePayload`, `normalizeCanvas`, `applyPatch`, `executePlan` (`fromNodes`, cycles, invalid loops), and `importFromClipboard` returns an actionable error or explicit `warnings` (no silent `continue` / no-op).
   - `clipUpstreamOutput` preserves UTF-16 surrogate pairs (no lone surrogates) and updates structured JSON headers when folded.
   - `isTransientFailure` only matches verified error/run-failed stop reasons (never `max-tokens` / `refusal` / `aborted` or long prose).
2. **Platform, IME & compatibility**:
   - Global `keydown` guards `ev.isComposing || ev.keyCode === 229` before handling `Escape`/`Enter` or shortcuts.
   - Windows path safety (`safeSessionFileBase`), lock-safe atomic rename, and PowerShell 5.1 command hygiene.
   - Old `localStorage` docs, presets, `.workflow-canvas-state.json`, and legacy `.run.json` (without `summary`) load cleanly; `applyCanvasDoc` (`merge && fromRemote`) clears deleted optional fields.
3. **UI geometry & dead code**:
   - Both `lr` and `tb` layouts, both `zh` and `en` locales: no overlap of badges, Stop pill, socket labels, tall condition cards, or popovers; elevated `zIndex` while menus are open.
   - Zero unused `I18N` keys, `S.*` styles, or dead helpers/refs left behind by refactors.

---

## Subagent C — Host Contract & Cross-File Skeptic

Challenge every assumption about DSH Desktop (`app.asar`) and verify cross-file synchronization:

1. **DSH host contract audit**:
   - Verify every host/client API call against `AGENTS.md` Section 3 (`SubagentResult.diagnostic`, `stopReason` enum, `outputSchema` `structured_output` tool rewrite, `[data-dockkit-content]` `aria-hidden`/`inert`, `workspaceFiles.stat`/`read` `RemoteResult`, lazy `ctx.remote.*` resolution, single-file CJS `client.js` vs ESM `index.js` + `./lib/*.js`).
   - **Explicitly list any new assumption NOT yet verified in `AGENTS.md` Section 3**, and draft a concise, ready-to-paste verification prompt for the user's DSH agent.
2. **Cross-file synchronization**:
   - `index.js` + `lib/*.js` ↔ `client.js` (`I18N` `zh`/`en`, `helpBody`, `buildPlan`, `applyCanvasDoc`, presets)
   - `buildActiveCanvasContext`, tool schemas/descriptions/`render()`, `SKILL_DESCRIPTION`, `skills/workflow-canvas/SKILL.md`
   - `README.zh.md`, `README.md`, `docs/DETAIL.md`, `docs/MECHANISM.zh.md`, `docs/MECHANISM.md`, `locale/*.json`, `package.json` (`files`, `description`, `dsh.client.inject`).

---

## Final Verification Gate

After fixing all confirmed findings and adding regression tests, run in one verification batch:

1. `npm run check` (syntax across `index.js`, `lib/*.js`, `client.js`, JSON/locale/`I18N`/`S.*` parity, doc links, `inject` compatibility, tarball hygiene)
2. `npm test` (all unit tests pass)
3. **Isolated npm tarball smoke test** (`npm pack` → unpack to temp dir → `node --input-type=module` import `index.js` to prove `./lib/*.js` and `"files"` work standalone)
4. `git status --short` (confirm `.dsh/`, `promo/`, and other local scratch directories stay untracked)

Summarize the audit clearly:
- **Fixed**: concrete findings with clickable `file://` links
- **Verified Clean**: dimensions checked with no remaining defects
- **DSH Agent Verification Prompt** (if any unverified host assumptions remain)
