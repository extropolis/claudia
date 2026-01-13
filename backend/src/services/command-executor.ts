import { spawn } from 'child_process';
import { v4 as uuid } from 'uuid';
import { ChatMessage } from '@claudia/shared';
import { EventEmitter } from 'events';

export class CommandExecutor extends EventEmitter {
    /**
     * Execute a terminal command and stream output to chat
     */
    async execute(command: string, cwd: string): Promise<void> {
        console.log(`[CommandExecutor] Running command: ${command}`);

        // Notify user that command is starting
        const startMessage: ChatMessage = {
            id: uuid(),
            role: 'assistant',
            content: `⚡ Running: \`${command}\``,
            timestamp: new Date()
        };
        this.emit('chat', startMessage);

        return new Promise((resolve) => {
            const proc = spawn('bash', ['-l', '-c', command], {
                cwd,
                env: { ...process.env, FORCE_COLOR: '0' },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let output = '';
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            let outputLines: string[] = [];

            const handleData = (data: Buffer) => {
                const text = data.toString();
                output += text;
                outputLines.push(text);
                // Stream output as chat messages (batched)
                this.emit('output', { type: 'command', data: text });
            };

            proc.stdout?.on('data', handleData);
            proc.stderr?.on('data', handleData);

            proc.on('close', (code: number) => {
                console.log(`[CommandExecutor] Command exited with code ${code}`);

                // Send final result
                const emoji = code === 0 ? '✅' : '❌';
                const resultMessage: ChatMessage = {
                    id: uuid(),
                    role: 'assistant',
                    content: `${emoji} Command completed (exit code: ${code})\n\n\`\`\`\n${output.slice(-2000)}\n\`\`\``,
                    timestamp: new Date()
                };
                this.emit('chat', resultMessage);
                resolve();
            });

            proc.on('error', (err: Error) => {
                console.error('[CommandExecutor] Command error:', err);
                const errorMessage: ChatMessage = {
                    id: uuid(),
                    role: 'assistant',
                    content: `❌ Command failed: ${err.message}`,
                    timestamp: new Date()
                };
                this.emit('chat', errorMessage);
                resolve();
            });
        });
    }
}
