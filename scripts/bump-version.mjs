#!/usr/bin/env node
/**
 * Bump version across all workspace packages and print next steps.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch   # 1.0.0 → 1.0.1
 *   node scripts/bump-version.mjs minor   # 1.0.0 → 1.1.0
 *   node scripts/bump-version.mjs major   # 1.0.0 → 2.0.0
 *   node scripts/bump-version.mjs 2.3.1   # set exact version
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

function bumpVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'major': return `${major + 1}.0.0`;
    default:
      // Assume it's an exact version string
      if (/^\d+\.\d+\.\d+/.test(type)) return type;
      console.error(`Unknown version type: ${type}`);
      console.error('Usage: node scripts/bump-version.mjs [patch|minor|major|x.y.z]');
      process.exit(1);
  }
}

// --- Main ---
const type = process.argv[2];
if (!type) {
  console.error('Usage: node scripts/bump-version.mjs [patch|minor|major|x.y.z]');
  process.exit(1);
}

// Read current version from root
const rootPkgPath = resolve(rootDir, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const currentVersion = rootPkg.version;
const newVersion = bumpVersion(currentVersion, type);

console.log(`\n📦 Bumping version: ${currentVersion} → ${newVersion}\n`);

// Update all package.json files
for (const rel of PACKAGE_PATHS) {
  const fullPath = resolve(rootDir, rel);
  try {
    const pkg = JSON.parse(readFileSync(fullPath, 'utf8'));
    pkg.version = newVersion;
    writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`  ✅ ${rel}`);
  } catch (err) {
    console.error(`  ❌ ${rel}: ${err.message}`);
  }
}

console.log(`
──────────────────────────────────────────
Version bumped to ${newVersion} in all packages.

Next steps (run these commands):

  git add package.json shared/package.json backend/package.json frontend/package.json
  git commit -m "chore: release v${newVersion}"
  git tag v${newVersion}
  git push origin main --tags

Pushing the tag will trigger the CI/CD pipeline.
The publish job will wait for your approval in GitHub.
──────────────────────────────────────────
`);
