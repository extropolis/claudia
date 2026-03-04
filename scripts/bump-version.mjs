#!/usr/bin/env node
/**
 * Syncs the version from version.txt into all package.json files.
 *
 * Usage:
 *   node scripts/bump-version.mjs          # reads version.txt and syncs all packages
 *   node scripts/bump-version.mjs --check  # verify all packages match version.txt (used in CI)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const PACKAGE_PATHS = [
  'package.json',
  'shared/package.json',
  'backend/package.json',
  'frontend/package.json',
];

// Read version.txt
const versionFile = resolve(rootDir, 'version.txt');
const version = readFileSync(versionFile, 'utf8').trim();

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`❌ Invalid version in version.txt: "${version}"`);
  process.exit(1);
}

const checkOnly = process.argv[2] === '--check';

if (checkOnly) {
  // --- Check mode (CI) ---
  console.log(`🏷️  version.txt: ${version}\n`);
  let failed = false;

  for (const rel of PACKAGE_PATHS) {
    const fullPath = resolve(rootDir, rel);
    const pkg = JSON.parse(readFileSync(fullPath, 'utf8'));
    if (pkg.version !== version) {
      console.log(`❌ ${pkg.name}@${pkg.version} — expected ${version}`);
      failed = true;
    } else {
      console.log(`✅ ${pkg.name}@${pkg.version}`);
    }
  }

  if (failed) {
    console.log('\nRun "node scripts/bump-version.mjs" to sync all packages to version.txt.');
    process.exit(1);
  }
  console.log('\nAll packages match version.txt.');

} else {
  // --- Sync mode ---
  console.log(`\n📦 Syncing all packages to version ${version} (from version.txt)\n`);

  for (const rel of PACKAGE_PATHS) {
    const fullPath = resolve(rootDir, rel);
    try {
      const pkg = JSON.parse(readFileSync(fullPath, 'utf8'));
      const old = pkg.version;
      pkg.version = version;
      writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      console.log(`  ✅ ${rel}  ${old} → ${version}`);
    } catch (err) {
      console.error(`  ❌ ${rel}: ${err.message}`);
    }
  }

  console.log(`
──────────────────────────────────────────
All packages synced to v${version}.

Next steps:

  git add -A
  git commit -m "chore: release v${version}"
  git tag v${version}
  git push origin main --tags

Pushing the tag triggers the CI/CD pipeline.
The publish job will wait for your approval in GitHub.
──────────────────────────────────────────
`);
}
