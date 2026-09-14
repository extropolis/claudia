# Tailscale device sharing — proposed scope for #178

Status: original implementation scope, 2026-09-14. During implementation the user requested removal of ngrok and an iOS remote-control plan. The shipped setup is documented in [../tailscale.md](../tailscale.md); the follow-on native scope is [claudia-ios-remote-control.md](claudia-ios-remote-control.md). These supersede the original coexistence proposal below. Starting issue: [#178](https://github.com/extropolis/claudia/issues/178), including its P0 promotion comment. Code reviewed after fetching and rebasing onto `origin/main` at `8ce9aa9`; the analysis worktree has no code delta from that commit. Existing issue bodies and the portable-backend plan contain stale implementation claims; the code evidence below takes precedence.

## Outcome and boundary

Run one Claudia backend on a machine that stays awake. Open the same workspaces, tasks, terminal output, and controls from a phone, tablet, or second computer through a private HTTPS address. Work remains on the host when a client disconnects. If the host sleeps or goes offline, clients show disconnected state; Tailscale does not move work or keep the host awake.

MVP is a single user's trusted devices, using browsers. Each device joins the user's tailnet and authenticates separately to Claudia with the existing full-authority instance token. This is not multi-user collaboration or permission-separated sharing.

Use **Tailscale Serve → the existing Claudia backend → built SPA + REST + WebSocket**. Serve supplies a tailnet-only HTTPS endpoint and manages its certificate. The operator installs and signs into Tailscale; Claudia does not embed a VPN, hold Tailscale account credentials, or modify tailnet policy. See [Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

## Verified starting point

| Area | Current code | Remaining scope |
| --- | --- | --- |
| Authentication | `backend/src/server.ts` gates REST and application WS unconditionally; `auth-token.ts` persists the instance token. | Validate Serve ingress and supply usable browser login. Do not rebuild auth based on old #127/#128 wording. |
| Proxy classification | `request-peer.ts` rejects forwarded requests as local, but relies on selected forwarding headers. `CLAUDIA_TRUSTED_PROXY` is a global switch for believing the HTTPS header. | Prove Serve HTTP and WS never qualify for local bootstrap, local-only Jira, or local-only broadcasts. Constrain scheme trust to configured proxy peers. |
| Browser routing | `frontend/src/config/api-config.ts` uses same-origin only for recognized tunnel hostnames; other hosts become `http://host:4001` / `ws://host:4001`. Electron conversion only replaces `http://`. | A Serve HTTPS page currently selects the wrong transport/port. Derive production URLs from the actual origin; convert HTTPS to WSS correctly. |
| Frontend hosting | `server.ts` serves `frontend/dist` when present. Its Vite proxy is specific to the active ngrok host. | Require a current production build for MVP; report missing assets clearly. Remote Vite/HMR is separate. |
| Sharing UI | `MobileAccessModal.tsx` manages ngrok and token-bearing QR URLs. `auth-client.ts` supports URL/session tokens and local bootstrap. | Add a Tailscale setup path and explicit token entry/invalid-token recovery. Do not reuse ngrok's root redirect that distributes its token. |
| Multiple viewers | `viewer-registry.ts`, WS handlers, and `TerminalView.tsx` already implement focus ownership, viewer counts, and owner-controlled dimensions. | Regression-test over Serve; #222's claim that every resize is unconditional is stale. Shared shell resizing needs a separate check. |
| Electron | `server-manager.ts` probes/attaches; `main.ts` accepts `CLAUDIA_BACKEND_URL`; token override exists. | #204 still needs connection settings, HTTPS WS handling, and no local-spawn fallback when an explicitly selected remote host is unavailable. |

## Delivery slices

### 1. Browser transport and ingress correctness — release blocker

- Resolve production REST URLs from `window.location.origin`, preserving scheme and explicit port. Retain an explicit local development backend override for Vite on 5173; retain Electron's configured backend origin. Use URL parsing for WS/WSS conversion, including IPv6. Do not add `.ts.net` substring detection.
- Serve the built SPA, assets, deep links, API, and application socket through the same HTTPS origin. Check CORS against the configured external origin when a proxy rewrites Host; do not broadly allow tailnet domains. Validate browser WS Origin as well as its token, allowing authenticated non-browser clients without Origin.
- Add an explicit opt-in loopback bind option for Serve deployments; keep the default listener and ports 4001/5173 unchanged. Document firewall isolation if an operator deliberately retains an all-interface listener. Scope proxy-scheme trust to the actual configured ingress rather than treating arbitrary forwarded headers as authoritative.
- Capture Serve's actual Host/forwarding behavior in a test fixture. Local-only privilege must require a genuinely local request, including local authority validation; header absence alone must not let a request for the configured remote origin bootstrap a token. Test both HTTP and WS and forged/missing forwarding headers. Do not use Tailscale identity headers as a Claudia login.
- Remove raw credential-bearing WS request URLs from logs (`server.ts` currently logs `req.url`). Redact query credentials on all touched diagnostic paths. HTTPS cookies must be Secure, HttpOnly, SameSite=Strict.

### 2. Setup and authentication — completes browser MVP

- Add a Tailscale section to remote-access settings: prerequisites, host address field, copy-address action, and a connection check. The copied address contains no token. Explain that work runs on the named host and that all enrolled devices need tailnet access.
- Start with manual Serve setup, using `tailscale serve --bg http://127.0.0.1:4001` and `tailscale serve status`; these are implementation instructions, not commands executed during scoping. Check existing Serve configuration first, and never reset unrelated services. Document HTTPS/admin requirements and platform-specific CLI setup using the [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
- Provide a token field on the remote login screen. The operator obtains the existing token locally on the host; it is not returned from a remote setup/status endpoint. Validate before opening the socket, show rejection distinctly from network failure, and offer retry/logout. Scope stored credentials to backend origin. The current WS protocol still needs an in-memory token; an HttpOnly cookie alone is not sufficient.
- Use existing session-storage behavior for MVP, document its lifetime, and clear session state on logout. Do not put the persistent token in share links or QR codes. If accepting old query-token links, consume and remove the token from the visible URL before normal navigation.
- Distinguish host unavailable, authentication rejected, and successful Claudia connection. A browser cannot reliably diagnose the host's Tailscale daemon; offer targeted checks without claiming a daemon diagnosis. No commands queued silently while offline.
- Document access policy limiting the HTTPS service to intended devices/users, host uptime, token replacement affecting all devices, and verifying that Funnel/public exposure is absent. Do not enable Funnel. Remove the existing ngrok path, its manager/endpoints/configuration, and token QR flow.

### 3. Desktop connection experience — follow-on under #204

Add a saved backend origin, secure token storage, host identity display, explicit connect/disconnect, and retry. An unreachable explicitly selected remote host must never cause a local backend to spawn. Switching hosts clears origin-specific auth/state and reconnects deliberately. Reuse the existing attach machinery and browser transport changes. This slice is not required for using a second laptop's browser.

## Acceptance and evidence

1. A phone on cellular with Tailscale connected and two computers open the same host through its HTTPS address. SPA assets and REST load without mixed content; the application socket uses WSS. The host runs a production frontend build.
2. An authorized client can create a disposable task, send input, observe output/state, and reconnect after a network change. Closing every client leaves the host task running; reconnect restores current state.
3. Three differently sized task viewers do not cause resize thrash. Focus ownership and viewer counts remain correct when the owner disconnects. Exercise the shared shell independently; fix any demonstrated cross-client interference before claiming it supported.
4. Missing/wrong tokens receive REST/WS rejection. Remote local-bootstrap and local-only Jira routes remain forbidden, including spoofed loopback/forwarding headers. Remote server-info contains no local data-directory path, and remote sockets receive no local-only broadcasts.
5. A valid token does not bypass tailnet access policy. A device outside the permitted network cannot reach the Serve endpoint. Verify no unwanted direct LAN/backend or public Funnel exposure for the documented deployment.
6. No full token appears in copied URLs, normal logs, or the address bar after login. HTTPS cookie flags and invalid-token recovery are verified in a real browser.
7. Automated coverage: URL matrix (localhost development, HTTPS production, explicit ports, IPv6, Electron), fake-proxy HTTP/WS tests, login recovery, and existing viewer regression suites. Extend `backend/test-cli.ts` only where necessary; verify its remote URL and credential behavior instead of trusting the older plan's hardcoded-port claims. Use isolated test servers/ports; do not restart the development server.
8. Release evidence includes a real Serve end-to-end run, client/browser/Tailscale versions, and a short recording of three-device viewing and reconnect. Mocked proxy tests alone do not establish VPN reachability.

## Dependencies and exclusions

Track implementation in #178. Reuse delivered portions of #126–#129, #189, and #222; their open status does not mean the code is missing. Coordinate remaining ingress hardening with #189 and desktop UX with #204. Per-device pairing/revocation (#130) is a later improvement; the MVP token grants full host authority and cannot revoke just one Claudia client.

No new relay/control plane, Fly hosting, native mobile app, machine migration, filesystem sync, embedded Tailscale/tsnet, automatic VPN installation, multi-user roles, or remote Vite support. No requirement to complete the headless-service epic #186 before sharing an existing awake host.

Size: two browser implementation slices plus an end-to-end validation pass; desktop UX is a separate follow-on. Main uncertainty is the actual Serve proxy behavior across supported host platforms, so verify that before polishing setup UI. This scope does not claim the feature works today and does not enable sharing on the user's machine.
