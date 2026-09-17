/**
 * Drag-and-drop payload keys.
 *
 * Kept in its own module so the sidebar can advertise a task drag without
 * importing PaneHost (which pulls in TerminalView and the whole xterm stack).
 */

/** Carries a task id from a sidebar TaskItem onto a split-screen pane. */
export const TASK_DRAG_MIME = 'application/x-claudia-task-id';
