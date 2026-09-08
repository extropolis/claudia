/**
 * Guards the WS protocol surface itself against drift.
 *
 * `server.ts` gates every inbound frame on a `VALID_WS_MESSAGE_TYPES` allow-list
 * and then dispatches through a separate `switch (message.type)`. These are two
 * hand-maintained lists that must stay identical:
 *
 *  - a type in the allow-list with NO case → the frame is accepted, silently
 *    falls through the switch, and the client waits forever for a reply;
 *  - a case with NO allow-list entry → dead code; the handler can never run,
 *    and the feature appears broken with only a generic INVALID_MESSAGE error.
 *
 * Neither failure raises anything at runtime, so it is asserted statically here
 * by parsing server.ts. Source parsing (rather than importing the Set) is
 * deliberate: the switch cases are not exported, so the file is the only place
 * both halves are observable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts');

function parseServerProtocol(): { allowList: string[]; cases: string[] } {
    const src = readFileSync(SERVER_SRC, 'utf8');

    const setStart = src.indexOf('const VALID_WS_MESSAGE_TYPES = new Set([');
    expect(setStart, 'VALID_WS_MESSAGE_TYPES declaration not found — did server.ts get restructured?').toBeGreaterThan(-1);
    const setEnd = src.indexOf(']);', setStart);
    const setBody = src.slice(setStart, setEnd);
    const allowList = [...setBody.matchAll(/'([a-z]+:[a-zA-Z:]+)'/g)].map(m => m[1]);

    const cases = [...src.matchAll(/^\s+case '([a-z]+:[a-zA-Z:]+)':/gm)].map(m => m[1]);

    return { allowList, cases };
}

describe('WS message-type allow-list matches the dispatch switch', () => {
    const { allowList, cases } = parseServerProtocol();

    it('parses a plausible protocol surface from server.ts', () => {
        // Sanity: if these regexes silently stop matching, the test below would
        // vacuously pass. Anchor on a floor that reflects the real surface.
        expect(allowList.length).toBeGreaterThan(50);
        expect(cases.length).toBeGreaterThan(50);
    });

    it('has no allow-listed type without a handler (would hang the client)', () => {
        const orphans = allowList.filter(t => !cases.includes(t));
        expect(orphans, `allow-listed but no case in the switch: ${orphans.join(', ')}`).toEqual([]);
    });

    it('has no handler that the allow-list rejects (dead code)', () => {
        const unreachable = cases.filter(t => !allowList.includes(t));
        expect(unreachable, `case exists but type is not allow-listed: ${unreachable.join(', ')}`).toEqual([]);
    });

    it('declares each message type exactly once in the allow-list', () => {
        const dupes = allowList.filter((t, i) => allowList.indexOf(t) !== i);
        expect(dupes, `duplicated in VALID_WS_MESSAGE_TYPES: ${dupes.join(', ')}`).toEqual([]);
    });

    it('handles each message type in exactly one case (no shadowed duplicate)', () => {
        const dupes = cases.filter((t, i) => cases.indexOf(t) !== i);
        expect(dupes, `duplicate case labels — the second is unreachable: ${dupes.join(', ')}`).toEqual([]);
    });
});
