import { create } from 'zustand';
import { Task, ChatMessage, ConversationSummary, Plan, RecentProject, Workspace, WorkspaceProject } from '@claudia/shared';

interface TaskStore {
    // State
    tasks: Map<string, Task>;
    selectedTaskId: string | null;
    chatMessages: ChatMessage[];
    isConnected: boolean;
    isThinking: boolean;

    // Plan mode state
    currentPlan: Plan | null;
    autoApproveEnabled: boolean;

    // Conversation selection state
    conversationCandidates: ConversationSummary[];
    originalMessage: string | null;
    showConversationPicker: boolean;

    // Project state
    currentProject: string | null;
    recentProjects: RecentProject[];
    showProjectPicker: boolean;

    // Workspace state
    workspaces: Workspace[];
    activeWorkspaceId: string | null;
    expandedWorkspaces: Set<string>;
    expandedProjects: Set<string>;
    showAddWorkspaceModal: boolean;
    addProjectToWorkspaceId: string | null; // Which workspace is adding a project

    // Task creation modal state
    showTaskCreateModal: boolean;
    taskCreateWorkspaceId: string | null;

    // Voice mode state
    voiceEnabled: boolean;
    autoSpeakResponses: boolean;
    selectedVoiceName: string | null;
    voiceRate: number;
    voicePitch: number;
    voiceVolume: number;

    // Actions
    setConnected: (connected: boolean) => void;
    selectTask: (id: string | null) => void;
    setTasks: (tasks: Task[]) => void;
    addTask: (task: Task) => void;
    updateTask: (task: Task) => void;
    deleteTask: (taskId: string) => void;
    clearTasks: () => void;
    appendOutput: (taskId: string, data: string) => void;
    addChatMessage: (message: ChatMessage) => void;
    clearChatMessages: () => void;
    setThinking: (thinking: boolean) => void;

    // Plan actions
    setPlan: (plan: Plan | null) => void;
    updatePlanStatus: (status: Plan['status']) => void;
    toggleAutoApprove: () => void;

    // Conversation actions
    showConversationSelection: (candidates: ConversationSummary[], originalMessage: string) => void;
    hideConversationSelection: () => void;

    // Project actions
    setCurrentProject: (path: string | null) => void;
    setRecentProjects: (projects: RecentProject[]) => void;
    setShowProjectPicker: (show: boolean) => void;

    // Workspace actions
    setWorkspaces: (workspaces: Workspace[]) => void;
    addWorkspace: (workspace: Workspace) => void;
    removeWorkspace: (workspaceId: string) => void;
    addProjectToWorkspaceState: (workspaceId: string, project: WorkspaceProject) => void;
    removeProjectFromWorkspaceState: (workspaceId: string, path: string) => void;
    setActiveWorkspaceId: (id: string | null) => void;
    toggleWorkspaceExpanded: (workspaceId: string) => void;
    toggleProjectExpanded: (projectPath: string) => void;
    setShowAddWorkspaceModal: (show: boolean) => void;
    setAddProjectToWorkspaceId: (workspaceId: string | null) => void;

    // Task creation actions
    setShowTaskCreateModal: (show: boolean, workspaceId?: string | null) => void;

    // Voice actions
    setVoiceEnabled: (enabled: boolean) => void;
    setAutoSpeakResponses: (enabled: boolean) => void;
    setVoiceSettings: (settings: { voiceName?: string | null; rate?: number; pitch?: number; volume?: number }) => void;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
    // Initial state
    tasks: new Map(),
    selectedTaskId: null,
    chatMessages: [],
    isConnected: false,
    isThinking: false,
    currentPlan: null,
    autoApproveEnabled: false, // Default: show plans for approval
    conversationCandidates: [],
    originalMessage: null,
    showConversationPicker: false,
    currentProject: null,
    recentProjects: [],
    showProjectPicker: false,

    // Workspace state
    workspaces: [],
    activeWorkspaceId: null,
    expandedWorkspaces: new Set<string>(),
    expandedProjects: new Set<string>(),
    showAddWorkspaceModal: false,
    addProjectToWorkspaceId: null,

    // Task creation modal state
    showTaskCreateModal: false,
    taskCreateWorkspaceId: null,

    // Voice mode state
    voiceEnabled: false,
    autoSpeakResponses: false,
    selectedVoiceName: null,
    voiceRate: 1,
    voicePitch: 1,
    voiceVolume: 1,

    // Actions
    setConnected: (connected) => set({ isConnected: connected }),
    setThinking: (thinking) => set({ isThinking: thinking }),

    selectTask: (id) => set({ selectedTaskId: id }),

    setTasks: (tasks) => {
        const taskMap = new Map<string, Task>();
        for (const task of tasks) {
            taskMap.set(task.id, task);
        }
        set({ tasks: taskMap });
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
        const existing = newTasks.get(task.id);

        if (existing) {
            // Smart merge of output:
            // 1. If we have more output locally (via appendOutput), keep it (real-time updates)
            // 2. If the incoming task is complete/error, trust its output (source of truth)
            // 3. If incoming has more lines, trust it (reconciliation)
            if (task.status !== 'complete' && task.status !== 'error' && existing.output.length > task.output.length) {
                task.output = existing.output;
            }
        }
        newTasks.set(task.id, task);
        set({ tasks: newTasks });
    },

    deleteTask: (taskId) => {
        const { tasks, selectedTaskId } = get();
        const newTasks = new Map(tasks);

        // Delete task and its children recursively
        const deleteRecursive = (id: string) => {
            newTasks.delete(id);
            for (const [childId, task] of newTasks) {
                if (task.parentId === id) {
                    deleteRecursive(childId);
                }
            }
        };
        deleteRecursive(taskId);

        // Clear selection if deleted task was selected
        const newSelectedId = selectedTaskId === taskId ? null : selectedTaskId;
        set({ tasks: newTasks, selectedTaskId: newSelectedId });
    },

    clearTasks: () => {
        set({ tasks: new Map(), selectedTaskId: null });
    },

    appendOutput: (taskId, data) => {
        const { tasks } = get();
        const task = tasks.get(taskId);
        if (!task) return;

        const newTasks = new Map(tasks);
        const updatedTask = { ...task, output: [...task.output, data] };
        newTasks.set(taskId, updatedTask);
        set({ tasks: newTasks });
    },

    addChatMessage: (message) => {
        set((state) => {
            const existingIndex = state.chatMessages.findIndex(m => m.id === message.id);
            if (existingIndex >= 0) {
                // Update existing message
                const newMessages = [...state.chatMessages];
                newMessages[existingIndex] = message;
                return { chatMessages: newMessages };
            } else {
                // Add new message
                return { chatMessages: [...state.chatMessages, message] };
            }
        });
    },

    clearChatMessages: () => {
        set({ chatMessages: [] });
    },

    // Conversation actions
    showConversationSelection: (candidates, originalMessage) => {
        set({
            conversationCandidates: candidates,
            originalMessage,
            showConversationPicker: true
        });
    },

    hideConversationSelection: () => {
        set({
            conversationCandidates: [],
            originalMessage: null,
            showConversationPicker: false
        });
    },

    // Plan actions
    setPlan: (plan) => set({ currentPlan: plan }),

    updatePlanStatus: (status) => {
        const { currentPlan } = get();
        if (currentPlan) {
            set({ currentPlan: { ...currentPlan, status } });
        }
    },

    toggleAutoApprove: () => {
        const { autoApproveEnabled } = get();
        set({ autoApproveEnabled: !autoApproveEnabled });
    },

    // Project actions
    setCurrentProject: (path) => set({ currentProject: path }),
    setRecentProjects: (projects) => set({ recentProjects: projects }),
    setShowProjectPicker: (show) => set({ showProjectPicker: show }),

    // Workspace actions
    setWorkspaces: (workspaces) => {
        // Auto-expand all workspaces on load
        const expandedWorkspaces = new Set(workspaces.map(w => w.id));
        set({ workspaces, expandedWorkspaces });
    },

    addWorkspace: (workspace) => {
        const { workspaces, expandedWorkspaces } = get();
        const newExpanded = new Set(expandedWorkspaces);
        newExpanded.add(workspace.id);
        set({
            workspaces: [...workspaces, workspace],
            expandedWorkspaces: newExpanded,
            activeWorkspaceId: workspace.id
        });
    },

    removeWorkspace: (workspaceId) => {
        const { workspaces, expandedWorkspaces, activeWorkspaceId } = get();
        const newExpanded = new Set(expandedWorkspaces);
        newExpanded.delete(workspaceId);
        const newWorkspaces = workspaces.filter(w => w.id !== workspaceId);
        set({
            workspaces: newWorkspaces,
            expandedWorkspaces: newExpanded,
            activeWorkspaceId: activeWorkspaceId === workspaceId ? (newWorkspaces[0]?.id || null) : activeWorkspaceId
        });
    },

    addProjectToWorkspaceState: (workspaceId, project) => {
        const { workspaces, expandedProjects } = get();
        const newWorkspaces = workspaces.map(w => {
            if (w.id === workspaceId) {
                return { ...w, projects: [...w.projects, project] };
            }
            return w;
        });
        // Auto-expand the new project
        const newExpanded = new Set(expandedProjects);
        newExpanded.add(project.path);
        set({ workspaces: newWorkspaces, expandedProjects: newExpanded });
    },

    removeProjectFromWorkspaceState: (workspaceId, path) => {
        const { workspaces, expandedProjects } = get();
        const newWorkspaces = workspaces.map(w => {
            if (w.id === workspaceId) {
                return { ...w, projects: w.projects.filter(p => p.path !== path) };
            }
            return w;
        });
        const newExpanded = new Set(expandedProjects);
        newExpanded.delete(path);
        set({ workspaces: newWorkspaces, expandedProjects: newExpanded });
    },

    setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),

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

    toggleProjectExpanded: (projectPath) => {
        const { expandedProjects } = get();
        const newExpanded = new Set(expandedProjects);
        if (newExpanded.has(projectPath)) {
            newExpanded.delete(projectPath);
        } else {
            newExpanded.add(projectPath);
        }
        set({ expandedProjects: newExpanded });
    },

    setShowAddWorkspaceModal: (show) => set({ showAddWorkspaceModal: show }),
    setAddProjectToWorkspaceId: (workspaceId) => set({ addProjectToWorkspaceId: workspaceId, showProjectPicker: workspaceId !== null }),

    // Task creation actions
    setShowTaskCreateModal: (show, workspaceId = null) => set({
        showTaskCreateModal: show,
        taskCreateWorkspaceId: show ? workspaceId : null
    }),

    // Voice actions
    setVoiceEnabled: (enabled) => set({ voiceEnabled: enabled }),
    setAutoSpeakResponses: (enabled) => set({ autoSpeakResponses: enabled }),
    setVoiceSettings: (settings) => set({
        selectedVoiceName: settings.voiceName !== undefined ? settings.voiceName : get().selectedVoiceName,
        voiceRate: settings.rate !== undefined ? settings.rate : get().voiceRate,
        voicePitch: settings.pitch !== undefined ? settings.pitch : get().voicePitch,
        voiceVolume: settings.volume !== undefined ? settings.volume : get().voiceVolume
    })
}));
