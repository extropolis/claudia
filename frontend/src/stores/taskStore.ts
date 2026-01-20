import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Task, Workspace, TaskSummary, ChatMessage, WaitingInputType } from '@claudia/shared';

// Info about a task that is waiting for user input
export interface WaitingInputInfo {
    taskId: string;
    inputType: WaitingInputType;
    recentOutput: string;
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
    isConnected: boolean;
    isServerReloading: boolean;  // True when server is restarting (hot reload)
    isOffline: boolean;  // True when browser has no internet connection

    // Workspace state
    workspaces: Workspace[];
    expandedWorkspaces: Set<string>;
    showProjectPicker: boolean;

    // Voice state
    voiceEnabled: boolean;
    autoSpeakResponses: boolean;
    selectedVoiceName: string | null;
    voiceRate: number;
    voicePitch: number;
    voiceVolume: number;

    // Global voice mode state
    globalVoiceEnabled: boolean;
    focusedInputId: string | null;
    voiceTranscript: string;
    voiceInterimTranscript: string;
    autoSendEnabled: boolean;
    autoSendDelayMs: number;

    // Supervisor state
    taskSummaries: Map<string, TaskSummary>;

    // Chat state
    chatMessages: ChatMessage[];
    chatTyping: boolean;

    // Waiting input notifications
    waitingInputNotifications: Map<string, WaitingInputInfo>;

    // Draft input per task (preserved when switching tasks)
    taskDraftInputs: Map<string, string>;

    // Settings
    autoFocusOnInput: boolean;
    supervisorEnabled: boolean;
    aiCoreConfigured: boolean | null; // null = not checked yet, false = not configured, true = configured

    // Actions
    setConnected: (connected: boolean) => void;
    setServerReloading: (reloading: boolean) => void;
    setOffline: (offline: boolean) => void;
    selectTask: (id: string | null) => void;
    setTasks: (tasks: Task[]) => void;
    addTask: (task: Task) => void;
    updateTask: (task: Task) => void;
    deleteTask: (taskId: string) => void;

    // Archived tasks actions
    setArchivedTasks: (tasks: Task[]) => void;
    setShowArchivedTasks: (show: boolean) => void;
    removeArchivedTask: (taskId: string) => void;

    // Workspace actions
    setWorkspaces: (workspaces: Workspace[]) => void;
    addWorkspace: (workspace: Workspace) => void;
    removeWorkspace: (workspaceId: string) => void;
    reorderWorkspaces: (fromIndex: number, toIndex: number) => void;
    toggleWorkspaceExpanded: (workspaceId: string) => void;
    setShowProjectPicker: (show: boolean) => void;

    // Voice actions
    setVoiceEnabled: (enabled: boolean) => void;
    setAutoSpeakResponses: (enabled: boolean) => void;
    setVoiceSettings: (settings: VoiceSettings) => void;

    // Global voice mode actions
    setGlobalVoiceEnabled: (enabled: boolean) => void;
    setFocusedInputId: (id: string | null) => void;
    appendVoiceTranscript: (transcript: string) => void;
    setVoiceInterimTranscript: (interim: string) => void;
    clearVoiceTranscript: () => void;
    consumeVoiceTranscript: () => string;
    setAutoSendSettings: (enabled: boolean, delayMs: number) => void;

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

    // Settings actions
    setAutoFocusOnInput: (enabled: boolean) => void;
    setSupervisorEnabled: (enabled: boolean) => void;
    setAiCoreConfigured: (configured: boolean | null) => void;
}

// Storage key for localStorage
const STORAGE_KEY = 'claudia-task-store';

// State that should be persisted (UI preferences and settings)
interface PersistedState {
    selectedTaskId: string | null;
    showArchivedTasks: boolean;
    expandedWorkspaces: string[];  // Stored as array, converted to Set
    voiceEnabled: boolean;
    autoSpeakResponses: boolean;
    selectedVoiceName: string | null;
    voiceRate: number;
    voicePitch: number;
    voiceVolume: number;
    globalVoiceEnabled: boolean;
    autoSendEnabled: boolean;
    autoSendDelayMs: number;
    autoFocusOnInput: boolean;
    supervisorEnabled: boolean;
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
    isConnected: false,
    isServerReloading: false,
    isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
    workspaces: [],
    expandedWorkspaces: new Set<string>(),
    showProjectPicker: false,

    // Voice initial state
    voiceEnabled: false,
    autoSpeakResponses: false,
    selectedVoiceName: null,
    voiceRate: 1.0,
    voicePitch: 1.0,
    voiceVolume: 1.0,

    // Global voice mode initial state
    globalVoiceEnabled: false,
    focusedInputId: null,
    voiceTranscript: '',
    voiceInterimTranscript: '',
    autoSendEnabled: false,
    autoSendDelayMs: 3000,

    // Supervisor initial state
    taskSummaries: new Map(),

    // Chat initial state
    chatMessages: [],
    chatTyping: false,

    // Waiting input initial state
    waitingInputNotifications: new Map(),

    // Draft input initial state
    taskDraftInputs: new Map(),

    // Settings initial state
    autoFocusOnInput: false,
    supervisorEnabled: false,
    aiCoreConfigured: null,

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

    selectTask: (id) => set({ selectedTaskId: id }),

    setTasks: (tasks) => {
        const taskMap = new Map<string, Task>();
        for (const task of tasks) {
            taskMap.set(task.id, task);
        }
        // Clear selectedTaskId if it's no longer in the task list
        const { selectedTaskId } = get();
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

        // Skip update if task state hasn't meaningfully changed
        // This prevents unnecessary re-renders when rapid updates arrive
        if (existing &&
            existing.state === task.state &&
            existing.waitingInputType === task.waitingInputType &&
            existing.lastActivity?.getTime?.() === task.lastActivity?.getTime?.()) {
            return; // No change, skip update
        }

        const newTasks = new Map(tasks);
        newTasks.set(task.id, task);
        set({ tasks: newTasks });
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
        const { expandedWorkspaces: currentExpanded } = get();
        // Keep existing expanded state, only add new workspaces as expanded
        const newExpanded = new Set(currentExpanded);
        // If this is the first load (no expanded workspaces), expand all
        if (currentExpanded.size === 0) {
            workspaces.forEach(w => newExpanded.add(w.id));
        } else {
            // Add any new workspaces as expanded
            workspaces.forEach(w => {
                if (!currentExpanded.has(w.id)) {
                    newExpanded.add(w.id);
                }
            });
        }
        // Remove any workspaces that no longer exist
        const workspaceIds = new Set(workspaces.map(w => w.id));
        for (const id of newExpanded) {
            if (!workspaceIds.has(id)) {
                newExpanded.delete(id);
            }
        }
        set({ workspaces, expandedWorkspaces: newExpanded });
    },

    addWorkspace: (workspace) => {
        const { workspaces, expandedWorkspaces } = get();
        const newExpanded = new Set(expandedWorkspaces);
        newExpanded.add(workspace.id);
        set({
            workspaces: [...workspaces, workspace],
            expandedWorkspaces: newExpanded
        });
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

    setShowProjectPicker: (show) => set({ showProjectPicker: show }),

    // Voice actions
    setVoiceEnabled: (enabled) => set({ voiceEnabled: enabled }),
    setAutoSpeakResponses: (enabled) => set({ autoSpeakResponses: enabled }),
    setVoiceSettings: (settings) => set({
        selectedVoiceName: settings.voiceName,
        voiceRate: settings.rate,
        voicePitch: settings.pitch,
        voiceVolume: settings.volume
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
    setAiCoreConfigured: (configured) => set({ aiCoreConfigured: configured })
        }),
        {
            name: STORAGE_KEY,
            storage: createJSONStorage(() => localStorage),
            // Only persist UI preferences and settings, not transient state
            partialize: (state): PersistedState => ({
                selectedTaskId: state.selectedTaskId,
                showArchivedTasks: state.showArchivedTasks,
                expandedWorkspaces: Array.from(state.expandedWorkspaces),
                voiceEnabled: state.voiceEnabled,
                autoSpeakResponses: state.autoSpeakResponses,
                selectedVoiceName: state.selectedVoiceName,
                voiceRate: state.voiceRate,
                voicePitch: state.voicePitch,
                voiceVolume: state.voiceVolume,
                globalVoiceEnabled: state.globalVoiceEnabled,
                autoSendEnabled: state.autoSendEnabled,
                autoSendDelayMs: state.autoSendDelayMs,
                autoFocusOnInput: state.autoFocusOnInput,
                supervisorEnabled: state.supervisorEnabled,
                taskSummaries: Array.from(state.taskSummaries.entries()),
                chatMessages: state.chatMessages,
            }),
            // Merge persisted state with initial state, converting arrays back to Set/Map
            merge: (persistedState, currentState) => {
                const persisted = persistedState as PersistedState | undefined;
                if (!persisted) return currentState;

                return {
                    ...currentState,
                    selectedTaskId: persisted.selectedTaskId ?? currentState.selectedTaskId,
                    showArchivedTasks: persisted.showArchivedTasks ?? currentState.showArchivedTasks,
                    expandedWorkspaces: persisted.expandedWorkspaces
                        ? new Set(persisted.expandedWorkspaces)
                        : currentState.expandedWorkspaces,
                    voiceEnabled: persisted.voiceEnabled ?? currentState.voiceEnabled,
                    autoSpeakResponses: persisted.autoSpeakResponses ?? currentState.autoSpeakResponses,
                    selectedVoiceName: persisted.selectedVoiceName ?? currentState.selectedVoiceName,
                    voiceRate: persisted.voiceRate ?? currentState.voiceRate,
                    voicePitch: persisted.voicePitch ?? currentState.voicePitch,
                    voiceVolume: persisted.voiceVolume ?? currentState.voiceVolume,
                    globalVoiceEnabled: persisted.globalVoiceEnabled ?? currentState.globalVoiceEnabled,
                    autoSendEnabled: persisted.autoSendEnabled ?? currentState.autoSendEnabled,
                    autoSendDelayMs: persisted.autoSendDelayMs ?? currentState.autoSendDelayMs,
                    autoFocusOnInput: persisted.autoFocusOnInput ?? currentState.autoFocusOnInput,
                    supervisorEnabled: persisted.supervisorEnabled ?? currentState.supervisorEnabled,
                    taskSummaries: persisted.taskSummaries
                        ? new Map(persisted.taskSummaries)
                        : currentState.taskSummaries,
                    chatMessages: persisted.chatMessages ?? currentState.chatMessages,
                };
            },
        }
    )
);
