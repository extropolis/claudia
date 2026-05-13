/**
 * AutonomousController - Drives multi-step autonomous development
 *
 * Accepts a high-level goal, generates a plan using Claude Opus,
 * spawns parallel tasks, evaluates results, runs tests (including Playwright),
 * and iterates until the goal is achieved or limits are reached.
 */

import { EventEmitter } from 'events';
import { TaskSpawner } from './task-spawner.js';
import { WorkspaceStore } from './workspace-store.js';
import { ConfigStore } from './config-store.js';
import { PORTS } from '@claudia/shared';
import type { Task } from '@claudia/shared';

const BACKEND_URL = process.env.CLAUDIA_BACKEND_URL || `http://localhost:${PORTS.BACKEND}`;
const PLANNING_MODEL = 'claude-opus-latest';
const EVALUATION_MODEL = 'claude-sonnet-4-6';
const MAX_PARALLEL_CODING_TASKS = 2;
const MAX_PARALLEL_TEST_TASKS = 1;
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_STEP_MAX_RETRIES = 2;
const TICK_INTERVAL_MS = 15000;

export type AutonomousState =
    | 'idle'
    | 'planning'
    | 'executing'
    | 'evaluating'
    | 'testing'
    | 'paused'
    | 'complete'
    | 'failed';

export interface PlanStep {
    id: string;
    description: string;
    taskPrompt: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
    dependsOn: string[];
    testRequired: boolean;
    testAssertions?: string;
    taskId?: string;
    retries: number;
    maxRetries: number;
    result?: string;
    phase: string;
}

export interface TestResult {
    type: 'build' | 'playwright' | 'dev_server' | 'unit_test';
    passed: boolean;
    details: string;
    stepId?: string;
    timestamp: string;
}

export interface AutonomousStatusPayload {
    state: AutonomousState;
    goalDescription: string;
    currentPhase: string;
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    currentStepDescription: string;
    activeTasks: Array<{ taskId: string; description: string; state: string }>;
    steps: Array<{ id: string; description: string; status: string; phase: string }>;
    iteration: number;
    maxIterations: number;
    recentTestResults: Array<{ type: string; passed: boolean; details: string }>;
    startedAt: string;
    elapsedMs: number;
}

interface AutonomousSession {
    id: string;
    goal: string;
    goalAdjustments: string[];
    workspaceId: string;
    plan: PlanStep[];
    state: AutonomousState;
    startedAt: string;
    completedAt?: string;
    iteration: number;
    maxIterations: number;
    consecutiveFailures: number;
    maxConsecutiveFailures: number;
    testResults: TestResult[];
    devServerTaskId?: string;
    devServerPort?: number;
}

export class AutonomousController extends EventEmitter {
    private taskSpawner: TaskSpawner;
    private workspaceStore: WorkspaceStore;
    private configStore: ConfigStore;
    private session: AutonomousSession | null = null;
    private tickTimer: NodeJS.Timeout | null = null;
    private tickInProgress = false;

    constructor(taskSpawner: TaskSpawner, workspaceStore: WorkspaceStore, configStore: ConfigStore) {
        super();
        this.taskSpawner = taskSpawner;
        this.workspaceStore = workspaceStore;
        this.configStore = configStore;
    }

    private async callLLM(model: string, systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
        const apiMode = this.configStore.getApiMode();
        let url: string;
        let headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
        };

        if (apiMode === 'hyperspace-proxy') {
            const proxy = this.configStore.getHyperspaceProxy();
            url = `${proxy.proxyUrl}/anthropic/v1/messages`;
            headers['Authorization'] = `Bearer ${proxy.apiKey}`;
        } else if (apiMode === 'custom-anthropic') {
            const apiKey = this.configStore.getCustomAnthropicApiKey();
            url = 'https://api.anthropic.com/v1/messages';
            headers['x-api-key'] = apiKey || '';
        } else {
            const apiKey = process.env.ANTHROPIC_API_KEY || '';
            url = 'https://api.anthropic.com/v1/messages';
            headers['x-api-key'] = apiKey;
        }

        console.log(`[Autonomous] callLLM model=${model} url=${url} apiMode=${apiMode}`);

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                system: systemPrompt,
                messages: [{ role: 'user', content: userMessage }],
                max_tokens: maxTokens,
            }),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`LLM API error ${response.status}: ${errText.substring(0, 200)}`);
        }

        const data = await response.json() as { content: Array<{ type: string; text?: string }> };
        const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');
        if (!textBlock || !('text' in textBlock)) throw new Error('No text in LLM response');
        return textBlock.text as string;
    }

    // ===== PUBLIC API =====

    async start(goal: string, workspacePath: string, maxIterations?: number): Promise<string> {
        if (this.session && this.session.state !== 'idle' && this.session.state !== 'complete' && this.session.state !== 'failed') {
            throw new Error('Autonomous session already active. Stop it first.');
        }

        // Ensure workspace exists
        try {
            const workspace = this.workspaceStore.getWorkspace(workspacePath);
            if (!workspace) {
                this.workspaceStore.addWorkspace(workspacePath);
            }
        } catch (e) {
            // Workspace may already exist — that's fine
            console.log(`[Autonomous] Workspace setup: ${e instanceof Error ? e.message : e}`);
        }

        this.session = {
            id: `auto-${Date.now()}`,
            goal,
            goalAdjustments: [],
            workspaceId: workspacePath,
            plan: [],
            state: 'planning',
            startedAt: new Date().toISOString(),
            iteration: 0,
            maxIterations: maxIterations || DEFAULT_MAX_ITERATIONS,
            consecutiveFailures: 0,
            maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
            testResults: [],
        };

        this.emitStateChange();
        this.announce(`Starting autonomous mode. Planning how to: ${goal}`);
        console.log(`[Autonomous] Starting session ${this.session.id} — goal: "${goal}" workspace: ${workspacePath}`);

        // Generate plan (async, then transition to executing)
        try {
            const plan = await this.generatePlan();
            this.session.plan = plan;
            this.session.state = 'executing';
            this.emitStateChange();
            this.announce(`Plan ready with ${plan.length} steps. Starting work.`);
            console.log(`[Autonomous] Plan generated: ${plan.length} steps`);
            this.startTickLoop();
        } catch (err) {
            console.error('[Autonomous] Planning failed:', err);
            this.session.state = 'failed';
            this.emitStateChange();
            this.announce('Failed to generate a development plan. Stopping.');
        }

        return this.session.id;
    }

    async stop(): Promise<void> {
        if (!this.session) return;
        console.log(`[Autonomous] Stopping session ${this.session.id}`);
        this.stopTickLoop();

        // Stop all tasks spawned by this session
        const activeSteps = this.session.plan.filter(s => s.status === 'in_progress' && s.taskId);
        for (const step of activeSteps) {
            try {
                await this.stopTask(step.taskId!);
                step.status = 'skipped';
            } catch (e) {
                console.error(`[Autonomous] Failed to stop task ${step.taskId}:`, e);
            }
        }

        // Stop dev server if running
        if (this.session.devServerTaskId) {
            try {
                await this.stopTask(this.session.devServerTaskId);
            } catch (e) { /* best effort */ }
        }

        this.session.state = 'idle';
        this.session.completedAt = new Date().toISOString();
        this.emitStateChange();
        this.announce('Autonomous mode stopped.');
    }

    async pause(): Promise<void> {
        if (!this.session || this.session.state === 'paused') return;
        console.log(`[Autonomous] Pausing session`);
        this.session.state = 'paused';
        this.stopTickLoop();
        this.emitStateChange();
        this.announce('Autonomous mode paused. Say resume to continue.');
    }

    async resume(): Promise<void> {
        if (!this.session || this.session.state !== 'paused') return;
        console.log(`[Autonomous] Resuming session`);
        this.session.state = 'executing';
        this.emitStateChange();
        this.startTickLoop();
        this.announce('Resuming autonomous mode.');
    }

    async adjustGoal(adjustment: string): Promise<void> {
        if (!this.session) throw new Error('No active autonomous session');
        console.log(`[Autonomous] Goal adjustment: "${adjustment}"`);
        this.session.goalAdjustments.push(adjustment);
        this.announce(`Got it. Adjusting the plan to: ${adjustment}`);

        // Revise plan with new context
        const wasPaused = this.session.state === 'paused';
        this.session.state = 'planning';
        this.emitStateChange();
        this.stopTickLoop();

        try {
            const revisedPlan = await this.generatePlan();
            // Keep completed steps, replace pending ones
            const completedSteps = this.session.plan.filter(s => s.status === 'completed');
            this.session.plan = [...completedSteps, ...revisedPlan];
            this.session.state = wasPaused ? 'paused' : 'executing';
            this.emitStateChange();
            if (!wasPaused) this.startTickLoop();
            this.announce(`Plan revised. ${revisedPlan.length} new steps added.`);
        } catch (err) {
            console.error('[Autonomous] Plan revision failed:', err);
            this.session.state = wasPaused ? 'paused' : 'executing';
            if (!wasPaused) this.startTickLoop();
            this.emitStateChange();
        }
    }

    getStatus(): AutonomousStatusPayload | null {
        if (!this.session) return null;

        const completedSteps = this.session.plan.filter(s => s.status === 'completed').length;
        const failedSteps = this.session.plan.filter(s => s.status === 'failed').length;
        const inProgressSteps = this.session.plan.filter(s => s.status === 'in_progress');
        const nextPending = this.session.plan.find(s => s.status === 'pending');
        const currentStep = inProgressSteps[0] || nextPending;

        // Build a context-aware description
        let currentStepDescription = '';
        if (this.session.state === 'testing') {
            const lastCompleted = this.session.plan.filter(s => s.status === 'completed').pop();
            currentStepDescription = `Testing: ${lastCompleted?.description || 'validating'}`;
        } else if (this.session.state === 'planning') {
            currentStepDescription = 'Generating development plan...';
        } else {
            currentStepDescription = currentStep?.description || '';
        }

        // Determine current phase
        let currentPhase = '';
        if (this.session.state === 'testing') {
            currentPhase = 'Testing';
        } else if (this.session.state === 'planning') {
            currentPhase = 'Planning';
        } else {
            currentPhase = currentStep?.phase || '';
        }

        return {
            state: this.session.state,
            goalDescription: this.session.goal,
            currentPhase,
            totalSteps: this.session.plan.length,
            completedSteps,
            failedSteps,
            currentStepDescription,
            activeTasks: inProgressSteps.map(s => ({
                taskId: s.taskId || '',
                description: s.description,
                state: 'busy',
            })),
            steps: this.session.plan.map(s => ({
                id: s.id,
                description: s.description,
                status: s.status,
                phase: s.phase,
            })),
            iteration: this.session.iteration,
            maxIterations: this.session.maxIterations,
            recentTestResults: this.session.testResults.slice(-5).map(r => ({
                type: r.type,
                passed: r.passed,
                details: r.details,
            })),
            startedAt: this.session.startedAt,
            elapsedMs: Date.now() - new Date(this.session.startedAt).getTime(),
        };
    }

    isActive(): boolean {
        return this.session !== null &&
            !['idle', 'complete', 'failed'].includes(this.session.state);
    }

    // ===== CORE LOOP =====

    private startTickLoop(): void {
        if (this.tickTimer) return;
        console.log(`[Autonomous] Starting tick loop (${TICK_INTERVAL_MS}ms)`);
        this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
        // Run first tick immediately
        this.tick();
    }

    private stopTickLoop(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
            console.log(`[Autonomous] Stopped tick loop`);
        }
    }

    private async tick(): Promise<void> {
        if (!this.session) return;
        if (this.tickInProgress) return;
        if (this.session.state === 'paused' || this.session.state === 'idle') return;

        this.tickInProgress = true;
        this.session.iteration++;

        try {
            // Check budget
            if (this.session.iteration > this.session.maxIterations) {
                console.log(`[Autonomous] Iteration limit reached (${this.session.maxIterations})`);
                this.session.state = 'failed';
                this.stopTickLoop();
                this.emitStateChange();
                this.announce('Reached the iteration limit. Stopping autonomous mode.');
                return;
            }

            if (this.session.state === 'executing' || this.session.state === 'evaluating' || this.session.state === 'testing') {
                await this.processLoop();
            }
        } catch (err) {
            console.error('[Autonomous] Tick error:', err);
        } finally {
            this.tickInProgress = false;
        }
    }

    private async processLoop(): Promise<void> {
        if (!this.session) return;

        // 1. Check if any in-progress tasks have completed
        const inProgressSteps = this.session.plan.filter(s => s.status === 'in_progress' && s.taskId);
        for (const step of inProgressSteps) {
            const taskState = await this.getTaskState(step.taskId!);
            if (taskState === 'idle' || taskState === 'exited') {
                // Task completed — evaluate
                console.log(`[Autonomous] Step "${step.description}" task ${step.taskId} completed (state: ${taskState})`);
                await this.evaluateStep(step);
            } else if (taskState === 'waiting_input') {
                // Auto-approve permissions
                await this.handleWaitingInput(step);
            }
            // busy/starting — still running, wait
        }

        // 2. Run tests for steps that need them
        const needsTesting = this.session.plan.find(s =>
            s.status === 'completed' && s.testRequired && !this.hasTestResult(s.id)
        );
        if (needsTesting) {
            this.session.state = 'testing';
            this.emitStateChange();
            await this.runTestsForStep(needsTesting);
            this.session.state = 'executing';
            this.emitStateChange();
            return; // Resume on next tick
        }

        // 3. Check if all steps done
        const allDone = this.session.plan.every(s =>
            s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
        );
        if (allDone && this.session.plan.length > 0) {
            const failedCount = this.session.plan.filter(s => s.status === 'failed').length;
            if (failedCount === 0) {
                this.session.state = 'complete';
                this.session.completedAt = new Date().toISOString();
                this.stopTickLoop();
                this.emitStateChange();
                this.announce(`Done! All ${this.session.plan.length} steps completed successfully.`);
            } else {
                this.session.state = 'complete';
                this.session.completedAt = new Date().toISOString();
                this.stopTickLoop();
                this.emitStateChange();
                this.announce(`Finished with ${failedCount} failed step(s) out of ${this.session.plan.length}.`);
            }
            return;
        }

        // 4. Spawn ready steps if slots available
        await this.executeReadySteps();
    }

    // ===== PLANNING =====

    private async generatePlan(): Promise<PlanStep[]> {
        if (!this.session) throw new Error('Cannot generate plan');

        const completedContext = this.session.plan
            .filter(s => s.status === 'completed')
            .map(s => `- ${s.description}: ${s.result || 'done'}`)
            .join('\n');

        const adjustments = this.session.goalAdjustments.length > 0
            ? `\nGoal adjustments:\n${this.session.goalAdjustments.map(a => `- ${a}`).join('\n')}`
            : '';

        const prompt = `Goal: ${this.session.goal}${adjustments}

Workspace: ${this.session.workspaceId}
${completedContext ? `\nAlready completed:\n${completedContext}` : ''}

Rules:
- Each step must be independently executable by a Claude Code agent in a terminal
- Steps CAN run in parallel if they have no dependencies on each other
- Include setup steps first (project init, install deps) before feature steps
- Mark steps that produce UI changes with testRequired=true and provide testAssertions describing what to verify
- Limit to 6-12 steps for a typical project
- Each taskPrompt must be detailed and self-contained (the agent has NO context beyond the prompt and the workspace files)
- The agent has Playwright MCP tools available for browser testing
- Group steps into phases (e.g., "Setup", "Core Features", "Testing", "Polish")
- Do NOT include steps for starting a dev server or running tests — those are handled automatically

Respond with ONLY valid JSON (no markdown code fences):
{
  "steps": [
    {
      "id": "step-1",
      "description": "Short description of what this step does",
      "taskPrompt": "Detailed prompt for the Claude Code agent...",
      "dependsOn": [],
      "testRequired": false,
      "testAssertions": null,
      "phase": "Setup"
    }
  ]
}`;

        const systemPrompt = 'You are a software development planner. Generate a step-by-step plan to achieve the given goal. Respond with ONLY valid JSON.';

        console.log('[Autonomous] Generating plan with', PLANNING_MODEL);
        const text = await this.callLLM(PLANNING_MODEL, systemPrompt, prompt);

        let parsed: { steps: Array<{ id: string; description: string; taskPrompt: string; dependsOn: string[]; testRequired: boolean; testAssertions?: string; phase: string }> };
        try {
            const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            parsed = JSON.parse(jsonStr);
        } catch (e) {
            console.error('[Autonomous] Failed to parse plan JSON:', text.substring(0, 500));
            throw new Error('Failed to parse plan from LLM response');
        }

        return parsed.steps.map(s => ({
            id: s.id,
            description: s.description,
            taskPrompt: s.taskPrompt,
            status: 'pending' as const,
            dependsOn: s.dependsOn || [],
            testRequired: s.testRequired || false,
            testAssertions: s.testAssertions || undefined,
            retries: 0,
            maxRetries: DEFAULT_STEP_MAX_RETRIES,
            phase: s.phase || 'Build',
        }));
    }

    // ===== EXECUTION =====

    private async executeReadySteps(): Promise<void> {
        if (!this.session) return;

        const readySteps = this.getReadySteps();
        if (readySteps.length === 0) return;

        const currentCodingTasks = this.session.plan.filter(s => s.status === 'in_progress').length;
        const slotsAvailable = MAX_PARALLEL_CODING_TASKS - currentCodingTasks;

        if (slotsAvailable <= 0) return;

        const toSpawn = readySteps.slice(0, slotsAvailable);
        for (const step of toSpawn) {
            await this.spawnStepTask(step);
        }
    }

    private getReadySteps(): PlanStep[] {
        if (!this.session) return [];
        return this.session.plan.filter(step => {
            if (step.status !== 'pending') return false;
            // All dependencies must be completed
            return step.dependsOn.every(depId =>
                this.session!.plan.some(s => s.id === depId && s.status === 'completed')
            );
        });
    }

    private async spawnStepTask(step: PlanStep): Promise<void> {
        if (!this.session) return;

        console.log(`[Autonomous] Spawning task for step "${step.description}"`);
        step.status = 'in_progress';
        this.emitStateChange();
        this.announce(`Working on: ${step.description}`);

        try {
            const task = await this.taskSpawner.createTask(
                step.taskPrompt,
                this.session.workspaceId
            );
            step.taskId = task.id;
            console.log(`[Autonomous] Task ${task.id} spawned for step ${step.id}`);
        } catch (err) {
            console.error(`[Autonomous] Failed to spawn task for step ${step.id}:`, err);
            step.status = 'failed';
            step.result = `Failed to spawn task: ${err}`;
            this.session.consecutiveFailures++;
            this.checkFailureLimit();
        }
    }

    // ===== EVALUATION =====

    private async evaluateStep(step: PlanStep): Promise<void> {
        if (!this.session || !step.taskId) return;

        const assessment = await this.assessTaskOutput(step.taskId);

        if (assessment.success) {
            step.status = 'completed';
            step.result = assessment.summary;
            this.session.consecutiveFailures = 0;
            console.log(`[Autonomous] Step "${step.description}" PASSED: ${assessment.summary}`);
            this.announce(`Completed: ${step.description}`);
        } else {
            step.retries++;
            if (step.retries <= step.maxRetries) {
                // Retry with error context
                console.log(`[Autonomous] Step "${step.description}" failed (retry ${step.retries}/${step.maxRetries}): ${assessment.summary}`);
                step.status = 'pending';
                step.taskPrompt = this.augmentPromptWithError(step.taskPrompt, assessment.summary);
                step.taskId = undefined;
                this.announce(`Retrying: ${step.description}. Error was: ${assessment.summary.substring(0, 60)}`);
            } else {
                step.status = 'failed';
                step.result = assessment.summary;
                this.session.consecutiveFailures++;
                console.log(`[Autonomous] Step "${step.description}" FAILED permanently: ${assessment.summary}`);
                this.announce(`Step failed after retries: ${step.description}`);
                this.checkFailureLimit();
            }
        }
        this.emitStateChange();
    }

    private async assessTaskOutput(taskId: string): Promise<{ success: boolean; summary: string }> {
        try {
            const response = await fetch(`${BACKEND_URL}/api/tasks/${taskId}/output?maxBytes=16384`);
            if (!response.ok) {
                return { success: false, summary: 'Could not retrieve task output' };
            }
            const data = await response.json();
            const output = (data.output || '') as string;

            // Quick heuristic checks
            const errorPatterns = [
                /error:/i,
                /Error:/,
                /FAIL/,
                /Cannot find module/,
                /ENOENT/,
                /Traceback/,
                /panic:/,
                /fatal:/i,
                /SyntaxError/,
                /TypeError/,
                /ReferenceError/,
            ];

            const hasError = errorPatterns.some(p => p.test(output.slice(-4000)));

            // Use LLM for nuanced assessment if we have significant output
            if (output.length > 100) {
                try {
                    const systemPrompt = 'You assess whether coding tasks completed successfully. Respond with ONLY valid JSON.';
                    const userMsg = `Assess whether this Claude Code task completed successfully. Output (last 4000 chars):\n\n${output.slice(-4000)}\n\nRespond with ONLY JSON: {"success": true/false, "summary": "one sentence explanation"}`;
                    const text = await this.callLLM(EVALUATION_MODEL, systemPrompt, userMsg, 200);
                    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                    return JSON.parse(jsonStr);
                } catch {
                    // Fall through to heuristic
                }
            }

            if (hasError) {
                const errorLine = output.split('\n').find(l => errorPatterns.some(p => p.test(l))) || '';
                return { success: false, summary: errorLine.substring(0, 200) || 'Task output contains errors' };
            }
            return { success: true, summary: 'Task completed without detected errors' };
        } catch (err) {
            return { success: false, summary: `Assessment error: ${err}` };
        }
    }

    private augmentPromptWithError(originalPrompt: string, errorSummary: string): string {
        return `${originalPrompt}\n\nIMPORTANT: A previous attempt failed with this error:\n${errorSummary}\n\nPlease fix the issue and complete the task successfully. Check for existing files/dependencies before creating new ones.`;
    }

    // ===== TESTING =====

    private async runTestsForStep(step: PlanStep): Promise<void> {
        if (!this.session) return;

        console.log(`[Autonomous] Running tests for step "${step.description}"`);
        this.announce(`Running tests for: ${step.description}`);

        // 1. Build check
        const buildResult = await this.spawnTestTask(
            `Run a build check in this project. Try "npm run build" or "npx tsc --noEmit" (whichever is available). Report ONLY whether it succeeded or failed. Include error output if it failed. Do NOT attempt to fix errors. At the end, output exactly "RESULT: PASS" or "RESULT: FAIL".`,
            'build'
        );
        this.session.testResults.push({ ...buildResult, stepId: step.id, timestamp: new Date().toISOString() });

        if (!buildResult.passed) {
            this.announce(`Build check failed for ${step.description}. Will retry the step.`);
            // Revert step to pending for retry
            step.retries++;
            if (step.retries <= step.maxRetries) {
                step.status = 'pending';
                step.taskPrompt = this.augmentPromptWithError(step.taskPrompt, `Build failed: ${buildResult.details}`);
                step.taskId = undefined;
            } else {
                step.status = 'failed';
                step.result = `Build failed: ${buildResult.details}`;
                this.session.consecutiveFailures++;
                this.checkFailureLimit();
            }
            this.emitStateChange();
            return;
        }

        // 2. Playwright test (if step has test assertions)
        if (step.testAssertions) {
            // Ensure dev server is running
            await this.ensureDevServer();

            if (this.session.devServerPort) {
                const playwrightResult = await this.spawnTestTask(
                    `You are a frontend QA tester. Use the Playwright MCP tools (browser_navigate, browser_snapshot, browser_click, browser_type, etc.) to test the application at http://localhost:${this.session.devServerPort}.

Test plan:
1. Navigate to http://localhost:${this.session.devServerPort}
2. Take a snapshot of the page
3. Verify: ${step.testAssertions}
4. If interactive elements are present, test basic interactions

At the end output exactly "RESULT: PASS" if all checks pass, or "RESULT: FAIL" with specific details about what failed.`,
                    'playwright'
                );
                this.session.testResults.push({ ...playwrightResult, stepId: step.id, timestamp: new Date().toISOString() });

                if (!playwrightResult.passed) {
                    this.announce(`Playwright test failed: ${playwrightResult.details.substring(0, 80)}`);
                    step.retries++;
                    if (step.retries <= step.maxRetries) {
                        step.status = 'pending';
                        step.taskPrompt = this.augmentPromptWithError(step.taskPrompt, `Playwright test failed: ${playwrightResult.details}`);
                        step.taskId = undefined;
                    } else {
                        step.status = 'failed';
                        step.result = `Playwright test failed: ${playwrightResult.details}`;
                        this.session.consecutiveFailures++;
                        this.checkFailureLimit();
                    }
                    this.emitStateChange();
                    return;
                }
                this.announce(`Tests passed for: ${step.description}`);
            }
        }
    }

    private async spawnTestTask(prompt: string, type: TestResult['type']): Promise<Omit<TestResult, 'stepId' | 'timestamp'>> {
        if (!this.session) return { type, passed: false, details: 'No session' };

        try {
            const task = await this.taskSpawner.createTask(prompt, this.session.workspaceId);
            console.log(`[Autonomous] Test task ${task.id} spawned (type: ${type})`);

            // Wait for task to complete (poll every 5s, max 120s)
            const result = await this.waitForTaskCompletion(task.id, 120000);
            if (!result) {
                return { type, passed: false, details: 'Test task timed out' };
            }

            // Read output and check result
            const response = await fetch(`${BACKEND_URL}/api/tasks/${task.id}/output?maxBytes=8192`);
            if (!response.ok) return { type, passed: false, details: 'Could not read test output' };
            const data = await response.json();
            const output = (data.output || '') as string;

            const passed = output.includes('RESULT: PASS');
            const failDetails = output.includes('RESULT: FAIL')
                ? output.split('RESULT: FAIL')[1]?.trim().substring(0, 300) || 'Test failed'
                : passed ? '' : 'No explicit PASS/FAIL result found';

            return { type, passed, details: passed ? 'All checks passed' : failDetails };
        } catch (err) {
            return { type, passed: false, details: `Test spawn error: ${err}` };
        }
    }

    private async ensureDevServer(): Promise<void> {
        if (!this.session) return;
        if (this.session.devServerTaskId) {
            // Check if still running
            const state = await this.getTaskState(this.session.devServerTaskId);
            if (state === 'busy' || state === 'starting') return;
        }

        // Spawn dev server task
        console.log(`[Autonomous] Starting dev server...`);
        try {
            const task = await this.taskSpawner.createTask(
                `Start the development server for this project. Try "npm run dev" or "npm start" (whichever is configured in package.json). Wait for it to be ready and report which port it's running on. Keep the server running. Output "DEV_SERVER_PORT: <number>" once it's up.`,
                this.session.workspaceId
            );
            this.session.devServerTaskId = task.id;

            // Wait a bit for it to start
            await this.waitForTaskOutput(task.id, 'DEV_SERVER_PORT:', 30000);

            // Parse port from output
            const response = await fetch(`${BACKEND_URL}/api/tasks/${task.id}/output?maxBytes=4096`);
            if (response.ok) {
                const data = await response.json();
                const output = (data.output || '') as string;
                const portMatch = output.match(/DEV_SERVER_PORT:\s*(\d+)/);
                if (portMatch) {
                    this.session.devServerPort = parseInt(portMatch[1], 10);
                    console.log(`[Autonomous] Dev server running on port ${this.session.devServerPort}`);
                } else {
                    // Default to 5173 for Vite or 3000 for other frameworks
                    this.session.devServerPort = 3000;
                    console.log(`[Autonomous] Dev server port not detected, assuming ${this.session.devServerPort}`);
                }
            }
        } catch (err) {
            console.error('[Autonomous] Failed to start dev server:', err);
        }
    }

    // ===== HELPERS =====

    private async waitForTaskCompletion(taskId: string, timeoutMs: number): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const state = await this.getTaskState(taskId);
            if (state === 'idle' || state === 'exited') return true;
            if (state === 'waiting_input') {
                // Auto-approve for test tasks
                await this.autoApproveInput(taskId);
            }
            await this.sleep(5000);
        }
        // Timeout — stop the task
        try { await this.stopTask(taskId); } catch { /* best effort */ }
        return false;
    }

    private async waitForTaskOutput(taskId: string, marker: string, timeoutMs: number): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const response = await fetch(`${BACKEND_URL}/api/tasks/${taskId}/output?maxBytes=4096`);
                if (response.ok) {
                    const data = await response.json();
                    if ((data.output || '').includes(marker)) return true;
                }
            } catch { /* continue polling */ }
            await this.sleep(3000);
        }
        return false;
    }

    private async getTaskState(taskId: string): Promise<string> {
        try {
            const response = await fetch(`${BACKEND_URL}/api/tasks`);
            if (!response.ok) return 'unknown';
            const tasks = await response.json();
            const task = tasks.find((t: any) => t.id === taskId);
            return task?.state || 'exited';
        } catch {
            return 'unknown';
        }
    }

    private async handleWaitingInput(step: PlanStep): Promise<void> {
        if (!step.taskId) return;
        await this.autoApproveInput(step.taskId);
    }

    private async autoApproveInput(taskId: string): Promise<void> {
        try {
            // Send "yes" or "y" to approve permissions
            const WebSocket = (await import('ws')).default;
            const wsUrl = BACKEND_URL.replace('http://', 'ws://').replace('https://', 'wss://');
            const ws = new WebSocket(wsUrl);

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => { ws.close(); resolve(); }, 5000);
                ws.on('open', () => {
                    ws.send(JSON.stringify({ type: 'task:input', payload: { taskId, input: 'y\r' } }));
                    clearTimeout(timeout);
                    setTimeout(() => { ws.close(); resolve(); }, 500);
                });
                ws.on('error', () => { clearTimeout(timeout); resolve(); });
            });
        } catch (err) {
            console.error(`[Autonomous] Failed to auto-approve input for ${taskId}:`, err);
        }
    }

    private async stopTask(taskId: string): Promise<void> {
        const WebSocket = (await import('ws')).default;
        const wsUrl = BACKEND_URL.replace('http://', 'ws://').replace('https://', 'wss://');
        const ws = new WebSocket(wsUrl);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { ws.close(); resolve(); }, 5000);
            ws.on('open', () => {
                ws.send(JSON.stringify({ type: 'task:stop', payload: { taskId } }));
                clearTimeout(timeout);
                setTimeout(() => { ws.close(); resolve(); }, 1000);
            });
            ws.on('error', () => { clearTimeout(timeout); resolve(); });
        });
    }

    private hasTestResult(stepId: string): boolean {
        if (!this.session) return false;
        return this.session.testResults.some(r => r.stepId === stepId);
    }

    private checkFailureLimit(): void {
        if (!this.session) return;
        if (this.session.consecutiveFailures >= this.session.maxConsecutiveFailures) {
            console.log(`[Autonomous] Max consecutive failures reached (${this.session.maxConsecutiveFailures})`);
            this.session.state = 'failed';
            this.stopTickLoop();
            this.emitStateChange();
            this.announce('Too many consecutive failures. Stopping autonomous mode.');
        }
    }

    private announce(message: string): void {
        console.log(`[Autonomous] Announce: ${message}`);
        this.emit('autonomous:announce', message);
    }

    private emitStateChange(): void {
        this.emit('autonomous:stateChanged', this.getStatus());
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
