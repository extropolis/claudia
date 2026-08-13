/**
 * Escaping contract for the two server-rendered HTML pages.
 *
 * THE BUG (unauthenticated reflected XSS):
 *   voice-agent-page.ts interpolated wsUrl / token / deepgramApiKey RAW into
 *   single-quoted JS string literals inside an inline <script>:
 *       const WS_URL = '${wsUrl}';
 *       const TOKEN  = '${token}';
 *   and server.ts's `GET /voice` handler takes `token` straight off the query
 *   string, gated only by `token.startsWith('local-')` — which SKIPS token
 *   validation entirely. So
 *       GET /voice?token=local-';alert(document.cookie);//
 *   broke out of the literal with no authentication at all. `wsUrl` is built
 *   from `req.get('host')`, so the Host header was a second vector.
 *
 *   mobile-page.ts used JSON.stringify, which stops quote-breakout but NOT
 *   script-element breakout: JSON.stringify('</script>') is '"</script>"', and
 *   the HTML parser ends the <script> element at that tag regardless of what
 *   the JS tokenizer thinks. Same class of hole, one step further in.
 *
 * WHAT THESE TESTS ASSERT — two independent properties per hostile value:
 *   1. CONTAINMENT: rendering with a hostile value introduces no new
 *      `</script`, `<script`, or `<!--` sequence versus rendering with a
 *      benign one. Counting against a baseline (rather than asserting an
 *      absolute count) is what makes this robust as the pages evolve.
 *   2. ROUND-TRIP: the emitted literal still evaluates, as JavaScript, back to
 *      the exact original string. An escaper that mangles the value would pass
 *      (1) while silently breaking the mobile page and the voice agent.
 *
 * NOT A COVERAGE TEST. Both modules are one giant exported template function
 * (~2,730 lines between them); calling each once marks all of it "covered"
 * while proving essentially nothing. The value here is the escaping contract,
 * not the line count it happens to move.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { jsLiteral } from '../html-escape.js';
import { getVoiceAgentPageHtml } from '../voice-agent-page.js';
import { getMobilePageHtml } from '../mobile-page.js';
import { startHarness, type Harness } from './helpers/server-harness.js';

/** A value with no HTML/JS significance, used to take the baseline counts. */
const BENIGN = 'benign-value-0000';

/**
 * Payloads that break out of one or both of the two contexts in play: the JS
 * string literal, and the <script> element that contains it.
 */
const HOSTILE: Array<[name: string, value: string]> = [
    ['single quote breakout', "';alert(document.cookie);//"],
    ['the real exploit token', "local-';globalThis.__CLAUDIA_XSS_PWNED=1;//"],
    ['double quote', '";alert(1);//'],
    ['backtick + template', '`${alert(1)}`'],
    ['script close tag', '</script><script>alert(1)</script>'],
    ['script close, uppercase + space', '</SCRIPT ><img src=x onerror=alert(1)>'],
    ['script close, no gt', '</script foo'],
    ['html comment open', '<!--<script>'],
    ['html comment close', '--><script>alert(1)</script>'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['backslash eater', "\\'; alert(1); //"],
    ['line separator U+2028', 'a\u2028alert(1)//'],
    ['paragraph separator U+2029', 'b\u2029alert(1)//'],
    ['newline + cr', 'c\n\ralert(1)//'],
    ['everything at once', "</script><!--`'\"\\;${alert(1)}\u2028javascript:</SCRIPT >"],
];

/** Sequences that, if they appear unescaped, end or reopen a script element. */
const BREAKOUT_PATTERNS: Array<[label: string, re: RegExp]> = [
    ['</script', /<\/script/gi],
    ['<script', /<script/gi],
    ['<!--', /<!--/g],
];

function countAll(html: string, re: RegExp): number {
    return (html.match(new RegExp(re.source, re.flags)) ?? []).length;
}

/**
 * Extract the JS literal assigned to `name` and evaluate it AS JAVASCRIPT.
 *
 * Line-based and greedy to the trailing `;`. A correctly escaped literal is
 * always exactly one line — JSON encoding escapes \n and \r, and jsLiteral
 * additionally escapes U+2028/U+2029 — so the whole literal is on the
 * assignment line and nothing follows it. Against a broken escaper the grabbed
 * fragment is either invalid JS (throws) or round-trips to the wrong value;
 * both fail, which is the point.
 *
 * Evaluating rather than JSON.parse-ing matters: it proves the browser's JS
 * parser accepts the escapes and reproduces the original string, so escaping
 * cannot have silently broken the page.
 */
function evalLiteral(html: string, name: string): { ok: true; value: unknown } | { ok: false; raw: string } {
    const line = html.split('\n').find(l => new RegExp(`(?:const|var|let)\\s+${name}\\s*=`).test(l));
    if (line === undefined) return { ok: false, raw: '<no assignment found>' };
    const m = new RegExp(`(?:const|var|let)\\s+${name}\\s*=\\s*(.*);\\s*$`).exec(line);
    if (!m) return { ok: false, raw: line };
    try {
        return { ok: true, value: new Function(`return (${m[1]});`)() };
    } catch {
        return { ok: false, raw: m[1] };
    }
}

/**
 * The shared contract, run against whichever page/parameter is under test.
 * `render` places the given value in exactly one interpolation slot; the other
 * slots stay benign so a failure names the parameter that leaked.
 */
function assertEscapes(render: (value: string) => string, literalName: string) {
    const baseline = render(BENIGN);
    const baseCounts = BREAKOUT_PATTERNS.map(([, re]) => countAll(baseline, re));

    // Sanity: the benign value really does round-trip. If this fails the test
    // helper is wrong, not the escaper.
    const benignRoundTrip = evalLiteral(baseline, literalName);
    expect(benignRoundTrip, `${literalName}: benign value must produce a parseable literal`).toMatchObject({ ok: true });
    expect((benignRoundTrip as { value: unknown }).value).toBe(BENIGN);

    for (const [name, value] of HOSTILE) {
        const html = render(value);

        BREAKOUT_PATTERNS.forEach(([label, re], i) => {
            expect(
                countAll(html, re),
                `${literalName} / ${name}: payload introduced a new "${label}" sequence — it escaped its context`,
            ).toBe(baseCounts[i]);
        });

        const got = evalLiteral(html, literalName);
        expect(got, `${literalName} / ${name}: emitted literal is not valid JS (raw: ${(got as { raw?: string }).raw})`)
            .toMatchObject({ ok: true });
        expect(
            (got as { value: unknown }).value,
            `${literalName} / ${name}: literal no longer round-trips to the original value`,
        ).toBe(value);
    }
}

describe('jsLiteral', () => {
    it('round-trips every hostile value through the JS parser', () => {
        for (const [name, value] of HOSTILE) {
            expect(new Function(`return (${jsLiteral(value)});`)(), name).toBe(value);
        }
    });

    it('emits no character that means anything to the HTML tokenizer', () => {
        for (const [name, value] of HOSTILE) {
            const lit = jsLiteral(value);
            expect(lit, `${name}: "<" must not survive`).not.toContain('<');
            expect(lit, `${name}: ">" must not survive`).not.toContain('>');
            expect(lit, `${name}: "&" must not survive`).not.toContain('&');
        }
    });

    it('escapes </script> specifically — the case JSON.stringify gets wrong', () => {
        // The regression guard for the mobile-page hole. JSON.stringify passes
        // the closing tag straight through; jsLiteral must not.
        expect(JSON.stringify('</script>')).toContain('</script>');
        expect(jsLiteral('</script>')).not.toContain('</script>');
        expect(new Function(`return (${jsLiteral('</script>')});`)()).toBe('</script>');
    });

    it('escapes the U+2028/U+2029 line terminators', () => {
        expect(jsLiteral('a\u2028b')).toBe('"a\\u2028b"');
        expect(jsLiteral('a\u2029b')).toBe('"a\\u2029b"');
    });

    it('emits a single-line literal for values containing newlines', () => {
        expect(jsLiteral('a\nb\r\nc')).not.toContain('\n');
        expect(new Function(`return (${jsLiteral('a\nb\r\nc')});`)()).toBe('a\nb\r\nc');
    });

    it('produces a valid empty literal for null and undefined', () => {
        expect(new Function(`return (${jsLiteral(undefined)});`)()).toBe('');
        expect(new Function(`return (${jsLiteral(null)});`)()).toBe('');
        expect(new Function(`return (${jsLiteral('')});`)()).toBe('');
    });
});

describe('voice-agent-page: inline <script> escaping', () => {
    it('escapes the token (the /voice?token= XSS vector)', () => {
        assertEscapes(v => getVoiceAgentPageHtml('ws://localhost:1234', v, 'dg-key'), 'TOKEN');
    });

    it('escapes the wsUrl (the Host-header vector)', () => {
        assertEscapes(v => getVoiceAgentPageHtml(v, 'local-tok', 'dg-key'), 'WS_URL');
    });

    it('escapes the Deepgram API key (a secret placed in a JS literal)', () => {
        assertEscapes(v => getVoiceAgentPageHtml('ws://localhost:1234', 'local-tok', v), 'DEEPGRAM_API_KEY');
    });

    it('does not let a payload execute when the emitted line is evaluated', () => {
        // Evaluate the WHOLE emitted source line, the way a browser's parser
        // would — not just the literal. Against the raw-interpolation bug the
        // line reads `const TOKEN = 'local-';globalThis.__PWNED=1;//';`, which
        // is perfectly valid JS that sets the global. That is the whole point.
        const g = globalThis as Record<string, unknown>;
        delete g.__CLAUDIA_XSS_PWNED;
        const html = getVoiceAgentPageHtml('ws://x', "local-';globalThis.__CLAUDIA_XSS_PWNED=1;//", '');
        const line = html.split('\n').find(l => /(?:const|var|let)\s+TOKEN\s*=/.test(l));
        expect(line, 'expected a TOKEN assignment line in the page').toBeDefined();
        try { new Function(line!)(); } catch { /* a throw is also "did not execute" */ }
        expect(g.__CLAUDIA_XSS_PWNED, 'payload executed — it escaped the string literal').toBeUndefined();
        delete g.__CLAUDIA_XSS_PWNED;
    });
});

describe('mobile-page: inline <script> escaping', () => {
    it('escapes the token', () => {
        assertEscapes(v => getMobilePageHtml('ws://localhost:1234', v), 'TOKEN');
    });

    it('escapes the wsUrl', () => {
        assertEscapes(v => getMobilePageHtml(v, 'local-tok'), 'WS_URL');
    });
});

/**
 * End-to-end through the real route. This is what proves the vector is closed
 * in production and not just in the template function — including that `/voice`
 * accepts an unauthenticated `local-` token in the first place.
 */
describe('GET /voice end-to-end', () => {
    let h: Harness | undefined;

    afterAll(async () => { await h?.stop(); });

    it('serves a safe page for an unauthenticated local- token carrying a payload', async () => {
        h = await startHarness({ prefix: '.claudia-xss-test-' });

        const benign = await h.fetch(`/voice?token=${encodeURIComponent('local-' + BENIGN)}`);
        expect(benign.status).toBe(200);
        const benignHtml = await benign.text();
        const baseCounts = BREAKOUT_PATTERNS.map(([, re]) => countAll(benignHtml, re));

        for (const [name, value] of HOSTILE) {
            const token = 'local-' + value;
            const res = await h.fetch(`/voice?token=${encodeURIComponent(token)}`);
            expect(res.status, `${name}: route should still serve the page`).toBe(200);
            const html = await res.text();

            BREAKOUT_PATTERNS.forEach(([label, re], i) => {
                expect(
                    countAll(html, re),
                    `/voice ${name}: response introduced a new "${label}" sequence`,
                ).toBe(baseCounts[i]);
            });

            const got = evalLiteral(html, 'TOKEN');
            expect(got, `/voice ${name}: served literal is not valid JS`).toMatchObject({ ok: true });
            expect((got as { value: unknown }).value, `/voice ${name}: token no longer round-trips`).toBe(token);
        }
    });
});
