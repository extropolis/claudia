import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileAccessModal } from '../MobileAccessModal';
const address = 'https://pc.tail.ts.net';
const original = window.fetch;
let requests: ReturnType<typeof vi.fn>;
beforeEach(() => {
    requests = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT') return new Response('{}');
        return new Response(JSON.stringify(url.endsWith('/api/config') ? { tailscaleUrl: address } : { instanceId: 'host-one' }));
    });
    window.fetch = requests as typeof fetch;
});
afterEach(() => { cleanup(); window.fetch = original; });
describe('Tailscale device setup', () => {
    it('copies only the address and never starts a tunnel', async () => {
        const user = userEvent.setup();
        const copy = vi.spyOn(navigator.clipboard, 'writeText');
        render(<MobileAccessModal isOpen onClose={vi.fn()} />);
        await waitFor(() => expect(screen.getByLabelText('Tailscale HTTPS address')).toHaveValue(address));
        await user.click(screen.getByRole('button', { name: 'Copy address' }));
        expect(copy).toHaveBeenCalledWith(address);
        expect(requests.mock.calls.every(([url]) => !String(url).includes('/api/tunnel'))).toBe(true);
    });
    it('checks public identity without forwarding a token', async () => {
        const user = userEvent.setup();
        render(<MobileAccessModal isOpen onClose={vi.fn()} />);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Check connection' })).toBeEnabled());
        await user.click(screen.getByRole('button', { name: 'Check connection' }));
        expect(await screen.findByRole('status')).toHaveTextContent('reachable from this device');
        expect(requests).toHaveBeenCalledWith(`${address}/api/server-info`, expect.objectContaining({ credentials: 'omit' }));
        const init = requests.mock.calls.at(-1)?.[1];
        expect(init?.headers).toBeUndefined();
    });
    it('surfaces invalid settings without marking them saved', async () => {
        const user = userEvent.setup();
        render(<MobileAccessModal isOpen onClose={vi.fn()} />);
        await waitFor(() => expect(screen.getByLabelText('Tailscale HTTPS address')).toHaveValue(address));
        await user.clear(screen.getByLabelText('Tailscale HTTPS address'));
        await user.type(screen.getByLabelText('Tailscale HTTPS address'), 'http://wrong');
        requests.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Use HTTPS' }), { status: 400 }));
        await user.click(screen.getByRole('button', { name: 'Save address' }));
        expect(await screen.findByRole('status')).toHaveTextContent('Use HTTPS');
        expect(screen.getByRole('button', { name: 'Copy address' })).toBeDisabled();
    });
});
