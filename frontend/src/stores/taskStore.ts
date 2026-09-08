import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Task, Workspace, TaskSummary, ChatMessage, WaitingInputType, ScheduledTask, TaskTokenUsage } from '@claudia/shared';
import { getApiBaseUrl } from '../config/api-config';
import { ThemePreference } from '../types/theme';

// Info about a task that is waiting for user input
export interface WaitingInputInfo {
    taskId: string;
    inputType: WaitingInputType;
    recentOutput: string;
    timestamp: Date;
}

// Activity event for the activity log
export interface ActivityEvent {
    id?: string; // auto-generated
    taskId: string;
    type: 'completed' | 'waiting_input' | 'error';
    taskName: string;
    message?: string;
    timestamp: Date;
}

interface VoiceSettings {
    voiceName: string | null;
    rate: number;
    pitch: number;
    volume: number;
}

interface TaskStore {
    // State
    tasks: Map<string, Task>;
    archivedTasks: Task[];
    showArchivedTasks: boolean;
    selectedTaskId: string | null;
    lastSelectedTaskByWorkspace: Map<string, string>; // workspaceId → last selected taskId
    isConnected: boolean;
    isServerReloading: boolean;  // True when server is restarting (hot reload)
    isOffline: boolean;  // True when browser has no internet connection
    errorNotification: { message: string; code?: string; timestamp: Date } | null;

    // Workspace state
    workspaces: Workspace[];
    expandedWorkspaces: Set<string>;
    expandedWorkspacesInitialized: boolean;  // True once persisted state is loaded or first workspaces set
    collapsedWorktreeGroups: Set<string>;  // Worktree group section ids the user has collapsed
    taskListHeight: number | null;  // User-set height (px) of the resizable task list; null = default
    showProjectPicker: boolean;
    workspaceColumns: number; // 0 = auto, 1-4 = fixed column count
    workspaceSortBy: 'date-created' | 'last-modified' | 'alphabetical' | 'manual'; // How to sort workspaces; 'manual' uses drag-drop order persisted on the backend
    taskSortBy: 'date-created' | 'last-modified'; // How to sort tasks within workspaces

    // Voice state
    voiceEnabled: boolean;
    autoSpeakResponses: boolean;
    selectedVoiceName: string | null;
    voiceRate: number;
    voicePitch: number;
    voiceVolume: number;

    // ElevenLabs voice state
    elevenLabsVoiceId: string | null;
    elevenLabsVoiceName: string | null;

    // Global voice mode state
    globalVoiceEnabled: boolean;
    focusedInputId: string | null;
    voiceTranscript: string;
    voiceInterimTranscript: string;
    autoSendEnabled: boolean;
    autoSendDelayMs: number;
    deepgramApiKey: string;

    // Supervisor state
    taskSummaries: Map<string, TaskSummary>;

    // Chat state
    chatMessages: ChatMessage[];
    chatTyping: boolean;

    // Waiting input notifications
    waitingInputNotifications: Map<string, WaitingInputInfo>;

    // Draft input per task (preserved when switching tasks)
    taskDraftInputs: Map<string, string>;

    // Scheduled tasks (cron) - keyed by scheduled task ID
    scheduledTasks: Map<string, ScheduledTask>;

    // Activity tracking - tasks with unread events + activity log
    unreadTaskIds: Set<string>;
    activityLog: ActivityEvent[];

    // Pending delete confirmation (from MCP agent). One request can cover many
    // tasks — the dialog lists them all and the user unchecks any to keep.
    pendingDeleteRequest: { requestId: string; tasks: { taskId: string; taskName: string }[] } | null;
    setPendingDeleteRequest: (request: { requestId: string; tasks: { taskId: string; taskName: string }[] } | null) => void;

    // Settings
    autoFocusOnInput: boolean;
    supervisorEnabled: boolean;
    aiCoreConfigured: boolean | null; // null = not checked yet, false = not configured, true = configured
    showSystemStats: boolean;
    browserNotificationsEnabled: boolean;
    notifyOnCompletion: boolean;
    notifyOnWaitingInput: boolean;
    thinkingSoundEnabled: boolean;
    thinkingSoundInterval: number; // milliseconds between sounds
    voiceSummaryOnCompletion: boolean; // Announce task summaries when tasks complete
    voiceProgressUpdatesEnabled: boolean; // Announce periodic progress for long-running tasks
    voiceProgressUpdateInterval: number; // milliseconds between progress updates
    themePreference: ThemePreference;
    tokenCostEnabled: boolean;

    // Actions
    setConnected: (connected: boolean) => void;
    setServerReloading: (reloading: boolean) => void;
    setOffline: (offline: boolean) => void;
    setErrorNotification: (message: string, code?: string) => void;
    clearErrorNotification: () => void;
    selectTask: (id: string | null) => void;
    setTasks: (tasks: Task[]) => void;
    addTask: (task: Task) => void;
    updateTask: (task: Task) => void;
    updateTaskTokenUsage: (taskId: string, tokenUsage: TaskTokenUsage) => void;
    deleteTask: (taskId: string) => void;

    // Archived tasks actions
    setArchivedTasks: (tasks: Task[]) => void;
    setShowArchivedTasks: (show: boolean) => void;
    removeArchivedTask: (taskId: string) => void;

    // Workspace actions
    setWorkspaces: (workspaces: Workspace[]) => void;
    addWorkspace: (workspace: Workspace) => void;
    updateWorkspace: (workspace: Workspace) => void;
    removeWorkspace: (workspaceId: string) => void;
    reorderWorkspaces: (fromIndex: number, toIndex: number) => void;
    toggleWorkspaceExpanded: (workspaceId: string) => void;
    toggleWorktreeGroupCollapsed: (groupId: string) => void;
    setTaskListHeight: (height: number | null) => void;
    setShowProjectPicker: (show: boolean) => void;

    // Task reordering
    reorderTasks: (workspaceId: string, fromIndex: number, toIndex: number) => void;

    // Voice actions
    setVoiceEnabled: (enabled: boolean) => void;
    setAutoSpeakResponses: (enabled: boolean) => void;
    setVoiceSettings: (settings: VoiceSettings) => void;
    setElevenLabsVoice: (voiceId: string, voiceName: string) => void;

    // Global voice mode actions
    setGlobalVoiceEnabled: (enabled: boolean) => void;
    setFocusedInputId: (id: string | null) => void;
    appendVoiceTranscript: (transcript: string) => void;
    setVoiceInterimTranscript: (interim: string) => void;
    clearVoiceTranscript: () => void;
    consumeVoiceTranscript: () => string;
    setAutoSendSettings: (enabled: boolean, delayMs: number) => void;
    setDeepgramApiKey: (key: string) => void;

    // Supervisor actions
    setTaskSummary: (summary: TaskSummary) => void;
    clearTaskSummary: (taskId: string) => void;

    // Chat actions
    addChatMessage: (message: ChatMessage) => void;
    setChatMessages: (messages: ChatMessage[]) => void;
    setChatTyping: (isTyping: boolean) => void;
    clearChatMessages: () => void;

    // Waiting input actions
    setWaitingInput: (info: WaitingInputInfo) => void;
    clearWaitingInput: (taskId: string) => void;

    // Draft input actions
    setTaskDraftInput: (taskId: string, input: string) => void;
    getTaskDraftInput: (taskId: string) => string;
    clearTaskDraftInput: (taskId: string) => void;

    // Scheduled tasks actions
    setScheduledTasks: (tasks: ScheduledTask[]) => void;
    addScheduledTask: (task: ScheduledTask) => void;
    removeScheduledTask: (cronId: string) => void;
    getScheduledTasksForTask: (taskId: string) => ScheduledTask[];

    // Activity actions
    addActivityEvent: (event: ActivityEvent, markUnread?: boolean) => void;
    clearTaskUnread: (taskId: string) => void;
    clearAllActivityLog: () => void;

    // Layout actions
    setWorkspaceColumns: (columns: number) => void;
    setWorkspaceSortBy: (sortBy: 'date-created' | 'last-modified' | 'alphabetical' | 'manual') => void;
    setTaskSortBy: (sortBy: 'date-created' | 'last-modified') => void;

    // Settings actions
    setAutoFocusOnInput: (enabled: boolean) => void;
    setSupervisorEnabled: (enabled: boolean) => void;
    setAiCoreConfigured: (configured: boolean | null) => void;
    setShowSystemStats: (show: boolean) => void;
    setBrowserNotificationsEnabled: (enabled: boolean) => void;
    setNotifyOnCompletion: (enabled: boolean) => void;
    setNotifyOnWaitingInput: (enabled: boolean) => void;
    setThinkingSoundEnabled: (enabled: boolean) => void;
    setThinkingSoundInterval: (interval: number) => void;
    setVoiceSummaryOnCompletion: (enabled: boolean) => void;
    setVoiceProgressUpdatesEnabled: (enabled: boolean) => void;
    setVoiceProgressUpdateInterval: (interval: number) => void;
    setThemePreference: (pref: ThemePreference) => void;
    setTokenCostEnabled: (enabled: boolean) => void;
}

// Storage key for localStorage
const STORAGE_KEY = 'claudia-task-store';

// State that should be persisted (UI preferences and settings)
interface PersistedState {
    selectedTaskId: string | null;
    showArchivedTasks: boolean;
    expandedWorkspaces: string[];  // Stored as array, converted to Set
    expandedWorkspacesInitialized: boolean;  // Track if user has interacted with workspaces
    collapsedWorktreeGroups: string[];  // Stored as array, converted to Set
    taskListHeight: number | null;  // User-set resizable task-list height
    workspaceColumns: number; // 0 = auto, 1-4 = fixed
    workspaceSortBy: 'date-created' | 'last-modified' | 'alphabetical' | 'manual'; // How to sort workspaces; 'manual' uses drag-drop order persisted on the backend
    taskSortBy: 'date-created' | 'last-modified'; // How to sort tasks within workspaces
    voiceEnabled: boolean;
    autoSpeakResponses: boolean;
    selectedVoiceName: string | null;
    voiceRate: number;
    voicePitch: number;
    voiceVolume: number;
    elevenLabsVoiceId: string | null;
    elevenLabsVoiceName: string | null;
    globalVoiceEnabled: boolean;
    autoSendEnabled: boolean;
    autoSendDelayMs: number;
    deepgramApiKey: string;
    autoFocusOnInput: boolean;
    supervisorEnabled: boolean;
    showSystemStats: boolean;
    browserNotificationsEnabled: boolean;
    notifyOnCompletion: boolean;
    notifyOnWaitingInput: boolean;
    thinkingSoundEnabled: boolean;
    thinkingSoundInterval: number;
    voiceSummaryOnCompletion: boolean;
    voiceProgressUpdatesEnabled: boolean;
    voiceProgressUpdateInterval: number;
    themePreference: ThemePreference;
    tokenCostEnabled: boolean;
    taskSummaries: [string, TaskSummary][];  // Stored as entries array
    chatMessages: ChatMessage[];
}

export const useTaskStore = create<TaskStore>()(
    persist(
        (set, get) => ({
            // Initial state
            tasks: new Map(),
            archivedTasks: [],
            showArchivedTasks: false,
            selectedTaskId: null,
            lastSelectedTaskByWorkspace: new Map(),
            isConnected: false,
            isServerReloading: false,
            isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
            errorNotification: null,
            workspaces: [],
            expandedWorkspaces: new Set<string>(),
            expandedWorkspacesInitialized: false,
            collapsedWorktreeGroups: new Set<string>(),
            taskListHeight: null,
            showProjectPicker: false,
            workspaceColumns: 0, // 0 = auto
            workspaceSortBy: 'date-created', // Default to date created
            taskSortBy: 'date-created', // Default to date created for tasks

            // Voice initial state
            voiceEnabled: false,
            autoSpeakResponses: false,
            selectedVoiceName: null,
            voiceRate: 1.0,
            voicePitch: 1.0,
            voiceVolume: 1.0,

            // ElevenLabs voice initial state
            elevenLabsVoiceId: null,
            elevenLabsVoiceName: null,

            // Global voice mode initial state
            globalVoiceEnabled: false,
            focusedInputId: null,
            voiceTranscript: '',
            voiceInterimTranscript: '',
            autoSendEnabled: false,
            autoSendDelayMs: 3000,
            deepgramApiKey: '',

            // Supervisor initial state
            taskSummaries: new Map(),

            // Chat initial state
            chatMessages: [],
            chatTyping: false,

            // Waiting input initial state
            waitingInputNotifications: new Map(),

            // Draft input initial state
            taskDraftInputs: new Map(),

            // Scheduled tasks initial state
            scheduledTasks: new Map(),

            // Activity tracking initial state
            unreadTaskIds: new Set(),
            activityLog: [],

            // Pending delete confirmation
            pendingDeleteRequest: null,
            setPendingDeleteRequest: (request) => set({ pendingDeleteRequest: request }),

            // Settings initial state
            autoFocusOnInput: false,
            supervisorEnabled: false,
            aiCoreConfigured: null,
            showSystemStats: false,
            browserNotificationsEnabled: false,
            notifyOnCompletion: true,
            notifyOnWaitingInput: true,
            thinkingSoundEnabled: false,
            thinkingSoundInterval: 5000, // 5 seconds
            voiceSummaryOnCompletion: false,
            voiceProgressUpdatesEnabled: false,
            voiceProgressUpdateInterval: 180000, // 3 minutes (180 seconds)
            themePreference: 'system' as ThemePreference,
            tokenCostEnabled: false,

            // Actions
            setConnected: (connected) => {
                // Clear reloading state when we reconnect
                if (connected) {
                    set({ isConnected: connected, isServerReloading: false });
                } else {
                    set({ isConnected: connected });
                }
            },

            setServerReloading: (reloading) => set({ isServerReloading: reloading }),

            setOffline: (offline) => set({ isOffline: offline }),
            setErrorNotification: (message, code) => set({ errorNotification: { message, code, timestamp: new Date() } }),
            clearErrorNotification: () => set({ errorNotification: null }),

            selectTask: (id) => {
                const { tasks, lastSelectedTaskByWorkspace, unreadTaskIds } = get();
                if (id) {
                    const task = tasks.get(id);
                    if (task) {
                        const newMap = new Map(lastSelectedTaskByWorkspace);
                        newMap.set(task.workspaceId, id);
                        // Clear unread flag when task is selected
                        if (unreadTaskIds.has(id)) {
                            const newUnread = new Set(unreadTaskIds);
                            newUnread.delete(id);
                            set({ selectedTaskId: id, lastSelectedTaskByWorkspace: newMap, unreadTaskIds: newUnread });
                        } else {
                            set({ selectedTaskId: id, lastSelectedTaskByWorkspace: newMap });
                        }
                        return;
                    }
                }
                set({ selectedTaskId: id });
            },

            setTasks: (tasks) => {
                const { tasks: existingTasks, selectedTaskId } = get();
                const taskMap = new Map<string, Task>();
                const incomingTaskIds = new Set<string>();

                for (const task of tasks) {
                    incomingTaskIds.add(task.id);
                    const existing = existingTasks.get(task.id);

                    // If we have an existing task, compare lastActivity timestamps
                    // to keep the more recent version (prevents state regression)
                    if (existing) {
                        const existingTime = existing.lastActivity?.getTime?.() ?? 0;
                        const incomingTime = task.lastActivity?.getTime?.() ?? 0;

                        // Keep whichever is newer based on lastActivity
                        // If timestamps are equal or incoming has no timestamp, use incoming
                        // (backend is source of truth when timestamps match)
                        if (existingTime > incomingTime) {
                            console.log(`[TaskStore] Keeping existing task ${task.id} (local: ${existingTime}, incoming: ${incomingTime})`);
                            taskMap.set(task.id, existing);
                        } else {
                            // Preserve existing order if incoming task doesn't have one
                            const mergedTask = task.order === undefined && existing.order !== undefined
                                ? { ...task, order: existing.order }
                                : task;
                            taskMap.set(task.id, mergedTask);
                        }
                    } else {
                        taskMap.set(task.id, task);
                    }
                }

                // Clear selectedTaskId if it's no longer in the task list
                const newSelectedId = selectedTaskId && !taskMap.has(selectedTaskId) ? null : selectedTaskId;
                set({ tasks: taskMap, selectedTaskId: newSelectedId });
            },

            addTask: (task) => {
                const { tasks } = get();
                // Create new Map and add/update task
                // (Same logic whether task exists or not)
                const newTasks = new Map(tasks);
                newTasks.set(task.id, task);
                set({ tasks: newTasks });
            },

            updateTask: (task) => {
                const { tasks } = get();
                const existing = tasks.get(task.id);

                // If we have an existing task, check if incoming is actually newer
                // to prevent state regression from out-of-order messages
                if (existing) {
                    const existingTime = existing.lastActivity?.getTime?.() ?? 0;
                    const incomingTime = task.lastActivity?.getTime?.() ?? 0;

                    // Skip update if existing is newer (prevents state regression)
                    if (existingTime > incomingTime) {
                        console.log(`[TaskStore] Skipping older update for task ${task.id} (local: ${existingTime}, incoming: ${incomingTime})`);
                        return;
                    }

                    // Skip update if nothing has meaningfully changed (same timestamp, same state)
                    // This prevents unnecessary re-renders when rapid updates arrive
                    if (existingTime === incomingTime &&
                        existing.state === task.state &&
                        existing.waitingInputType === task.waitingInputType) {
                        return; // No change, skip update
                    }
                }

                // Preserve existing order if incoming task doesn't have one
                const mergedTask = existing && task.order === undefined && existing.order !== undefined
                    ? { ...task, order: existing.order }
                    : task;

                const newTasks = new Map(tasks);
                newTasks.set(task.id, mergedTask);
                set({ tasks: newTasks });
            },

            updateTaskTokenUsage: (taskId, tokenUsage) => {
                const { tasks } = get();
                const task = tasks.get(taskId);
                if (task) {
                    const newTasks = new Map(tasks);
                    newTasks.set(taskId, { ...task, tokenUsage });
                    set({ tasks: newTasks });
                }
            },

            deleteTask: (taskId) => {
                const { tasks, selectedTaskId } = get();
                const newTasks = new Map(tasks);
                newTasks.delete(taskId);
                const newSelectedId = selectedTaskId === taskId ? null : selectedTaskId;
                set({ tasks: newTasks, selectedTaskId: newSelectedId });
            },

            // Archived tasks actions
            setArchivedTasks: (tasks) => set({ archivedTasks: tasks }),
            setShowArchivedTasks: (show) => set({ showArchivedTasks: show }),
            removeArchivedTask: (taskId) => {
                const { archivedTasks } = get();
                set({ archivedTasks: archivedTasks.filter(t => t.id !== taskId) });
            },

            // Workspace actions
            setWorkspaces: (workspaces) => {
                const { expandedWorkspaces: currentExpanded, expandedWorkspacesInitialized, workspaces: existingWorkspaces } = get();

                console.log('[TaskStore] setWorkspaces called:', {
                    incomingCount: workspaces.length,
                    existingWorkspacesCount: existingWorkspaces.length,
                    currentExpandedCount: currentExpanded.size,
                    expandedWorkspacesInitialized,
                    currentExpanded: Array.from(currentExpanded)
                });

                // Deduplicate workspaces by id (keep first occurrence)
                const seenIds = new Set<string>();
                const uniqueWorkspaces = workspaces.filter(w => {
                    if (seenIds.has(w.id)) {
                        console.warn('[TaskStore] Duplicate workspace filtered out:', w.id);
                        return false;
                    }
                    seenIds.add(w.id);
                    return true;
                });

                // Keep existing expanded state, only add new workspaces as expanded
                const newExpanded = new Set(currentExpanded);

                // Default behavior: all workspaces start closed
                // Only auto-expand truly new workspaces added mid-session
                if (existingWorkspaces.length > 0) {
                    console.log('[TaskStore] Mid-session update - only expanding new workspaces');
                    const existingWorkspaceIds = new Set(existingWorkspaces.map(w => w.id));
                    uniqueWorkspaces.forEach(w => {
                        if (!existingWorkspaceIds.has(w.id)) {
                            console.log('[TaskStore] New workspace detected mid-session, expanding:', w.id);
                            newExpanded.add(w.id);
                        }
                    });
                } else if (!expandedWorkspacesInitialized) {
                    // Genuine first run — no persisted expand/collapse state exists yet,
                    // so default to all-expanded.
                    console.log('[TaskStore] First run (no persisted state) - expanding all workspaces');
                    uniqueWorkspaces.forEach(w => newExpanded.add(w.id));
                } else {
                    // Page refresh / reconnect: `workspaces` is transient (not persisted) so
                    // it starts empty, but `expandedWorkspaces` was rehydrated from
                    // localStorage. Respect the user's persisted collapsed state instead of
                    // re-expanding everything (which was wiping minimized workspaces on every reset).
                    console.log('[TaskStore] Reload with persisted state - preserving collapsed workspaces');
                }
                // Remove any workspaces that no longer exist
                const workspaceIds = new Set(uniqueWorkspaces.map(w => w.id));
                for (const id of newExpanded) {
                    if (!workspaceIds.has(id)) {
                        newExpanded.delete(id);
                    }
                }

                console.log('[TaskStore] Final expanded workspaces:', Array.from(newExpanded));
                set({ workspaces: uniqueWorkspaces, expandedWorkspaces: newExpanded, expandedWorkspacesInitialized: true });
            },

            addWorkspace: (workspace) => {
                const { workspaces, expandedWorkspaces } = get();
                // Prevent duplicate workspaces
                if (workspaces.some(w => w.id === workspace.id)) {
                    console.warn('[TaskStore] Workspace already exists:', workspace.id);
                    return;
                }
                const newExpanded = new Set(expandedWorkspaces);
                newExpanded.add(workspace.id);
                set({
                    workspaces: [...workspaces, workspace],
                    expandedWorkspaces: newExpanded
                });
            },

            updateWorkspace: (workspace) => {
                const { workspaces } = get();
                set({ workspaces: workspaces.map(w => w.id === workspace.id ? workspace : w) });
            },

            removeWorkspace: (workspaceId) => {
                const { workspaces, expandedWorkspaces } = get();
                const newExpanded = new Set(expandedWorkspaces);
                newExpanded.delete(workspaceId);
                set({
                    workspaces: workspaces.filter(w => w.id !== workspaceId),
                    expandedWorkspaces: newExpanded
                });
            },

            reorderWorkspaces: (fromIndex, toIndex) => {
                const { workspaces } = get();
                if (fromIndex === toIndex) return;
                if (fromIndex < 0 || fromIndex >= workspaces.length) return;
                if (toIndex < 0 || toIndex >= workspaces.length) return;

                const newWorkspaces = [...workspaces];
                const [removed] = newWorkspaces.splice(fromIndex, 1);
                newWorkspaces.splice(toIndex, 0, removed);
                set({ workspaces: newWorkspaces });
            },

            toggleWorkspaceExpanded: (workspaceId) => {
                const { expandedWorkspaces } = get();
                const newExpanded = new Set(expandedWorkspaces);
                if (newExpanded.has(workspaceId)) {
                    newExpanded.delete(workspaceId);
                } else {
                    newExpanded.add(workspaceId);
                }
                set({ expandedWorkspaces: newExpanded });
            },

            toggleWorktreeGroupCollapsed: (groupId) => {
                const newCollapsed = new Set(get().collapsedWorktreeGroups);
                if (newCollapsed.has(groupId)) {
                    newCollapsed.delete(groupId);
                } else {
                    newCollapsed.add(groupId);
                }
                set({ collapsedWorktreeGroups: newCollapsed });
            },

            setTaskListHeight: (height) => set({ taskListHeight: height }),

            setShowProjectPicker: (show) => set({ showProjectPicker: show }),

            setWorkspaceColumns: (columns) => set({ workspaceColumns: columns }),

            setWorkspaceSortBy: (sortBy) => set({ workspaceSortBy: sortBy }),

            setTaskSortBy: (sortBy) => set({ taskSortBy: sortBy }),

            // Scheduled tasks actions
            setScheduledTasks: (tasks) => {
                const map = new Map<string, ScheduledTask>();
                for (const t of tasks) map.set(t.id, t);
                set({ scheduledTasks: map });
            },
            addScheduledTask: (task) => {
                const { scheduledTasks } = get();
                const next = new Map(scheduledTasks);
                next.set(task.id, task);
                set({ scheduledTasks: next });
            },
            removeScheduledTask: (cronId) => {
                const { scheduledTasks } = get();
                const next = new Map(scheduledTasks);
                next.delete(cronId);
                set({ scheduledTasks: next });
            },
            getScheduledTasksForTask: (taskId) => {
                const { scheduledTasks } = get();
                return Array.from(scheduledTasks.values()).filter(s => s.taskId === taskId);
            },

            // Activity tracking actions
            addActivityEvent: (event, markUnread = true) => {
                const { unreadTaskIds, activityLog } = get();
                // One entry per task - replace existing entry for same taskId
                const filtered = activityLog.filter(e => e.taskId !== event.taskId);
                const newEvent = { ...event, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
                const newLog = [newEvent, ...filtered].slice(0, 50);
                if (markUnread) {
                    const newUnread = new Set(unreadTaskIds);
                    newUnread.add(event.taskId);
                    set({ unreadTaskIds: newUnread, activityLog: newLog });
                } else {
                    set({ activityLog: newLog });
                }
            },
            clearTaskUnread: (taskId) => {
                const { unreadTaskIds } = get();
                if (unreadTaskIds.has(taskId)) {
                    const newUnread = new Set(unreadTaskIds);
                    newUnread.delete(taskId);
                    set({ unreadTaskIds: newUnread });
                }
            },
            clearAllActivityLog: () => set({ activityLog: [], unreadTaskIds: new Set() }),

            // Task reordering within a workspace
            reorderTasks: (workspaceId, fromIndex, toIndex) => {
                const { tasks } = get();
                if (fromIndex === toIndex) return;

                // Get tasks for this workspace, sorted EXACTLY like the display
                // (must match WorkspacePanel's getTasksForWorkspace sorting)
                const workspaceTasks = Array.from(tasks.values())
                    .filter(t => t.workspaceId === workspaceId)
                    .sort((a, b) => {
                        // If both have order, sort by order (ascending)
                        if (a.order !== undefined && b.order !== undefined) {
                            return a.order - b.order;
                        }
                        // If only one has order, it comes first
                        if (a.order !== undefined) return -1;
                        if (b.order !== undefined) return 1;
                        // Neither has order, sort by creation time (newest first)
                        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                    });

                if (fromIndex < 0 || fromIndex >= workspaceTasks.length) return;
                if (toIndex < 0 || toIndex >= workspaceTasks.length) return;

                // Reorder the array
                const [removed] = workspaceTasks.splice(fromIndex, 1);
                workspaceTasks.splice(toIndex, 0, removed);

                // Update order values for all tasks in workspace
                const newTasks = new Map(tasks);
                workspaceTasks.forEach((task, index) => {
                    const updatedTask = { ...task, order: index };
                    newTasks.set(task.id, updatedTask);
                });

                set({ tasks: newTasks });
            },

            // Voice actions
            setVoiceEnabled: (enabled) => set({ voiceEnabled: enabled }),
            setAutoSpeakResponses: (enabled) => set({ autoSpeakResponses: enabled }),
            setVoiceSettings: (settings) => set({
                selectedVoiceName: settings.voiceName,
                voiceRate: settings.rate,
                voicePitch: settings.pitch,
                voiceVolume: settings.volume
            }),
            setElevenLabsVoice: (voiceId, voiceName) => set({
                elevenLabsVoiceId: voiceId,
                elevenLabsVoiceName: voiceName
            }),

            // Global voice mode actions
            setGlobalVoiceEnabled: (enabled) => set({ globalVoiceEnabled: enabled }),
            setFocusedInputId: (id) => set({ focusedInputId: id }),
            appendVoiceTranscript: (transcript) => {
                const { voiceTranscript } = get();
                const newTranscript = voiceTranscript
                    ? voiceTranscript + ' ' + transcript
                    : transcript;
                set({ voiceTranscript: newTranscript });
            },
            setVoiceInterimTranscript: (interim) => set({ voiceInterimTranscript: interim }),
            clearVoiceTranscript: () => set({ voiceTranscript: '', voiceInterimTranscript: '' }),
            consumeVoiceTranscript: () => {
                const { voiceTranscript } = get();
                set({ voiceTranscript: '', voiceInterimTranscript: '' });
                return voiceTranscript;
            },
            setAutoSendSettings: (enabled, delayMs) => set({
                autoSendEnabled: enabled,
                autoSendDelayMs: delayMs
            }),
            setDeepgramApiKey: (key) => {
                set({ deepgramApiKey: key });
                // Sync to backend so mobile clients can access it
                fetch(`${getApiBaseUrl()}/api/config`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deepgramApiKey: key })
                }).catch(err => console.error('[TaskStore] Failed to sync Deepgram key to backend:', err));
            },

            // Supervisor actions
            setTaskSummary: (summary) => {
                const { taskSummaries } = get();
                const newSummaries = new Map(taskSummaries);
                newSummaries.set(summary.taskId, summary);
                set({ taskSummaries: newSummaries });
            },
            clearTaskSummary: (taskId) => {
                const { taskSummaries } = get();
                const newSummaries = new Map(taskSummaries);
                newSummaries.delete(taskId);
                set({ taskSummaries: newSummaries });
            },

            // Chat actions
            addChatMessage: (message) => {
                const { chatMessages } = get();
                // Avoid duplicates by checking if message already exists
                if (!chatMessages.some(m => m.id === message.id)) {
                    set({ chatMessages: [...chatMessages, message] });
                }
            },
            setChatMessages: (messages) => set({ chatMessages: messages }),
            setChatTyping: (isTyping) => set({ chatTyping: isTyping }),
            clearChatMessages: () => set({ chatMessages: [] }),

            // Waiting input actions
            setWaitingInput: (info) => {
                const { waitingInputNotifications } = get();
                const newNotifications = new Map(waitingInputNotifications);
                newNotifications.set(info.taskId, info);
                set({ waitingInputNotifications: newNotifications });
            },
            clearWaitingInput: (taskId) => {
                const { waitingInputNotifications } = get();
                const newNotifications = new Map(waitingInputNotifications);
                newNotifications.delete(taskId);
                set({ waitingInputNotifications: newNotifications });
            },

            // Draft input actions
            setTaskDraftInput: (taskId, input) => {
                const { taskDraftInputs } = get();
                const newDrafts = new Map(taskDraftInputs);
                if (input) {
                    newDrafts.set(taskId, input);
                } else {
                    newDrafts.delete(taskId);
                }
                set({ taskDraftInputs: newDrafts });
            },
            getTaskDraftInput: (taskId) => {
                const { taskDraftInputs } = get();
                return taskDraftInputs.get(taskId) || '';
            },
            clearTaskDraftInput: (taskId) => {
                const { taskDraftInputs } = get();
                const newDrafts = new Map(taskDraftInputs);
                newDrafts.delete(taskId);
                set({ taskDraftInputs: newDrafts });
            },

            // Settings actions
            setAutoFocusOnInput: (enabled) => set({ autoFocusOnInput: enabled }),
            setSupervisorEnabled: (enabled) => set({ supervisorEnabled: enabled }),
            setAiCoreConfigured: (configured) => set({ aiCoreConfigured: configured }),
            setShowSystemStats: (show) => set({ showSystemStats: show }),
            setBrowserNotificationsEnabled: (enabled) => set({ browserNotificationsEnabled: enabled }),
            setNotifyOnCompletion: (enabled) => set({ notifyOnCompletion: enabled }),
            setNotifyOnWaitingInput: (enabled) => set({ notifyOnWaitingInput: enabled }),
            setThinkingSoundEnabled: (enabled) => set({ thinkingSoundEnabled: enabled }),
            setThinkingSoundInterval: (interval) => set({ thinkingSoundInterval: interval }),
            setVoiceSummaryOnCompletion: (enabled) => set({ voiceSummaryOnCompletion: enabled }),
            setVoiceProgressUpdatesEnabled: (enabled) => set({ voiceProgressUpdatesEnabled: enabled }),
            setVoiceProgressUpdateInterval: (interval) => set({ voiceProgressUpdateInterval: interval }),
            setThemePreference: (pref) => set({ themePreference: pref }),
            setTokenCostEnabled: (enabled) => set({ tokenCostEnabled: enabled })
        }),
        {
            name: STORAGE_KEY,
            storage: createJSONStorage(() => localStorage),
            // Only persist UI preferences and settings, not transient state
            partialize: (state): PersistedState => ({
                selectedTaskId: state.selectedTaskId,
                showArchivedTasks: state.showArchivedTasks,
                expandedWorkspaces: Array.from(state.expandedWorkspaces),
                expandedWorkspacesInitialized: state.expandedWorkspacesInitialized,
                collapsedWorktreeGroups: Array.from(state.collapsedWorktreeGroups),
                taskListHeight: state.taskListHeight,
                workspaceColumns: state.workspaceColumns,
                workspaceSortBy: state.workspaceSortBy,
                taskSortBy: state.taskSortBy,
                voiceEnabled: state.voiceEnabled,
                autoSpeakResponses: state.autoSpeakResponses,
                selectedVoiceName: state.selectedVoiceName,
                voiceRate: state.voiceRate,
                voicePitch: state.voicePitch,
                voiceVolume: state.voiceVolume,
                elevenLabsVoiceId: state.elevenLabsVoiceId,
                elevenLabsVoiceName: state.elevenLabsVoiceName,
                globalVoiceEnabled: state.globalVoiceEnabled,
                autoSendEnabled: state.autoSendEnabled,
                autoSendDelayMs: state.autoSendDelayMs,
                deepgramApiKey: state.deepgramApiKey,
                autoFocusOnInput: state.autoFocusOnInput,
                supervisorEnabled: state.supervisorEnabled,
                showSystemStats: state.showSystemStats,
                browserNotificationsEnabled: state.browserNotificationsEnabled,
                notifyOnCompletion: state.notifyOnCompletion,
                notifyOnWaitingInput: state.notifyOnWaitingInput,
                thinkingSoundEnabled: state.thinkingSoundEnabled,
                thinkingSoundInterval: state.thinkingSoundInterval,
                voiceSummaryOnCompletion: state.voiceSummaryOnCompletion,
                voiceProgressUpdatesEnabled: state.voiceProgressUpdatesEnabled,
                voiceProgressUpdateInterval: state.voiceProgressUpdateInterval,
                themePreference: state.themePreference,
                tokenCostEnabled: state.tokenCostEnabled,
                taskSummaries: Array.from(state.taskSummaries.entries()),
                chatMessages: state.chatMessages,
            }),
            // Merge persisted state with initial state, converting arrays back to Set/Map
            merge: (persistedState, currentState) => {
                const persisted = persistedState as PersistedState | undefined;
                if (!persisted) {
                    console.log('[TaskStore] No persisted state found, using defaults');
                    return currentState;
                }

                console.log('[TaskStore] Merging persisted state:', {
                    expandedWorkspaces: persisted.expandedWorkspaces,
                    expandedWorkspacesInitialized: persisted.expandedWorkspacesInitialized
                });

                return {
                    ...currentState,
                    selectedTaskId: persisted.selectedTaskId ?? currentState.selectedTaskId,
                    showArchivedTasks: persisted.showArchivedTasks ?? currentState.showArchivedTasks,
                    expandedWorkspaces: persisted.expandedWorkspaces
                        ? new Set(persisted.expandedWorkspaces)
                        : currentState.expandedWorkspaces,
                    // Use persisted initialized flag, or mark as initialized if we have any persisted expanded state
                    expandedWorkspacesInitialized: persisted.expandedWorkspacesInitialized ??
                        (persisted.expandedWorkspaces !== undefined),
                    collapsedWorktreeGroups: persisted.collapsedWorktreeGroups
                        ? new Set(persisted.collapsedWorktreeGroups)
                        : currentState.collapsedWorktreeGroups,
                    taskListHeight: persisted.taskListHeight ?? currentState.taskListHeight,
                    workspaceColumns: persisted.workspaceColumns ?? currentState.workspaceColumns,
                    workspaceSortBy: persisted.workspaceSortBy ?? currentState.workspaceSortBy,
                    taskSortBy: persisted.taskSortBy ?? currentState.taskSortBy,
                    voiceEnabled: persisted.voiceEnabled ?? currentState.voiceEnabled,
                    autoSpeakResponses: persisted.autoSpeakResponses ?? currentState.autoSpeakResponses,
                    selectedVoiceName: persisted.selectedVoiceName ?? currentState.selectedVoiceName,
                    voiceRate: persisted.voiceRate ?? currentState.voiceRate,
                    voicePitch: persisted.voicePitch ?? currentState.voicePitch,
                    voiceVolume: persisted.voiceVolume ?? currentState.voiceVolume,
                    elevenLabsVoiceId: persisted.elevenLabsVoiceId ?? currentState.elevenLabsVoiceId,
                    elevenLabsVoiceName: persisted.elevenLabsVoiceName ?? currentState.elevenLabsVoiceName,
                    globalVoiceEnabled: persisted.globalVoiceEnabled ?? currentState.globalVoiceEnabled,
                    autoSendEnabled: persisted.autoSendEnabled ?? currentState.autoSendEnabled,
                    autoSendDelayMs: persisted.autoSendDelayMs ?? currentState.autoSendDelayMs,
                    deepgramApiKey: persisted.deepgramApiKey ?? currentState.deepgramApiKey,
                    autoFocusOnInput: persisted.autoFocusOnInput ?? currentState.autoFocusOnInput,
                    supervisorEnabled: persisted.supervisorEnabled ?? currentState.supervisorEnabled,
                    showSystemStats: persisted.showSystemStats ?? currentState.showSystemStats,
                    browserNotificationsEnabled: persisted.browserNotificationsEnabled ?? currentState.browserNotificationsEnabled,
                    notifyOnCompletion: persisted.notifyOnCompletion ?? currentState.notifyOnCompletion,
                    notifyOnWaitingInput: persisted.notifyOnWaitingInput ?? currentState.notifyOnWaitingInput,
                    thinkingSoundEnabled: persisted.thinkingSoundEnabled ?? currentState.thinkingSoundEnabled,
                    thinkingSoundInterval: persisted.thinkingSoundInterval ?? currentState.thinkingSoundInterval,
                    voiceSummaryOnCompletion: persisted.voiceSummaryOnCompletion ?? currentState.voiceSummaryOnCompletion,
                    voiceProgressUpdatesEnabled: persisted.voiceProgressUpdatesEnabled ?? currentState.voiceProgressUpdatesEnabled,
                    voiceProgressUpdateInterval: persisted.voiceProgressUpdateInterval ?? currentState.voiceProgressUpdateInterval,
                    themePreference: persisted.themePreference ?? currentState.themePreference,
                    tokenCostEnabled: persisted.tokenCostEnabled ?? currentState.tokenCostEnabled,
                    taskSummaries: persisted.taskSummaries
                        ? new Map(persisted.taskSummaries)
                        : currentState.taskSummaries,
                    chatMessages: persisted.chatMessages ?? currentState.chatMessages,
                };
            },
        }
    )
);
