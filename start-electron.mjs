#!/usr/bin/env node

/**
 * Alternative Node.js-based Electron launcher
 * More reliable than bash script with better error handling
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env if it exists
try {
  const envPath = join(__dirname, '.env');
  const envContent = readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=:#]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      process.env[key] = value;
    }
  });
  console.log('✅ Loaded .env file');
} catch (err) {
  // .env is optional
}

// Increase Node.js memory limit
process.env.NODE_OPTIONS = '--max-old-space-size=8192';

console.log('🔮 Starting Claudia Electron App...\n');

// Helper to run npm command
function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    console.log(`📦 Running: npm ${args.join(' ')}`);

    const proc = spawn(npm, args, {
      cwd: __dirname,
      stdio: options.background ? 'ignore' : 'inherit',
      shell: true,
      env: { ...process.env }
    });

    if (options.background) {
      // Don't wait for background processes
      resolve(proc);
    } else {
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm ${args.join(' ')} failed with code ${code}`));
        }
      });
    }
  });
}

// Helper to wait for URL to be available
async function waitForUrl(url, maxAttempts = 30) {
  console.log(`⏳ Waiting for ${url}...`);

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        console.log(`✅ Server is ready at ${url}`);
        return true;
      }
    } catch (err) {
      // Ignore errors, keep trying
    }

    if (i % 5 === 0) {
      console.log(`   Attempt ${i}/${maxAttempts}...`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Server did not start at ${url} within ${maxAttempts} seconds`);
}

// Main execution
async function main() {
  let frontendProc = null;

  // Cleanup handler
  const cleanup = () => {
    console.log('\n🛑 Shutting down...');
    if (frontendProc) {
      frontendProc.kill();
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // Step 1: Build shared types
    console.log('📦 Building shared types...');
    await runNpm(['run', 'build', '-w', 'shared']);

    // Step 2: Build backend
    console.log('📦 Building backend...');
    await runNpm(['run', 'build:backend']);

    // Step 3: Build Electron
    console.log('📦 Building Electron...');
    await runNpm(['run', 'build:electron']);

    // Step 4: Start frontend dev server in background
    console.log('🌐 Starting frontend dev server...');
    frontendProc = await runNpm(['run', 'dev:frontend'], { background: true });

    // Wait for frontend to be ready
    await waitForUrl('http://localhost:5173');

    // Step 5: Launch Electron
    console.log('\n🚀 Launching Claudia Electron...');
    console.log('   NODE_ENV=development');
    console.log('   Running: npx electron .\n');

    const electronProc = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['electron', '.'],
      {
        cwd: __dirname,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, NODE_ENV: 'development' }
      }
    );

    electronProc.on('close', (code) => {
      console.log(`\nElectron exited with code: ${code}`);
      cleanup();
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    cleanup();
    process.exit(1);
  }
}

main();
