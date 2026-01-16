import { create } from 'zustand';
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
    selectedTaskId: string | null;
    isConnected: boolean;
    isServerReloading: boolean;  // True when server is restarting (hot reload)

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

    // Settings
    autoFocusOnInput: boolean;
    supervisorEnabled: boolean;
    aiCoreConfigured: boolean | null; // null = not checked yet, false = not configured, true = configured

    // Actions
    setConnected: (connected: boolean) => void;
    setServerReloading: (reloading: boolean) => void;
    selectTask: (id: string | null) => void;
    setTasks: (tasks: Task[]) => void;
    addTask: (task: Task) => void;
    updateTask: (task: Task) => void;
    deleteTask: (taskId: string) => void;

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

    // Settings actions
    setAutoFocusOnInput: (enabled: boolean) => void;
    setSupervisorEnabled: (enabled: boolean) => void;
    setAiCoreConfigured: (configured: boolean | null) => void;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
    // Initial state
    tasks: new Map(),
    selectedTaskId: null,
    isConnected: false,
    isServerReloading: false,
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
    autoSendDelayMs: 2000,

    // Supervisor initial state
    taskSummaries: new Map(),

    // Chat initial state
    chatMessages: [],
    chatTyping: false,

    // Waiting input initial state
    waitingInputNotifications: new Map(),

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
        const newTasks = new Map(tasks);
        newTasks.set(task.id, task);
        set({ tasks: newTasks });
    },

    updateTask: (task) => {
        const { tasks } = get();
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

    // Workspace actions
    setWorkspaces: (workspaces) => {
        const expandedWorkspaces = new Set(workspaces.map(w => w.id));
        set({ workspaces, expandedWorkspaces });
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

    // Settings actions
    setAutoFocusOnInput: (enabled) => set({ autoFocusOnInput: enabled }),
    setSupervisorEnabled: (enabled) => set({ supervisorEnabled: enabled }),
    setAiCoreConfigured: (configured) => set({ aiCoreConfigured: configured })
}));
