# Claudia: One Host, Thin Clients

**Status:** Draft v3 — for review
**Date:** 2026-09-07
**Supersedes:** draft v2 (2026-08-09) of this document. Changes from v2 are listed in §14.
**Bias:** cost-sensitive and simple. Where two designs are close, the cheaper and smaller one wins.

---

## 1. Goal

Run Claudia's backend on **exactly one always-on host per user**, with every UI — web, desktop, mobile — reduced to a thin client over one protocol. Tasks keep running when every client is closed. The whole installation can be exported from one host and imported on another.

The host is any persistent Linux or macOS box:

| Host | Reached via | Cost |
| --- | --- | --- |
| A Mac that stays awake (mini, Studio, or a laptop on power) | LAN, Tailscale | $0 |
| A home server | Tailscale | $0 |
| One Fly Sprite | Public HTTPS | ~$0.44 per 4-hour session; idle at $0.02/GB-month |

Same code on all three. There is no "cloud mode" branch.

The defining property: **sessions keep running when every client is closed.** Not because work migrates anywhere, but because the machine doing the work never goes to sleep.

The host is agent-runtime agnostic: Claude Code today, Codex and OpenCode next, others later (§4.5). Long-horizon runs are the workload this is built for.

---

## 2. The boundary

Where the isolation boundary sits was the open architectural question. Three candidates were considered; the first is chosen.

| Boundary | What it means | Verdict |
| --- | --- | --- |
| **The host** — one VM is the whole Claudia | Backend, every workspace, `~/.claude`, `~/.claudia` all on one box | **Chosen.** No new subsystems. One bill, mostly zero. |
| A workspace — one VM per project | Backend becomes a control plane driving a VM per repo over a remote PTY | Rejected. Needs a remote-PTY transport, a separate always-on control plane that can never sleep, and credential seeding per VM. Multiplies the OS/node/claude footprint per project. The isolation it buys — repo A can't touch repo B — matters for multiple *people*, not one. |
| A task — one microVM per agent run | Ephemeral Firecracker-style sandbox per task | Rejected. Same transport cost as above, plus Claude Code needs `~/.claude` continuity to resume, which ephemeral sandboxes don't give. |

Consequences of choosing the host:

- `Workspace.id` stays the absolute path (`workspace-store.ts:159`). A stable-id refactor was only justified by per-workspace hosts. Relocation is handled by path remapping at import time (§11), a contained change, not an identity change.
- Snapshot-before-refactor is a Sprite checkpoint of the whole VM — coarser than per-project, free.
- Multi-device works identically: every client talks to the one backend.

---

## 3. Verified starting position

Facts confirmed by reading the code at `d718fbc`. Line numbers are current.

| Claim | Evidence |
| --- | --- |
| A backend abstraction exists | `backend/src/backends/types.ts:85` `CodeBackend`, 16 methods; PTY and OpenCode implementations. Not needed for this plan, kept as-is. |
| The backend already serves the SPA | `server.ts:7473-7481` static + catch-all. It is already a self-contained web service. |
| The data directory is configurable | `paths.ts` — explicit → `CLAUDIA_DATA_DIR` → legacy `backend/`. #188 closed. **Two stores and one sidecar ignore it** (§7.5). |
| Electron only spawns a local backend | `server-manager.ts:25` `startServer()`; no attach path; no `requestSingleInstanceLock`. `preload.ts:12` default `http://localhost:3001` is stale (real port 4001). |
| The preload survives an `http://` load | `main.ts:115-119` binds preload to the window, not the scheme. Dev already loads `http://localhost:5173`. Attach mode needs no Electron rework. |
| There is no auth for non-tunnel hosts | `server.ts:458-497` gates `/api/*` only when `isTunnelHost(host)`; `voice-auth.ts:20-23` matches hostname substrings (`ngrok`, `loca.lt`). `index.ts:96` binds all interfaces. A LAN IP, Tailscale name, or `*.fly.dev` host gets zero auth. |
| A local-token pattern already exists | `mcp-auth.ts:36-85` — 32 random bytes, persisted 0600 at `<dataDir>/mcp-token`, `timingSafeEqual`. This is the model for all auth. |
| No instance lock exists | Only `EADDRINUSE` (`index.ts:107-118`), `start.sh`'s `/tmp` lock, and `saveTasks` refusing to write when `tasks.json`'s mtime moved (`task-spawner.ts:2381-2393`). Three partial guards, none authoritative. |
| `tasks.json` is unversioned | `task-spawner.ts:2543` plain `JSON.stringify`. Six other stores use the `{schemaVersion, data}` envelope (`utils/schema-version.ts`). No migration is registered anywhere. |
| Workspaces with a missing path are deleted on load | `workspace-store.ts:71` `filter(w => existsSync(w.id))`. Silent. Also fires for an unmounted external drive. |
| Claude CLI session files are keyed by absolute path | `~/.claude/projects/<mangled-path>/<sessionId>.jsonl`; mangling in `token-parser.ts:17-24`, duplicated at `task-spawner.ts:2576-2584`, `conversation-parser.ts:84`, `backends/claude-code-backend.ts:835`. Resume, cost accounting, and conversation rendering all depend on it. |
| Secrets live in plaintext state | `config.json`: Anthropic key (`config-store.ts:105`), Deepgram (`:110`), AI Core (`:113-115`), Jira token (`:69-71`), arbitrary `mcpServers[].env`/`headers`. Plus `mcp-token`, copied into every workspace's `.mcp.json` (`task-spawner.ts:851-855`). |
| Histories are large | On the primary machine: `task-histories/` 1.3 GB / 921 files, `archived-histories/` 910 MB / 453 files. |
| High-consequence prompts are auto-approved | `task-spawner.ts:1644-1664` writes `\r`; `isPermissionPrompt()` at `:3112-3141` is a regex over terminal text. No audit store. `backend/config.json` on the primary machine has `skipPermissions: true`. |
| Multi-client viewing is unmodeled | `server.ts:2024-2029` applies `task:resize` unconditionally; no viewer count, no per-client dimensions. `clients` (`:786`) is unbounded and every socket receives every task's output (`:841-853`). |
| Six surfaces assume backend and display are the same machine | `POST /api/browse-folder` `server.ts:3438-3496`; `workspace:browseFolder` `:2456-2535`; `workspace:openFolder` `:2537-2557`; `workspace:openTerminal` `:2559`; reveal-in-finder `:5009-5017`; Windows shell default `:1336`. |
| `test-cli` half-supports a remote target | `--url` exists (`test-cli.ts:1409`) but HTTP calls force the port back to 4001 (`:2666-2669`), and Jira/tunnel subcommands hardcode `http://localhost:4001` (`:2486`, `:2568`). |
| Sprites fit the workload | Persistent KVM VM, 100 GB durable filesystem, checkpoints ~300 ms, auto-sleep preserving process state, idle billing $0.02/GB-month, ~$0.44 per 4-hour Claude Code session. Exec API is a WebSocket with TTY mode; sessions persist across disconnects. Sources: sdxcentral.com/news/flyio-debuts-sprites-persistent-vms-that-let-ai-agents-keep-their-state, docs.sprites.dev/working-with-sprites, sprites.dev/api/sprites/exec |

**Correction to v2.** v2 §3 claimed "machine coupling is small" by counting `homedir()` calls. That measured the wrong thing. Coupling is pervasive but goes through absolute paths, not `homedir()`: workspace ids, task `workspaceId`, worktree ids and parents, Claude session folder names, node binary paths in synced `.mcp.json`, the backend port in every `.mcp.json`. The work is still deployment rather than a rewrite, but the co-location list is known (this table), not a surprise budget.

**Conclusion:** the backend is 90% a headless service. The missing 10% is auth, instance identity, data-dir hygiene, attach mode, and a real export/import. All of it is P0.

---

## 4. Architecture

```
┌── Clients (thin, protocol only) ────────────────────────────┐
│  Web SPA · Electron (mac/win/linux, attach mode) · iOS      │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS/WSS, token-authed, always
                            │
              ┌─────────────┴──────────────┐
              │   THE host (exactly one)   │
              │                            │
              │  claudia backend (node)    │
              │  ~/.claudia   state        │
              │  ~/.claude    CLI sessions │
              │  ~/work/*     repos        │
              └────────────────────────────┘
        Mac that stays awake · home server · one Sprite
```

### 4.1 Data layout: the home directory

All Claudia state defaults to **`~/.claudia/`** on every host. `CLAUDIA_DATA_DIR` overrides. This replaces today's three-way split (repo `backend/`, Electron's `Application Support`, `/data`).

Why the home directory rather than a platform-specific location:

- The user can find, inspect, back up, and `rsync` it without instructions.
- The layout is identical on laptop, home server, and Sprite: `~/.claudia` next to `~/.claude`, repos wherever the user keeps them. A container is a Linux user whose home is on the volume. No code has a cloud branch.
- Export/import is "the home directory's Claudia state, minus secrets."

**Migration on first boot:** if `~/.claudia` is absent and legacy state exists (`backend/` or Electron `userData`), copy — not move — and log loudly. Rollback is free. `LEGACY_DATA_DIR` remains readable for one release, then the fallback is removed.

### 4.2 Instance identity: exactly one backend per data directory

The invariant is stated and enforced in one place:

- The backend writes `<dataDir>/instance.json` on boot: `{ instanceId, pid, port, startedAt, version }`, with an exclusive lock. A second backend against the same data dir refuses to start and prints the running instance's URL.
- `GET /api/server-info` returns `{ instanceId, version, protocolVersion, dataDir, startedAt }`. Unauthenticated; carries nothing sensitive.
- Every launcher — `start.sh`, Electron, `test-cli` — reads `instance.json` (or probes `/api/server-info`) **before** spawning. Found → attach. Not found → spawn.

This is what makes Electron attach mode a small change rather than a subsystem, and what retires `start.sh`'s `/tmp` lock and `saveTasks`'s mtime heuristic.

### 4.3 Auth: always on

There is no unauthenticated mode. The hostname sniffing in `voice-auth.ts:20-23` (and its three copies) is deleted.

- One bearer token, provisioned at first boot into `<dataDir>/auth-token` (0600), same mechanism as `mcp-auth.ts`.
- Loopback clients get it automatically: `start.sh` and Electron read the file and pass it. The browser at `localhost` reads it once from a `/api/auth/local` endpoint that only answers to loopback peers (`isLoopbackRequest`, `server.ts:6280-6320`, already checks the socket address).
- Remote clients paste it once (QR code for mobile, as the tunnel flow does today). Stored in an `HttpOnly; Secure; SameSite=Strict` cookie for the SPA, `Authorization: Bearer` for API clients.
- Every `/api/*` route and every WebSocket upgrade validates it, with `timingSafeEqual`. The `mobile=1` special case in the upgrade handler (`server.ts:1650-1687`) is removed — one path.
- Behind a reverse proxy, `X-Forwarded-*` is trusted only when `CLAUDIA_TRUSTED_PROXY` is set (#189).

Tailscale remains recommended for the home-server tier as defense in depth, not as the auth mechanism.

### 4.4 Agent runtimes

The host runs any agent CLI. `CodeBackend` (`backends/types.ts:85`) is the seam; two implementations ship — Claude Code over a PTY, OpenCode over HTTP. Codex is a PTY application like Claude Code and lands as a third implementation of the same interface with a different command line and prompt patterns. Nothing in this plan is runtime-specific except one thing that must stop being:

- **Session location is Claude-specific and leaks into four files.** The `~/.claude/projects/<mangled-path>/<sessionId>.jsonl` derivation lives in `token-parser.ts:17-24`, `task-spawner.ts:2576-2584`, `conversation-parser.ts:84`, `backends/claude-code-backend.ts:835`. It moves behind the backend: `CodeBackend.sessionFiles(workspacePath, sessionId): string[]`. Export/import (§11), resume, and cost accounting call that; they never know a runtime's dotdir layout. Codex keeps its own sessions under `~/.codex`; OpenCode's are server-side.
- **Resume is a backend capability, not a Claudia one.** Claudia's reconnect path already re-spawns `claude --resume <sessionId>` after any interruption (`reconnectTask`). Each backend implements resume for its runtime; a runtime without resume gets a fresh session with the prior transcript injected as context. This is what makes handoff (§11.3) runtime-agnostic.

Per-runtime credentials (`~/.claude`, `~/.codex`, `~/.config/gh`) are bootstrapped once per host through the terminal (§5.10) and are never exported.

### 4.5 Protocol v1

Unchanged from v2. Deferred to P2: P0 ships against the existing SPA↔backend interface because the goal there is deployment, not contract. `GET /api/server-info` (§4.2) is the seed of it and ships in P0.

---

## 5. What changes

Ordered by dependency. Each item is small; together they are P0.

### 5.1 Instance lock and server-info (§4.2)

`instance.json`, `/api/server-info`, launchers probe before spawn. Two files, one endpoint.

### 5.2 Auth always on (§4.3)

Blocks everything remote. Deletes the tunnel-hostname special-casing rather than extending it.

### 5.3 Data-dir hygiene

- Default to `~/.claudia`; first-boot copy from legacy.
- Fix the wiring bugs (§7.5): `server.ts:695` `new TodoStore()` → `new TodoStore(dataDir)`; `server.ts:698` `new CheckpointStore(basePath)` → `new CheckpointStore(dataDir)`; `shared-mcp-manager.ts:77-83` pid/log files under `dataDir`.
- Put `tasks.json` and `archived-tasks.json` in the `{schemaVersion, data}` envelope. Register the first migration. Without this, upgrade/rollback (§12) is a belief, not a capability.
- Stop writing `~/.claude/commands/learn.md` on every boot (`index.ts:29-63`); write once, guarded by a marker.

### 5.4 Workspaces with a missing path become `unavailable`, not deleted

`workspace-store.ts:71` deletes; it should mark. The UI shows the workspace greyed with the path it expects. Applies to unmounted drives today and to import tomorrow. Tasks keep their `workspaceId` and stay listed.

### 5.5 Electron attach mode (#204)

On launch: read `instance.json` / probe `/api/server-info` at the configured URL (default `http://localhost:4001`). Found → `loadURL('http://<host>:<port>?backendUrl=…')`, no spawn. Not found → spawn as today, then the same load. The preload is scheme-independent (`main.ts:115-119`), so `electronAPI` — clipboard, fullscreen, updater — keeps working. Fix `preload.ts:12`'s stale `3001` default. Add a "Connect to…" field in Settings for a remote host and its token.

Display-coupled surfaces (§3, six of them) must check `isElectron()` *and* whether the backend is local; otherwise the folder dialog returns a client-side path that means nothing to the host. Hide them when remote; #209 replaces them.

### 5.6 Minimal multi-client viewer model (#222)

Two viewers is day one, not P1 — attach mode creates it. Minimal model:

- The task's PTY dimensions are owned by the **most recently focused** client. `task:resize` from any other client is ignored; the server records who owns it.
- Non-owning clients render at the owner's dimensions inside their own viewport (xterm handles a smaller viewport by scrolling; it does not need to reflow).
- The server broadcasts `task:viewers { taskId, count, ownerClientId }` so the UI can say "viewing at 120×40, owned by phone."

That is the whole model. It replaces two viewers fighting through 250 ms damping with one owner and no fighting.

### 5.7 Export/import (#223) — see §11

### 5.8 Package the backend as a container image (#208)

Debian-based, carrying node, `node-pty` (native build), git, `gh`, ripgrep, `claude`. Runs as a non-root user whose home is the mounted volume, so §4.1's layout holds unchanged. Explicitly not multi-tenant.

### 5.9 Workspace creation without a desktop (#209)

Replace the native dialog with two paths: clone from a Git remote (primary; the host owns the working tree), and a server-side directory listing rendered by the client. `Workspace.id` remains the absolute path on the host.

### 5.10 Credential bootstrap on a headless host (#210)

Unchanged from v2: Claudia is a PTY multiplexer, so first-run is a terminal in the UI where the user runs `claude` and `gh auth login`. Once per host. With one host per user this is "do it once," which is why per-workspace VMs were rejected (§2).

---

## 6. What this removes

| Dropped | Reason |
| --- | --- |
| Rendezvous relay (#191) | Tailscale gives a home server a stable address; Fly gives a Sprite a hostname. |
| Clerk + Stripe (#192) | Billing only matters if *we* operate Sprites. Not v1. |
| Migration / offload / CRIU | Nothing sleeps mid-work. |
| Native Windows/Linux clients | Electron builds all three; attach mode makes them thin. |
| Bonjour / mDNS (#131, #145) | The host has an address. |
| **Per-workspace VMs** | §2. A control plane and a remote-PTY transport to serve a boundary one person doesn't need. |
| **Per-task sandboxes** | §2. Same transport cost, and breaks `~/.claude` continuity. |
| **Hostname-based tunnel detection** | Replaced by always-on auth. Four drifting copies deleted. |
| **`start.sh` `/tmp` lock, `saveTasks` mtime heuristic** | Replaced by `instance.json`. |

**Still required, deferred:** APNs push (#193), as in v2.

---

## 7. Defects this plan must fix

### 7.1 High-consequence prompts are silently auto-approved

Unchanged from v2; line numbers drifted to `task-spawner.ts:1644-1664` (auto-accept) and `:3112-3141` (`isPermissionPrompt`). Still a regex over rendered terminal text. The only addition since v2 is a `logger.info` line — an app-log entry, not an audit trail. **Server deployments default to `skipPermissions: false`**; #190 adds the decision log.

### 7.2 Multi-client viewing is unmodeled

`server.ts:2024-2029`, verbatim `if (taskId && cols && rows) taskSpawner.resizeTask(...)`. Fixed by §5.6, in P0.

### 7.3 Unattended auto-approval — unchanged from v2.

### 7.4 Approval latency exceeds the hook timeout — unchanged from v2.

### 7.5 The configurable data directory is only partly wired

- `server.ts:695` — `new TodoStore()` takes no argument; `todos.json` always lands in `backend/`, even for Electron.
- `server.ts:698` — `new CheckpointStore(basePath)` passes the raw caller argument instead of the resolved `dataDir`; under `CLAUDIA_DATA_DIR` (a container) it falls back to `backend/`.
- `shared-mcp-manager.ts:77-83` — pid and log files hardcoded to `join(__dirname, '..')`.

In a container all three write into the image layer and vanish on redeploy — the exact failure #188 was meant to prevent. Corroborated on the primary machine: `backend/todos.json` and `backend/checkpoints.json` are current while other state lives elsewhere.

### 7.6 Auth is keyed on hostname substrings

`voice-auth.ts:20-23` and three copies (`server.ts:1637`, `frontend/src/config/api-config.ts:11`, `server.ts:454`). Any hostname without `ngrok`/`loca.lt` in it is treated as local and gets no auth. The WS upgrade validates the token only when `mobile=1` (`server.ts:1672-1687`). `tunnel-manager.ts:652` compares tokens with `===`. All replaced by §4.3.

### 7.7 Workspaces with a missing path are deleted on load

`workspace-store.ts:71`. Fixed by §5.4.

### 7.8 `tasks.json` is unversioned

`task-spawner.ts:2543`. Fixed by §5.3.

### 7.9 `test-cli` can't fully target a remote host

`test-cli.ts:2666-2669` rewrites the port to 4001; `:2486` and `:2568` hardcode the URL. Fixed alongside §5.5 so the CLI is the first attach-mode client.

---

## 8. The Manager

Unchanged from v2 (§8 there). This architecture makes it more viable: it runs on the always-on host rather than competing with a laptop for uptime.

---

## 9. Phasing

| Phase | Delivers | Gate |
| --- | --- | --- |
| **P0 — One host** | §5.1 instance lock + server-info · §5.2 auth always on · §5.3 data-dir hygiene + `tasks.json` envelope · §5.4 unavailable workspaces · §5.5 Electron attach · §5.6 viewer model · §5.7 export/import · §7.9 `test-cli` remote | The primary Mac stays awake as host. Phone and a second laptop attach with a token. State is exported, imported on a second machine with paths remapped, and a task resumes there. |
| **P1 — Headless host** | §5.8 container image · §5.9 git-clone workspace creation · §5.10 credential bootstrap · #178 Tailscale · #189 trusted proxy · #190 approval audit | Same image runs on a home server and on one Sprite, unmodified. Daily driver from the web SPA for two weeks. |
| **P2 — Protocol** | Protocol v1 (#187), SPA on the live stream (#141), parser v2 (#133) | A second client type can be written against fixtures. |
| **P3 — iOS** | Unchanged from v2 | Dogfooded daily for two weeks |
| **P4 — Manager** | Unchanged from v2 | Measurable drop in babysitting rate (#173) |
| **P5 — Mobile v2** | Unchanged from v2 | — |

**Ordering rationale.** v2 put attach mode and the viewer model in P1 and export/import in "operations." All three moved to P0: attach mode is the fix for the bug that exposed the two-backend split; two viewers exist the moment attach works; and migration is the first thing every existing user does, including us. Auth moved from "one of five P0 bullets" to the second item, because P0's own transport (LAN/Tailscale) is exactly the case that bypasses today's auth.

**P0 first.** It is the whole point: your sessions keep running when you close your laptop, and you can take the whole setup with you.

---

## 10. Testing

- `test-cli.ts --url <ws-url> --token <t>` honored end-to-end (§7.9). The CLI is the first attach client and the CI check that attach works.
- `test-cli.ts --export <dir> [--with-secrets] [--with-histories] [--with-agent-sessions]` and `--import <dir> [--map <old>=<new>]... [--dry-run]`.
- Round-trip test in CI: boot a backend on an ephemeral port with seeded state (the #184/#185 harnesses), export, import into a second ephemeral backend with a remapped root, assert workspaces are `available`, tasks list, and a task's session file resolves under the new mangled folder.
- Handoff round-trip test: task running on backend A with a dirty tree; `--export --handoff`; `--import --handoff` into backend B with a remapped root; assert the tree matches, the task resumes with the prior turn visible in its transcript, and A refuses to run tasks.
- Instance-lock test: second backend against the same data dir exits non-zero and prints the first's URL.
- Auth test: every route in `server.ts` returns 401 without the token, from a non-loopback peer. Generated from the route table so a new route can't be forgotten.
- Viewer-model test: two WS clients, one focused; resize from the other is ignored; `task:viewers` reports the owner.
- `docker compose` fixture booting the image with a seeded volume (P1).

Coverage note from v2 stands: `server.ts` and `task-spawner.ts` are the least-covered large modules and the ones P0 touches most. Write tests alongside, not after.

---

## 11. Export / import (#223)

The one piece v2 left as prose. A copied data directory does not survive a machine change: workspaces whose paths don't exist are deleted on load (§7.7), Claude session folders are named by the old absolute path (§3), secrets travel in plaintext, and histories are gigabytes.

### 11.1 Format

A directory (tar it if you like):

```
claudia-export-<yyyy-mm-dd>/
  manifest.json          formatVersion, exportedAt, claudiaVersion,
                         source { platform, hostname, instanceId, dataDir, homeDir },
                         tiers included, schemaVersions per file,
                         workspaces [ { id, name, worktreeParentId? } ]
  state/                 config.json (secrets stripped), workspace-config.json,
                         tasks.json, archived-tasks.json, checkpoints.json,
                         scheduled-tasks.json, todos.json, learnings.json,
                         chat-history.json
  secrets.json           only with --with-secrets; the stripped fields, 0600
  histories/             only with --with-histories; task-histories/, archived-histories/
  agent-sessions/        only with --with-agent-sessions;
                         <backend>/<workspaceId-as-recorded>/<sessionId>.*
                         (files named by CodeBackend.sessionFiles, §4.4)
```

Never exported: `instance.json`, `mcp-token`, `auth-token`, pid files, `crash.log`, tunnel state, anything under `tmpdir()`. Tokens are regenerated on the target.

### 11.2 Import

`--import <dir> [--map <old-root>=<new-root>]... [--dry-run]`

1. Refuses if a backend holds `instance.json` in the target data dir.
2. Applies the schema migrations of the *target* version to each file (which is why `tasks.json` needs the envelope, §5.3).
3. Rewrites paths in the known fields: `workspaces[].id`, `workspaces[].worktreeParentId`, `recentWorkspaces[].id`, `lastBrowsedPath`, `tasks[].workspaceId`, `archivedTasks[].workspaceId`, checkpoint cwds. Longest-prefix match on the `--map` table; also maps the source `homeDir` to the target's by default.
4. Writes each runtime's session files where that runtime expects them on the target (`CodeBackend.sessionFiles` with the remapped path).
5. Marks any workspace whose remapped path does not exist as `unavailable` (§5.4). Never deletes.
6. `--dry-run` prints the remap table and the list of workspaces that would be unavailable, and exits.

### 11.3 Handoff: moving live work between hosts

The question this must answer: a task is running on a Sprite, money runs out, and the user wants to continue on their PC — or the reverse. Transfer as little as possible; recreate processes on the other side; keep the conversation.

Claudia already has two of the three pieces. Every backend restart marks tasks `wasInterrupted` and re-spawns them with resume (§4.4) — process recreation is the ordinary reconnect path, not a new mechanism. Checkpoints already capture the dirty working tree as a diff. The missing piece is §11.1–11.2 plus a git-based repo handoff.

What transfers, and what does not:

| Transfers | Size | Does not transfer |
| --- | --- | --- |
| Claudia state (`state/`) | KB–MB | Processes, PTYs — recreated by resume |
| Agent session files for **non-archived tasks only** | MB | Terminal scrollback — optional tier, not needed to continue |
| Repos as **git refs**, not files | delta only | `node_modules`, build output — rebuilt |
| | | Tokens, instance identity — regenerated |

Flow, `--export --handoff` on the source:

1. For every workspace, commit the dirty working tree to `claudia/handoff/<workspace-slug>` (a WIP commit on a throwaway branch; the user's branch is untouched) and push it. Workspaces with no remote are listed and the export refuses unless `--allow-no-remote`, in which case that repo is included as a bundle (`git bundle`), still delta-free of history the target already has.
2. Stop every task gracefully (the runtime flushes its session file), then export per §11.1 with `--with-agent-sessions`, agent sessions filtered to non-archived tasks.
3. Write `handedOffAt` and the export's `instanceId` into the source's `instance.json`. The source backend will start, but refuses to run tasks until `--import` or `--reclaim` — this is what prevents two hosts resuming the same session.

`--import --handoff` on the target:

4. Import per §11.2 with a remap table.
5. For each workspace, `git fetch` the handoff ref and check it out onto the user's branch as uncommitted changes (`git reset --soft` back to the WIP commit's parent), so the tree looks exactly as it did on the source.
6. Every imported task is `wasInterrupted`; the existing auto-reconnect resumes them in order, throttled as it is today.

Both directions are the same operation. A Sprite left behind sleeps at storage cost; it can be resumed later with `--reclaim` after handing back.

Limits, stated so they aren't discovered: an agent mid-tool-call loses that call — resume continues from the last completed turn, identical to Ctrl-C then resume today. Runtimes without a resume primitive get the transcript injected as context (§4.4), which is lossy. Dependencies are reinstalled on the target, so the first run after handoff is slow.

### 11.4 Operations

- **Backup** is `--export` on a schedule plus whatever the host's filesystem offers (ZFS/btrfs snapshots on a home server; Sprite checkpoints). A restore is `--import` — tested in CI (§10), so it is a capability, not a belief.
- **Migration from today's install** is `--export` on the Mac, `--import --map /Users/<u>/Work=/home/<u>/work` on the host. Documented as the first thing every existing user does.
- **Upgrade and rollback** are a pull and restart, and a tag pin. Safe only because every store — now including `tasks.json` — is versioned and migrations are registered. A migration that is not backward compatible is called out in its release.
- **Resource pressure** — unchanged from v2: `memory-guard.ts` (budget 45% of RAM, minimum 3 live agents) sheds idle agents by disconnecting, not killing.

---

## 12. Open questions

1. **Agent credentials on operated Sprites.** Unchanged from v2, but narrowed: it only applies if *Claudia* operates the Fly account for users. A user deploying to their own Fly account is running a VPS. The self-host path has no ToS question. Needs an answer from Anthropic before an operated tier exists.
2. ~~Does the free tier stay unauthenticated on localhost?~~ **Resolved: auth is always on; loopback gets the token automatically (§4.3).**
3. ~~One backend per user, or does the desktop keep a local backend for offline work?~~ **Resolved: one backend. The desktop spawns one only when none is reachable, and that one is the host until it's replaced (§4.2).**
4. Do we retire `/mobile` at P3? Unchanged.
5. Manager default autonomy — unchanged.
6. **New:** Fly Machines vs Sprites for the container tier. Sprites preserve process state across auto-sleep; Machines with `auto_stop_machines` kill every PTY. If Machines are ever used: `auto_stop_machines = false`, `min_machines_running = 1`, and the "sessions survive" property costs a continuously-billed VM. Default is Sprites.

---

## 13. Issue map

Milestone **Portable Backend & Native Clients**, epic **#186**. Status at `d718fbc`: only #188 is closed.

| Phase | Issues |
| --- | --- |
| P0 One host | **new:** instance lock + server-info · **new:** `~/.claudia` default + first-boot copy · **new:** #188 wiring fixes (§7.5) · **new:** `tasks.json` envelope · **new:** unavailable workspaces · #126/#127/#128 auth (rescoped: always on, delete hostname sniffing) · #204 attach mode · #222 viewer model · #223 export/import (rescoped per §11) · **new:** handoff (§11.3) · **new:** `CodeBackend.sessionFiles` (§4.4) · **new:** `test-cli` remote fixes |
| P1 Headless host | #208 image · #209 workspace creation · #210 credential bootstrap · #178 Tailscale · #189 trusted proxy · #190 approval audit |
| P2 Protocol | #187 · #136 · #133 · #141 · #211 Sprite deploy path (rescoped: docs + fly config, no control plane) · #205 |
| P3 iOS | #195 · #196 · #149 · #10 |
| P4 Manager | #198 · #199 · #165 · #167 · #166 · #160 · #46 |
| P5 Mobile v2 | #200 · #193 · #194 · #139/#140 · #197 · #201 · #44 · #202 |

Closed as superseded: as in v2. **#192 billing and the #211 control plane** move out of every phase until an operated tier is decided (§12.1).

---

## 14. Changes from v2

- **Boundary decided (§2):** one host is the whole Claudia. Per-workspace VMs and per-task sandboxes considered and rejected with reasons. `Workspace.id` stays the path.
- **§3 corrected:** "machine coupling is small" replaced with the verified coupling list.
- **Data layout (§4.1):** `~/.claudia` by default everywhere, replacing `/data/{repos,claude,claudia}`. First-boot copy from legacy.
- **Instance identity (§4.2):** new. `instance.json`, `/api/server-info`, probe-before-spawn.
- **Auth (§4.3):** always on; hostname sniffing deleted; loopback auto-token. Was one P0 bullet, now the P0 blocker.
- **Viewer model (§5.6):** concrete minimal design; moved P1 → P0.
- **Attach mode (§5.5):** moved P1 → P0; verified the preload survives an `http://` load.
- **Export/import (§11):** specified — format, tiers, remap, dry run, CI round-trip. Moved from "operations" prose to P0.
- **Defects:** §7.5–7.9 added (data-dir wiring, hostname auth, workspace deletion, unversioned `tasks.json`, `test-cli` remote).
- **Open questions:** 2 and 3 resolved; 1 narrowed to the operated tier; 6 added (Machines vs Sprites).
- **Agent runtimes (§4.4):** new. Runtime-agnostic host; session location and resume move behind `CodeBackend`; Codex as a third backend.
- **Handoff (§11.3):** new. Live work moves between hosts by exporting state + agent sessions + git refs, and recreating processes through the existing resume path.
- **Sprite host tier:** now a P1 deployment target of the same image, not a P2 subsystem. Control plane and billing deferred until an operated tier is decided.
