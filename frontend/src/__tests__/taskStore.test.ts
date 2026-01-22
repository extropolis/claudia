import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskStore } from '../stores/taskStore';
import { Task, Workspace, TaskSummary, ChatMessage } from '@claudia/shared';

describe('taskStore', () => {
    beforeEach(() => {
        // Reset store state before each test
        useTaskStore.setState({
            tasks: new Map(),
            archivedTasks: [],
            showArchivedTasks: false,
            selectedTaskId: null,
            isConnected: false,
            isServerReloading: false,
            isOffline: false,
            workspaces: [],
            expandedWorkspaces: new Set(),
            showProjectPicker: false,
            voiceEnabled: false,
            autoSpeakResponses: false,
            selectedVoiceName: null,
            voiceRate: 1.0,
            voicePitch: 1.0,
            voiceVolume: 1.0,
            globalVoiceEnabled: false,
            focusedInputId: null,
            voiceTranscript: '',
            voiceInterimTranscript: '',
            autoSendEnabled: false,
            autoSendDelayMs: 3000,
            taskSummaries: new Map(),
            chatMessages: [],
            chatTyping: false,
            waitingInputNotifications: new Map(),
            taskDraftInputs: new Map(),
            autoFocusOnInput: false,
            supervisorEnabled: false,
            aiCoreConfigured: null,
            showSystemStats: true,
        });
        // Clear localStorage
        localStorage.clear();
    });

    describe('connection state', () => {
        it('should set connected state', () => {
            useTaskStore.getState().setConnected(true);
            expect(useTaskStore.getState().isConnected).toBe(true);

            useTaskStore.getState().setConnected(false);
            expect(useTaskStore.getState().isConnected).toBe(false);
        });

        it('should clear reloading state when connected', () => {
            useTaskStore.setState({ isServerReloading: true });
            useTaskStore.getState().setConnected(true);

            expect(useTaskStore.getState().isServerReloading).toBe(false);
        });

        it('should set server reloading state', () => {
            useTaskStore.getState().setServerReloading(true);
            expect(useTaskStore.getState().isServerReloading).toBe(true);
        });

        it('should set offline state', () => {
            useTaskStore.getState().setOffline(true);
            expect(useTaskStore.getState().isOffline).toBe(true);
        });
    });

    describe('task management', () => {
        const mockTask: Task = {
            id: 'task-1',
            prompt: 'Test task',
            state: 'idle',
            workspaceId: '/test/workspace',
            createdAt: new Date(),
            lastActivity: new Date(),
        };

        it('should add a task', () => {
            useTaskStore.getState().addTask(mockTask);

            const tasks = useTaskStore.getState().tasks;
            expect(tasks.get('task-1')).toEqual(mockTask);
        });

        it('should set tasks from array', () => {
            const tasks = [
                mockTask,
                { ...mockTask, id: 'task-2', prompt: 'Task 2' },
            ];

            useTaskStore.getState().setTasks(tasks);

            const storedTasks = useTaskStore.getState().tasks;
            expect(storedTasks.size).toBe(2);
            expect(storedTasks.get('task-1')).toBeDefined();
            expect(storedTasks.get('task-2')).toBeDefined();
        });

        it('should update a task', () => {
            useTaskStore.getState().addTask(mockTask);

            const updatedTask = { ...mockTask, state: 'busy' as const };
            useTaskStore.getState().updateTask(updatedTask);

            const task = useTaskStore.getState().tasks.get('task-1');
            expect(task?.state).toBe('busy');
        });

        it('should skip update if state unchanged', () => {
            useTaskStore.getState().addTask(mockTask);
            const originalTasks = useTaskStore.getState().tasks;

            // Update with same values
            useTaskStore.getState().updateTask(mockTask);

            // Should be the same Map reference (no update)
            expect(useTaskStore.getState().tasks).toBe(originalTasks);
        });

        it('should delete a task', () => {
            useTaskStore.getState().addTask(mockTask);
            useTaskStore.getState().deleteTask('task-1');

            expect(useTaskStore.getState().tasks.get('task-1')).toBeUndefined();
        });

        it('should clear selected task when deleted', () => {
            useTaskStore.getState().addTask(mockTask);
            useTaskStore.getState().selectTask('task-1');
            useTaskStore.getState().deleteTask('task-1');

            expect(useTaskStore.getState().selectedTaskId).toBeNull();
        });

        it('should select a task', () => {
            useTaskStore.getState().selectTask('task-1');
            expect(useTaskStore.getState().selectedTaskId).toBe('task-1');
        });

        it('should clear selected task when setTasks removes it', () => {
            useTaskStore.getState().addTask(mockTask);
            useTaskStore.getState().selectTask('task-1');

            // Set new tasks without task-1
            useTaskStore.getState().setTasks([]);

            expect(useTaskStore.getState().selectedTaskId).toBeNull();
        });
    });

    describe('archived tasks', () => {
        const mockArchivedTask: Task = {
            id: 'archived-1',
            prompt: 'Archived task',
            state: 'exited',
            workspaceId: '/test/workspace',
            createdAt: new Date(),
            lastActivity: new Date(),
        };

        it('should set archived tasks', () => {
            useTaskStore.getState().setArchivedTasks([mockArchivedTask]);
            expect(useTaskStore.getState().archivedTasks).toHaveLength(1);
        });

        it('should toggle show archived tasks', () => {
            useTaskStore.getState().setShowArchivedTasks(true);
            expect(useTaskStore.getState().showArchivedTasks).toBe(true);
        });

        it('should remove archived task', () => {
            useTaskStore.getState().setArchivedTasks([mockArchivedTask]);
            useTaskStore.getState().removeArchivedTask('archived-1');
            expect(useTaskStore.getState().archivedTasks).toHaveLength(0);
        });
    });

    describe('workspace management', () => {
        const mockWorkspace: Workspace = {
            id: '/test/workspace',
            name: 'workspace',
            createdAt: new Date().toISOString(),
        };

        it('should set workspaces', () => {
            useTaskStore.getState().setWorkspaces([mockWorkspace]);
            expect(useTaskStore.getState().workspaces).toHaveLength(1);
        });

        it('should expand all workspaces on first load', () => {
            useTaskStore.getState().setWorkspaces([mockWorkspace]);
            expect(useTaskStore.getState().expandedWorkspaces.has('/test/workspace')).toBe(true);
        });

        it('should add workspace', () => {
            useTaskStore.getState().addWorkspace(mockWorkspace);

            expect(useTaskStore.getState().workspaces).toContainEqual(mockWorkspace);
            expect(useTaskStore.getState().expandedWorkspaces.has('/test/workspace')).toBe(true);
        });

        it('should remove workspace', () => {
            useTaskStore.getState().addWorkspace(mockWorkspace);
            useTaskStore.getState().removeWorkspace('/test/workspace');

            expect(useTaskStore.getState().workspaces).toHaveLength(0);
            expect(useTaskStore.getState().expandedWorkspaces.has('/test/workspace')).toBe(false);
        });

        it('should toggle workspace expanded', () => {
            useTaskStore.getState().addWorkspace(mockWorkspace);

            // Initially expanded
            expect(useTaskStore.getState().expandedWorkspaces.has('/test/workspace')).toBe(true);

            // Toggle to collapse
            useTaskStore.getState().toggleWorkspaceExpanded('/test/workspace');
            expect(useTaskStore.getState().expandedWorkspaces.has('/test/workspace')).toBe(false);

            // Toggle to expand
            useTaskStore.getState().toggleWorkspaceExpanded('/test/workspace');
            expect(useTaskStore.getState().expandedWorkspaces.has('/test/workspace')).toBe(true);
        });

        it('should reorder workspaces', () => {
            const workspace2: Workspace = { ...mockWorkspace, id: '/test/workspace2', name: 'workspace2' };
            useTaskStore.getState().setWorkspaces([mockWorkspace, workspace2]);

            useTaskStore.getState().reorderWorkspaces(0, 1);

            const workspaces = useTaskStore.getState().workspaces;
            expect(workspaces[0].id).toBe('/test/workspace2');
            expect(workspaces[1].id).toBe('/test/workspace');
        });

        it('should not reorder if same index', () => {
            useTaskStore.getState().setWorkspaces([mockWorkspace]);
            const originalWorkspaces = useTaskStore.getState().workspaces;

            useTaskStore.getState().reorderWorkspaces(0, 0);

            // No change
            expect(useTaskStore.getState().workspaces).toEqual(originalWorkspaces);
        });

        it('should not reorder if out of bounds', () => {
            useTaskStore.getState().setWorkspaces([mockWorkspace]);

            useTaskStore.getState().reorderWorkspaces(-1, 0);
            useTaskStore.getState().reorderWorkspaces(0, 100);

            // No changes
            expect(useTaskStore.getState().workspaces).toHaveLength(1);
        });

        it('should set show project picker', () => {
            useTaskStore.getState().setShowProjectPicker(true);
            expect(useTaskStore.getState().showProjectPicker).toBe(true);
        });
    });

    describe('voice settings', () => {
        it('should set voice enabled', () => {
            useTaskStore.getState().setVoiceEnabled(true);
            expect(useTaskStore.getState().voiceEnabled).toBe(true);
        });

        it('should set auto speak responses', () => {
            useTaskStore.getState().setAutoSpeakResponses(true);
            expect(useTaskStore.getState().autoSpeakResponses).toBe(true);
        });

        it('should set voice settings', () => {
            useTaskStore.getState().setVoiceSettings({
                voiceName: 'Alex',
                rate: 1.5,
                pitch: 0.8,
                volume: 0.9,
            });

            const state = useTaskStore.getState();
            expect(state.selectedVoiceName).toBe('Alex');
            expect(state.voiceRate).toBe(1.5);
            expect(state.voicePitch).toBe(0.8);
            expect(state.voiceVolume).toBe(0.9);
        });
    });

    describe('global voice mode', () => {
        it('should set global voice enabled', () => {
            useTaskStore.getState().setGlobalVoiceEnabled(true);
            expect(useTaskStore.getState().globalVoiceEnabled).toBe(true);
        });

        it('should set focused input id', () => {
            useTaskStore.getState().setFocusedInputId('input-1');
            expect(useTaskStore.getState().focusedInputId).toBe('input-1');
        });

        it('should append voice transcript', () => {
            useTaskStore.getState().appendVoiceTranscript('Hello');
            expect(useTaskStore.getState().voiceTranscript).toBe('Hello');

            useTaskStore.getState().appendVoiceTranscript('World');
            expect(useTaskStore.getState().voiceTranscript).toBe('Hello World');
        });

        it('should set voice interim transcript', () => {
            useTaskStore.getState().setVoiceInterimTranscript('typing...');
            expect(useTaskStore.getState().voiceInterimTranscript).toBe('typing...');
        });

        it('should clear voice transcript', () => {
            useTaskStore.getState().appendVoiceTranscript('Hello');
            useTaskStore.getState().setVoiceInterimTranscript('typing');

            useTaskStore.getState().clearVoiceTranscript();

            expect(useTaskStore.getState().voiceTranscript).toBe('');
            expect(useTaskStore.getState().voiceInterimTranscript).toBe('');
        });

        it('should consume voice transcript', () => {
            useTaskStore.getState().appendVoiceTranscript('Hello World');

            const transcript = useTaskStore.getState().consumeVoiceTranscript();

            expect(transcript).toBe('Hello World');
            expect(useTaskStore.getState().voiceTranscript).toBe('');
        });

        it('should set auto send settings', () => {
            useTaskStore.getState().setAutoSendSettings(true, 5000);

            expect(useTaskStore.getState().autoSendEnabled).toBe(true);
            expect(useTaskStore.getState().autoSendDelayMs).toBe(5000);
        });
    });

    describe('supervisor', () => {
        const mockSummary: TaskSummary = {
            taskId: 'task-1',
            summary: 'Task completed successfully',
            needsFollowUp: false,
        };

        it('should set task summary', () => {
            useTaskStore.getState().setTaskSummary(mockSummary);

            const summaries = useTaskStore.getState().taskSummaries;
            expect(summaries.get('task-1')).toEqual(mockSummary);
        });

        it('should clear task summary', () => {
            useTaskStore.getState().setTaskSummary(mockSummary);
            useTaskStore.getState().clearTaskSummary('task-1');

            expect(useTaskStore.getState().taskSummaries.get('task-1')).toBeUndefined();
        });
    });

    describe('chat', () => {
        const mockMessage: ChatMessage = {
            id: 'msg-1',
            role: 'user',
            content: 'Hello',
            timestamp: new Date(),
        };

        it('should add chat message', () => {
            useTaskStore.getState().addChatMessage(mockMessage);
            expect(useTaskStore.getState().chatMessages).toContainEqual(mockMessage);
        });

        it('should not add duplicate message', () => {
            useTaskStore.getState().addChatMessage(mockMessage);
            useTaskStore.getState().addChatMessage(mockMessage);

            expect(useTaskStore.getState().chatMessages).toHaveLength(1);
        });

        it('should set chat messages', () => {
            const messages = [mockMessage, { ...mockMessage, id: 'msg-2' }];
            useTaskStore.getState().setChatMessages(messages);

            expect(useTaskStore.getState().chatMessages).toHaveLength(2);
        });

        it('should set chat typing', () => {
            useTaskStore.getState().setChatTyping(true);
            expect(useTaskStore.getState().chatTyping).toBe(true);
        });

        it('should clear chat messages', () => {
            useTaskStore.getState().addChatMessage(mockMessage);
            useTaskStore.getState().clearChatMessages();

            expect(useTaskStore.getState().chatMessages).toHaveLength(0);
        });
    });

    describe('waiting input notifications', () => {
        it('should set waiting input', () => {
            useTaskStore.getState().setWaitingInput({
                taskId: 'task-1',
                inputType: 'question',
                recentOutput: 'What file?',
                timestamp: new Date(),
            });

            const notifications = useTaskStore.getState().waitingInputNotifications;
            expect(notifications.has('task-1')).toBe(true);
        });

        it('should clear waiting input', () => {
            useTaskStore.getState().setWaitingInput({
                taskId: 'task-1',
                inputType: 'question',
                recentOutput: 'What file?',
                timestamp: new Date(),
            });

            useTaskStore.getState().clearWaitingInput('task-1');
            expect(useTaskStore.getState().waitingInputNotifications.has('task-1')).toBe(false);
        });
    });

    describe('draft inputs', () => {
        it('should set task draft input', () => {
            useTaskStore.getState().setTaskDraftInput('task-1', 'my draft');
            expect(useTaskStore.getState().getTaskDraftInput('task-1')).toBe('my draft');
        });

        it('should get empty string for non-existent draft', () => {
            expect(useTaskStore.getState().getTaskDraftInput('non-existent')).toBe('');
        });

        it('should clear task draft input when set to empty', () => {
            useTaskStore.getState().setTaskDraftInput('task-1', 'draft');
            useTaskStore.getState().setTaskDraftInput('task-1', '');

            expect(useTaskStore.getState().taskDraftInputs.has('task-1')).toBe(false);
        });

        it('should clear task draft input', () => {
            useTaskStore.getState().setTaskDraftInput('task-1', 'draft');
            useTaskStore.getState().clearTaskDraftInput('task-1');

            expect(useTaskStore.getState().taskDraftInputs.has('task-1')).toBe(false);
        });
    });

    describe('settings', () => {
        it('should set auto focus on input', () => {
            useTaskStore.getState().setAutoFocusOnInput(true);
            expect(useTaskStore.getState().autoFocusOnInput).toBe(true);
        });

        it('should set supervisor enabled', () => {
            useTaskStore.getState().setSupervisorEnabled(true);
            expect(useTaskStore.getState().supervisorEnabled).toBe(true);
        });

        it('should set AI Core configured', () => {
            useTaskStore.getState().setAiCoreConfigured(true);
            expect(useTaskStore.getState().aiCoreConfigured).toBe(true);
        });

        it('should set show system stats', () => {
            useTaskStore.getState().setShowSystemStats(false);
            expect(useTaskStore.getState().showSystemStats).toBe(false);
        });
    });
});
