/**
 * This client's server-assigned connection id.
 *
 * One backend serves many clients (desktop app, browser tab, phone), and a
 * task's terminal has exactly one OWNER — the client whose `task:resize` frames
 * are actually applied to the PTY. The server hands each socket its own id in
 * the `init` frame and names the owner in `task:viewers`; comparing the two is
 * how a view knows whether it may drive the terminal size.
 *
 * A plain mutable module object rather than store state: it is read inside the
 * xterm WebSocket handler, which is outside React's render cycle and must not
 * re-subscribe on every frame. `id` is null until the first `init` arrives.
 */
export const clientIdentity: { id: string | null } = { id: null };
