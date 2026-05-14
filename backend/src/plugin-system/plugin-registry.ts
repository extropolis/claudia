/**
 * Plugin Registry
 *
 * Helper utilities for plugin management
 */

import { PluginManifest } from './plugin-types.js';

/**
 * Validate a plugin manifest
 */
export function validateManifest(manifest: any): { valid: boolean; error?: string } {
  if (!manifest) {
    return { valid: false, error: 'Manifest is required' };
  }

  if (!manifest.name || typeof manifest.name !== 'string') {
    return { valid: false, error: 'Plugin name is required and must be a string' };
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    return { valid: false, error: 'Plugin version is required and must be a string' };
  }

  if (!manifest.displayName || typeof manifest.displayName !== 'string') {
    return { valid: false, error: 'Plugin displayName is required and must be a string' };
  }

  if (!manifest.type || !['ai-provider', 'utility', 'integration'].includes(manifest.type)) {
    return { valid: false, error: 'Plugin type must be ai-provider, utility, or integration' };
  }

  return { valid: true };
}

/**
 * Create a basic plugin manifest template
 */
export function createManifestTemplate(
  name: string,
  displayName: string,
  type: 'ai-provider' | 'utility' | 'integration',
): PluginManifest {
  return {
    name,
    version: '1.0.0',
    type,
    displayName,
    description: '',
    backend: {
      entry: './index.js',
      provides: {},
    },
  };
}
