import { useEffect, useRef, useCallback } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { WSMessage, Task, Workspace, TaskState, TaskSummary, SuggestedAction, ChatMessage, WaitingInputType } from '@claudia/shared';
import { getWebSocketUrl, getApiBaseUrl } from '../config/api-config';

const WS_URL = getWebSocketUrl();
const API_URL = getApiBaseUrl();

// Poll interval for task status (ms) - fallback for when hooks don't fire
// Uses faster polling when tasks are busy to quickly detect completion
const STATUS_POLL_INTERVAL_BUSY = 2000;
const STATUS_POLL_INTERVAL_IDLE = 5000;

export function useWebSocket() {
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number>();
    const pollIntervalRef = useRef<number>();

    const {
        setConnected,
        setServerReloading,
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
        clearWaitingInput
    } = useTaskStore();

    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN ||
            wsRef.current?.readyState === WebSocket.CONNECTING) return;

        console.log('[WebSocket] Connecting to', WS_URL);
        const ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log('[WebSocket] Connected');
            setConnected(true);
        };

        ws.onclose = () => {
            console.log('[WebSocket] Disconnected');
            setConnected(false);
            reconnectTimeoutRef.current = window.setTimeout(connect, 2000);
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
                }
            } catch (err) {
                console.error('[WebSocket] Error parsing message:', err);
            }
        };

        wsRef.current = ws;
    }, [setConnected, setTasks, addTask, updateTask, deleteTask, selectTask, setWorkspaces, addWorkspace, removeWorkspace, setTaskSummary, addChatMessage, setChatMessages, setChatTyping, setWaitingInput, clearWaitingInput]);

    const sendMessage = useCallback((type: string, payload: unknown) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            console.log(`[WebSocket] Sending: ${type}`, payload);
            wsRef.current.send(JSON.stringify({ type, payload }));
        } else {
            console.warn(`[WebSocket] Cannot send ${type}: WebSocket not open (state: ${wsRef.current?.readyState})`);
        }
    }, []);

    // Poll task statuses for more reliable state detection
    // Backend uses output-based detection (checking for "ctrl+c to interrupt" etc.)
    const pollTaskStatuses = useCallback(async () => {
        const { tasks } = useTaskStore.getState();
        let hasBusyTasks = false;

        for (const [taskId, task] of tasks) {
            // Only poll active tasks (not disconnected or exited)
            if (task.state === 'disconnected' || task.state === 'exited') continue;

            if (task.state === 'busy') {
                hasBusyTasks = true;
            }

            try {
                const response = await fetch(`${API_URL}/api/tasks/${taskId}/status`);
                if (response.ok) {
                    const status = await response.json();
                    // Update state if server state differs from current
                    if (status.state && status.state !== task.state) {
                        console.log(`[Poll] Task ${taskId} state: ${task.state} -> ${status.state}`);
                        updateTask({ ...task, state: status.state as TaskState });
                    }
                }
            } catch (err) {
                // Ignore polling errors
            }
        }

        // Adjust polling interval based on whether we have busy tasks
        // Poll faster when tasks are busy to quickly detect completion
        const nextInterval = hasBusyTasks ? STATUS_POLL_INTERVAL_BUSY : STATUS_POLL_INTERVAL_IDLE;
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
        }
        pollIntervalRef.current = window.setInterval(pollTaskStatuses, nextInterval);
    }, [updateTask]);

    useEffect(() => {
        connect();

        // Start polling for task statuses (start with faster interval)
        pollIntervalRef.current = window.setInterval(pollTaskStatuses, STATUS_POLL_INTERVAL_BUSY);

        return () => {
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
            }
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
        executeSupervisorAction,
        requestTaskAnalysis,
        sendChatMessage,
        requestChatHistory,
        clearChatHistory,
        wsRef
    };
}
