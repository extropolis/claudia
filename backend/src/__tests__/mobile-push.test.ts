import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    _setStorePathForTests,
    listDevices,
    registerDevice,
    reloadStore,
    unregisterDevice,
} from '../mobile-push.js';

describe('mobile-push device store persistence', () => {
    let dir: string;
    let storePath: string;
    let prevPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mobile-push-test-'));
        storePath = join(dir, 'mobile-devices.json');
        prevPath = _setStorePathForTests(storePath);
    });

    afterEach(() => {
        _setStorePathForTests(prevPath);
        rmSync(dir, { recursive: true, force: true });
    });

    it('persists registered devices to disk as valid JSON', () => {
        registerDevice({
            deviceId: 'dev-1',
            pushToken: 'ExponentPushToken[abc]',
            platform: 'ios',
            label: 'Test phone',
        });
        expect(existsSync(storePath)).toBe(true);
        const parsed = JSON.parse(readFileSync(storePath, 'utf-8'));
        expect(parsed.devices['dev-1'].pushToken).toBe('ExponentPushToken[abc]');
        expect(parsed.devices['dev-1'].platform).toBe('ios');
    });

    it('leaves no temp files behind after a write (atomic rename)', () => {
        registerDevice({ deviceId: 'dev-1', pushToken: 'tok', platform: 'android' });
        const leftovers = readdirSync(dir).filter((f) => f !== 'mobile-devices.json');
        expect(leftovers).toEqual([]);
    });

    it('survives a reload round-trip', () => {
        registerDevice({ deviceId: 'dev-1', pushToken: 'tok-1', platform: 'ios' });
        registerDevice({ deviceId: 'dev-2', pushToken: 'tok-2', platform: 'android' });
        reloadStore();
        const devices = listDevices();
        expect(devices.map((d) => d.deviceId).sort()).toEqual(['dev-1', 'dev-2']);
    });

    it('re-registering preserves registeredAt and updates the token', () => {
        const first = registerDevice({ deviceId: 'dev-1', pushToken: 'old', platform: 'ios' });
        const second = registerDevice({ deviceId: 'dev-1', pushToken: 'new', platform: 'ios' });
        expect(second.registeredAt).toBe(first.registeredAt);
        expect(second.pushToken).toBe('new');
        reloadStore();
        expect(listDevices()[0].pushToken).toBe('new');
    });

    it('unregisterDevice removes the device durably', () => {
        registerDevice({ deviceId: 'dev-1', pushToken: 'tok', platform: 'web' });
        expect(unregisterDevice('dev-1')).toBe(true);
        expect(unregisterDevice('dev-1')).toBe(false);
        reloadStore();
        expect(listDevices()).toEqual([]);
    });

    it('a pre-existing corrupt store file falls back to empty instead of throwing', () => {
        writeFileSync(storePath, '{"devices": {  TRUNCATED', 'utf-8');
        reloadStore();
        expect(listDevices()).toEqual([]);
        // And the next successful write repairs the file atomically.
        registerDevice({ deviceId: 'dev-1', pushToken: 'tok', platform: 'ios' });
        const parsed = JSON.parse(readFileSync(storePath, 'utf-8'));
        expect(Object.keys(parsed.devices)).toEqual(['dev-1']);
    });
});
