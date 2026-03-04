#!/usr/bin/env node
/**
 * One-command release: reads version.txt, syncs all package.json files,
 * commits, tags, and pushes. The CI pipeline handles the rest.
 *
 * Usage:
 *   node scripts/release.mjs
 *
 * Just edit version.txt first, then run this.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const PACKAGE_PATHS = [
  'package.json',
  'shared/package.json',
  'backend/package.json',
  'frontend/package.json',
];

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { cwd: rootDir, stdio: 'inherit', ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: rootDir, encoding: 'utf8' }).trim();
}

// --- Read version.txt ---
const versionFile = resolve(rootDir, 'version.txt');
const version = readFileSync(versionFile, 'utf8').trim();

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`\n❌ Invalid version in version.txt: "${version}"`);
  console.error('   Expected format: x.y.z or x.y.z-beta.1');
  process.exit(1);
}

const tag = `v${version}`;

console.log(`\n🚀 Releasing ${tag}\n`);

// --- Check we're on main ---
const branch = runCapture('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') {
  console.error(`❌ You're on branch "${branch}". Switch to main first.`);
  process.exit(1);
}

// --- Check working tree is clean (except version changes we're about to make) ---
const dirtyFiles = runCapture('git status --porcelain')
  .split('\n')
  .filter(line => line.trim())
  .filter(line => !line.includes('version.txt') && !line.includes('package.json'));

if (dirtyFiles.length > 0) {
  console.error('❌ Working tree has uncommitted changes (besides version files):');
  dirtyFiles.forEach(f => console.error(`   ${f}`));
  console.error('\nCommit or stash them first.');
  process.exit(1);
}

// --- Check tag doesn't already exist ---
try {
  runCapture(`git rev-parse refs/tags/${tag}`);
  console.error(`❌ Tag ${tag} already exists. Bump version.txt to a new version.`);
  process.exit(1);
} catch {
  // Good — tag doesn't exist yet
}

// --- Sync all package.json files ---
console.log('📦 Syncing package versions...\n');
for (const rel of PACKAGE_PATHS) {
  const fullPath = resolve(rootDir, rel);
  const pkg = JSON.parse(readFileSync(fullPath, 'utf8'));
  const old = pkg.version;
  pkg.version = version;
  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`  ✅ ${rel}  ${old} → ${version}`);
}

// --- Git: stage, commit, tag, push ---
console.log('\n📝 Committing...\n');
run('git add version.txt package.json shared/package.json backend/package.json frontend/package.json');

// Check if there are staged changes to commit
const staged = runCapture('git diff --cached --name-only');
if (staged) {
  run(`git commit -m "chore: release ${tag}"`);
} else {
  console.log('  (no version changes to commit — versions already match)');
}

console.log('\n🏷️  Tagging...\n');
run(`git tag ${tag}`);

console.log('\n🚀 Pushing...\n');
run('git push origin main --tags');

console.log(`
──────────────────────────────────────────
✅ Released ${tag}

What happens next:
  1. CI builds and runs tests automatically
  2. You'll get a GitHub notification to approve publishing
  3. Once approved, packages are published to npm

Track it at: https://github.com/extropolis/claudia/actions
──────────────────────────────────────────
`);
