import { describe, it, expect, beforeEach } from 'vitest';
import { getApiBaseUrl, getWebSocketUrl, isElectron, getMobileToken } from '../api-config';
import { setAuthToken, __resetAuthFetchForTests } from '../auth-client';

function location(origin: string) {
    Object.defineProperty(window, 'location', { value: new URL(origin), configurable: true });
}
beforeEach(() => {
    delete window.electronAPI;
    location('http://localhost:5173');
    sessionStorage.clear();
    __resetAuthFetchForTests();
});

describe('backend origins', () => {
    it('retains the separate local Vite backend', () => {
        expect(getApiBaseUrl()).toBe('http://localhost:4001');
        expect(getWebSocketUrl()).toBe('ws://localhost:4001/');
    });
    it.each([
        ['https://pc.tail.ts.net', 'wss://pc.tail.ts.net/'],
        ['https://pc.tail.ts.net:8443', 'wss://pc.tail.ts.net:8443/'],
        ['http://192.168.1.20:4001', 'ws://192.168.1.20:4001/'],
        ['https://[fd7a:115c:a1e0::1]:8443', 'wss://[fd7a:115c:a1e0::1]:8443/'],
        ['https://custom.example', 'wss://custom.example/'],
    ])('preserves production origin %s', (origin, socket) => {
        location(origin);
        expect(getApiBaseUrl()).toBe(origin);
        expect(getWebSocketUrl()).toBe(socket);
        setAuthToken('a+b&c');
        expect(new URL(getWebSocketUrl()).searchParams.get('token')).toBe('a+b&c');
    });
    it('uses WSS for an Electron HTTPS attachment', () => {
        window.electronAPI = { getBackendUrl: () => 'https://pc.tail.ts.net:8443' } as any;
        expect(getWebSocketUrl()).toBe('wss://pc.tail.ts.net:8443/');
    });
});

it('uses the active credential for legacy token consumers and detects desktop mode', () => {
    expect(isElectron()).toBe(false);
    expect(getMobileToken()).toBeNull();
    setAuthToken('voice-token');
    expect(getMobileToken()).toBe('voice-token');
    window.electronAPI = { getBackendUrl: () => 'http://localhost:4001' } as any;
    expect(isElectron()).toBe(true);
});
