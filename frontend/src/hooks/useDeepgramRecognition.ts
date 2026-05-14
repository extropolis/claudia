import { useState, useEffect, useRef, useCallback } from 'react';

interface DeepgramRecognitionOptions {
  continuous?: boolean;
  interimResults?: boolean;
  language?: string;
  deepgramApiKey?: string;
  onResult?: (transcript: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  onListeningChange?: (isListening: boolean) => void;
}

/**
 * Detect the best supported audio mimeType for MediaRecorder.
 * Chrome/Android prefer webm+opus, Safari/iOS use mp4.
 */
function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const t of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) {
      console.log('[DeepgramRecognition] Using mimeType:', t);
      return t;
    }
  }
  console.warn('[DeepgramRecognition] No preferred mimeType supported, falling back to default');
  return '';
}

export function useDeepgramRecognition(options: DeepgramRecognitionOptions = {}) {
  const {
    continuous = false,
    interimResults = true,
    language = 'en',
    deepgramApiKey = '',
    onResult,
    onError,
    onListeningChange,
  } = options;

  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');

  // Refs to hold active resources
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shouldBeListeningRef = useRef(false);
  const accumulatedTranscriptRef = useRef('');

  // Callback refs to avoid recreating connections when callbacks change
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const onListeningChangeRef = useRef(onListeningChange);

  useEffect(() => {
    onResultRef.current = onResult;
    onErrorRef.current = onError;
    onListeningChangeRef.current = onListeningChange;
  }, [onResult, onError, onListeningChange]);

  // Check support on mount
  useEffect(() => {
    const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    setIsSupported(supported);
    console.log('[DeepgramRecognition] isSupported:', supported);
  }, []);

  /**
   * Release all resources: stop MediaRecorder, close WebSocket, release mic stream.
   */
  const cleanupResources = useCallback(() => {
    console.log('[DeepgramRecognition] Cleaning up resources');

    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch (e) {
        console.warn('[DeepgramRecognition] MediaRecorder stop error:', e);
      }
      mediaRecorderRef.current = null;
    }

    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          // Send empty buffer to signal end of audio
          wsRef.current.send(new Uint8Array(0));
        }
        wsRef.current.close();
      } catch (e) {
        console.warn('[DeepgramRecognition] WebSocket close error:', e);
      }
      wsRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop();
        console.log('[DeepgramRecognition] Stopped audio track:', track.label);
      });
      streamRef.current = null;
    }
  }, []);

  const startListening = useCallback(async () => {
    console.log(
      '[DeepgramRecognition] startListening called | isListening:',
      isListening,
      '| shouldBeListening:',
      shouldBeListeningRef.current,
    );

    if (shouldBeListeningRef.current) {
      console.log('[DeepgramRecognition] Already listening, skipping start');
      return;
    }

    if (!deepgramApiKey) {
      const msg = 'Deepgram API key not configured. Set it in Voice Settings.';
      console.error('[DeepgramRecognition]', msg);
      onErrorRef.current?.(msg);
      return;
    }

    // Reset state
    setTranscript('');
    setInterimTranscript('');
    accumulatedTranscriptRef.current = '';
    shouldBeListeningRef.current = true;

    try {
      // 1. Get microphone stream
      console.log('[DeepgramRecognition] Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      console.log('[DeepgramRecognition] Microphone access granted');

      // Check if we were stopped while waiting for mic permission
      if (!shouldBeListeningRef.current) {
        console.log('[DeepgramRecognition] Stopped while waiting for mic, cleaning up');
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        return;
      }

      // 2. Determine encoding from mimeType
      const mimeType = getSupportedMimeType();
      let encoding = 'linear16';
      if (mimeType.includes('opus')) {
        encoding = 'opus';
      } else if (mimeType.includes('webm')) {
        encoding = 'webm';
      } else if (mimeType.includes('mp4')) {
        encoding = 'mp4';
      }

      // 3. Open WebSocket to Deepgram
      const lang = language || 'en';
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&interim_results=${interimResults}&language=${lang}&smart_format=true&encoding=${encoding}`;
      console.log('[DeepgramRecognition] Opening WebSocket to Deepgram...');
      const ws = new WebSocket(wsUrl, ['token', deepgramApiKey]);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[DeepgramRecognition] WebSocket connected to Deepgram');

        // Check again if we should still be listening
        if (!shouldBeListeningRef.current) {
          console.log('[DeepgramRecognition] Stopped before WS opened, closing');
          ws.close();
          return;
        }

        // 4. Start MediaRecorder to chunk audio every 250ms
        try {
          const recorderOptions: MediaRecorderOptions = {};
          if (mimeType) {
            recorderOptions.mimeType = mimeType;
          }
          const recorder = new MediaRecorder(stream, recorderOptions);
          mediaRecorderRef.current = recorder;

          recorder.ondataavailable = (event) => {
            if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
              ws.send(event.data);
            }
          };

          recorder.onerror = (event) => {
            console.error('[DeepgramRecognition] MediaRecorder error:', event);
            onErrorRef.current?.('Microphone recording error');
          };

          recorder.start(250); // Chunk every 250ms
          console.log(
            '[DeepgramRecognition] MediaRecorder started (250ms chunks, mimeType:',
            mimeType || 'default',
            ')',
          );

          setIsListening(true);
          onListeningChangeRef.current?.(true);
        } catch (recErr) {
          console.error('[DeepgramRecognition] MediaRecorder creation failed:', recErr);
          onErrorRef.current?.('Failed to start audio recording');
          shouldBeListeningRef.current = false;
          cleanupResources();
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Deepgram sends various message types
          if (data.type === 'Results') {
            const alt = data.channel?.alternatives?.[0];
            if (!alt) return;

            const text = alt.transcript || '';
            if (!text) return;

            const isFinal = data.is_final === true;
            const speechFinal = data.speech_final === true;

            console.log(
              '[DeepgramRecognition] Transcript:',
              text,
              '| is_final:',
              isFinal,
              '| speech_final:',
              speechFinal,
            );

            if (isFinal) {
              // Accumulate final transcripts
              if (continuous) {
                const spacer = accumulatedTranscriptRef.current ? ' ' : '';
                accumulatedTranscriptRef.current += spacer + text;
                setTranscript(accumulatedTranscriptRef.current);
              } else {
                setTranscript(text);
              }
              setInterimTranscript('');
              onResultRef.current?.(text, true);
            } else if (interimResults) {
              setInterimTranscript(text);
              onResultRef.current?.(text, false);
            }
          } else if (data.type === 'Metadata') {
            console.log('[DeepgramRecognition] Metadata:', data);
          } else if (data.type === 'Error') {
            console.error('[DeepgramRecognition] Deepgram error:', data);
            onErrorRef.current?.(data.description || 'Deepgram transcription error');
          }
        } catch (parseErr) {
          console.warn('[DeepgramRecognition] Failed to parse message:', parseErr);
        }
      };

      ws.onerror = (event) => {
        console.error('[DeepgramRecognition] WebSocket error:', event);
        onErrorRef.current?.('Connection error to Deepgram');
      };

      ws.onclose = (event) => {
        console.log(
          '[DeepgramRecognition] WebSocket closed:',
          event.code,
          event.reason,
          '| shouldBeListening:',
          shouldBeListeningRef.current,
        );

        // If we should still be listening (continuous mode), reconnect
        if (shouldBeListeningRef.current && continuous) {
          console.log('[DeepgramRecognition] Reconnecting in continuous mode...');
          // Clean up current resources but preserve shouldBeListeningRef
          if (mediaRecorderRef.current) {
            try {
              mediaRecorderRef.current.stop();
            } catch (e) {
              /* ignore */
            }
            mediaRecorderRef.current = null;
          }
          wsRef.current = null;
          // Keep stream alive, just reconnect WS and restart recorder
          if (streamRef.current && streamRef.current.active) {
            setTimeout(() => {
              if (shouldBeListeningRef.current) {
                // Recursively call startListening by stopping and restarting
                // But we need to be careful not to re-request mic
                reconnect(streamRef.current!);
              }
            }, 500);
          } else {
            // Stream died, full restart
            setIsListening(false);
            onListeningChangeRef.current?.(false);
            shouldBeListeningRef.current = false;
          }
        } else {
          setIsListening(false);
          onListeningChangeRef.current?.(false);
        }
      };
    } catch (err: any) {
      console.error('[DeepgramRecognition] Start failed:', err);
      shouldBeListeningRef.current = false;

      if (err.name === 'NotAllowedError') {
        onErrorRef.current?.('Microphone access denied. Please allow microphone access.');
      } else if (err.name === 'NotFoundError') {
        onErrorRef.current?.('No microphone found.');
      } else {
        onErrorRef.current?.(`Failed to start voice recognition: ${err.message}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepgramApiKey, language, continuous, interimResults, isListening, cleanupResources]);

  /**
   * Reconnect WebSocket while reusing existing mic stream (for continuous mode).
   */
  const reconnect = useCallback(
    (stream: MediaStream) => {
      if (!shouldBeListeningRef.current || !deepgramApiKey) return;

      const mimeType = getSupportedMimeType();
      let encoding = 'linear16';
      if (mimeType.includes('opus')) {
        encoding = 'opus';
      } else if (mimeType.includes('webm')) {
        encoding = 'webm';
      } else if (mimeType.includes('mp4')) {
        encoding = 'mp4';
      }

      const lang = language || 'en';
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&interim_results=${interimResults}&language=${lang}&smart_format=true&encoding=${encoding}`;
      console.log('[DeepgramRecognition] Reconnecting WebSocket...');
      const ws = new WebSocket(wsUrl, ['token', deepgramApiKey]);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[DeepgramRecognition] Reconnected to Deepgram');
        if (!shouldBeListeningRef.current) {
          ws.close();
          return;
        }

        try {
          const recorderOptions: MediaRecorderOptions = {};
          if (mimeType) {
            recorderOptions.mimeType = mimeType;
          }
          const recorder = new MediaRecorder(stream, recorderOptions);
          mediaRecorderRef.current = recorder;

          recorder.ondataavailable = (event) => {
            if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
              ws.send(event.data);
            }
          };

          recorder.start(250);
          console.log('[DeepgramRecognition] MediaRecorder restarted after reconnect');
        } catch (e) {
          console.error('[DeepgramRecognition] Reconnect recorder failed:', e);
          shouldBeListeningRef.current = false;
          setIsListening(false);
          onListeningChangeRef.current?.(false);
          cleanupResources();
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'Results') {
            const alt = data.channel?.alternatives?.[0];
            if (!alt) return;
            const text = alt.transcript || '';
            if (!text) return;

            const isFinal = data.is_final === true;

            if (isFinal) {
              const spacer = accumulatedTranscriptRef.current ? ' ' : '';
              accumulatedTranscriptRef.current += spacer + text;
              setTranscript(accumulatedTranscriptRef.current);
              setInterimTranscript('');
              onResultRef.current?.(text, true);
            } else if (interimResults) {
              setInterimTranscript(text);
              onResultRef.current?.(text, false);
            }
          } else if (data.type === 'Error') {
            console.error('[DeepgramRecognition] Deepgram error on reconnect:', data);
            onErrorRef.current?.(data.description || 'Deepgram transcription error');
          }
        } catch (e) {
          console.warn('[DeepgramRecognition] Parse error on reconnect:', e);
        }
      };

      ws.onerror = () => {
        console.error('[DeepgramRecognition] Reconnect WebSocket error');
      };

      ws.onclose = (event) => {
        console.log(
          '[DeepgramRecognition] Reconnect WS closed:',
          event.code,
          '| shouldBeListening:',
          shouldBeListeningRef.current,
        );
        if (shouldBeListeningRef.current && continuous && stream.active) {
          setTimeout(() => {
            if (shouldBeListeningRef.current) {
              reconnect(stream);
            }
          }, 1000);
        } else if (!shouldBeListeningRef.current) {
          // Expected close
        } else {
          setIsListening(false);
          onListeningChangeRef.current?.(false);
          shouldBeListeningRef.current = false;
        }
      };
       
    },
    [deepgramApiKey, language, continuous, interimResults, cleanupResources],
  );

  const stopListening = useCallback(() => {
    console.log('[DeepgramRecognition] stopListening called');
    shouldBeListeningRef.current = false;
    cleanupResources();
    setIsListening(false);
    setInterimTranscript('');
    onListeningChangeRef.current?.(false);
  }, [cleanupResources]);

  const resetTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    accumulatedTranscriptRef.current = '';
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldBeListeningRef.current = false;
      cleanupResources();
    };
  }, [cleanupResources]);

  return {
    isSupported,
    isListening,
    transcript,
    interimTranscript,
    startListening,
    stopListening,
    resetTranscript,
  };
}
