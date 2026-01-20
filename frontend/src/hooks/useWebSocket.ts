import { useEffect, useRef, useCallback } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { WSMessage, WSErrorPayload, Task, Workspace, TaskSummary, SuggestedAction, ChatMessage, WaitingInputType } from '@claudia/shared';
import { getWebSocketUrl, getApiBaseUrl } from '../config/api-config';

const WS_URL = getWebSocketUrl();
const API_URL = getApiBaseUrl();

/** Base delay for reconnection in ms */
const RECONNECT_BASE_DELAY = 1000;
/** Maximum reconnection delay in ms */
const RECONNECT_MAX_DELAY = 30000;

// Note: Polling removed for performance - WebSocket handles all state updates reliably

export function useWebSocket() {
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number>();
    /** Track reconnection attempts for exponential backoff */
    const reconnectAttempts = useRef<number>(0);

    const {
        setConnected,
        setServerReloading,
        setOffline,
        setTasks,
        addTask,
        updateTask,
        deleteTask,
        selectTask,
        setWorkspaces,
        addWorkspace,
        removeWorkspace,
        setTaskSummary,
        addChatMessage,
        setChatMessages,
        setChatTyping,
        setWaitingInput,
        clearWaitingInput,
        setArchivedTasks,
        removeArchivedTask
    } = useTaskStore();

    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN ||
            wsRef.current?.readyState === WebSocket.CONNECTING) return;

        console.log('[WebSocket] Connecting to', WS_URL);
        const ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log('[WebSocket] Connected');
            setConnected(true);
            // Reset reconnection attempts on successful connection
            reconnectAttempts.current = 0;
        };

        ws.onclose = () => {
            console.log('[WebSocket] Disconnected');
            setConnected(false);
            // Exponential backoff: delay = min(base * 2^attempts, max)
            const delay = Math.min(
                RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts.current),
                RECONNECT_MAX_DELAY
            );
            console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current + 1})`);
            reconnectAttempts.current++;
            reconnectTimeoutRef.current = window.setTimeout(connect, delay);
        };

        ws.onerror = (error) => {
            console.error('[WebSocket] Error:', error);
        };

        ws.onmessage = (event) => {
            try {
                const message: WSMessage = JSON.parse(event.data);
                console.log('[WebSocket] Received:', message.type);

                switch (message.type) {
                    case 'init': {
                        const payload = message.payload as {
                            tasks: Task[];
                            workspaces: Workspace[];
                        };
                        setTasks(payload.tasks);
                        if (payload.workspaces) {
                            setWorkspaces(payload.workspaces);
                        }
                        // Clear reloading state when we get initialized
                        setServerReloading(false);

                        // Fetch config to get settings
                        fetch(`${API_URL}/api/config`)
                            .then(res => res.json())
                            .then(config => {
                                if (config.autoFocusOnInput !== undefined) {
                                    useTaskStore.getState().setAutoFocusOnInput(config.autoFocusOnInput);
                                }
                                if (config.supervisorEnabled !== undefined) {
                                    useTaskStore.getState().setSupervisorEnabled(config.supervisorEnabled);
                                }
                                // Check if AI Core credentials are configured
                                // Prefer env vars (aiCoreConfiguredFromEnv) over config file credentials
                                const aiCoreConfigured = config.aiCoreConfiguredFromEnv || !!(
                                    config.aiCoreCredentials?.clientId &&
                                    config.aiCoreCredentials?.clientSecret &&
                                    config.aiCoreCredentials?.authUrl &&
                                    config.aiCoreCredentials?.baseUrl
                                );
                                useTaskStore.getState().setAiCoreConfigured(aiCoreConfigured);
                            })
                            .catch(err => console.error('Failed to fetch config:', err));
                        break;
                    }
                    case 'task:created': {
                        const payload = message.payload as { task: Task };
                        addTask(payload.task);
                        // Auto-select newly created task
                        selectTask(payload.task.id);
                        break;
                    }
                    case 'tasks:updated': {
                        const payload = message.payload as { tasks?: Task[] };
                        if (payload.tasks) {
                            setTasks(payload.tasks);
                        }
                        // Clear reloading state when tasks are updated (e.g. after reconnection)
                        setServerReloading(false);
                        break;
                    }
                    case 'task:destroyed': {
                        const payload = message.payload as { taskId: string };
                        console.log(`[WebSocket] Task destroyed: ${payload.taskId}`);
                        deleteTask(payload.taskId);
                        break;
                    }
                    case 'workspace:created': {
                        const payload = message.payload as { workspace: Workspace };
                        addWorkspace(payload.workspace);
                        break;
                    }
                    case 'workspace:deleted': {
                        const payload = message.payload as { workspaceId: string };
                        removeWorkspace(payload.workspaceId);
                        break;
                    }
                    case 'workspace:reordered': {
                        const payload = message.payload as { workspaces: Workspace[] };
                        console.log('[WebSocket] Workspaces reordered');
                        setWorkspaces(payload.workspaces);
                        break;
                    }
                    case 'task:summary': {
                        const payload = message.payload as { summary: TaskSummary };
                        console.log('[WebSocket] Task summary received:', payload.summary);
                        setTaskSummary(payload.summary);
                        break;
                    }
                    case 'supervisor:chat:response': {
                        const payload = message.payload as { message: ChatMessage };
                        console.log('[WebSocket] Chat message received:', payload.message.role);
                        addChatMessage(payload.message);
                        break;
                    }
                    case 'supervisor:chat:history': {
                        const payload = message.payload as { messages: ChatMessage[] };
                        console.log('[WebSocket] Chat history received:', payload.messages.length, 'messages');
                        setChatMessages(payload.messages);
                        break;
                    }
                    case 'supervisor:chat:typing': {
                        const payload = message.payload as { isTyping: boolean };
                        setChatTyping(payload.isTyping);
                        break;
                    }
                    case 'task:waitingInput': {
                        const payload = message.payload as {
                            taskId: string;
                            inputType: WaitingInputType;
                            recentOutput: string;
                        };
                        console.log('[WebSocket] Task waiting for input:', payload.taskId, payload.inputType);
                        setWaitingInput({
                            taskId: payload.taskId,
                            inputType: payload.inputType,
                            recentOutput: payload.recentOutput,
                            timestamp: new Date()
                        });

                        // Auto-focus on the task if setting is enabled
                        const { autoFocusOnInput, selectedTaskId } = useTaskStore.getState();
                        if (autoFocusOnInput && selectedTaskId !== payload.taskId) {
                            console.log('[WebSocket] Auto-focusing on task:', payload.taskId);
                            selectTask(payload.taskId);

                            // Dispatch scroll-to-bottom event like handleSelectTask does
                            setTimeout(() => {
                                window.dispatchEvent(new CustomEvent('terminal:scrollToBottom', {
                                    detail: { taskId: payload.taskId }
                                }));
                            }, 100);

                            // Focus the task input bar after a short delay to allow the component to mount
                            setTimeout(() => {
                                window.dispatchEvent(new CustomEvent('taskInput:focus', {
                                    detail: { taskId: payload.taskId }
                                }));
                            }, 150);
                        }
                        break;
                    }
                    case 'task:stateChanged': {
                        const payload = message.payload as { task?: Task; tasks?: Task[] };
                        console.log('[WebSocket] task:stateChanged received:', payload.task?.id, 'state:', payload.task?.state);
                        if (payload.task) {
                            updateTask(payload.task);
                            // Clear waiting input notification when task becomes busy OR idle
                            // (idle means Claude finished and isn't asking anything)
                            if (payload.task.state === 'busy' || payload.task.state === 'idle') {
                                clearWaitingInput(payload.task.id);
                            }

                            // Auto-focus on task when it completes (becomes idle) if setting is enabled
                            // This behaves like clicking on the task - selects it and scrolls to bottom
                            if (payload.task.state === 'idle') {
                                const { autoFocusOnInput, selectedTaskId } = useTaskStore.getState();
                                if (autoFocusOnInput && selectedTaskId !== payload.task.id) {
                                    console.log('[WebSocket] Auto-focusing on completed task:', payload.task.id);
                                    selectTask(payload.task.id);

                                    // Dispatch scroll-to-bottom events like handleSelectTask does
                                    const delays = [100, 300, 600];
                                    delays.forEach(delay => {
                                        setTimeout(() => {
                                            window.dispatchEvent(new CustomEvent('terminal:scrollToBottom', {
                                                detail: { taskId: payload.task!.id }
                                            }));
                                        }, delay);
                                    });

                                    // Focus the task input bar after a short delay to allow the component to mount
                                    setTimeout(() => {
                                        window.dispatchEvent(new CustomEvent('taskInput:focus', {
                                            detail: { taskId: payload.task!.id }
                                        }));
                                    }, 150);
                                }
                            }
                        }
                        if (payload.tasks) {
                            setTasks(payload.tasks);
                        }
                        break;
                    }
                    case 'server:reloading': {
                        console.log('[WebSocket] Server is reloading (hot reload)');
                        setServerReloading(true);
                        break;
                    }
                    case 'server:reconnecting': {
                        const payload = message.payload as { message?: string };
                        console.log('[WebSocket] Server is reconnecting tasks:', payload.message);
                        // Show reconnecting state in UI (reuse reloading state for now)
                        setServerReloading(true);
                        break;
                    }
                    case 'task:archived:list': {
                        const payload = message.payload as { tasks: Task[] };
                        console.log('[WebSocket] Archived tasks received:', payload.tasks.length);
                        setArchivedTasks(payload.tasks);
                        break;
                    }
                    case 'task:archived:restored': {
                        const payload = message.payload as { task: Task };
                        console.log('[WebSocket] Archived task restored:', payload.task.id);
                        removeArchivedTask(payload.task.id);
                        addTask(payload.task);
                        break;
                    }
                    case 'task:archived:deleted': {
                        const payload = message.payload as { taskId: string; success: boolean };
                        console.log('[WebSocket] Archived task deleted:', payload.taskId, payload.success);
                        if (payload.success) {
                            removeArchivedTask(payload.taskId);
                        }
                        break;
                    }
                    case 'task:archived:continued': {
                        const payload = message.payload as { task: Task };
                        console.log('[WebSocket] Archived task continued:', payload.task.id);
                        removeArchivedTask(payload.task.id);
                        addTask(payload.task);
                        selectTask(payload.task.id);
                        break;
                    }
                    case 'error': {
                        const payload = message.payload as WSErrorPayload;
                        console.error('[WebSocket] Server error:', payload.message, {
                            code: payload.code,
                            originalType: payload.originalType
                        });
                        // TODO: Could add a toast notification system here
                        break;
                    }
                }
            } catch (err) {
                console.error('[WebSocket] Error parsing message:', err);
            }
        };

        wsRef.current = ws;
    }, [setConnected, setTasks, addTask, updateTask, deleteTask, selectTask, setWorkspaces, addWorkspace, removeWorkspace, setTaskSummary, addChatMessage, setChatMessages, setChatTyping, setWaitingInput, clearWaitingInput, setArchivedTasks, removeArchivedTask]);

    const sendMessage = useCallback((type: string, payload: unknown) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            console.log(`[WebSocket] Sending: ${type}`, payload);
            wsRef.current.send(JSON.stringify({ type, payload }));
        } else {
            console.warn(`[WebSocket] Cannot send ${type}: WebSocket not open (state: ${wsRef.current?.readyState})`);
        }
    }, []);

    useEffect(() => {
        connect();

        // Listen for online/offline events
        const handleOnline = () => {
            console.log('[Network] Browser is online');
            setOffline(false);
            // Attempt to reconnect when coming back online
            connect();
        };

        const handleOffline = () => {
            console.log('[Network] Browser is offline');
            setOffline(true);
        };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            wsRef.current?.close();
        };
    }, []);

    // Task actions
    const createTask = useCallback((prompt: string, workspaceId: string) => {
        sendMessage('task:create', { prompt, workspaceId });
    }, [sendMessage]);

    const selectTaskOnServer = useCallback((taskId: string) => {
        sendMessage('task:select', { taskId });
    }, [sendMessage]);

    const sendTaskInput = useCallback((taskId: string, input: string) => {
        sendMessage('task:input', { taskId, input });
    }, [sendMessage]);

    const resizeTask = useCallback((taskId: string, cols: number, rows: number) => {
        sendMessage('task:resize', { taskId, cols, rows });
    }, [sendMessage]);

    const destroyTask = useCallback((taskId: string) => {
        sendMessage('task:destroy', { taskId });
    }, [sendMessage]);

    const interruptTask = useCallback((taskId: string) => {
        sendMessage('task:interrupt', { taskId });
    }, [sendMessage]);

    const restoreTask = useCallback((taskId: string) => {
        sendMessage('task:restore', { taskId });
    }, [sendMessage]);

    const reconnectTask = useCallback((taskId: string) => {
        sendMessage('task:reconnect', { taskId });
    }, [sendMessage]);

    const archiveTask = useCallback((taskId: string) => {
        sendMessage('task:archive', { taskId });
    }, [sendMessage]);

    const revertTask = useCallback((taskId: string, cleanUntracked: boolean = false) => {
        sendMessage('task:revert', { taskId, cleanUntracked });
    }, [sendMessage]);

    // Workspace actions
    const createWorkspace = useCallback((path: string) => {
        sendMessage('workspace:create', { path });
    }, [sendMessage]);

    const deleteWorkspace = useCallback((workspaceId: string) => {
        sendMessage('workspace:delete', { workspaceId });
    }, [sendMessage]);

    const reorderWorkspaces = useCallback((fromIndex: number, toIndex: number) => {
        sendMessage('workspace:reorder', { fromIndex, toIndex });
    }, [sendMessage]);

    // Supervisor actions
    const executeSupervisorAction = useCallback((taskId: string, action: SuggestedAction) => {
        sendMessage('supervisor:action', { taskId, action });
    }, [sendMessage]);

    const requestTaskAnalysis = useCallback((taskId: string) => {
        sendMessage('supervisor:analyze', { taskId });
    }, [sendMessage]);

    // Chat actions
    const sendChatMessage = useCallback((content: string, taskId?: string) => {
        sendMessage('supervisor:chat:message', { content, taskId });
    }, [sendMessage]);

    const requestChatHistory = useCallback(() => {
        sendMessage('supervisor:chat:history', {});
    }, [sendMessage]);

    const clearChatHistory = useCallback(() => {
        sendMessage('supervisor:chat:clear', {});
    }, [sendMessage]);

    // Archived task actions
    const requestArchivedTasks = useCallback(() => {
        sendMessage('task:archived:list', {});
    }, [sendMessage]);

    const restoreArchivedTask = useCallback((taskId: string) => {
        sendMessage('task:archived:restore', { taskId });
    }, [sendMessage]);

    const deleteArchivedTask = useCallback((taskId: string) => {
        sendMessage('task:archived:delete', { taskId });
    }, [sendMessage]);

    const continueArchivedTask = useCallback((taskId: string) => {
        sendMessage('task:archived:continue', { taskId });
    }, [sendMessage]);

    return {
        createTask,
        selectTaskOnServer,
        sendTaskInput,
        resizeTask,
        destroyTask,
        interruptTask,
        restoreTask,
        reconnectTask,
        archiveTask,
        revertTask,
        createWorkspace,
        deleteWorkspace,
        reorderWorkspaces,
        executeSupervisorAction,
        requestTaskAnalysis,
        sendChatMessage,
        requestChatHistory,
        clearChatHistory,
        requestArchivedTasks,
        restoreArchivedTask,
        deleteArchivedTask,
        continueArchivedTask,
        wsRef
    };
}
