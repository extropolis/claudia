/**
 * /voice page token acceptance.
 *
 * WHAT THIS GUARDS. The page embeds the Deepgram API key, so serving it to an
 * unauthenticated caller is a secret disclosure. It used to accept any token
 * beginning with `local-` on any host the tunnel substring match did not
 * recognize — and that prefix is minted client-side by the frontend as
 * `'local-' + Math.random()...`, with nothing ever registering the suffix. So
 * `GET http://<lan-ip>:4001/voice?token=local-x` returned 200 plus the key to
 * anyone on the network, and only ngrok/localtunnel hostnames were protected.
 *
 * THE FIX. There is no hostname branch and no self-minted prefix. /voice takes
 * the same credential as everything else, checked by the caller.
 *
 * Why a unit test and not an HTTP test: through the real stack a tunnel-host
 * request is first handed to the Vite proxy, which only falls through on
 * ECONNREFUSED — so whether the route is reached depends on whether Vite is
 * running, which is true on a developer machine and false in CI.
 */
import { describe, it, expect } from 'vitest';
import { isVoiceTokenAcceptable } from '../voice-auth.js';

/** Stands in for a server with no valid credentials on offer. */
const acceptsNothing = () => false;

/** Stands in for a server that issued exactly `issued`. */
const accepting = (issued: string) => (t: string) => t === issued;

describe('isVoiceTokenAcceptable', () => {
    it('accepts a token the server actually issued', () => {
        expect(isVoiceTokenAcceptable('real-token', accepting('real-token'))).toBe(true);
    });

    it('REJECTS a self-minted local- token — the prefix is not a credential', () => {
        expect(isVoiceTokenAcceptable('local-abc123', acceptsNothing)).toBe(false);
        expect(isVoiceTokenAcceptable('local-forged', accepting('real-token'))).toBe(false);
    });

    it('rejects a token the server did not issue', () => {
        expect(isVoiceTokenAcceptable('guessed', accepting('real-token'))).toBe(false);
    });

    it('rejects an empty token without consulting the validator', () => {
        let consulted = false;
        const spy = () => { consulted = true; return true; };
        expect(isVoiceTokenAcceptable('', spy)).toBe(false);
        expect(consulted).toBe(false);
    });

    it('does not vary with the host it was asked about', () => {
        // The signature no longer takes a host at all; this test exists to fail
        // loudly if a hostname parameter is ever reintroduced here.
        expect(isVoiceTokenAcceptable.length).toBe(2);
    });
});
