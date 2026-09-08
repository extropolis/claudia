# Plan Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This is a **visual feature** — per project rules, verify the always-on meter and dashboard by manual browser check (Playwright MCP or the running app at :5173), not only unit tests. Load the **dataviz** skill before writing any chart/meter/progress code.

**Goal:** Surface the user's real Anthropic plan usage inside Claudia the way claude.ai/settings/usage does — an always-visible "current session" meter on the main page, plus an openable dashboard with weekly (all-models and per-model) limits and reset times.

**Architecture:** The backend reads the Claude Code OAuth token from the OS credential store and calls Anthropic's undocumented `GET /api/oauth/usage` endpoint (the same source powering Claude Code's `/usage`). Results are cached hard and polled slowly (the endpoint 429s aggressively). The backend exposes `GET /api/usage` + a `usage:updated` WS broadcast; the frontend renders a compact session meter always, and a full dashboard on demand.

**Tech Stack:** TypeScript, Express + WS, Node `https`/`fetch`, macOS `security` CLI for Keychain, Zustand + React, vitest.

## Global Constraints

- **NEVER touch ports 4001/5173, never restart the server** (`tsx watch` hot-reloads).
- No attribution footers in commits. No summary-report files. Clean up any temp test files.
- **Rate-limit discipline is a hard requirement.** `/api/oauth/usage` returns persistent 429s if abused. Rules: send the required `User-Agent` header; never poll faster than **180s**; default cache TTL **300s**; on 429, exponential backoff (300s → 600s → 1200s, cap 1800s); only run the background poll while ≥1 WS client is connected; always serve last-good cache on any fetch failure.
- **Confirmed API contract** (verified 2026-07-02):
  - `GET https://api.anthropic.com/api/oauth/usage`
  - Headers (ALL required — missing User-Agent causes permanent 429):
    - `Authorization: Bearer <accessToken>`
    - `anthropic-beta: oauth-2025-04-20`
    - `User-Agent: claude-code/<version>` (detect via `claude --version`; fallback `claude-code/2.1.198`)
    - `Content-Type: application/json`
  - Response JSON:
    ```json
    {
      "five_hour":       { "utilization": <0-100>, "resets_at": "<ISO8601>" },
      "seven_day":       { "utilization": <0-100>, "resets_at": "<ISO8601>" },
      "seven_day_opus":  { "utilization": <0-100>, "resets_at": "<ISO8601>" } | null,
      "seven_day_sonnet":{ ... } | null,
      "extra_usage":     { "is_enabled": <bool>, "monthly_limit": <num|null>, "used_credits": <num|null>, "utilization": <num|null> }
    }
    ```
    Treat any `seven_day_<model>` key generically (so a future `seven_day_fable` renders with no code change).
- **Token source** (shape `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType, rateLimitTier } }`):
  - macOS: `security find-generic-password -s "Claude Code-credentials" -a "$USER" -w` → stdout is the JSON blob.
  - Linux/Windows: read `~/.claude/.credentials.json` (same JSON shape).
  - `subscriptionType` (`"max"`/`"pro"`) → plan label ("Max", "Pro"). If `expiresAt` is in the past, still attempt the call (Claude Code refreshes it out of band); on 401 report `unavailable` with reason `auth`.

---

### Task 1: Shared usage types

**Files:** Modify `shared/src/index.ts`; Test — none (types only, exercised in Task 2).

**Interfaces — Produces (exact names later tasks depend on):**
```ts
export interface UsageWindow { utilization: number; resetsAt: string; }          // utilization 0-100
export interface UsageModelWindow extends UsageWindow { model: string; }          // model e.g. "opus","sonnet","fable"
export interface PlanUsage {
    fiveHour: UsageWindow;
    sevenDay: UsageWindow;
    sevenDayByModel: UsageModelWindow[];
    extraUsage?: { isEnabled: boolean; monthlyLimit: number | null; usedCredits: number | null; utilization: number | null };
    planLabel: string;            // "Max" | "Pro" | "Unknown"
    fetchedAt: string;            // ISO
    stale?: boolean;              // served from cache after a failed refresh
    unavailable?: boolean;        // could not fetch at all
    reason?: 'auth' | 'rate_limited' | 'no_token' | 'network' | 'unsupported_platform';
}
```
Add `'usage:get'` and `'usage:updated'` to the `WSMessageType` union.

- [ ] Add the interfaces + WS message types. Commit: `feat: add PlanUsage shared types`.

---

### Task 2: Pure response mapper (`mapUsageResponse`)

**Files:** Create `backend/src/usage-mapper.ts`; Test `backend/src/__tests__/usage-mapper.test.ts`.

**Interfaces — Produces:** `mapUsageResponse(raw: unknown, planLabel: string, fetchedAt: string): PlanUsage`

- [ ] **Step 1 — failing test.** Cover: full payload with opus+sonnet maps to `sevenDayByModel` of length 2 with `model:'opus'|'sonnet'`; null per-model keys are omitted; an unknown `seven_day_fable` key is included with `model:'fable'`; `extra_usage.is_enabled:false` → `extraUsage.isEnabled false`; utilization/resets_at copied verbatim onto `fiveHour`/`sevenDay`; `planLabel`/`fetchedAt` passed through. Test with literal JSON objects (no network).

```ts
import { describe, it, expect } from 'vitest';
import { mapUsageResponse } from '../usage-mapper';

const raw = {
    five_hour: { utilization: 31, resets_at: '2026-07-02T04:00:00Z' },
    seven_day: { utilization: 28, resets_at: '2026-07-08T15:00:00Z' },
    seven_day_opus: { utilization: 12, resets_at: '2026-07-08T14:59:00Z' },
    seven_day_sonnet: null,
    seven_day_fable: { utilization: 9, resets_at: '2026-07-08T14:59:00Z' },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

it('maps windows, generic per-model keys, and drops nulls', () => {
    const u = mapUsageResponse(raw, 'Max', '2026-07-02T01:00:00Z');
    expect(u.fiveHour).toEqual({ utilization: 31, resetsAt: '2026-07-02T04:00:00Z' });
    expect(u.sevenDay.utilization).toBe(28);
    expect(u.sevenDayByModel.map(m => m.model).sort()).toEqual(['fable', 'opus']);
    expect(u.sevenDayByModel.find(m => m.model === 'fable')?.utilization).toBe(9);
    expect(u.extraUsage?.isEnabled).toBe(false);
    expect(u.planLabel).toBe('Max');
});
```

- [ ] **Step 2** run → FAIL (no module). **Step 3** implement the mapper (iterate `Object.entries(raw)`, match `/^seven_day_(.+)$/`, skip null values, clamp utilization to `[0,100]` defensively). **Step 4** run → PASS. **Step 5** commit `feat: pure mapper for Anthropic usage response`.

---

### Task 3: Token reader (`usage-credentials.ts`)

**Files:** Create `backend/src/usage-credentials.ts`; Test `backend/src/__tests__/usage-credentials.test.ts`.

**Interfaces — Produces:**
- `readOAuthCredentials(): Promise<{ accessToken: string; subscriptionType?: string } | null>` (null when no token found / unsupported)
- `planLabelFromSubscription(sub?: string): string` (`'max'`→`'Max'`, `'pro'`→`'Pro'`, else `'Unknown'`)
- `parseCredentialsBlob(json: string): { accessToken: string; subscriptionType?: string } | null` (pure — this is what the test targets; handles both `{claudeAiOauth:{...}}` and a bare `{...}` shape)

- [ ] **Step 1 — failing test** for `parseCredentialsBlob` (valid nested blob → token+sub; missing accessToken → null; malformed JSON → null) and `planLabelFromSubscription`. Keep `readOAuthCredentials` (does I/O: spawns `security` on macOS, reads `~/.claude/.credentials.json` otherwise) out of the pure test.
- [ ] **Steps 2-4** implement + pass. On macOS use `execFile('security', ['find-generic-password','-s','Claude Code-credentials','-a', os.userInfo().username, '-w'])`. On other platforms read `path.join(os.homedir(), '.claude', '.credentials.json')`. Never log the token. **Step 5** commit `feat: read Claude Code OAuth token from OS credential store`.

---

### Task 4: Usage service — fetch, cache, backoff (`usage-service.ts`)

**Files:** Create `backend/src/usage-service.ts`; Test `backend/src/__tests__/usage-service.test.ts`.

**Interfaces — Produces a `UsageService` class:**
- `getUsage(forceRefresh?: boolean): Promise<PlanUsage>` — returns cached if within TTL or during backoff; otherwise fetches. Never throws; encodes failure in `PlanUsage.unavailable/stale/reason`.
- `startPolling(hasClients: () => boolean)` / `stopPolling()` — interval respecting TTL + backoff, skips when `!hasClients()`.
- Constructor takes injectable deps for testing: `{ fetchImpl, readCreds, detectVersion, now }` (all optional; real defaults wired in). `fetchImpl(url, init) => Promise<{ status, json() }>`.

**Testable logic (unit-test with injected deps, NO real network):**
- Cold call with a stubbed 200 → returns mapped usage, `stale` false; second call within TTL returns the SAME cached object without calling `fetchImpl` again.
- Stubbed 429 → `getUsage` returns last-good cache with `stale:true` (or `unavailable:true, reason:'rate_limited'` if no cache yet), and the next allowed fetch time moves out by the backoff schedule (assert `fetchImpl` is NOT called again before backoff elapses using the injected `now`).
- `readCreds` returns null → `unavailable:true, reason:'no_token'`, no fetch attempted.
- Stubbed 401 → `unavailable:true, reason:'auth'`.

- [ ] Write failing tests for the four scenarios above (inject `now` as a mutable clock, `fetchImpl` as a stub returning scripted `{status,json}`). Implement the service (in-memory `lastGood: PlanUsage | null`, `nextAllowedFetchAt: number`, `backoffStep`). Required headers exactly as in Global Constraints; detect version once via `execFile(claudeBin,['--version'])` parsed to `claude-code/<x.y.z>`, fallback `claude-code/2.1.198`. Pass → commit `feat: usage service with hard caching and 429 backoff`.

---

### Task 5: Wire into server (REST + WS + poller)

**Files:** Modify `backend/src/server.ts`.

- [ ] Instantiate `UsageService` at startup. Add `app.get('/api/usage', async (_req,res) => res.json(await usageService.getUsage()))`. Add WS `case 'usage:get'` → reply `{ type:'usage:updated', payload: await usageService.getUsage() }` to that socket. Start `usageService.startPolling(() => wss.clients.size > 0)` after the server binds; on each successful/changed poll, `broadcast({ type:'usage:updated', payload })`. Verify: `curl -s localhost:4001/api/usage | python3 -m json.tool` (server already running — do NOT restart) shows real `fiveHour`/`sevenDay` numbers. Commit `feat: expose plan usage over REST and WS`.

---

### Task 6: test-cli `--usage`

**Files:** Modify `backend/test-cli.ts`.

- [ ] Add `--usage` flag that GETs `/api/usage` and pretty-prints session %, weekly %, per-model %, reset times, and any `unavailable`/`stale` state. Update `--help`. Verify: `npx tsx test-cli.ts --usage`. Commit `feat: test-cli --usage`.

---

### Task 7: Frontend store + WS wiring

**Files:** Modify `frontend/src/stores/taskStore.ts`, `frontend/src/hooks/useWebSocket.ts` (or wherever WS messages are dispatched); Test `frontend/src/__tests__/taskStore.test.ts`.

- [ ] Add `planUsage: PlanUsage | null` + `setPlanUsage(u)` to the store. On WS `usage:updated`, call `setPlanUsage(payload)`. On WS (re)connect, send `usage:get`. Add a store test: `setPlanUsage` populates state; a `usage:updated` dispatch (via the existing message-dispatch path the other tests use) updates it. Commit `feat: plan usage in frontend store`.

---

### Task 8: Always-visible session meter (`SessionUsageMeter.tsx`)

**Files:** Create `frontend/src/components/SessionUsageMeter.tsx` (+ css); mount it in the main-page chrome (top of `WorkspacePanel.tsx` header, or the app header — match existing layout).

**REQUIRED: load the `dataviz` skill first.** Match claude.ai's restraint: a slim horizontal meter or small ring, utilization-colored (calm under ~75%, warm 75–90%, hot >90%), label `"31% · resets in 2h 17m"` (compute the countdown from `fiveHour.resetsAt` with a 1-min ticking `setInterval`, cleared on unmount). Clicking it opens the dashboard (Task 9). Degrade gracefully: if `planUsage?.unavailable`, show a muted "usage unavailable" affordance (tooltip carries `reason`); if `stale`, a subtle dot. Accessible: `role="progressbar"` with aria values.

- [ ] Build it, mount it, and **verify visually** in the browser (Playwright MCP screenshot or ask nothing — drive it): meter shows real %, countdown ticks, click opens dashboard. Commit `feat: always-on session usage meter`.

---

### Task 9: Usage dashboard (`UsageDashboard.tsx`)

**Files:** Create `frontend/src/components/UsageDashboard.tsx` (+ css); trigger from the meter.

**REQUIRED: dataviz skill.** A modal/side panel titled with `planLabel` ("Max"). Sections mirroring claude.ai:
1. **Current session** — ring or bar, `fiveHour.utilization`%, "Resets in Xh Ym".
2. **Weekly limits** — "All models" bar (`sevenDay`), then one bar per `sevenDayByModel` entry (label the model name capitalized — "Fable", "Opus"), each with "Resets <weekday> <time>" from its `resetsAt`.
3. **Extra usage** — only if `extraUsage?.isEnabled`: used vs monthly limit.
Consistent color system with the meter (one shared utilization→color helper — DRY). Reset times formatted in local time. Close on backdrop/Esc. Empty/unavailable state explains how to fix (e.g. "run `claude` once to refresh auth").

- [ ] Build it. **Verify visually**: open from the meter, all sections render with real numbers, per-model bars present, reset times sensible, closes cleanly. Commit `feat: plan usage dashboard`.

---

## Self-Review Notes
- Spec coverage: session-always-visible ✅ (Task 8); openable dashboard with weekly all-models + per-model + resets ✅ (Task 9); "Max" label ✅ (Task 3); Fable per-model handled generically ✅ (Task 2). Visualized like claude.ai ✅ (Tasks 8–9, dataviz skill).
- Rate-limit safety is enforced in Task 4 and re-stated in Global Constraints — the single highest-risk area; the backoff/cache tests are mandatory, not optional.
- Type consistency: `PlanUsage`/`UsageWindow`/`UsageModelWindow` names identical across backend mapper, service, server, store, and both components. `utilization` is 0–100 everywhere.
- Cross-platform: Keychain path (macOS) vs `.credentials.json` (Linux/Windows) both handled in Task 3; `reason:'unsupported_platform'` reserved if neither works.
