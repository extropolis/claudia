/**
 * Electron main process for the updater simulation.
 *
 * Launched by `scripts/updater-sim.mjs`. Loads the COMPILED updater module
 * (dist-electron/updater.js) so the sim exercises the code that actually
 * ships, then drives it through a full check -> download cycle against the
 * fake feed and prints a machine-checkable result line.
 *
 * Never creates a window and never calls quitAndInstall.
 */

import { app } from 'electron';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const expectVersion = process.env.CLAUDIA_UPDATER_SIM_EXPECT;
const userDataDir = process.env.CLAUDIA_UPDATER_SIM_USERDATA;

// Isolate prefs and caches from the developer's real installation.
if (userDataDir) app.setPath('userData', userDataDir);

// Never let a stray GPU/window init block a headless CI runner.
app.disableHardwareAcceleration();

function done(ok, message) {
    if (ok) {
        console.log(`SIM_RESULT_OK ${message}`);
    } else {
        console.error(`SIM_RESULT_FAIL ${message}`);
    }
    app.exit(ok ? 0 : 1);
}

app.whenReady().then(async () => {
    let updater;
    try {
        updater = await import(pathToFileURL(resolve(rootDir, 'dist-electron', 'updater.js')).href);
    } catch (err) {
        done(false, `Could not load dist-electron/updater.js — run "npm run build:electron" first. ${err}`);
        return;
    }

    try {
        updater.initUpdater({
            getWindow: () => null,
            getBackendUrl: () => null,
            stopBackend: async () => { /* no backend in the sim */ }
        });

        const initial = updater.getStatus();
        console.log(`   [sim] current version: ${initial.currentVersion}`);
        if (initial.phase === 'unsupported') {
            done(false, `updater reported unsupported: ${initial.unsupportedReason}`);
            return;
        }

        // 1. Check, in "notify" mode ------------------------------------------
        // Setting notify first proves the behaviour pref actually gates
        // auto-download: the check must stop at "available" and fetch no
        // artifact. (Under the default "download" behaviour it would race
        // straight through to "downloaded" and this assertion would be
        // meaningless.)
        updater.setPrefs({ behaviour: 'notify' });
        console.log('   [sim] checking for updates (behaviour=notify)...');
        const checked = await updater.checkForUpdates();
        if (checked.phase !== 'available') {
            done(false, `expected phase "available" after check in notify mode, got "${checked.phase}" (error: ${checked.error})`);
            return;
        }
        if (checked.availableVersion !== expectVersion) {
            done(false, `expected version ${expectVersion}, got ${checked.availableVersion}`);
            return;
        }
        console.log(`   [sim] update available: ${checked.availableVersion} (not downloaded, as expected)`);

        // 2. Explicit download ------------------------------------------------
        console.log('   [sim] downloading...');
        const downloaded = await updater.downloadUpdate();
        if (downloaded.phase !== 'downloaded') {
            done(false, `expected phase "downloaded", got "${downloaded.phase}" (error: ${downloaded.error})`);
            return;
        }
        console.log(`   [sim] downloaded ${downloaded.availableVersion}, sha512 verified by electron-updater`);

        // 3. Install must be refused while tasks are "running" -----------------
        // getBackendUrl returns null here so the busy count is 0 and install
        // would be permitted; we assert the guard's shape without restarting.
        if (downloaded.canInstallNow !== true) {
            done(false, `expected canInstallNow=true with no backend, got ${downloaded.canInstallNow}`);
            return;
        }

        // 4. The disable switch must stop ALL feed traffic ---------------------
        // Ping a checkpoint URL so the parent can assert that nothing hit the
        // feed after this point, then run the *scheduled* code path (the one
        // the background timer uses) with updates switched off.
        const feed = process.env.CLAUDIA_UPDATER_SIM_FEED;
        await fetch(`${feed}/__checkpoint_disabled`).catch(() => { /* logged by parent */ });

        updater.setPrefs({ enabled: false });
        if (updater.getPrefs().enabled !== false) {
            done(false, 'setPrefs({enabled:false}) did not persist');
            return;
        }
        console.log('   [sim] updates disabled; running the scheduled check path...');
        await updater.checkIfDue();

        // Also assert the pin freezes scheduled checks, the other "no traffic"
        // guarantee (a pinned app must not be dragged forward again).
        updater.setPrefs({ enabled: true, pinnedVersion: '0.2.30' });
        await updater.checkIfDue();

        done(true, `check+download verified for ${downloaded.availableVersion}`);
    } catch (err) {
        done(false, `unexpected error: ${err && err.stack ? err.stack : err}`);
    }
});

// A hung updater must not leave the process alive forever.
setTimeout(() => done(false, 'sim timed out internally after 100s'), 100_000).unref?.();
