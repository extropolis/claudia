#!/usr/bin/env node
/**
 * Monorepo coverage aggregator + regression gate.
 *
 * Vitest reports coverage per workspace package, so nobody could see a single
 * number for Claudia as a whole, and the per-file `thresholds` allowlists in
 * the vitest configs leave every NEW file ungated. This script closes both
 * holes:
 *
 *   1. Aggregate  — merges each package's istanbul `coverage-final.json` into
 *                   one repo-wide total, with a per-package and per-directory
 *                   breakdown.
 *   2. Ratchet    — the repo-wide total may never drop below the committed
 *                   baseline (coverage-baseline.json). It only ever goes up.
 *   3. New-file   — any source file added relative to the merge-base with the
 *      floor        default branch must meet NEW_FILE_FLOOR, so untested code
 *                   cannot land even in files no threshold mentions.
 *   4. Surface    — reports API surface (HTTP routes, WS message types, MCP
 *                   tools) with no apparent test reference, which line
 *                   coverage alone cannot tell you.
 *
 * Usage:
 *   node scripts/coverage.mjs                  # run tests, aggregate, gate
 *   node scripts/coverage.mjs --no-run         # reuse existing coverage output
 *   node scripts/coverage.mjs --update-baseline# accept current numbers
 *   node scripts/coverage.mjs --surface        # include API-surface audit
 *   node scripts/coverage.mjs --json           # machine-readable output
 *   node scripts/coverage.mjs --base <ref>     # merge-base ref for new files
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative, dirname, sep } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'coverage-baseline.json');

/**
 * Packages that produce coverage. Add new workspaces here.
 *
 * `optional` packages are skipped (with a note) when they have no vitest
 * config yet, instead of failing the run. That keeps this script usable in a
 * branch where a package's test setup has not landed, WITHOUT weakening the
 * empty-report check below for packages that ARE configured.
 */
const PACKAGES = [
    { name: 'backend', dir: 'backend', script: 'test:coverage' },
    { name: 'frontend', dir: 'frontend', script: 'test:coverage' },
    { name: 'shared', dir: 'shared', script: 'test:coverage', optional: true },
];

/** Minimum line coverage required of a source file added in this branch. */
const NEW_FILE_FLOOR = 60;

/**
 * Files exempt from the new-file floor. Keep this list SHORT and justified —
 * every entry is a hole in the gate.
 */
const NEW_FILE_EXEMPT = [
    /\.d\.ts$/,
    /[\\/]__tests__[\\/]/,
    /\.test\.(ts|tsx)$/,
    /\.spec\.(ts|tsx)$/,
    /[\\/]test[\\/]setup\.ts$/,
    /\.config\.(ts|mts|js|mjs)$/,
    /[\\/]types?\.ts$/,          // pure type declarations carry no statements
];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const OPTS = {
    run: !flag('--no-run'),
    updateBaseline: flag('--update-baseline'),
    surface: flag('--surface'),
    json: flag('--json'),
    baseRef: opt('--base', null),
};

// ---------------------------------------------------------------------------
// istanbul coverage-final.json → metrics
// ---------------------------------------------------------------------------

const emptyTotals = () => ({
    statements: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
});

function addInto(target, other) {
    for (const k of Object.keys(target)) {
        target[k].covered += other[k].covered;
        target[k].total += other[k].total;
    }
    return target;
}

/**
 * Per-file metrics from one istanbul entry.
 *
 * `lines` is derived from statementMap start lines rather than trusted from a
 * lineMap: the v8 provider emits one statement per line, and collapsing by
 * line (max hit count wins) is what reproduces vitest's own line percentage.
 */
function fileMetrics(entry) {
    const m = emptyTotals();

    const s = entry.s || {};
    for (const id of Object.keys(s)) {
        m.statements.total++;
        if (s[id] > 0) m.statements.covered++;
    }

    const f = entry.f || {};
    for (const id of Object.keys(f)) {
        m.functions.total++;
        if (f[id] > 0) m.functions.covered++;
    }

    const b = entry.b || {};
    for (const id of Object.keys(b)) {
        for (const hit of b[id]) {
            m.branches.total++;
            if (hit > 0) m.branches.covered++;
        }
    }

    const lineHits = new Map();
    const smap = entry.statementMap || {};
    for (const id of Object.keys(smap)) {
        const line = smap[id]?.start?.line;
        if (typeof line !== 'number') continue;
        const hit = s[id] || 0;
        lineHits.set(line, Math.max(lineHits.get(line) || 0, hit));
    }
    for (const hit of lineHits.values()) {
        m.lines.total++;
        if (hit > 0) m.lines.covered++;
    }

    return m;
}

const pct = (c) => (c.total === 0 ? 100 : (c.covered / c.total) * 100);
const fmt = (n) => `${n.toFixed(2)}%`;

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function runPackageCoverage(pkg) {
    process.stderr.write(`\n▶ running coverage: ${pkg.name}\n`);
    const res = spawnSync('npm', ['run', pkg.script, '-w', pkg.dir], {
        cwd: ROOT,
        stdio: OPTS.json ? 'ignore' : 'inherit',
        env: process.env,
    });
    // A failing per-file threshold still writes coverage-final.json, so we
    // record the failure and keep going rather than aborting the aggregate —
    // the operator wants the full picture even when one package is red.
    return res.status === 0;
}

/**
 * Merge two istanbul entries for the SAME file. `shared/src/*` is exercised by
 * both the backend and frontend suites, so it appears in both reports; taking
 * either one alone understates it, and counting both double-counts the totals.
 * Summing hit counts per counter is the only correct answer.
 *
 * Returns null when the coverage maps disagree (different build of the file),
 * in which case the caller keeps the richer entry rather than doing bad math.
 */
function mergeEntries(a, b) {
    const sameShape =
        Object.keys(a.s || {}).length === Object.keys(b.s || {}).length &&
        Object.keys(a.f || {}).length === Object.keys(b.f || {}).length &&
        Object.keys(a.b || {}).length === Object.keys(b.b || {}).length;
    if (!sameShape) return null;

    const out = { ...a, s: { ...a.s }, f: { ...a.f }, b: {} };
    for (const id of Object.keys(out.s)) out.s[id] = (a.s[id] || 0) + (b.s[id] || 0);
    for (const id of Object.keys(out.f)) out.f[id] = (a.f[id] || 0) + (b.f[id] || 0);
    for (const id of Object.keys(a.b || {})) {
        out.b[id] = (a.b[id] || []).map((hit, i) => hit + ((b.b?.[id]?.[i]) || 0));
    }
    return out;
}

function collect() {
    const entries = new Map();   // absolute path -> { pkgs: Set, entry }
    const packages = [];
    const failures = [];
    const skipped = [];

    for (const pkg of PACKAGES) {
        // "Not configured for tests" is a different fact from "tests produced
        // nothing" — only the latter is a bug worth failing on.
        if (pkg.optional && !existsSync(join(ROOT, pkg.dir, 'vitest.config.ts'))) {
            skipped.push(pkg.name);
            continue;
        }

        if (OPTS.run && !runPackageCoverage(pkg)) failures.push(pkg.name);

        const jsonPath = join(ROOT, pkg.dir, 'coverage', 'coverage-final.json');
        if (!existsSync(jsonPath)) {
            throw new Error(
                `No coverage output for "${pkg.name}" at ${jsonPath}. ` +
                `Run without --no-run, or run \`npm run ${pkg.script} -w ${pkg.dir}\` first.`
            );
        }

        const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));

        // An empty report is NOT 100% coverage — it means the run produced
        // nothing (misconfigured include globs, crashed collection, stale
        // wiped output). Left unchecked this reads as a perfect score and
        // silently drags the repo-wide average with a phantom denominator.
        if (Object.keys(raw).length === 0) {
            throw new Error(
                `Coverage report for "${pkg.name}" is EMPTY (${relative(ROOT, jsonPath)}).\n` +
                `An empty report is not 100% — it means collection produced nothing. ` +
                `Check the coverage include/exclude globs in ${pkg.dir}/vitest.config.ts, ` +
                `then re-run \`npm run ${pkg.script} -w ${pkg.dir}\`.`
            );
        }

        const pkgTotals = emptyTotals();

        for (const abs of Object.keys(raw)) {
            addInto(pkgTotals, fileMetrics(raw[abs]));

            const prior = entries.get(abs);
            if (!prior) {
                entries.set(abs, { pkgs: new Set([pkg.name]), entry: raw[abs] });
            } else {
                prior.pkgs.add(pkg.name);
                const merged = mergeEntries(prior.entry, raw[abs]);
                if (merged) {
                    prior.entry = merged;
                } else if (Object.keys(raw[abs].s || {}).length > Object.keys(prior.entry.s || {}).length) {
                    prior.entry = raw[abs];
                }
            }
        }

        packages.push({ name: pkg.name, totals: pkgTotals, fileCount: Object.keys(raw).length });
    }

    // Repo-wide totals come from the DEDUPED+MERGED map, not the sum of
    // per-package totals — otherwise shared/ is counted once per package.
    const files = new Map();
    const total = emptyTotals();
    for (const [abs, { pkgs, entry }] of entries) {
        const m = fileMetrics(entry);
        files.set(abs, { pkg: [...pkgs].join('+'), metrics: m });
        addInto(total, m);
    }

    return { files, packages, total, failures, skipped };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function readBaseline() {
    if (!existsSync(BASELINE_PATH)) return null;
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

/**
 * Ratchet: the repo-wide numbers may never regress. A small tolerance absorbs
 * v8's instrumentation jitter (a line can flip covered/uncovered between runs
 * depending on async interleaving) without opening a hole big enough to hide
 * a real deletion of tests.
 */
const RATCHET_TOLERANCE = 0.25;

function checkRatchet(total, baseline) {
    if (!baseline) {
        return { ok: true, notes: ['no baseline committed yet — run with --update-baseline to create one'] };
    }
    const problems = [];
    for (const metric of ['lines', 'statements', 'branches', 'functions']) {
        const now = pct(total[metric]);
        const was = baseline.total?.[metric];
        if (typeof was !== 'number') continue;
        if (now < was - RATCHET_TOLERANCE) {
            problems.push(
                `${metric}: ${fmt(now)} is below the committed baseline ${fmt(was)} ` +
                `(-${(was - now).toFixed(2)} pts)`
            );
        }
    }
    return { ok: problems.length === 0, problems };
}

function gitFiles(baseRef) {
    try {
        const base = baseRef || defaultBase();
        if (!base) return { base: null, added: [] };

        const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

        // Committed-on-this-branch additions. This is what CI sees on a PR.
        const committed = lines(execFileSync(
            'git', ['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`],
            { cwd: ROOT, encoding: 'utf8' }
        ));

        // Working-tree additions (staged or untracked). Without these the gate
        // is a no-op locally until you commit, which is exactly when a
        // developer most wants to hear about it.
        const working = lines(execFileSync(
            'git', ['status', '--porcelain', '--untracked-files=all'],
            { cwd: ROOT, encoding: 'utf8' }
        ))
            .filter((l) => /^(\?\?|A[ MD]|[ MD]A)/.test(l))
            .map((l) => l.slice(3).trim())
            .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p));

        return { base, added: [...new Set([...committed, ...working])] };
    } catch {
        return { base: null, added: [] };
    }
}

function defaultBase() {
    for (const ref of ['origin/main', 'main']) {
        try {
            return execFileSync('git', ['merge-base', 'HEAD', ref], { cwd: ROOT, encoding: 'utf8' }).trim();
        } catch { /* try next */ }
    }
    return null;
}

/**
 * New-file floor: a source file introduced on this branch must be tested.
 * This is the gate the per-file threshold allowlists structurally cannot
 * provide, since nobody remembers to add a new file to them.
 */
function checkNewFiles(files, baseRef) {
    const { base, added } = gitFiles(baseRef);
    if (!base) return { ok: true, base: null, checked: [], violations: [] };

    const notExempt = (p) => !NEW_FILE_EXEMPT.some((re) => re.test(p));
    const sources = added.filter((p) => /^(backend|frontend|shared)\/src\/.*\.(ts|tsx)$/.test(p) && notExempt(p));

    // electron/ still has no test setup, so its new files can neither be
    // gated nor reported. Surface them rather than silently passing.
    const ungatable = added.filter((p) => /^electron\/.*\.(ts|tsx)$/.test(p) && notExempt(p));

    const checked = [];
    const violations = [];
    for (const rel of sources) {
        const abs = join(ROOT, rel);
        const entry = files.get(abs);
        if (!entry) {
            // Not in the report at all. Both configs set `all: true`, so an
            // absent file means it is outside the coverage `include` globs.
            violations.push({ file: rel, coverage: null, reason: 'not present in any coverage report' });
            continue;
        }
        const linePct = pct(entry.metrics.lines);
        checked.push({ file: rel, coverage: linePct });
        if (linePct < NEW_FILE_FLOOR) {
            violations.push({ file: rel, coverage: linePct, reason: `below the ${NEW_FILE_FLOOR}% new-file floor` });
        }
    }
    return { ok: violations.length === 0, base, checked, violations, ungatable };
}

// ---------------------------------------------------------------------------
// API-surface audit (--surface)
// ---------------------------------------------------------------------------

function readIf(p) { return existsSync(p) ? readFileSync(p, 'utf8') : ''; }

function testCorpus() {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter((p) => /(__tests__|\.test\.(ts|tsx)|\.spec\.(ts|tsx)|^e2e\/)/.test(p));
    return out.map((p) => readIf(join(ROOT, p))).join('\n');
}

function auditSurface() {
    const server = readIf(join(ROOT, 'backend/src/server.ts'));
    const mcp = readIf(join(ROOT, 'backend/src/claudia-mcp-server.ts'));
    const corpus = testCorpus();

    const routes = [...server.matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)]
        .map((m) => ({ kind: 'route', id: `${m[1].toUpperCase()} ${m[2]}`, needle: m[2] }))
        .filter((r) => r.needle.startsWith('/api/'));

    const wsTypes = [...server.matchAll(/^\s*case\s+'([a-z][a-zA-Z]*:[a-zA-Z:]+)'/gm)]
        .map((m) => ({ kind: 'ws', id: m[1], needle: m[1] }));

    // Tools register as `server.tool('claudia_x', description, schema, handler)`.
    const mcpTools = [...mcp.matchAll(/server\.tool\(\s*'(claudia_[a-z_]+)'/g)]
        .map((m) => ({ kind: 'mcp', id: m[1], needle: m[1] }));

    const dedupe = (arr) => [...new Map(arr.map((x) => [x.id, x])).values()];
    const all = [...dedupe(routes), ...dedupe(wsTypes), ...dedupe(mcpTools)];

    const untested = all.filter((x) => !corpus.includes(x.needle));
    return { all, untested };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function dirBreakdown(files) {
    const byDir = new Map();
    for (const [abs, { metrics }] of files) {
        const rel = relative(ROOT, abs);
        const dir = dirname(rel).split(sep).slice(0, 3).join('/');
        if (!byDir.has(dir)) byDir.set(dir, emptyTotals());
        addInto(byDir.get(dir), metrics);
    }
    return [...byDir.entries()]
        .map(([dir, t]) => ({ dir, lines: pct(t.lines), total: t.lines.total }))
        .sort((a, b) => a.lines - b.lines);
}

function worstFiles(files, n = 15) {
    return [...files]
        .map(([abs, { metrics }]) => ({
            file: relative(ROOT, abs),
            lines: pct(metrics.lines),
            uncovered: metrics.lines.total - metrics.lines.covered,
        }))
        .filter((f) => f.uncovered > 0)
        .sort((a, b) => b.uncovered - a.uncovered)
        .slice(0, n);
}

function bar(p) {
    const w = 24;
    const filled = Math.round((p / 100) * w);
    return `${'█'.repeat(filled)}${'░'.repeat(w - filled)}`;
}

function report(data) {
    const { packages, total, files, ratchet, newFiles, surface, failures, skipped } = data;
    const L = [];
    L.push('');
    L.push('═══ Claudia coverage ═══════════════════════════════════════════════');
    L.push('');
    L.push('  package     lines     stmts    branch     funcs    files');
    for (const p of packages) {
        L.push(
            `  ${p.name.padEnd(10)} ${fmt(pct(p.totals.lines)).padStart(7)} ` +
            `${fmt(pct(p.totals.statements)).padStart(9)} ${fmt(pct(p.totals.branches)).padStart(9)} ` +
            `${fmt(pct(p.totals.functions)).padStart(9)} ${String(p.fileCount).padStart(8)}`
        );
    }
    L.push('  ' + '─'.repeat(62));
    L.push(
        `  ${'TOTAL'.padEnd(10)} ${fmt(pct(total.lines)).padStart(7)} ` +
        `${fmt(pct(total.statements)).padStart(9)} ${fmt(pct(total.branches)).padStart(9)} ` +
        `${fmt(pct(total.functions)).padStart(9)} ${String(files.size).padStart(8)}`
    );
    L.push('');
    L.push(`  ${bar(pct(total.lines))}  ${fmt(pct(total.lines))} of ${total.lines.total} lines`);
    L.push('');

    L.push('─── weakest areas (by line coverage) ───────────────────────────────');
    for (const d of dirBreakdown(files).slice(0, 10)) {
        L.push(`  ${fmt(d.lines).padStart(7)}  ${d.dir}  (${d.total} lines)`);
    }
    L.push('');

    L.push('─── biggest untested surfaces (by uncovered lines) ─────────────────');
    for (const f of worstFiles(files)) {
        L.push(`  ${String(f.uncovered).padStart(5)} uncovered  ${fmt(f.lines).padStart(7)}  ${f.file}`);
    }
    L.push('');

    if (surface) {
        const byKind = (k) => surface.untested.filter((u) => u.kind === k);
        L.push('─── API surface with no test reference ─────────────────────────────');
        for (const [kind, label] of [['route', 'HTTP routes'], ['ws', 'WS message types'], ['mcp', 'MCP tools']]) {
            const un = byKind(kind);
            const tot = surface.all.filter((a) => a.kind === kind).length;
            L.push(`  ${label}: ${tot - un.length}/${tot} referenced by tests`);
            for (const u of un) L.push(`      ✗ ${u.id}`);
        }
        L.push('');
        L.push('  (a name appearing in a test is a weak signal — it proves the');
        L.push('   surface is reachable from the suite, not that it is well tested)');
        L.push('');
    }

    L.push('─── gates ──────────────────────────────────────────────────────────');
    if (failures.length) {
        L.push(`  ⚠ package test run failed: ${failures.join(', ')} (per-file thresholds or failing tests)`);
    }
    if (skipped?.length) {
        L.push(`  · skipped (no vitest config yet): ${skipped.join(', ')}`);
    }
    if (ratchet.notes) ratchet.notes.forEach((n) => L.push(`  · ratchet: ${n}`));
    if (ratchet.ok) {
        L.push('  ✓ ratchet: no repo-wide regression');
    } else {
        L.push('  ✗ ratchet: COVERAGE REGRESSED');
        ratchet.problems.forEach((p) => L.push(`      ${p}`));
    }

    if (newFiles.ungatable?.length) {
        L.push(`  ⚠ ${newFiles.ungatable.length} new file(s) in electron/ — no test setup, ungated:`);
        newFiles.ungatable.forEach((f) => L.push(`      ${f}`));
    }
    if (!newFiles.base) {
        L.push('  · new-file floor: skipped (no merge-base with origin/main or main)');
    } else if (newFiles.ok) {
        L.push(`  ✓ new-file floor: ${newFiles.checked.length} new source file(s) meet the ${NEW_FILE_FLOOR}% floor`);
    } else {
        L.push(`  ✗ new-file floor: ${newFiles.violations.length} new file(s) under the ${NEW_FILE_FLOOR}% floor`);
        newFiles.violations.forEach((v) =>
            L.push(`      ${v.file} — ${v.coverage === null ? v.reason : `${fmt(v.coverage)} (${v.reason})`}`)
        );
    }
    L.push('');
    return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const { files, packages, total, failures, skipped } = collect();
    const baseline = readBaseline();
    const ratchet = checkRatchet(total, baseline);
    const newFiles = checkNewFiles(files, OPTS.baseRef);
    const surface = OPTS.surface ? auditSurface() : null;

    const summary = {
        generatedBy: 'scripts/coverage.mjs',
        total: Object.fromEntries(['lines', 'statements', 'branches', 'functions'].map((m) => [m, +pct(total[m]).toFixed(2)])),
        packages: Object.fromEntries(
            packages.map((p) => [p.name, Object.fromEntries(
                ['lines', 'statements', 'branches', 'functions'].map((m) => [m, +pct(p.totals[m]).toFixed(2)])
            )])
        ),
    };

    if (OPTS.updateBaseline) {
        writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 4) + '\n');
        process.stderr.write(`\nBaseline written to ${relative(ROOT, BASELINE_PATH)}\n`);
    }

    if (OPTS.json) {
        console.log(JSON.stringify({ ...summary, ratchet, newFiles, surface, packageFailures: failures, skippedPackages: skipped }, null, 2));
    } else {
        console.log(report({ packages, total, files, ratchet, newFiles, surface, failures, skipped }));
    }

    const gateFailed = (!ratchet.ok || !newFiles.ok) && !OPTS.updateBaseline;
    process.exit(gateFailed || failures.length ? 1 : 0);
}

main();
