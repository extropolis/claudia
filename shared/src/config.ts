/**
 * Shared configuration - Single source of truth for port settings
 */

export const PORTS = {
  /** Backend API server port */
  BACKEND: 4001,
  /** Frontend dev server port */
  FRONTEND: 5173,
  /** Internal OpenCode server port */
  OPENCODE: 4097,
};

export const BACKEND_URL = `http://localhost:${PORTS.BACKEND}`;
export const BACKEND_WS_URL = `ws://localhost:${PORTS.BACKEND}`;
