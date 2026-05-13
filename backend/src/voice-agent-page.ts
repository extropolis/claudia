/**
 * Voice Agent Page - Full-featured coding companion with chat UI, activity feed,
 * proactive suggestions, and rich voice interaction.
 *
 * Features:
 * - Chat-style conversation thread (not single transcript box)
 * - Activity feed showing real-time agent actions
 * - Proactive announcement toasts
 * - Suggestion chips for recommended actions
 * - Floating mini-mode (collapsible orb)
 * - Keyboard shortcuts (Space to talk, Esc to stop)
 * - Audio waveform visualization
 * - Voice I/O via Deepgram Nova-3 + ElevenLabs TTS
 */

export function getVoiceAgentPageHtml(wsUrl: string, token: string, deepgramApiKey: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>Claudia Voice Agent</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg: #0a0e14;
            --surface: #131920;
            --surface-2: #1a2130;
            --border: #2a3545;
            --text: #e6edf3;
            --text-muted: #7a8a9e;
            --accent: #58a6ff;
            --accent-dim: rgba(88, 166, 255, 0.15);
            --accent-glow: rgba(88, 166, 255, 0.3);
            --success: #3fb950;
            --success-dim: rgba(63, 185, 80, 0.15);
            --warning: #d29922;
            --warning-dim: rgba(210, 153, 34, 0.15);
            --error: #f85149;
            --error-dim: rgba(248, 81, 73, 0.15);
            --purple: #bc8cff;
            --purple-dim: rgba(188, 140, 255, 0.15);
            --radius: 12px;
            --radius-sm: 8px;
            --shadow: 0 4px 24px rgba(0,0,0,0.4);
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg);
            color: var(--text);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* ===== HEADER ===== */
        .header {
            padding: 0.75rem 1.25rem;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 50;
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .workspace-selector {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            margin-left: 1rem;
            padding-left: 1rem;
            border-left: 1px solid var(--border);
        }

        .workspace-selector select {
            background: var(--surface-2);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text);
            font-size: 0.8rem;
            padding: 0.35rem 0.6rem;
            outline: none;
            cursor: pointer;
            max-width: 200px;
            appearance: none;
            -webkit-appearance: none;
            padding-right: 1.5rem;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%237a8a9e'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 0.5rem center;
        }

        .workspace-selector select:hover {
            border-color: var(--accent);
        }

        .workspace-selector select:focus {
            border-color: var(--accent);
            box-shadow: 0 0 0 2px var(--accent-dim);
        }

        .workspace-label {
            font-size: 0.7rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }

        .header-logo {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--accent), var(--purple));
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1rem;
        }

        .header h1 {
            font-size: 1.1rem;
            font-weight: 600;
            letter-spacing: -0.02em;
        }

        .header-status {
            font-size: 0.75rem;
            color: var(--text-muted);
            display: flex;
            align-items: center;
            gap: 0.4rem;
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--success);
        }

        .status-dot.thinking {
            background: var(--accent);
            animation: pulse-dot 1.2s infinite;
        }

        @keyframes pulse-dot {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.8); }
        }

        .header-controls {
            display: flex;
            align-items: center;
            gap: 0.4rem;
        }

        .icon-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--text-muted);
            width: 34px;
            height: 34px;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 1rem;
            transition: all 0.15s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .icon-btn:hover {
            background: var(--surface-2);
            color: var(--text);
            border-color: var(--border);
        }

        .icon-btn.active {
            color: var(--accent);
            background: var(--accent-dim);
            border-color: rgba(88, 166, 255, 0.3);
        }

        .icon-btn.recording {
            color: white;
            background: var(--error);
            border-color: var(--error);
            animation: mic-pulse 1.5s infinite;
        }

        @keyframes mic-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(248, 81, 73, 0.4); }
            50% { box-shadow: 0 0 0 6px rgba(248, 81, 73, 0); }
        }

        .icon-btn.auto-active {
            color: #a78bfa;
            background: rgba(167, 139, 250, 0.15);
            border-color: rgba(167, 139, 250, 0.4);
            animation: auto-pulse 1.5s ease-in-out infinite;
        }

        @keyframes auto-pulse {
            0%, 100% { border-color: rgba(167, 139, 250, 0.4); }
            50% { border-color: rgba(167, 139, 250, 0.8); }
        }

        .input-row.auto-armed {
            box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.4), 0 0 8px rgba(167, 139, 250, 0.15);
        }

        /* ===== AUTONOMOUS MODE ===== */
        .autonomous-bar {
            display: none;
            padding: 0.5rem 1.25rem;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
            align-items: center;
            gap: 0.75rem;
        }

        .autonomous-bar.active {
            display: flex;
        }

        .auto-badge {
            display: flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.25rem 0.6rem;
            background: rgba(188, 140, 255, 0.1);
            border: 1px solid rgba(188, 140, 255, 0.3);
            border-radius: 20px;
            font-size: 0.7rem;
            color: #bc8cff;
            white-space: nowrap;
        }

        .auto-badge .auto-pulse {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #bc8cff;
            animation: autoPulse 2s infinite;
        }

        @keyframes autoPulse {
            0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(188, 140, 255, 0.5); }
            50% { opacity: 0.6; box-shadow: 0 0 0 4px rgba(188, 140, 255, 0); }
        }

        .auto-progress {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 0.6rem;
        }

        .auto-progress-bar {
            flex: 1;
            height: 4px;
            background: var(--surface-2);
            border-radius: 2px;
            overflow: hidden;
        }

        .auto-progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #58a6ff, #bc8cff);
            transition: width 0.5s ease;
            width: 0%;
        }

        .auto-progress-text {
            font-size: 0.7rem;
            color: var(--text-muted);
            white-space: nowrap;
        }

        .auto-controls {
            display: flex;
            gap: 0.3rem;
        }

        .auto-controls button {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-muted);
            width: 26px;
            height: 26px;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-size: 0.75rem;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
        }

        .auto-controls button:hover {
            background: var(--surface-2);
            color: var(--text);
        }

        .auto-controls button.danger:hover {
            background: rgba(248, 81, 73, 0.15);
            color: #f85149;
            border-color: rgba(248, 81, 73, 0.4);
        }

        .auto-progress-bar { cursor: pointer; }

        .auto-step-list {
            display: none;
            padding: 0.5rem 1.25rem 0.75rem;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
        }

        .auto-step-list.active { display: block; }

        .auto-step-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.25rem 0;
            font-size: 0.72rem;
            color: var(--text-muted);
        }

        .auto-step-item .auto-step-icon {
            width: 14px;
            text-align: center;
            flex-shrink: 0;
        }

        .auto-step-item.completed .auto-step-icon { color: #3fb950; }
        .auto-step-item.running .auto-step-icon { color: #58a6ff; }
        .auto-step-item.failed .auto-step-icon { color: #f85149; }
        .auto-step-item.pending .auto-step-icon { color: var(--text-muted); opacity: 0.5; }

        .auto-step-item.running { color: var(--text); font-weight: 500; }
        .auto-step-item.completed { color: var(--text-muted); }

        .auto-step-phase {
            font-size: 0.6rem;
            padding: 0.1rem 0.35rem;
            background: var(--surface-2);
            border-radius: 3px;
            color: var(--text-muted);
            margin-left: auto;
            flex-shrink: 0;
        }

        /* ===== MAIN LAYOUT ===== */
        .main-layout {
            flex: 1;
            display: flex;
            overflow: hidden;
        }

        /* ===== CHAT AREA ===== */
        .chat-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-width: 0;
        }

        .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 1.5rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
            scroll-behavior: smooth;
        }

        .chat-messages::-webkit-scrollbar { width: 4px; }
        .chat-messages::-webkit-scrollbar-track { background: transparent; }
        .chat-messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

        .message {
            display: flex;
            gap: 0.75rem;
            max-width: 85%;
            animation: msg-in 0.2s ease-out;
        }

        @keyframes msg-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.user {
            align-self: flex-end;
            flex-direction: row-reverse;
        }

        .message-avatar {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.75rem;
        }

        .message.user .message-avatar {
            background: var(--surface-2);
            border: 1px solid var(--border);
        }

        .message.assistant .message-avatar {
            background: linear-gradient(135deg, var(--accent), var(--purple));
        }

        .message-bubble {
            padding: 0.75rem 1rem;
            border-radius: var(--radius);
            line-height: 1.5;
            font-size: 0.9rem;
        }

        .message.user .message-bubble {
            background: var(--accent-dim);
            border: 1px solid rgba(88, 166, 255, 0.2);
            border-top-right-radius: 4px;
        }

        .message.assistant .message-bubble {
            background: var(--surface-2);
            border: 1px solid var(--border);
            border-top-left-radius: 4px;
        }

        .message-time {
            font-size: 0.65rem;
            color: var(--text-muted);
            margin-top: 0.3rem;
            opacity: 0;
            transition: opacity 0.15s;
        }

        .message:hover .message-time { opacity: 1; }

        .typing-indicator {
            display: flex;
            gap: 4px;
            padding: 0.75rem 1rem;
            align-items: center;
        }

        .typing-indicator span {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--text-muted);
            animation: typing 1.2s infinite;
        }

        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

        @keyframes typing {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
            30% { transform: translateY(-4px); opacity: 1; }
        }

        /* ===== SUGGESTIONS ===== */
        .suggestions-bar {
            padding: 0.5rem 1.5rem;
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
            border-top: 1px solid var(--border);
            background: var(--surface);
            display: none;
        }

        .suggestions-bar.visible { display: flex; }

        .suggestion-chip {
            padding: 0.4rem 0.75rem;
            background: var(--surface-2);
            border: 1px solid var(--border);
            border-radius: 20px;
            color: var(--text);
            font-size: 0.8rem;
            cursor: pointer;
            transition: all 0.15s;
            white-space: nowrap;
        }

        .suggestion-chip:hover {
            background: var(--accent-dim);
            border-color: var(--accent);
            color: var(--accent);
        }

        /* ===== INPUT AREA ===== */
        .input-area {
            padding: 1rem 1.5rem;
            background: var(--surface);
            border-top: 1px solid var(--border);
        }

        .input-row {
            display: flex;
            align-items: flex-end;
            gap: 0.5rem;
            background: var(--surface-2);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 0.5rem;
            transition: border-color 0.15s;
        }

        .input-row:focus-within {
            border-color: var(--accent);
            box-shadow: 0 0 0 2px var(--accent-dim);
        }

        .input-row textarea {
            flex: 1;
            background: transparent;
            border: none;
            color: var(--text);
            font-size: 0.9rem;
            font-family: inherit;
            resize: none;
            overflow-y: hidden;
            line-height: 1.4;
            max-height: 120px;
            padding: 0.4rem 0.5rem;
            outline: none;
        }

        .input-row textarea::placeholder { color: var(--text-muted); }

        .input-actions {
            display: flex;
            align-items: center;
            gap: 0.3rem;
        }

        .send-btn {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            border: none;
            background: var(--accent);
            color: var(--bg);
            font-size: 1rem;
            cursor: pointer;
            transition: all 0.15s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .send-btn:hover { transform: scale(1.05); }
        .send-btn:disabled { opacity: 0.3; cursor: not-allowed; transform: none; }

        .input-hint {
            font-size: 0.7rem;
            color: var(--text-muted);
            margin-top: 0.4rem;
            text-align: center;
        }

        .input-hint kbd {
            background: var(--surface-2);
            border: 1px solid var(--border);
            padding: 0.1rem 0.35rem;
            border-radius: 3px;
            font-family: inherit;
            font-size: 0.65rem;
        }

        /* ===== PREVIEW PANEL ===== */
        .preview-panel {
            display: none;
            flex-direction: column;
            border-left: 1px solid var(--border);
            background: var(--surface);
            width: 50%;
            min-width: 320px;
            max-width: 70%;
            position: relative;
        }

        .preview-panel.visible {
            display: flex;
        }

        .preview-header {
            padding: 0.5rem 0.75rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.78rem;
            color: var(--text-muted);
        }

        .preview-header label {
            font-weight: 500;
        }

        .preview-port-input {
            width: 70px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--text);
            font-size: 0.78rem;
            padding: 0.25rem 0.4rem;
            outline: none;
        }

        .preview-port-input:focus {
            border-color: var(--accent);
        }

        .preview-actions {
            margin-left: auto;
            display: flex;
            gap: 0.35rem;
        }

        .preview-actions button {
            background: var(--surface-2);
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--text-muted);
            font-size: 0.7rem;
            padding: 0.2rem 0.5rem;
            cursor: pointer;
        }

        .preview-actions button:hover {
            color: var(--text);
            border-color: var(--accent);
        }

        .preview-iframe-container {
            flex: 1;
            position: relative;
            background: var(--bg);
        }

        .preview-iframe-container iframe {
            width: 100%;
            height: 100%;
            border: none;
            background: #fff;
        }

        .preview-placeholder {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            color: var(--text-muted);
            font-size: 0.85rem;
            background: var(--bg);
        }

        .preview-placeholder .preview-icon {
            font-size: 2rem;
            opacity: 0.5;
        }

        /* ===== ACTIVITY SIDEBAR ===== */
        .activity-sidebar {
            width: 280px;
            background: var(--surface);
            border-left: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            transition: width 0.2s, opacity 0.2s;
            overflow: hidden;
        }

        .activity-sidebar.hidden {
            width: 0;
            opacity: 0;
            border: none;
        }

        .sidebar-header {
            padding: 0.75rem 1rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .sidebar-header h3 {
            font-size: 0.8rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-muted);
        }

        .activity-feed {
            flex: 1;
            overflow-y: auto;
            padding: 0.5rem;
        }

        .activity-feed::-webkit-scrollbar { width: 3px; }
        .activity-feed::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

        .activity-item {
            padding: 0.5rem 0.75rem;
            border-radius: var(--radius-sm);
            margin-bottom: 0.25rem;
            font-size: 0.78rem;
            line-height: 1.4;
            display: flex;
            align-items: flex-start;
            gap: 0.5rem;
            animation: activity-in 0.2s ease-out;
        }

        @keyframes activity-in {
            from { opacity: 0; transform: translateX(10px); }
            to { opacity: 1; transform: translateX(0); }
        }

        .activity-icon {
            flex-shrink: 0;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.6rem;
        }

        .activity-icon.task { background: var(--accent-dim); color: var(--accent); }
        .activity-icon.success { background: var(--success-dim); color: var(--success); }
        .activity-icon.error { background: var(--error-dim); color: var(--error); }
        .activity-icon.info { background: var(--purple-dim); color: var(--purple); }
        .activity-icon.warning { background: var(--warning-dim); color: var(--warning); }
        .activity-icon.auto { background: rgba(188, 140, 255, 0.1); color: #bc8cff; }

        .auto-update-text { color: #bc8cff; }

        .activity-text {
            flex: 1;
            color: var(--text-muted);
            min-width: 0;
        }

        .activity-text strong { color: var(--text); font-weight: 500; }

        .activity-time {
            font-size: 0.65rem;
            color: var(--text-muted);
            opacity: 0.6;
            flex-shrink: 0;
        }

        /* Task list in sidebar */
        .sidebar-section {
            padding: 0.75rem 1rem;
            border-top: 1px solid var(--border);
        }

        .sidebar-section h4 {
            font-size: 0.75rem;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 0.5rem;
        }

        .task-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.4rem 0.5rem;
            border-radius: 6px;
            margin-bottom: 0.2rem;
            font-size: 0.78rem;
            cursor: pointer;
            transition: background 0.1s;
        }

        .task-item:hover { background: var(--surface-2); }

        .task-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            flex-shrink: 0;
        }

        .task-dot.busy { background: var(--accent); animation: pulse-dot 1.2s infinite; }
        .task-dot.idle { background: var(--success); }
        .task-dot.waiting_input { background: var(--warning); }
        .task-dot.exited { background: var(--text-muted); }
        .task-dot.starting { background: var(--warning); animation: pulse-dot 1s infinite; }

        .task-name {
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--text);
        }

        .task-state {
            font-size: 0.65rem;
            color: var(--text-muted);
        }

        /* ===== TOAST NOTIFICATIONS ===== */
        .toast-container {
            position: fixed;
            top: 60px;
            right: 1rem;
            z-index: 1000;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .toast {
            background: var(--surface-2);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 0.75rem 1rem;
            box-shadow: var(--shadow);
            display: flex;
            align-items: center;
            gap: 0.6rem;
            min-width: 260px;
            max-width: 360px;
            animation: toast-in 0.3s ease-out;
            cursor: pointer;
            transition: opacity 0.2s;
        }

        .toast:hover { opacity: 0.85; }

        @keyframes toast-in {
            from { opacity: 0; transform: translateX(20px); }
            to { opacity: 1; transform: translateX(0); }
        }

        .toast.leaving {
            animation: toast-out 0.2s ease-in forwards;
        }

        @keyframes toast-out {
            to { opacity: 0; transform: translateX(20px); }
        }

        .toast-icon { font-size: 1rem; }
        .toast-text { font-size: 0.82rem; color: var(--text); flex: 1; }
        .toast-close { color: var(--text-muted); cursor: pointer; font-size: 0.9rem; }

        /* ===== WAVEFORM ===== */
        .waveform-container {
            display: none;
            align-items: center;
            justify-content: center;
            gap: 2px;
            height: 24px;
            padding: 0 0.5rem;
        }

        .waveform-container.active { display: flex; }

        .waveform-bar {
            width: 3px;
            height: 8px;
            background: var(--accent);
            border-radius: 2px;
            animation: wave 0.8s infinite ease-in-out;
        }

        .waveform-bar:nth-child(1) { animation-delay: 0s; }
        .waveform-bar:nth-child(2) { animation-delay: 0.1s; }
        .waveform-bar:nth-child(3) { animation-delay: 0.2s; }
        .waveform-bar:nth-child(4) { animation-delay: 0.3s; }
        .waveform-bar:nth-child(5) { animation-delay: 0.4s; }

        @keyframes wave {
            0%, 100% { height: 6px; opacity: 0.5; }
            50% { height: 20px; opacity: 1; }
        }

        /* ===== MINI MODE ===== */
        .mini-mode {
            display: none;
            position: fixed;
            bottom: 2rem;
            right: 2rem;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--accent), var(--purple));
            box-shadow: 0 4px 20px rgba(88, 166, 255, 0.3);
            cursor: pointer;
            z-index: 2000;
            align-items: center;
            justify-content: center;
            font-size: 1.3rem;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .mini-mode:hover {
            transform: scale(1.1);
            box-shadow: 0 6px 28px rgba(88, 166, 255, 0.5);
        }

        .mini-mode.has-notification {
            animation: orb-pulse 2s infinite;
        }

        @keyframes orb-pulse {
            0%, 100% { box-shadow: 0 4px 20px rgba(88, 166, 255, 0.3); }
            50% { box-shadow: 0 4px 30px rgba(88, 166, 255, 0.6); }
        }

        .mini-badge {
            position: absolute;
            top: -2px;
            right: -2px;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--error);
            color: white;
            font-size: 0.6rem;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
        }

        body.mini-active .header,
        body.mini-active .main-layout,
        body.mini-active .input-area { display: none; }
        body.mini-active .mini-mode { display: flex; }

        /* ===== SETTINGS MODAL ===== */
        .modal-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.7);
            z-index: 1500;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(4px);
        }

        .modal-overlay.show { display: flex; }

        .modal {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 1.5rem;
            max-width: 560px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: var(--shadow);
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.25rem;
        }

        .modal-title { font-size: 1.2rem; font-weight: 600; }

        .modal-tabs {
            display: flex;
            gap: 0;
            margin-bottom: 1.25rem;
            border-bottom: 1px solid var(--border);
        }

        .modal-tab {
            padding: 0.6rem 1rem;
            font-size: 0.82rem;
            color: var(--text-muted);
            cursor: pointer;
            border-bottom: 2px solid transparent;
            transition: all 0.15s;
        }

        .modal-tab:hover { color: var(--text); }
        .modal-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

        .modal-section { margin-bottom: 1rem; }
        .modal-label { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.4rem; }

        .modal-textarea {
            width: 100%;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--text);
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.8rem;
            padding: 0.75rem;
            resize: vertical;
            min-height: 120px;
            outline: none;
        }

        .modal-textarea:focus { border-color: var(--accent); }

        .voice-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 0.4rem;
        }

        .voice-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            cursor: pointer;
            transition: all 0.15s;
        }

        .voice-item:hover { border-color: var(--accent); background: var(--accent-dim); }
        .voice-item.selected { border-color: var(--success); background: var(--success-dim); }

        .voice-info { display: flex; flex-direction: column; gap: 0.15rem; }
        .voice-name { font-weight: 500; font-size: 0.88rem; }
        .voice-category { font-size: 0.75rem; color: var(--text-muted); }

        .voice-actions { display: flex; gap: 0.4rem; }

        .btn-sm {
            padding: 0.35rem 0.7rem;
            border-radius: 6px;
            border: 1px solid var(--border);
            background: var(--surface-2);
            color: var(--text);
            cursor: pointer;
            font-size: 0.78rem;
            transition: all 0.15s;
        }

        .btn-sm:hover { border-color: var(--accent); color: var(--accent); }

        /* ===== WELCOME STATE ===== */
        .welcome-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            flex: 1;
            gap: 1.5rem;
            padding: 2rem;
            text-align: center;
        }

        .welcome-orb {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--accent), var(--purple));
            opacity: 0.8;
            animation: float 4s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-8px); }
        }

        .welcome-text { font-size: 1.1rem; color: var(--text-muted); max-width: 400px; }
        .welcome-text strong { color: var(--text); }

        /* ===== RESPONSIVE ===== */
        @media (max-width: 768px) {
            .activity-sidebar { display: none; }
            .preview-panel { display: none !important; }
            .message { max-width: 92%; }
            .input-hint { display: none; }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-left">
            <div class="header-logo">C</div>
            <div>
                <h1>Claudia</h1>
                <div class="header-status">
                    <span class="status-dot" id="statusDot"></span>
                    <span id="statusText">Connected</span>
                </div>
            </div>
            <div class="workspace-selector">
                <span class="workspace-label">Workspace</span>
                <select id="workspaceSelect" onchange="onWorkspaceChange()">
                    <option value="">All workspaces</option>
                </select>
            </div>
        </div>
        <div class="header-controls">
            <div class="waveform-container" id="waveform">
                <div class="waveform-bar"></div>
                <div class="waveform-bar"></div>
                <div class="waveform-bar"></div>
                <div class="waveform-bar"></div>
                <div class="waveform-bar"></div>
            </div>
            <button class="icon-btn" id="autoModeToggle" onclick="toggleAutoMode()" title="Autonomous mode (G)">🤖</button>
            <button class="icon-btn active" id="micToggle" onclick="toggleRecording()" title="Microphone (M)">🎙️</button>
            <button class="icon-btn active" id="ttsToggle" onclick="toggleTtsEnabled()" title="Voice output (V)">🔊</button>
            <button class="icon-btn" id="previewToggle" onclick="togglePreview()" title="Preview (P)">🖥️</button>
            <button class="icon-btn" id="sidebarToggle" onclick="toggleSidebar()" title="Activity (A)">📋</button>
            <button class="icon-btn" onclick="toggleMiniMode()" title="Mini mode (Ctrl+M)">⊙</button>
            <button class="icon-btn" onclick="showSettings()" title="Settings">⚙️</button>
        </div>
    </div>

    <div class="autonomous-bar" id="autonomousBar">
        <div class="auto-badge">
            <span class="auto-pulse"></span>
            <span id="autoBadgeLabel">Autonomous</span>
        </div>
        <div class="auto-progress">
            <div class="auto-progress-bar">
                <div class="auto-progress-fill" id="autoProgressFill"></div>
            </div>
            <span class="auto-progress-text" id="autoProgressText">Planning...</span>
        </div>
        <div class="auto-controls">
            <button onclick="toggleAutonomousPause()" title="Pause/Resume" id="autoPauseBtn">⏸</button>
            <button class="danger" onclick="stopAutonomous()" title="Stop">■</button>
        </div>
    </div>
    <div class="auto-step-list" id="autoStepList"></div>

    <div class="main-layout">
        <div class="chat-area">
            <div class="chat-messages" id="chatMessages">
                <div class="welcome-state" id="welcomeState">
                    <div class="welcome-orb"></div>
                    <div class="welcome-text">
                        <strong>Hey! I'm your coding companion.</strong><br>
                        Ask me to create tasks, debug issues, run tests, or check on running work. I'll keep you updated on progress.
                    </div>
                </div>
            </div>

            <div class="suggestions-bar" id="suggestionsBar">
                <div class="suggestion-chip" onclick="sendSuggestion('What tasks are running?')">What's running?</div>
                <div class="suggestion-chip" onclick="sendSuggestion('Show me recent errors')">Recent errors</div>
                <div class="suggestion-chip" onclick="sendSuggestion('Run the tests')">Run tests</div>
                <div class="suggestion-chip" onclick="sendSuggestion('What should I work on next?')">Suggest work</div>
            </div>

            <div class="input-area">
                <div class="input-row">
                    <textarea id="textInput" placeholder="Ask me anything..." rows="1"></textarea>
                    <div class="input-actions">
                        <button class="send-btn" id="sendButton" onclick="sendTextMessage()" title="Send (Enter)">↑</button>
                    </div>
                </div>
                <div class="input-hint">
                    <kbd>Enter</kbd> send · <kbd>M</kbd> toggle mic · <kbd>Esc</kbd> stop
                </div>
            </div>
        </div>

        <div class="preview-panel" id="previewPanel">
            <div class="preview-header">
                <label>Preview</label>
                <input type="number" class="preview-port-input" id="previewPortInput" placeholder="Port" min="1" max="65535" onchange="loadPreview()" onkeydown="if(event.key==='Enter')loadPreview()">
                <div class="preview-actions">
                    <button onclick="refreshPreview()" title="Refresh">↻</button>
                    <button onclick="togglePreview()" title="Close">✕</button>
                </div>
            </div>
            <div class="preview-iframe-container" id="previewContainer">
                <div class="preview-placeholder" id="previewPlaceholder">
                    <div class="preview-icon">🖥️</div>
                    <div>Enter a port number to preview your app</div>
                </div>
                <iframe id="previewIframe" style="display:none;"></iframe>
            </div>
        </div>

        <div class="activity-sidebar" id="activitySidebar">
            <div class="sidebar-header">
                <h3>Activity</h3>
                <button class="icon-btn" onclick="clearActivity()" title="Clear" style="width:24px;height:24px;font-size:0.7rem;">✕</button>
            </div>
            <div class="activity-feed" id="activityFeed">
                <div class="activity-item">
                    <div class="activity-icon info">●</div>
                    <div class="activity-text">Voice agent <strong>ready</strong></div>
                    <div class="activity-time">now</div>
                </div>
            </div>
            <div class="sidebar-section" id="taskSection">
                <h4>Tasks</h4>
                <div id="taskList" style="color:var(--text-muted);font-size:0.78rem;font-style:italic;">No active tasks</div>
            </div>
        </div>
    </div>

    <!-- Mini Mode Orb -->
    <div class="mini-mode" id="miniMode" onclick="toggleMiniMode()">🎤</div>

    <!-- Toast Container -->
    <div class="toast-container" id="toastContainer"></div>

    <!-- Settings Modal -->
    <div class="modal-overlay" id="settingsModal">
        <div class="modal">
            <div class="modal-header">
                <h2 class="modal-title">Settings</h2>
                <button class="icon-btn" onclick="closeSettings()" style="font-size:1.2rem;">✕</button>
            </div>
            <div class="modal-tabs">
                <div class="modal-tab active" onclick="switchTab('voice')">Voice</div>
                <div class="modal-tab" onclick="switchTab('persona')">Persona</div>
                <div class="modal-tab" onclick="switchTab('behavior')">Behavior</div>
            </div>
            <div id="settingsContent">
                <div class="modal-section" id="tabVoice"></div>
                <div class="modal-section" id="tabPersona" style="display:none;">
                    <div class="modal-label">System Prompt (customize how the agent behaves)</div>
                    <textarea class="modal-textarea" id="systemPromptInput" placeholder="You are a voice assistant..."></textarea>
                    <button class="btn-sm" style="margin-top:0.5rem;" onclick="saveSystemPrompt()">Save Prompt</button>
                </div>
                <div class="modal-section" id="tabBehavior" style="display:none;">
                    <div class="modal-label">Proactive Announcements</div>
                    <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;margin:0.5rem 0;cursor:pointer;">
                        <input type="checkbox" id="announceTaskComplete" checked onchange="saveBehavior()"> Announce when tasks complete
                    </label>
                    <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;margin:0.5rem 0;cursor:pointer;">
                        <input type="checkbox" id="announceErrors" checked onchange="saveBehavior()"> Announce errors
                    </label>
                    <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;margin:0.5rem 0;cursor:pointer;">
                        <input type="checkbox" id="proactiveUpdates" checked onchange="saveBehavior()"> Proactive task updates (every 60s)
                    </label>
                    <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;margin:0.5rem 0;cursor:pointer;">
                        <input type="checkbox" id="showSuggestions" checked onchange="saveBehavior()"> Show action suggestions
                    </label>
                    <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;margin:0.5rem 0;cursor:pointer;">
                        <input type="checkbox" id="autoListenAfterResponse" onchange="saveBehavior()"> Auto-listen after response
                    </label>
                </div>
            </div>
        </div>
    </div>

    <script>
        const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const WS_URL = WS_PROTOCOL + '//' + window.location.host;
        const TOKEN = '${token}';
        let DEEPGRAM_API_KEY = '${deepgramApiKey}';

        // State
        let ws = null;
        let mediaRecorder = null;
        let deepgramSocket = null;
        let isRecording = false;
        let ttsEnabled = localStorage.getItem('voiceTtsEnabled') !== 'false';
        let sidebarVisible = localStorage.getItem('voiceSidebarVisible') !== 'false';
        let isMiniMode = false;
        let allTasks = [];
        let allWorkspaces = [];
        let selectedWorkspaceId = localStorage.getItem('voiceSelectedWorkspace') || '';
        let pendingNotifications = 0;
        let currentStreamingMsg = null;
        let isProcessing = false;
        const voiceTaskIds = new Set(JSON.parse(localStorage.getItem('voiceTaskIds') || '[]'));

        // Behavior settings
        let behavior = JSON.parse(localStorage.getItem('voiceBehavior') || '{}');
        behavior = {
            announceTaskComplete: behavior.announceTaskComplete !== false,
            announceErrors: behavior.announceErrors !== false,
            showSuggestions: behavior.showSuggestions !== false,
            proactiveUpdates: behavior.proactiveUpdates !== false,
            autoListenAfterResponse: behavior.autoListenAfterResponse || false,
            ...behavior
        };

        // ===== INITIALIZATION =====
        function init() {
            document.getElementById('micToggle').classList.toggle('active', false);
            document.getElementById('ttsToggle').classList.toggle('active', ttsEnabled);
            document.getElementById('sidebarToggle').classList.toggle('active', sidebarVisible);
            document.getElementById('activitySidebar').classList.toggle('hidden', !sidebarVisible);

            if (behavior.showSuggestions) {
                document.getElementById('suggestionsBar').classList.add('visible');
            }

            // Fetch fresh Deepgram API key from backend config
            fetch('/api/config')
                .then(r => r.json())
                .then(config => {
                    if (config.deepgramApiKey && config.deepgramApiKey !== DEEPGRAM_API_KEY) {
                        console.log('[Voice] Updated Deepgram API key from config');
                        DEEPGRAM_API_KEY = config.deepgramApiKey;
                    }
                    if (!DEEPGRAM_API_KEY) {
                        addActivity('warning', 'Deepgram API key not set — voice input disabled');
                    }
                })
                .catch(err => console.warn('[Voice] Could not fetch config:', err));

            initWebSocket();
            initTextInput();
            initKeyboardShortcuts();

            document.querySelector('.auto-progress').addEventListener('click', () => {
                document.getElementById('autoStepList').classList.toggle('active');
            });
        }

        // ===== WORKSPACE SELECTOR =====
        function onWorkspaceChange() {
            const select = document.getElementById('workspaceSelect');
            selectedWorkspaceId = select.value;
            localStorage.setItem('voiceSelectedWorkspace', selectedWorkspaceId);
            renderTaskList();
            updatePreviewPortFromWorkspace();
            addActivity('info', selectedWorkspaceId
                ? \`Focused on workspace: <strong>\${escapeHtml(getWorkspaceName(selectedWorkspaceId))}</strong>\`
                : 'Showing all workspaces');
        }

        function renderWorkspaceSelector() {
            const select = document.getElementById('workspaceSelect');
            const current = selectedWorkspaceId;
            select.innerHTML = '<option value="">All workspaces</option>';
            allWorkspaces.forEach(ws => {
                const name = ws.displayName || ws.name || ws.id;
                const opt = document.createElement('option');
                opt.value = ws.id;
                opt.textContent = name;
                if (ws.id === current) opt.selected = true;
                select.appendChild(opt);
            });
            // If stored workspace not in list, auto-select first with active tasks
            if (current && !allWorkspaces.find(w => w.id === current)) {
                const busyTask = allTasks.find(t => t.state === 'busy');
                if (busyTask && busyTask.workspaceId) {
                    selectedWorkspaceId = busyTask.workspaceId;
                    select.value = selectedWorkspaceId;
                    localStorage.setItem('voiceSelectedWorkspace', selectedWorkspaceId);
                }
            }
        }

        function getWorkspaceName(id) {
            const ws = allWorkspaces.find(w => w.id === id);
            if (ws) return ws.displayName || ws.name || ws.id;
            if (!id) return 'All';
            const parts = id.replace(/\\\\/g, '/').split('/');
            return parts[parts.length - 1] || id;
        }

        function getFilteredTasks() {
            let tasks = allTasks;
            if (selectedWorkspaceId) {
                tasks = tasks.filter(t => t.workspaceId === selectedWorkspaceId);
            }
            // Default filter: only show voice-created tasks
            if (voiceTaskIds.size > 0) {
                tasks = tasks.filter(t => voiceTaskIds.has(t.id));
            }
            return tasks;
        }
        function initWebSocket() {
            ws = new WebSocket(\`\${WS_URL}/ws?token=\${TOKEN}&voice=1\`);

            ws.onopen = () => {
                console.log('[Voice] WebSocket connected');
                setStatus('Connected', false);
                addActivity('info', 'Connected to server');
            };

            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                handleWSMessage(message);
            };

            ws.onerror = (error) => {
                console.error('[Voice] WebSocket error:', error);
                setStatus('Connection error', false);
                addActivity('error', 'Connection error');
            };

            ws.onclose = () => {
                console.log('[Voice] WebSocket closed, reconnecting...');
                setStatus('Reconnecting...', false);
                setTimeout(initWebSocket, 2000);
            };
        }

        function handleWSMessage(message) {
            console.log('[Voice WS]', message.type, message.payload);

            // Task messages
            handleTaskMessages(message);

            switch (message.type) {
                case 'voice:announce':
                    handleAnnouncement(message.payload);
                    break;
                case 'voice:proactive_update':
                    handleProactiveUpdate(message.payload);
                    break;
                case 'voice:autonomous_update':
                    handleAutonomousUpdate(message.payload);
                    break;
                case 'voice:autonomous_status':
                    handleAutonomousStatus(message.payload);
                    break;
                case 'voice:status':
                    if (message.payload.status === 'processing') {
                        setStatus('Thinking...', true);
                        isProcessing = true;
                        startStreamingMessage();
                    }
                    break;
                case 'voice:text_chunk':
                    appendToStreamingMessage(message.payload.text);
                    break;
                case 'voice:response':
                    finalizeStreamingMessage(message.payload.text);
                    setStatus('Connected', false);
                    isProcessing = false;
                    if (message.payload.text && message.payload.action !== 'error') {
                        playTTS(message.payload.text);
                    }
                    break;
            }
        }

        // ===== CHAT MESSAGES =====
        function hideWelcome() {
            const el = document.getElementById('welcomeState');
            if (el) el.style.display = 'none';
        }

        function addChatMessage(role, text) {
            hideWelcome();
            const container = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.className = 'message ' + role;

            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const avatar = role === 'user' ? '👤' : '✦';

            div.innerHTML = \`
                <div class="message-avatar">\${avatar}</div>
                <div>
                    <div class="message-bubble">\${escapeHtml(text)}</div>
                    <div class="message-time">\${time}</div>
                </div>
            \`;

            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
            return div;
        }

        function startStreamingMessage() {
            hideWelcome();
            const container = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.className = 'message assistant';
            div.id = 'streamingMsg';

            div.innerHTML = \`
                <div class="message-avatar">✦</div>
                <div>
                    <div class="message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>
                    <div class="message-time"></div>
                </div>
            \`;

            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
            currentStreamingMsg = div;
        }

        function appendToStreamingMessage(text) {
            if (!currentStreamingMsg) startStreamingMessage();
            const bubble = currentStreamingMsg.querySelector('.message-bubble');
            if (bubble.querySelector('.typing-indicator')) {
                bubble.innerHTML = '';
            }
            bubble.textContent += text;
            const container = document.getElementById('chatMessages');
            container.scrollTop = container.scrollHeight;
        }

        function finalizeStreamingMessage(fullText) {
            if (currentStreamingMsg) {
                const bubble = currentStreamingMsg.querySelector('.message-bubble');
                const timeEl = currentStreamingMsg.querySelector('.message-time');
                if (fullText) bubble.textContent = fullText;
                timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                currentStreamingMsg.removeAttribute('id');
                currentStreamingMsg = null;
            } else if (fullText) {
                addChatMessage('assistant', fullText);
            }
        }

        // ===== ANNOUNCEMENTS & TOASTS =====
        function handleAnnouncement(payload) {
            const text = payload.text || payload;
            showToast(text, 'info');
            addActivity('info', text);
            if (ttsEnabled) playTTS(text);
            if (isMiniMode) {
                pendingNotifications++;
                updateMiniBadge();
            }
        }

        function handleProactiveUpdate(payload) {
            if (!behavior.proactiveUpdates) return;
            const text = payload.text || '';
            if (!text) return;
            addChatMessage('assistant', text);
            addActivity('task', \`<strong>Update:</strong> \${escapeHtml(text)}\`);
            if (ttsEnabled) playTTS(text);
            if (isMiniMode) {
                pendingNotifications++;
                updateMiniBadge();
            }
        }

        // ===== AUTONOMOUS MODE =====
        function handleAutonomousUpdate(payload) {
            const text = payload.text || '';
            if (!text) return;
            addActivity('auto', \`<span class="auto-update-text">\${escapeHtml(text)}</span>\`);
        }

        function handleAutonomousStatus(payload) {
            const bar = document.getElementById('autonomousBar');
            const stepList = document.getElementById('autoStepList');
            if (!payload || payload.state === 'idle' || payload.state === 'complete' || payload.state === 'failed') {
                bar.classList.remove('active');
                stepList.classList.remove('active');
                stepList.innerHTML = '';
                if (payload && (payload.state === 'complete' || payload.state === 'failed')) {
                    addActivity('info', \`Autonomous mode \${payload.state}.\`);
                }
                return;
            }

            bar.classList.add('active');

            const completedSteps = payload.completedSteps || 0;
            const totalSteps = payload.totalSteps || 1;
            const pct = Math.round((completedSteps / totalSteps) * 100);

            document.getElementById('autoProgressFill').style.width = pct + '%';

            // Build progress text based on state
            let progressText = '';
            const elapsed = payload.elapsedMs ? formatElapsed(payload.elapsedMs) : '';
            if (payload.state === 'testing') {
                progressText = \`\${payload.currentStepDescription || 'Running tests'} (\${completedSteps}/\${totalSteps} done)\`;
            } else if (payload.state === 'planning') {
                progressText = 'Generating plan...';
            } else if (payload.activeTasks && payload.activeTasks.length > 1) {
                const descriptions = payload.activeTasks.map(t => t.description).join(' + ');
                const activeNums = payload.activeTasks.map((_, i) => completedSteps + 1 + i);
                progressText = \`Steps \${activeNums[0]}-\${activeNums[activeNums.length-1]}/\${totalSteps}: \${descriptions}\`;
            } else {
                const stepNum = Math.min(completedSteps + 1, totalSteps);
                progressText = \`Step \${stepNum}/\${totalSteps}: \${payload.currentStepDescription || payload.state}\`;
            }
            if (elapsed) progressText += \` · \${elapsed}\`;
            document.getElementById('autoProgressText').textContent = progressText;

            // Badge label shows phase
            let badgeLabel = 'Autonomous';
            if (payload.state === 'paused') badgeLabel = 'Paused';
            else if (payload.currentPhase) badgeLabel = payload.currentPhase;
            document.getElementById('autoBadgeLabel').textContent = badgeLabel;

            const pauseBtn = document.getElementById('autoPauseBtn');
            pauseBtn.textContent = payload.state === 'paused' ? '▶' : '⏸';

            // Render step list
            if (payload.steps && payload.steps.length > 0) {
                stepList.innerHTML = payload.steps.map(step => {
                    let icon = '○';
                    let statusClass = 'pending';
                    if (step.status === 'completed') { icon = '✓'; statusClass = 'completed'; }
                    else if (step.status === 'in_progress' || step.status === 'running') { icon = '●'; statusClass = 'running'; }
                    else if (step.status === 'failed') { icon = '✗'; statusClass = 'failed'; }
                    return \`<div class="auto-step-item \${statusClass}"><span class="auto-step-icon">\${icon}</span><span class="auto-step-desc">\${escapeHtml(step.description)}</span>\${step.phase ? \`<span class="auto-step-phase">\${escapeHtml(step.phase)}</span>\` : ''}</div>\`;
                }).join('');
            }
        }

        function formatElapsed(ms) {
            const s = Math.floor(ms / 1000);
            if (s < 60) return s + 's';
            const m = Math.floor(s / 60);
            if (m < 60) return m + 'm ' + (s % 60) + 's';
            return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
        }

        function toggleAutonomousPause() {
            sendVoiceInput('pause autonomous mode');
        }

        function stopAutonomous() {
            if (confirm('Stop autonomous mode? Running tasks will be stopped.')) {
                sendVoiceInput('stop autonomous mode');
            }
        }

        function showToast(text, type = 'info') {
            const container = document.getElementById('toastContainer');
            const icons = { info: '💬', success: '✓', error: '✗', warning: '⚠' };
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.innerHTML = \`
                <span class="toast-icon">\${icons[type] || icons.info}</span>
                <span class="toast-text">\${escapeHtml(text)}</span>
                <span class="toast-close" onclick="this.parentElement.remove()">✕</span>
            \`;
            toast.onclick = () => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 200); };
            container.appendChild(toast);
            setTimeout(() => { if (toast.parentElement) { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 200); } }, 6000);
        }

        // ===== ACTIVITY FEED =====
        function addActivity(type, text) {
            const feed = document.getElementById('activityFeed');
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const item = document.createElement('div');
            item.className = 'activity-item';
            item.innerHTML = \`
                <div class="activity-icon \${type}">●</div>
                <div class="activity-text">\${text}</div>
                <div class="activity-time">\${time}</div>
            \`;
            feed.appendChild(item);
            feed.scrollTop = feed.scrollHeight;

            // Keep max 50 items
            while (feed.children.length > 50) feed.removeChild(feed.firstChild);
        }

        function clearActivity() {
            document.getElementById('activityFeed').innerHTML = '';
            addActivity('info', 'Activity cleared');
        }

        // ===== TASK PANEL =====
        function handleTaskMessages(message) {
            if (message.type === 'init') {
                allTasks = message.payload.tasks || [];
                allWorkspaces = message.payload.workspaces || [];
                renderWorkspaceSelector();
                renderTaskList();
            } else if (message.type === 'task:created') {
                const task = message.payload.task;
                if (task) {
                    const idx = allTasks.findIndex(t => t.id === task.id);
                    if (idx >= 0) allTasks[idx] = task;
                    else allTasks.push(task);
                    if (message.payload.source === 'voice') {
                        voiceTaskIds.add(task.id);
                        localStorage.setItem('voiceTaskIds', JSON.stringify([...voiceTaskIds]));
                        console.log('[Voice] Tracked voice task:', task.id);
                    }
                    renderTaskList();
                }
            } else if (message.type === 'tasks:updated') {
                const oldTasks = [...allTasks];
                allTasks = message.payload.tasks || [];
                checkTaskTransitions(oldTasks, allTasks);
                renderTaskList();
            } else if (message.type === 'task:stateChanged') {
                const updated = message.payload.task;
                if (updated) {
                    const idx = allTasks.findIndex(t => t.id === updated.id);
                    const oldState = idx >= 0 ? allTasks[idx].state : null;
                    if (idx >= 0) allTasks[idx] = updated;
                    else allTasks.push(updated);

                    // Proactive announcements (only for selected workspace)
                    if (oldState && oldState !== updated.state) {
                        if (!selectedWorkspaceId || updated.workspaceId === selectedWorkspaceId) {
                            onTaskStateChange(updated, oldState);
                        }
                    }
                    renderTaskList();
                }
            } else if (message.type === 'workspace:created') {
                const ws = message.payload.workspace;
                if (ws && !allWorkspaces.find(w => w.id === ws.id)) {
                    allWorkspaces.push(ws);
                    renderWorkspaceSelector();
                }
            }
        }

        function checkTaskTransitions(oldTasks, newTasks) {
            for (const newT of newTasks) {
                const oldT = oldTasks.find(t => t.id === newT.id);
                if (oldT && oldT.state !== newT.state) {
                    onTaskStateChange(newT, oldT.state);
                }
            }
        }

        function onTaskStateChange(task, oldState) {
            const name = task.displayName || task.prompt?.substring(0, 40) || task.id;

            if (task.state === 'exited' && oldState === 'busy') {
                addActivity('success', \`Task <strong>\${escapeHtml(name)}</strong> completed\`);
                if (behavior.announceTaskComplete) {
                    showToast(\`Task completed: \${name}\`, 'success');
                    if (ttsEnabled) playTTS(\`Task completed: \${name}\`);
                }
            } else if (task.state === 'waiting_input') {
                addActivity('warning', \`Task <strong>\${escapeHtml(name)}</strong> needs input\`);
                showToast(\`\${name} is waiting for input\`, 'warning');
            } else if (task.state === 'busy' && oldState !== 'busy') {
                addActivity('task', \`Task <strong>\${escapeHtml(name)}</strong> started\`);
            }
        }

        function renderTaskList() {
            const container = document.getElementById('taskList');
            const filtered = getFilteredTasks();
            const activeTasks = filtered.filter(t => ['busy', 'starting', 'waiting_input', 'idle'].includes(t.state));

            if (activeTasks.length === 0) {
                container.innerHTML = '<div style="color:var(--text-muted);font-size:0.78rem;font-style:italic;">No active tasks</div>';
                return;
            }

            container.innerHTML = activeTasks.map(t => {
                const name = t.displayName || t.prompt?.substring(0, 35) || t.id;
                return \`<div class="task-item" onclick="sendSuggestion('What is the status of task \${t.id}?')">
                    <div class="task-dot \${t.state}"></div>
                    <div class="task-name">\${escapeHtml(name)}</div>
                    <div class="task-state">\${t.state}</div>
                </div>\`;
            }).join('');
        }

        // ===== VOICE INPUT/OUTPUT =====
        function toggleTtsEnabled() {
            ttsEnabled = !ttsEnabled;
            localStorage.setItem('voiceTtsEnabled', ttsEnabled);
            document.getElementById('ttsToggle').classList.toggle('active', ttsEnabled);
        }

        let autoModeArmed = false;

        function toggleAutoMode() {
            autoModeArmed = !autoModeArmed;
            document.getElementById('autoModeToggle').classList.toggle('auto-active', autoModeArmed);
            document.getElementById('textInput').placeholder = autoModeArmed ? 'Describe your goal...' : 'Ask me anything...';
            document.querySelector('.input-row').classList.toggle('auto-armed', autoModeArmed);
        }

        async function toggleRecording() {
            if (isRecording) stopRecording();
            else await startRecording();
        }

        function getSupportedMimeType() {
            const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
            for (const t of types) {
                if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
            }
            return '';
        }

        async function startRecording() {
            try {
                if (!DEEPGRAM_API_KEY) {
                    showToast('Deepgram API key not configured. Set it in Claudia Settings > Voice.', 'error');
                    setStatus('No API key', false);
                    addActivity('error', 'Deepgram API key not configured');
                    return;
                }

                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const mimeType = getSupportedMimeType();
                const isContainerized = mimeType.includes('webm') || mimeType.includes('mp4') || mimeType.includes('ogg');
                const dgParams = 'model=nova-3&language=en&smart_format=true&punctuate=true&interim_results=true';
                const dgUrl = isContainerized
                    ? 'wss://api.deepgram.com/v1/listen?' + dgParams
                    : 'wss://api.deepgram.com/v1/listen?' + dgParams + '&encoding=linear16&sample_rate=48000';

                console.log('[Voice] Connecting to Deepgram...', { mimeType, isContainerized });
                deepgramSocket = new WebSocket(dgUrl, ['token', DEEPGRAM_API_KEY]);

                deepgramSocket.onopen = () => {
                    console.log('[Voice] Deepgram WebSocket connected');
                    setStatus('Listening...', true);
                    document.getElementById('waveform').classList.add('active');
                };

                deepgramSocket.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    console.log('[Voice] Deepgram msg:', data.type, data.channel?.alternatives?.[0]?.transcript || '');
                    if (data.type === 'Results') {
                        const transcript = data.channel?.alternatives?.[0]?.transcript || '';
                        if (!transcript.trim()) return;
                        if (data.is_final === true) {
                            sendVoiceInput(transcript);
                        }
                    } else if (data.type === 'Error') {
                        console.error('[Voice] Deepgram error:', data);
                        showToast('Deepgram error: ' + (data.description || data.message || 'Unknown'), 'error');
                        addActivity('error', 'Deepgram: ' + (data.description || data.message || 'Unknown error'));
                    }
                };

                deepgramSocket.onerror = (err) => {
                    console.error('[Voice] Deepgram WebSocket error:', err);
                    setStatus('Recognition error', false);
                    showToast('Failed to connect to Deepgram. Check API key.', 'error');
                    addActivity('error', 'Deepgram connection failed');
                };

                deepgramSocket.onclose = (event) => {
                    console.log('[Voice] Deepgram closed:', event.code, event.reason);
                    if (isRecording && event.code !== 1000) {
                        showToast('Deepgram disconnected (code ' + event.code + '). Check API key.', 'error');
                        addActivity('error', 'Deepgram disconnected (code ' + event.code + ')');
                        stopRecording();
                    }
                };

                let pendingChunks = [];
                const recorderOptions = mimeType ? { mimeType } : {};
                mediaRecorder = new MediaRecorder(stream, recorderOptions);

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size === 0) return;
                    if (deepgramSocket?.readyState === WebSocket.OPEN) {
                        if (pendingChunks.length > 0) {
                            for (const chunk of pendingChunks) deepgramSocket.send(chunk);
                            pendingChunks = [];
                        }
                        deepgramSocket.send(event.data);
                    } else if (deepgramSocket?.readyState === WebSocket.CONNECTING) {
                        pendingChunks.push(event.data);
                    }
                };

                mediaRecorder.start(250);
                isRecording = true;
                document.getElementById('micToggle').classList.add('recording');
                document.getElementById('micToggle').classList.add('active');
                addActivity('info', 'Listening...');
            } catch (error) {
                console.error('[Voice] Mic error:', error);
                setStatus('Microphone access denied', false);
                showToast('Microphone access denied', 'error');
            }
        }

        function stopRecording() {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
                mediaRecorder.stream.getTracks().forEach(track => track.stop());
            }
            if (deepgramSocket) deepgramSocket.close();
            isRecording = false;
            document.getElementById('micToggle').classList.remove('recording');
            document.getElementById('micToggle').classList.remove('active');
            document.getElementById('waveform').classList.remove('active');
            setStatus('Connected', false);
        }

        function sendVoiceInput(text) {
            if (!text.trim()) return;
            addChatMessage('user', text);
            if (ws && ws.readyState === WebSocket.OPEN) {
                const payload = { text, workspaceId: selectedWorkspaceId || undefined, autonomous: autoModeArmed || undefined };
                ws.send(JSON.stringify({ type: 'voice:input', payload }));
            }
            if (autoModeArmed) {
                autoModeArmed = false;
                document.getElementById('autoModeToggle').classList.remove('auto-active');
                document.getElementById('textInput').placeholder = 'Ask me anything...';
                document.querySelector('.input-row').classList.remove('auto-armed');
            }
        }

        function sendTextMessage() {
            const input = document.getElementById('textInput');
            const text = input.value.trim();
            if (!text) return;
            addChatMessage('user', text);
            if (ws && ws.readyState === WebSocket.OPEN) {
                const payload = { text, workspaceId: selectedWorkspaceId || undefined, autonomous: autoModeArmed || undefined };
                ws.send(JSON.stringify({ type: 'voice:input', payload }));
            }
            if (autoModeArmed) {
                autoModeArmed = false;
                document.getElementById('autoModeToggle').classList.remove('auto-active');
                document.getElementById('textInput').placeholder = 'Ask me anything...';
                document.querySelector('.input-row').classList.remove('auto-armed');
            }
            input.value = '';
            input.style.height = 'auto';
        }

        function sendSuggestion(text) {
            addChatMessage('user', text);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'voice:input', payload: { text, workspaceId: selectedWorkspaceId || undefined } }));
            }
        }

        async function playTTS(text) {
            if (!ttsEnabled || !text?.trim()) return;
            try {
                const voiceName = localStorage.getItem('elevenLabsVoiceName') || 'charlotte';
                const response = await fetch('/api/tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, voice: voiceName })
                });
                if (!response.ok) return;
                const audioBlob = await response.blob();
                const audioUrl = URL.createObjectURL(audioBlob);
                const audio = new Audio(audioUrl);
                audio.onended = () => URL.revokeObjectURL(audioUrl);
                await audio.play();
            } catch (error) {
                console.error('[Voice TTS] Error:', error);
            }
        }

        // ===== UI HELPERS =====
        function setStatus(text, active) {
            document.getElementById('statusText').textContent = text;
            document.getElementById('statusDot').classList.toggle('thinking', active);
        }

        function toggleSidebar() {
            sidebarVisible = !sidebarVisible;
            localStorage.setItem('voiceSidebarVisible', sidebarVisible);
            document.getElementById('activitySidebar').classList.toggle('hidden', !sidebarVisible);
            document.getElementById('sidebarToggle').classList.toggle('active', sidebarVisible);
        }

        // ===== PREVIEW PANEL =====
        let previewVisible = false;
        let previewPort = parseInt(localStorage.getItem('voicePreviewPort') || '0', 10) || 0;

        function togglePreview() {
            previewVisible = !previewVisible;
            document.getElementById('previewPanel').classList.toggle('visible', previewVisible);
            document.getElementById('previewToggle').classList.toggle('active', previewVisible);
            if (previewVisible && previewPort) {
                document.getElementById('previewPortInput').value = previewPort;
                loadPreview();
            }
        }

        function loadPreview() {
            const input = document.getElementById('previewPortInput');
            const port = parseInt(input.value, 10);
            if (!port || port < 1 || port > 65535) return;
            previewPort = port;
            localStorage.setItem('voicePreviewPort', String(port));
            const iframe = document.getElementById('previewIframe');
            const placeholder = document.getElementById('previewPlaceholder');

            // Use direct localhost URL for local access (avoids Vite module path issues)
            // Use proxy only for tunnel access
            const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            const previewUrl = isLocal ? \`http://localhost:\${port}/\` : \`/api/preview/\${port}/\`;

            // Check if dev server is reachable
            fetch(\`/api/preview/\${port}/\`).then(res => {
                if (res.ok) {
                    iframe.src = previewUrl;
                    iframe.style.display = 'block';
                    placeholder.style.display = 'none';
                } else {
                    iframe.style.display = 'none';
                    placeholder.innerHTML = \`<div class="preview-icon">⚠️</div><div>Dev server not running on port \${port}</div><div style="font-size:0.75rem;margin-top:0.25rem;color:var(--text-muted)">Start your dev server and try again</div>\`;
                    placeholder.style.display = 'flex';
                }
            }).catch(() => {
                iframe.style.display = 'none';
                placeholder.innerHTML = '<div class="preview-icon">⚠️</div><div>Could not reach preview server</div>';
                placeholder.style.display = 'flex';
            });
            console.log('[Preview] Loading port', port, isLocal ? '(direct)' : '(proxy)');
        }

        function refreshPreview() {
            const iframe = document.getElementById('previewIframe');
            if (iframe.src && iframe.style.display !== 'none') {
                iframe.src = iframe.src;
            }
        }

        // Auto-load preview port from workspace if available
        function updatePreviewPortFromWorkspace() {
            if (selectedWorkspaceId) {
                const ws = allWorkspaces.find(w => w.id === selectedWorkspaceId);
                if (ws && ws.previewPort) {
                    previewPort = ws.previewPort;
                    localStorage.setItem('voicePreviewPort', String(previewPort));
                    const input = document.getElementById('previewPortInput');
                    if (input) input.value = previewPort;
                    if (previewVisible) loadPreview();
                }
            }
        }

        function toggleMiniMode() {
            isMiniMode = !isMiniMode;
            document.body.classList.toggle('mini-active', isMiniMode);
            if (!isMiniMode) {
                pendingNotifications = 0;
                updateMiniBadge();
            }
        }

        function updateMiniBadge() {
            const badge = document.getElementById('miniMode').querySelector('.mini-badge');
            if (pendingNotifications > 0) {
                if (!badge) {
                    const b = document.createElement('div');
                    b.className = 'mini-badge';
                    b.textContent = pendingNotifications;
                    document.getElementById('miniMode').appendChild(b);
                } else {
                    badge.textContent = pendingNotifications;
                }
                document.getElementById('miniMode').classList.add('has-notification');
            } else {
                if (badge) badge.remove();
                document.getElementById('miniMode').classList.remove('has-notification');
            }
        }

        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // ===== TEXT INPUT =====
        function initTextInput() {
            const input = document.getElementById('textInput');
            input.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            });
            input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendTextMessage();
                }
            });
        }

        // ===== KEYBOARD SHORTCUTS =====

        function initKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                // Don't capture when typing in inputs
                if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
                    if (e.key === 'Escape') {
                        e.target.blur();
                        if (isRecording) stopRecording();
                    }
                    return;
                }

                if (e.key === 'm' && !e.ctrlKey && !e.metaKey) {
                    toggleRecording();
                } else if (e.key === 'Escape') {
                    if (isRecording) stopRecording();
                    if (document.getElementById('settingsModal').classList.contains('show')) closeSettings();
                } else if (e.key === 'v' && !e.ctrlKey && !e.metaKey) {
                    toggleTtsEnabled();
                } else if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
                    toggleSidebar();
                } else if (e.key === 'p' && !e.ctrlKey && !e.metaKey) {
                    togglePreview();
                } else if (e.key === 'm' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    toggleMiniMode();
                } else if (e.key === '/' || e.key === 'i') {
                    document.getElementById('textInput').focus();
                } else if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
                    toggleAutoMode();
                }
            });
        }

        // ===== SETTINGS =====
        function showSettings() {
            document.getElementById('settingsModal').classList.add('show');
            loadVoiceTab();
            loadBehaviorSettings();
        }

        function closeSettings() {
            document.getElementById('settingsModal').classList.remove('show');
        }

        function switchTab(tab) {
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.modal-section').forEach(s => s.style.display = 'none');
            event.target.classList.add('active');
            document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).style.display = '';
        }

        async function loadVoiceTab() {
            const container = document.getElementById('tabVoice');
            const currentVoiceName = localStorage.getItem('elevenLabsVoiceName') || 'Default';

            container.innerHTML = \`<div class="modal-label">Current voice: <strong>\${escapeHtml(currentVoiceName)}</strong></div><div style="color:var(--text-muted);font-size:0.82rem;">Loading voices...</div>\`;

            try {
                const response = await fetch('/api/elevenlabs/voices');
                if (!response.ok) throw new Error(response.statusText);
                const voices = await response.json();

                container.innerHTML = \`
                    <div class="modal-label">Current voice: <strong>\${escapeHtml(currentVoiceName)}</strong></div>
                    <ul class="voice-list">\${voices.map(v => \`
                        <li class="voice-item\${v.name === currentVoiceName ? ' selected' : ''}" onclick="selectVoice('\${v.voice_id}', '\${v.name}')">
                            <div class="voice-info">
                                <div class="voice-name">\${v.name}</div>
                                <div class="voice-category">\${v.category || ''}</div>
                            </div>
                            <div class="voice-actions">
                                <button class="btn-sm" onclick="event.stopPropagation();previewVoice('\${v.voice_id}')">Preview</button>
                            </div>
                        </li>
                    \`).join('')}</ul>
                \`;
            } catch (err) {
                container.innerHTML = \`<div style="color:var(--error);font-size:0.85rem;">Failed to load voices: \${err.message}</div>\`;
            }
        }

        async function previewVoice(voiceId) {
            try {
                const response = await fetch(\`/api/elevenlabs/voices/\${voiceId}/preview\`);
                if (!response.ok) throw new Error(response.statusText);
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.play();
                audio.onended = () => URL.revokeObjectURL(url);
            } catch (err) {
                showToast('Failed to preview voice', 'error');
            }
        }

        function selectVoice(voiceId, voiceName) {
            localStorage.setItem('elevenLabsVoiceId', voiceId);
            localStorage.setItem('elevenLabsVoiceName', voiceName);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'config:update', payload: { elevenLabsVoiceId: voiceId } }));
            }
            showToast(\`Voice changed to \${voiceName}\`, 'success');
            loadVoiceTab();
        }

        function saveSystemPrompt() {
            const prompt = document.getElementById('systemPromptInput').value.trim();
            if (!prompt) return;
            localStorage.setItem('voiceSystemPrompt', prompt);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'config:update', payload: { voiceSystemPrompt: prompt } }));
            }
            showToast('System prompt saved', 'success');
        }

        function loadBehaviorSettings() {
            document.getElementById('announceTaskComplete').checked = behavior.announceTaskComplete;
            document.getElementById('announceErrors').checked = behavior.announceErrors;
            document.getElementById('proactiveUpdates').checked = behavior.proactiveUpdates;
            document.getElementById('showSuggestions').checked = behavior.showSuggestions;
            document.getElementById('autoListenAfterResponse').checked = behavior.autoListenAfterResponse;
        }

        function saveBehavior() {
            behavior.announceTaskComplete = document.getElementById('announceTaskComplete').checked;
            behavior.announceErrors = document.getElementById('announceErrors').checked;
            behavior.proactiveUpdates = document.getElementById('proactiveUpdates').checked;
            behavior.showSuggestions = document.getElementById('showSuggestions').checked;
            behavior.autoListenAfterResponse = document.getElementById('autoListenAfterResponse').checked;
            localStorage.setItem('voiceBehavior', JSON.stringify(behavior));
            document.getElementById('suggestionsBar').classList.toggle('visible', behavior.showSuggestions);
        }

        // Close modal on overlay click
        document.getElementById('settingsModal').addEventListener('click', (e) => {
            if (e.target.id === 'settingsModal') closeSettings();
        });

        // Boot
        init();
    </script>
</body>
</html>`;
}
