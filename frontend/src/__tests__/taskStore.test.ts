import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskStore } from '../stores/taskStore';
import { Task, Workspace, TaskSummary } from '@claudia/shared';

describe('taskStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    // Must match ALL fields from the store's initial state exactly
    useTaskStore.setState({
      tasks: new Map(),
      archivedTasks: [],
      showArchivedTasks: false,
      selectedTaskId: null,
      isConnected: false,
      isServerReloading: false,
      isOffline: false,
      errorNotification: null,
      workspaces: [],
      expandedWorkspaces: new Set(),
      expandedWorkspacesInitialized: false,
      showProjectPicker: false,
      workspaceColumns: 0,
      workspaceSortBy: 'date-created',
      taskSortBy: 'date-created',
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
      deepgramApiKey: '',
      taskSummaries: new Map(),
      waitingInputNotifications: new Map(),
      taskDraftInputs: new Map(),
      autoFocusOnInput: false,
      aiCoreConfigured: null,
      showSystemStats: false,
      browserNotificationsEnabled: false,
      notifyOnCompletion: true,
      notifyOnWaitingInput: true,
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
      const tasks = [mockTask, { ...mockTask, id: 'task-2', prompt: 'Task 2' }];

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
      const workspace2: Workspace = {
        ...mockWorkspace,
        id: '/test/workspace2',
        name: 'workspace2',
      };
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
      status: 'completed',
      summary: 'Task completed successfully',
      suggestedActions: [],
      timestamp: new Date(),
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

    it('should set AI Core configured', () => {
      useTaskStore.getState().setAiCoreConfigured(true);
      expect(useTaskStore.getState().aiCoreConfigured).toBe(true);
    });

    it('should set show system stats', () => {
      useTaskStore.getState().setShowSystemStats(true);
      expect(useTaskStore.getState().showSystemStats).toBe(true);

      useTaskStore.getState().setShowSystemStats(false);
      expect(useTaskStore.getState().showSystemStats).toBe(false);
    });

    it('should set browser notifications enabled', () => {
      useTaskStore.getState().setBrowserNotificationsEnabled(true);
      expect(useTaskStore.getState().browserNotificationsEnabled).toBe(true);

      useTaskStore.getState().setBrowserNotificationsEnabled(false);
      expect(useTaskStore.getState().browserNotificationsEnabled).toBe(false);
    });

    it('should set notify on completion', () => {
      // Default is true
      expect(useTaskStore.getState().notifyOnCompletion).toBe(true);

      useTaskStore.getState().setNotifyOnCompletion(false);
      expect(useTaskStore.getState().notifyOnCompletion).toBe(false);
    });

    it('should set notify on waiting input', () => {
      // Default is true
      expect(useTaskStore.getState().notifyOnWaitingInput).toBe(true);

      useTaskStore.getState().setNotifyOnWaitingInput(false);
      expect(useTaskStore.getState().notifyOnWaitingInput).toBe(false);
    });
  });

  describe('error notifications', () => {
    it('should set error notification', () => {
      useTaskStore.getState().setErrorNotification('Something went wrong', 'ERR_001');

      const notification = useTaskStore.getState().errorNotification;
      expect(notification).not.toBeNull();
      expect(notification!.message).toBe('Something went wrong');
      expect(notification!.code).toBe('ERR_001');
      expect(notification!.timestamp).toBeInstanceOf(Date);
    });

    it('should set error notification without code', () => {
      useTaskStore.getState().setErrorNotification('Connection lost');

      const notification = useTaskStore.getState().errorNotification;
      expect(notification).not.toBeNull();
      expect(notification!.message).toBe('Connection lost');
      expect(notification!.code).toBeUndefined();
    });

    it('should clear error notification', () => {
      useTaskStore.getState().setErrorNotification('Error');
      useTaskStore.getState().clearErrorNotification();

      expect(useTaskStore.getState().errorNotification).toBeNull();
    });
  });

  describe('task reordering within workspace', () => {
    const now = new Date();
    const tasks: Task[] = [
      {
        id: 'task-a',
        prompt: 'Task A',
        state: 'idle',
        workspaceId: '/ws1',
        createdAt: new Date(now.getTime() - 3000),
        lastActivity: now,
      },
      {
        id: 'task-b',
        prompt: 'Task B',
        state: 'idle',
        workspaceId: '/ws1',
        createdAt: new Date(now.getTime() - 2000),
        lastActivity: now,
      },
      {
        id: 'task-c',
        prompt: 'Task C',
        state: 'idle',
        workspaceId: '/ws1',
        createdAt: new Date(now.getTime() - 1000),
        lastActivity: now,
      },
      {
        id: 'task-d',
        prompt: 'Task D',
        state: 'idle',
        workspaceId: '/ws2',
        createdAt: now,
        lastActivity: now,
      },
    ];

    beforeEach(() => {
      for (const task of tasks) {
        useTaskStore.getState().addTask(task);
      }
    });

    it('should reorder tasks within a workspace', () => {
      // Reorder first task to last position in /ws1
      useTaskStore.getState().reorderTasks('/ws1', 0, 2);

      const storedTasks = useTaskStore.getState().tasks;
      // All tasks should have order fields after reorder
      const ws1Tasks = Array.from(storedTasks.values())
        .filter((t) => t.workspaceId === '/ws1')
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

      expect(ws1Tasks).toHaveLength(3);
      // After reorder, order fields should be set
      expect(ws1Tasks[0].order).toBe(0);
      expect(ws1Tasks[1].order).toBe(1);
      expect(ws1Tasks[2].order).toBe(2);
    });

    it('should not reorder tasks with same index', () => {
      const before = useTaskStore.getState().tasks;
      useTaskStore.getState().reorderTasks('/ws1', 1, 1);
      // No change expected - same Map reference (early return)
      const after = useTaskStore.getState().tasks;
      expect(after).toBe(before);
    });

    it('should not reorder tasks with out of bounds index', () => {
      useTaskStore.getState().reorderTasks('/ws1', -1, 0);
      // Should not throw, just return
      expect(useTaskStore.getState().tasks.size).toBe(4);
    });

    it('should not affect tasks in other workspaces', () => {
      useTaskStore.getState().reorderTasks('/ws1', 0, 2);

      const ws2Task = useTaskStore.getState().tasks.get('task-d');
      expect(ws2Task?.workspaceId).toBe('/ws2');
      // task-d should not have an order field set by the reorder
      expect(ws2Task?.order).toBeUndefined();
    });
  });

  describe('workspace deduplication', () => {
    it('should deduplicate workspaces with same id', () => {
      const ws1: Workspace = { id: '/ws1', name: 'ws1', createdAt: new Date().toISOString() };
      const ws1Dup: Workspace = {
        id: '/ws1',
        name: 'ws1-duplicate',
        createdAt: new Date().toISOString(),
      };

      useTaskStore.getState().setWorkspaces([ws1, ws1Dup]);

      expect(useTaskStore.getState().workspaces).toHaveLength(1);
      expect(useTaskStore.getState().workspaces[0].name).toBe('ws1');
    });

    it('should not add duplicate workspace via addWorkspace', () => {
      const ws: Workspace = { id: '/ws1', name: 'ws1', createdAt: new Date().toISOString() };

      useTaskStore.getState().addWorkspace(ws);
      useTaskStore.getState().addWorkspace(ws);

      expect(useTaskStore.getState().workspaces).toHaveLength(1);
    });
  });

  describe('task state regression prevention', () => {
    it('should keep newer local task over older incoming task in setTasks', () => {
      const newerTime = new Date('2026-03-11T12:00:00Z');
      const olderTime = new Date('2026-03-11T11:00:00Z');

      const localTask: Task = {
        id: 'task-1',
        prompt: 'Test',
        state: 'busy',
        workspaceId: '/ws1',
        createdAt: olderTime,
        lastActivity: newerTime,
      };

      const incomingTask: Task = {
        id: 'task-1',
        prompt: 'Test',
        state: 'idle',
        workspaceId: '/ws1',
        createdAt: olderTime,
        lastActivity: olderTime,
      };

      useTaskStore.getState().addTask(localTask);
      useTaskStore.getState().setTasks([incomingTask]);

      // Should keep the local (newer) task
      const task = useTaskStore.getState().tasks.get('task-1');
      expect(task?.state).toBe('busy');
      expect(task?.lastActivity).toEqual(newerTime);
    });

    it('should skip updateTask if existing task is newer', () => {
      const newerTime = new Date('2026-03-11T12:00:00Z');
      const olderTime = new Date('2026-03-11T11:00:00Z');

      const localTask: Task = {
        id: 'task-1',
        prompt: 'Test',
        state: 'busy',
        workspaceId: '/ws1',
        createdAt: olderTime,
        lastActivity: newerTime,
      };

      const olderUpdate: Task = {
        id: 'task-1',
        prompt: 'Test',
        state: 'idle',
        workspaceId: '/ws1',
        createdAt: olderTime,
        lastActivity: olderTime,
      };

      useTaskStore.getState().addTask(localTask);
      useTaskStore.getState().updateTask(olderUpdate);

      // Should keep the local (newer) task
      const task = useTaskStore.getState().tasks.get('task-1');
      expect(task?.state).toBe('busy');
    });
  });

  describe('deepgram API key', () => {
    it('should set deepgram API key', () => {
      // Note: setDeepgramApiKey also fires a fetch to sync to backend,
      // which will fail in test env (expected, tested for state only)
      useTaskStore.getState().setDeepgramApiKey('test-key-123');
      expect(useTaskStore.getState().deepgramApiKey).toBe('test-key-123');
    });
  });

  describe('task sort options', () => {
    it('should default taskSortBy to date-created', () => {
      expect(useTaskStore.getState().taskSortBy).toBe('date-created');
    });

    it('should set taskSortBy to last-modified', () => {
      useTaskStore.getState().setTaskSortBy('last-modified');
      expect(useTaskStore.getState().taskSortBy).toBe('last-modified');
    });

    it('should set taskSortBy to alphabetical', () => {
      useTaskStore.getState().setTaskSortBy('alphabetical');
      expect(useTaskStore.getState().taskSortBy).toBe('alphabetical');
    });

    it('should set taskSortBy to manual', () => {
      useTaskStore.getState().setTaskSortBy('manual');
      expect(useTaskStore.getState().taskSortBy).toBe('manual');
    });
  });

  describe('workspace sort options', () => {
    it('should default workspaceSortBy to date-created', () => {
      expect(useTaskStore.getState().workspaceSortBy).toBe('date-created');
    });

    it('should set workspaceSortBy to alphabetical', () => {
      useTaskStore.getState().setWorkspaceSortBy('alphabetical');
      expect(useTaskStore.getState().workspaceSortBy).toBe('alphabetical');
    });

    it('should set workspaceSortBy to manual', () => {
      useTaskStore.getState().setWorkspaceSortBy('manual');
      expect(useTaskStore.getState().workspaceSortBy).toBe('manual');
    });

    it('should set workspaceSortBy to last-modified', () => {
      useTaskStore.getState().setWorkspaceSortBy('last-modified');
      expect(useTaskStore.getState().workspaceSortBy).toBe('last-modified');
    });
  });

  describe('workspace columns', () => {
    it('should default workspaceColumns to 0 (auto)', () => {
      expect(useTaskStore.getState().workspaceColumns).toBe(0);
    });

    it('should set workspace columns', () => {
      useTaskStore.getState().setWorkspaceColumns(2);
      expect(useTaskStore.getState().workspaceColumns).toBe(2);

      useTaskStore.getState().setWorkspaceColumns(4);
      expect(useTaskStore.getState().workspaceColumns).toBe(4);
    });
  });

  describe('removed supervisor/chat features', () => {
    it('should not have supervisorEnabled property', () => {
      const state = useTaskStore.getState();
      expect('supervisorEnabled' in state).toBe(false);
    });

    it('should not have chat-related properties', () => {
      const state = useTaskStore.getState();
      expect('chatMessages' in state).toBe(false);
      expect('chatTyping' in state).toBe(false);
    });

    it('should not have chat-related actions', () => {
      const state = useTaskStore.getState();
      expect('addChatMessage' in state).toBe(false);
      expect('setChatMessages' in state).toBe(false);
      expect('setChatTyping' in state).toBe(false);
      expect('clearChatMessages' in state).toBe(false);
    });

    it('should not have setSupervisorEnabled action', () => {
      const state = useTaskStore.getState();
      expect('setSupervisorEnabled' in state).toBe(false);
    });
  });

  describe('task summaries (formerly supervisor)', () => {
    const mockSummary: TaskSummary = {
      taskId: 'task-1',
      status: 'completed',
      summary: 'Task completed successfully',
      suggestedActions: [],
      timestamp: new Date(),
    };

    it('should still support task summaries after supervisor removal', () => {
      useTaskStore.getState().setTaskSummary(mockSummary);
      const summaries = useTaskStore.getState().taskSummaries;
      expect(summaries.get('task-1')).toEqual(mockSummary);
    });

    it('should update an existing task summary', () => {
      useTaskStore.getState().setTaskSummary(mockSummary);

      const updatedSummary: TaskSummary = {
        ...mockSummary,
        status: 'needs_input',
        summary: 'Still working...',
      };
      useTaskStore.getState().setTaskSummary(updatedSummary);

      const summaries = useTaskStore.getState().taskSummaries;
      expect(summaries.get('task-1')?.status).toBe('needs_input');
      expect(summaries.get('task-1')?.summary).toBe('Still working...');
    });

    it('should handle multiple task summaries', () => {
      useTaskStore.getState().setTaskSummary(mockSummary);
      useTaskStore.getState().setTaskSummary({
        ...mockSummary,
        taskId: 'task-2',
        summary: 'Second task',
      });

      const summaries = useTaskStore.getState().taskSummaries;
      expect(summaries.size).toBe(2);
    });
  });
});
