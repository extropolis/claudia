import { describe, it, expect } from 'vitest';
import { validateManifest, createManifestTemplate } from '../plugin-system/plugin-registry.js';

describe('plugin-registry', () => {
    describe('validateManifest', () => {
        it('rejects a missing/null manifest', () => {
            expect(validateManifest(null)).toEqual({ valid: false, error: 'Manifest is required' });
            expect(validateManifest(undefined)).toEqual({ valid: false, error: 'Manifest is required' });
        });

        it('rejects a manifest without a name', () => {
            const result = validateManifest({ version: '1.0.0', displayName: 'X', type: 'utility' });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/name is required/);
        });

        it('rejects a non-string name', () => {
            const result = validateManifest({ name: 42, version: '1.0.0', displayName: 'X', type: 'utility' });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/name is required/);
        });

        it('rejects a manifest without a version', () => {
            const result = validateManifest({ name: 'p', displayName: 'X', type: 'utility' });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/version is required/);
        });

        it('rejects a non-string version', () => {
            const result = validateManifest({ name: 'p', version: 1, displayName: 'X', type: 'utility' });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/version is required/);
        });

        it('rejects a manifest without a displayName', () => {
            const result = validateManifest({ name: 'p', version: '1.0.0', type: 'utility' });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/displayName is required/);
        });

        it('rejects a non-string displayName', () => {
            const result = validateManifest({ name: 'p', version: '1.0.0', displayName: 5, type: 'utility' });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/displayName is required/);
        });

        it('rejects a missing type', () => {
            const result = validateManifest({ name: 'p', version: '1.0.0', displayName: 'X' });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/type must be/);
        });

        it('rejects an invalid type', () => {
            const result = validateManifest({ name: 'p', version: '1.0.0', displayName: 'X', type: 'bogus' });
            expect(result.valid).toBe(false);
            expect(result.error).toMatch(/type must be/);
        });

        it('accepts each valid type', () => {
            for (const type of ['ai-provider', 'utility', 'integration']) {
                const result = validateManifest({ name: 'p', version: '1.0.0', displayName: 'X', type });
                expect(result).toEqual({ valid: true });
            }
        });

        it('checks name before version before displayName before type', () => {
            // Only name missing → name error even though others also missing
            expect(validateManifest({}).error).toMatch(/name is required/);
            // name present, version missing → version error
            expect(validateManifest({ name: 'p' }).error).toMatch(/version is required/);
            // name + version present, displayName missing → displayName error
            expect(validateManifest({ name: 'p', version: '1.0.0' }).error).toMatch(/displayName is required/);
        });
    });

    describe('createManifestTemplate', () => {
        it('produces a valid manifest', () => {
            const manifest = createManifestTemplate('my-plugin', 'My Plugin', 'utility');
            expect(validateManifest(manifest)).toEqual({ valid: true });
        });

        it('fills in the provided fields', () => {
            const manifest = createManifestTemplate('my-plugin', 'My Plugin', 'integration');
            expect(manifest.name).toBe('my-plugin');
            expect(manifest.displayName).toBe('My Plugin');
            expect(manifest.type).toBe('integration');
        });

        it('sets sensible defaults for the rest', () => {
            const manifest = createManifestTemplate('p', 'P', 'ai-provider');
            expect(manifest.version).toBe('1.0.0');
            expect(manifest.description).toBe('');
            expect(manifest.backend).toEqual({ entry: './index.js', provides: {} });
        });
    });
});
