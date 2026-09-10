import { describe, it, expect } from 'vitest';
import { httpBaseFromWsUrl } from '../utils/backend-url.js';

describe('httpBaseFromWsUrl', () => {
    it('maps ws:// to http:// and preserves a non-default port', () => {
        expect(httpBaseFromWsUrl('ws://host:8080')).toBe('http://host:8080');
    });

    it('maps wss:// to https:// with no port', () => {
        expect(httpBaseFromWsUrl('wss://x.fly.dev')).toBe('https://x.fly.dev');
    });

    it('strips a trailing slash', () => {
        expect(httpBaseFromWsUrl('ws://localhost:4001/')).toBe('http://localhost:4001');
    });

    it('leaves an http(s) URL alone apart from the trailing slash', () => {
        expect(httpBaseFromWsUrl('https://x.fly.dev/')).toBe('https://x.fly.dev');
    });
});
