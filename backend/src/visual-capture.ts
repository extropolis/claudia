/**
 * Visual Capture - pluggable screenshot capturers for visual verification.
 *
 * There is deliberately no universal capture mechanism here, because none
 * exists: web pages need a browser, Unity/Godot need in-engine hooks that only
 * work with a real graphics device, and some engines expose nothing scriptable
 * at all. What every mechanism DOES have in common is its output - PNG bytes
 * plus a little metadata. That is the contract this module exposes:
 *
 *     capture(request) -> { images: [{ buffer, label }], ... }
 *
 * Storage (verification-store) and the mobile feed are written against that
 * contract only, so adding a Unity or Godot capturer later is a new file here
 * rather than a change to anything downstream.
 *
 * Currently implemented:
 *   - playwright-web:  web pages, 2D canvas and WebGL, via Chromium. Headless.
 *   - desktop-window:  OS-level window/screen grab. The universal fallback for
 *                      engines with no scriptable hook. Needs a GUI session.
 *
 * Notes that cost real debugging time if ignored:
 *   - Chromium ONLY for canvas/WebGL. WebGL canvases screenshot blank under
 *     WebKit (playwright#17904), silently - you get a valid but empty PNG.
 *   - Never sleep before capturing; wait for an explicit readiness signal.
 *     Arbitrary timeouts are the top source of flaky screenshots. Callers can
 *     pass `readySelector` (e.g. 'canvas[data-ready="1"]').
 *   - WebGL contents can read back blank unless the capture happens in the same
 *     frame as the draw or the context was made with preserveDrawingBuffer.
 *     `webglSafe` re-draws via the app's own hook when one is exposed.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { CapturerId } from '@claudia/shared';

const execFileAsync = promisify(execFile);

/** One captured frame. */
export interface CapturedImage {
    buffer: Buffer;
    label?: string;
    width?: number;
    height?: number;
}

export interface CaptureRequest {
    capturer: CapturerId;
    /** URL for web; window title for desktop-window. */
    target: string;
    viewport?: { width: number; height: number };
    /** CSS selector to wait for before capturing (readiness signal). */
    readySelector?: string;
    /** CSS selector to capture instead of the whole viewport. */
    selector?: string;
    /** Capture N frames as a filmstrip rather than a single image. */
    frames?: number;
    /** Milliseconds between filmstrip frames. */
    frameIntervalMs?: number;
    /**
     * Call the page's own frame hook before capturing, for WebGL apps whose
     * drawing buffer would otherwise read back blank. The app must expose
     * window.__claudiaCapture = { draw?(), step?(n), pause?() }.
     */
    webglSafe?: boolean;
    timeoutMs?: number;
}

export interface CaptureResult {
    images: CapturedImage[];
    capturer: CapturerId;
    target: string;
    viewport?: { width: number; height: number };
    warnings: string[];
}

export class CaptureError extends Error {
    constructor(message: string, readonly capturer: CapturerId) {
        super(message);
        this.name = 'CaptureError';
    }
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Load Playwright lazily. It lives in the repo root node_modules rather than
 * being a backend dependency, so a missing install must degrade to a clear
 * error rather than crashing the server at import time.
 */
async function loadChromium(): Promise<any> {
    try {
        const mod: any = await import('playwright');
        return mod.chromium ?? mod.default?.chromium;
    } catch {
        try {
            const mod: any = await import('playwright-core');
            return mod.chromium ?? mod.default?.chromium;
        } catch {
            throw new CaptureError(
                'Playwright is not available. Install it with `npm install playwright` ' +
                'and `npx playwright install chromium` to enable web capture.',
                'playwright-web',
            );
        }
    }
}

/**
 * Capture a web page, 2D canvas or WebGL app using Chromium.
 */
async function capturePlaywrightWeb(req: CaptureRequest): Promise<CaptureResult> {
    const chromium = await loadChromium();
    const viewport = req.viewport ?? DEFAULT_VIEWPORT;
    const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const warnings: string[] = [];
    const frames = Math.max(1, Math.min(req.frames ?? 1, 12));

    console.log(
        `[VisualCapture] playwright-web: target=${req.target} viewport=${viewport.width}x${viewport.height} ` +
        `frames=${frames} readySelector=${req.readySelector ?? 'none'} webglSafe=${!!req.webglSafe}`,
    );

    let browser: any;
    try {
        browser = await chromium.launch({
            headless: true,
            // Software GL so WebGL works headlessly (no GPU in CI or on a
            // detached session). It MUST be the angle+swiftshader pair: the
            // widely-cited `--use-gl=swiftshader` is stale advice and yields NO
            // webgl context at all on current Chromium, which shows up as a
            // silently blank canvas rather than an error.
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--use-gl=angle',
                '--use-angle=swiftshader',
            ],
        });
    } catch (error) {
        throw new CaptureError(
            `Could not launch Chromium: ${error instanceof Error ? error.message : String(error)}. ` +
            'Run `npx playwright install chromium`.',
            'playwright-web',
        );
    }

    try {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();

        page.on('pageerror', (err: Error) => {
            warnings.push(`Page error: ${err.message}`);
            console.warn(`[VisualCapture] page error: ${err.message}`);
        });

        await page.goto(req.target, { waitUntil: 'load', timeout });

        // Readiness signal beats an arbitrary sleep. If the app never sets it,
        // warn and carry on rather than failing the whole capture - a warned
        // screenshot is more useful to the user than an error.
        if (req.readySelector) {
            try {
                await page.waitForSelector(req.readySelector, { timeout });
            } catch {
                const msg = `Ready selector "${req.readySelector}" never appeared; captured anyway.`;
                warnings.push(msg);
                console.warn(`[VisualCapture] ${msg}`);
            }
        }

        const shotTarget = req.selector ? page.locator(req.selector).first() : page;
        const images: CapturedImage[] = [];

        for (let i = 0; i < frames; i++) {
            if (req.webglSafe) {
                // Ask the app to draw in this frame so the buffer is populated.
                const drew = await page.evaluate(() => {
                    const hook = (window as any).__claudiaCapture;
                    if (hook && typeof hook.draw === 'function') {
                        hook.draw();
                        return true;
                    }
                    return false;
                }).catch(() => false);
                if (!drew && i === 0) {
                    const msg =
                        'webglSafe requested but window.__claudiaCapture.draw() is not exposed by the page. ' +
                        'If the canvas captures blank, expose that hook or create the context with preserveDrawingBuffer.';
                    warnings.push(msg);
                    console.warn(`[VisualCapture] ${msg}`);
                }
            }

            const buffer: Buffer = await shotTarget.screenshot({
                type: 'png',
                animations: frames > 1 ? 'allow' : 'disabled',
                timeout,
            });
            images.push({
                buffer,
                label: frames > 1 ? `frame ${i + 1}` : undefined,
                width: viewport.width,
                height: viewport.height,
            });

            if (i < frames - 1) {
                // Prefer deterministic frame stepping when the app supports it.
                const stepped = await page.evaluate((n: number) => {
                    const hook = (window as any).__claudiaCapture;
                    if (hook && typeof hook.step === 'function') {
                        hook.step(n);
                        return true;
                    }
                    return false;
                }, 1).catch(() => false);

                if (!stepped) {
                    await page.waitForTimeout(req.frameIntervalMs ?? 200);
                }
            }
        }

        await context.close();
        console.log(`[VisualCapture] playwright-web captured ${images.length} image(s)`);
        return { images, capturer: 'playwright-web', target: req.target, viewport, warnings };
    } finally {
        await browser.close().catch(() => { /* best effort */ });
    }
}

/**
 * OS-level window capture - the universal fallback for anything with no
 * scriptable hook. Requires a logged-in GUI session, so it does not work
 * headlessly or over plain SSH.
 */
async function captureDesktopWindow(req: CaptureRequest): Promise<CaptureResult> {
    const warnings: string[] = [];
    const outPath = join(tmpdir(), `claudia-capture-${randomUUID()}.png`);
    const frames = Math.max(1, Math.min(req.frames ?? 1, 12));
    const images: CapturedImage[] = [];

    console.log(`[VisualCapture] desktop-window: target=${req.target || 'full screen'} frames=${frames}`);

    for (let i = 0; i < frames; i++) {
        const framePath = frames > 1 ? outPath.replace('.png', `-${i}.png`) : outPath;
        try {
            if (process.platform === 'darwin') {
                // -x silences the shutter sound. Without a window id this grabs
                // the full screen, which still answers "what does it look like".
                await execFileAsync('screencapture', ['-x', '-t', 'png', framePath], {
                    timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                });
            } else if (process.platform === 'win32') {
                throw new CaptureError(
                    'Desktop capture on Windows is not implemented yet. Windows.Graphics.Capture ' +
                    'is the correct API (GDI BitBlt returns black frames for GPU-composited game windows).',
                    'desktop-window',
                );
            } else {
                // Linux: try ImageMagick, commonly present on desktop installs.
                await execFileAsync('import', ['-window', 'root', framePath], {
                    timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                });
            }
        } catch (error) {
            if (error instanceof CaptureError) throw error;
            throw new CaptureError(
                `Desktop capture failed: ${error instanceof Error ? error.message : String(error)}. ` +
                (process.platform === 'darwin'
                    ? 'On macOS the process running Claudia needs Screen Recording permission ' +
                      '(System Settings > Privacy & Security > Screen Recording), otherwise captures come back blank.'
                    : 'Ensure a GUI session is available and ImageMagick is installed.'),
                'desktop-window',
            );
        }

        try {
            const buffer = await readFile(framePath);
            images.push({ buffer, label: frames > 1 ? `frame ${i + 1}` : undefined });
        } catch (error) {
            throw new CaptureError(
                `Capture wrote no readable file: ${error instanceof Error ? error.message : String(error)}`,
                'desktop-window',
            );
        } finally {
            await unlink(framePath).catch(() => { /* best effort */ });
        }

        if (i < frames - 1) {
            await new Promise((r) => setTimeout(r, req.frameIntervalMs ?? 200));
        }
    }

    if (process.platform === 'darwin') {
        warnings.push(
            'Desktop capture grabs the whole screen; per-window capture needs a window id.',
        );
    }

    console.log(`[VisualCapture] desktop-window captured ${images.length} image(s)`);
    return {
        images,
        capturer: 'desktop-window',
        target: req.target || 'screen',
        viewport: req.viewport,
        warnings,
    };
}

/**
 * Dispatch to the right capturer. New stacks (Unity, Godot) plug in here
 * without anything downstream changing.
 */
export async function capture(req: CaptureRequest): Promise<CaptureResult> {
    switch (req.capturer) {
        case 'playwright-web':
            return capturePlaywrightWeb(req);
        case 'desktop-window':
            return captureDesktopWindow(req);
        case 'unity':
        case 'godot':
            throw new CaptureError(
                `The "${req.capturer}" capturer is not implemented yet. Use "desktop-window" as a ` +
                'fallback (needs a GUI session), or attach an existing screenshot with capturer "manual".',
                req.capturer,
            );
        case 'manual':
            throw new CaptureError(
                'The "manual" capturer takes an existing image file rather than capturing one.',
                'manual',
            );
        default:
            throw new CaptureError(`Unknown capturer: ${req.capturer}`, req.capturer);
    }
}

/** Capturers that can actually run on this machine right now. */
export function availableCapturers(): CapturerId[] {
    const list: CapturerId[] = ['playwright-web', 'manual'];
    if (process.platform === 'darwin' || process.platform === 'linux') {
        list.push('desktop-window');
    }
    return list;
}
