/**
 * SettingsMenu behaviour tests.
 *
 * SettingsMenu is ~2700 lines and mostly markup. These tests deliberately
 * target the STATE LOGIC rather than chasing line coverage:
 *
 *   - config round-trip: what it GETs on open, how the form is populated,
 *     and the exact request body it writes back
 *   - MCP server add / remove / JSON-editor validation
 *   - CLI switch + model-tiering persistence, including debounce behaviour
 *   - panel expand/collapse and the toggles that write to the Zustand store
 *
 * Pure presentation (SAP AI Core / Hyperspace credential panels, plugin cards,
 * connection-test spinners) is left uncovered on purpose — see the notes at
 * the bottom of this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';

import { SettingsMenu } from '../SettingsMenu';
import { NotificationProvider } from '../NotificationContainer';
import { useTaskStore } from '../../stores/taskStore';

// Browser notification capability is environment-dependent; stub it so the
// notification toggles are reachable and their branches deterministic.
const capabilities = {
    hasBrowserNotifications: vi.fn(() => true),
    getNotificationPermission: vi.fn(() => 'granted' as NotificationPermission),
    requestNotificationPermission: vi.fn(async () => 'granted' as NotificationPermission),
    sendBrowserNotification: vi.fn(() => true as unknown),
};
// SettingsMenu paints ~14 collapsible panels, each with an icon and a chevron,
// plus per-row icons once a panel is open. Every lucide icon is a real <svg>
// with several <path> children, so a single render builds hundreds of extra
// DOM nodes that no test here looks at (queries go through role/text/title,
// and an <svg> contributes no accessible name either way). Stubbing the icon
// set to render nothing keeps the rendered tree — and the module graph —
// dramatically smaller without changing a single query result.
vi.mock('lucide-react', () => {
    const Icon = () => null;
    return new Proxy(
        { __esModule: true } as Record<string, unknown>,
        {
            get: (_target, prop) => {
                if (prop === '__esModule') return true;
                // Never let the mock look like a thenable to the ESM loader.
                if (prop === 'then') return undefined;
                return Icon;
            },
            has: () => true,
        }
    );
});

// SettingsMenu only consumes `showWarning` from the notification context, and
// none of these tests assert on toasts. A pass-through provider avoids running
// the real provider's state machine and rendering a toast tree on top of every
// one of the 59 renders below.
vi.mock('../NotificationContainer', () => ({
    NotificationProvider: ({ children }: { children: React.ReactNode }) => children,
    useNotification: () => ({
        showNotification: vi.fn(),
        showSuccess: vi.fn(),
        showError: vi.fn(),
        showWarning: vi.fn(),
        showInfo: vi.fn(),
    }),
}));

// The Sound panel renders VoiceSettingsContent, a 491-line component that
// drags in the whole speech-synthesis/recognition hook stack. No test here
// expands that panel (it is out of scope for this file), so stubbing it keeps
// it out of the module graph entirely — a large chunk of this file's collect
// and transform time.
vi.mock('../VoiceSettingsContent', () => ({
    VoiceSettingsContent: () => <div>voice-settings-stub</div>,
}));

vi.mock('../../utils/browserCapabilities', () => ({
    hasBrowserNotifications: () => capabilities.hasBrowserNotifications(),
    getNotificationPermission: () => capabilities.getNotificationPermission(),
    requestNotificationPermission: () => capabilities.requestNotificationPermission(),
    sendBrowserNotification: (...args: unknown[]) => capabilities.sendBrowserNotification(...(args as [])),
}));

// ---------------------------------------------------------------------------
// fetch harness
// ---------------------------------------------------------------------------

interface RecordedCall {
    path: string;
    method: string;
    body: Record<string, unknown> | null;
}

let calls: RecordedCall[] = [];

/** Config payload the stubbed GET /api/config returns. */
type ConfigShape = Record<string, unknown>;

/**
 * Route every request the component makes by pathname. Anything unrecognised
 * resolves to `{}` so a stray call can never hang or hit the network.
 */
function installFetch(config: ConfigShape = {}, overrides: Record<string, unknown> = {}) {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname;
        const method = init?.method ?? 'GET';
        let body: Record<string, unknown> | null = null;
        if (typeof init?.body === 'string') {
            try { body = JSON.parse(init.body); } catch { body = null; }
        }
        calls.push({ path, method, body });

        const ok = (data: unknown) => ({
            ok: true,
            status: 200,
            json: async () => data,
            text: async () => JSON.stringify(data),
        }) as Response;

        if (path in overrides) return ok(overrides[path]);
        if (path === '/api/config' && method === 'GET') return ok(config);
        if (path === '/api/config') return ok({ success: true });
        if (path === '/api/plugins') return ok({ success: true, plugins: [] });
        if (path === '/api/backend/status') {
            return ok({ backend: 'claude-code', installed: true, version: '1.0.0', availableBackends: ['claude-code'] });
        }
        return ok({});
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

/** All bodies sent to PUT /api/config, oldest first. */
const putBodies = () =>
    calls.filter(c => c.path === '/api/config' && c.method === 'PUT').map(c => c.body);

/** Bodies sent to POST /api/config. */
const postBodies = () =>
    calls.filter(c => c.path === '/api/config' && c.method === 'POST').map(c => c.body);

const paths = () => calls.map(c => `${c.method} ${c.path}`);

// ---------------------------------------------------------------------------
// render helpers
// ---------------------------------------------------------------------------

async function renderSettings(props: Partial<React.ComponentProps<typeof SettingsMenu>> = {}) {
    const onClose = vi.fn();
    const utils = render(
        <NotificationProvider>
            <SettingsMenu isOpen onClose={onClose} {...props} />
        </NotificationProvider>
    );
    // Let the on-open config/plugins/backend fetches settle.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { onClose, ...utils };
}

/** Expand a collapsible panel by its header text. */
async function expandPanel(title: string) {
    fireEvent.click(screen.getByRole('button', { name: title }));
    await act(async () => { await Promise.resolve(); });
}

/**
 * Find the form control belonging to a settings row, located by the row's
 * visible label text. The toggle switches have no accessible name of their
 * own (an unlabelled checkbox inside a decorative <label>), so we walk up from
 * the label text to the nearest ancestor that owns a control. This stays a
 * text-based query — no CSS class selectors.
 */
function controlFor(labelText: string | RegExp, selector = 'input, select, textarea'): HTMLElement {
    let el: HTMLElement | null = screen.getByText(labelText);
    while (el) {
        const found = el.querySelector<HTMLElement>(selector);
        if (found) return found;
        el = el.parentElement;
    }
    throw new Error(`No control found near label "${labelText}"`);
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

// ---------------------------------------------------------------------------

beforeEach(() => {
    calls = [];
    localStorage.clear();
    vi.clearAllMocks();
    capabilities.hasBrowserNotifications.mockReturnValue(true);
    capabilities.getNotificationPermission.mockReturnValue('granted');
    capabilities.requestNotificationPermission.mockResolvedValue('granted');
    capabilities.sendBrowserNotification.mockReturnValue(true);
    useTaskStore.setState({
        showSystemStats: false,
        browserNotificationsEnabled: false,
        notifyOnCompletion: true,
        notifyOnWaitingInput: true,
        themePreference: 'system',
    });
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe('SettingsMenu — open/close', () => {
    it('renders nothing while closed and issues no requests', async () => {
        installFetch();
        const { container } = render(
            <NotificationProvider>
                <SettingsMenu isOpen={false} onClose={vi.fn()} />
            </NotificationProvider>
        );
        await flush();

        expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
        expect(calls).toHaveLength(0);
        expect(container).not.toHaveTextContent('Appearance');
    });

    it('loads config, plugins and backend status when opened', async () => {
        installFetch();
        await renderSettings();

        expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
        expect(paths()).toContain('GET /api/config');
        expect(paths()).toContain('GET /api/plugins');
        expect(paths()).toContain('GET /api/backend/status');
    });

    it('close button invokes onClose', async () => {
        installFetch();
        const { onClose, container } = await renderSettings();
        // The header close button is the only button with no accessible name.
        const closeButton = within(container).getAllByRole('button').find(b => b.textContent === '');
        fireEvent.click(closeButton!);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('survives a failing config fetch without crashing', async () => {
        global.fetch = vi.fn(async () => { throw new Error('backend down'); }) as unknown as typeof fetch;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} />
            </NotificationProvider>
        );
        await flush();

        expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
        errorSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
describe('SettingsMenu — panel expansion', () => {
    it('starts with every panel collapsed', async () => {
        installFetch();
        await renderSettings();

        expect(screen.getByRole('button', { name: 'Behavior' })).toBeInTheDocument();
        expect(screen.queryByText('Auto-focus on Input')).not.toBeInTheDocument();
    });

    it('toggles a panel open and closed again', async () => {
        installFetch();
        await renderSettings();

        await expandPanel('Behavior');
        expect(screen.getByText('Auto-focus on Input')).toBeInTheDocument();

        await expandPanel('Behavior');
        expect(screen.queryByText('Auto-focus on Input')).not.toBeInTheDocument();
    });

    it('auto-expands the panel named by initialPanel', async () => {
        installFetch();
        await renderSettings({ initialPanel: 'permissions' });
        expect(screen.getByText('Skip Permissions')).toBeInTheDocument();
    });

    it('re-fetches backend status when the AI Backend panel is expanded', async () => {
        installFetch();
        await renderSettings();
        const before = calls.filter(c => c.path === '/api/backend/status').length;

        await expandPanel('AI Backend');
        await flush();

        expect(calls.filter(c => c.path === '/api/backend/status').length).toBeGreaterThan(before);
    });
});

// ---------------------------------------------------------------------------
describe('SettingsMenu — config round-trip', () => {
    const fullConfig = {
        skipPermissions: true,
        rules: '- always test',
        supervisorEnabled: true,
        supervisorSystemPrompt: 'watch closely',
        autoFocusOnInput: true,
        useLearnings: true,
        claudiaMcpServerEnabled: true,
        defaultBaseDirectory: '/Users/me/Work',
        apiMode: 'default',
        backend: 'claude-code',
    };

    it('populates the Behavior panel from the fetched config', async () => {
        installFetch(fullConfig);
        await renderSettings({ initialPanel: 'behavior' });

        expect(controlFor('Auto-focus on Input')).toBeChecked();
        expect(controlFor('Default Base Directory')).toHaveValue('/Users/me/Work');
        // NOTE: the "Archived Worktree Retention (days)" control ships with PR
        // #179; its assertion is omitted here so this file stays green on main.
    });

    it('populates permissions, rules and supervisor panels from config', async () => {
        installFetch(fullConfig);
        await renderSettings({ initialPanel: 'permissions' });

        expect(controlFor('Skip Permissions')).toBeChecked();

        await expandPanel('Rules');
        expect(screen.getByRole('textbox')).toHaveValue('- always test');

        await expandPanel('AI Supervisor');
        expect(controlFor('Enable AI Supervisor')).toBeChecked();
    });

    it('falls back to defaults for a sparse config payload', async () => {
        installFetch({});
        await renderSettings({ initialPanel: 'behavior' });

        expect(controlFor('Auto-focus on Input')).not.toBeChecked();
        expect(controlFor('Default Base Directory')).toHaveValue('');
        // NOTE: the worktreeRetentionDays default (30 when the backend omits it)
        // ships with PR #179; its assertion is omitted here so this file stays
        // green on main.
    });

    it('PUTs the base directory on blur with the exact field name', async () => {
        installFetch(fullConfig);
        await renderSettings({ initialPanel: 'behavior' });

        const input = controlFor('Default Base Directory');
        fireEvent.change(input, { target: { value: '/srv/projects' } });
        fireEvent.blur(input);
        await flush();

        expect(putBodies()).toContainEqual({ defaultBaseDirectory: '/srv/projects' });
    });

    // NOTE: worktree-retention clamping ("clamps a negative worktree retention
    // to 0 before persisting" and "treats a cleared retention field as 0 rather
    // than NaN") ships with PR #179; those tests are omitted here so this file
    // stays green on main. Restore them with that feature.

    it('PUTs skipPermissions and only applies the toggle after the write succeeds', async () => {
        installFetch({ ...fullConfig, skipPermissions: false });
        await renderSettings({ initialPanel: 'permissions' });

        const toggle = controlFor('Skip Permissions');
        expect(toggle).not.toBeChecked();

        fireEvent.click(toggle);
        await flush();

        expect(putBodies()).toContainEqual({ skipPermissions: true });
        expect(toggle).toBeChecked();
    });

    it('leaves the toggle off when the backend rejects the write', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            const method = init?.method ?? 'GET';
            calls.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
            if (path === '/api/config' && method === 'PUT') {
                return { ok: false, status: 500, json: async () => ({ error: 'nope' }) } as Response;
            }
            if (path === '/api/plugins') return { ok: true, status: 200, json: async () => ({ success: true, plugins: [] }) } as Response;
            return { ok: true, status: 200, json: async () => ({ skipPermissions: false }) } as Response;
        }) as unknown as typeof fetch;

        await renderSettings({ initialPanel: 'permissions' });

        const toggle = controlFor('Skip Permissions');
        fireEvent.click(toggle);
        await flush();

        expect(putBodies()).toContainEqual({ skipPermissions: true });
        expect(toggle).not.toBeChecked();
        errorSpy.mockRestore();
    });

    it('debounces the rules textarea into a single PUT after 1s', async () => {
        vi.useFakeTimers();
        installFetch(fullConfig);
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="rules" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        const textarea = screen.getByRole('textbox');
        fireEvent.change(textarea, { target: { value: '- rule one' } });
        fireEvent.change(textarea, { target: { value: '- rule one\n- rule two' } });

        await act(async () => { await vi.advanceTimersByTimeAsync(999); });
        expect(putBodies()).toHaveLength(0);

        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(putBodies()).toEqual([{ rules: '- rule one\n- rule two' }]);
    });

    it('restores SAP AI Core credentials from localStorage to the backend', async () => {
        localStorage.setItem('claudia_sap_ai_core_client_id', 'cid');
        localStorage.setItem('claudia_sap_ai_core_client_secret', 'secret');
        localStorage.setItem('claudia_sap_ai_core_auth_url', 'https://auth.example');
        localStorage.setItem('claudia_sap_ai_core_base_url', 'https://api.example');
        localStorage.setItem('claudia_sap_ai_core_resource_group', 'rg1');
        localStorage.setItem('claudia_sap_ai_core_model', 'anthropic--claude-4.5-sonnet');

        // Backend has no sapAiCore block yet -> a restore POST is expected.
        installFetch({});
        await renderSettings();
        await waitFor(() => expect(postBodies().length).toBeGreaterThan(0));

        expect(postBodies()[0]).toEqual({
            sapAiCore: {
                clientId: 'cid',
                clientSecret: 'secret',
                authUrl: 'https://auth.example',
                baseUrl: 'https://api.example',
                resourceGroup: 'rg1',
                model: 'anthropic--claude-4.5-sonnet',
            },
        });
    });

    it('does not re-POST credentials the backend already has', async () => {
        localStorage.setItem('claudia_sap_ai_core_client_id', 'cid');
        localStorage.setItem('claudia_sap_ai_core_client_secret', 'secret');
        localStorage.setItem('claudia_sap_ai_core_auth_url', 'https://auth.example');
        localStorage.setItem('claudia_sap_ai_core_base_url', 'https://api.example');

        installFetch({ sapAiCore: { clientId: 'cid', clientSecret: 'secret', authUrl: 'https://auth.example', baseUrl: 'https://api.example' } });
        await renderSettings();
        await flush();

        expect(postBodies()).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
describe('SettingsMenu — MCP servers', () => {
    const withServers = {
        mcpServers: [
            { name: 'filesystem', type: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], enabled: true },
            { name: 'remote', type: 'streamableHttp', url: 'http://localhost:8080/mcp', enabled: true },
        ],
    };

    it('lists the servers from the config in list view', async () => {
        installFetch(withServers);
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        expect(screen.getByText('filesystem')).toBeInTheDocument();
        expect(screen.getByText('npx -y fs-mcp')).toBeInTheDocument();
        expect(screen.getByText('remote')).toBeInTheDocument();
        expect(screen.getByText('http://localhost:8080/mcp')).toBeInTheDocument();
        expect(screen.getByText('HTTP')).toBeInTheDocument();
        expect(screen.getByText('stdio')).toBeInTheDocument();
    });

    it('shows the empty state when no servers are configured', async () => {
        installFetch({ mcpServers: [] });
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        expect(screen.getByText('No MCP servers configured')).toBeInTheDocument();
    });

    it('keeps Add Server disabled until the required fields are filled', async () => {
        installFetch({ mcpServers: [] });
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }));

        const add = screen.getByRole('button', { name: 'Add Server' });
        expect(add).toBeDisabled();

        fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'my-server' } });
        expect(add).toBeDisabled(); // name alone is not enough for stdio

        fireEvent.change(screen.getByPlaceholderText('Command (e.g., npx)'), { target: { value: 'npx' } });
        expect(add).toBeEnabled();
    });

    it('an HTTP server requires a URL, not a command', async () => {
        installFetch({ mcpServers: [] });
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }));
        fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'remote' } });
        fireEvent.click(screen.getByRole('radio', { name: 'HTTP (URL)' }));

        expect(screen.queryByPlaceholderText('Command (e.g., npx)')).not.toBeInTheDocument();
        const add = screen.getByRole('button', { name: 'Add Server' });
        expect(add).toBeDisabled();

        fireEvent.change(screen.getByPlaceholderText('URL (e.g., http://localhost:8080/mcp)'), {
            target: { value: 'http://localhost:9000/mcp' },
        });
        expect(add).toBeEnabled();
    });

    it('adding a stdio server PUTs the full server array and closes the form', async () => {
        installFetch(withServers);
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }));
        fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'github' } });
        fireEvent.change(screen.getByPlaceholderText('Command (e.g., npx)'), { target: { value: 'npx' } });
        fireEvent.change(screen.getByPlaceholderText('Arguments (space-separated)'), { target: { value: '-y  gh-mcp' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add Server' }));
        await flush();

        const body = putBodies().at(-1) as { mcpServers: Array<Record<string, unknown>> };
        expect(body.mcpServers.map(s => s.name)).toEqual(['filesystem', 'remote', 'github']);
        expect(body.mcpServers.at(-1)).toEqual({
            name: 'github',
            enabled: true,
            type: 'stdio',
            command: 'npx',
            // blank segments from the double space are filtered out
            args: ['-y', 'gh-mcp'],
            url: undefined,
            env: undefined,
            timeout: undefined,
            autoApprove: undefined,
            description: undefined,
        });

        // Form collapses back to the "Add MCP Server" affordance.
        expect(screen.getByRole('button', { name: 'Add MCP Server' })).toBeInTheDocument();
        expect(screen.getByText('github')).toBeInTheDocument();
    });

    it('adding an HTTP server persists the url and streamableHttp type', async () => {
        installFetch({ mcpServers: [] });
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }));
        fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'remote' } });
        fireEvent.click(screen.getByRole('radio', { name: 'HTTP (URL)' }));
        fireEvent.change(screen.getByPlaceholderText('URL (e.g., http://localhost:8080/mcp)'), {
            target: { value: 'http://localhost:9000/mcp' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Add Server' }));
        await flush();

        const body = putBodies().at(-1) as { mcpServers: Array<Record<string, unknown>> };
        expect(body.mcpServers).toHaveLength(1);
        expect(body.mcpServers[0]).toMatchObject({
            name: 'remote',
            type: 'streamableHttp',
            url: 'http://localhost:9000/mcp',
            enabled: true,
        });
        expect(body.mcpServers[0].command).toBeUndefined();
    });

    it('cancelling the add form discards the draft and writes nothing', async () => {
        installFetch({ mcpServers: [] });
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }));
        fireEvent.change(screen.getByPlaceholderText('Server name'), { target: { value: 'scratch' } });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await flush();

        expect(putBodies()).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Add MCP Server' }));
        expect(screen.getByPlaceholderText('Server name')).toHaveValue('');
    });

    it('removing a server PUTs the remaining servers and drops it from the list', async () => {
        installFetch(withServers);
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        const removeButtons = screen.getAllByTitle('Remove');
        fireEvent.click(removeButtons[0]); // filesystem
        await flush();

        const body = putBodies().at(-1) as { mcpServers: Array<Record<string, unknown>> };
        expect(body.mcpServers.map(s => s.name)).toEqual(['remote']);
        expect(screen.queryByText('filesystem')).not.toBeInTheDocument();
        expect(screen.getByText('remote')).toBeInTheDocument();
    });

    it('surfaces a backend error message when the remove write fails', async () => {
        installFetch(withServers);
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        // Swap in a failing PUT for the removal only.
        const previous = global.fetch;
        global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            const method = init?.method ?? 'GET';
            calls.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
            return { ok: false, status: 400, json: async () => ({ error: 'disk full' }) } as Response;
        }) as unknown as typeof fetch;

        fireEvent.click(screen.getAllByTitle('Remove')[0]);
        await flush();

        expect(await screen.findByText('disk full')).toBeInTheDocument();
        // NOTE: the removal is applied optimistically and is NOT rolled back
        // when the write fails, so the list now disagrees with the backend.
        // Documented here as current behaviour, not endorsed as correct.
        expect(screen.queryByText('filesystem')).not.toBeInTheDocument();
        global.fetch = previous;
    });

    it('tests an MCP connection and reports success', async () => {
        installFetch(withServers, { '/api/mcp/test': { success: true, message: '3 tools' } });
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        fireEvent.click(screen.getAllByTitle('Test Connection')[0]);
        await flush();

        const testCall = calls.find(c => c.path === '/api/mcp/test');
        expect(testCall?.method).toBe('POST');
        expect(testCall?.body).toEqual({
            server: { name: 'filesystem', type: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], url: '', headers: undefined },
        });
        expect(await screen.findByText('3 tools')).toBeInTheDocument();
    });

    it('reports a failed MCP connection test', async () => {
        installFetch(withServers, { '/api/mcp/test': { success: false, error: 'spawn ENOENT' } });
        await renderSettings({ initialPanel: 'mcp' });
        await flush();

        fireEvent.click(screen.getAllByTitle('Test Connection')[0]);
        expect(await screen.findByText('spawn ENOENT')).toBeInTheDocument();
    });
});

// ---------------------------------------------------------------------------
describe('SettingsMenu — MCP JSON editor', () => {
    const withServers = {
        mcpServers: [{ name: 'fs', type: 'stdio', command: 'npx', args: ['fs-mcp'], enabled: true }],
    };

    async function openJsonView() {
        await renderSettings({ initialPanel: 'mcp' });
        await flush();
        fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
        await flush();
    }

    it('renders the servers as an object keyed by name', async () => {
        installFetch(withServers);
        await openJsonView();

        const textarea = screen.getByPlaceholderText('Loading...');
        expect(JSON.parse((textarea as HTMLTextAreaElement).value)).toEqual({
            fs: { type: 'stdio', command: 'npx', args: ['fs-mcp'] },
        });
    });

    it('switches back to list view', async () => {
        installFetch(withServers);
        await openJsonView();

        fireEvent.click(screen.getByRole('button', { name: 'List' }));
        expect(screen.getByText('fs')).toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Loading...')).not.toBeInTheDocument();
    });

    it('saves valid JSON after the 1s debounce, converted back to array format', async () => {
        vi.useFakeTimers();
        installFetch(withServers);
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="mcp" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        fireEvent.change(screen.getByPlaceholderText('Loading...'), {
            target: { value: '{"echo": {"command": "echo", "args": ["hi"]}}' },
        });

        await act(async () => { await vi.advanceTimersByTimeAsync(999); });
        expect(putBodies()).toHaveLength(0);

        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(putBodies().at(-1)).toEqual({
            mcpServers: [{
                name: 'echo', enabled: true, type: 'stdio', command: 'echo', args: ['hi'],
                url: undefined, env: undefined, timeout: undefined, autoApprove: undefined, description: undefined,
            }],
        });
    });

    it('rejects malformed JSON with an inline error and never writes', async () => {
        vi.useFakeTimers();
        installFetch(withServers);
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="mcp" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        fireEvent.change(screen.getByPlaceholderText('Loading...'), { target: { value: '{ oops' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

        expect(screen.getByText(/^Invalid JSON:/)).toBeInTheDocument();
        expect(putBodies()).toHaveLength(0);
    });

    it('rejects a top-level array with a specific message', async () => {
        vi.useFakeTimers();
        installFetch(withServers);
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="mcp" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        fireEvent.change(screen.getByPlaceholderText('Loading...'), { target: { value: '[]' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

        expect(screen.getByText('mcpServers must be an object')).toBeInTheDocument();
        expect(putBodies()).toHaveLength(0);
    });

    it('clears a previous error once the JSON becomes valid again', async () => {
        vi.useFakeTimers();
        installFetch(withServers);
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="mcp" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        const textarea = screen.getByPlaceholderText('Loading...');
        fireEvent.change(textarea, { target: { value: '{ oops' } });
        expect(screen.getByText(/^Invalid JSON:/)).toBeInTheDocument();

        fireEvent.change(textarea, { target: { value: '{}' } });
        expect(screen.queryByText(/^Invalid JSON:/)).not.toBeInTheDocument();
    });
});

// ---------------------------------------------------------------------------
describe('SettingsMenu — CLI switches and model tiering', () => {
    const cfg = {
        claudeCodeSwitches: {
            verbose: false,
            maxTurns: null,
            maxBudgetUsd: null,
            permissionMode: null,
            allowedTools: '',
            disallowedTools: '',
            appendSystemPrompt: '',
            effortLevel: 'high',
            defaultModel: 'sonnet',
        },
    };

    it('populates the switches from config', async () => {
        installFetch({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, verbose: true, effortLevel: 'low', defaultModel: 'opus' } });
        await renderSettings({ initialPanel: 'cliSwitches' });

        expect(controlFor('Verbose')).toBeChecked();
        expect(controlFor('Effort Level')).toHaveValue('low');
        expect(controlFor('Default Model', 'select')).toHaveValue('opus');
    });

    it('falls back to the legacy `model` key for the default model', async () => {
        installFetch({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, defaultModel: '', model: 'haiku' } });
        await renderSettings({ initialPanel: 'cliSwitches' });

        expect(controlFor('Default Model', 'select')).toHaveValue('haiku');
    });

    it('shows a custom model id as the __custom__ select option', async () => {
        installFetch({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, defaultModel: 'Claude-Opus-4.6[1m]' } });
        await renderSettings({ initialPanel: 'cliSwitches' });

        expect(controlFor('Default Model', 'select')).toHaveValue('__custom__');
        expect(screen.getByPlaceholderText('Custom model ID (e.g. Claude-Opus-4.6[1m])')).toHaveValue('Claude-Opus-4.6[1m]');
    });

    it('a toggle writes the whole switches object immediately', async () => {
        installFetch(cfg);
        await renderSettings({ initialPanel: 'cliSwitches' });

        fireEvent.click(controlFor('Verbose'));
        await flush();

        expect(putBodies().at(-1)).toEqual({
            claudeCodeSwitches: { ...cfg.claudeCodeSwitches, verbose: true },
        });
    });

    it('changing effort level persists the new value', async () => {
        installFetch(cfg);
        await renderSettings({ initialPanel: 'cliSwitches' });

        fireEvent.change(controlFor('Effort Level'), { target: { value: 'medium' } });
        await flush();

        expect(putBodies().at(-1)).toEqual({
            claudeCodeSwitches: { ...cfg.claudeCodeSwitches, effortLevel: 'medium' },
        });
    });

    it('enabling Max Turns seeds 50 and edits are debounced by 500ms', async () => {
        vi.useFakeTimers();
        installFetch(cfg);
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="cliSwitches" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        fireEvent.click(controlFor('Max Turns'));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(putBodies().at(-1)).toEqual({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, maxTurns: 50 } });

        const number = controlFor('Max Turns', 'input[type="number"]');
        expect(number).toHaveValue(50);

        const putsBefore = putBodies().length;
        fireEvent.change(number, { target: { value: '12' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(499); });
        expect(putBodies()).toHaveLength(putsBefore);

        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(putBodies().at(-1)).toEqual({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, maxTurns: 12 } });
    });

    it('coerces a non-numeric Max Turns entry to 1', async () => {
        vi.useFakeTimers();
        installFetch({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, maxTurns: 50 } });
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="cliSwitches" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        fireEvent.change(controlFor('Max Turns', 'input[type="number"]'), { target: { value: '' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });

        expect(putBodies().at(-1)).toEqual({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, maxTurns: 1 } });
    });

    it('enabling Max Budget seeds 5.0 and coerces junk input to 0', async () => {
        vi.useFakeTimers();
        installFetch(cfg);
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="cliSwitches" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        fireEvent.click(controlFor('Max Budget (USD)'));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(putBodies().at(-1)).toEqual({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, maxBudgetUsd: 5.0 } });

        fireEvent.change(controlFor('Max Budget (USD)', 'input[type="number"]'), { target: { value: '' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(putBodies().at(-1)).toEqual({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, maxBudgetUsd: 0 } });
    });

    it('turning Max Turns back off persists null', async () => {
        installFetch({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, maxTurns: 50 } });
        await renderSettings({ initialPanel: 'cliSwitches' });

        fireEvent.click(controlFor('Max Turns'));
        await flush();

        expect(putBodies().at(-1)).toEqual({ claudeCodeSwitches: { ...cfg.claudeCodeSwitches, maxTurns: null } });
    });

    it('model tiering hides its tier inputs until enabled, then persists them', async () => {
        vi.useFakeTimers();
        installFetch(cfg);
        render(
            <NotificationProvider>
                <SettingsMenu isOpen onClose={vi.fn()} initialPanel="cliSwitches" />
            </NotificationProvider>
        );
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });

        expect(screen.queryByText('Low complexity')).not.toBeInTheDocument();

        fireEvent.click(controlFor('Model Tiering'));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(putBodies().at(-1)).toEqual({
            modelTiering: { enabled: true, tiers: { low: 'haiku', medium: 'sonnet', high: 'opus' } },
        });

        fireEvent.change(controlFor('High complexity', 'input[type="text"]'), { target: { value: 'claude-opus-4-8' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });

        expect(putBodies().at(-1)).toEqual({
            modelTiering: { enabled: true, tiers: { low: 'haiku', medium: 'sonnet', high: 'claude-opus-4-8' } },
        });
    });

    it('loads a persisted model-tiering config', async () => {
        installFetch({ ...cfg, modelTiering: { enabled: true, tiers: { low: 'a', medium: 'b', high: 'c' } } });
        await renderSettings({ initialPanel: 'cliSwitches' });

        expect(controlFor('Low complexity', 'input[type="text"]')).toHaveValue('a');
        expect(controlFor('Medium complexity', 'input[type="text"]')).toHaveValue('b');
        expect(controlFor('High complexity', 'input[type="text"]')).toHaveValue('c');
    });
});

// ---------------------------------------------------------------------------
describe('SettingsMenu — store-backed toggles', () => {
    it('theme buttons write the preference to the store', async () => {
        installFetch();
        await renderSettings({ initialPanel: 'appearance' });

        expect(useTaskStore.getState().themePreference).toBe('system');

        fireEvent.click(screen.getByRole('button', { name: /Dark/ }));
        expect(useTaskStore.getState().themePreference).toBe('dark');

        fireEvent.click(screen.getByRole('button', { name: /Light/ }));
        expect(useTaskStore.getState().themePreference).toBe('light');

        fireEvent.click(screen.getByRole('button', { name: /System/ }));
        expect(useTaskStore.getState().themePreference).toBe('system');
    });

    it('Show System Stats writes to the store, not the backend', async () => {
        installFetch();
        await renderSettings({ initialPanel: 'behavior' });

        fireEvent.click(controlFor('Show System Stats'));
        await flush();

        expect(useTaskStore.getState().showSystemStats).toBe(true);
        expect(putBodies()).toHaveLength(0);
    });

    it('enabling browser notifications asks for permission and reveals the sub-toggles', async () => {
        installFetch();
        await renderSettings({ initialPanel: 'notifications' });

        expect(screen.queryByText('Task Completion')).not.toBeInTheDocument();

        fireEvent.click(controlFor('Browser Notifications'));
        await flush();

        expect(capabilities.requestNotificationPermission).toHaveBeenCalled();
        expect(useTaskStore.getState().browserNotificationsEnabled).toBe(true);
        expect(screen.getByText('Task Completion')).toBeInTheDocument();
        expect(screen.getByText('Waiting for Input')).toBeInTheDocument();
    });

    it('stays off when the user denies the permission prompt', async () => {
        capabilities.requestNotificationPermission.mockResolvedValue('denied');
        installFetch();
        await renderSettings({ initialPanel: 'notifications' });

        fireEvent.click(controlFor('Browser Notifications'));
        await flush();

        expect(useTaskStore.getState().browserNotificationsEnabled).toBe(false);
        expect(screen.queryByText('Task Completion')).not.toBeInTheDocument();
    });

    it('disables the toggle and explains why when notifications are blocked', async () => {
        capabilities.getNotificationPermission.mockReturnValue('denied');
        installFetch();
        await renderSettings({ initialPanel: 'notifications' });

        expect(controlFor('Browser Notifications')).toBeDisabled();
        expect(screen.getByText(/Notifications are blocked/)).toBeInTheDocument();
    });

    it('explains when the environment has no notification support', async () => {
        capabilities.hasBrowserNotifications.mockReturnValue(false);
        installFetch();
        await renderSettings({ initialPanel: 'notifications' });

        expect(controlFor('Browser Notifications')).toBeDisabled();
        expect(screen.getByText(/not supported in this environment/)).toBeInTheDocument();
    });

    it('the sub-toggles write completion/waiting preferences to the store', async () => {
        useTaskStore.setState({ browserNotificationsEnabled: true });
        installFetch();
        await renderSettings({ initialPanel: 'notifications' });

        fireEvent.click(controlFor('Task Completion'));
        expect(useTaskStore.getState().notifyOnCompletion).toBe(false);

        fireEvent.click(controlFor('Waiting for Input'));
        expect(useTaskStore.getState().notifyOnWaitingInput).toBe(false);
    });

    it('the test-notification button reports success and failure', async () => {
        useTaskStore.setState({ browserNotificationsEnabled: true });
        installFetch();
        await renderSettings({ initialPanel: 'notifications' });

        fireEvent.click(screen.getByRole('button', { name: 'Test Notification' }));
        expect(capabilities.sendBrowserNotification).toHaveBeenCalledWith('Test Notification', {
            body: 'Browser notifications are working!',
            tag: 'test-notification',
        });
        expect(screen.getByText(/Notification sent\./)).toBeInTheDocument();

        capabilities.sendBrowserNotification.mockReturnValue(false);
        fireEvent.click(screen.getByRole('button', { name: 'Test Notification' }));
        expect(screen.getByText(/Failed to send notification/)).toBeInTheDocument();
    });
});

// ---------------------------------------------------------------------------
describe('SettingsMenu — other persisted toggles', () => {
    it('auto-focus-on-input persists to the backend', async () => {
        installFetch({ autoFocusOnInput: false });
        await renderSettings({ initialPanel: 'behavior' });

        fireEvent.click(controlFor('Auto-focus on Input'));
        await flush();

        expect(putBodies()).toContainEqual({ autoFocusOnInput: true });
    });

    it('learnings (RAG) persists to the backend', async () => {
        installFetch({ useLearnings: false });
        await renderSettings({ initialPanel: 'learnings' });

        fireEvent.click(controlFor('Use Learnings'));
        await flush();

        expect(putBodies()).toContainEqual({ useLearnings: true });
    });

    it('the Claudia MCP server toggle persists to the backend', async () => {
        installFetch({ claudiaMcpServerEnabled: false });
        await renderSettings({ initialPanel: 'claudiaMcp' });

        fireEvent.click(controlFor('Enable Claudia MCP Server'));
        await flush();

        expect(putBodies()).toContainEqual({ claudiaMcpServerEnabled: true });
    });

    it('the supervisor toggle persists to the backend', async () => {
        installFetch({ supervisorEnabled: false });
        await renderSettings({ initialPanel: 'supervisor' });

        fireEvent.click(controlFor('Enable AI Supervisor'));
        await flush();

        expect(putBodies()).toContainEqual({ supervisorEnabled: true });
    });
});

/*
 * Deliberately NOT covered here (and why):
 *
 *  - SAP AI Core / Hyperspace Proxy credential panels beyond the localStorage
 *    restore path: these are long credential forms whose only logic is
 *    "input -> setState -> PUT". The two proxy connection-test flows call out
 *    to third-party endpoints (including api.anthropic.com directly) and are
 *    better served by an integration test than by mocking six endpoints.
 *  - Plugin enable/disable cards: they render from a backend-supplied plugin
 *    list, and there are currently no plugins in the default config to key on.
 *  - The MCP test-status auto-reset timers (5s success / 8s failure) — the
 *    status text they clear is already asserted; the reset itself is cosmetic.
 *  - The overlay mousedown/mouseup close dance: it depends on dataset
 *    round-tripping through real pointer events that jsdom models poorly.
 *  - The Sound panel (VoiceSettingsContent) — that is a separate 491-line
 *    component and out of scope for this file.
 */
