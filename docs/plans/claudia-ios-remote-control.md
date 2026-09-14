# Native iOS remote control for Claudia

Implementation plan, 2026-09-14. Builds on Tailscale device sharing (#178) and the existing workspace/GitHub managers. This plan scopes the next feature; this PR does not implement an iOS application.

## Product

A native iPhone app controls the user's existing Claudia session running on a PC, Mac, or Linux host. The primary experience is managing repositories, workspaces, GitHub issues/PR work, and agent tasks. Repositories, `gh` authentication, agent credentials, PTYs, and execution stay on the host. The phone neither clones the working tree locally nor starts another backend.

Default tabs:

1. **Workspaces:** repositories and worktrees, branch/dirty/availability status, active tasks, and repository details.
2. **GitHub:** repository issues, notifications, PR/CI status, and actions to start or steer work from an issue.
3. **Tasks:** active/queued/needs-input tasks across workspaces, detail conversation, send instruction, stop, and explicit archive/delete actions.
4. **Host:** saved host address, verified identity, connection/freshness status, reconnect, and sign out.

Terminal viewing is a secondary diagnostic screen. The app should not require typing shell commands to perform normal manager actions.

## Transport decisions carried by this PR

- One HTTPS origin through user-managed Tailscale Serve. The user installs Tailscale on iOS and signs into the same tailnet. No embedded VPN, relay, public Funnel, or ngrok fallback.
- Discover using `/api/server-info`; authenticate using `/api/auth/check`. A URL and a token are separate inputs. Persist the verified host origin and identity, with its credential in Keychain scoped to that host. A changed backend instance after restart is a reconnect event, not evidence by itself of an attack: the current `instanceId` is per running instance, not a durable device identity.
- REST and application WebSocket upgrades accept a bearer Authorization header. iOS can create its WebSocket from an authenticated URLRequest; it need not use a query-token URL or browser bootstrap/cookies.
- Local-only routes remain local-only. Tailscale identity headers never grant Claudia authority.
- The host remains authoritative. On foreground/reconnect, fetch fresh snapshots before enabling destructive actions. Do not automatically retry mutations after an ambiguous disconnect.

Use SwiftUI and a small shared Swift client package, with an actor owning URLSession, the socket, and ordered state updates. Apple's [URLSessionWebSocketTask](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask) provides the transport. Design for suspension: background execution is bounded, not an always-running socket; see Apple's [background execution guidance](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time). Save a small, explicitly stale snapshot on background, reconnect on foreground, and avoid claiming live state while suspended.

## Existing API inventory and gaps

Verified against `main` at `8ce9aa9` plus this PR. `frontend/src/components/FileExplorer.tsx` currently contains much of the GitHub UI; `WorkspaceManager.tsx` manages workspace selection/creation. Manager interfaces may evolve, so reuse their backend contracts rather than their browser component structure.

| User action | Existing surface | Work for iOS |
| --- | --- | --- |
| List workspaces/tasks | `GET /api/workspaces`, `GET /api/tasks`, WS `init`/updates | Swift models, stable sorting, availability and freshness UI. |
| Create/rename/delete workspace | WS `workspace:create`, `workspace:rename`, `workspace:delete` | Typed acknowledgements and action-specific errors. Current browse-folder paths open a native dialog on the host; add server-side browse/clone before offering remote workspace creation. |
| Manage worktrees | `GET/POST/DELETE /api/worktrees`, prune; workspace WS messages | Present current branch/dirty state and explicit deletion confirmation. Establish a single documented mutation contract. |
| Inspect files/git | `/api/workspaces/files`, `/read-file`, `/git-status`, `/git-log`, `/git-diff` | Encoded server-side paths, paging/size limits, diff rendering; never treat a host path as an iOS filesystem path. |
| Issues | `GET/POST /api/workspaces/github-issues`, `PATCH /api/workspaces/github-issues/:issueNumber` | Issue list/detail/edit, pagination and repository selection; show backend `gh` errors accurately. |
| PR/CI status | `GET /api/workspaces/ci-status`, `PATCH /api/workspaces/pr-description` | PR detail/status first. Review submission, merge, and richer PR browsing need explicit APIs; do not invent support from the manager's name. |
| GitHub notifications | `GET /api/github/notifications`, `PATCH /api/github/notifications/:threadId` | Inbox, mark read, route to selected repository. |
| Start/steer tasks | WS `task:create`, `task:input`, lifecycle commands | Structured action layer, operation identity, duplicate prevention. Raw terminal input is not a semantic approval API. |
| Read task conversation | `GET /api/tasks/:taskId/conversation`, output/history endpoints | Bounded snapshots initially; cursor-based catch-up and structured live events before rich streaming. |
| Approval or destructive task deletion | Existing WS prompt/delete coordination | Audit exact prompt and request identity. Add server-owned, expiring, one-shot decisions so phone and PC cannot both answer an obsolete prompt. |

Do not fetch `/api/config` as the iOS home-screen model: it contains broad application configuration, including credentials the manager screens do not need. Add a small capabilities response and purpose-built manager settings endpoints as required.

## Delivery order

### I0 — remote contract and fixtures

Freeze the initial REST/WS subset and generate sanitized JSON fixtures from a real isolated backend. Document envelope/version/error fields, timestamps, host paths, pagination, and unknown-event behavior. Add request IDs and acknowledged outcomes for every mutation exposed by iOS, with server-side idempotency for create/merge/delete operations before retry support. Add endpoint-level capability flags instead of inferring feature availability from an app version.

For credential lifecycle, the Tailscale MVP's shared instance token is sufficient for an internal prototype. Before wider distribution, deliver per-device issuance/revocation (#126/#130), ensure revocation closes existing sockets, and provide host-side device management. Browser logout currently clears local credentials; it is not per-device revocation.

Gate: an API-only harness can exercise the manager workflows without Electron, desktop dialogs, or reading secret configuration.

### I1 — read-only iPhone manager

Create the SwiftUI app and client package. Implement host connection, Keychain credential storage, workspace/task lists, issue/notification lists, PR/CI status, and task detail. Display the host name/address throughout navigation. Support cellular + Tailscale, airplane mode, host sleep, app suspension, invalid credentials, and explicit host switching. Show last-updated timestamps on cached content; segregate cache and credentials per host.

Gate: physical iPhone and desktop display the same workspace/task/issue state. Foreground refresh never silently switches to another host or an independent local session.

### I2 — remote actions

Add issue create/edit, start task from issue, task instruction/stop, workspace/worktree creation through the new server-side flow, and notification read actions. Add reviewed PR mutations only after their APIs exist. Confirm consequential operations against the selected repository, branch, issue/PR, and latest state. For two clients racing on the same action, present the server's accepted result or conflict. Never send guessed terminal keystrokes as an approval decision.

Gate: run each action from a phone while the PC observes it; disconnect after send but before acknowledgement and prove reconnect does not duplicate the mutation. A GitHub issue action uses the host's `gh` credentials and reports API errors without requiring GitHub credentials on the phone.

### I3 — task supervision and optional terminal

Add structured prompt cards, conversation catch-up, task completion/needs-input inbox, and a read-only terminal escape hatch. Reuse the task viewer protocol without claiming terminal size ownership merely by viewing on a phone. Decide any interactive terminal takeover explicitly. The separate workspace shell currently has shared resize semantics; fix or omit it from the iOS UI.

Push notifications are a separate design (#193): a tailnet-only host cannot be assumed to sustain an iOS background socket. An APNs sender, enrollment/revocation, notification privacy, and offline-host behavior require their own scope. No implied push guarantee in I1/I2.

## Validation and dependencies

Test decoding against fixtures; API contract tests against the Node backend; iOS UI tests for host identity, failed login, cached state, reconnect, and confirmations. Run physical-device tests over Wi-Fi and cellular with Tailscale. Verify that an unauthorized device cannot reach the endpoint, and that removing an app credential affects active access once device revocation exists.

Coordinate with #204 (desktop remote attachment), #209 (remote workspace creation), #126/#130 (device credentials), #136/#141 (conversation protocol), #139/#140 (semantic approvals), #195/#196 (native iOS), and #222 (viewer model, already partly shipped). Existing issues may contain superseded relay assumptions; the PC-hosted Tailscale model above is the intended connection path.

No cloud execution/migration, multi-user roles, embedded GitHub tokens on the phone, remote desktop video, or requirement to rebuild every browser feature before shipping the manager.
