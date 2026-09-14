# Connect your devices with Tailscale

Claudia runs on one host PC, Mac, or Linux machine. Your phone and other computers connect to that same backend. Tasks, repositories, GitHub credentials, and agent sessions remain on the host. Keep it awake while work runs; a disconnected client does not move or stop the work.

## Host setup

1. Install and sign into [Tailscale](https://tailscale.com/docs/install) on the host and every client. Limit access in your tailnet policy to the users/devices intended to control this host.
2. Build Claudia with `npm run build`. Serve uses the production frontend, not the Vite development server.
3. Configure the host's backend launcher with `CLAUDIA_BIND_HOST=127.0.0.1` and `CLAUDIA_TRUSTED_PROXY=1`. For a new standalone service, run `node backend/dist/index.js` with those variables. On PowerShell, set `$env:CLAUDIA_BIND_HOST='127.0.0.1'` and `$env:CLAUDIA_TRUSTED_PROXY='1'` first. Keep your existing data directory and port configuration. The default backend port remains 4001.

   Apply launcher changes at a planned restart after ongoing work is safe. Do not launch another backend against an active data directory. Electron's spawned backend also honors the bind variable; if Electron attaches to an existing backend, configure that backend's launcher instead.
4. Inspect existing mappings with `tailscale serve status`. With an unused HTTPS listener, run:

   ```sh
   tailscale serve --bg http://127.0.0.1:4001
   tailscale serve status
   ```

   Replace 4001 only if your backend is explicitly configured on another port. If the default HTTPS listener is occupied, use an unused HTTPS port with `--https=<port>` and include that port in the copied URL. Do not reset or overwrite other Serve mappings. Follow any Tailscale HTTPS approval prompts. The [Serve CLI documentation](https://tailscale.com/docs/reference/tailscale-cli/serve) covers prerequisites and platform details.
5. Open Claudia locally, select **Devices**, and save the HTTPS `.ts.net` address printed by Serve. This saves the address and its allowed browser origin; it does not start Tailscale or prove connectivity. **Check connection** verifies that the address answers with this backend's instance identity from the current device. **Copy address** copies no credentials.
6. Open the address from another device with Tailscale connected. Paste the host's Claudia token into the login screen. Obtain it locally from the host's startup URL or the `auth-token` file in its data directory (normally `~/.claudia`, or the configured `CLAUDIA_DATA_DIR`). If the host uses `CLAUDIA_AUTH_TOKEN`, use that value instead. The token grants full control; transfer it privately.

Tailscale Serve makes the endpoint private to the tailnet; [Funnel](https://tailscale.com/docs/features/tailscale-funnel) is a separate public-exposure feature and is not part of this setup. Verify `tailscale funnel status` does not show public exposure. With loopback binding, the raw backend is not reachable over the LAN. If you retain the default all-interface listener, configure your firewall separately; saving a Tailscale address does not isolate the listener.

## Browser behavior

The browser uses the same HTTPS origin for assets and API calls, and WSS for the application socket. Login validates the token before loading the app. Query-token links from existing local launchers are consumed and removed from the visible URL. The token is scoped to the backend origin in session storage, normally lasting for the tab's lifetime. The server also sets an HttpOnly cookie; logout clears it and the tab's credential. Closing a tab is not token revocation.

Open **Devices → Log out of this browser** to disconnect that browser. Replacing the instance token affects all devices; per-device pairing and revocation are future work. This remains a single-user application, with full authority for every authenticated device.

Task terminals reuse Claudia's existing viewer ownership: the focused client controls terminal dimensions, and other viewers follow them. The separate workspace shell remains a shared interactive shell; simultaneous independent shell resizing is not covered by task ownership. Prefer task controls when using several devices at once.

An offline banner means the client is disconnected. Keep the host awake, check Tailscale on both ends, and retry. Do not assume an interrupted mutation failed; refresh state before repeating it. The UI does not silently queue offline commands.

## Native clients and diagnostics

Native clients use the same HTTPS address, without a browser or Tailscale identity-header login:

- `GET /api/server-info` is public identity/version discovery, with no remote data-directory path.
- `GET /api/auth/check` with `Authorization: Bearer <token>` verifies access.
- REST calls and WebSocket upgrades accept `Authorization: Bearer <token>`. Browser sockets use the existing query credential because browser WebSocket APIs cannot set an Authorization header.
- Requests through Serve cannot use `/api/auth/local` or local-only Jira features. HTTPS scheme headers are trusted only when the proxy option is enabled and the socket peer is loopback.

With `CLAUDIA_AUTH_TOKEN` set privately in the environment, run:

```sh
npx tsx backend/test-cli.ts --url wss://my-pc.tailnet.ts.net --remote-status
npx tsx backend/test-cli.ts --url wss://my-pc.tailnet.ts.net --list-tasks
```

The first command prints host identity and authentication status without printing the token. The second exercises the application socket. For an existing Electron remote attachment, set `CLAUDIA_BACKEND_URL=https://my-pc.tailnet.ts.net` and `CLAUDIA_AUTH_TOKEN`; an unavailable explicitly configured host no longer falls back to spawning a local backend. A graphical desktop host picker is future work.

## Migrating from ngrok

Tailscale replaces Claudia's ngrok integration. The tunnel manager, start/stop/status APIs, CLI tunnel commands, hostname detection, tunnel tokens/cookies, and token QR flow have been removed. The old `ngrokDomain` setting and `NGROK_DOMAIN` variable no longer enable anything. Old tunnel links/cookies do not authenticate to this version.

At your planned upgrade, stop the old ngrok process/service using its original launcher and remove any public mapping you configured. This release does not search for or kill unrelated ngrok processes. Clearing the saved Tailscale address does not stop Serve; manage its mapping through the Tailscale CLI.

## Validation before relying on remote access

Automated tests cover the real backend with Serve-shaped HTTP/WS requests, authentication, cookies, local privilege rejection, removed APIs, and existing task viewer arbitration. They do not prove a VPN connection. Before using this outside your home, verify on a physical phone using cellular plus Tailscale: login, workspace/task listing, task control, reconnect, and simultaneous viewing from another computer. Also verify an unauthorized device cannot reach the service. Record the host/client versions and observed results in the PR.

See the [native iOS implementation plan](plans/claudia-ios-remote-control.md).
