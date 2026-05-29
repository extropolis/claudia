import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    isTunnelAccess,
    getMobileToken,
    getApiBaseUrl,
    getWebSocketUrl,
    isElectron,
} from '../api-config';
import { PORTS } from '@claudia/shared';

/**
 * Override window.location with a partial location object.
 * jsdom's window.location is not directly assignable, so we redefine it.
 */
function setLocation(partial: Partial<Location>) {
    const base: any = {
        hostname: 'localhost',
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
        protocol: 'http:',
        search: '',
    };
    Object.defineProperty(window, 'location', {
        value: { ...base, ...partial },
        configurable: true,
        writable: true,
    });
}

function clearElectron() {
    delete (window as any).electronAPI;
}

describe('api-config', () => {
    beforeEach(() => {
        clearElectron();
        setLocation({});
    });

    afterEach(() => {
        clearElectron();
    });

    describe('isTunnelAccess', () => {
        it('returns false for localhost', () => {
            setLocation({ hostname: 'localhost' });
            expect(isTunnelAccess()).toBe(false);
        });

        it('detects .loca.lt', () => {
            setLocation({ hostname: 'myapp.loca.lt' });
            expect(isTunnelAccess()).toBe(true);
        });

        it('detects ngrok-free.app', () => {
            setLocation({ hostname: 'abc.ngrok-free.app' });
            expect(isTunnelAccess()).toBe(true);
        });

        it('detects ngrok.io', () => {
            setLocation({ hostname: 'abc.ngrok.io' });
            expect(isTunnelAccess()).toBe(true);
        });

        it('detects generic ngrok host', () => {
            setLocation({ hostname: 'foo.ngrok.example' });
            expect(isTunnelAccess()).toBe(true);
        });
    });

    describe('getMobileToken', () => {
        it('returns null when no token param', () => {
            setLocation({ search: '' });
            expect(getMobileToken()).toBeNull();
        });

        it('extracts the token param', () => {
            setLocation({ search: '?token=abc123&mobile=1' });
            expect(getMobileToken()).toBe('abc123');
        });
    });

    describe('isElectron', () => {
        it('returns false without electronAPI', () => {
            expect(isElectron()).toBe(false);
        });

        it('returns true with electronAPI', () => {
            (window as any).electronAPI = { getBackendUrl: () => 'http://x' };
            expect(isElectron()).toBe(true);
        });
    });

    describe('getApiBaseUrl', () => {
        it('uses electron backend url when in electron', () => {
            (window as any).electronAPI = { getBackendUrl: () => 'http://127.0.0.1:9999' };
            expect(getApiBaseUrl()).toBe('http://127.0.0.1:9999');
        });

        it('uses origin for tunnel access', () => {
            setLocation({ hostname: 'app.loca.lt', origin: 'https://app.loca.lt' });
            expect(getApiBaseUrl()).toBe('https://app.loca.lt');
        });

        it('uses hostname + backend port for web', () => {
            setLocation({ hostname: 'myhost' });
            expect(getApiBaseUrl()).toBe(`http://myhost:${PORTS.BACKEND}`);
        });
    });

    describe('getWebSocketUrl', () => {
        it('converts electron http url to ws', () => {
            (window as any).electronAPI = { getBackendUrl: () => 'http://127.0.0.1:9999' };
            expect(getWebSocketUrl()).toBe('ws://127.0.0.1:9999');
        });

        it('uses wss for https tunnel with token', () => {
            setLocation({
                hostname: 'app.loca.lt',
                host: 'app.loca.lt',
                protocol: 'https:',
                search: '?token=tok99',
            });
            expect(getWebSocketUrl()).toBe('wss://app.loca.lt?token=tok99&mobile=1');
        });

        it('uses ws for http tunnel without token', () => {
            setLocation({
                hostname: 'app.loca.lt',
                host: 'app.loca.lt',
                protocol: 'http:',
                search: '',
            });
            expect(getWebSocketUrl()).toBe('ws://app.loca.lt');
        });

        it('uses hostname + backend port for web', () => {
            setLocation({ hostname: 'myhost' });
            expect(getWebSocketUrl()).toBe(`ws://myhost:${PORTS.BACKEND}`);
        });
    });
});
