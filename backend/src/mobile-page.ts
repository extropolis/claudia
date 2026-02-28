/**
 * Mobile Terminal Page - Self-contained HTML page for mobile task monitoring & input
 *
 * Shows tasks in an accordion view with xterm.js terminal rendering (same as desktop).
 * Connects via WebSocket. Voice input via Web Speech API, voice summaries via ElevenLabs TTS.
 * Loads xterm.js + fit addon from CDN. No React or build dependencies.
 */

export function getMobilePageHtml(wsUrl: string, token: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>Claudia Mobile</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg: #0d1117;
            --surface: #161b22;
            --border: #30363d;
            --text: #e6edf3;
            --text-muted: #8b949e;
            --accent: #58a6ff;
            --accent-glow: rgba(88, 166, 255, 0.3);
            --success: #3fb950;
            --warning: #d29922;
            --error: #f85149;
            --busy: #58a6ff;
            --idle: #3fb950;
            --waiting: #d29922;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg);
            color: var(--text);
            height: 100dvh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            -webkit-tap-highlight-color: transparent;
        }

        /* Header */
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 16px;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
        }

        .header h1 {
            font-size: 17px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .connection-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--error);
            transition: background 0.3s;
            flex-shrink: 0;
        }

        .connection-dot.connected { background: var(--success); }
        .connection-dot.connecting { background: var(--warning); animation: pulse 1s infinite; }

        .header-controls {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        /* Workspace selector */
        .workspace-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
        }

        .workspace-bar label {
            font-size: 12px;
            color: var(--text-muted);
            white-space: nowrap;
        }

        .workspace-select {
            flex: 1;
            background: var(--bg);
            color: var(--text);
            border: 1px solid var(--border);
            padding: 6px 10px;
            border-radius: 8px;
            font-size: 13px;
            outline: none;
            cursor: pointer;
            min-width: 0;
        }

        .workspace-select:focus { border-color: var(--accent); }

        /* TTS controls */
        .voice-select {
            background: var(--bg);
            color: var(--text-muted);
            border: 1px solid var(--border);
            padding: 4px 6px;
            border-radius: 6px;
            font-size: 11px;
            outline: none;
            cursor: pointer;
            max-width: 90px;
        }

        .voice-select:focus { border-color: var(--accent); color: var(--text); }

        .tts-toggle {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-muted);
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 15px;
            cursor: pointer;
            position: relative;
            line-height: 1;
        }

        .tts-toggle.active, .sound-toggle.active { color: var(--accent); border-color: var(--accent); }

        .sound-toggle {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-muted);
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 15px;
            cursor: pointer;
            line-height: 1;
        }

        .tts-toggle.loading::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 50%;
            transform: translateX(-50%);
            width: 16px;
            height: 2px;
            background: var(--accent);
            border-radius: 1px;
            animation: ttsLoading 0.8s infinite;
        }

        @keyframes ttsLoading {
            0%, 100% { width: 4px; opacity: 0.5; }
            50% { width: 16px; opacity: 1; }
        }

        /* Accordion task list */
        .task-list {
            flex: 1;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
        }

        .empty-state {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--text-muted);
            font-size: 14px;
            padding: 32px;
            text-align: center;
        }

        .task-item {
            border-bottom: 1px solid var(--border);
        }

        .task-header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 16px;
            cursor: pointer;
            background: var(--surface);
            -webkit-tap-highlight-color: transparent;
            user-select: none;
            transition: background 0.15s;
        }

        .task-header:active { background: var(--border); }

        .task-header.expanded {
            border-bottom: 1px solid var(--border);
        }

        .state-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }

        .state-dot.starting, .state-dot.busy { background: var(--busy); animation: pulse 1.5s infinite; }
        .state-dot.idle { background: var(--idle); }
        .state-dot.waiting_input { background: var(--waiting); animation: pulse 1.2s infinite; }
        .state-dot.exited, .state-dot.disconnected { background: var(--text-muted); }
        .state-dot.interrupted { background: var(--error); }

        .task-prompt {
            flex: 1;
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
        }

        .task-state-label {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            font-weight: 600;
            letter-spacing: 0.5px;
            flex-shrink: 0;
        }

        .task-state-label.busy, .task-state-label.starting { background: rgba(88, 166, 255, 0.15); color: var(--accent); }
        .task-state-label.idle { background: rgba(63, 185, 80, 0.15); color: var(--success); }
        .task-state-label.waiting_input { background: rgba(210, 153, 34, 0.15); color: var(--warning); }
        .task-state-label.exited { background: rgba(139, 148, 158, 0.15); color: var(--text-muted); }
        .task-state-label.disconnected { background: rgba(139, 148, 158, 0.15); color: var(--text-muted); }
        .task-state-label.interrupted { background: rgba(248, 81, 73, 0.15); color: var(--error); }

        .chevron {
            font-size: 12px;
            color: var(--text-muted);
            transition: transform 0.2s;
            flex-shrink: 0;
        }

        .task-header.expanded .chevron { transform: rotate(90deg); }

        .task-delete-btn {
            width: 28px;
            height: 28px;
            border-radius: 6px;
            border: none;
            background: transparent;
            color: var(--text-muted);
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            flex-shrink: 0;
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
            transition: all 0.15s;
            padding: 0;
            line-height: 1;
        }

        .task-delete-btn:active {
            background: rgba(248, 81, 73, 0.2);
            color: var(--error);
            transform: scale(0.9);
        }

        /* Swipe-to-delete action area */
        .task-delete-confirm {
            display: none;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 10px 16px;
            background: rgba(248, 81, 73, 0.1);
            border-bottom: 1px solid var(--border);
        }

        .task-delete-confirm.visible { display: flex; }

        .task-delete-confirm span {
            font-size: 13px;
            color: var(--text-muted);
        }

        .task-delete-confirm-btn {
            padding: 6px 16px;
            border-radius: 6px;
            border: none;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            -webkit-tap-highlight-color: transparent;
        }

        .task-delete-confirm-yes {
            background: var(--error);
            color: #fff;
        }

        .task-delete-confirm-no {
            background: var(--border);
            color: var(--text);
        }

        .task-body {
            display: none;
            background: #0a0a0a;
        }

        .task-body.expanded {
            display: block;
        }

        .terminal-container {
            height: 50vh;
            overflow: hidden;
            /* Enable touch scrolling on mobile */
            touch-action: pan-y;
        }

        /* Make xterm fill its container */
        .terminal-container .xterm {
            height: 100%;
            padding: 4px;
        }

        /* Enable touch-based scrolling in xterm viewport on mobile */
        .terminal-container .xterm-viewport {
            overflow-y: auto !important;
            -webkit-overflow-scrolling: touch;
            touch-action: pan-y;
        }

        .terminal-container .xterm-screen {
            touch-action: pan-y;
        }

        .terminal-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: var(--text-muted);
            font-size: 13px;
            gap: 8px;
        }

        .terminal-loading .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* Input area */
        .input-area {
            padding: 10px 12px;
            background: var(--surface);
            border-top: 1px solid var(--border);
            flex-shrink: 0;
            padding-bottom: max(10px, env(safe-area-inset-bottom));
        }

        .input-area.disabled { opacity: 0.4; pointer-events: none; }

        .input-target {
            font-size: 11px;
            color: var(--text-muted);
            margin-bottom: 6px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .input-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .input-row input {
            flex: 1;
            padding: 10px 14px;
            border-radius: 20px;
            border: 1px solid var(--border);
            background: var(--bg);
            color: var(--text);
            font-size: 15px;
            outline: none;
            min-width: 0;
        }

        .input-row input:focus { border-color: var(--accent); }

        .send-btn, .mic-btn {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            border: none;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            flex-shrink: 0;
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
            transition: all 0.15s;
        }

        .send-btn {
            background: var(--accent);
            color: #fff;
        }

        .send-btn:active { transform: scale(0.9); }

        .send-btn svg, .mic-btn svg {
            width: 20px;
            height: 20px;
        }

        .mic-btn {
            background: transparent;
            border: 2px solid var(--accent);
            color: var(--accent);
        }

        .mic-btn:active { transform: scale(0.9); }

        .mic-btn.listening {
            background: var(--accent);
            color: #fff;
            box-shadow: 0 0 0 4px var(--accent-glow);
            animation: micPulse 1.5s infinite;
        }

        .mic-btn.disabled { opacity: 0.3; pointer-events: none; }

        /* Voice transcript overlay */
        .voice-overlay {
            display: none;
            padding: 8px 12px;
            background: var(--surface);
            border-top: 1px solid var(--border);
            flex-shrink: 0;
        }

        .voice-overlay.visible { display: block; }

        .voice-transcript {
            font-size: 14px;
            color: var(--text);
            margin-bottom: 8px;
            max-height: 60px;
            overflow-y: auto;
            word-wrap: break-word;
        }

        .voice-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }

        .voice-actions button {
            padding: 6px 16px;
            border-radius: 16px;
            border: none;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
        }

        .voice-send { background: var(--success); color: #fff; }
        .voice-clear { background: var(--border); color: var(--text); }

        /* No speech banner */
        .no-speech-banner {
            padding: 8px 16px;
            background: var(--warning);
            color: #000;
            text-align: center;
            font-size: 12px;
            display: none;
            flex-shrink: 0;
        }

        .no-speech-banner.visible { display: block; }

        /* Animations */
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        @keyframes micPulse {
            0%, 100% { box-shadow: 0 0 0 4px var(--accent-glow); }
            50% { box-shadow: 0 0 0 8px rgba(88, 166, 255, 0.1); }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>
            <span class="connection-dot" id="connDot"></span>
            Claudia
        </h1>
        <div class="header-controls">
            <select class="voice-select" id="voiceSelect" title="TTS voice">
                <option value="charlotte" selected>Charlotte</option>
                <option value="verity">Verity</option>
                <option value="george">George</option>
                <option value="brian">Brian</option>
                <option value="jessica">Jessica</option>
                <option value="daisy">Daisy</option>
            </select>
            <button class="sound-toggle active" id="soundToggle" title="Toggle completion sound">&#x1f514;</button>
            <button class="tts-toggle active" id="ttsToggle" title="Toggle voice summaries">&#x1f50a;</button>
        </div>
    </div>

    <div class="no-speech-banner" id="noSpeechBanner">
        Speech recognition not supported. Use text input.
    </div>

    <div class="workspace-bar" id="workspaceBar" style="display:none;">
        <label>Workspace:</label>
        <select class="workspace-select" id="workspaceSelect"></select>
    </div>

    <div class="task-list" id="taskList">
        <div class="empty-state" id="emptyState">Connecting...</div>
    </div>

    <div class="voice-overlay" id="voiceOverlay">
        <div class="voice-transcript" id="voiceTranscript"></div>
        <div class="voice-actions">
            <button class="voice-clear" id="voiceClearBtn">Clear</button>
            <button class="voice-send" id="voiceSendBtn">Send</button>
        </div>
    </div>

    <div class="input-area" id="inputArea">
        <div class="input-target" id="inputTarget">No task selected</div>
        <div class="input-row">
            <input type="text" id="textInput" placeholder="Send to task..." autocomplete="off" />
            <button class="mic-btn" id="micBtn" title="Voice input">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                    <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
            </button>
            <button class="send-btn" id="sendBtn" title="Send">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
            </button>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
    <script>
    (function() {
        'use strict';

        var WS_URL = ${JSON.stringify(wsUrl)};
        var TOKEN = ${JSON.stringify(token)};

        // State
        var ws = null;
        var tasks = [];
        var workspaces = [];
        var currentWorkspaceId = null;
        var selectedTaskId = null;
        var taskTerminals = {};          // taskId -> { term, fitAddon, container, history }
        var taskRestorePending = {};     // taskId -> true while waiting for restore
        var ttsEnabled = true;
        var soundEnabled = true;
        var isListening = false;
        var recognition = null;
        var accumulatedTranscript = '';

        // xterm theme matching the desktop app
        var XTERM_THEME = {
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
            brightWhite: '#e5e5e5'
        };

        // DOM
        var connDot = document.getElementById('connDot');
        var taskListEl = document.getElementById('taskList');
        var emptyState = document.getElementById('emptyState');
        var workspaceBar = document.getElementById('workspaceBar');
        var workspaceSelect = document.getElementById('workspaceSelect');
        var inputArea = document.getElementById('inputArea');
        var inputTarget = document.getElementById('inputTarget');
        var textInput = document.getElementById('textInput');
        var sendBtn = document.getElementById('sendBtn');
        var micBtn = document.getElementById('micBtn');
        var ttsToggle = document.getElementById('ttsToggle');
        var soundToggle = document.getElementById('soundToggle');
        var voiceSelect = document.getElementById('voiceSelect');
        var voiceOverlay = document.getElementById('voiceOverlay');
        var voiceTranscript = document.getElementById('voiceTranscript');
        var voiceSendBtn = document.getElementById('voiceSendBtn');
        var voiceClearBtn = document.getElementById('voiceClearBtn');
        var noSpeechBanner = document.getElementById('noSpeechBanner');

        // ===== Utilities =====
        function truncate(str, len) {
            if (!str) return '';
            return str.length > len ? str.substring(0, len) + '...' : str;
        }

        function stateLabel(state) {
            var map = {
                starting: 'Starting',
                busy: 'Busy',
                idle: 'Idle',
                waiting_input: 'Input',
                exited: 'Done',
                disconnected: 'Lost',
                interrupted: 'Stopped'
            };
            return map[state] || state;
        }

        function escapeHtml(text) {
            var d = document.createElement('div');
            d.textContent = text;
            return d.innerHTML;
        }

        // ===== xterm.js Terminal Management =====
        function getOrCreateTerminal(taskId) {
            if (taskTerminals[taskId]) return taskTerminals[taskId];

            var term = new window.Terminal({
                cursorBlink: false,
                fontSize: 11,
                fontFamily: '"SF Mono", "Menlo", "Monaco", "Courier New", monospace',
                scrollback: 5000,
                allowProposedApi: true,
                disableStdin: true,  // input goes through our text field, not xterm
                theme: XTERM_THEME
            });

            var fitAddon = new window.FitAddon.FitAddon();
            term.loadAddon(fitAddon);

            taskTerminals[taskId] = {
                term: term,
                fitAddon: fitAddon,
                container: null,
                history: '',
                opened: false
            };

            return taskTerminals[taskId];
        }

        // Enable touch scrolling inside xterm on mobile devices.
        // xterm.js renders to a canvas that captures touch events for text selection,
        // which prevents normal finger-scroll. We intercept vertical swipe gestures
        // on the xterm screen element and programmatically scroll the viewport.
        function enableTouchScroll(containerEl, term) {
            var screenEl = containerEl.querySelector('.xterm-screen');
            if (!screenEl || screenEl._touchScrollEnabled) return;
            screenEl._touchScrollEnabled = true;

            var viewportEl = containerEl.querySelector('.xterm-viewport');
            if (!viewportEl) return;

            var startY = 0;
            var lastY = 0;
            var isScrolling = false;

            screenEl.addEventListener('touchstart', function(e) {
                if (e.touches.length === 1) {
                    startY = e.touches[0].clientY;
                    lastY = startY;
                    isScrolling = false;
                }
            }, { passive: true });

            screenEl.addEventListener('touchmove', function(e) {
                if (e.touches.length !== 1) return;

                var currentY = e.touches[0].clientY;
                var deltaY = lastY - currentY;

                // Only treat as scroll if moved more than 5px vertically
                if (!isScrolling && Math.abs(currentY - startY) > 5) {
                    isScrolling = true;
                }

                if (isScrolling) {
                    e.preventDefault();
                    e.stopPropagation();
                    viewportEl.scrollTop += deltaY;
                }

                lastY = currentY;
            }, { passive: false });

            screenEl.addEventListener('touchend', function() {
                isScrolling = false;
            }, { passive: true });

            console.log('[Mobile] Touch scroll enabled for terminal');
        }

        function mountTerminal(taskId, containerEl) {
            var entry = getOrCreateTerminal(taskId);
            entry.container = containerEl;

            if (!entry.opened) {
                entry.term.open(containerEl);
                entry.opened = true;
                // Write any buffered history that arrived before mount
                if (entry.history) {
                    entry.term.write(entry.history);
                }
            } else {
                // Terminal was already opened on a previous container.
                // Move its DOM element into the new container.
                var termEl = entry.term.element;
                if (termEl && termEl.parentNode !== containerEl) {
                    containerEl.appendChild(termEl);
                }
            }

            // Fit after DOM paint
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    try { entry.fitAddon.fit(); } catch(e) {}
                    // Send resize to backend
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'task:resize',
                            payload: { taskId: taskId, cols: entry.term.cols, rows: entry.term.rows }
                        }));
                    }
                    // Enable touch scrolling on mobile: forward touch events on the
                    // xterm canvas/screen to the xterm-viewport scroll container
                    enableTouchScroll(containerEl, entry.term);
                });
            });
        }

        function destroyTerminal(taskId) {
            var entry = taskTerminals[taskId];
            if (entry) {
                try { entry.term.dispose(); } catch(e) {}
                delete taskTerminals[taskId];
            }
        }

        // ===== Accordion Rendering =====
        function getFilteredTasks() {
            return tasks.filter(function(t) {
                if (t.state === 'archived' || t.state === 'disconnected') return false;
                if (currentWorkspaceId && t.workspaceId && t.workspaceId !== currentWorkspaceId) return false;
                return true;
            });
        }

        function renderAccordion() {
            var filtered = getFilteredTasks();

            if (filtered.length === 0) {
                // Dispose any terminals from a previous render
                Object.keys(taskTerminals).forEach(function(id) {
                    taskTerminals[id].container = null;
                });
                taskListEl.innerHTML = '';
                emptyState.textContent = 'No active tasks in this workspace.';
                taskListEl.appendChild(emptyState);
                updateInputArea();
                return;
            }

            // Sort by order then createdAt
            filtered.sort(function(a, b) {
                if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            });

            taskListEl.innerHTML = '';

            filtered.forEach(function(task) {
                var item = document.createElement('div');
                item.className = 'task-item';
                item.dataset.taskId = task.id;

                var isExpanded = task.id === selectedTaskId;

                // Header
                var header = document.createElement('div');
                header.className = 'task-header' + (isExpanded ? ' expanded' : '');

                var dot = document.createElement('span');
                dot.className = 'state-dot ' + task.state;

                var prompt = document.createElement('span');
                prompt.className = 'task-prompt';
                prompt.textContent = truncate(task.prompt || task.id, 50);

                var label = document.createElement('span');
                label.className = 'task-state-label ' + task.state;
                label.textContent = stateLabel(task.state);

                var chevron = document.createElement('span');
                chevron.className = 'chevron';
                chevron.textContent = '\\u25B6';

                var deleteBtn = document.createElement('button');
                deleteBtn.className = 'task-delete-btn';
                deleteBtn.innerHTML = '&#x2715;';
                deleteBtn.title = 'Remove task';
                deleteBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    showDeleteConfirm(task.id);
                });

                header.appendChild(dot);
                header.appendChild(prompt);
                header.appendChild(label);
                header.appendChild(deleteBtn);
                header.appendChild(chevron);

                header.addEventListener('click', function() {
                    toggleTask(task.id);
                });

                item.appendChild(header);

                // Delete confirm bar
                var confirmBar = document.createElement('div');
                confirmBar.className = 'task-delete-confirm';
                confirmBar.id = 'confirm-' + task.id;

                var confirmText = document.createElement('span');
                confirmText.textContent = 'Remove this task?';

                var yesBtn = document.createElement('button');
                yesBtn.className = 'task-delete-confirm-btn task-delete-confirm-yes';
                yesBtn.textContent = 'Remove';
                yesBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    destroyTaskFromMobile(task.id);
                });

                var noBtn = document.createElement('button');
                noBtn.className = 'task-delete-confirm-btn task-delete-confirm-no';
                noBtn.textContent = 'Cancel';
                noBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    hideDeleteConfirm(task.id);
                });

                confirmBar.appendChild(confirmText);
                confirmBar.appendChild(yesBtn);
                confirmBar.appendChild(noBtn);
                item.appendChild(confirmBar);

                // Body
                var body = document.createElement('div');
                body.className = 'task-body' + (isExpanded ? ' expanded' : '');
                body.id = 'body-' + task.id;

                if (isExpanded) {
                    if (taskRestorePending[task.id]) {
                        body.innerHTML = '<div class="terminal-loading"><div class="spinner"></div>Loading history...</div>';
                    } else {
                        var termContainer = document.createElement('div');
                        termContainer.className = 'terminal-container';
                        termContainer.id = 'termcontainer-' + task.id;
                        body.appendChild(termContainer);
                    }
                }

                item.appendChild(body);
                taskListEl.appendChild(item);

                // Mount xterm after appending to DOM
                if (isExpanded && !taskRestorePending[task.id]) {
                    var el = document.getElementById('termcontainer-' + task.id);
                    if (el) mountTerminal(task.id, el);
                }
            });

            updateInputArea();
        }

        function toggleTask(taskId) {
            if (selectedTaskId === taskId) {
                // Collapse
                selectedTaskId = null;
                renderAccordion();
                return;
            }

            selectedTaskId = taskId;

            // If we don't have a terminal with content yet, request restore
            var entry = taskTerminals[taskId];
            if (!entry || !entry.history) {
                taskRestorePending[taskId] = true;
            }

            // Tell server to activate this task (triggers task:restore with history)
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'task:select', payload: { taskId: taskId } }));
            }

            renderAccordion();
        }

        function showDeleteConfirm(taskId) {
            // Hide any other open confirm bars first
            document.querySelectorAll('.task-delete-confirm.visible').forEach(function(el) {
                el.classList.remove('visible');
            });
            var bar = document.getElementById('confirm-' + taskId);
            if (bar) bar.classList.add('visible');
        }

        function hideDeleteConfirm(taskId) {
            var bar = document.getElementById('confirm-' + taskId);
            if (bar) bar.classList.remove('visible');
        }

        function destroyTaskFromMobile(taskId) {
            console.log('[Mobile] Destroying task:', taskId);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'task:destroy',
                    payload: { taskId: taskId }
                }));
            }
        }

        function updateInputArea() {
            if (!selectedTaskId) {
                inputTarget.textContent = 'No task selected';
                inputArea.classList.add('disabled');
                return;
            }

            var task = tasks.find(function(t) { return t.id === selectedTaskId; });
            if (!task) {
                inputTarget.textContent = 'No task selected';
                inputArea.classList.add('disabled');
                return;
            }

            var isDisabled = task.state === 'exited' || task.state === 'disconnected' || task.state === 'interrupted';
            if (isDisabled) {
                inputArea.classList.add('disabled');
            } else {
                inputArea.classList.remove('disabled');
            }
            inputTarget.textContent = '\\u25B8 ' + truncate(task.prompt || task.id, 40);
        }

        function writeToTerminal(taskId, data) {
            var entry = getOrCreateTerminal(taskId);
            entry.history += data;
            if (entry.opened) {
                entry.term.write(data);
            }
        }

        function restoreTerminal(taskId, history) {
            var entry = getOrCreateTerminal(taskId);
            // Reset and write full history
            entry.history = history;
            if (entry.opened) {
                entry.term.reset();
                entry.term.write(history);
            }
            delete taskRestorePending[taskId];

            if (taskId === selectedTaskId) {
                renderAccordion();
            }
        }

        // ===== Workspace Selector =====
        function initWorkspaceSelector() {
            if (!workspaces || workspaces.length === 0) {
                workspaceBar.style.display = 'none';
                return;
            }

            workspaceBar.style.display = 'flex';
            workspaceSelect.innerHTML = '';

            workspaces.forEach(function(w) {
                var opt = document.createElement('option');
                opt.value = w.id;
                opt.textContent = w.name || w.id;
                workspaceSelect.appendChild(opt);
            });

            var savedWs = null;
            try { savedWs = localStorage.getItem('claudia-mobile-workspace'); } catch(e) {}

            if (savedWs && workspaces.some(function(w) { return w.id === savedWs; })) {
                currentWorkspaceId = savedWs;
            } else {
                currentWorkspaceId = workspaces[0].id;
            }
            workspaceSelect.value = currentWorkspaceId;

            // Auto-select first task in workspace
            autoSelectFirstTask();
        }

        function autoSelectFirstTask() {
            var filtered = getFilteredTasks();
            if (filtered.length > 0) {
                var active = filtered.find(function(t) {
                    return t.state === 'busy' || t.state === 'starting' || t.state === 'waiting_input';
                });
                toggleTask((active || filtered[0]).id);
            } else {
                selectedTaskId = null;
                renderAccordion();
            }
        }

        workspaceSelect.addEventListener('change', function() {
            currentWorkspaceId = workspaceSelect.value;
            try { localStorage.setItem('claudia-mobile-workspace', currentWorkspaceId); } catch(e) {}
            selectedTaskId = null;
            autoSelectFirstTask();
        });

        // ===== WebSocket =====
        function connectWebSocket() {
            connDot.className = 'connection-dot connecting';
            var wsUrlWithToken = WS_URL + (WS_URL.includes('?') ? '&' : '?') + 'token=' + TOKEN + '&mobile=1';
            console.log('[Mobile] Connecting:', wsUrlWithToken);

            ws = new WebSocket(wsUrlWithToken);

            ws.onopen = function() {
                console.log('[Mobile] Connected');
                connDot.className = 'connection-dot connected';
            };

            ws.onmessage = function(event) {
                try {
                    handleMessage(JSON.parse(event.data));
                } catch (e) {
                    console.error('[Mobile] Parse error:', e);
                }
            };

            ws.onclose = function(event) {
                console.log('[Mobile] Closed:', event.code);
                connDot.className = 'connection-dot';
                setTimeout(function() {
                    if (!ws || ws.readyState === WebSocket.CLOSED) connectWebSocket();
                }, 3000);
            };

            ws.onerror = function() {
                connDot.className = 'connection-dot';
            };
        }

        function handleMessage(msg) {
            console.log('[Mobile] Msg:', msg.type);
            var p = msg.payload || {};

            switch (msg.type) {
                case 'init':
                    if (p.tasks) tasks = p.tasks;
                    if (p.workspaces) {
                        workspaces = p.workspaces;
                        initWorkspaceSelector();
                    }
                    renderAccordion();
                    // Start audio keep-alive if any tasks are active
                    if (tasks.some(function(t) { return t.state === 'busy' || t.state === 'starting'; })) {
                        startAudioKeepAlive();
                    }
                    break;

                case 'task:output':
                    if (p.taskId && p.data) {
                        writeToTerminal(p.taskId, p.data);
                    }
                    break;

                case 'task:restore':
                    if (p.taskId) {
                        restoreTerminal(p.taskId, p.history || p.data || '');
                    }
                    break;

                case 'task:stateChanged':
                    if (p.task) {
                        var idx = tasks.findIndex(function(t) { return t.id === p.task.id; });
                        var prevState = idx >= 0 ? tasks[idx].state : null;
                        if (idx >= 0) tasks[idx] = p.task;
                        else tasks.push(p.task);

                        // Update state label + dot without full re-render if possible
                        var existingItem = taskListEl.querySelector('[data-task-id="' + p.task.id + '"]');
                        if (existingItem) {
                            var dotEl = existingItem.querySelector('.state-dot');
                            var labelEl = existingItem.querySelector('.task-state-label');
                            if (dotEl) dotEl.className = 'state-dot ' + p.task.state;
                            if (labelEl) {
                                labelEl.className = 'task-state-label ' + p.task.state;
                                labelEl.textContent = stateLabel(p.task.state);
                            }
                            updateInputArea();
                        } else {
                            renderAccordion();
                        }

                        // Notification sound + voice summary on completion
                        if ((p.task.state === 'idle' || p.task.state === 'exited') &&
                            prevState && prevState !== 'idle' && prevState !== 'exited') {
                            playNotificationSound();
                            if (ttsEnabled) triggerVoiceSummary(p.task.id);
                        }

                        // Manage background audio keep-alive based on active tasks
                        if (p.task.state === 'busy' || p.task.state === 'starting') {
                            startAudioKeepAlive();
                        }
                    }
                    break;

                case 'task:created':
                    if (p.task) {
                        tasks.push(p.task);
                        // Only auto-expand if nothing is currently selected
                        if (!selectedTaskId && (!currentWorkspaceId || p.task.workspaceId === currentWorkspaceId)) {
                            selectedTaskId = p.task.id;
                            taskRestorePending[p.task.id] = true;
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'task:select', payload: { taskId: p.task.id } }));
                            }
                        }
                        renderAccordion();
                    }
                    break;

                case 'task:destroyed':
                    if (p.taskId) {
                        tasks = tasks.filter(function(t) { return t.id !== p.taskId; });
                        destroyTerminal(p.taskId);
                        delete taskRestorePending[p.taskId];
                        if (selectedTaskId === p.taskId) {
                            selectedTaskId = null;
                            autoSelectFirstTask();
                        } else {
                            renderAccordion();
                        }
                    }
                    break;

                case 'tasks:updated':
                    if (p.tasks) {
                        tasks = p.tasks;
                        renderAccordion();
                    }
                    break;

                case 'workspace:created':
                case 'workspace:updated':
                case 'workspace:reordered':
                case 'workspace:deleted':
                    if (p.workspaces) {
                        workspaces = p.workspaces;
                        initWorkspaceSelector();
                        renderAccordion();
                    }
                    break;

                case 'supervisor:chat:response':
                    // Used for voice summaries — check if tagged with a taskId
                    if (p.message && p.message.taskId && pendingVoiceSummaries[p.message.taskId]) {
                        delete pendingVoiceSummaries[p.message.taskId];
                        if (ttsEnabled && p.message.content) {
                            speak(p.message.content);
                        }
                    }
                    break;

                case 'server:reconnecting':
                    emptyState.textContent = 'Reconnecting tasks...';
                    break;
            }
        }

        // ===== Voice Summary =====
        var pendingVoiceSummaries = {};

        function triggerVoiceSummary(taskId) {
            console.log('[Mobile] Waiting for voice summary for task:', taskId);
            pendingVoiceSummaries[taskId] = true;
            setTimeout(function() { delete pendingVoiceSummaries[taskId]; }, 30000);
        }

        // ===== Input =====
        function sendTaskInput(text) {
            if (!text || !selectedTaskId || !ws || ws.readyState !== WebSocket.OPEN) return;
            console.log('[Mobile] Sending input to task:', selectedTaskId, text.substring(0, 50));
            ws.send(JSON.stringify({
                type: 'task:input',
                payload: { taskId: selectedTaskId, input: text + '\\r' }
            }));
        }

        sendBtn.addEventListener('click', function() {
            var text = textInput.value.trim();
            if (text) {
                sendTaskInput(text);
                textInput.value = '';
            }
        });

        textInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                var text = textInput.value.trim();
                if (text) {
                    sendTaskInput(text);
                    textInput.value = '';
                }
            }
        });

        // ===== Speech Recognition =====
        var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            noSpeechBanner.className = 'no-speech-banner visible';
            micBtn.className = 'mic-btn disabled';
        } else {
            recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'en-US';

            recognition.onstart = function() {
                isListening = true;
                micBtn.className = 'mic-btn listening';
            };

            recognition.onresult = function(event) {
                var interim = '';
                var newFinal = '';
                for (var i = event.resultIndex; i < event.results.length; i++) {
                    if (event.results[i].isFinal) {
                        newFinal += event.results[i][0].transcript;
                    } else {
                        interim += event.results[i][0].transcript;
                    }
                }
                if (newFinal) {
                    accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + newFinal.trim();
                }
                var display = accumulatedTranscript + (interim ? ' ' + interim : '');
                if (display.trim()) {
                    voiceTranscript.textContent = display;
                    voiceOverlay.className = 'voice-overlay visible';
                }
            };

            recognition.onend = function() {
                if (isListening) {
                    try { recognition.start(); } catch(e) {
                        setTimeout(function() {
                            if (isListening) {
                                try { recognition.start(); } catch(e2) {
                                    isListening = false;
                                    micBtn.className = 'mic-btn';
                                }
                            }
                        }, 200);
                    }
                    return;
                }
                micBtn.className = 'mic-btn';
            };

            recognition.onerror = function(event) {
                if (event.error === 'no-speech' || event.error === 'aborted') return;
                isListening = false;
                micBtn.className = 'mic-btn';
            };
        }

        micBtn.addEventListener('click', function() {
            if (!recognition) return;
            stopTts(true);

            if (isListening) {
                isListening = false;
                recognition.stop();
            } else {
                try { recognition.start(); } catch(e) {
                    console.error('[Mobile] Mic start failed:', e);
                }
            }
        });

        voiceSendBtn.addEventListener('click', function() {
            if (!accumulatedTranscript.trim()) return;
            if (isListening) { isListening = false; try { recognition.stop(); } catch(e) {} }
            sendTaskInput(accumulatedTranscript.trim());
            accumulatedTranscript = '';
            voiceOverlay.className = 'voice-overlay';
        });

        voiceClearBtn.addEventListener('click', function() {
            accumulatedTranscript = '';
            voiceOverlay.className = 'voice-overlay';
            if (!isListening) micBtn.className = 'mic-btn';
        });

        // ===== TTS (ElevenLabs only) =====
        var currentAudio = null;
        var ttsAbortController = null;
        var ttsPlaying = false;
        var ttsCancelledByUser = false;

        // iOS audio unlock
        var iosAudioUnlocked = false;
        var persistentAudio = new Audio();
        var SILENT_MP3 = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwMHAAAAAAD/+1DEAAAHAAL0AAAAIgAAXoAAABE//////////////4AAAAAAAAAAAAAAAAAA//tQxBcAAADSAAAAAAAAANIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//tQxCQAAADSAAAAAAAAANIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwMH';

        function unlockIOSAudio() {
            if (iosAudioUnlocked) return;
            persistentAudio.src = SILENT_MP3;
            persistentAudio.play().then(function() {
                iosAudioUnlocked = true;
            }).catch(function() {});
        }

        ['click', 'touchstart'].forEach(function(evt) {
            document.body.addEventListener(evt, function handler() {
                unlockIOSAudio();
                if (iosAudioUnlocked) document.body.removeEventListener(evt, handler);
            }, { once: false, passive: true });
        });

        // Load saved voice
        try {
            var savedVoice = localStorage.getItem('claudia-mobile-voice');
            if (savedVoice) voiceSelect.value = savedVoice;
        } catch(e) {}

        voiceSelect.addEventListener('change', function() {
            try { localStorage.setItem('claudia-mobile-voice', voiceSelect.value); } catch(e) {}
        });

        // Load saved TTS preference
        try {
            var savedTts = localStorage.getItem('claudia-mobile-tts');
            if (savedTts === 'false') {
                ttsEnabled = false;
                ttsToggle.className = 'tts-toggle';
            }
        } catch(e) {}

        ttsToggle.addEventListener('click', function() {
            ttsEnabled = !ttsEnabled;
            ttsToggle.className = ttsEnabled ? 'tts-toggle active' : 'tts-toggle';
            try { localStorage.setItem('claudia-mobile-tts', String(ttsEnabled)); } catch(e) {}
            if (!ttsEnabled) stopTts(true);
        });

        function setTtsLoading(loading) {
            if (loading) ttsToggle.classList.add('loading');
            else ttsToggle.classList.remove('loading');
        }

        async function fetchTtsAudio(text, voice) {
            var controller = new AbortController();
            ttsAbortController = controller;
            var response = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text, voice: voice }),
                signal: controller.signal
            });
            if (!response.ok) {
                var err = await response.json().catch(function() { return {}; });
                throw new Error(err.error || ('TTS HTTP ' + response.status));
            }
            var blob = await response.blob();
            return URL.createObjectURL(blob);
        }

        function playAudioUrl(url) {
            return new Promise(function(resolve, reject) {
                var audio = persistentAudio;
                currentAudio = audio;
                audio.onended = null;
                audio.onerror = null;
                audio.onended = function() { URL.revokeObjectURL(url); currentAudio = null; resolve(); };
                audio.onerror = function() { URL.revokeObjectURL(url); currentAudio = null; reject(new Error('Playback failed')); };
                audio.src = url;
                audio.play().catch(function(err) {
                    URL.revokeObjectURL(url);
                    currentAudio = null;
                    reject(err);
                });
            });
        }

        function splitSentences(text) {
            var sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
            var merged = [];
            var current = '';
            for (var i = 0; i < sentences.length; i++) {
                current += sentences[i];
                if (current.length > 40 || i === sentences.length - 1) {
                    merged.push(current.trim());
                    current = '';
                }
            }
            if (current.trim()) merged.push(current.trim());
            return merged;
        }

        async function speak(text) {
            if (!ttsEnabled) return;
            stopTts();

            var sentences = splitSentences(text);
            var voice = voiceSelect.value;
            setTtsLoading(true);
            ttsPlaying = true;
            ttsCancelledByUser = false;

            try {
                for (var i = 0; i < sentences.length; i++) {
                    if (!ttsPlaying) break;
                    try {
                        var url = await fetchTtsAudio(sentences[i], voice);
                        if (!ttsPlaying) { URL.revokeObjectURL(url); break; }
                        setTtsLoading(false);
                        await playAudioUrl(url);
                    } catch (err) {
                        if (err.name === 'AbortError') break;
                        console.warn('[Mobile] TTS sentence failed, skipping:', err.message);
                    }
                }
            } catch (err) {
                console.error('[Mobile] TTS error:', err);
            } finally {
                setTtsLoading(false);
                ttsPlaying = false;
            }
        }

        function stopTts(userInitiated) {
            if (userInitiated) ttsCancelledByUser = true;
            ttsPlaying = false;
            if (ttsAbortController) { try { ttsAbortController.abort(); } catch(e) {} ttsAbortController = null; }
            if (currentAudio) {
                try { currentAudio.pause(); currentAudio.currentTime = 0; } catch(e) {}
                currentAudio = null;
            }
        }

        // ===== Notification Sound (Web Audio API) =====
        var audioCtx = null;

        function getAudioContext() {
            if (!audioCtx) {
                var AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (AudioCtx) audioCtx = new AudioCtx();
            }
            // Resume if suspended (iOS background restriction)
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume().catch(function() {});
            }
            return audioCtx;
        }

        // Unlock AudioContext on first user interaction (required by iOS/Android)
        ['click', 'touchstart'].forEach(function(evt) {
            document.body.addEventListener(evt, function ctxHandler() {
                var ctx = getAudioContext();
                if (ctx && ctx.state !== 'suspended') {
                    document.body.removeEventListener(evt, ctxHandler);
                }
            }, { once: false, passive: true });
        });

        function playNotificationSound() {
            if (!soundEnabled) return;
            var ctx = getAudioContext();
            if (!ctx) return;

            console.log('[Mobile] Playing notification sound');

            // Two-tone chime: a pleasant ascending ding
            var now = ctx.currentTime;
            var gain = ctx.createGain();
            gain.connect(ctx.destination);
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);

            // First tone (C5 = 523Hz)
            var osc1 = ctx.createOscillator();
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(523, now);
            osc1.connect(gain);
            osc1.start(now);
            osc1.stop(now + 0.2);

            // Second tone (E5 = 659Hz) — slightly delayed
            var gain2 = ctx.createGain();
            gain2.connect(ctx.destination);
            gain2.gain.setValueAtTime(0, now);
            gain2.gain.setValueAtTime(0.3, now + 0.15);
            gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.7);

            var osc2 = ctx.createOscillator();
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(659, now + 0.15);
            osc2.connect(gain2);
            osc2.start(now + 0.15);
            osc2.stop(now + 0.5);

            // Third tone (G5 = 784Hz) — final high note
            var gain3 = ctx.createGain();
            gain3.connect(ctx.destination);
            gain3.gain.setValueAtTime(0, now);
            gain3.gain.setValueAtTime(0.25, now + 0.3);
            gain3.gain.exponentialRampToValueAtTime(0.01, now + 0.9);

            var osc3 = ctx.createOscillator();
            osc3.type = 'sine';
            osc3.frequency.setValueAtTime(784, now + 0.3);
            osc3.connect(gain3);
            osc3.start(now + 0.3);
            osc3.stop(now + 0.7);
        }

        // Background audio keep-alive: periodically play silent audio while tasks are active
        // This prevents iOS from suspending our audio capability when the app is backgrounded
        var keepAliveInterval = null;

        function startAudioKeepAlive() {
            if (keepAliveInterval) return;
            keepAliveInterval = setInterval(function() {
                var hasActiveTasks = tasks.some(function(t) {
                    return t.state === 'busy' || t.state === 'starting' || t.state === 'waiting_input';
                });
                if (!hasActiveTasks) {
                    stopAudioKeepAlive();
                    return;
                }
                // Silent ping to keep audio context alive
                var ctx = getAudioContext();
                if (ctx) {
                    var osc = ctx.createOscillator();
                    var g = ctx.createGain();
                    g.gain.setValueAtTime(0, ctx.currentTime);
                    osc.connect(g);
                    g.connect(ctx.destination);
                    osc.start();
                    osc.stop(ctx.currentTime + 0.01);
                }
                // Also ping the HTML Audio element to keep it alive
                if (persistentAudio && iosAudioUnlocked) {
                    persistentAudio.src = SILENT_MP3;
                    persistentAudio.play().catch(function() {});
                }
            }, 15000); // every 15 seconds
        }

        function stopAudioKeepAlive() {
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
        }

        // Sound toggle
        try {
            var savedSound = localStorage.getItem('claudia-mobile-sound');
            if (savedSound === 'false') {
                soundEnabled = false;
                soundToggle.className = 'sound-toggle';
            }
        } catch(e) {}

        soundToggle.addEventListener('click', function() {
            soundEnabled = !soundEnabled;
            soundToggle.className = soundEnabled ? 'sound-toggle active' : 'sound-toggle';
            try { localStorage.setItem('claudia-mobile-sound', String(soundEnabled)); } catch(e) {}
            // Play a test chime when enabling so user hears it works
            if (soundEnabled) playNotificationSound();
        });

        // ===== Init =====
        connectWebSocket();
    })();
    </script>
</body>
</html>`;
}
