/**
 * Context-aware escaping for server-rendered HTML pages.
 *
 * Embedding an untrusted value in an HTML document is not one problem but
 * several, and the correct escaping depends entirely on which slot the value
 * lands in. Every interpolation in mobile-page.ts and voice-agent-page.ts is an
 * inline-`<script>` slot, so that is the one context implemented here. If an
 * attribute or text-content slot is ever added to those pages, add the matching
 * helper rather than reaching for this one — `jsLiteral` is not correct there.
 */

/**
 * Serialize a value as a JavaScript literal safe to embed inside an inline
 * `<script>` element.
 *
 * `JSON.stringify` alone is NOT sufficient here, which is the subtle part. It
 * correctly prevents quote-breakout, but the value still sits inside a
 * `<script>` *element*, and the HTML tokenizer scans that element's raw text
 * for `</script`, `<script`, and `<!--` before JavaScript ever sees it.
 * `JSON.stringify('</script>')` yields `"</script>"`, whose closing tag ends
 * the element — the injected markup then lands in HTML context, wide open.
 *
 * So: JSON-encode for the JS-string layer, then neutralize the characters that
 * matter to the HTML layer by rewriting them as `\uXXXX` escapes. Those escapes
 * are resolved by the JavaScript parser, so the runtime value is unchanged —
 * `jsLiteral('</script>')` evaluates back to exactly `</script>` — while the
 * HTML tokenizer sees only inert ASCII and never finds a tag to close.
 *
 * U+2028 / U+2029 are escaped too: they are literal line terminators to older
 * JavaScript parsers, so an unescaped one can terminate the statement early.
 *
 * Returns a COMPLETE literal including its surrounding quotes. Interpolate it
 * bare — `const T = ${jsLiteral(token)};` — never inside quotes of your own.
 */
export function jsLiteral(value: unknown): string {
    return JSON.stringify(value ?? '')
        // `<` and `>` cover `</script`, `<script`, `<!--` and `-->` in one go.
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        // Not strictly required once `<` is gone, but it closes off HTML-entity
        // tricks in any context that re-decodes the payload before parsing it.
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
