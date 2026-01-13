import { useEffect, useRef, useCallback } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { WSMessage, Task, ChatMessage, ConversationSummary, Plan, ImageAttachment, Workspace, WorkspaceProject } from '@claudia/shared';
import { getWebSocketUrl } from '../config/api-config';

const WS_URL = getWebSocketUrl();

export function useWebSocket() {
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<number>();
    const originalMessageRef = useRef<string | null>(null);

    const {
        setConnected,
        setTasks,
        addTask,
        updateTask,
        deleteTask,
        clearTasks,
        appendOutput,
        addChatMessage,
        clearChatMessages,
        showConversationSelection,
        setThinking,
        setPlan,
        updatePlanStatus,
        setCurrentProject,
        setWorkspaces,
        addWorkspace,
        removeWorkspace,
        addProjectToWorkspaceState,
        removeProjectFromWorkspaceState,
        setActiveWorkspaceId
    } = useTaskStore();

    const connect = useCallback(() => {
        // Check for both OPEN and CONNECTING states to prevent duplicate connections in StrictMode
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
            // Reconnect after 2 seconds
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
                            tasks: Task[],
                            currentProject?: string | null,
                            workspaces?: Workspace[],
                            activeWorkspaceId?: string | null
                        };
                        setTasks(payload.tasks);
                        if (payload.currentProject !== undefined) {
                            setCurrentProject(payload.currentProject);
                        }
                        if (payload.workspaces) {
                            setWorkspaces(payload.workspaces);
                        }
                        if (payload.activeWorkspaceId !== undefined) {
                            setActiveWorkspaceId(payload.activeWorkspaceId);
                        }
                        break;
                    }
                    case 'task:created': {
                        const payload = message.payload as { task: Task };
                        addTask(payload.task);
                        break;
                    }
                    case 'task:updated':
                    case 'task:complete': {
                        const payload = message.payload as { task: Task };
                        updateTask(payload.task);
                        break;
                    }
                    case 'task:output': {
                        const payload = message.payload as { taskId: string; data: string };
                        appendOutput(payload.taskId, payload.data);
                        break;
                    }
                    case 'chat:message': {
                        const payload = message.payload as { message: ChatMessage };
                        addChatMessage(payload.message);
                        // Stop thinking when we get a response from assistant
                        if (payload.message.role === 'assistant') {
                            setThinking(false);
                        }
                        break;
                    }
                    case 'conversation:select': {
                        const payload = message.payload as {
                            candidates: ConversationSummary[];
                            originalMessage: string
                        };
                        originalMessageRef.current = payload.originalMessage;
                        showConversationSelection(payload.candidates, payload.originalMessage);
                        break;
                    }
                    case 'task:deleted': {
                        const payload = message.payload as { taskId: string };
                        deleteTask(payload.taskId);
                        break;
                    }
                    case 'task:cleared': {
                        clearTasks();
                        break;
                    }
                    case 'chat:cleared': {
                        clearChatMessages();
                        break;
                    }
                    case 'plan:created': {
                        const payload = message.payload as { plan: Plan };
                        setPlan(payload.plan);
                        setThinking(false);
                        break;
                    }
                    case 'plan:approved': {
                        updatePlanStatus('executing');
                        // Clear plan after a short delay to show executing state
                        setTimeout(() => setPlan(null), 1000);
                        break;
                    }
                    case 'plan:rejected': {
                        setPlan(null);
                        break;
                    }
                    case 'project:changed': {
                        const payload = message.payload as { currentProject: string | null };
                        setCurrentProject(payload.currentProject);
                        break;
                    }
                    case 'project:error': {
                        const payload = message.payload as { error: string };
                        alert(`Project error: ${payload.error}`);
                        break;
                    }
                    // Workspace events
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
                    case 'workspace:projectAdded': {
                        const payload = message.payload as { workspaceId: string; project: WorkspaceProject };
                        addProjectToWorkspaceState(payload.workspaceId, payload.project);
                        break;
                    }
                    case 'workspace:projectRemoved': {
                        const payload = message.payload as { workspaceId: string; path: string };
                        removeProjectFromWorkspaceState(payload.workspaceId, payload.path);
                        break;
                    }
                    case 'workspace:setActive': {
                        const payload = message.payload as { workspaceId: string | null };
                        setActiveWorkspaceId(payload.workspaceId);
                        break;
                    }
                }
            } catch (err) {
                console.error('[WebSocket] Error parsing message:', err);
            }
        };

        wsRef.current = ws;
    }, [setConnected, setTasks, addTask, updateTask, deleteTask, clearTasks, appendOutput, addChatMessage, clearChatMessages, showConversationSelection, setThinking, setPlan, updatePlanStatus, setCurrentProject, setWorkspaces, addWorkspace, removeWorkspace, addProjectToWorkspaceState, removeProjectFromWorkspaceState, setActiveWorkspaceId]);

    const sendMessage = useCallback((type: string, payload: unknown) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, payload }));
        }
    }, []);

    const sendChatMessage = useCallback((content: string, images?: ImageAttachment[]) => {
        setThinking(true);
        sendMessage('chat:send', { content, images });
    }, [sendMessage, setThinking]);

    useEffect(() => {
        connect();
        return () => {
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            wsRef.current?.close();
        };
    }, []); // Empty dependency array - only connect once on mount

    const selectConversation = useCallback((conversationId: string | null) => {
        sendMessage('conversation:select', {
            conversationId,
            originalMessage: originalMessageRef.current
        });
        originalMessageRef.current = null;
    }, [sendMessage]);

    const sendDeleteTask = useCallback((taskId: string) => {
        sendMessage('task:delete', { taskId });
    }, [sendMessage]);

    const sendClearTasks = useCallback(() => {
        sendMessage('task:clear', {});
    }, [sendMessage]);

    const sendClearChat = useCallback(() => {
        sendMessage('chat:clear', {});
    }, [sendMessage]);

    const approvePlan = useCallback(() => {
        sendMessage('plan:approve', {});
    }, [sendMessage]);

    const rejectPlan = useCallback(() => {
        sendMessage('plan:reject', {});
    }, [sendMessage]);

    const selectProject = useCallback((path: string) => {
        sendMessage('project:set', { path });
    }, [sendMessage]);

    const sendAutoApproveUpdate = useCallback((enabled: boolean) => {
        sendMessage('config:autoApprove', { enabled });
    }, [sendMessage]);

    // Workspace actions
    const createWorkspace = useCallback((path: string) => {
        sendMessage('workspace:create', { path });
    }, [sendMessage]);

    const deleteWorkspace = useCallback((workspaceId: string) => {
        sendMessage('workspace:delete', { workspaceId });
    }, [sendMessage]);

    const setActiveWorkspace = useCallback((workspaceId: string) => {
        sendMessage('workspace:setActive', { workspaceId });
    }, [sendMessage]);

    const sendTaskInput = useCallback((taskId: string, input: string) => {
        sendMessage('task:input', { taskId, input });
    }, [sendMessage]);

    const sendStopTask = useCallback((taskId: string) => {
        sendMessage('task:stop', { taskId });
    }, [sendMessage]);

    const createTask = useCallback((name: string, description: string, workspaceId: string) => {
        sendMessage('task:create', { name, description, workspaceId });
    }, [sendMessage]);

    return {
        sendChatMessage,
        selectConversation,
        sendDeleteTask,
        sendClearTasks,
        sendClearChat,
        approvePlan,
        rejectPlan,
        selectProject,
        sendAutoApproveUpdate,
        createWorkspace,
        deleteWorkspace,
        setActiveWorkspace,
        sendTaskInput,
        sendStopTask,
        createTask
    };
}
