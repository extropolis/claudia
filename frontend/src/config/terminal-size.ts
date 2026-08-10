/**
 * Shared mutable store for the last known terminal dimensions.
 * Updated by TerminalView whenever it successfully fits and sends a resize.
 * Read by WorkspacePanel when creating new tasks so the PTY starts at the
 * correct size instead of being guessed from panel pixel width.
 */
export const lastKnownTerminalSize = { cols: 220, rows: 50 };
