# Claudia: Headless Service & Thin Clients

**Status:** Draft v2 — for review
**Date:** 2026-08-09
**Supersedes:** draft v1 of this document (laptop-hosted backend + cloud relay); the connection story in `docs/plans/claudia-manager.md`; the LAN/Bonjour transport assumptions in epic #125

---

## 1. Goal

Turn Claudia's backend into a **headless Linux service** that runs on an always-on machine, with every UI — web, desktop, mobile — reduced to a thin client over one protocol.

Two deployment targets, one artifact:

| Tier | Runs on | Reached via | Price |
| --- | --- | --- | --- |
| **Free** | The user's own home server | Tailscale | Free |
| **Paid** | A Fly Sprite | Public HTTPS | TBD (§11) |

The defining property: **sessions keep running when every client is closed.** Not because work migrates anywhere, but because the machine doing the work never goes to sleep in the first place.

---

## 2. Why this is the simplifying move

Earlier drafts assumed the backend lived on the user's laptop, which forced a chain of hard problems: what happens when the lid closes, how work offloads to the cloud, how it comes back, how a phone reaches a sleeping Mac. Each answer added a subsystem.

Moving the backend to an always-on box deletes the entire chain. There is no offload because nothing stops. There is no migration because nothing moves. There is no rendezvous relay because the service has a stable address.

The laptop was never the right place for it. The laptop is a client.

---

## 3. Verified starting position

Facts confirmed by reading the code and primary sources, not inferred.

| Claim | Evidence |
| --- | --- |
| A backend abstraction already exists | `backend/src/backends/types.ts` defines `CodeBackend` with 16 methods and 5 events; two implementations ship (`claude-code-backend.ts` PTY, `opencode-backend.ts` HTTP) |
| Machine coupling is small | `homedir()` appears in 12 places, only 2 of them non-test (`index.ts`, `server.ts`) |
| The backend already serves the SPA | `server.ts` has a catch-all `get *` route; it is already a self-contained web service |
| Workspace identity is a filesystem path | `shared/src/index.ts:63` — `Workspace.id` is the absolute path. This survives the move; a server path is still a path. |
| Workspace *creation* is desktop-only | `server.ts:2796` — `POST /api/browse-folder` shells out to a native OS dialog (AppleScript `choose folder` on macOS). Meaningless on a server. |
| No multi-tenancy exists | Zero occurrences of `tenantId` / `ownerId` in `backend/src` |
| Electron only spawns a local backend | `electron/server-manager.ts`, `electron/backend-worker.ts` — no attach path |
| Desktop apps already build | `package.json` defines `package:mac`, `package:win`, `package:linux` via electron-builder |
| Tunnel auth hole is fixed | `server.ts:409-439` — token required on `/api/*`. Issue #77 closed. |
| High-consequence prompts are auto-approved | `task-spawner.ts:1297-1319` + `isPermissionPrompt()` at `:2367` — see §7 |
| Claude Code auth persists in `~/.claude` | Claude Code setup docs: browser login, or approve `ANTHROPIC_API_KEY` if set; requires Pro/Max/Team/Enterprise |
| Sprites suit this workload | Persistent KVM VMs, 100 GB durable root filesystem, 1–2s creation, checkpoint/restore, **auto-sleep preserving all state** with idle billing at cold-storage rates |

**Conclusion:** the backend is already 90% a headless service. It serves its own UI, abstracts its agent runtime, and barely touches the host. The work is deployment and workspace provisioning, not a rewrite.

---

## 4. Architecture

```
┌── Clients (thin, protocol only) ───────────────┐
│  Web SPA · Electron (mac/win/linux) · iOS      │
└────────────────────┬───────────────────────────┘
                     │ Protocol v1 — WSS + REST, token-authed
         ┌───────────┴────────────┐
    Tailscale                 public HTTPS
         │                        │
┌────────┴─────────┐    ┌─────────┴────────┐
│   Home server    │    │   Fly Sprite     │
│   (free tier)    │    │   (paid tier)    │
└──────────────────┘    └──────────────────┘
          same container image
          same persistent volume:
            /data/repos      git working trees
            /data/claude     ~/.claude — sessions, JSONL, credentials
            /data/claudia    tasks, config, history
```

A home server and a Sprite are the same thing from the software's point of view: a persistent Linux box with a durable filesystem. This is what keeps the design honest — there is no "cloud mode" branch in the code.

### 4.1 Protocol v1

The single versioned contract every client speaks (#187). Promoted from an implementation detail to *the* architectural artifact, because it is now the only interface to the product.

- WSS for live events, REST for backfill and mutations
- `GET /api/server-info` advertises `protocolVersion`; clients negotiate and refuse mismatches loudly
- Unknown enum values decode to `unknown(raw)` — a CLI update must never brick a shipped client
- Core messages: `conversation:event`, `task:prompt`, `task:answer`, `task:state`, `fleet:snapshot`
- Backend emits golden fixtures consumed by client test suites, so drift fails in CI

---

## 5. What changes

Four items. Only the second is substantial.

### 5.1 Package the backend as a container

A Debian-based image carrying node, `node-pty`, git, `gh`, ripgrep, and the `claude` CLI, with `/data` mounted as a volume. The code-side prerequisite is the configurable data directory (#188) — small, given only two non-test files call `homedir()`.

Explicitly **not** multi-tenant. One service, one user, one volume. A `TenantContext` seam is worth threading through the stores so multi-tenancy stays possible, but nothing more.

### 5.2 Rework workspace creation

`POST /api/browse-folder` opens a native OS folder dialog on the machine running the backend (`server.ts:2796`). On a server that is not a degraded experience — it is nonsense. Replace with two paths:

- **Clone from a Git remote** — the primary path. The server owns the working tree.
- **Browse the server's filesystem** — an API returning directory listings, rendered by the client. Not an OS dialog.

`Workspace.id` remains the absolute path, so the data model, worktree support, and PR integration are untouched. Only the picker changes.

This is the largest UX change in the plan and the piece most likely to reveal further co-location assumptions.

### 5.3 Bootstrap credentials on a headless box

Both `claude` and `gh` expect an interactive first run. Both persist afterwards — `~/.claude` and `~/.config/gh` live on the volume, so this happens once per deployment.

**Claudia already solves this and doesn't know it: it is a PTY multiplexer.** First-run setup is a terminal in the Claudia UI where the user runs `claude` and `gh auth login` directly, completing the browser step on whatever device they are already using. No new mechanism, no credential handling code, no secrets in config files.

### 5.4 Authentication becomes mandatory

The service is network-reachable by definition now. #126 (AuthManager), #127 (REST), and #128 (WS) stop being hardening and become launch blockers. A Sprite in particular is on the public internet with a task-spawning API — that is RCE-equivalent if unauthenticated, which is exactly the class of bug #77 was.

---

## 6. What this removes

The architecture is a net deletion, which is the strongest argument for it.

| Dropped | Reason |
| --- | --- |
| **Rendezvous relay (#191)** | Unnecessary. Tailscale gives the home server a stable address; Fly gives the Sprite a hostname. An entire subsystem disappears. |
| **Clerk + Stripe (#192)** | Not needed for v1. Billing matters only if *we* operate the Sprites (§11). |
| **Migration / offload / CRIU** | Nothing sleeps mid-work. |
| **Native Windows/Linux clients** | Electron already builds all three; #204 attach mode becomes the default, not an option. |
| **Bonjour / mDNS discovery (#131, #145)** | The service has an address. Discovery was solving laptop-finding. |

**Still required, but deferred:** APNs push (#193). iOS cannot receive background notifications from a self-hosted backend without a service holding the certificates. For v1 the app reconnects and resyncs on foreground; push becomes a small standalone service later, not a prerequisite.

---

## 7. Defects this plan must fix

### 7.1 High-consequence prompts are silently auto-approved

`task-spawner.ts:1297-1319` writes `\r` to auto-accept when `skipPermissions` is enabled. `isPermissionPrompt()` (`:2367-2396`) decides what qualifies:

| Prompt class | Behavior |
| --- | --- |
| AskUserQuestion (`Enter to select · ↑/↓ to navigate`) | **Excluded** — reaches `waiting_input` ✓ |
| `Allow` / `Deny` dialogs | auto-accepted ✗ |
| Numbered `1. Yes / 2. No` — **includes plan-mode exit and edit approval** | auto-accepted ✗ |
| Static-analysis warnings, `Esc to cancel · Tab to amend` | auto-accepted ✗ |

`backend/config.json` on the primary machine has `"skipPermissions": true` (code default is `false`).

The behavior is inverted from what any remote client needs: low-stakes questions reach the user while **plan approvals and edit approvals are auto-answered**. It matters more in this architecture than the last one — an unattended server approving its own plans is a different risk than a laptop doing it while you watch.

Two structural problems: ground truth is a **regex over rendered terminal text** (English-only, brittle across CLI updates), and there is **no audit trail** — the auto-accept path writes and `continue`s, recording nothing.

### 7.2 Multi-client viewing is now the default, and is unmodeled

One always-on backend means a laptop, a desktop, and a phone can all watch the same task. Today that is an accident; under this plan it is the normal case.

The code assumes a single viewer. `task:resize` is applied unconditionally — `if (taskId && cols && rows) taskSpawner.resizeTask(...)` — so the last client to send a width wins, and there is no viewer count anywhere in `server.ts` or `task-spawner.ts`.

`CLAUDE.md` already documents the consequences as known hazards: terminal resize *"buffers PTY output for 250ms to prevent width-mismatch corruption"*, and resize events under three columns are suppressed *"to prevent feedback loops"*. Both mitigations are tuned for one client. Three clients with different window widths will fight over the PTY continuously, and the existing damping makes the thrash slower rather than absent.

Needs an explicit model: who owns a task's terminal dimensions, what the other viewers see, and whether non-owning clients render read-only. Deciding this late means discovering it as "the terminal is garbled on my phone" with no obvious cause.

### 7.3 Unattended auto-approval

`skipPermissions: true` plus an always-on, internet-reachable machine is a different proposition from the same flag on a laptop the user is sitting in front of. §7.1 fixes the audit trail; it does not decide the policy.

The plan's position: **server deployments default to `skipPermissions: false`.** Approvals route to a human through the inbox rather than being answered by a regex. A user who wants the current behavior sets it deliberately, having seen the decision log that #190 adds.

### 7.4 Approval latency exceeds the hook timeout

#139 specifies a ~55-second long-poll before falling back to the terminal dialog. A human answering from a phone routinely exceeds this. Needs a renewable poll plus an explicit receipt — `pending → delivered → host_applied | stale | rejected` — so "tapped Approve" is never confused with "the agent acted" (@Snailflyer on #44).

---

## 8. The Manager

An autonomous engineering manager — a session that watches every task, handles the nitty-gritty, summarizes at a high level, and escalates only when it needs a human. It is the intended primary surface for mobile, because narrative summaries suit a phone and 80-column terminals do not.

This architecture makes the Manager *more* viable, not less: it now runs on an always-on server rather than competing with the user's laptop for uptime.

### 8.1 Cost

`docs/plans/claudia-manager.md` rejects Manager-as-Task twice — Appendix A cites **$500–3000/month** — then reverses to a backend `ManagerService` at **~$12/month**, observing that *"90% of the manager loop is deterministic."* Because the backend uses the user's own Claude subscription, this cost lands on their quota, and #167 records **33 usage-limit waits in a single session**.

### 8.2 Resolution: deterministic sensing, agentic judgment

- **`ManagerService`** (deterministic, free): polls task state, git, PR status, usage limits; detects stalls, landed work, duplicate effort.
- **Manager session** (Claude, invoked selectively): summarizes, decides, escalates, answers the developer.

Keeps the phone useful when the LLM half is rate-limited — the difference between a product and a demo.

### 8.3 Escalation policy

The Manager's value is what it *doesn't* send. Prerequisites:

- **#165 permission profiles.** Measured: 179+64 permission waits in one session; 133, 42, 39 in others. Without profiles, notifications are a firehose.
- **#167 usage-limit awareness.** *Blocked on you* vs *blocked until quota resets* — escalating the latter is the fastest way to get notifications disabled.
- **Consequence badging** (#163): internal actions instant and undoable; anything leaving the machine requires approval.

---

## 9. Phasing

Each phase is independently useful. P0 alone is a complete product for a single developer.

| Phase | Delivers | Gate |
| --- | --- | --- |
| **P0 — Service** | Container image, portable data dir, workspace creation rework, credential bootstrap, mandatory auth, Tailscale reachability | Runs on the home server; daily driver from the web SPA for two weeks |
| **P1 — Desktop attach** | Electron connects to a remote backend (#204) | Mac and PC drive one fleet |
| **P2 — Protocol + Sprite** | Protocol v1 (#187), SPA on the live stream (#141), `sprite` deploy path, auto-sleep tuning | Same image runs on a Sprite unmodified |
| **P3 — iOS** | Shared Swift package (#195), fleet, task detail, escape hatch, composer | Dogfooded daily for two weeks |
| **P4 — Manager** | `ManagerService` (#198), Manager session (#199), escalation policy | Measurable drop in babysitting rate (#173) |
| **P5 — Mobile v2** | Manager chat + escalation inbox (#200), APNs (#193), voice (#201) | — |

**P0 first.** It is the whole point: your sessions keep running when you close your laptop.

**Note on ordering:** Protocol v1 lands in P2 rather than P0. P0 can ship against the existing SPA↔backend interface — the goal there is *deployment*, not *contract*. The protocol becomes load-bearing when a second client type appears.

---

## 10. Testing

Per `CLAUDE.md`, test-CLI coverage before manual testing:

- `test-cli.ts --remote <url>` — run the existing CLI against a remote backend
- `test-cli.ts --protocol-tap <taskId>` — dump Protocol v1 events
- `test-cli.ts --manager-signals` — dump the deterministic signal set
- A `docker compose` fixture that boots the image with a seeded volume, so deployment is testable in CI rather than only on a real server
- Backend-generated protocol fixtures consumed by client test suites

**Where the existing suite will not help.** Repo coverage is 28% overall (backend 35% lines, frontend 7.6%), and the two least-covered large modules are `server.ts` and `task-spawner.ts` — exactly what P0 changes. `browse-folder` lives in `server.ts` and #209 rewrites it. A green suite after those changes is weak evidence, so they should be written with tests alongside rather than after. The WS and HTTP harnesses added in #184/#185 boot the real server on an ephemeral port with isolated state, so the cost of doing this is low.

---

## 11. Operations

The volume is the product. Everything that matters — repositories with uncommitted work, `~/.claude` credentials and transcripts, task state — lives on it, and the architecture's whole premise is that it outlives the machine.

**Backup.** Nothing in this plan protects that volume, which is the largest unaddressed risk in it. On a home server, a filesystem with snapshots (ZFS or btrfs) is worth setting up before there is data to lose. On a Sprite the durable root filesystem survives sleep and restart, but survives neither an account problem nor a mistaken `destroy`. A documented restore path matters more than the backup mechanism: an untested backup is a belief, not a capability.

**Migration from an existing install.** Every current user has state in `backend/`. Because the data directory defaults to the legacy location when unset (§5.1), moving is: stop Claudia, copy the files to the new volume, set `CLAUDIA_DATA_DIR`, start. This should be a documented procedure rather than folklore — it is the first thing every existing user does, including us.

**Upgrades and rollback.** Container images make upgrade a pull and restart, and rollback a matter of pinning the previous tag — but only if the data is forward *and* backward compatible. The stores already version their payloads through `loadVersioned`/`saveVersioned`, so the constraint is real and checkable: a schema bump that an older image cannot read makes rollback a data-loss event. Any migration that is not backward compatible needs to be called out in its release.

**Resource pressure — already answered.** A home server running many agents was a live failure mode: ~60 concurrent agents on a 24 GB machine drove load average to 205 at 0.9% idle. `memory-guard.ts` (#180) sheds the least-recently-used agents before the host pages, disconnecting rather than killing, so tasks keep their session and resume on click. This plan inherits that and needs nothing further; the tuning may want revisiting once the host is a server rather than a laptop.

## 12. Open questions

1. **Agent credentials on operated Sprites — the one unresolved risk.** We operate the Fly account (§4.2), so a user's Claude Code runs on infrastructure we own and bill for. Anthropic's Consumer Terms §3 prohibit accessing the Services *"through automated or non-human means"* except via an API Key, and since March 2026 subscription OAuth is enforced server-side as first-party only. Whether a user logging into *their own* isolated VM through our product counts as first-party use is genuinely unclear — it resembles a rented VPS, but it is sold as a managed service. **This needs an answer from Anthropic, not an inference from public terms.** The architecture works either way; only the billing story changes: subscription auth if permitted, otherwise bring-your-own API key at $150–250/month.
2. Does the free tier stay unauthenticated on localhost, or is auth always on?
3. One backend per user, or does the desktop keep a local backend for offline work?
4. Do we retire `/mobile` at P3, or keep it as a no-install fallback?
5. What is the Manager's default autonomy level on first run?

---

## 13. Issue map

Tracked under milestone **Portable Backend & Native Clients**, epic **#186**.

| Phase | Issues |
| --- | --- |
| P0 Service | #208 container image · #188 portable data dir · #209 workspace creation · #210 credential bootstrap · #126/#127/#128 auth · #189 trusted proxy · #178 Tailscale · #190 approval audit · #223 backup/migration/rollback |
| P1 Desktop | #204 attach mode · #222 multi-client viewer model |
| P2 Protocol + Sprite | #187 protocol · #136 event stream · #133 parser · #141 SPA on stream · #211 Sprite + control plane · #205 security posture · #192 billing |
| P3 iOS | #195 Swift package · #196 v1 surfaces · #149 composer · #10 sign & notarize |
| P4 Manager | #198 ManagerService · #199 Manager session · #165 · #167 · #166 · #160 · #46 |
| P5 Mobile v2 | #200 Manager UI · #193 APNs · #194 receipts · #139/#140 approval plumbing · #197 offline UX · #201 voice · #44 desktop inbox · #202 retire `/mobile` |

Closed as superseded: #77 (fixed), #142/#143/#144/#145 (→#195), #147 (→#196), #148 (→#200), #191 rendezvous relay (architecture change).

Rescoped rather than closed: #192 (billing now serves the Sprite control plane, not a relay), #205 (per-user Sprite isolation, not relay hardening), #193 (a standalone push service, not part of Connect).

Moved out of this milestone: #146 native macOS shell and #131 Bonjour — the first because Electron plus #204 covers desktop, the second because a service with a stable address has nothing to discover.
