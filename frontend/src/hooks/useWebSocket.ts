import { useEffect, useRef, useCallback } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { WSMessage, WSErrorPayload, Task, Workspace, TaskSummary, SuggestedAction, ChatMessage, WaitingInputType } from '@claudia/shared';
import { getWebSocketUrl, getApiBaseUrl, isTunnelAccess } from '../config/api-config';
import { playTaskCompletionSound, sendTaskCompletionNotification, sendTaskWaitingInputNotification } from '../utils/browserCapabilities';

const WS_URL = getWebSocketUrl();
const API_URL = getApiBaseUrl();

/**
 * Module-level singleton reference to the active WebSocket.
 * Used by sendWsMessage() so components can send messages without
 * instantiating a second useWebSocket hook (which would create a
 * second connection and disconnect on unmount).
 */
let _activeWs: WebSocket | null = null;

/**
 * Send a WebSocket message from any component without needing to call
 * useWebSocket() (which creates a new connection with a destructive cleanup).
 */
export function sendWsMessage(type: string, payload: unknown): void {
    if (_activeWs?.readyState === WebSocket.OPEN) {
        if (type !== 'task:input' && type !== 'task:resize' && type !== 'shell:input' && type !== 'shell:resize') {
            console.log(`[WebSocket] Sending (singleton): ${type}`, payload);
        }
        _activeWs.send(JSON.stringify({ type, payload }));
    } else {
        console.warn(`[WebSocket] sendWsMessage: cannot send ${type} - WS not open (state: ${_activeWs?.readyState})`);
    }
}

/** Base delay for reconnection in ms */
const RECONNECT_BASE_DELAY = 1000;
/** Maximum reconnection delay in ms */
const RECONNECT_MAX_DELAY = 30000;

/**
 * Warm up the tunnel connection before attempting WebSocket.
 * Makes an HTTP request to the backend first to ensure the tunnel is
 * responsive and any proxy layers have been initialized.
 * Returns true if warmup succeeded, false otherwise.
 */
async function warmUpTunnel(): Promise<boolean> {
    if (!isTunnelAccess()) return true; // no warmup needed for local connections

    try {
        console.log('[WebSocket] 🌐 Tunnel detected, warming up HTTP connection first...');
        console.log('[WebSocket] Fetching:', `${API_URL}/api/tunnel/status`);
        const res = await fetch(`${API_URL}/api/tunnel/status`, {
            credentials: 'include', // Ensure cookies are sent/received
        });
        console.log('[WebSocket] Warmup fetch response status:', res.status, res.statusText);
        if (res.ok) {
            console.log('[WebSocket] ✓ Tunnel warmup succeeded');
            return true;
        }
        console.warn('[WebSocket] ⚠️ Tunnel warmup returned non-OK status:', res.status);
        return false;
    } catch (err) {
        console.warn('[WebSocket] ❌ Tunnel warmup failed with error:', err);
        return false;
    }
}

// Note: Polling removed for performance - WebSocket handles all state updates reliably

export function useWebSocket() {
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number>();
    /** Track reconnection attempts for exponential backoff */
    const reconnectAttempts = useRef<number>(0);
    /** Track previous task states to detect busy→idle transitions */
    const taskStatesRef = useRef<Map<string, string>>(new Map());
    /** Flag to skip sound on initial load */
    const initializedRef = useRef<boolean>(false);

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
        updateWorkspace,
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

    const connect = useCallback(async () => {
        const currentState = wsRef.current?.readyState;
        console.log(`[WebSocket] connect() called - current state: ${currentState}, isTunnel: ${isTunnelAccess()}`);

        if (wsRef.current?.readyState === WebSocket.OPEN ||
            wsRef.current?.readyState === WebSocket.CONNECTING) {
            console.log('[WebSocket] Skipping connect - already OPEN or CONNECTING');
            return;
        }

        // For tunnel connections, warm up with HTTP first to ensure
        // the tunnel proxy is responsive before attempting WebSocket
        if (isTunnelAccess()) {
            console.log('[WebSocket] Tunnel detected - starting warmup...');
            const warmupOk = await warmUpTunnel();
            if (!warmupOk) {
                console.warn('[WebSocket] ❌ Tunnel warmup FAILED - scheduling retry in 2s...');
                reconnectTimeoutRef.current = window.setTimeout(connect, 2000);
                return;
            }
            console.log('[WebSocket] ✓ Tunnel warmup SUCCESS - proceeding with WebSocket...');
        }

        console.log('[WebSocket] Creating WebSocket connection to:', WS_URL);
        const ws = new WebSocket(WS_URL);
        console.log('[WebSocket] WebSocket object created, readyState:', ws.readyState);

        ws.onopen = () => {
            console.log('[WebSocket] ✓✓✓ CONNECTION OPENED SUCCESSFULLY ✓✓✓');
            _activeWs = ws;
            setConnected(true);
            // Reset reconnection attempts on successful connection
            reconnectAttempts.current = 0;
        };

        ws.onclose = (event) => {
            console.log(`[WebSocket] ❌ DISCONNECTED - code: ${event.code}, reason: ${event.reason || 'none'}, wasClean: ${event.wasClean}`);
            if (_activeWs === ws) _activeWs = null;
            setConnected(false);
            // Exponential backoff: delay = min(base * 2^attempts, max)
            const delay = Math.min(
                RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts.current),
                RECONNECT_MAX_DELAY
            );
            console.log(`[WebSocket] ⏱️ Scheduling reconnect in ${delay}ms (attempt ${reconnectAttempts.current + 1})`);
            reconnectAttempts.current++;
            reconnectTimeoutRef.current = window.setTimeout(connect, delay);
        };

        ws.onerror = (error) => {
            console.error('[WebSocket] ❌❌❌ ERROR EVENT:', error);
        };

        ws.onmessage = (event) => {
            try {
                const message: WSMessage = JSON.parse(event.data);
                // Skip logging high-frequency messages to reduce console noise
                const msgType = message.type as string;
                if (msgType !== 'task:output' && msgType !== 'shell:output' && msgType !== 'supervisor:chat:typing') {
                    console.log('[WebSocket] Received:', message.type);
                }

                switch (message.type) {
                    case 'init': {
                        console.log('[WebSocket] 🎉 RECEIVED INIT MESSAGE - clearing reload state');
                        const payload = message.payload as {
                            tasks: Task[];
                            workspaces: Workspace[];
                        };
                        setTasks(payload.tasks);
                        if (payload.workspaces) {
                            setWorkspaces(payload.workspaces);
                        }
                        // Seed task states from initial load (so we don't play sounds for existing idle tasks)
                        payload.tasks.forEach((t: Task) => {
                            taskStatesRef.current.set(t.id, t.state);
                        });
                        initializedRef.current = true;
                        // Clear reloading state when we get initialized
                        setServerReloading(false);
                        console.log('[WebSocket] ✓ Init complete - isServerReloading set to FALSE');

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

                                // Sync token cost display setting
                                if (config.tokenCostEnabled !== undefined) {
                                    useTaskStore.getState().setTokenCostEnabled(config.tokenCostEnabled);
                                }

                                // Sync Deepgram API key from backend (for mobile/tunnel clients)
                                if (config.deepgramApiKey && !useTaskStore.getState().deepgramApiKey) {
                                    useTaskStore.setState({ deepgramApiKey: config.deepgramApiKey });
                                }
                            })
                            .catch(err => console.error('Failed to fetch config:', err));

                        // Fetch scheduled tasks
                        fetch(`${API_URL}/api/cron`)
                            .then(r => r.json())
                            .then(tasks => useTaskStore.getState().setScheduledTasks(tasks))
                            .catch(err => console.error('Failed to fetch scheduled tasks:', err));
                        break;
                    }
                    case 'task:created': {
                        const payload = message.payload as { task: Task; source?: string };
                        addTask(payload.task);
                        // Only auto-select tasks created from the UI (not MCP/agent-spawned)
                        if (payload.source !== 'mcp') {
                            selectTask(payload.task.id);
                            // IMPORTANT: Notify server that task is active so it sends the initial prompt
                            sendMessage('task:select', { taskId: payload.task.id });
                        }
                        break;
                    }
                    case 'tasks:updated': {
                        const payload = message.payload as { tasks?: Task[] };
                        if (payload.tasks) {
                            console.log(`[WebSocket] tasks:updated received with ${payload.tasks.length} tasks`);
                            setTasks(payload.tasks);
                        }
                        // Clear reloading state when tasks are updated (e.g. after reconnection)
                        setServerReloading(false);
                        break;
                    }
                    case 'task:destroyed': {
                        const payload = message.payload as { taskId: string };
                        console.log(`[WebSocket] Task destroyed: ${payload.taskId}`);
                        taskStatesRef.current.delete(payload.taskId);
                        deleteTask(payload.taskId);
                        break;
                    }
                    case 'task:deleteRequest': {
                        const payload = message.payload as { requestId: string; tasks: { taskId: string; taskName: string }[] };
                        console.log(`[WebSocket] Delete request from agent: ${payload.tasks.length} task(s)`, payload.requestId);
                        useTaskStore.getState().setPendingDeleteRequest(payload);
                        break;
                    }
                    case 'task:deleteResolved': {
                        const payload = message.payload as {
                            requestId: string;
                            archivedIds: string[];
                            keptIds: string[];
                            failed: { taskId: string; reason: string }[];
                        };
                        console.log(
                            `[WebSocket] Delete resolved: ${payload.archivedIds.length} archived, ` +
                            `${payload.keptIds.length} kept, ${payload.failed.length} failed`, payload.requestId
                        );
                        if (payload.failed.length > 0) {
                            console.error('[WebSocket] Some tasks could not be archived:', payload.failed);
                        }
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
                    case 'tasks:reordered': {
                        const payload = message.payload as { tasks: Task[] };
                        console.log('[WebSocket] Tasks reordered');
                        setTasks(payload.tasks);
                        break;
                    }
                    case 'workspace:updated': {
                        const payload = message.payload as { workspaces?: Workspace[]; workspace?: Workspace };
                        if (payload.workspace) {
                            // Singular update (e.g. autoWorktree toggle)
                            updateWorkspace(payload.workspace);
                        } else if (payload.workspaces) {
                            setWorkspaces(payload.workspaces);
                        }
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

                        // Log to activity feed; only mark unread if not currently viewing
                        {
                            const { tasks, selectedTaskId: sTaskId } = useTaskStore.getState();
                            const task = tasks.get(payload.taskId);
                            const inputLabel = payload.inputType === 'permission' ? 'Needs permission'
                                : payload.inputType === 'question' ? 'Has a question'
                                : 'Needs confirmation';
                            const isViewing = sTaskId === payload.taskId;
                            useTaskStore.getState().addActivityEvent({
                                taskId: payload.taskId,
                                type: 'waiting_input',
                                taskName: task?.displayName || task?.prompt || 'Unknown',
                                message: inputLabel,
                                timestamp: new Date(),
                            }, !isViewing);
                        }

                        // Send browser notification for waiting input
                        {
                            const { browserNotificationsEnabled, notifyOnWaitingInput, tasks, selectedTaskId: currentTaskId } = useTaskStore.getState();
                            if (browserNotificationsEnabled && notifyOnWaitingInput && currentTaskId !== payload.taskId) {
                                const task = tasks.get(payload.taskId);
                                sendTaskWaitingInputNotification({
                                    taskName: task?.displayName || task?.prompt,
                                    recentOutput: payload.recentOutput,
                                    inputType: payload.inputType,
                                    taskId: payload.taskId,
                                });
                            }
                        }

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
                            const previousState = taskStatesRef.current.get(payload.task.id);
                            // Update tracked state
                            taskStatesRef.current.set(payload.task.id, payload.task.state);

                            updateTask(payload.task);
                            // Clear waiting input notification when task becomes busy OR idle
                            // (idle means Claude finished and isn't asking anything)
                            if (payload.task.state === 'busy' || payload.task.state === 'idle') {
                                clearWaitingInput(payload.task.id);
                            }

                            // Play completion sound + browser notification on busy→idle transition
                            if (payload.task.state === 'idle' && previousState === 'busy' && initializedRef.current) {
                                playTaskCompletionSound();
                                const taskName = payload.task.displayName || payload.task.prompt;
                                const taskId = payload.task.id;
                                const { selectedTaskId: currentTaskId } = useTaskStore.getState();
                                const isViewing = currentTaskId === payload.task.id;
                                // Always log to activity feed; only mark unread if not currently viewing
                                useTaskStore.getState().addActivityEvent({
                                    taskId: payload.task.id,
                                    type: 'completed',
                                    taskName,
                                    timestamp: new Date(),
                                }, !isViewing);
                                const { browserNotificationsEnabled, notifyOnCompletion } = useTaskStore.getState();
                                if (browserNotificationsEnabled && notifyOnCompletion && currentTaskId !== payload.task.id) {
                                    // Fetch last Claude message from conversation API for the notification body
                                    fetch(`${API_URL}/api/tasks/${taskId}/conversation`)
                                        .then(res => res.ok ? res.json() : null)
                                        .then(data => {
                                            const messages = data?.messages || [];
                                            const lastAssistant = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
                                            sendTaskCompletionNotification({
                                                taskName,
                                                lastMessage: lastAssistant?.content,
                                                taskId,
                                            });
                                        })
                                        .catch(() => {
                                            sendTaskCompletionNotification({ taskName, taskId });
                                        });
                                }
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
                        console.log('[WebSocket] 🔄 SERVER IS RELOADING - setting isServerReloading=true');
                        setServerReloading(true);
                        break;
                    }
                    case 'server:reconnecting': {
                        const payload = message.payload as { message?: string };
                        console.log('[WebSocket] 🔄 SERVER RECONNECTING TASKS:', payload.message);
                        // Show reconnecting state in UI (reuse reloading state for now)
                        setServerReloading(true);
                        break;
                    }
                    case 'task:tokenUsage': {
                        const payload = message.payload as { taskId: string; tokenUsage: import('@claudia/shared').TaskTokenUsage };
                        useTaskStore.getState().updateTaskTokenUsage(payload.taskId, payload.tokenUsage);
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
                    case 'workspace:resetResult' as string: {
                        const payload = message.payload as {
                            workspaceId: string;
                            archivedCount: number;
                            totalTasks: number;
                            branchCheckout: boolean;
                            checkedOutBranch: string | null;
                            branchError: string | null;
                            isGitRepo: boolean;
                        };
                        console.log('[WebSocket] Workspace reset result:', payload);

                        // Build a user-friendly notification
                        let message_text = `Reset complete: ${payload.archivedCount} task(s) archived.`;
                        if (payload.isGitRepo) {
                            if (payload.branchCheckout && payload.checkedOutBranch) {
                                message_text += ` Switched to branch "${payload.checkedOutBranch}".`;
                            } else if (payload.branchError) {
                                message_text += ` Branch checkout failed: ${payload.branchError}`;
                            }
                        }

                        // Show as error notification if branch checkout failed
                        if (payload.isGitRepo && !payload.branchCheckout) {
                            useTaskStore.getState().setErrorNotification(message_text, 'WORKSPACE_RESET_PARTIAL');
                        }
                        break;
                    }
                    // Scheduled tasks (cron) messages
                    case 'cron:created': {
                        const payload = message.payload as { scheduledTask: any };
                        if (payload.scheduledTask) {
                            useTaskStore.getState().addScheduledTask(payload.scheduledTask);
                        }
                        break;
                    }
                    case 'cron:deleted': {
                        const payload = message.payload as { cronId: string };
                        if (payload.cronId) {
                            useTaskStore.getState().removeScheduledTask(payload.cronId);
                        }
                        break;
                    }
                    case 'cron:updated': {
                        // Refresh all scheduled tasks from backend
                        fetch(`${API_URL}/api/cron`)
                            .then(r => r.json())
                            .then(tasks => useTaskStore.getState().setScheduledTasks(tasks))
                            .catch(err => console.error('[WebSocket] Failed to refresh cron tasks:', err));
                        break;
                    }
                    case 'cron:fired': {
                        const payload = message.payload as { scheduledTaskId: string; taskId: string; prompt: string };
                        console.log(`[WebSocket] Scheduled task fired: ${payload.scheduledTaskId} → task ${payload.taskId}`);
                        break;
                    }
                    case 'tunnel:status': {
                        // Broadcast tunnel status change to App.tsx via a custom DOM event.
                        // The tunnel token may have changed (e.g. after tsx watch reload + adopt),
                        // so the UI needs to refresh its copy of the active state.
                        const payload = message.payload as { active: boolean; url?: string | null; error?: string | null };
                        console.log('[WebSocket] Tunnel status update:', payload.active, payload.url);
                        window.dispatchEvent(new CustomEvent('claudia:tunnelStatus', { detail: payload }));
                        break;
                    }
                    case 'error': {
                        const payload = message.payload as WSErrorPayload;
                        console.error('[WebSocket] Server error:', payload.message, {
                            code: payload.code,
                            originalType: payload.originalType
                        });
                        // Show error notification to the user
                        useTaskStore.getState().setErrorNotification(payload.message, payload.code);
                        break;
                    }
                }
            } catch (err) {
                console.error('[WebSocket] Error parsing message:', err);
            }
        };

        wsRef.current = ws;
    }, [setConnected, setTasks, addTask, updateTask, deleteTask, selectTask, setWorkspaces, addWorkspace, updateWorkspace, removeWorkspace, setTaskSummary, addChatMessage, setChatMessages, setChatTyping, setWaitingInput, clearWaitingInput, setArchivedTasks, removeArchivedTask]);

    const sendMessage = useCallback((type: string, payload: unknown) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            // Skip logging high-frequency messages to reduce console noise
            if (type !== 'task:input' && type !== 'task:resize' && type !== 'shell:input' && type !== 'shell:resize') {
                console.log(`[WebSocket] Sending: ${type}`, payload);
            }
            wsRef.current.send(JSON.stringify({ type, payload }));
        } else {
            console.warn(`[WebSocket] Cannot send ${type}: WebSocket not open (state: ${wsRef.current?.readyState})`);
        }
    }, []);

    useEffect(() => {
        console.log('[WebSocket] 🚀 useEffect mounting - initiating first connection');
        connect();

        // Listen for online/offline events
        const handleOnline = () => {
            console.log('[Network] 📡 Browser is ONLINE - attempting reconnect');
            setOffline(false);
            // Attempt to reconnect when coming back online
            connect();
        };

        const handleOffline = () => {
            console.log('[Network] ❌ Browser is OFFLINE');
            setOffline(true);
        };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        // Handle notification clicks to focus on specific tasks
        const handleNotificationClick = (e: Event) => {
            const taskId = (e as CustomEvent).detail?.taskId;
            if (taskId) {
                selectTask(taskId);
                sendMessage('task:select', { taskId });
                setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('terminal:scrollToBottom', {
                        detail: { taskId }
                    }));
                }, 100);
            }
        };
        window.addEventListener('notification:taskClick', handleNotificationClick);

        return () => {
            console.log('[WebSocket] 🧹 Cleanup - closing connection');
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
            window.removeEventListener('notification:taskClick', handleNotificationClick);
            _activeWs = null;
            wsRef.current?.close();
        };
    }, []);

    // Task actions
    const createTask = useCallback((prompt: string, workspaceId: string, initialCols?: number, initialRows?: number, isolate?: boolean) => {
        sendMessage('task:create', { prompt, workspaceId, initialCols, initialRows, ...(isolate ? { isolate: true } : {}) });
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

    // Answer a bulk delete confirmation. The backend archives `approvedIds` and
    // reports back, so the frontend never has to emit one archive per task.
    const resolveDeleteRequest = useCallback((requestId: string, approvedIds: string[], rejectedIds: string[]) => {
        sendMessage('task:deleteResolved', { requestId, approvedIds, rejectedIds });
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

    const setWorkspaceOrder = useCallback((orderedIds: string[]) => {
        sendMessage('workspace:setOrder', { orderedIds });
    }, [sendMessage]);

    const reorderTasks = useCallback((taskOrders: { taskId: string; order: number }[]) => {
        sendMessage('task:reorder', { taskOrders });
    }, [sendMessage]);

    const openFolder = useCallback((workspaceId: string) => {
        sendMessage('workspace:openFolder', { workspaceId });
    }, [sendMessage]);

    const openTerminal = useCallback((workspaceId: string) => {
        sendMessage('workspace:openTerminal', { workspaceId });
    }, [sendMessage]);

    const setSystemPrompt = useCallback((workspaceId: string, systemPrompt: string) => {
        sendMessage('workspace:systemPrompt:set', { workspaceId, systemPrompt });
    }, [sendMessage]);

    const requestRecentWorkspaces = useCallback(() => {
        sendMessage('workspace:recent:list', {});
    }, [sendMessage]);

    const clearRecentWorkspace = useCallback((workspaceId?: string) => {
        sendMessage('workspace:recent:clear', { workspaceId });
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

    // Git actions
    const pushToGithub = useCallback((workspaceId: string) => {
        sendMessage('git:push', { workspaceId });
    }, [sendMessage]);

    // Workspace reset action
    const resetWorkspace = useCallback((workspaceId: string) => {
        sendMessage('workspace:reset', { workspaceId });
    }, [sendMessage]);

    // Rename actions
    const renameTask = useCallback((taskId: string, displayName: string) => {
        sendMessage('task:rename', { taskId, displayName, source: 'user' });
    }, [sendMessage]);

    const renameWorkspace = useCallback((workspaceId: string, displayName: string) => {
        sendMessage('workspace:rename', { workspaceId, displayName });
    }, [sendMessage]);

    // Workspace reference actions
    const toggleReference = useCallback((workspaceId: string, referencePath: string) => {
        sendMessage('workspace:references:toggle', { workspaceId, referencePath });
    }, [sendMessage]);

    const addCustomReference = useCallback((workspaceId: string, path: string, description?: string) => {
        sendMessage('workspace:references:add', { workspaceId, path, description });
    }, [sendMessage]);

    const removeReference = useCallback((workspaceId: string, referenceId: string) => {
        sendMessage('workspace:references:remove', { workspaceId, referenceId });
    }, [sendMessage]);

    const createScheduledTask = useCallback((taskId: string, cronExpression: string, prompt: string, isRecurring: boolean = true) => {
        sendMessage('cron:create', { taskId, cronExpression, prompt, isRecurring });
    }, [sendMessage]);

    const deleteScheduledTask = useCallback((cronId: string) => {
        sendMessage('cron:delete', { cronId });
    }, [sendMessage]);

    const updateScheduledTask = useCallback((cronId: string, updates: { cronExpression?: string; prompt?: string; isRecurring?: boolean; isPaused?: boolean }) => {
        sendMessage('cron:update', { cronId, ...updates });
    }, [sendMessage]);

    const pauseScheduledTask = useCallback((cronId: string, paused: boolean) => {
        sendMessage('cron:update', { cronId, isPaused: paused });
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
        setWorkspaceOrder,
        reorderTasks,
        openFolder,
        openTerminal,
        setSystemPrompt,
        requestRecentWorkspaces,
        clearRecentWorkspace,
        executeSupervisorAction,
        requestTaskAnalysis,
        sendChatMessage,
        requestChatHistory,
        clearChatHistory,
        requestArchivedTasks,
        restoreArchivedTask,
        deleteArchivedTask,
        continueArchivedTask,
        pushToGithub,
        resetWorkspace,
        renameTask,
        renameWorkspace,
        toggleReference,
        addCustomReference,
        removeReference,
        createScheduledTask,
        deleteScheduledTask,
        updateScheduledTask,
        pauseScheduledTask,
        resolveDeleteRequest,
        wsRef
    };
}
