/**
 * Companion suite for filePickerService — the branches the original suite
 * leaves out: the two "API claims to exist but isn't there" paths and the
 * unreachable-method fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { selectDirectory } from '../filePickerService';
import * as capabilities from '../../utils/browserCapabilities';

describe('filePickerService — unavailable-API branches', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (window as { electronAPI?: unknown }).electronAPI;
        delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    });

    it('reports unsupported when Electron is the chosen method but the bridge is missing', async () => {
        // Happens in a renderer whose preload script failed to load.
        vi.spyOn(capabilities, 'getDirectorySelectionMethod').mockReturnValue('electron');
        delete (window as { electronAPI?: unknown }).electronAPI;

        const result = await selectDirectory();

        expect(result.success).toBe(false);
        expect(result.error).toMatchObject({
            type: 'unsupported',
            message: 'Electron API is not available',
        });
    });

    it('reports unsupported when the File System Access API is chosen but absent', async () => {
        vi.spyOn(capabilities, 'getDirectorySelectionMethod').mockReturnValue('filesystem-api');
        delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;

        const result = await selectDirectory();

        expect(result.success).toBe(false);
        expect(result.error?.type).toBe('unsupported');
        expect(result.error?.message).toMatch(/File System Access API is not supported/);
    });

    it('falls back to a clear error for an unrecognised selection method', async () => {
        // Guards against a new capability value being added upstream without a
        // matching case here.
        vi.spyOn(capabilities, 'getDirectorySelectionMethod').mockReturnValue(
            'some-future-method' as never,
        );

        const result = await selectDirectory();

        expect(result.success).toBe(false);
        expect(result.error).toMatchObject({
            type: 'unsupported',
            message: 'Unknown directory selection method',
        });
    });
});
