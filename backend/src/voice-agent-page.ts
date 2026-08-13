/**
 * Voice Agent Page - Self-contained HTML page for voice-based task interaction
 *
 * Provides voice input via Deepgram Nova-3 and voice output via ElevenLabs TTS.
 * Includes voice selection UI with preview capabilities.
 * Loads from CDN. No React or build dependencies.
 *
 * All caller-supplied values land inside an inline <script>, so they MUST go
 * through jsLiteral() — see html-escape.ts for why JSON.stringify alone is not
 * enough. `token` here is attacker-controlled: GET /voice?token=... accepts any
 * `local-` prefixed token without validation.
 */
import { jsLiteral } from './html-escape.js';

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

        .content {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 2rem;
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
    </style>
</head>
<body>
    <div class="header">
        <h1>🎤 Claudia Voice Agent</h1>
        <button class="settings-btn" onclick="showSettings()">⚙️ Settings</button>
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
        const WS_URL = ${jsLiteral(wsUrl)};
        const TOKEN = ${jsLiteral(token)};
        const DEEPGRAM_API_KEY = ${jsLiteral(deepgramApiKey)};

        let ws = null;
        let mediaRecorder = null;
        let deepgramSocket = null;
        let isRecording = false;
        let audioContext = null;

        // Initialize WebSocket connection
        function initWebSocket() {
            ws = new WebSocket(\`\${WS_URL}/ws?token=\${TOKEN}\`);

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
            if (message.type === 'voice:announce') {
                playAnnouncement(message.payload.text);
            }
        }

        function playAnnouncement(text) {
            console.log('Playing announcement:', text);
            // Audio will be played via voice supervisor
        }

        async function toggleRecording() {
            if (isRecording) {
                stopRecording();
            } else {
                await startRecording();
            }
        }

        async function startRecording() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

                // Initialize Deepgram WebSocket
                deepgramSocket = new WebSocket(
                    'wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true',
                    ['token', DEEPGRAM_API_KEY]
                );

                deepgramSocket.onopen = () => {
                    console.log('Deepgram connected');
                    updateStatus('Listening...', true);
                };

                deepgramSocket.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    if (data.channel?.alternatives?.[0]?.transcript) {
                        const transcript = data.channel.alternatives[0].transcript;
                        if (transcript.trim()) {
                            updateTranscript(transcript);

                            // Send to backend if final
                            if (data.is_final) {
                                sendVoiceInput(transcript);
                            }
                        }
                    }
                };

                deepgramSocket.onerror = (error) => {
                    console.error('Deepgram error:', error);
                    updateStatus('Recognition error', false);
                };

                // Setup MediaRecorder
                mediaRecorder = new MediaRecorder(stream, {
                    mimeType: 'audio/webm;codecs=opus'
                });

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0 && deepgramSocket?.readyState === WebSocket.OPEN) {
                        deepgramSocket.send(event.data);
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
