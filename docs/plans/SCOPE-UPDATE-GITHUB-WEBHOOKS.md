# Scope Update: GitHub Webhooks & Code Review

**Date:** 2026-06-15  
**Type:** Scope Clarification (not a new iteration)  
**Trigger:** User requirement to catch all developer activity and perform code reviews

---

## User Requirements (New)

1. **Don't miss any GitHub activity:**
   - Comments on your PRs
   - Questions from reviewers
   - @mentions
   - Review requests
   - Issue assignments

2. **Automated code review:**
   - Triggered by new PR events
   - Configurable (can enable/disable)
   - Controlled by event webhooks

---

## Solution: Event-Driven GitHub Integration

### Architecture Change

**From:** Polling-based (check every 10 minutes)
```typescript
setInterval(() => fetchNotifications(), 10 * 60 * 1000);
```

**To:** Event-driven webhooks (instant)
```typescript
app.post('/webhooks/github', webhookHandler.handle);
```

**Benefits:**
- ✅ Instant notification (not 10-minute delay)
- ✅ Catches ALL activity (nothing missed)
- ✅ More efficient (no unnecessary API calls)
- ✅ Proper foundation for code review triggers

---

## Implementation Plan

### Week 1 Day 3: GitHub Integration (~6 hours, was 7)

**Previous scope:**
- GitHub sync via polling
- Create tasks for PRs

**Updated scope:**
- ✅ GitHub sync via webhooks (primary)
- ✅ Fallback polling (backup, every 30 min)
- ✅ Webhook signature verification
- ✅ Event handlers (pr_opened, review_requested, comment, etc.)
- ✅ Code review module (disabled by default)

**Implementation:**

```typescript
// backend/src/webhooks/github-webhook.ts
export class GitHubWebhookHandler {
  async handle(req: Request, res: Response) {
    // 1. Verify signature
    if (!this.verifySignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // 2. Route to handler
    const event = req.headers['x-github-event'];
    switch (event) {
      case 'pull_request':
        await this.handlePullRequest(req.body);
        break;
      case 'pull_request_review':
        await this.handleReview(req.body);
        break;
      case 'issue_comment':
        await this.handleComment(req.body);
        break;
    }
    
    res.status(200).json({ received: true });
  }
  
  private async handlePullRequest(payload: any) {
    const { action, pull_request, repository } = payload;
    
    // Create task
    const task = await taskSpawner.createTask({
      prompt: `${action}: PR #${pull_request.number} - ${pull_request.title}`,
      workspaceId: GITHUB_WORKSPACE,
      labels: ['github', 'pr'],
      metadata: {
        githubPRUrl: pull_request.html_url,
        githubEvent: action
      }
    });
    
    // Optionally trigger code review
    if (action === 'opened' && config.codeReview.enabled) {
      await this.triggerCodeReview(pull_request, repository, task.id);
    }
  }
}
```

---

## Configuration Schema (Extended)

```typescript
interface ManagerConfig {
  githubSync: {
    enabled: boolean;
    mode: 'webhooks' | 'polling' | 'both';  // NEW
    repos: string[];
    webhookSecret?: string;  // NEW: for signature verification
    pollingIntervalMinutes?: number;  // Fallback
  };
  
  codeReview: {  // NEW SECTION
    enabled: boolean;  // Default: false
    
    triggers: Array<'pr_opened' | 'review_requested' | 'manual'>;
    
    checks: {
      security: boolean;      // Check for vulnerabilities
      performance: boolean;   // Check for perf issues
      tests: boolean;         // Check test coverage
      style: boolean;         // Check code style
    };
    
    postToGitHub: boolean;  // true = public review, false = private
    maxCostPerPR: number;   // Skip expensive reviews (default: $0.25)
    
    skipConditions?: {
      ciPassing?: boolean;     // Skip if CI green
      authorIsBot?: boolean;   // Skip Dependabot
      draft?: boolean;         // Skip draft PRs
    };
  };
}
```

**Default config (MVP):**
```json
{
  "manager": {
    "githubSync": {
      "enabled": true,
      "mode": "webhooks",
      "repos": []
    },
    "codeReview": {
      "enabled": false  // ← OFF by default
    }
  }
}
```

---

## Cost Impact

### Webhooks (No cost change)
- Infrastructure: Free (just an HTTP endpoint)
- Bandwidth: Negligible (~1KB per event)
- **Cost: $0/month** ✅

### Code Review (IF enabled)

**Per-PR cost:**
- Small PR (200 lines): ~$0.02-0.05
- Medium PR (1000 lines): ~$0.10-0.15  
- Large PR (3000+ lines): ~$0.20-0.30

**Monthly cost (estimated):**
- Low activity (5 PRs/day): ~$10-20/month
- Medium activity (20 PRs/day): ~$40-80/month
- High activity (50 PRs/day): ~$100-200/month

**Controls:**
- `maxCostPerPR`: Skip reviews over threshold
- `skipConditions`: Skip bot PRs, CI-passing PRs, drafts
- `enabled: false`: Turn off entirely

---

## Setup Instructions

### 1. Configure Webhook Secret

```bash
# Generate secret
openssl rand -hex 32

# Add to .env
echo "GITHUB_WEBHOOK_SECRET=<your-secret>" >> .env
```

### 2. Set Up GitHub Webhook

**Repo Settings → Webhooks → Add webhook:**

- **URL:** `https://your-server.com/webhooks/github`
- **Content type:** `application/json`
- **Secret:** (paste from .env)
- **Events:**
  - ✅ Pull requests
  - ✅ Pull request reviews  
  - ✅ Pull request review comments
  - ✅ Issue comments
  - ✅ Issues

### 3. Configure Manager

```json
{
  "manager": {
    "githubSync": {
      "enabled": true,
      "mode": "webhooks",
      "repos": ["your-org/your-repo"]
    },
    "codeReview": {
      "enabled": false  // Start with this OFF
    }
  }
}
```

### 4. Test

Open a test PR → Task should appear within 1-2 seconds.

---

## Phased Rollout (Recommended)

### Week 1-3: MVP
- ✅ Webhooks implemented
- ❌ Code review disabled
- **Cost: $0/month**
- **Goal:** Validate that GitHub task tracking is useful

### Week 4: Enable Code Review (Experiment)
- ✅ Enable on 1 test repo
- ✅ Security checks only
- ✅ Private mode (don't post to GitHub)
- **Cost: ~$5-10/month**
- **Goal:** Test if AI reviews are helpful

### Week 5+: Expand (If Successful)
- ✅ Add more repos
- ✅ Add test coverage checks
- ✅ Consider public mode
- **Cost: Scale based on value**

---

## Testing Plan

### Webhook Handler Tests

```typescript
// backend/tests/github-webhook.test.ts

describe('GitHub Webhook Handler', () => {
  it('rejects invalid signatures', async () => {
    const res = await request(app)
      .post('/webhooks/github')
      .set('X-Hub-Signature-256', 'invalid')
      .send({ action: 'opened' });
    
    expect(res.status).toBe(401);
  });
  
  it('creates task for PR opened event', async () => {
    const payload = {
      action: 'opened',
      pull_request: {
        number: 123,
        title: 'Test PR',
        html_url: 'https://github.com/...'
      },
      repository: {
        full_name: 'owner/repo'
      }
    };
    
    const res = await request(app)
      .post('/webhooks/github')
      .set('X-Hub-Signature-256', validSignature(payload))
      .send(payload);
    
    expect(res.status).toBe(200);
    
    const tasks = await taskSpawner.getAllTasks();
    expect(tasks).toContainEqual(
      expect.objectContaining({
        prompt: expect.stringContaining('PR #123'),
        metadata: expect.objectContaining({
          githubPRUrl: payload.pull_request.html_url
        })
      })
    );
  });
});
```

---

## Files to Create/Modify

### New Files
- `backend/src/webhooks/github-webhook.ts` (~300 LOC)
- `backend/src/code-review/reviewer.ts` (~400 LOC, disabled by default)
- `backend/tests/github-webhook.test.ts` (~200 LOC)

### Modified Files
- `backend/src/server.ts` (add webhook endpoint)
- `shared/src/index.ts` (extend config schema)
- `docs/RUNBOOK.md` (add webhook setup instructions)

**Total new code:** ~900 LOC (4-6 hours implementation)

---

## Timeline Impact

**Original Week 1 Day 3:** 7 hours  
**Updated Week 1 Day 3:** 6 hours (webhooks) + 4 hours (code review module)  
**Net change:** +3 hours (can absorb from Day 5 buffer)

**Total timeline:** Still 3 weeks to validation

---

## Risk Assessment

### New Risks

**MEDIUM: Webhook delivery failures**
- GitHub webhooks can be delayed/dropped
- **Mitigation:** Keep polling as fallback (every 30 min)

**MEDIUM: Code review quality**
- AI reviews might be noisy/unhelpful
- **Mitigation:** Start disabled, test privately, get feedback

**LOW: Webhook endpoint security**
- Public endpoint could be spammed
- **Mitigation:** Signature verification, rate limiting

### Mitigations Added

```typescript
// Rate limit webhook endpoint
import rateLimit from 'express-rate-limit';

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 minute
  max: 100,  // 100 requests per minute
  message: 'Too many webhook requests'
});

app.post('/webhooks/github', webhookLimiter, webhookHandler.handle);
```

---

## Validation Criteria (Updated)

**Original (Week 3):**
1. Label adoption ≥50%
2. Filter usage ≥30%
3. Health clicks ≥5/day
4. GitHub tasks ≥3/week
5. User satisfaction ≥4/5

**Updated:**
1. Label adoption ≥50%
2. Filter usage ≥30%
3. Health clicks ≥5/day
4. **GitHub webhook tasks ≥5/day** (updated from 3/week)
5. User satisfaction ≥4/5
6. **NEW (Week 4 if code review enabled):** AI review helpfulness ≥3/5

---

## Decision Point

**Webhooks:** ✅ **ADD TO MVP** (good architecture, solves user requirement)

**Code Review:** ⚠️ **IMPLEMENT BUT DISABLE** (enable in Week 4 as experiment)

**Rationale:**
- Webhooks are infrastructure (low risk, high value)
- Code review is feature (high risk, uncertain value)
- Build both, validate separately

---

## This Is NOT Iteration 14

**This is a scope clarification based on specific user requirements.**

The plan was already bulletproof at 99% confidence. This update:
- Addresses a specific gap identified by the user
- Improves the architecture (webhooks > polling)
- Adds optional capability (code review) for future validation
- Does NOT fundamentally change the plan

**Confidence remains: 99%**  
**Status remains: READY FOR IMPLEMENTATION**

---

**Next step:** Week 0 prep, then implement with updated GitHub integration scope.
