/**
 * useVoiceAssistant - Hook for OpenAI Realtime API voice assistant
 *
 * Connects to the backend voice WebSocket for bidirectional voice communication.
 * Features:
 * - Real-time speech-to-text via OpenAI Whisper
 * - Natural text-to-speech responses
 * - Voice commands for task management
 * - Task completion announcements
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// Audio configuration for OpenAI Realtime API
const SAMPLE_RATE = 24000; // 24kHz required by OpenAI
const CHANNELS = 1; // Mono audio

interface VoiceAssistantState {
    isConnected: boolean;
    isConnecting: boolean;
    isListening: boolean;
    isSpeaking: boolean;
    transcript: string;
    response: string;
    error: string | null;
}

interface VoiceCommandResult {
    command: string;
    result: {
        success?: boolean;
        taskId?: string;
        tasks?: Array<{ id: string; prompt: string; state: string }>;
        message?: string;
        error?: string;
    };
}

interface UseVoiceAssistantOptions {
    onCommandExecuted?: (result: VoiceCommandResult) => void;
    onTaskCreated?: (taskId: string, prompt: string) => void;
    onError?: (error: string) => void;
}

export function useVoiceAssistant(options: UseVoiceAssistantOptions = {}) {
    const [state, setState] = useState<VoiceAssistantState>({
        isConnected: false,
        isConnecting: false,
        isListening: false,
        isSpeaking: false,
        transcript: '',
        response: '',
        error: null
    });

    const wsRef = useRef<WebSocket | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const audioQueueRef = useRef<string[]>([]);
    const isPlayingRef = useRef(false);

    // Get WebSocket URL for voice endpoint
    const getVoiceWsUrl = useCallback(() => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname;
        const port = 4001; // Backend port
        return `${protocol}//${host}:${port}/voice`;
    }, []);

    // Connect to voice WebSocket
    const connect = useCallback(async () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            return;
        }

        setState(prev => ({ ...prev, isConnecting: true, error: null }));

        try {
            const ws = new WebSocket(getVoiceWsUrl());
            wsRef.current = ws;

            ws.onopen = () => {
                console.log('[VoiceAssistant] WebSocket connected');
                // Request connection to OpenAI Realtime API
                ws.send(JSON.stringify({ type: 'voice:connect' }));
            };

            ws.onmessage = (event) => {
                handleMessage(JSON.parse(event.data));
            };

            ws.onclose = (event) => {
                console.log('[VoiceAssistant] WebSocket closed', event.code, event.reason);
                setState(prev => ({
                    ...prev,
                    isConnected: false,
                    isConnecting: false,
                    isListening: false
                }));
                cleanup();
            };

            ws.onerror = (error) => {
                console.error('[VoiceAssistant] WebSocket error', error);
                setState(prev => ({
                    ...prev,
                    error: 'Connection error',
                    isConnecting: false
                }));
            };

        } catch (error) {
            console.error('[VoiceAssistant] Failed to connect', error);
            setState(prev => ({
                ...prev,
                error: 'Failed to connect to voice service',
                isConnecting: false
            }));
        }
    }, [getVoiceWsUrl]);

    // Handle incoming WebSocket messages
    const handleMessage = useCallback((message: { type: string; payload?: any }) => {
        switch (message.type) {
            case 'voice:connected':
                setState(prev => ({
                    ...prev,
                    isConnected: true,
                    isConnecting: false,
                    error: null
                }));
                break;

            case 'voice:disconnected':
                setState(prev => ({
                    ...prev,
                    isConnected: false,
                    isListening: false
                }));
                break;

            case 'voice:error':
                setState(prev => ({
                    ...prev,
                    error: message.payload?.message || 'Unknown error'
                }));
                options.onError?.(message.payload?.message);
                break;

            case 'voice:transcript':
                setState(prev => ({
                    ...prev,
                    transcript: message.payload?.text || ''
                }));
                break;

            case 'voice:response':
                setState(prev => ({
                    ...prev,
                    response: message.payload?.text || ''
                }));
                break;

            case 'voice:audio':
                // Queue audio for playback
                audioQueueRef.current.push(message.payload?.audio);
                playNextAudio();
                break;

            case 'voice:speechStart':
                setState(prev => ({ ...prev, isListening: true }));
                break;

            case 'voice:speechEnd':
                setState(prev => ({ ...prev, isListening: false }));
                break;

            case 'voice:command':
                options.onCommandExecuted?.(message.payload as VoiceCommandResult);
                if (message.payload?.command === 'create_task' && message.payload?.result?.taskId) {
                    options.onTaskCreated?.(
                        message.payload.result.taskId,
                        message.payload.result.prompt || ''
                    );
                }
                break;

            case 'voice:status':
                // Initial status message
                break;

            default:
                console.log('[VoiceAssistant] Unknown message type:', message.type);
        }
    }, [options]);

    // Play audio from queue
    const playNextAudio = useCallback(async () => {
        if (isPlayingRef.current || audioQueueRef.current.length === 0) {
            return;
        }

        isPlayingRef.current = true;
        setState(prev => ({ ...prev, isSpeaking: true }));

        try {
            const audioBase64 = audioQueueRef.current.shift()!;
            await playAudioBase64(audioBase64);
        } catch (error) {
            console.error('[VoiceAssistant] Error playing audio:', error);
        }

        isPlayingRef.current = false;
        setState(prev => ({ ...prev, isSpeaking: audioQueueRef.current.length > 0 }));

        // Play next in queue if available
        if (audioQueueRef.current.length > 0) {
            playNextAudio();
        }
    }, []);

    // Play base64-encoded PCM16 audio
    const playAudioBase64 = useCallback(async (base64Audio: string) => {
        return new Promise<void>((resolve, reject) => {
            try {
                // Decode base64 to binary
                const binaryString = atob(base64Audio);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // Convert PCM16 to Float32 for Web Audio API
                const pcm16 = new Int16Array(bytes.buffer);
                const float32 = new Float32Array(pcm16.length);
                for (let i = 0; i < pcm16.length; i++) {
                    float32[i] = pcm16[i] / 32768.0;
                }

                // Create audio context if needed
                if (!audioContextRef.current) {
                    audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
                }

                const audioContext = audioContextRef.current;

                // Create audio buffer
                const audioBuffer = audioContext.createBuffer(1, float32.length, SAMPLE_RATE);
                audioBuffer.getChannelData(0).set(float32);

                // Play the buffer
                const source = audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioContext.destination);
                source.onended = () => resolve();
                source.start();

            } catch (error) {
                reject(error);
            }
        });
    }, []);

    // Start capturing microphone audio
    const startListening = useCallback(async () => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            setState(prev => ({ ...prev, error: 'Not connected to voice service' }));
            return;
        }

        try {
            // Get microphone access
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: SAMPLE_RATE,
                    channelCount: CHANNELS,
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });

            mediaStreamRef.current = stream;

            // Create audio context for processing
            const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
            audioContextRef.current = audioContext;

            // Create source from microphone
            const source = audioContext.createMediaStreamSource(stream);
            sourceRef.current = source;

            // Create processor for capturing audio data
            // Note: ScriptProcessorNode is deprecated but still widely supported
            // AudioWorklet would be better but requires more setup
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (event) => {
                if (wsRef.current?.readyState !== WebSocket.OPEN) return;

                const inputData = event.inputBuffer.getChannelData(0);

                // Convert Float32 to PCM16
                const pcm16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Convert to base64
                const uint8Array = new Uint8Array(pcm16.buffer);
                let binary = '';
                for (let i = 0; i < uint8Array.length; i++) {
                    binary += String.fromCharCode(uint8Array[i]);
                }
                const base64Audio = btoa(binary);

                // Send to server
                wsRef.current.send(JSON.stringify({
                    type: 'voice:audio',
                    payload: { audio: base64Audio }
                }));
            };

            source.connect(processor);
            processor.connect(audioContext.destination);

            setState(prev => ({ ...prev, isListening: true, error: null }));

        } catch (error) {
            console.error('[VoiceAssistant] Failed to start listening', error);
            setState(prev => ({
                ...prev,
                error: 'Failed to access microphone'
            }));
        }
    }, []);

    // Stop capturing microphone audio
    const stopListening = useCallback(() => {
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }

        if (sourceRef.current) {
            sourceRef.current.disconnect();
            sourceRef.current = null;
        }

        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
            mediaStreamRef.current = null;
        }

        // Commit audio buffer to trigger response
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'voice:commit' }));
        }

        setState(prev => ({ ...prev, isListening: false }));
    }, []);

    // Send a text message (for testing or accessibility)
    const sendTextMessage = useCallback((text: string) => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
            setState(prev => ({ ...prev, error: 'Not connected to voice service' }));
            return;
        }

        wsRef.current.send(JSON.stringify({
            type: 'voice:text',
            payload: { text }
        }));
    }, []);

    // Update task context
    const updateTaskContext = useCallback((tasks: Array<{ id: string; prompt: string; state: string; workspaceId: string }>) => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;

        wsRef.current.send(JSON.stringify({
            type: 'voice:updateTasks',
            payload: { tasks }
        }));
    }, []);

    // Set current workspace
    const setCurrentWorkspace = useCallback((workspaceId: string) => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;

        wsRef.current.send(JSON.stringify({
            type: 'voice:setWorkspace',
            payload: { workspaceId }
        }));
    }, []);

    // Disconnect from voice service
    const disconnect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'voice:disconnect' }));
        }
        cleanup();
    }, []);

    // Cleanup resources
    const cleanup = useCallback(() => {
        stopListening();

        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }

        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }

        audioQueueRef.current = [];
    }, [stopListening]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cleanup();
        };
    }, [cleanup]);

    return {
        ...state,
        connect,
        disconnect,
        startListening,
        stopListening,
        sendTextMessage,
        updateTaskContext,
        setCurrentWorkspace
    };
}
