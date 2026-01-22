#!/usr/bin/env node
/**
 * Non-interactive CLI test tool for the orchestrator
 * Emulates the frontend to test structured output functionality
 */

import WebSocket from 'ws';
import { WSMessage, ChatMessage, Task } from './src/types.js';
import * as fs from 'fs';
import * as path from 'path';

interface TestConfig {
    backendUrl: string;
    testMessage: string;
    timeoutMs: number;
    testClear: boolean;
    createTask: boolean;      // Use task:create instead of chat:send
    taskName: string;         // Name for task creation
    workspaceId: string | null;  // Optional workspace ID
    verbose: boolean;         // Verbose logging of all events
    authCode: string;         // Auth code for the server
    // New operations
    taskInput: boolean;       // Send input to a task
    taskId: string | null;    // Task ID for operations
    stopTask: boolean;        // Stop a running task
    deleteTask: boolean;      // Delete a specific task
    clearTasks: boolean;      // Clear all tasks
    approvePlan: boolean;     // Approve current plan
    rejectPlan: boolean;      // Reject current plan
    autoApprove: boolean | null;  // Toggle auto-approve mode (null = don't set)
    createWorkspace: boolean; // Create a new workspace
    deleteWorkspace: boolean; // Delete a workspace
    setActiveWorkspace: boolean; // Set active workspace
    reorderWorkspaces: boolean; // Reorder workspaces
    reorderFrom: number | null; // From index for reorder
    reorderTo: number | null;   // To index for reorder
    setProject: boolean;      // Set current project path
    projectPath: string | null;  // Project path for project:set
    listTasks: boolean;       // List all tasks
    viewTaskFiles: boolean;   // View code files for a task
    getConfig: boolean;       // Get orchestrator config
    imagePath: string | null; // Path to image to attach
    supervisorChat: boolean;  // Use supervisor chat (supervisor:chat:message)
    // Archived task operations
    listArchivedTasks: boolean;  // List all archived tasks
    restoreArchivedTask: boolean;  // Restore an archived task
    deleteArchivedTask: boolean;   // Delete an archived task permanently
    continueArchivedTask: boolean; // Continue an archived task (restore + reconnect)
    watchTask: boolean;           // Watch task state changes
    archiveTask: boolean;         // Archive a task
    gitPush: boolean;             // Push to GitHub
    backendStatus: boolean;       // Get backend status (no WebSocket needed)
    setBackend: string | null;    // Set backend ('claude-code' or 'opencode')
}

class TestCLI {
    private ws: WebSocket | null = null;
    private config: TestConfig;
    private chatMessages: ChatMessage[] = [];
    private tasks: Map<string, Task> = new Map();
    private archivedTasks: Task[] = [];
    private startTime: number = 0;
    private completionTimer: NodeJS.Timeout | null = null;
    private lastActivityTime: number = 0;

    constructor(config: TestConfig) {
        this.config = config;
    }

    async run(): Promise<void> {
        console.log('🧪 Test CLI - Starting test');
        console.log(`📡 Connecting to: ${this.config.backendUrl}`);
        console.log(`💬 Test message: "${this.config.testMessage}"`);
        console.log('');

        this.startTime = Date.now();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                console.error('❌ Test timed out');
                this.cleanup();
                reject(new Error('Test timeout'));
            }, this.config.timeoutMs);

            this.ws = new WebSocket(this.config.backendUrl);

            this.ws.on('open', async () => {
                console.log('✅ Connected to backend');
                console.log('');

                // Handle different operations based on config
                if (this.config.listTasks) {
                    // Wait for init message to populate tasks, then list them
                    setTimeout(() => {
                        this.listTasks();
                        setTimeout(() => this.cleanup(), 1000);
                    }, 1000);
                } else if (this.config.viewTaskFiles && this.config.taskId) {
                    await this.viewTaskFiles(this.config.taskId);
                    setTimeout(() => this.cleanup(), 1000);
                } else if (this.config.getConfig) {
                    await this.getConfig();
                    setTimeout(() => this.cleanup(), 1000);
                } else if (this.config.taskInput && this.config.taskId) {
                    this.sendTaskInput(this.config.taskId, this.config.testMessage);
                } else if (this.config.stopTask && this.config.taskId) {
                    this.sendStopTask(this.config.taskId);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.deleteTask && this.config.taskId) {
                    this.sendDeleteTask(this.config.taskId);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.clearTasks) {
                    this.sendClearTasks();
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.approvePlan) {
                    this.sendApprovePlan();
                } else if (this.config.rejectPlan) {
                    this.sendRejectPlan();
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.autoApprove !== null) {
                    this.sendAutoApprove(this.config.autoApprove);
                    setTimeout(() => this.cleanup(), 1000);
                } else if (this.config.createWorkspace && this.config.projectPath) {
                    this.sendCreateWorkspace(this.config.projectPath);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.deleteWorkspace && this.config.workspaceId) {
                    this.sendDeleteWorkspace(this.config.workspaceId);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.setActiveWorkspace && this.config.workspaceId) {
                    this.sendSetActiveWorkspace(this.config.workspaceId);
                    setTimeout(() => this.cleanup(), 1000);
                } else if (this.config.reorderWorkspaces && this.config.reorderFrom !== null && this.config.reorderTo !== null) {
                    this.sendReorderWorkspaces(this.config.reorderFrom, this.config.reorderTo);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.setProject && this.config.projectPath) {
                    this.sendSetProject(this.config.projectPath);
                    setTimeout(() => this.cleanup(), 1000);
                } else if (this.config.testClear) {
                    // Test clear functionality
                    console.log('🧪 Testing clear functionality...');
                    console.log('');

                    // Send a message first
                    this.sendMessage(this.config.testMessage, this.config.imagePath || undefined);

                    // Wait 2 seconds then clear
                    setTimeout(() => {
                        this.sendClearChat();

                        // Wait another 2 seconds then send another message
                        setTimeout(() => {
                            this.sendMessage('Second message after clear');

                            // Close after 3 seconds
                            setTimeout(() => {
                                console.log('');
                                console.log('✅ Clear test complete - closing connection');
                                this.cleanup();
                            }, 3000);
                        }, 2000);
                    }, 2000);
                } else if (this.config.createTask) {
                    // Create task directly like the frontend does
                    this.sendTask(this.config.taskName, this.config.testMessage);
                } else if (this.config.supervisorChat) {
                    // Use supervisor chat
                    this.sendSupervisorChat(this.config.testMessage, this.config.taskId || undefined);
                } else if (this.config.listArchivedTasks) {
                    // List archived tasks
                    this.sendListArchivedTasks();
                } else if (this.config.restoreArchivedTask && this.config.taskId) {
                    // Restore archived task
                    this.sendRestoreArchivedTask(this.config.taskId);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.deleteArchivedTask && this.config.taskId) {
                    // Delete archived task permanently
                    this.sendDeleteArchivedTask(this.config.taskId);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.continueArchivedTask && this.config.taskId) {
                    // Continue archived task (restore + reconnect)
                    this.sendContinueArchivedTask(this.config.taskId);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.watchTask) {
                    // Watch task state changes - don't auto-close
                    console.log('👁️  Watching task state changes... (Ctrl+C to exit)');
                    console.log('');
                } else if (this.config.archiveTask && this.config.taskId) {
                    this.sendArchiveTask(this.config.taskId);
                    setTimeout(() => this.cleanup(), 2000);
                } else if (this.config.gitPush && this.config.workspaceId) {
                    this.sendGitPush(this.config.workspaceId);
                } else {
                    this.sendMessage(this.config.testMessage, this.config.imagePath || undefined);
                }
            });

            this.ws.on('message', (data: Buffer) => {
                try {
                    const message: WSMessage = JSON.parse(data.toString());
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Failed to parse message:', error);
                }
            });

            this.ws.on('close', () => {
                console.log('🔌 Connection closed');
                clearTimeout(timeout);
                this.printSummary();
                resolve();
            });

            this.ws.on('error', (error: Error) => {
                console.error('❌ WebSocket error:', error.message);
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    private sendMessage(content: string, imagePath?: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send message: WebSocket not connected');
            return;
        }

        const payload: any = { content };

        // Add image if provided
        if (imagePath) {
            try {
                const imageBuffer = fs.readFileSync(imagePath);
                const base64Image = imageBuffer.toString('base64');
                const ext = path.extname(imagePath).toLowerCase();
                const mimeType = {
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.webp': 'image/webp'
                }[ext] || 'image/png';

                payload.images = [{
                    name: path.basename(imagePath),
                    data: base64Image,
                    mimeType
                }];

                console.log(`📤 Sending message with image: ${path.basename(imagePath)}`);
            } catch (error) {
                console.error(`Failed to read image: ${error}`);
                return;
            }
        } else {
            console.log('📤 Sending message...');
        }

        const message = {
            type: 'chat:send',
            payload
        };

        this.ws.send(JSON.stringify(message));
    }

    private sendTask(name: string, description: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send task: WebSocket not connected');
            return;
        }

        // Server expects 'prompt' and 'workspaceId' fields
        const message = {
            type: 'task:create',
            payload: {
                prompt: description,
                workspaceId: this.config.workspaceId
            }
        };

        console.log(`📤 Creating task: "${name}"`);
        console.log(`   Prompt: ${description}`);
        if (this.config.workspaceId) {
            console.log(`   Workspace: ${this.config.workspaceId}`);
        }
        this.ws.send(JSON.stringify(message));
    }

    private sendClearChat(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot clear chat: WebSocket not connected');
            return;
        }

        const message = {
            type: 'chat:clear',
            payload: {}
        };


        console.log('🗑️  Clearing chat...');
        this.ws.send(JSON.stringify(message));
    }

    private sendSupervisorChat(content: string, taskId?: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send supervisor chat: WebSocket not connected');
            return;
        }

        const message = {
            type: 'supervisor:chat:message',
            payload: { content, taskId }
        };

        console.log(`📤 Sending supervisor chat: "${content}"`);
        if (taskId) {
            console.log(`   Task context: ${taskId}`);
        }
        this.ws.send(JSON.stringify(message));
    }

    private sendTaskInput(taskId: string, input: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot send task input: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:input',
            payload: { taskId, input }
        };

        console.log(`📥 Sending input to task ${taskId}: "${input}"`);
        this.ws.send(JSON.stringify(message));
    }

    private sendStopTask(taskId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot stop task: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:interrupt',
            payload: { taskId }
        };

        console.log(`⏹️  Stopping task ${taskId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendDeleteTask(taskId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot delete task: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:destroy',
            payload: { taskId }
        };

        console.log(`🗑️  Deleting task ${taskId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendClearTasks(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot clear tasks: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:clear',
            payload: {}
        };

        console.log('🗑️  Clearing all tasks...');
        this.ws.send(JSON.stringify(message));
    }

    private sendApprovePlan(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot approve plan: WebSocket not connected');
            return;
        }

        const message = {
            type: 'plan:approve',
            payload: {}
        };

        console.log('✅ Approving plan...');
        this.ws.send(JSON.stringify(message));
    }

    private sendRejectPlan(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot reject plan: WebSocket not connected');
            return;
        }

        const message = {
            type: 'plan:reject',
            payload: {}
        };

        console.log('❌ Rejecting plan...');
        this.ws.send(JSON.stringify(message));
    }

    private sendAutoApprove(enabled: boolean): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot set auto-approve: WebSocket not connected');
            return;
        }

        const message = {
            type: 'config:autoApprove',
            payload: { enabled }
        };

        console.log(`⚙️  Setting auto-approve to: ${enabled}`);
        this.ws.send(JSON.stringify(message));
    }

    private sendCreateWorkspace(path: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot create workspace: WebSocket not connected');
            return;
        }

        const message = {
            type: 'workspace:create',
            payload: { path }
        };

        console.log(`📁 Creating workspace: ${path}`);
        this.ws.send(JSON.stringify(message));
    }

    private sendDeleteWorkspace(workspaceId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot delete workspace: WebSocket not connected');
            return;
        }

        const message = {
            type: 'workspace:delete',
            payload: { workspaceId }
        };

        console.log(`🗑️  Deleting workspace ${workspaceId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendSetActiveWorkspace(workspaceId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot set active workspace: WebSocket not connected');
            return;
        }

        const message = {
            type: 'workspace:setActive',
            payload: { workspaceId }
        };

        console.log(`🎯 Setting active workspace to ${workspaceId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendReorderWorkspaces(fromIndex: number, toIndex: number): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot reorder workspaces: WebSocket not connected');
            return;
        }

        const message = {
            type: 'workspace:reorder',
            payload: { fromIndex, toIndex }
        };

        console.log(`🔄 Reordering workspaces: ${fromIndex} -> ${toIndex}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendSetProject(path: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot set project: WebSocket not connected');
            return;
        }

        const message = {
            type: 'project:set',
            payload: { path }
        };

        console.log(`📂 Setting project path to: ${path}`);
        this.ws.send(JSON.stringify(message));
    }

    private sendListArchivedTasks(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot list archived tasks: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:archived:list',
            payload: {}
        };

        console.log('📦 Requesting archived tasks...');
        this.ws.send(JSON.stringify(message));
    }

    private sendRestoreArchivedTask(taskId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot restore archived task: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:archived:restore',
            payload: { taskId }
        };

        console.log(`♻️  Restoring archived task ${taskId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendDeleteArchivedTask(taskId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot delete archived task: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:archived:delete',
            payload: { taskId }
        };

        console.log(`🗑️  Permanently deleting archived task ${taskId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendContinueArchivedTask(taskId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot continue archived task: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:archived:continue',
            payload: { taskId }
        };

        console.log(`▶️  Continuing archived task ${taskId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendArchiveTask(taskId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot archive task: WebSocket not connected');
            return;
        }

        const message = {
            type: 'task:archive',
            payload: { taskId }
        };

        console.log(`📦 Archiving task ${taskId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private sendGitPush(workspaceId: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('Cannot push to GitHub: WebSocket not connected');
            return;
        }

        const message = {
            type: 'git:push',
            payload: { workspaceId }
        };

        console.log(`🚀 Pushing to GitHub for workspace ${workspaceId}...`);
        this.ws.send(JSON.stringify(message));
    }

    private listTasks(): void {
        console.log('');
        console.log('📋 TASK LIST');
        console.log('='.repeat(80));

        if (this.tasks.size === 0) {
            console.log('  No tasks found');
            return;
        }

        const taskArray = Array.from(this.tasks.values());

        // Group by workspace
        const byWorkspace = new Map<string, Task[]>();
        taskArray.forEach(task => {
            const key = task.projectPath || 'No workspace';
            if (!byWorkspace.has(key)) {
                byWorkspace.set(key, []);
            }
            byWorkspace.get(key)!.push(task);
        });

        byWorkspace.forEach((tasks, workspace) => {
            console.log('');
            console.log(`📁 ${workspace}`);
            console.log('-'.repeat(80));

            tasks.forEach(task => {
                const statusIcon = {
                    'pending': '⏳',
                    'running': '▶️',
                    'complete': '✅',
                    'error': '❌',
                    'stopped': '⏹️',
                    'cancelled': '🚫',
                    'blocked': '🔒'
                }[task.status] || '❓';

                console.log(`  ${statusIcon} [${task.id.substring(0, 8)}...] ${task.name}`);
                console.log(`     Status: ${task.status || (task as any).state}`);
                if (task.parentId) {
                    console.log(`     Parent: ${task.parentId.substring(0, 8)}...`);
                }
            });
        });

        console.log('');
    }

    private async viewTaskFiles(taskId: string): Promise<void> {
        const httpUrl = this.config.backendUrl.replace('ws://', 'http://').replace('ws', '3000');
        const url = `${httpUrl}/api/tasks/${taskId}/files`;

        console.log(`📄 Fetching files for task ${taskId}...`);

        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.error(`Failed to fetch files: ${response.statusText}`);
                return;
            }

            const files = await response.json();

            if (!files || files.length === 0) {
                console.log('  No files found for this task');
                return;
            }

            console.log('');
            console.log('📂 CODE FILES');
            console.log('='.repeat(80));

            files.forEach((file: any) => {
                const opIcon = {
                    'created': '➕',
                    'modified': '✏️',
                    'deleted': '➖'
                }[file.operation] || '📄';

                console.log('');
                console.log(`${opIcon} ${file.filename} [${file.operation}] (${file.language})`);
                console.log('-'.repeat(80));
                console.log(file.content);
            });

            console.log('');
        } catch (error) {
            console.error('Failed to fetch files:', error);
        }
    }

    private async getConfig(): Promise<void> {
        const httpUrl = this.config.backendUrl.replace('ws://', 'http://').replace('ws', '3000');
        const url = `${httpUrl}/api/config`;

        console.log('⚙️  Fetching orchestrator configuration...');

        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.error(`Failed to fetch config: ${response.statusText}`);
                return;
            }

            const config = await response.json();

            console.log('');
            console.log('⚙️  ORCHESTRATOR CONFIGURATION');
            console.log('='.repeat(80));
            console.log(JSON.stringify(config, null, 2));
            console.log('');
        } catch (error) {
            console.error('Failed to fetch config:', error);
        }
    }

    private handleMessage(message: WSMessage): void {
        // Verbose logging of all events
        if (this.config.verbose) {
            const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
            const payloadPreview = JSON.stringify(message.payload).substring(0, 100);
            console.log(`[${elapsed}s] EVENT     │ ${message.type}: ${payloadPreview}...`);
        }

        switch (message.type) {
            case 'init':
                this.handleInit(message.payload);
                break;

            case 'chat:message':
                this.handleChatMessage(message.payload as { message: ChatMessage });
                break;

            case 'chat:cleared':
                this.handleChatCleared();
                break;

            case 'task:created':
                this.handleTaskCreated(message.payload as { task: Task });
                break;

            case 'task:updated':
                this.handleTaskUpdated(message.payload as { task: Task });
                break;

            case 'task:complete':
                this.handleTaskComplete(message.payload as { task: Task });
                break;

            case 'task:output':
                this.handleTaskOutput(message.payload as { taskId: string; data: string });
                break;

            case 'supervisor:chat:response':
                this.handleSupervisorChatResponse(message.payload as { message: ChatMessage });
                break;

            case 'supervisor:chat:typing':
                this.handleSupervisorTyping(message.payload as { isTyping: boolean });
                break;

            case 'plan:created':
            case 'plan:approved':
            case 'plan:rejected':
                if (this.config.verbose) {
                    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
                    console.log(`[${elapsed}s] PLAN      │ ${message.type}`);
                }
                break;

            case 'task:archived:list':
                this.handleArchivedTaskList(message.payload as { tasks: Task[] });
                break;

            case 'task:archived:restored':
                this.handleArchivedTaskRestored(message.payload as { task: Task });
                break;

            case 'task:archived:deleted':
                this.handleArchivedTaskDeleted(message.payload as { taskId: string; success: boolean });
                break;

            case 'task:archived:continued':
                this.handleArchivedTaskContinued(message.payload as { task: Task });
                break;

            case 'task:stateChanged':
                this.handleTaskStateChanged(message.payload as { task: Task });
                break;

            default:
                if (this.config.verbose) {
                    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
                    console.log(`[${elapsed}s] UNKNOWN   │ ${message.type}`);
                }
                break;
        }
    }

    private handleInit(payload: any): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const taskCount = payload.tasks?.length || 0;
        const workspaceCount = payload.workspaces?.length || 0;
        console.log(`[${elapsed}s] INIT      │ Received ${taskCount} existing tasks, ${workspaceCount} workspaces`);

        // Load existing tasks
        if (payload.tasks) {
            for (const task of payload.tasks) {
                this.tasks.set(task.id, task);
            }
        }
    }

    private handleTaskOutput(payload: { taskId: string; data: string }): void {
        this.lastActivityTime = Date.now();

        if (this.config.verbose) {
            const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
            const preview = payload.data.substring(0, 80).replace(/\n/g, ' ');
            console.log(`[${elapsed}s] OUTPUT    │ [${payload.taskId.substring(0, 8)}...] ${preview}...`);
        }
    }

    private handleChatCleared(): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        console.log(`[${elapsed}s] CLEARED   │ Chat conversation has been cleared`);
        const previousCount = this.chatMessages.length;
        this.chatMessages = [];
        console.log(`[${elapsed}s] CLEARED   │ Removed ${previousCount} messages from local state`);
    }

    private handleSupervisorChatResponse(payload: { message: ChatMessage }): void {
        const msg = payload.message;
        this.chatMessages.push(msg);

        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const role = msg.role.toUpperCase().padEnd(9);

        console.log(`[${elapsed}s] ${role} │ ${msg.content}`);

        // Update activity time
        this.lastActivityTime = Date.now();

        // Check for completion after assistant message
        if (msg.role === 'assistant') {
            this.scheduleCompletionCheck();
        }
    }

    private handleSupervisorTyping(payload: { isTyping: boolean }): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        if (payload.isTyping) {
            console.log(`[${elapsed}s] TYPING    │ Supervisor is typing...`);
        } else {
            console.log(`[${elapsed}s] TYPING    │ Supervisor finished typing`);
        }
    }

    private handleChatMessage(payload: { message: ChatMessage }): void {
        const msg = payload.message;
        this.chatMessages.push(msg);

        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const role = msg.role.toUpperCase().padEnd(9);

        console.log(`[${elapsed}s] ${role} │ ${msg.content}`);

        // Update activity time
        this.lastActivityTime = Date.now();

        // Check for completion after any message
        this.scheduleCompletionCheck();
    }

    private handleTaskCreated(payload: { task: Task }): void {
        const task = payload.task;
        this.tasks.set(task.id, task);

        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        console.log(`[${elapsed}s] TASK      │ Created: ${task.name}`);

        this.lastActivityTime = Date.now();
    }

    private handleTaskUpdated(payload: { task: Task }): void {
        const task = payload.task;
        this.tasks.set(task.id, task);

        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        console.log(`[${elapsed}s] TASK      │ Status: ${task.status} - ${task.name}`);

        this.lastActivityTime = Date.now();
    }

    private handleTaskComplete(payload: { task: Task }): void {
        const task = payload.task;
        this.tasks.set(task.id, task);

        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const taskName = task.name;
        console.log(`[${elapsed}s] COMPLETE  │ ${taskName} (exit: ${task.exitCode ?? 'N/A'}, status: ${task.status})`);

        if (this.config.verbose && task.structuredResult) {
            console.log(`[${elapsed}s] RESULT    │ Summary: ${task.structuredResult.summary || 'N/A'}`);
            if (task.structuredResult.artifacts?.length) {
                console.log(`[${elapsed}s] RESULT    │ Artifacts: ${task.structuredResult.artifacts.join(', ')}`);
            }
        }

        this.lastActivityTime = Date.now();

        // Schedule completion check after task completes
        this.scheduleCompletionCheck();
    }

    private handleArchivedTaskList(payload: { tasks: Task[] }): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        this.archivedTasks = payload.tasks || [];
        console.log(`[${elapsed}s] ARCHIVED  │ Received ${this.archivedTasks.length} archived tasks`);

        // Print the list
        console.log('');
        console.log('📦 ARCHIVED TASKS');
        console.log('='.repeat(80));

        if (this.archivedTasks.length === 0) {
            console.log('  No archived tasks found');
        } else {
            this.archivedTasks.forEach(task => {
                const archivedDate = new Date(task.lastActivity).toLocaleDateString();
                const prompt = (task.prompt || '').substring(0, 50) + (task.prompt && task.prompt.length > 50 ? '...' : '');
                console.log(`  📦 [${task.id.substring(0, 12)}...] ${prompt}`);
                console.log(`     Workspace: ${task.workspaceId}`);
                console.log(`     Archived: ${archivedDate}`);
                console.log('');
            });
        }

        // Close connection after listing
        setTimeout(() => this.cleanup(), 1000);
    }

    private handleArchivedTaskRestored(payload: { task: Task }): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const task = payload.task;
        console.log(`[${elapsed}s] RESTORED  │ Task ${task.id} restored successfully`);
        console.log(`     Prompt: ${task.prompt?.substring(0, 50)}...`);
        console.log(`     State: ${task.state}`);
    }

    private handleArchivedTaskDeleted(payload: { taskId: string; success: boolean }): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        if (payload.success) {
            console.log(`[${elapsed}s] DELETED   │ Archived task ${payload.taskId} permanently deleted`);
        } else {
            console.log(`[${elapsed}s] ERROR     │ Failed to delete archived task ${payload.taskId}`);
        }
    }

    private handleArchivedTaskContinued(payload: { task: Task }): void {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const task = payload.task;
        console.log(`[${elapsed}s] CONTINUED │ Task ${task.id} restored and reconnected`);
        console.log(`     Prompt: ${task.prompt?.substring(0, 50)}...`);
        console.log(`     State: ${task.state}`);
        this.tasks.set(task.id, task);
    }

    private handleTaskStateChanged(payload: { task: Task }): void {
        const task = payload.task;
        this.tasks.set(task.id, task);

        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

        // State icons
        const stateIcon: Record<string, string> = {
            'starting': '▶️',
            'busy': '🔄',
            'idle': '✅',
            'waiting_input': '❓',
            'exited': '🛑',
            'disconnected': '🔌',
            'interrupted': '⚡',
            'archived': '📦'
        };
        const icon = stateIcon[task.state] || '❔';

        // Show state change prominently
        const shortId = task.id.substring(0, 12);
        const waitingType = task.waitingInputType ? ` (${task.waitingInputType})` : '';
        console.log(`[${elapsed}s] STATE     │ ${icon} ${shortId}... → ${task.state}${waitingType}`);

        this.lastActivityTime = Date.now();
    }

    /**
     * Schedule a completion check after activity stops
     */
    private scheduleCompletionCheck(): void {
        // Cancel any existing timer
        if (this.completionTimer) {
            clearTimeout(this.completionTimer);
        }

        // Wait 4 seconds of inactivity before checking completion
        this.completionTimer = setTimeout(() => {
            this.checkForCompletion();
        }, 4000);
    }

    /**
     * Check if the test should be considered complete
     */
    private checkForCompletion(): void {
        const runningTasks = Array.from(this.tasks.values()).filter(t => t.status === 'running');
        const assistantMessages = this.chatMessages.filter(m => m.role === 'assistant');

        // Complete if:
        // 1. No tasks are running
        // 2. We have at least one assistant response
        // 3. 4 seconds of inactivity have passed
        if (runningTasks.length === 0 && assistantMessages.length > 0) {
            const timeSinceActivity = Date.now() - this.lastActivityTime;
            if (timeSinceActivity >= 4000) {
                console.log('');
                console.log('✅ Test complete - closing connection');
                this.cleanup();
            }
        }
    }

    private printSummary(): void {
        console.log('');
        console.log('='.repeat(80));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(80));
        console.log('');

        const duration = ((Date.now() - this.startTime) / 1000).toFixed(1);
        console.log(`⏱️  Duration: ${duration}s`);
        console.log(`💬 Chat messages: ${this.chatMessages.length}`);
        console.log(`📋 Tasks: ${this.tasks.size}`);
        console.log('');

        console.log('📝 ASSISTANT RESPONSES:');
        console.log('-'.repeat(80));

        const assistantMessages = this.chatMessages.filter(m => m.role === 'assistant');
        if (assistantMessages.length === 0) {
            console.log('  ⚠️  No assistant responses received!');
        } else {
            assistantMessages.forEach((msg, i) => {
                console.log(`  ${i + 1}. ${msg.content}`);
                console.log('');
            });
        }

        console.log('✅ TEST VERIFICATION:');
        console.log('-'.repeat(80));

        // Check if the last assistant message contains actual data (not just "task complete")
        const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
        if (lastAssistantMsg) {
            const hasRealContent = lastAssistantMsg.content.length > 50 &&
                !lastAssistantMsg.content.match(/^[✅❌⚠️]\s*(Task|Worker).*complete/i);

            if (hasRealContent) {
                console.log('  ✅ PASS: Assistant provided detailed results (not just "task complete")');
            } else {
                console.log('  ❌ FAIL: Assistant only said "task complete" without showing results');
            }
        } else {
            console.log('  ❌ FAIL: No assistant response received');
        }

        console.log('');
    }

    private cleanup(): void {
        // Clear any pending timers
        if (this.completionTimer) {
            clearTimeout(this.completionTimer);
            this.completionTimer = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// Parse command line arguments
function parseArgs(): TestConfig {
    const args = process.argv.slice(2);

    let backendUrl = 'ws://localhost:4001';
    let testMessage = 'echo hello world';
    let timeoutMs = 120000; // 120 seconds
    let testClear = false;
    let createTask = false;
    let taskName = 'CLI Test Task';
    let workspaceId: string | null = null;
    let verbose = false;
    let authCode = 'asdf123';
    let taskInput = false;
    let taskId: string | null = null;
    let stopTask = false;
    let deleteTask = false;
    let clearTasks = false;
    let approvePlan = false;
    let rejectPlan = false;
    let autoApprove: boolean | null = null;
    let createWorkspace = false;
    let deleteWorkspace = false;
    let setActiveWorkspace = false;
    let reorderWorkspaces = false;
    let reorderFrom: number | null = null;
    let reorderTo: number | null = null;
    let setProject = false;
    let projectPath: string | null = null;
    let listTasks = false;
    let viewTaskFiles = false;
    let getConfig = false;
    let imagePath: string | null = null;
    let supervisorChat = false;
    let listArchivedTasks = false;
    let restoreArchivedTask = false;
    let deleteArchivedTask = false;
    let continueArchivedTask = false;

    let watchTask = false;
    let archiveTask = false;
    let gitPush = false;
    let backendStatus = false;
    let setBackend: string | null = null;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--url':
                backendUrl = args[++i];
                break;
            case '--message':
            case '-m':
                testMessage = args[++i];
                break;
            case '--timeout':
            case '-t':
                timeoutMs = parseInt(args[++i]);
                break;
            case '--clear':
                testClear = true;
                break;
            case '--task':
                createTask = true;
                break;
            case '--task-name':
            case '-n':
                taskName = args[++i];
                break;
            case '--workspace':
            case '-w':
                workspaceId = args[++i];
                break;
            case '--verbose':
            case '-v':
                verbose = true;
                break;
            case '--auth':
            case '-a':
                authCode = args[++i];
                break;
            case '--task-input':
                taskInput = true;
                break;
            case '--task-id':
                taskId = args[++i];
                break;
            case '--stop-task':
                stopTask = true;
                break;
            case '--delete-task':
                deleteTask = true;
                break;
            case '--clear-tasks':
                clearTasks = true;
                break;
            case '--approve-plan':
                approvePlan = true;
                break;
            case '--reject-plan':
                rejectPlan = true;
                break;
            case '--auto-approve':
                autoApprove = args[++i] === 'true';
                break;
            case '--create-workspace':
                createWorkspace = true;
                break;
            case '--delete-workspace':
                deleteWorkspace = true;
                break;
            case '--set-active-workspace':
                setActiveWorkspace = true;
                break;
            case '--reorder-workspaces':
                reorderWorkspaces = true;
                break;
            case '--reorder-from':
                reorderFrom = parseInt(args[++i], 10);
                break;
            case '--reorder-to':
                reorderTo = parseInt(args[++i], 10);
                break;
            case '--set-project':
                setProject = true;
                break;
            case '--project-path':
            case '-p':
                projectPath = args[++i];
                break;
            case '--list-tasks':
                listTasks = true;
                break;
            case '--view-files':
                viewTaskFiles = true;
                break;
            case '--get-config':
                getConfig = true;
                break;
            case '--image':
            case '-i':
                imagePath = args[++i];
                break;
            case '--supervisor-chat':
            case '-s':
                supervisorChat = true;
                break;
            case '--list-archived':
                listArchivedTasks = true;
                break;
            case '--restore-archived':
                restoreArchivedTask = true;
                break;
            case '--delete-archived':
                deleteArchivedTask = true;
                break;
            case '--continue-archived':
                continueArchivedTask = true;
                break;
            case '--watch-task':
                watchTask = true;
                break;
            case '--archive-task':
                archiveTask = true;
                break;
            case '--git-push':
                gitPush = true;
                break;
            case '--backend-status':
                backendStatus = true;
                break;
            case '--set-backend':
                setBackend = args[++i];
                break;
            case '--help':
            case '-h':
                console.log(`
Usage: npx tsx test-cli.ts [options]

BASIC OPTIONS:
  --url <url>              Backend WebSocket URL (default: ws://localhost:4001)
  --message, -m <text>     Test message/description to send (default: echo hello world)
  --timeout, -t <ms>       Timeout in milliseconds (default: 120000)
  --verbose, -v            Show all WebSocket events and detailed logging
  --auth, -a <code>        Auth code (default: asdf123)
  --help, -h               Show this help message

CHAT OPERATIONS:
  --clear                  Test the clear chat functionality
  --image, -i <path>       Attach an image to the message

TASK OPERATIONS:
  --task                   Create task directly (like frontend task:create)
  --task-name, -n <name>   Name for the task when using --task
  --task-id <id>           Task ID for operations (stop, delete, input, view-files)
  --task-input             Send input to a task (requires --task-id and --message)
  --stop-task              Stop a running task (requires --task-id)
  --delete-task            Delete a specific task (requires --task-id)
  --clear-tasks            Clear all tasks
  --list-tasks             List all tasks with their status
  --view-files             View code files for a task (requires --task-id)
  --archive-task           Archive a task (requires --task-id)

ARCHIVED TASK OPERATIONS:
  --list-archived          List all archived tasks
  --restore-archived       Restore an archived task (requires --task-id)
  --continue-archived      Continue an archived task - restores and reconnects (requires --task-id)
  --delete-archived        Permanently delete an archived task (requires --task-id)

WORKSPACE OPERATIONS:
  --workspace, -w <id>     Workspace ID to use for task creation
  --create-workspace       Create a new workspace (requires --project-path)
  --delete-workspace       Delete a workspace (requires --workspace)
  --set-active-workspace   Set active workspace (requires --workspace)

PROJECT OPERATIONS:
  --set-project            Set current project path (requires --project-path)
  --project-path, -p <path> Project path for workspace/project operations

PLAN OPERATIONS:
  --approve-plan           Approve the current plan
  --reject-plan            Reject the current plan
  --auto-approve <bool>    Toggle auto-approve mode (true/false)

CONFIGURATION:
  --get-config             Get orchestrator configuration

BACKEND OPERATIONS:
  --backend-status         Get current backend status (claude-code or opencode)
  --set-backend <name>     Set the AI backend ('claude-code' or 'opencode')

Examples:
  # Basic chat message
  npx tsx test-cli.ts -m "create a file called hello.txt"

  # Chat with image attachment
  npx tsx test-cli.ts -m "What's in this image?" -i ./screenshot.png

  # Create a task
  npx tsx test-cli.ts --task -m "run the tests" -n "Run Tests"

  # Create task in specific workspace
  npx tsx test-cli.ts --task -w /Users/me/project -m "build the app"

  # Send input to running task
  npx tsx test-cli.ts --task-input --task-id abc123 -m "yes, continue"

  # Stop a running task
  npx tsx test-cli.ts --stop-task --task-id abc123

  # Delete a task
  npx tsx test-cli.ts --delete-task --task-id abc123

  # List all tasks
  npx tsx test-cli.ts --list-tasks

  # View code files for a task
  npx tsx test-cli.ts --view-files --task-id abc123

  # Create workspace
  npx tsx test-cli.ts --create-workspace -p /Users/me/my-project

  # Set active workspace
  npx tsx test-cli.ts --set-active-workspace -w workspace123

  # Approve plan (when plan mode is enabled)
  npx tsx test-cli.ts --approve-plan

  # Enable auto-approve
  npx tsx test-cli.ts --auto-approve true

  # Get configuration
  npx tsx test-cli.ts --get-config

  # Verbose mode
  npx tsx test-cli.ts -v -m "list files in current directory"

  # Clear all tasks
  npx tsx test-cli.ts --clear-tasks

  # List archived tasks
  npx tsx test-cli.ts --list-archived

  # Restore an archived task
  npx tsx test-cli.ts --restore-archived --task-id task-123456

  # Delete an archived task permanently
  npx tsx test-cli.ts --delete-archived --task-id task-123456

  # Check backend status
  npx tsx test-cli.ts --backend-status

  # Switch to opencode backend
  npx tsx test-cli.ts --set-backend opencode

  # Switch back to claude-code backend
  npx tsx test-cli.ts --set-backend claude-code
                `);
                process.exit(0);
        }
    }

    return {
        backendUrl,
        testMessage,
        timeoutMs,
        testClear,
        createTask,
        taskName,
        workspaceId,
        verbose,
        authCode,
        taskInput,
        taskId,
        stopTask,
        deleteTask,
        clearTasks,
        approvePlan,
        rejectPlan,
        autoApprove,
        createWorkspace,
        deleteWorkspace,
        setActiveWorkspace,
        reorderWorkspaces,
        reorderFrom,
        reorderTo,
        setProject,
        projectPath,
        listTasks,
        viewTaskFiles,
        getConfig,
        imagePath,
        supervisorChat,
        listArchivedTasks,
        restoreArchivedTask,
        deleteArchivedTask,
        continueArchivedTask,
        watchTask,
        archiveTask,
        gitPush,
        backendStatus,
        setBackend
    };
}

// Backend status and configuration functions (no WebSocket needed)
async function getBackendStatus(baseHttpUrl: string): Promise<void> {
    console.log('🔍 Checking backend status...');
    console.log('');

    try {
        const response = await fetch(`${baseHttpUrl}/api/backend/status`);
        if (!response.ok) {
            console.error(`Failed to get backend status: ${response.statusText}`);
            return;
        }

        const status = await response.json();

        console.log('⚙️  BACKEND STATUS');
        console.log('='.repeat(60));
        console.log(`  Current Backend: ${status.backend}`);
        console.log(`  Installed:       ${status.installed ? '✅ Yes' : '❌ No'}`);

        if (status.installed && status.version) {
            console.log(`  Version:         ${status.version}`);
        }

        if (status.serverRunning !== undefined) {
            console.log(`  Server Running:  ${status.serverRunning ? '✅ Yes' : '❌ No'}`);
        }

        if (status.error) {
            console.log(`  Error:           ${status.error}`);
        }

        console.log('');
        console.log('Available Backends:');
        for (const backend of status.availableBackends || []) {
            const isCurrent = backend === status.backend;
            console.log(`  ${isCurrent ? '►' : ' '} ${backend}`);
        }
        console.log('');
    } catch (error) {
        console.error('Failed to get backend status:', error);
    }
}

async function setBackendConfig(baseHttpUrl: string, backend: string): Promise<void> {
    const validBackends = ['claude-code', 'opencode'];
    if (!validBackends.includes(backend)) {
        console.error(`Invalid backend: ${backend}`);
        console.error(`Valid options: ${validBackends.join(', ')}`);
        process.exit(1);
    }

    console.log(`⚙️  Setting backend to: ${backend}`);

    try {
        const response = await fetch(`${baseHttpUrl}/api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backend })
        });

        if (!response.ok) {
            console.error(`Failed to set backend: ${response.statusText}`);
            return;
        }

        console.log('✅ Backend updated successfully');
        console.log('');

        // Show new status
        await getBackendStatus(baseHttpUrl);
    } catch (error) {
        console.error('Failed to set backend:', error);
    }
}

// Main execution
async function main() {
    const config = parseArgs();

    // Derive HTTP URL from WebSocket URL for API calls
    const baseHttpUrl = config.backendUrl
        .replace('ws://', 'http://')
        .replace('wss://', 'https://')
        .replace(/:\d+$/, ':4001');  // Ensure correct port

    // Handle backend commands that don't need WebSocket
    if (config.backendStatus) {
        await getBackendStatus(baseHttpUrl);
        process.exit(0);
    }

    if (config.setBackend) {
        await setBackendConfig(baseHttpUrl, config.setBackend);
        process.exit(0);
    }

    // WebSocket-based operations
    const cli = new TestCLI(config);

    try {
        await cli.run();
        process.exit(0);
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

main();
