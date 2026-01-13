import { useEffect, useRef, useState } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { Terminal, ArrowLeft, FileCode, Copy, Check, Send, StopCircle } from 'lucide-react';
import { CodeViewer } from './CodeViewer';
import { VoiceInput } from './VoiceInput';
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis';

type TabType = 'terminal' | 'code';

interface TerminalPanelProps {
    onSendInput?: (taskId: string, input: string) => void;
    onStopTask?: (taskId: string) => void;
}

export function TerminalPanel({ onSendInput, onStopTask }: TerminalPanelProps) {
    const {
        selectedTaskId,
        tasks,
        selectTask,
        voiceEnabled,
        autoSpeakResponses,
        selectedVoiceName,
        voiceRate,
        voicePitch,
        voiceVolume
    } = useTaskStore();
    const contentRef = useRef<HTMLDivElement>(null);
    const autoScrollRef = useRef(true);
    const [activeTab, setActiveTab] = useState<TabType>('terminal');
    const [copied, setCopied] = useState(false);
    const [input, setInput] = useState('');
    const [isInterrupting, setIsInterrupting] = useState(false);
    const lastOutputLengthRef = useRef(0);

    const task = selectedTaskId ? tasks.get(selectedTaskId) : null;

    // Speech synthesis
    const { speak, cancel, voices, setSelectedVoice } = useSpeechSynthesis({
        rate: voiceRate,
        pitch: voicePitch,
        volume: voiceVolume
    });

    // Auto-scroll to bottom when new output arrives
    useEffect(() => {
        if (autoScrollRef.current && contentRef.current) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
    }, [task?.output]);

    // Update selected voice when voice name changes
    useEffect(() => {
        if (selectedVoiceName && voices.length > 0) {
            const voice = voices.find(v => v.name === selectedVoiceName);
            if (voice) {
                setSelectedVoice(voice);
            }
        }
    }, [selectedVoiceName, voices, setSelectedVoice]);

    // Auto-speak new task output
    useEffect(() => {
        if (!autoSpeakResponses || !voiceEnabled || !task) return;

        const currentLength = task.output.length;
        if (currentLength > lastOutputLengthRef.current) {
            // New output was added
            const newLines = task.output.slice(lastOutputLengthRef.current);
            const newContent = newLines.join('\n');

            // Only speak if there's substantial content (not just blank lines)
            if (newContent.trim().length > 5) {
                speak(newContent);
            }

            lastOutputLengthRef.current = currentLength;
        }
    }, [task?.output, autoSpeakResponses, voiceEnabled, speak]);

    // Reset output length tracker when task changes
    useEffect(() => {
        if (task) {
            lastOutputLengthRef.current = task.output.length;
        }
    }, [selectedTaskId]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cancel();
        };
    }, [cancel]);

    // Handle scroll - disable auto-scroll if user scrolls up
    const handleScroll = () => {
        if (!contentRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
        autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
    };

    const copyTaskOutput = async () => {
        if (!task) return;
        const output = [
            `Task: ${task.name}`,
            `Status: ${task.status}`,
            `Description: ${task.description}`,
            '',
            '--- Output ---',
            '',
            ...task.output
        ].join('\n');

        try {
            await navigator.clipboard.writeText(output);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const handleSendInput = (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || !selectedTaskId || !onSendInput) return;

        onSendInput(selectedTaskId, input);
        setInput('');
        setIsInterrupting(false); // Reset interrupting state after sending
    };

    const handleInterrupt = () => {
        if (!selectedTaskId || !onStopTask) return;
        onStopTask(selectedTaskId);
        setIsInterrupting(true);
    };

    const handleVoiceTranscript = (transcript: string, isFinal: boolean) => {
        if (isFinal) {
            // Append to input on final result
            setInput(prev => (prev ? prev + ' ' + transcript : transcript));
        }
    };

    if (!task) {
        return (
            <div className="terminal-panel empty">
                <Terminal size={48} />
                <p>Select a task to view its output</p>
            </div>
        );
    }

    const statusEmoji = {
        pending: '⏸️',
        running: '🔄',
        complete: '✅',
        error: '❌',
        cancelled: '🚫',
        stopped: '⏹️'
    }[task.status];

    return (
        <div className="terminal-panel">
            <div className="terminal-header">
                <button className="back-button" onClick={() => selectTask(null)}>
                    <ArrowLeft size={18} />
                    Back
                </button>
                <div className="terminal-title">
                    <Terminal size={18} />
                    <span>{task.name}</span>
                    <span className="status-badge">{statusEmoji} {task.status}</span>
                </div>
                <button
                    className={`copy-button ${copied ? 'copied' : ''}`}
                    onClick={copyTaskOutput}
                    title="Copy task output to clipboard"
                >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    {copied ? 'Copied!' : 'Copy'}
                </button>
            </div>

            <div className="tab-bar">
                <button
                    className={`tab ${activeTab === 'terminal' ? 'active' : ''}`}
                    onClick={() => setActiveTab('terminal')}
                >
                    <Terminal size={16} />
                    Terminal
                </button>
                <button
                    className={`tab ${activeTab === 'code' ? 'active' : ''}`}
                    onClick={() => setActiveTab('code')}
                >
                    <FileCode size={16} />
                    Code Changes
                </button>
            </div>

            {activeTab === 'terminal' ? (
                <>
                    <div
                        className="terminal-content"
                        ref={contentRef}
                        onScroll={handleScroll}
                    >
                        <div className="terminal-prompt">
                            &gt; claudia run
                        </div>
                        <div className="task-description-box">
                            {task.description}
                        </div>
                        {task.output.map((line, i) => (
                            <div key={i} className="terminal-line">
                                {line}
                            </div>
                        ))}
                        {task.status === 'running' && (
                            <div className="terminal-cursor">▌</div>
                        )}
                    </div>

                    {onSendInput && (
                        <form className="terminal-input-form" onSubmit={handleSendInput}>
                            {task.status === 'running' && onStopTask && !isInterrupting && (
                                <button
                                    type="button"
                                    onClick={handleInterrupt}
                                    className="interrupt-button"
                                    title="Interrupt task and provide new instructions"
                                >
                                    <StopCircle size={18} />
                                    Interrupt
                                </button>
                            )}
                            {voiceEnabled && (
                                <VoiceInput
                                    onTranscript={handleVoiceTranscript}
                                    disabled={task.status === 'running' && !isInterrupting}
                                />
                            )}
                            <input
                                type="text"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                placeholder={
                                    isInterrupting
                                        ? "Task interrupted. Type new instructions to resume..."
                                        : task.status === 'running'
                                            ? "Type a message..."
                                            : task.status === 'complete' || task.status === 'error' || task.status === 'stopped'
                                                ? "Task finished. Type to resume with new instructions..."
                                                : "Task pending. Type to start with instructions..."
                                }
                                className="terminal-input"
                                disabled={task.status === 'running' && !isInterrupting}
                            />
                            <button
                                type="submit"
                                disabled={!input.trim()}
                                className="terminal-send-button"
                            >
                                <Send size={18} />
                            </button>
                        </form>
                    )}
                </>
            ) : (
                <CodeViewer taskId={selectedTaskId!} />
            )}
        </div>
    );
}

