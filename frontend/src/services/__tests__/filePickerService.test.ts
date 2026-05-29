import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    selectDirectory,
    isDirectorySelectionAvailable,
    getDirectorySelectionInfo,
} from '../filePickerService';

function clearGlobals() {
    delete (window as any).electronAPI;
    delete (window as any).showDirectoryPicker;
}

describe('filePickerService', () => {
    beforeEach(() => {
        clearGlobals();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        clearGlobals();
        vi.restoreAllMocks();
    });

    describe('selectDirectory - electron', () => {
        it('returns success with selected path', async () => {
            (window as any).electronAPI = { selectDirectory: vi.fn().mockResolvedValue('/Users/me/proj') };
            const r = await selectDirectory();
            expect(r).toEqual({ success: true, path: '/Users/me/proj' });
        });

        it('returns cancelled when no path returned', async () => {
            (window as any).electronAPI = { selectDirectory: vi.fn().mockResolvedValue(null) };
            const r = await selectDirectory();
            expect(r.success).toBe(false);
            expect(r.error?.type).toBe('cancelled');
        });

        it('returns unknown error when selectDirectory throws', async () => {
            (window as any).electronAPI = { selectDirectory: vi.fn().mockRejectedValue(new Error('boom')) };
            const r = await selectDirectory();
            expect(r.success).toBe(false);
            expect(r.error?.type).toBe('unknown');
            expect(r.error?.message).toBe('boom');
            expect(r.error?.originalError).toBeInstanceOf(Error);
        });

        it('returns unsupported when electronAPI present at method-detect but missing at call (edge)', async () => {
            // getDirectorySelectionMethod sees electronAPI; selectDirectoryElectron also checks it.
            // Define electronAPI with selectDirectory so it routes to electron, then ensure the
            // guard path is covered by deleting selectDirectory implementation.
            (window as any).electronAPI = {};
            // electron branch is selected (electronAPI truthy) but selectDirectory is undefined -> throws -> unknown
            const r = await selectDirectory();
            expect(r.success).toBe(false);
            expect(r.error?.type).toBe('unknown');
        });
    });

    describe('selectDirectory - filesystem-api', () => {
        it('returns success with directory name', async () => {
            (window as any).showDirectoryPicker = vi.fn().mockResolvedValue({ name: 'my-folder' });
            const r = await selectDirectory();
            expect(r).toEqual({ success: true, path: 'my-folder' });
        });

        it('returns cancelled when picker resolves falsy', async () => {
            (window as any).showDirectoryPicker = vi.fn().mockResolvedValue(null);
            const r = await selectDirectory();
            expect(r.success).toBe(false);
            expect(r.error?.type).toBe('cancelled');
        });

        it('maps AbortError to cancelled', async () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            (window as any).showDirectoryPicker = vi.fn().mockRejectedValue(err);
            const r = await selectDirectory();
            expect(r.success).toBe(false);
            expect(r.error?.type).toBe('cancelled');
        });

        it('maps NotAllowedError to permission-denied', async () => {
            const err = new Error('denied');
            err.name = 'NotAllowedError';
            (window as any).showDirectoryPicker = vi.fn().mockRejectedValue(err);
            const r = await selectDirectory();
            expect(r.success).toBe(false);
            expect(r.error?.type).toBe('permission-denied');
        });

        it('maps SecurityError to permission-denied', async () => {
            const err = new Error('sec');
            err.name = 'SecurityError';
            (window as any).showDirectoryPicker = vi.fn().mockRejectedValue(err);
            const r = await selectDirectory();
            expect(r.error?.type).toBe('permission-denied');
        });

        it('maps other errors to unknown', async () => {
            const err = new Error('weird');
            err.name = 'WeirdError';
            (window as any).showDirectoryPicker = vi.fn().mockRejectedValue(err);
            const r = await selectDirectory();
            expect(r.error?.type).toBe('unknown');
            expect(r.error?.message).toBe('weird');
        });
    });

    describe('selectDirectory - none', () => {
        it('returns unsupported when no method available', async () => {
            const r = await selectDirectory();
            expect(r.success).toBe(false);
            expect(r.error?.type).toBe('unsupported');
            expect(r.error?.message).toContain('Directory selection');
        });
    });

    describe('isDirectorySelectionAvailable', () => {
        it('false when nothing available', () => {
            expect(isDirectorySelectionAvailable()).toBe(false);
        });

        it('true in electron', () => {
            (window as any).electronAPI = {};
            expect(isDirectorySelectionAvailable()).toBe(true);
        });

        it('true with filesystem api', () => {
            (window as any).showDirectoryPicker = () => {};
            expect(isDirectorySelectionAvailable()).toBe(true);
        });
    });

    describe('getDirectorySelectionInfo', () => {
        it('reports electron', () => {
            (window as any).electronAPI = {};
            const info = getDirectorySelectionInfo();
            expect(info).toEqual({
                available: true,
                method: 'electron',
                message: 'Using Electron native directory picker',
            });
        });

        it('reports filesystem-api', () => {
            (window as any).showDirectoryPicker = () => {};
            const info = getDirectorySelectionInfo();
            expect(info.method).toBe('filesystem-api');
            expect(info.available).toBe(true);
            expect(info.message).toContain('File System Access API');
        });

        it('reports none with unsupported message', () => {
            const info = getDirectorySelectionInfo();
            expect(info.method).toBe('none');
            expect(info.available).toBe(false);
            expect(info.message).toContain('Directory selection');
        });
    });
});
