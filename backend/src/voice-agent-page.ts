/**
 * Voice Agent Page - Self-contained HTML page for voice-based task interaction
 *
 * Provides voice input via Deepgram Nova-3 and voice output via ElevenLabs TTS.
 * Includes voice selection UI with preview capabilities.
 * Loads from CDN. No React or build dependencies.
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

        .header {
            padding: 1rem;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header h1 {
            font-size: 1.5rem;
            font-weight: 600;
        }

        .settings-btn {
            background: var(--surface);
            border: 1px solid var(--border);
            color: var(--text);
            padding: 0.5rem 1rem;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1rem;
            transition: all 0.2s;
        }

        .settings-btn:hover {
            border-color: var(--accent);
            background: rgba(88, 166, 255, 0.1);
        }

        .header-controls {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .toggle-btn {
            background: var(--surface);
            border: 1px solid var(--border);
            color: var(--text-muted);
            width: 36px;
            height: 36px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1.1rem;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.5;
        }

        .toggle-btn.active {
            opacity: 1;
            border-color: var(--accent);
            color: var(--text);
            background: rgba(88, 166, 255, 0.1);
        }

        .toggle-btn:hover {
            border-color: var(--accent);
        }

        .content {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 2rem;
            padding-bottom: 60px;
            overflow-y: auto;
        }

        .voice-controls {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 2rem;
            max-width: 500px;
            width: 100%;
        }

        .mic-button {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            border: 3px solid var(--accent);
            background: var(--surface);
            color: var(--accent);
            font-size: 3rem;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .mic-button:hover {
            transform: scale(1.05);
            box-shadow: 0 0 20px var(--accent-glow);
        }

        .mic-button.active {
            background: var(--accent);
            color: var(--bg);
            box-shadow: 0 0 30px var(--accent-glow);
            animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }

        .status {
            font-size: 1.2rem;
            color: var(--text-muted);
            text-align: center;
        }

        .status.active {
            color: var(--accent);
        }

        .transcript {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1.5rem;
            max-width: 600px;
            width: 100%;
            min-height: 100px;
            max-height: 300px;
            overflow-y: auto;
        }

        .transcript-text {
            color: var(--text);
            line-height: 1.6;
        }

        .transcript-text.empty {
            color: var(--text-muted);
            font-style: italic;
        }

        .text-input-container {
            display: flex;
            align-items: flex-end;
            gap: 0.5rem;
            max-width: 600px;
            width: 100%;
        }

        .text-input {
            flex: 1;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 0.75rem 1rem;
            color: var(--text);
            font-size: 1rem;
            font-family: inherit;
            resize: none;
            overflow-y: hidden;
            line-height: 1.4;
            max-height: 120px;
        }

        .text-input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 2px var(--accent-glow);
        }

        .text-input::placeholder {
            color: var(--text-muted);
        }

        .send-btn {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            border: 1px solid var(--accent);
            background: var(--accent);
            color: var(--bg);
            font-size: 1.2rem;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            flex-shrink: 0;
        }

        .send-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 0 10px var(--accent-glow);
        }

        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }

        .modal.show {
            display: flex;
        }

        .modal-content {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 2rem;
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
        }

        .modal-title {
            font-size: 1.5rem;
            font-weight: 600;
        }

        .close-btn {
            background: transparent;
            border: none;
            color: var(--text-muted);
            font-size: 1.5rem;
            cursor: pointer;
            padding: 0;
            width: 30px;
            height: 30px;
        }

        .close-btn:hover {
            color: var(--text);
        }

        .voice-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .voice-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .voice-item:hover {
            border-color: var(--accent);
            background: rgba(88, 166, 255, 0.05);
        }

        .voice-item.selected {
            border-color: var(--success);
            background: rgba(63, 185, 80, 0.1);
        }

        .voice-info {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }

        .voice-name {
            font-weight: 500;
            color: var(--text);
        }

        .voice-category {
            font-size: 0.875rem;
            color: var(--text-muted);
        }

        .voice-actions {
            display: flex;
            gap: 0.5rem;
        }

        .preview-btn, .select-btn {
            padding: 0.5rem 1rem;
            border-radius: 6px;
            border: 1px solid var(--border);
            background: var(--surface);
            color: var(--text);
            cursor: pointer;
            font-size: 0.875rem;
            transition: all 0.2s;
        }

        .preview-btn:hover {
            border-color: var(--accent);
            background: rgba(88, 166, 255, 0.1);
        }

        .select-btn:hover {
            border-color: var(--success);
            background: rgba(63, 185, 80, 0.1);
            color: var(--success);
        }

        .loading {
            text-align: center;
            color: var(--text-muted);
            padding: 2rem;
        }

        .error {
            color: var(--error);
            padding: 1rem;
            background: rgba(248, 81, 73, 0.1);
            border: 1px solid var(--error);
            border-radius: 8px;
            margin-bottom: 1rem;
        }

        .current-voice {
            padding: 1rem;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            margin-bottom: 1rem;
        }

        .current-voice-label {
            font-size: 0.875rem;
            color: var(--text-muted);
            margin-bottom: 0.5rem;
        }

        .current-voice-name {
            font-size: 1.125rem;
            font-weight: 500;
            color: var(--success);
        }

        /* Task Panel Styles */
        .task-panel {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: var(--surface);
            border-top: 1px solid var(--border);
            z-index: 100;
            transition: transform 0.3s ease;
            max-height: 50vh;
            display: flex;
            flex-direction: column;
        }

        .task-panel.collapsed {
            transform: translateY(calc(100% - 40px));
        }

        .task-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.5rem 1rem;
            cursor: pointer;
            border-bottom: 1px solid var(--border);
            min-height: 40px;
            flex-shrink: 0;
            user-select: none;
        }

        .task-panel-header:hover {
            background: rgba(88, 166, 255, 0.05);
        }

        .task-panel-title {
            font-size: 0.875rem;
            font-weight: 600;
            color: var(--text);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .task-count-badge {
            background: var(--accent);
            color: var(--bg);
            font-size: 0.7rem;
            padding: 0.1rem 0.4rem;
            border-radius: 10px;
            font-weight: 700;
        }

        .task-panel-toggle {
            font-size: 0.75rem;
            color: var(--text-muted);
            transition: transform 0.3s;
        }

        .task-panel.collapsed .task-panel-toggle {
            transform: rotate(180deg);
        }

        .task-panel-workspace {
            padding: 0.4rem 1rem;
            font-size: 0.75rem;
            color: var(--text-muted);
            background: var(--bg);
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            gap: 0.4rem;
            flex-shrink: 0;
        }

        .task-panel-workspace .ws-name {
            color: var(--accent);
            font-weight: 500;
        }

        .task-list-scroll {
            overflow-y: auto;
            flex: 1;
            padding: 0.5rem;
        }

        .task-item {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            padding: 0.5rem 0.75rem;
            border-radius: 6px;
            margin-bottom: 0.25rem;
            transition: background 0.15s;
        }

        .task-item:hover {
            background: rgba(88, 166, 255, 0.05);
        }

        .task-state-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }

        .task-state-dot.busy { background: var(--accent); animation: dot-pulse 1.5s infinite; }
        .task-state-dot.starting { background: var(--warning); animation: dot-pulse 1s infinite; }
        .task-state-dot.waiting_input { background: var(--warning); }
        .task-state-dot.idle { background: var(--success); }
        .task-state-dot.exited { background: var(--text-muted); }
        .task-state-dot.disconnected { background: var(--text-muted); opacity: 0.5; }
        .task-state-dot.interrupted { background: var(--error); }

        @keyframes dot-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        .task-item-info {
            flex: 1;
            min-width: 0;
        }

        .task-item-name {
            font-size: 0.8rem;
            color: var(--text);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .task-item-state {
            font-size: 0.7rem;
            color: var(--text-muted);
        }

        .task-item-time {
            font-size: 0.65rem;
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .task-empty {
            text-align: center;
            color: var(--text-muted);
            font-size: 0.8rem;
            padding: 1rem;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎤 Claudia Voice Agent</h1>
        <div class="header-controls">
            <button class="toggle-btn active" id="micToggle" onclick="toggleMicEnabled()" title="Microphone">🎙️</button>
            <button class="toggle-btn active" id="ttsToggle" onclick="toggleTtsEnabled()" title="Voice output">🔊</button>
            <button class="settings-btn" onclick="showSettings()">⚙️ Settings</button>
        </div>
    </div>

    <div class="content">
        <div class="voice-controls">
            <button class="mic-button" id="micButton" onclick="toggleRecording()">
                🎤
            </button>
            <div class="status" id="status">Click to start recording</div>
            <div class="transcript">
                <div class="transcript-text empty" id="transcript">Your speech will appear here...</div>
            </div>
            <div class="transcript" id="responseArea" style="margin-top: 1rem; display: none;">
                <div class="transcript-text" id="responseText" style="color: var(--success);"></div>
            </div>
            <div class="text-input-container">
                <textarea id="textInput" class="text-input" placeholder="Type a message..." rows="1"></textarea>
                <button id="sendButton" class="send-btn" onclick="sendTextMessage()">➤</button>
            </div>
        </div>
    </div>

    <!-- Task Panel -->
    <div class="task-panel collapsed" id="taskPanel">
        <div class="task-panel-header" onclick="toggleTaskPanel()">
            <div class="task-panel-title">
                Tasks <span class="task-count-badge" id="taskCountBadge">0</span>
            </div>
            <div class="task-panel-toggle">▼</div>
        </div>
        <div class="task-panel-workspace" id="taskPanelWorkspace" style="display:none;">
            <span>Workspace:</span> <span class="ws-name" id="workspaceName">—</span>
        </div>
        <div class="task-list-scroll" id="taskListScroll">
            <div class="task-empty">No tasks</div>
        </div>
    </div>

    <!-- Settings Modal -->
    <div class="modal" id="settingsModal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 class="modal-title">Voice Settings</h2>
                <button class="close-btn" onclick="closeSettings()">×</button>
            </div>
            <div id="settingsContent">
                <div class="current-voice" id="currentVoiceDisplay"></div>
                <div class="loading">Loading voices...</div>
            </div>
        </div>
    </div>

    <script>
        // Determine WebSocket URL client-side to handle tunnel/HTTPS correctly
        const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const WS_URL = WS_PROTOCOL + '//' + window.location.host;
        const TOKEN = '${token}';
        const DEEPGRAM_API_KEY = '${deepgramApiKey}';

        let ws = null;
        let mediaRecorder = null;
        let deepgramSocket = null;
        let isRecording = false;
        let audioContext = null;
        let micEnabled = localStorage.getItem('voiceMicEnabled') !== 'false';
        let ttsEnabled = localStorage.getItem('voiceTtsEnabled') !== 'false';

        function toggleMicEnabled() {
            micEnabled = !micEnabled;
            localStorage.setItem('voiceMicEnabled', micEnabled);
            document.getElementById('micToggle').classList.toggle('active', micEnabled);
            if (!micEnabled && isRecording) {
                toggleRecording();
            }
            document.getElementById('micButton').style.display = micEnabled ? '' : 'none';
            document.getElementById('status').textContent = micEnabled ? 'Click to start recording' : 'Mic disabled';
        }

        function toggleTtsEnabled() {
            ttsEnabled = !ttsEnabled;
            localStorage.setItem('voiceTtsEnabled', ttsEnabled);
            document.getElementById('ttsToggle').classList.toggle('active', ttsEnabled);
        }

        // Apply initial toggle state
        (function initToggles() {
            document.getElementById('micToggle').classList.toggle('active', micEnabled);
            document.getElementById('ttsToggle').classList.toggle('active', ttsEnabled);
            if (!micEnabled) {
                document.getElementById('micButton').style.display = 'none';
                document.getElementById('status').textContent = 'Mic disabled';
            }
        })();

        // Initialize WebSocket connection
        function initWebSocket() {
            ws = new WebSocket(\`\${WS_URL}/ws?token=\${TOKEN}&voice=1\`);

            ws.onopen = () => {
                console.log('WebSocket connected');
            };

            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                handleWSMessage(message);
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                updateStatus('Connection error', false);
            };

            ws.onclose = () => {
                console.log('WebSocket closed');
                setTimeout(initWebSocket, 1000);
            };
        }

        function handleWSMessage(message) {
            console.log('[Voice WS] Received message:', message.type, message.payload);
            // Route task/workspace messages to panel
            handleTaskMessages(message);

            if (message.type === 'voice:announce') {
                playAnnouncement(message.payload.text);
            } else if (message.type === 'voice:status') {
                if (message.payload.status === 'processing') {
                    updateStatus('Thinking...', true);
                    // Clear previous response and show area
                    const responseArea = document.getElementById('responseArea');
                    const responseText = document.getElementById('responseText');
                    responseText.textContent = '';
                    responseArea.style.display = 'block';
                }
            } else if (message.type === 'voice:text_chunk') {
                // Append streaming text chunks
                const responseText = document.getElementById('responseText');
                responseText.textContent += message.payload.text;
            } else if (message.type === 'voice:response') {
                // Final response - show full text and play TTS
                const responseText = document.getElementById('responseText');
                responseText.textContent = message.payload.text;
                updateStatus('Click to start recording', false);
                // Play TTS audio
                if (message.payload.text && message.payload.action !== 'error') {
                    playTTS(message.payload.text);
                }
            }
        }

        function playAnnouncement(text) {
            console.log('Playing announcement:', text);
            playTTS(text);
        }

        async function playTTS(text) {
            if (!ttsEnabled) return;
            if (!text || text.trim().length === 0) return;
            try {
                const voiceId = localStorage.getItem('elevenLabsVoiceId') || '';
                const voiceName = localStorage.getItem('elevenLabsVoiceName') || 'charlotte';
                console.log('[Voice TTS] Speaking:', text, 'voice:', voiceName);

                const response = await fetch('/api/tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, voice: voiceName })
                });

                if (!response.ok) {
                    console.error('[Voice TTS] TTS request failed:', response.status, response.statusText);
                    return;
                }

                const audioBlob = await response.blob();
                const audioUrl = URL.createObjectURL(audioBlob);
                const audio = new Audio(audioUrl);
                audio.onended = () => URL.revokeObjectURL(audioUrl);
                audio.onerror = (e) => {
                    console.error('[Voice TTS] Audio playback error:', e);
                    URL.revokeObjectURL(audioUrl);
                };
                await audio.play();
            } catch (error) {
                console.error('[Voice TTS] Failed to play TTS:', error);
            }
        }

        async function toggleRecording() {
            if (!micEnabled) return;
            if (isRecording) {
                stopRecording();
            } else {
                await startRecording();
            }
        }

        function getSupportedMimeType() {
            const types = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/mp4',
                'audio/ogg;codecs=opus',
            ];
            for (const t of types) {
                if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) {
                    console.log('[Voice] Using mimeType:', t);
                    return t;
                }
            }
            console.warn('[Voice] No preferred mimeType supported, falling back to default');
            return '';
        }

        async function startRecording() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

                // Detect best mimeType for this browser
                const mimeType = getSupportedMimeType();

                // When MediaRecorder produces containerized audio (WebM, MP4, Ogg),
                // do NOT pass the encoding param — Deepgram auto-detects from the
                // container metadata. Only pass encoding for raw/headerless audio.
                const isContainerized = mimeType.includes('webm') || mimeType.includes('mp4') || mimeType.includes('ogg');
                const dgParams = 'model=nova-3&language=en&smart_format=true&punctuate=true&interim_results=true';
                const dgUrl = isContainerized
                    ? 'wss://api.deepgram.com/v1/listen?' + dgParams
                    : 'wss://api.deepgram.com/v1/listen?' + dgParams + '&encoding=linear16&sample_rate=48000';
                console.log('[Voice] Connecting to Deepgram, containerized:', isContainerized, 'mimeType:', mimeType);
                deepgramSocket = new WebSocket(dgUrl, ['token', DEEPGRAM_API_KEY]);

                deepgramSocket.onopen = () => {
                    console.log('Deepgram connected');
                    updateStatus('Listening...', true);
                };

                deepgramSocket.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    console.log('[Voice] Deepgram msg:', data.type, JSON.stringify(data).substring(0, 200));
                    if (data.type === 'Results') {
                        const alt = data.channel?.alternatives?.[0];
                        if (!alt) return;
                        const transcript = alt.transcript || '';
                        if (!transcript.trim()) return;

                        const isFinal = data.is_final === true;
                        console.log('[Voice] Transcript:', transcript, 'isFinal:', isFinal);
                        updateTranscript(transcript);

                        if (isFinal) {
                            sendVoiceInput(transcript);
                        }
                    } else if (data.type === 'Error') {
                        console.error('[Voice] Deepgram error:', data);
                        updateStatus('Recognition error', false);
                    }
                };

                deepgramSocket.onerror = (error) => {
                    console.error('Deepgram error:', error);
                    updateStatus('Recognition error', false);
                };

                deepgramSocket.onclose = () => {
                    console.log('[Voice] Deepgram WebSocket closed');
                };

                // Buffer chunks that arrive before Deepgram is ready.
                // The first chunk contains the WebM header — losing it means
                // Deepgram can't detect the container format.
                let pendingChunks = [];

                // Setup MediaRecorder with detected mimeType
                const recorderOptions = {};
                if (mimeType) recorderOptions.mimeType = mimeType;
                mediaRecorder = new MediaRecorder(stream, recorderOptions);

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size === 0) return;
                    if (deepgramSocket?.readyState === WebSocket.OPEN) {
                        // Flush any buffered chunks first
                        if (pendingChunks.length > 0) {
                            console.log('[Voice] Flushing', pendingChunks.length, 'buffered chunks');
                            for (const chunk of pendingChunks) {
                                deepgramSocket.send(chunk);
                            }
                            pendingChunks = [];
                        }
                        deepgramSocket.send(event.data);
                    } else if (deepgramSocket?.readyState === WebSocket.CONNECTING) {
                        console.log('[Voice] Buffering chunk:', event.data.size, 'bytes (DG still connecting)');
                        pendingChunks.push(event.data);
                    }
                };

                mediaRecorder.start(250); // Send data every 250ms
                isRecording = true;

                document.getElementById('micButton').classList.add('active');
            } catch (error) {
                console.error('Failed to start recording:', error);
                updateStatus('Microphone access denied', false);
            }
        }

        function stopRecording() {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
                mediaRecorder.stream.getTracks().forEach(track => track.stop());
            }

            if (deepgramSocket) {
                deepgramSocket.close();
            }

            isRecording = false;
            document.getElementById('micButton').classList.remove('active');
            updateStatus('Click to start recording', false);
        }

        function updateStatus(text, active) {
            const statusEl = document.getElementById('status');
            statusEl.textContent = text;
            if (active) {
                statusEl.classList.add('active');
            } else {
                statusEl.classList.remove('active');
            }
        }

        function updateTranscript(text) {
            const transcriptEl = document.getElementById('transcript');
            transcriptEl.textContent = text;
            transcriptEl.classList.remove('empty');
        }

        function sendVoiceInput(text) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'voice:input',
                    payload: { text }
                }));
            }
        }

        function sendTextMessage() {
            const input = document.getElementById('textInput');
            const text = input.value.trim();
            if (!text) return;
            updateTranscript(text);
            sendVoiceInput(text);
            input.value = '';
            input.style.height = 'auto';
        }

        // Auto-resize textarea and handle Enter to send
        (function initTextInput() {
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
        })();

        function showSettings() {
            document.getElementById('settingsModal').classList.add('show');
            loadVoices();
        }

        function closeSettings() {
            document.getElementById('settingsModal').classList.remove('show');
        }

        async function loadVoices() {
            const contentEl = document.getElementById('settingsContent');
            const currentVoiceId = localStorage.getItem('elevenLabsVoiceId');
            const currentVoiceName = localStorage.getItem('elevenLabsVoiceName');

            try {
                // Show current voice
                const currentVoiceEl = document.getElementById('currentVoiceDisplay');
                if (currentVoiceName) {
                    currentVoiceEl.innerHTML = \`
                        <div class="current-voice-label">Current Voice</div>
                        <div class="current-voice-name">\${currentVoiceName}</div>
                    \`;
                } else {
                    currentVoiceEl.innerHTML = \`
                        <div class="current-voice-label">Current Voice</div>
                        <div class="current-voice-name">Default</div>
                    \`;
                }

                const response = await fetch('/api/elevenlabs/voices');
                if (!response.ok) {
                    throw new Error(\`Failed to fetch voices: \${response.statusText}\`);
                }

                const voices = await response.json();

                contentEl.innerHTML = \`
                    <div class="current-voice" id="currentVoiceDisplay"></div>
                    <ul class="voice-list" id="voiceList"></ul>
                \`;

                // Re-show current voice after content update
                const currentVoiceDisplay = document.getElementById('currentVoiceDisplay');
                if (currentVoiceName) {
                    currentVoiceDisplay.innerHTML = \`
                        <div class="current-voice-label">Current Voice</div>
                        <div class="current-voice-name">\${currentVoiceName}</div>
                    \`;
                } else {
                    currentVoiceDisplay.innerHTML = \`
                        <div class="current-voice-label">Current Voice</div>
                        <div class="current-voice-name">Default</div>
                    \`;
                }

                const voiceList = document.getElementById('voiceList');
                voices.forEach(voice => {
                    const li = document.createElement('li');
                    li.className = 'voice-item';
                    if (voice.voice_id === currentVoiceId) {
                        li.classList.add('selected');
                    }

                    li.innerHTML = \`
                        <div class="voice-info">
                            <div class="voice-name">\${voice.name}</div>
                            <div class="voice-category">[\${voice.category}]</div>
                        </div>
                        <div class="voice-actions">
                            <button class="preview-btn" onclick="previewVoice('\${voice.voice_id}', '\${voice.name}')">
                                🔊 Preview
                            </button>
                            <button class="select-btn" onclick="selectVoice('\${voice.voice_id}', '\${voice.name}')">
                                ✓ Select
                            </button>
                        </div>
                    \`;

                    voiceList.appendChild(li);
                });
            } catch (error) {
                console.error('Failed to load voices:', error);
                contentEl.innerHTML = \`
                    <div class="error">Failed to load voices: \${error.message}</div>
                \`;
            }
        }

        async function previewVoice(voiceId, voiceName) {
            try {
                const response = await fetch(\`/api/elevenlabs/voices/\${voiceId}/preview\`);
                if (!response.ok) {
                    throw new Error(\`Failed to fetch preview: \${response.statusText}\`);
                }

                const audioBlob = await response.blob();
                const audioUrl = URL.createObjectURL(audioBlob);

                const audio = new Audio(audioUrl);
                audio.play();

                audio.onended = () => {
                    URL.revokeObjectURL(audioUrl);
                };
            } catch (error) {
                console.error('Failed to preview voice:', error);
                alert(\`Failed to preview voice: \${error.message}\`);
            }
        }

        function selectVoice(voiceId, voiceName) {
            localStorage.setItem('elevenLabsVoiceId', voiceId);
            localStorage.setItem('elevenLabsVoiceName', voiceName);

            // Send to backend
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'config:update',
                    payload: {
                        elevenLabsVoiceId: voiceId
                    }
                }));
            }

            closeSettings();
            alert(\`Voice changed to: \${voiceName}\`);
        }

        // ===== Task Panel =====
        let allTasks = [];
        let allWorkspaces = [];

        function toggleTaskPanel() {
            document.getElementById('taskPanel').classList.toggle('collapsed');
        }

        function getTaskDisplayName(task) {
            return task.displayName || (task.prompt && task.prompt.length > 60
                ? task.prompt.substring(0, 60) + '...'
                : task.prompt) || 'Untitled';
        }

        function getWorkspaceName(workspaceId) {
            const ws = allWorkspaces.find(w => w.id === workspaceId);
            if (ws) return ws.displayName || ws.name;
            if (!workspaceId) return '—';
            const parts = workspaceId.replace(/\\\\/g, '/').split('/');
            return parts[parts.length - 1] || workspaceId;
        }

        function timeAgo(dateStr) {
            if (!dateStr) return '';
            const d = new Date(dateStr);
            const now = Date.now();
            const diff = Math.floor((now - d.getTime()) / 1000);
            if (diff < 60) return 'just now';
            if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
            if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
            return Math.floor(diff / 86400) + 'd ago';
        }

        function renderTaskList() {
            const scroll = document.getElementById('taskListScroll');
            const badge = document.getElementById('taskCountBadge');
            const wsEl = document.getElementById('taskPanelWorkspace');
            const wsNameEl = document.getElementById('workspaceName');

            // Filter to recent/active tasks: running or active in last 24h
            const now = Date.now();
            const DAY = 24 * 60 * 60 * 1000;
            const activeTasks = allTasks.filter(t => {
                if (['busy', 'starting', 'waiting_input'].includes(t.state)) return true;
                const lastAct = new Date(t.lastActivity || t.createdAt).getTime();
                return (now - lastAct) < DAY && t.state !== 'archived';
            });

            // Sort: running first, then by last activity
            const stateOrder = { busy: 0, starting: 1, waiting_input: 2, idle: 3, exited: 4, interrupted: 5, disconnected: 6 };
            activeTasks.sort((a, b) => {
                const sa = stateOrder[a.state] ?? 9;
                const sb = stateOrder[b.state] ?? 9;
                if (sa !== sb) return sa - sb;
                const ta = new Date(b.lastActivity || b.createdAt).getTime();
                const tb = new Date(a.lastActivity || a.createdAt).getTime();
                return ta - tb;
            });

            const runningCount = activeTasks.filter(t => ['busy', 'starting', 'waiting_input'].includes(t.state)).length;
            badge.textContent = runningCount > 0 ? runningCount : activeTasks.length;
            badge.style.background = runningCount > 0 ? 'var(--accent)' : 'var(--text-muted)';

            // Show workspace if tasks exist
            if (activeTasks.length > 0) {
                const primaryWs = activeTasks[0].workspaceId;
                wsNameEl.textContent = getWorkspaceName(primaryWs);
                wsEl.style.display = '';
            } else {
                wsEl.style.display = 'none';
            }

            if (activeTasks.length === 0) {
                scroll.innerHTML = '<div class="task-empty">No recent tasks</div>';
                return;
            }

            scroll.innerHTML = activeTasks.map(t => \`
                <div class="task-item">
                    <div class="task-state-dot \${t.state}"></div>
                    <div class="task-item-info">
                        <div class="task-item-name">\${escapeHtml(getTaskDisplayName(t))}</div>
                        <div class="task-item-state">\${t.state}\${t.workspaceId ? ' · ' + escapeHtml(getWorkspaceName(t.workspaceId)) : ''}</div>
                    </div>
                    <div class="task-item-time">\${timeAgo(t.lastActivity || t.createdAt)}</div>
                </div>
            \`).join('');
        }

        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function handleTaskMessages(message) {
            if (message.type === 'init') {
                allTasks = message.payload.tasks || [];
                allWorkspaces = message.payload.workspaces || [];
                renderTaskList();
            } else if (message.type === 'tasks:updated') {
                allTasks = message.payload.tasks || [];
                renderTaskList();
            } else if (message.type === 'task:stateChanged') {
                const updated = message.payload.task;
                if (updated) {
                    const idx = allTasks.findIndex(t => t.id === updated.id);
                    if (idx >= 0) allTasks[idx] = updated;
                    else allTasks.push(updated);
                    renderTaskList();
                }
            } else if (message.type === 'workspace:created') {
                const ws = message.payload.workspace;
                if (ws && !allWorkspaces.find(w => w.id === ws.id)) {
                    allWorkspaces.push(ws);
                }
            }
        }

        // Initialize on load
        initWebSocket();

        // Close modal on outside click
        document.getElementById('settingsModal').addEventListener('click', (e) => {
            if (e.target.id === 'settingsModal') {
                closeSettings();
            }
        });
    </script>
</body>
</html>`;
}
