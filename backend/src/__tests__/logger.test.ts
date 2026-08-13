import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger, log } from '../logger.js';

/**
 * Tests for src/logger.ts
 *
 * Covers: level filtering (debug gated on process.env.DEBUG), the exact output
 * format, context serialization, which console sink each level writes to, and
 * the legacy `log()` helper.
 *
 * KNOWN GAPS documented (not endorsed) by the tests at the bottom:
 *   - the logger performs NO redaction of secret-looking context values
 *   - JSON.stringify on the context is unguarded, so a circular context throws
 */

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

describe('logger', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let originalDebug: string | undefined;

    beforeEach(() => {
        originalDebug = process.env.DEBUG;
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        if (originalDebug === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = originalDebug;
        vi.restoreAllMocks();
    });

    describe('level filtering', () => {
        it('suppresses debug when DEBUG is unset', () => {
            delete process.env.DEBUG;
            createLogger('[T]').debug('hidden');
            expect(logSpy).not.toHaveBeenCalled();
        });

        it('suppresses debug when DEBUG is the empty string (falsy)', () => {
            process.env.DEBUG = '';
            createLogger('[T]').debug('hidden');
            expect(logSpy).not.toHaveBeenCalled();
        });

        it('emits debug when DEBUG is set to any truthy value', () => {
            process.env.DEBUG = '1';
            createLogger('[T]').debug('shown');
            expect(logSpy).toHaveBeenCalledTimes(1);
            expect(logSpy.mock.calls[0][0]).toContain('[T] [DEBUG] shown');
        });

        it('emits debug when DEBUG is a namespace string', () => {
            process.env.DEBUG = 'claudia:*';
            createLogger('[T]').debug('shown');
            expect(logSpy).toHaveBeenCalledTimes(1);
        });

        it('emits info, warn and error regardless of DEBUG', () => {
            delete process.env.DEBUG;
            const logger = createLogger('[T]');
            logger.info('i');
            logger.warn('w');
            logger.error('e');
            expect(logSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('sink routing', () => {
        it('routes each level to its own console method and no other', () => {
            process.env.DEBUG = '1';
            const logger = createLogger('[Routing]');

            logger.warn('only-warn');
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(logSpy).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();

            logger.error('only-error');
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledTimes(1);

            logger.info('only-info');
            logger.debug('also-log');
            expect(logSpy).toHaveBeenCalledTimes(2);
        });
    });

    describe('formatting', () => {
        it('formats as "<iso> <prefix> [<LEVEL>] <message>"', () => {
            createLogger('[Server]').info('started');
            const line = logSpy.mock.calls[0][0] as string;
            expect(line).toMatch(ISO);
            expect(line).toMatch(/^\S+ \[Server\] \[INFO\] started$/);
        });

        it('uppercases the level for every level', () => {
            process.env.DEBUG = '1';
            const logger = createLogger('[P]');
            logger.debug('d');
            logger.info('i');
            logger.warn('w');
            logger.error('e');
            expect(logSpy.mock.calls[0][0]).toContain('[DEBUG]');
            expect(logSpy.mock.calls[1][0]).toContain('[INFO]');
            expect(warnSpy.mock.calls[0][0]).toContain('[WARN]');
            expect(errorSpy.mock.calls[0][0]).toContain('[ERROR]');
        });

        it('appends JSON-serialized context after a single space', () => {
            createLogger('[P]').info('with ctx', { a: 1, b: 'two' });
            expect(logSpy.mock.calls[0][0]).toBe(
                `${(logSpy.mock.calls[0][0] as string).split(' ')[0]} [P] [INFO] with ctx {"a":1,"b":"two"}`,
            );
        });

        it('omits the context segment entirely when no context is passed', () => {
            createLogger('[P]').info('no ctx');
            expect(logSpy.mock.calls[0][0]).toMatch(/no ctx$/);
        });

        it('emits an empty-object context rather than omitting it (truthy {})', () => {
            createLogger('[P]').info('empty ctx', {});
            expect(logSpy.mock.calls[0][0]).toMatch(/empty ctx \{\}$/);
        });

        it('serializes nested and array context values', () => {
            createLogger('[P]').warn('nested', { a: { b: [1, 2] }, c: null });
            expect(warnSpy.mock.calls[0][0]).toContain('{"a":{"b":[1,2]},"c":null}');
        });

        it('drops undefined context values the way JSON.stringify does', () => {
            createLogger('[P]').error('undef', { kept: 1, dropped: undefined });
            expect(errorSpy.mock.calls[0][0]).toContain('{"kept":1}');
        });

        it('serializes Error objects in context as {} (JSON.stringify semantics)', () => {
            // Callers across the codebase do logger.error('...', { error }). This
            // asserts the (lossy) shape that actually reaches the console.
            createLogger('[P]').error('boom', { error: new Error('detail') });
            expect(errorSpy.mock.calls[0][0]).toContain('{"error":{}}');
        });

        it('preserves the prefix verbatim, including an empty prefix', () => {
            createLogger('').info('m');
            expect(logSpy.mock.calls[0][0]).toMatch(/^\S+  \[INFO\] m$/);
        });

        it('gives independent loggers independent prefixes', () => {
            createLogger('[A]').info('x');
            createLogger('[B]').info('x');
            expect(logSpy.mock.calls[0][0]).toContain('[A]');
            expect(logSpy.mock.calls[1][0]).toContain('[B]');
        });

        it('emits a fresh timestamp per call', () => {
            const logger = createLogger('[P]');
            logger.info('a');
            logger.info('b');
            const t0 = (logSpy.mock.calls[0][0] as string).split(' ')[0];
            const t1 = (logSpy.mock.calls[1][0] as string).split(' ')[0];
            // Non-decreasing ISO timestamps; string compare is valid for ISO-8601 Z.
            expect(t1 >= t0).toBe(true);
        });
    });

    describe('log() legacy helper', () => {
        it('writes "<prefix> <message>" with no timestamp or level', () => {
            log('[Legacy]', 'hello');
            expect(logSpy).toHaveBeenCalledWith('[Legacy] hello');
        });

        it('appends serialized context when provided', () => {
            log('[Legacy]', 'hello', { n: 3 });
            expect(logSpy).toHaveBeenCalledWith('[Legacy] hello {"n":3}');
        });

        it('always writes to console.log, never warn/error', () => {
            log('[Legacy]', 'hello');
            expect(warnSpy).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('ignores DEBUG (it is not level-gated)', () => {
            delete process.env.DEBUG;
            log('[Legacy]', 'always');
            expect(logSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('KNOWN GAPS (documented, not endorsed)', () => {
        it('does NOT redact secret-looking context keys — values pass through verbatim', () => {
            // Documenting the absence of redaction so that adding it is a
            // deliberate, test-visible change rather than a silent one.
            createLogger('[P]').info('cfg', { apiKey: 'PLACEHOLDER-NOT-A-REAL-SECRET' });
            expect(logSpy.mock.calls[0][0]).toContain('PLACEHOLDER-NOT-A-REAL-SECRET');
        });

        it('throws instead of degrading when the context is circular', () => {
            // JSON.stringify is unguarded, so a circular context turns a log
            // call into an exception in the caller's code path.
            const circular: Record<string, unknown> = { name: 'x' };
            circular.self = circular;
            expect(() => createLogger('[P]').info('circular', circular)).toThrow(TypeError);
        });
    });
});
