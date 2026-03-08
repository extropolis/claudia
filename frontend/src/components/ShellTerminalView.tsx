import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { X, Copy, Check } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import './ShellTerminalView.css';

interface ShellTerminalViewProps {
    workspaceId: string;
    workspaceName: string;
    wsRef: React.RefObject<WebSocket | null>;
    onClose: () => void;
    visible?: boolean;
}

export function ShellTerminalView({ workspaceId, workspaceName, wsRef, onClose, visible = true }: ShellTerminalViewProps) {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const [copied, setCopied] = useState(false);

    const copyToClipboard = async () => {
        if (!xtermRef.current) return;
        const buffer = xtermRef.current.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) lines.push(line.translateToString(true));
        }
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
        }
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    useEffect(() => {
        if (!terminalRef.current) return;

        // Clear container
        while (terminalRef.current.firstChild) {
            terminalRef.current.removeChild(terminalRef.current.firstChild);
        }

        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: '"SF Mono", "Monaco", "Inconsolata", "Fira Code", monospace',
            scrollback: 10000,
            allowProposedApi: true,
            theme: {
                background: '#0a0a0a',
                foreground: '#d4d4d4',
                cursor: '#d4d4d4',
                black: '#0a0a0a',
                red: '#cd3131',
                green: '#0dbc79',
                yellow: '#e5e510',
                blue: '#2472c8',
                magenta: '#bc3fbc',
                cyan: '#11a8cd',
                white: '#e5e5e5',
                brightBlack: '#666666',
                brightRed: '#f14c4c',
                brightGreen: '#23d18b',
                brightYellow: '#f5f543',
                brightBlue: '#3b8eea',
                brightMagenta: '#d670d6',
                brightCyan: '#29b8db',
                brightWhite: '#e5e5e5',
            },
        });

        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);

        // Electron clipboard integration
        if (window.electronAPI?.readClipboard) {
            term.attachCustomKeyEventHandler((event) => {
                if (event.type === 'keydown' && event.ctrlKey && event.key === 'v') {
                    const text = window.electronAPI!.readClipboard();
                    if (text) term.paste(text);
                    return false;
                }
                if (event.type === 'keydown' && event.ctrlKey && event.key === 'c') {
                    const selection = term.getSelection();
                    if (selection) {
                        window.electronAPI!.writeClipboard(selection);
                        return false;
                    }
                }
                return true;
            });
        }

        // Send input to backend shell
        term.onData((data) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'shell:input',
                    payload: { workspaceId, input: data }
                }));
            }
        });

        // Send resize to backend shell
        term.onResize(({ cols, rows }) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({
                    type: 'shell:resize',
                    payload: { workspaceId, cols, rows }
                }));
            }
        });

        term.open(terminalRef.current);
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        // Windows right-click copy/paste
        if (window.electronAPI?.writeClipboard) {
            term.element?.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const selection = term.getSelection();
                if (selection) {
                    window.electronAPI!.writeClipboard(selection);
                    term.clearSelection();
                } else {
                    const text = window.electronAPI!.readClipboard();
                    if (text) term.paste(text);
                }
            });
        }

        // Initial fit
        requestAnimationFrame(() => {
            try {
                fitAddon.fit();
            } catch (e) {
                console.error('[ShellTerminalView] Initial fit failed:', e);
            }
        });

        // ResizeObserver
        let resizeTimeout: number;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeTimeout) window.clearTimeout(resizeTimeout);
            resizeTimeout = window.setTimeout(() => {
                try { fitAddonRef.current?.fit(); } catch {}
            }, 50);
        });
        resizeObserver.observe(terminalRef.current);

        const handleWindowResize = () => {
            if (resizeTimeout) window.clearTimeout(resizeTimeout);
            resizeTimeout = window.setTimeout(() => {
                fitAddonRef.current?.fit();
            }, 50);
        };
        window.addEventListener('resize', handleWindowResize);

        // Listen for shell output and exit from backend
        const handleMessage = (event: MessageEvent) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'shell:output' && message.payload.workspaceId === workspaceId) {
                    term.write(message.payload.data);
                } else if (message.type === 'shell:exited' && message.payload.workspaceId === workspaceId) {
                    term.writeln('\r\n\x1b[90m[Shell exited]\x1b[0m');
                } else if (message.type === 'shell:closed' && message.payload.workspaceId === workspaceId) {
                    term.writeln('\r\n\x1b[90m[Shell closed]\x1b[0m');
                }
            } catch (e) {
                console.error('[ShellTerminalView] Message error:', e);
            }
        };

        if (wsRef.current) {
            wsRef.current.addEventListener('message', handleMessage);
        }

        // Create the shell session on the backend
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            const { cols, rows } = term;
            wsRef.current.send(JSON.stringify({
                type: 'shell:create',
                payload: { workspaceId, cols, rows }
            }));
        }

        return () => {
            if (resizeTimeout) window.clearTimeout(resizeTimeout);
            resizeObserver.disconnect();
            window.removeEventListener('resize', handleWindowResize);
            if (wsRef.current) {
                wsRef.current.removeEventListener('message', handleMessage);
            }
            term.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
        };
    }, [workspaceId, wsRef]);

    // Refit terminal when becoming visible (xterm can't measure when hidden)
    useEffect(() => {
        if (visible && fitAddonRef.current && xtermRef.current) {
            // Small delay to let the DOM update display before measuring
            const timer = setTimeout(() => {
                try {
                    fitAddonRef.current?.fit();
                    xtermRef.current?.scrollToBottom();
                } catch {}
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [visible]);

    const handleClose = () => {
        // Close the shell on the backend
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'shell:close',
                payload: { workspaceId }
            }));
        }
        onClose();
    };

    return (
        <div className="shell-terminal-view">
            <div className="shell-terminal-header">
                <span className="shell-terminal-title">Shell — {workspaceName}</span>
                <button
                    className={`copy-button ${copied ? 'copied' : ''}`}
                    onClick={copyToClipboard}
                    title="Copy terminal content"
                >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                </button>
                <button
                    className="shell-close-button"
                    onClick={handleClose}
                    title="Close shell"
                >
                    <X size={16} />
                </button>
            </div>
            <div className="shell-terminal-container-wrapper">
                <div ref={terminalRef} className="shell-terminal-container" />
            </div>
        </div>
    );
}
