# Claudia Frontend Redesign — VS Code-style Workbench

Status: **rev 3, for user review** · Date: 2026-09-04 · Base: `origin/main` @ `815106f` (#231)
Re-verified 2026-09-08 against `origin/main` @ `d718fbc` (v0.4.0, 7 commits later). Drift found and folded in is listed in §15; all structural claims below still hold.
Scope: `frontend/` plus the backend slices in §6.6. Mobile layout out of scope (§6.5). **No feature flag** (user decision, §9 #18): each phase replaces the old UI directly; rollback = revert the PR.

Inputs: live-UI inspection, code reading on `main`, the usage audit of this machine (§10), three rev-1 adversarial reviews and two rev-2 reviews (closure + fresh-eyes), all folded in. Rejected findings are listed in §13. One design decision is still open (§14).

---

## 1. Goal

Rebuild the Claudia desktop UI around the VS Code *workbench* model — activity bar, side bars, tabbed editor area, bottom panel, status bar, command palette — so that:

- the **terminal is the hero**: most of the viewport by default instead of ~25 %;
- every task, shell, file and settings page is a **tab** in one editor area; switching context does not destroy terminal state;
- chrome is **quiet**: one icon rail, flat rows, one status bar; anything used less than a few times a day lives in the palette, a context menu or Settings; dead features are gated off;
- the layout is **keyboard-driven**, with browser-safe and Electron profiles;
- **nothing used daily is lost** — §3 is the retention contract, checked against the audit (§10) and a component-by-component inventory;
- the redesign **adds** what fleet-style work is missing: a needs-input queue, fleet status on orchestrator tasks, stalled detection, bulk hygiene, prompt templates (§11).

Non-goals: mobile redesign (#125/#186), a code editor (CodeMirror later), orchestration features beyond §11, full multi-client viewing (#222 — §6.7 is its first slice).

## 2. What exists today (measured on `main`; `it()` counted with `grep -cE '^\s*(it|test)\('`)

| File | Lines | Tests |
|---|---|---|
| `components/WorkspacePanel.tsx` (+ `.css` 2 622) | 2 998 | 50 |
| `components/SettingsMenu.tsx` (+ `.css` 2 035) | 3 577 | 57 |
| `components/FileExplorer.tsx` (+ `.css` 1 487) | 2 244 | 28 |
| `App.tsx` | 883 | 45 |
| `components/TerminalView.tsx` | 846 | 41 |
| `components/TaskInputBar.tsx` | 482 | 28 |
| `stores/taskStore.ts` / `hooks/useWebSocket.ts` | 1 006 / 990 | 159 / 95 |
| `panelsAndModals` / `smallComponents` / `voiceComponents` / `voiceHooks` tests | — | 93 / 100 / 82 / 100 |
| All CSS (`styles/index.css` + `components/*.css`) | **14 511** | — |
| Frontend suite | 21 files | **969** cases |
| `coverage-baseline.json` frontend lines | 7.56 % committed; ≈74 % measured on `main` | see §8.1 |

### 2.1 Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ≻_ Claudia v0.4.0   [⚡3/18 ①] [📱 Mobile] [🎙 Voice Agent] [🎙 Voice] 🔔 ↺ 📊 ⚙ │  header 57px
├───────────────────────────────┬───────────────────────┬──────────────────────┤
│ WORKSPACES  🗄 [Sort▾][Auto▾]⚙ + ‹ │ prompt… ⧉ [Learn] IDLE │ neuralspeaker      › │
│ ┌ ⠿ ⌄ 🗀 extropolis-website ─┐ │                       │ Files Changes PR …   │
│ │ [Type or speak a task…] 🖼 ⑂ ➤ │ │   xterm (~270px wide) │ 12 folders • 28 files│
│ │  ○ Scoping company website 12d │ │                       │ › .claude            │
│ └────────────────────────────┘ │                       │ › docs               │
│ ┌ ⠿ ⌄ 🗀 neuralspeaker  #1405 21 ┐ │                       │ …                    │
│ │ [Type or speak a task…] 🖼 ⑂ ➤ │ │                       │                      │
│ │  ✓ Speech CLI bug sweep    9m  │ ├───────────────────────┤                      │
│ │  ✓ how-it-works guide      9m  │ │ 💬 [Type a message] 🖼 ⏰ ➤ │                      │
│ │  …                             │ │ Enter to send, Shift+… │                      │
│ └────────────────────────────┘ │ 738 in | 312k out | … │                      │
│ ┌ ⠿ ⌄ 🗀 terravue ───────────┐ │ › ⑂ Checkpoints 1   + │                      │
│   sidebar 640px (default)       │ main-panel            │ explorer 310px (opt) │
└───────────────────────────────┴───────────────────────┴──────────────────────┘
```

`App.tsx`: `header` → `main` = `[sidebar | resize | main-panel | FileExplorer (collapsed by default) | (resize | chat-panel)]`, a separate mobile JSX branch with the same 28 props, 10 modals at the root.

### 2.2 Always-visible controls today

| Region | Controls | Count |
|---|---|---|
| Header | activity counter, Mobile, Voice Agent, Voice, Mute, Restart Server, Token Usage, Settings, (Chat), (Exit Fullscreen) | 8–10 |
| Workspace panel header | archived toggle, sort `<select>`, columns `<select>`, manage, add, collapse | 6 |
| **Per workspace card** | drag grip, chevron, icon, name, branch chip (click = copy), PR badge, task count, worktree-count pill, auto-isolate pill, references count, ⋮ menu, **full composer** (textarea, attach, isolate, send), list resize grip | 13 × N |
| Per task row | state icon, `#N`, name, time-ago, hover rename / schedule / delete (+ archive on ✓, stop while busy), worktree, PR, landed/outstanding, clock, subtask pill | up to 12 |
| Terminal header | full prompt, copy, Learn, state pill, (Resume) | 4–5 |
| Below terminal | composer + hint line; token-stats bar; checkpoint accordion | 3 footers |
| Right panel (expanded) | workspace name, collapse, 5–6 labelled tabs, per-tab toolbar | 8+ |

### 2.3 Problems

1. **Terminal squeezed** — 640 px sidebar default; ≈270 px terminal at 1258 px.
2. **Redundant affordances** — two mic buttons; sort/columns/archived in the toolbar; Restart Server beside Settings; token usage in three places.
3. **Cards fight density** — bordered, resizable cards, nested scrollbars, N identical composers.
4. **Prompt-as-header** — 2 000-char orchestrator prompts above the terminal.
5. **Modals everywhere** — a file opened from the explorer hides the terminal.
6. **No keyboard model** — only `Escape`/`Enter` handlers.
7. **Single document** — one terminal mounted; every switch replays history; shell is special-cased.
8. **Right panel is a second app** — six unrelated views, overflowing text tabs.
9. **CSS has no system** — 28 custom properties, 14 511 lines, mixed radii, light theme with 7 overrides and hard-coded rgba state colours.
10. **Dead code** (no importers, verified) — `TaskSummaryPanel`, `ConversationHistory`, `TaskCreateModal`, `LearnFromConversationModal`, `VoiceSettings.tsx` (only `VoiceSettingsContent` is used), `useVoiceRecognition.ts`, the `collapsedWorktreeGroups` persist slice, `.workspace-section.active` CSS. Several still have tests on `main`.
11. **Side effects buried in components** — waiting-input beep, MCP batch-delete modal and the SystemPrompt/Scheduled/WorkspaceManager modal hosts live in `WorkspacePanel`; the Deepgram key modal in `GlobalVoiceToggle`; Jira polling and the inbox badge in `FileExplorer` (work only while that tab is mounted).

## 3. Retention contract

**Keep** = unchanged behaviour · **Move** = same behaviour, new home · **Gate** = code kept, shown only when its setting is on · **Drop** = removed (reason given).

### 3.1 Tasks & workspaces

| Capability | Today | Disposition |
|---|---|---|
| Create task: typed, image paste/drop, attach, voice transcript, isolate toggle (default = workspace auto-isolate), initial PTY size (#81) | per-card composer | **Keep** — one-line composer row per expanded workspace (§5.3) |
| Task tree: state icon, `#N`, name, time-ago, unread, needs-input, selected, last-selected-per-workspace | rows | **Keep** (§5.2) |
| Subtask hierarchy, worktree-child lifting, collapse pill (#231/#233) | rows | **Keep** verbatim; tests ported first |
| Badges: worktree ⑂, PR (CI/review/merged, hover refresh #81/#179), landed/outstanding (#233), clock | rows | **Keep**, ≤3 + `+n` |
| Row actions: archive (✓ idle), stop (busy), rename, schedule, delete, revert, resume, continue, interrupt | hover | **Keep two inline** (archive/stop) + `…`; rest in context menu and palette |
| Task drag-reorder (`order`) | drag | **Keep** |
| Workspace row: chevron, icon, name, branch chip (click = copy), PR badge, task count, worktree count, auto-isolate pill, references count | card header | **Keep** name/branch/PR/count; auto-isolate + references → menu with ✓; worktree count → menu |
| Workspace ⋮ menu — Open in Finder, Open Shell, Open External Terminal, Copy Path, Rename, Push to GitHub, System Prompt, References ▸ (checkbox list + Add Custom Folder…), Code Review, Analyze Sessions → Issues, Sort by ▸, New Worktree…, Manage Worktrees, Auto-isolate ✓, Go to Parent / Remove Worktree, Reset, Remove/Unlink, **Hide** (#161, new) | ⋮ | **Keep all** as a right-click / `…` menu (needs `ContextMenu` v2, §5.2) |
| Worktree create modal and manager | modals | **Keep unchanged** |
| Whole-header drag to reorder workspaces; external folder drop adds a workspace | drag | **Keep** (`useWorkspaceDnD.ts`) |
| Sort workspaces / tasks | toolbar selects | **Move** → view `…` menu |
| Columns mode | select | **Drop** (§9 #3) |
| Per-card list height + grip | grip | **Drop** → per-workspace row cap (§5.2) |
| Archived tasks: workspace name, continue / restore / delete-permanently | toolbar toggle | **Move** → always-present, collapsed `ARCHIVED (n)` group at the bottom (no menu item) |
| Workspace manager, project picker with recents, path input | modals | **Keep**; view-header `⊕` = add workspace |
| Waiting-input beep (respects mute) | in `WorkspacePanel` | **Move** → `SoundManager` (phase 0c) |
| MCP batch-delete confirm (`pendingDeleteRequests`) | in `WorkspacePanel` | **Move** → workbench root, stays modal |
| Jira write confirm | App | **Keep** modal |
| `autoFocusOnInput`, browser notifications, notification click → select | `useWebSocket` | **Keep**; semantics in §5.9 |

### 3.2 Terminal & task tab

| Capability | Today | Disposition |
|---|---|---|
| xterm/WebGL, resize buffer, ≤2-col guard, chunked history, query stripping, scroll-to-bottom, mobile ESC | `TerminalView` | **Keep** — internals untouched **except four named hunks**: (1) WS listener → dispatcher (0b, `:719`), (2) header removal (2a, `:773-795`, `handleResume :749`), (3) `task:select`-in-rAF → `task:watch` (3b, `:554`), (4) WebGL detach/attach on hide/show (3b, `:366-371`). Each PR lists its hunks (§8.4 #5) |
| Copy prompt, `/learn`, Resume, state | header | copy → breadcrumb `…`; Resume → breadcrumb action; state → tree/tab; `/learn` **Gate** (`useLearnings`) |
| Message bar: Enter/⇧Enter, queue while disconnected (#78/#155), attach, ⏰ prefill, voice hint, drafts per task | `TaskInputBar` | **Keep**; hint → placeholder "Enter to send · ⇧Enter newline · ⌘V pastes screenshots" |
| Token stats | footer | **Move** → status bar (model · tokens; cost when `tokenCostEnabled`) + Task Details |
| Checkpoints | accordion | **Move** → Task Details only (§9 #8) |
| Shell per workspace + "shell running" banner | special mount | **Move** → editor tab (`⌃\``); panel host in phase 4 |
| Reconnect remount, reload banner, offline overlay, error banner | App | reconnect → status item + sticky toast > 5 s; offline overlay stays blocking; errors → toast |

### 3.3 Right panel, header, modals

| Capability | Today | Disposition |
|---|---|---|
| Files: tree, open (view/edit/save/markdown/image/download), multi-select, context menu, diff for changes | tab + modal | **Move** → Explorer view (right) + file tab (3d); until 3d, clicks open today's `FileContentModal` |
| Changes / staged / log, PR (edit body, copy link, checks) | tabs | **Move** → Source Control view (right) |
| Issues, Inbox (badge) | tabs | **Gate** → GitHub view, off by default (§9 #9); store-level poller while enabled |
| Jira tab + `jira:focusTicket` | tab | **Gate** (auto when configured); deep link → `showView('jira')` + ticket |
| Supervisor chat | panel | **Gate** (`supervisorEnabled`) → right bar |
| Activity log + unread | header popover | **Move** → status-bar bell; until phase 4 the bell opens today's `ActivityPanel` popover anchored above the bar; from 4 also a panel tab |
| Busy/idle counts | header | **Move** → status bar |
| Mobile tunnel + QR | header | status item while active; gear menu |
| Voice toggle (target, hands-free, Deepgram modal), Voice Agent | header | **Gate** (`claudia.voice.enabled`) |
| Mute | header | bell right-click + palette `Toggle Sounds` |
| Restart server | header | palette + confirm |
| Usage dashboard | header modal | until 3d: modal from gear/palette; from 3d: editor tab |
| `SystemStats` | header, gated | status item, same gate |
| Settings (13 panels: api, appearance, backend, behavior, jira, learnings, mcp, notifications, permissions, plugins, rules, sound, supervisor) | modal | until 3c: modal from gear/palette; from 3c: Settings tab (§5.7) |
| Electron fullscreen exit / F11 | header | status item using existing `exitFullscreen` IPC (2a); `toggleFullscreen` added in 4 |
| App version `v0.4.0` (`App.tsx:512`, `__APP_VERSION__`) | header | **Move** → welcome page (§6.8) + gear menu; the header that carries it is deleted in 2a |
| Electron auto-update: check, download, opt-out, rollback (#241) | Settings → Updates | **Keep** in Settings (14th panel, §5.7). An update-ready state has **no** ambient indicator today; 2a adds a status-bar item (right, next to the bell) so a downloaded update is discoverable once the modal stops being the only surface |
| Mobile two-screen flow | separate branch | **Keep** on `WorkspacePanel`/`TerminalView`, frozen (§6.5) |

## 4. Target layout

```
┌──┬──────────────────────────┬─────────────────────────────────────────────┬───────────────────┐
│⧉ │ TASKS         ⊕ 🔍 …    │ ⧉ #48 Speech CLI…  │ ⌨ neuralspeaker │ 📄 CLAUDE.md│ SOURCE CONTROL    │
│⑂ │ ▾ NEEDS INPUT (2)        │─────────────────────────────────────────────│ ▾ Changes (3)     │
│📁│   ! #51 Phoneme matcher  │ neuralspeaker › #48 Speech CLI bug sweep  ⏹ ▶ … │   M speech_cli/…  │
│  │   ! #53 Bulletproof audit│                                             │ ▾ Pull Request    │
│  │ ▾ neuralspeaker ⑂ feat/… │                                             │   #1405 ✓ checks  │
│  │   ＋ New task…            │                                             │ › Log             │
│  │   ● #48 Speech CLI sweep │              xterm (all remaining width)    │                   │
│  │   ✓ #47 how-it-works     │                                             │ TASK DETAILS      │
│  │     └ ◐ #46 …    2/6     │                                             │ #48 · fable-5     │
│  │   … 12 more              │                                             │ 738 in · 312k out │
│  │ › terravue           8   │                                             │ ⑂ feat/issue-1404 │
│  │ › extropolis-website  1  │─────────────────────────────────────────────│ Checkpoints (1)   │
│  │ › ARCHIVED (12)          │ [Enter to send · ⇧Enter newline · ⌘V image] 🖼 ⏰ ➤ │ Schedules (0)     │
│⚙ │                          │                                             │                   │
├──┴──────────────────────────┴─────────────────────────────────────────────┴───────────────────┤
│ ⟳ connected  ⚡ 3 busy · 2 quiet · 18 idle · 2.1 GB   ⑂ feat/issue-1404     fable-5 · 312k  ⛨ 🎭  🔔 2 │ 22px
└───────────────────────────────────────────────────────────────────────────────────────────────┘
 48px   primary side bar 300px (⌘B)        editor area           secondary side bar 320px (⌥⌘B)
        (secondary bar drawn open for illustration; hidden by default)
```

**Spatial model = today's**: tasks left, files/PR/details right, terminal in the middle.

| Region | Default | Toggle | Contents |
|---|---|---|---|
| Activity bar | 48 px | palette | top group (left bar): **Tasks** (badge = needs-input count); bottom group (right bar): **Source Control**, **Explorer**, optional GitHub / Jira (auto when configured); gear at the bottom. Two `role="tablist"` groups, one per side. No voice icon unless enabled |
| Primary side bar | 300 px, visible | `⌘B` | Tasks view |
| Editor area | fills | — | tab strip + breadcrumb + one editor; split groups in phase 6 |
| Secondary side bar | 320 px, hidden | `⌥⌘B`, or activating a right-group icon | chosen view + pinned **Task Details** section (collapsible) |
| Panel | hidden | `⌘J` | Shell · Activity (phase 4) |
| Status bar | 22 px | palette | §5.6 |
| Title bar | none in browser; Electron native frame | — | — |

## 5. Component design

### 5.1 Workbench shell — `frontend/src/workbench/`

```
Workbench.tsx      grid + 3 resize handles (left 200–600, right 240–700, panel 120px–60%), double-click resets; drag emits no task:resize until mouse-up
ActivityBar.tsx    two tablists; badges from store selectors
SideBar.tsx        view container (title, actions, "…"), used for both sides
EditorArea.tsx     tab strip + breadcrumb + host; policy in editorCache.ts (pure)
editorCache.ts     open/close/activate/pin/preview/MRU/evict — 100 % unit-testable
EditorTabs.tsx     role="tablist"; middle-click close; context menu; drag reorder (phase 6)
Breadcrumb.tsx     workspace ▸ (dropdown of workspaces) · task ▸ (siblings) · actions slot
Panel.tsx          phase 4
StatusBar.tsx      registry { id, side, priority, when, render, onClick, tooltip }
CommandPalette.tsx ⌘⇧P · QuickOpen.tsx ⌘P (tasks by #N/name/workspace incl. archived; ">" = commands; files in phase 6)
ContextMenu.tsx    v2 (§5.2)
Tooltip.tsx        title + key hint from the command registry
Toasts.tsx         bottom-right; max 3 visible; 8 s auto-dismiss; sticky; dedupe by key; hover pauses; "Open" action; aria-live=polite
Dialog.tsx         role="dialog", hand-rolled focus trap (first/last cycling), inert background, Esc cancels, focus returns to the invoker (xterm if it had focus)
commands.ts        registry { id, title, category, keybinding?, when?, skipShell?, run }
keybindings.ts     two profiles (§5.10); capture-phase dispatcher on window; matches on event.code; preventDefault + stopPropagation
layoutStore.ts     §6.1 · focus.ts  activeEditor / modalOpen / focus ∈ {tree, composer, terminal, editor, palette, menu, other}
useTaskActions.ts  (0b) hook wrapping the useWebSocket senders so views read stores + call actions instead of taking 28 props
```

`App.tsx` becomes: providers, `useWebSocket`, `useTheme`, global managers (`SoundManager`, voice managers), overlays (offline, agent modals), then `isMobile ? <MobileApp/> : <Workbench/>`.

### 5.2 Tasks view (`views/tasks/`)

```
TASKS                                   ⊕  🔍  …           ← ⊕ add workspace · filter · view menu
▾ NEEDS INPUT (2)                                          ← pinned group (1c), only when non-empty
    ! #51  Phoneme phrase matcher     neuralspeaker  2m
▾ 🗀 neuralspeaker   ⑂ feat/issue-1404  #1405✓  21          ← workspace row; hover: ⊕ (expand + focus composer) …
    ＋ New task in neuralspeaker…                           ← composer row (§5.3), role="none", outside the treeitems
    ● #48  Speech CLI bug sweep & hardening   ⑂ 🕒   9m    ← task row; hover: ✓archive|⏹stop, …
    ✓ #47  how-it-works guide: done                   9m
      └ ◐ #46  Phoneme phrase matcher   2/6  ⑂ PR✓  2m     ← orchestrator (fleet count in phase 5)
    … 12 more                                              ← cap on top-level rows; busy/waiting always shown
› 🗀 terravue                                     8
› ARCHIVED (12)                                            ← always present, collapsed
```

- Rows: `role="treeitem"`, `aria-expanded/selected`; density `comfortable` 26 px (default) / `compact` 22 px; 13 px font. Needs-input = `!` glyph **and** amber border; unread = bold + dot; selected = `list.activeSelection`; last-selected-per-workspace = subtle outline, and clicking a *workspace row* activates that task (today's `lastSelectedTaskByWorkspace` behaviour, `WorkspacePanel.tsx:2706`).
- Badges: ≤3 icons with tooltips, then `+n`.
- Inline hover actions: archive (idle/exited), stop (busy), `…`. Context menu: Open, Open to the Side (phase 6), Rename `F2`, Schedule…, Create Checkpoint, Interrupt, Continue/Resume, Revert…, Archive, Delete.
- Multi-select: `⇧`/`⌘`-click, `Space` toggles, `⌘A` (tree focused); context-menu actions apply to the selection; selection toolbar in the view header (Archive · Delete · Stop · Continue).
- **Tree keyboard model (1b)**: `↑↓` move (groups, workspaces, composer row skipped, tasks, subtasks, "… more", ARCHIVED), `←→` collapse/expand, `Enter` open, `⇧↑↓` range, `Home/End`. `focus.ts` reports `composer` while typing in the composer row so tree keys never fire there.
- Workspace row context menu = full list in §3.1 with ✓ states.
- **`ContextMenu` v2 (1b)**: `MenuItem = { id, label, icon?, keybinding?, checked?, disabled?, danger?, submenu?, separator? }`, `role="menu"`, arrow/Enter/Esc navigation, anchor-to-element or x/y, focus returns to the invoker. Replaces today's flat button list (`ContextMenu.tsx:4-11`) and the bespoke ⋮ dropdown.
- Filter (`🔍` / `⌘F` in view): `#N`, name, workspace, state words.
- Cap: `rowsPerWorkspace` (default 10) counts top-level rows; busy/waiting/needs-input rows are always shown; "… N more" expansion remembered for the session.
- View `…` menu: Sort workspaces ▸, Sort tasks ▸, Collapse all, Hidden workspaces ▸, Manage workspaces…, Density ▸.
- Files: `TasksView.tsx`, `NeedsInputGroup.tsx`, `WorkspaceRow.tsx` (owns DnD handlers so they are covered by ported tests), `TaskRow.tsx`, `SubtaskList.tsx`, `ArchivedGroup.tsx`, `TaskComposerRow.tsx`, `useWorkspaceDnD.ts` (folder drop + reorder helpers), `useTaskSorting.ts`, `useTaskSelection.ts`, `useTreeKeyboard.ts`. Views read stores and call `useTaskActions()`; the mobile branch keeps `WorkspacePanel`'s props.

### 5.3 Composer

- Shared `Composer` (0c): `props { mode: 'create'|'reply'; workspaceId; taskId?; inputId; draftKey; onSubmit({ text, images, isolate, cols, rows }) }`. Extracted from today's per-card composer (`inputValue`, `images`, drag/paste upload, `isolate` ← `workspace.autoWorktree`, `focusedInputId` voice routing, `lastKnownTerminalSize`). `TaskInputBar` = `Composer mode="reply"`.
- **Drafts**: create-mode drafts live in `taskStore.workspaceDraftInputs` (per workspace, persisted like `taskDraftInputs`); pending images live in the store too, so collapsing or switching never drops them.
- **Default `claudia.tasks.composer = "always"`** (§9 #1): one 26 px line per expanded workspace; grows on focus (textarea, 🖼, ⑂, ➤); collapses **only** on `Esc` or send — clicking elsewhere keeps it expanded; expanding another workspace's composer collapses this one but keeps its draft. `on-demand` shows it only via `⊕`/`⌥N`.
- Keys: `Enter` send, `⇧Enter` newline, `⌘Enter` send-and-keep-open, `Esc` collapse (create) / focus terminal (reply).
- `⌥N`/`⌘N`: tree row focused → that workspace's composer; else Quick Open workspace picker.
- Initial PTY size: `lastKnownTerminalSize` (today) through phase 2; `EditorArea.measureTerminalSize()` (hidden probe fit; jsdom tests stub `FitAddon.proposeDimensions` as `TerminalView.test` already does) from 3b.
- Welcome page hosts `Composer mode="create"` with a workspace picker.

### 5.4 Editor area & tabs

```ts
type EditorTab =
  | { id: `task:${string}`;  kind: 'task';     taskId: string;  pinned: true }
  | { id: `shell:${string}`; kind: 'shell';    workspaceId: string }
  | { id: `file:${string}`;  kind: 'file';     workspaceId: string; path: string; mode: 'view'|'diff'; staged?: boolean; preview: boolean }
  | { id: 'settings'; kind: 'settings'; section?: string }
  | { id: 'usage'; kind: 'usage' } | { id: 'welcome'; kind: 'welcome'; page?: 'moved' };
// runtime-only (not persisted): dirty: Set<id>, stale: Set<id>, mounted: Set<id>
// editorCache.ts (pure): open(s, tab, {preview?, activate?}) · close(s, id) · activate(s, id) · touchMru(s, id)
//                        · evict(s, cap, { protect: dirtyIds ∪ attachmentIds }) → evictedIds   (prefers idle/exited over busy/waiting)
```

- **Preview tabs: files only** (§9 #4). Task tabs always pin.
- Task tab: `#48 Speech CLI…` + state dot (+ *stale* decoration after reconnect, §5.9); tooltip = full prompt; context menu: Close, Close Others, Close All, Copy Prompt, Rename, Archive.
- **Breadcrumb**: `neuralspeaker ▸ #48 Speech CLI bug sweep` (both dropdowns); right: **Interrupt ⏹** (sends `\x1b`), **Continue ▶**, **Resume** (state-gated), `…` (Copy prompt, Learn [gated], Rename, Schedule…, Checkpoint…, Archive). No state text.
- Task tab body = `TerminalView` + `Composer mode="reply"`. Nothing else below.
- **Activation** sends `task:watch { taskIds:[id], primaryTaskId:id }` (dimension-owner switch) + `task:refreshPr` (existing message; no new `task:focus`), sets `taskStore.selectedTaskId`, clears unread.
- Shell tab = `ShellTerminalView` without header; `⌃\`` toggles.
- File tab = today's `FileContentModal` body: view/edit/save (`⌘S`), markdown, image, download, diff; dirty guard dialog on close/eviction; no eviction while dirty.
- Keys: go-to-tab / prev / next / close / reopen per §5.10.
- Startup restores the tab list, mounts only the active editor; **prunes on the WS `init` frame** (tasks are not persisted client-side) and lazily marks missing files with a "file missing" editor state.
- `beforeunload` guard when any composer has a draft or a task tab is busy (browser `⌘W` habit).

### 5.5 Side-bar views

| View | Bar | Source | Notes |
|---|---|---|---|
| Tasks | left | `WorkspacePanel` | §5.2 |
| Source Control | right | Changes + PR tabs | Changes (default-expanded) / Staged / Pull Request / Log; file click → file tab (`diff`) |
| Explorer | right | Files tab | tree, refresh, collapse-all, multi-select, context menu; single-click preview, double-click pin |
| GitHub | right, optional | Issues + Inbox | store-level 60 s poller only while enabled |
| Jira | right, auto | Jira tab | deep link opens the view |
| Supervisor Chat | right, gated | `SupervisorChat` | when `supervisorEnabled` |

**Task Details** (right bar, pinned bottom): `detailsTaskId = activeEditor.kind==='task' ? activeEditor.taskId : taskStore.selectedTaskId`; sections (each collapsible, state in `layoutStore.details.collapsed`): Identity (`#N`, prompt collapsible, state, model, branch/worktree/PR + landed/outstanding), Tokens (`TaskTokenStats taskId`; cost when enabled), Checkpoints (`CheckpointTimeline taskId`), Schedules (`scheduledTasks` filtered by task), Workspace prompt (`SystemPromptModal` body read-only + Edit…; it is per-workspace). Empty state when no task.

**`currentWorkspaceId`** (drives Explorer/SCM/GitHub/Jira/branch item): persisted; on startup validated against `workspaces` else first; set by task-tab activation (the task's workspace — for worktree tasks that is the worktree workspace, intentionally), by clicking a workspace row, by the breadcrumb workspace dropdown, by the welcome picker; falls back to first when removed.

Views are lazily mounted and kept mounted when hidden.

### 5.6 Status bar

Left: connection (`⟳ connected` / `reconnecting…` warning colour / `restarting…` / `offline`), fleet `⚡ 3 busy · 2 quiet · 18 idle · 2.1 GB` (click → Activity; menu: Stop all busy…), branch of `currentWorkspaceId` (click → SCM), `SystemStats` when enabled. Right: active task `fable-5 · 312k` (+ `$4.12` when enabled; click → Task Details), `⛨ skip-perms` / `🎭 playwright` toggles (§11.9), mic (voice enabled only; target label + hands-free; right-click → voice settings / Deepgram key), tunnel (active/loading), fullscreen (Electron), **bell** right-most (unread; click → Activity popover until 4, panel from 4; right-click → Toggle Sounds, Thinking sound, Browser notifications).

### 5.7 Settings tab (3c)

Search; section list; anchored form. **Existing 14 panels** ported one file each (`editors/settings/sections/`) with the 49 config round-trip tests — the 14th is **Updates** (#241: Electron auto-update, opt-out, version rollback; ~660 lines + 324 CSS; loads prefs/status lazily the first time it is expanded, and that laziness must survive the port); **5 new sections**: Views (optional views), Keyboard (profile display; editor in phase 6), Terminal (max mounted, WebGL), Privacy (UI-event log on/off + clear), Advanced (Restart Server + confirm, data dir). Appearance gains density, composer mode, rows per workspace, preview tabs; Behaviour gains stalled threshold, auto-isolate default.

Carried from the modal: refetch on activation; **`flushPendingSaves()` on deactivate / close / eviction / `beforeunload`** (today only Done flushes rules, supervisor prompt, `.mcp.json`); dirty dot; `{section}` deep link (fixes the dead `'aicore'` target); the notification copy "only when tab in background" corrected to "when the task is not selected" (`useWebSocket.ts` gate).

**Storage split**: per-machine UI prefs → `layoutStore` (density, widths, `maxMounted`, `rowsPerWorkspace`, composer mode, optional views, preview tabs); cross-client behaviour → backend `ConfigStore` (`voice.enabled`, `stalledThresholdSec`, `uiEventLog`) — fields added in §6.6.

### 5.8 Notifications & dialogs

Modal (`Dialog.tsx`): MCP batch delete, Jira write confirm, unsaved-file guard, Restart Server confirm. Toasts: errors, "Task #51 needs input · Open" (when not the active editor), agent-created schedule (§11.8), reconnecting > 5 s (sticky), partial workspace reset. Offline overlay stays blocking.

### 5.9 Focus, auto-select, reconnect

`task.open(taskId, { focus?: 'terminal'|'composer'|'none' })` replaces the six `selectTask` call sites (`App.tsx:310`; `useWebSocket.ts:273, 424, 497, 566, 729`).

- Unread clears on tab activation.
- `autoFocusOnInput`: activates the task tab unless the active editor is a dirty file/Settings tab or a modal is open (then toast only); **at most once per 10 s** and never within 2 s of user typing — further waiting tasks go to NEEDS INPUT + toast.
- Focus target: **terminal** for `waitingInputType ∈ {permission, question, confirmation}`; **composer** for `text_input` / not waiting.
- `Esc` precedence: modal → context menu → palette → composer (create: collapse if empty else keep; reply: focus terminal) → xterm passthrough. An `Esc` arriving within 500 ms of a composer→terminal hand-off is swallowed (avoids the accidental Claude interrupt).
- Per-editor side effects (`window.focus` refocus, voice target, `terminal:scrollToBottom`, `taskInput:focus`) run only for the active editor, wired through `focus.ts`.
- **Reconnect / server restart**: on `init` the client re-watches **only the primary**; other mounted tabs are marked *stale* (tab decoration), unwatched, and re-watched + restored on activation. Only the active editor restores. `terminalRefreshCounter` is deleted in 0b.

### 5.10 Commands & keybindings

Profiles: `electron` (`window.electronAPI`) or `browser`. Dispatcher: `window` capture phase, matches `event.code` (so `⌥N`/`⌥W` work on macOS despite dead keys), `preventDefault()` + `stopPropagation()`. **No binding fires while `focus === 'terminal'` unless the command is marked `skipShell`** (VS Code `commandsToSkipShell` model) — this keeps Claude Code's TUI keys (`Ctrl+B/C/D/E/G/J/K/L/O/R/T/U/V/_`, `⌃2…8` control codes, `Esc`) intact on Windows/Linux. Browser-reserved and unpreventable: `⌘W/N/T/⇧T/⇧N`, `⌃Tab`, `⌘⌥←/→` (Chrome/Edge mac "next/prev tab"), `⌘1…9` (treated as reserved conservatively). Electron menu takes `⌘R`, `⌘+/-`, `⌘A` (Edit role) — not used. `⌃1…9` on mac can collide with Mission Control when the user enabled it; `Alt+1…9` is offered on mac too. Linux uses the win column.

| Command | when | Electron | Browser (mac / win) | skipShell |
|---|---|---|---|---|
| Command palette / Quick open | — | `⌘⇧P` / `⌘P` | same | ✓ |
| New task | — | `⌘N` | `⌥N` / `Alt+N` | ✓ |
| Toggle left / right bar / panel | — | `⌘B` / `⌥⌘B` / `⌘J` | same | ✓ (mac) · win: `Ctrl+B/J` **not** skipShell |
| Focus Tasks / SCM / Explorer | — | `⌘⇧K` / `⌘⇧G` / `⌘⇧E` | same | ✓ |
| Go to tab *n* | — | `⌘1…9` | `⌃1…9` or `Alt+1…9` / `Alt+1…9` | ✓ |
| Prev / next tab | — | `⌘⌥←` / `⌘⌥→` | `⌃PgUp` / `⌃PgDn` (VS Code Web) | ✓ |
| Close tab / reopen | — | `⌘W` / `⌘⇧T` | `⌥W` or `⌘K W` / `⌘K ⇧T` | ✓ |
| Next task needing input | — | `⌘⇧Y` | same | ✓ |
| Tree: move / expand / open / rename / select / range / all | focus=tree | `↑↓ ←→ Enter F2 Space ⇧↑↓ ⌘A` | same | — |
| Focus composer | focus=terminal | `⌘Enter` | same | ✓ |
| Send & keep open | focus=composer | `⌘Enter` | same | — |
| Back to terminal / collapse | focus=composer | `Esc` | same | — |
| Toggle workspace shell | — | `` ⌃` `` | same | ✓ |
| Prompt templates | focus=composer | `⌘/` | same | — |
| Settings / Keyboard shortcuts | — | `⌘,` / `⌘K ⌘S` | `⌘K ⌘,` / same | ✓ |
| Save file tab | editor=file | `⌘S` | same | — |
| Filter tasks | focus=tree | `⌘F` | same | — |

`keybindings.test.ts` asserts every binding against per-host reserved fixtures (browser mac/win, Electron menu roles), the Claude Code TUI key list, and xterm's own claimed keys; a dispatched chord must not reach xterm's `onKey`/`onData`. The fixture is hand-maintained (headless Chromium has no browser chrome, so e2e cannot prove reservedness). Tooltips and palette rows show the active profile's keys.

## 6. Technical design

### 6.1 `layoutStore` (zustand, `claudia-layout-v1`)

```ts
interface LayoutState {
  activeRightView: 'scm'|'explorer'|'github'|'jira'|'chat'|null;
  sideBar:   { visible: boolean; width: number };
  secondary: { visible: boolean; width: number };
  panel:     { visible: boolean; height: number; activeTab: 'shell'|'activity'; maximized: boolean };
  details:   { collapsed: Record<string, boolean> };
  editors: EditorTab[]; activeEditorId: string|null; mru: string[];
  currentWorkspaceId: string|null;
  prefs: { density; composer; rowsPerWorkspace; maxMounted; previewFiles; optionalViews: string[] };
  firstRunToastShownAt: string|null; welcomeSeenVersion: number;
  selection: { taskIds: string[] };   // not persisted
}
```

Migration (0b): seeds from `claudia-sidebar-width`, `claudia-sidebar-collapsed`, `claudia-chat-panel-width`, `claudia-file-explorer-width`, then deletes them (2a, when the legacy layout goes). `taskStore` keeps its persist keys; `taskListHeight`, `workspaceColumns`, `collapsedWorktreeGroups` become no-ops until phase 6 removes them. `selectedTaskId` stays the backend-facing active task; only `task.open` and tab activation set it. Log at info: `[Layout] migrated from legacy keys`, `[Layout] hydrated editors=N pruned=M`.

### 6.2 Terminals across tabs — backend constraint (verified on `d718fbc`)

Output is emitted only while `task.isActive` (`task-spawner.ts:3829`; the adapter gates at `backends/opencode-backend.ts:241/265/277/574`). `isActive` is flipped by **four** sites: `setTaskActive` (`:4225`, marks every other task inactive at `:4249`, frees history after 30 s) via `task:select` (`server.ts:1930`) and `task:reconnect` (`:2257`); the pending-input reconnect path (`task-spawner.ts:5572`, reached from `reconnectTask :5221`); and both adapters' own `setTaskActive` (`backends/types.ts:159`, `backends/opencode-backend.ts:361-376`, `backends/claude-code-backend.ts`). `task:restore` and `task:output` are **broadcast** to every client (`server.ts:1559` and `:1478`/`:1554`). There is no per-client routing and no resize ownership (`resizeTask :4717`).

- **Phase 2a** (single tab): unchanged.
- **Phase 3a** (backend): watched-task set, §6.7.
- **Phase 3b**: ≤ `maxMounted` (default 3) terminals mounted; eviction prefers idle/exited, protects dirty files and reply composers with pending attachments; WebGL addon disposed on hide / re-attached on show (`TerminalView.tsx:366-371` today disposes permanently on context loss); mounted + watched tab activation sends no `task:restore`, no `term.reset()`; `useHiddenSafeFit()` for both terminal kinds (`ShellTerminalView.tsx:172/183/191` fit without the `clientWidth` guard `TerminalView.tsx:159` has) — fit after display toggle in `requestAnimationFrame`, discard ≤ 2 cols/rows, mount only when first visible.
- **WS dispatcher (0b)**: `useWebSocket` parses once; `subscribeTaskOutput(taskId, cb)` / `subscribeShellOutput`; survives reconnects; still writes through the injected `wsRef` so `TerminalView.test` frame assertions stay valid.
- Budgets: mounted-tab switch < 100 ms; ≤ +30 MB per mounted terminal; server logs `[TaskSpawner] watched=N residentMB=M`; client logs `[Workbench] mounted=N webgl=M`.

### 6.3 Command registry
`registerCommand({ id, title, category, keybinding?, when?, skipShell?, run })`; `when` gets `{ activeEditor, selectedTask, currentWorkspaceId, focus, modalOpen, host }`. Pure, DOM-free tests.

### 6.4 Design tokens — `styles/tokens.css`
VS Code-shaped semantic set: `--wb-activityBar-*`, `--wb-sideBar-*`, `--wb-list-*`, `--wb-editor-*`, `--wb-tab-*`, `--wb-panel-*`, `--wb-statusBar-*` (+ `-warning-bg`), `--wb-input-*`, `--wb-badge-*`, `--wb-button-*`, `--wb-widget-shadow`, text roles, **state tokens** `--wb-state-busy/-waiting/-idle/-exited/-unread/-lastSelected`, `--wb-font-ui` 13 px, `--wb-row-h` (26/22), `--wb-radius` 4 px, spacing 4–32. Old variables aliased until phase 6. Global `:focus-visible`; `prefers-reduced-motion`.

### 6.5 Mobile
`isMobile` keeps the two-screen flow on `WorkspacePanel` + `TerminalView`; those files stay, desktop-only CSS removed in 1c and the rest scoped under `.is-mobile`; App.test mobile cases + a 390×844 screenshot per phase. Mobile moves to `TasksView` in a separate later effort.

### 6.6 Backend touch points

| Slice | Phase | Change | Tests |
|---|---|---|---|
| Watched-task set | 3a | §6.7 | ws-integration, spawner lifecycle, adapters, `test-cli --watch` |
| Config fields | 0b | `ConfigStore`: `voice.enabled` (default false), `stalledThresholdSec` (120), `uiEventLog` (true) | config-store test |
| `?backendUrl=` | 0d | `api-config.ts` honours a `backendUrl` query param (e2e only) | unit |
| Coverage gate | 0a | `coverage.mjs`: per-package ratchet (§8.1) | script test |
| Electron | 4 | `toggleFullscreen` IPC + `electron.d.ts` | manual |
| UI-event log | 5 | `POST /api/ui-events` → `<dataDir>/ui-events.jsonl`, 5 MB cap, no prompt text | route + privacy guard |
| `lastOutputAt` | 5 | on `task:stateChanged` payload | spawner test |
| Fleet load | 5 | `/api/system/stats` + agent count/RSS (#180 data) | route test |
| Prompt templates | 5 | `GET/PUT /api/prompt-templates` | route test |
| Create-from-issue | 5 | existing issue endpoint | — |

### 6.7 Protocol — watched-task set (3a)

```ts
// client → server (ids accept #N / short / full via the existing resolver)
{ type: 'task:watch',   payload: { taskIds: string[]; primaryTaskId?: string; replace?: boolean } }
{ type: 'task:unwatch', payload: { taskIds: string[] } }
// server → requesting connection only (never broadcast)
{ type: 'task:watched', payload: { taskIds: string[]; primaryTaskId: string|null } }   // ack
{ type: 'task:restore', payload: { taskId, history } }                                  // per newly watched id
// unchanged, but routed to watchers only: task:output
```

Invariants:
- `watchers: Map<taskId, Set<WebSocket>>` + per-connection `{ watched: Set<taskId>, primary: taskId|null }`; `task.isActive` **derived** = `watchers.get(id)?.size > 0`, recomputed on watch/unwatch/close (`ws.on('close')`, `server.ts:3365`, today only `clients.delete`).
- `replace: true` swaps the connection's whole set (used by `task:select` compat: `task:select {id}` ≡ `watch { taskIds:[id], primaryTaskId:id, replace:true }` — mobile and any old client keep working).
- `task:reconnect` adds the id to the requester's set; the pending-input path (`task-spawner.ts:5572`) sets `isActive` only through the watcher map.
- Watching a **disconnected** task = one-shot restore from disk (today's `setTaskActive` early-return path), no membership.
- The 30 s history sweep skips watched tasks; resident history = Σ watched × ≤ 2 MB, logged.
- **Resize ownership enforced server-side**: `task:resize` accepted only from the connection whose `primary` is that task; others logged once `[Server] resize ignored: not primary`; when the owner disconnects, the next resize from any watcher takes ownership.
- Adapters: `CodeBackend.setTaskActive(id, active)` → `setWatched(ids: Set<string>)` in `backends/types.ts:159` and both adapters (their single-active sweeps removed).
- `task:created` no longer implies select (`useWebSocket.ts:273`): the initial prompt is sent on ready detection regardless of `isActive` (`:3708-3722`); `task.open` watches + sets primary; MCP-created tasks stay unopened.
- Caps: client `maxMounted` (3) + shell; server hard cap 8 per connection → error `WATCH_LIMIT`.

Tests: two clients watch different tasks and receive only their own output; per-connection restore (the other client does **not** `term.reset()`); non-primary resize ignored; owner hand-off; legacy `task:select` unchanged; close clears the set; two watched **opencode** tasks both stream; `test-cli --watch a,b`.

### 6.8 Remaining definitions
- **Welcome page** (`editors.length === 0`): name/version, `Composer mode="create"` + workspace picker (default `currentWorkspaceId`), NEEDS INPUT list, 5 recent tasks, five key hints, link to `welcome {page:'moved'}` (hand-maintained `movedWhere.ts` table derived from §3). `Help: Welcome` reopens it.
- **First-run toast**: once, when `welcomeSeenVersion < 1`; not while a modal is open; sets `firstRunToastShownAt`.
- **`SoundManager` (0c)**: waiting beep (`WorkspacePanel.tsx:37-58`), completion sound (`useWebSocket.ts`), thinking sound — all through `isSoundEnabled()`.
- **Fuzzy scorer**: subsequence with word-start bonus, `#N` exact, workspace prefix; ≤ 60 lines; unit-tested. Quick Open indexes live + archived tasks (archived ranked last).

## 7. Phasing — ~25 PRs, ≤ ~2 000 net lines each, each leaves a complete UI

No flag: 1a–1c ship into the live sidebar; 2a is the single PR that swaps the shell and must keep every daily action reachable (existing Settings/Usage/FileContent modals and the Activity popover stay until 3c/3d/4 replace them). Calendar with review + user validation: **5–7 weeks**.

| # | PRs | Deliverable | Depends on | Parallel |
|---|---|---|---|---|
| **0a** | 1 | Commit this spec; delete dead components + their tests (§2.3.10); **then** `coverage:baseline`; `coverage.mjs` per-package ratchet (§8.1) | — | — |
| **0b** | 1 | `tokens.css` + aliases; `layoutStore` + migration tests; `commands.ts`, `keybindings.ts` (profiles, skipShell, fixtures), `CommandPalette`, `QuickOpen`; `StatusBar` skeleton under the current layout; WS dispatcher (`TerminalView` hunk 1, tests green); `useTaskActions()`; `ConfigStore` fields | 0a | ∥ 0c, 0d |
| **0c** | 1 | `SoundManager`, batch-delete modal + modal hosts to app level, store-level Jira/inbox pollers; shared `Composer` + tests; `Dialog.tsx` focus trap | 0a | ∥ 0b |
| **0d** | 1 | e2e harness: backend on an ephemeral port with `CLAUDIA_DATA_DIR` under `homedir()`, `fake-claude.sh`/`fake-gh.sh` on PATH, `vite preview` + `?backendUrl=`, `playwright.config.ts`, `npx playwright install --with-deps chromium` in CI, smoke + screenshot spec (3 viewports × 2 themes), `workflow_dispatch` + `schedule:` nightly. Never touches 4001/5173 | — | ∥ 0b |
| **1a** | 1 | Tasks-view decomposition in the old sidebar at 640 px: tree/rows/worktree groups/subtasks, 50 tests ported per component, flat rows only | 0b, 0c | — |
| **1b** | 1 | Composer row + drafts, hover actions, `ContextMenu` v2, workspace/task context menus, view menu, density, tree keyboard model | 1a | — |
| **1c** | 1 | NEEDS INPUT group, archived group, hide workspace (#161), filter, multi-select + selection toolbar, row cap; desktop card CSS deleted (mobile scoped) | 1b | — |
| **2a** | 1 | Workbench shell: grid, activity bar, left bar hosting `TasksView`, `EditorArea` single task tab + breadcrumb (Interrupt/Continue/Resume), header removed → status bar / gear / palette (modals retained), `⌘⇧Y`, toasts, welcome + moved-where page, first-run toast, tooltips, `beforeunload` guard, `exitFullscreen` status item. **Owns** `Workbench.tsx`, `SideBar.tsx`, `layoutStore.secondary` | 1c | — |
| **2b** | 1 | Explorer / Source Control / GitHub / Jira views (own dirs) + Task Details; right bar wiring. Adds files under `views/*` + one registry line | 2a | ∥ 3a, 3c |
| **3a** | 1 | Backend watched-task set (§6.7) | — | ∥ 2 |
| **3b** | 1 | Multi-tab, MRU, mounted cache, WebGL detach, shell tab, hidden-safe fit, stale-after-reconnect, `task:watch` on activation (hunks 3–4). **Owns** the editor registry | 2a, 3a | ∥ 3c |
| **3c** | 1–2 | Settings tab (13 + 5 sections, 57 tests ported, flush-on-deactivate, copy fix). Adds `editors/settings/*` + one registry line | 2a | ∥ 3b |
| **3d** | 1 | File tab (view/edit/diff, dirty guard, file-missing state) replacing `FileContentModal`; Usage tab; modals deleted | 3b, 2b | — |
| **4** | 2 | Panel (Shell, Activity), `toggleFullscreen` IPC, keyboard-only pass, legacy `index.css` rules removed, CLAUDE.md updated | 3b, 3c, 3d | — |
| **5** | 8 | ★ 11.2 fleet header, 11.3 stalled, 11.5 templates, 11.6 bulk hygiene + fleet load, 11.7 create-from-issue, 11.8 schedule toasts, 11.10 UI-event log (11.1 shipped in 1c/2a; 11.4 in 2a; 11.9 in 2a) | 4 | mostly ∥ |
| **6** | 2 | Split groups + Open to the Side, tab drag, Move View, Keyboard Shortcuts editor, Quick Open files (`git ls-files` route), light-theme pass, alias-token removal, deprecated persist keys removed, CSS audit ≤ 9 000 lines | 4 | — |

Shared-seam owners: 2a owns `Workbench.tsx`/`SideBar.tsx`/`layoutStore` shape; 3b owns `EditorArea`/registry; 2b and 3c only add directories plus a single registry line each.

## 8. Testing, gates, definition of done

### 8.1 Coverage gates (`scripts/coverage.mjs`)
- New-file floor 60 % on every new `frontend/src` source file (tracked or untracked) — ≈45–50 files: **no source file without its test in the same PR**; hosts keep logic in pure modules. `git mv` + material edits still counts as new; DnD stays inside `WorkspaceRow.tsx` (covered by ported tests) rather than a jsdom-hostile hook. `NEW_FILE_EXEMPT` unchanged.
- Ratchet: 0a deletes dead code **first**, then re-baselines (deleting well-tested dead code lowers the aggregate). Because the gate is repo-wide, host files landing at 60 % would drag a ~74 % package down: 0a changes `coverage.mjs` to ratchet **per package** (tolerance unchanged) and new host files must reach the package average or be listed with a reason.
- Test budget ≈ 1× source lines per PR.

| Test file | Cases | Fate |
|---|---|---|
| `App.test.tsx` | 45 | header/sidebar cases (~30) → workbench cases in 2a; remount, mobile, banner cases kept |
| `WorkspacePanel.test.tsx` | 50 | re-homed per component in 1a–1c; columns cases deleted; 2 known-defect cases kept marked |
| `TerminalView.test.tsx` | 41 | internals cases unchanged; header cases → breadcrumb; + hidden-mount, + watch-on-activate |
| `SettingsMenu.test.tsx` | 57 | 8 modal → tab lifecycle; 49 → per section |
| `FileExplorer.test.tsx` | 28 | split across views; duplicate-root known-defect kept |
| `TaskInputBar.test.tsx` | 28 | kept; hint case updated |
| `panelsAndModals` / `smallComponents` | 93 / 100 | dead-component cases removed in 0a; `FileContentModal` → file tab (3d); re-homed views' props updated |
| `useWebSocket.test.tsx` | 95 | + dispatcher, + `task:watch` |
| `taskStore*` | 159 | persist-key no-ops; `workspaceDraftInputs` |
| `voiceComponents` / `voiceHooks` | 82 / 100 | unchanged (gated, not removed) |

### 8.2 Regression hotspots → checks
| Behaviour | Check |
|---|---|
| Spawn size (#58/#81) | composer passes probe cols/rows (jsdom stubs `FitAddon.proposeDimensions`); create with no tab open → editor-area width |
| Resize buffer / oscillation (#61) | 12 cases kept; hidden-tab activation ≤ 1 resize; `⌘J` twice → net 0 extra; bar drag → no storm |
| Reconnect (App.test ×2) | ported to `EditorArea`; active-only restore; stale decoration |
| History interleave / query stripping (#155) | `TerminalView` hunks named per PR; internals cases pass |
| First-input delivery (#78/#155) | queue test kept; reply composer only in the active tab |
| UI-state persistence (#79/#155) | migration fixture; reconnect keeps layout |
| PR badge hover refresh (#81/#179) | hover test ported; breadcrumb hover throttled |
| Hierarchy (#231/#233) | 6 cases ported verbatim before layout changes |
| Mobile | App.test mobile cases; 390×844 screenshot |
| Shell hidden mount | App.test shell cases → tab |
| No network in tests (#218) | `hasLoaded` gating; fetch stub default |

### 8.3 E2E (0d)
Isolated backend + fake `claude`/`gh`; specs: palette; two-task switch with no `task:restore` on the wire (after 3b); bars/panel toggles; file tab save; Settings flush on switch; screenshot spec. Linux only; blocks merges once **10 consecutive nightly runs pass**; until then RTL + manual pass are the gate. e2e cannot prove key reservedness (headless has no browser chrome) — the fixture does.

### 8.4 Definition of done — every phase PR
1. Cut from `origin/main` ≤ 2 days old; rebased before merge.
2. `tsc --noEmit` (frontend, electron), `npm run build -w frontend`, Electron build clean.
3. `npm test` green on the three CI legs; `npm run coverage` pasted: ratchet ✓, every new file with its %.
4. Test inventory (deleted / rewritten / kept).
5. `TerminalView.tsx` hunks listed (or "untouched").
6. Screenshots: 1280×800 dark + 390×844 for every PR; add 1920×1080 + light for PRs touching CSS (screenshot spec automates this after 0d).
7. Keyboard-only pass; `aria-label` on icon-only controls; roles per §5.
8. User's 10-minute script: create task with no tab open; switch among **3** tasks 5× (no restore after 3b); resize a bar while output streams; toggle panel; reload → layout/selection/expanded preserved; nothing restarted.
9. Console clean; `[Workbench] mounted=N` ≤ cap; no WebGL fallback on the active tab.
10. CLAUDE.md + `docs/keybindings.md` updated; "what moved" paragraph in the PR body.

Logging: `[Workbench]`, `[Layout]`, `[Commands]`, `[Keybindings]`, `[UIEvent]` (never prompt text); info-level for migration, hydrate/prune counts, watch set changes, mounted/webgl counts.

## 9. Decisions

| # | Decision | Resolution | Evidence |
|---|---|---|---|
| 1 | Composer default | always-visible one-line row per expanded workspace | 419 human tasks, 252 < 300 chars; VS Code SCM input precedent |
| 2 | Isolate default | on for new workspaces | 54–59 % worktree tasks since July |
| 3 | Columns mode | removed | 14 weak matches |
| 4 | Preview tabs | files only | replaced previews unmount terminals |
| 5 | Voice / agent / thinking sound / Deepgram | gated, default off | 0 uses |
| 6 | Supervisor chat | gated (`supervisorEnabled`) | disabled |
| 7 | `/learn` | gated (`useLearnings`) | 0 uses |
| 8 | Checkpoints | Task Details only | 2 ever |
| 9 | GitHub / Jira views | optional, off by default; Jira auto | consumed via prompts + badge |
| 10 | Usage / tokens | status item + Task Details; dashboard by palette | 0 mentions |
| 11 | Mobile tunnel | status item while active | 3 mentions |
| 12 | Restart server | palette + confirm | 0 mentions |
| 13 | Header | removed | nothing daily-use |
| 14 | Files / Changes | both stay, right bar, SCM first | 467 `gitState` snapshots |
| 15 | References / per-task prompt | menu / details only | 1 / 0 |
| 16 | Manual rename | menu + `F2` | 0 |
| 17 | Two side bars | Tasks left, rest right | single bar hides the fleet while reading a diff |
| 18 | Feature flag | **none — user decision.** 2a is the cut-over PR; rollback = revert | — |
| 19 | Schedules | Task Details + palette + toast | five homes was too many |
| 20 | Workspace tabs vs tree | **open** — §14 | — |

## 10. Usage-audit findings (2026-09-04, this machine)

Source: `tasks.json` (877 tasks: 303 live / 574 archived), `config.json`, 970 session files, `git log -- frontend/src`, merged PRs. UI-only actions leave no trace; tab/badge clicks are *unknown*, not *unused*.

- **Claudia is the launcher**: 85 % of sessions match a Claudia task; 7 root + 45 worktree workspaces.
- **Fleet orchestration dominates**: 95 fan-out bursts = **403 tasks (46 %)**; 227 `claudia_create_task` calls; 554 status polls; 90 % auto-titled; half of tasks agent-authored.
- **Worktrees are the norm**: 54–59 % since July.
- **Issue → worktree → PR** (93 + 79 prompts, 1 149 `gh pr` calls), **PR babysitting** (81 agent crons), **read-only review fan-out** (39 pasted preambles), **fleet hygiene**, **36 slowdown/OOM messages**.
- Human sessions: median 1 message, p90 10 — the terminal is watched more than typed into.

| CORE | SECONDARY | RARE / DEAD |
|---|---|---|
| task creation · tree with state/unread/needs-input · subtasks · terminal + message bar · worktree badge + isolate · PR/CI badge · auto-title · busy/idle counts | sibling `send_input`/`continue` · bulk archive/delete/stop · image paste · sort/order/drag (wanted, unreliable) · workspace manager · schedule visibility · Changes/revert · token line | voice (0) · supervisor (off) · `/learn` (off) · checkpoints (2) · Jira (unconfigured) · Inbox/Issues/PR tabs · usage dashboard · references (1) · per-task prompt (0) · manual rename (0) · tunnel (3) · restart (0) · shell (unknown) |

Non-default settings: **MCP = playwright**, **`skipPermissions: true`**.

| Pain point | Count | Answer |
|---|---|---|
| `[Request interrupted by user]` | 55 / 31 sessions | Interrupt button; `Esc` double-tap guard |
| "continue" / "still running?" re-prompts | 50 / 26 | stalled state, Continue button |
| slowdown / OOM | 36 / 18 | fleet load + bulk stop |
| worktree count wrong, reset leaves worktrees, mute not muting, drag broken | recurring | fixed + tested in 1a–1c |
| content lost after restart; input not delivered | 2 | reconnect toast; active-only restore; #78/#155 paths untouched |
| 413 injected `<task-notification>` turns | — | needs-input queue + toasts for humans |

## 11. New capabilities (audit-driven)

1. **Needs-input queue** (1c/2a) — pinned group, activity badge, status `⚠ n`, `⌘⇧Y`, toast when not active.
2. **Fleet header** (5) — `2/6` + state strip; breadcrumb Fleet dropdown; Stop all / Archive finished / Open children.
3. **Stalled state** (5) — `busy` with no output > 120 s → `● quiet 4m`; needs `lastOutputAt`.
4. **Interrupt / Continue / Resume** (2a).
5. **Prompt templates** (5) — `⌘/`; `{{placeholders}}`; ships with the three observed shapes.
6. **Bulk hygiene** (1c multi-select; 5 *Archive landed tasks* + fleet load with *Stop all busy / Stop idle > 1 h*).
7. **New task from issue/PR** (5) — `#123` / GitHub URL in a composer → prefilled template, isolate on, title set.
8. **Schedule visibility** (5) — toast when an agent creates a cron; Task Details lists them.
9. **Quick toggles** (2a) — skip-permissions, Playwright MCP.
10. **Local UI-event log** (5) — on by default, Settings → Privacy, never prompt text.
11. *Quick chat* (#157) — deferred.

## 12. Dependencies, docs, platform
No new runtime dependencies. Windows: `keybindings.test.ts` covers both tables; Linux uses the win table. Electron: manual `dev:electron` smoke per phase. Docs: CLAUDE.md, `docs/keybindings.md`, `movedWhere.ts`.

## 13. Review findings deliberately not adopted
| Finding | Why not |
|---|---|
| Feature flag `claudia.ui.workbench` (three reviews recommended) | User chose a hard cut-over; 2a is designed as a complete replacement and 1a–1c are behaviour-preserving |
| Pull split editor groups into phase 3 | 3b's shell tab + `⌃\`` cover the "3 tasks + shell" case; splits stay in 6 |
| Six mounted terminals | cap 3 (WebGL contexts, memory); a setting |
| Custom Electron title bar | deferred; native frame |
| Mobile on `TasksView` now | frozen `WorkspacePanel` is cheaper and safer; separate effort |
| Port dead settings (`voiceEnabled` legacy mic buttons, `autoSpeakResponses`, `elevenLabsVoice*`) | dropped with their consumers |
| Quick Open over files in 0b | needs a recursive listing route; phase 6 |
| Branch shown in 3 places (row chip, status bar, details) | accepted — each answers a different question |

## 14. Open decision — workspace tabs

Alternative to the tree, proposed by the user: a 30 px top strip with one tab per workspace (`neuralspeaker ⑂ feat/1404 ●2 ⚠1 | terravue ●1 | …`, `+`); the left bar shows only that workspace's tasks (worktrees nested inside), editor tabs are per workspace (each remembers its own set), Explorer/SCM scope automatically, hide = close tab (#161), reorder = drag, the ⋮ menu = tab right-click. Cross-workspace safeguards: per-tab busy/needs-input badges, global `⚠ n` + `⌘⇧Y` switching workspaces, an **All** overview tab (the cross-workspace tree / board, #123).

Impact if chosen: §4 gains the strip; §5.2 loses workspace rows (tree becomes tasks-only with worktree groups); §6.1 `editors` becomes `Record<workspaceId, EditorTab[]>` + `activeWorkspaceId`; `currentWorkspaceId` = the active tab; the NEEDS INPUT group becomes workspace-scoped with the All tab holding the global one; phase 1a–1c unchanged except the workspace-row work moves to a `WorkspaceTabs.tsx` in 2a (+~0.5 PR). Fits the audit's within-repo rituals; costs cross-repo glanceability, which the safeguards restore.

---

## 15. Re-verification against `d718fbc` (2026-09-08)

The spec was written against `815106f`. Seven commits landed before it was committed; this is what re-checking every measured claim found.

| Claim | Status |
|---|---|
| Dead components — `TaskSummaryPanel`, `ConversationHistory`, `TaskCreateModal`, `LearnFromConversationModal`, `useVoiceRecognition` (§2.3.10) | **Holds.** Zero non-test importers on `d718fbc`; still test-covered, so 0a's delete-then-rebaseline order still matters |
| `WorkspacePanel` 2 998 · `App` 883 · `TerminalView` 846 · `TaskInputBar` 482 · `taskStore` 1 006 · `useWebSocket` 990 · `FileExplorer` 2 244 | **Holds**, unchanged |
| `SettingsMenu` 2 919 | **Stale** → 3 577 (+`.css` 1 711 → 2 035). #241 added the Updates panel; §5.7 and §3.3 updated |
| Four `isActive` flip sites, single-active model, `task:restore`/`task:output` broadcast to all clients, no resize ownership (§6.2) | **Holds.** #240 (busy-input delivery, session-id pre-assignment, non-destructive resume) touched `setTaskActive` logging only — it did not change the single-active model §6.7 replaces |
| Every backend line number in §6.2/§6.7 | **Stale**, re-anchored to `d718fbc` (`task-spawner.ts` 3728→3829, 4131→4225, 4155→4249, 5462→5572, 4621→4717; `server.ts` 1916→1930, 2243→2257, 1547→1559, 3351→3365). `backends/opencode-backend.ts` line refs unchanged; the path in the spec was missing its `backends/` prefix |
| Frontend hunk refs in §3.2 (`TerminalView.tsx:719/773-795/749/554/366-371`) and §5.9 (`App.tsx:310`, `useWebSocket.ts:273/424/497/566/729`) | **Holds** — all three files are byte-identical to the baseline |
| `v0.3.0` in the §2.1 sketch | **Stale** → `v0.4.0` |

New work the spec must absorb, beyond the table: #241 also added `frontend/src/types/electron.d.ts` (162 lines) — the Electron IPC surface the phase-4 `toggleFullscreen` work extends rather than invents.
