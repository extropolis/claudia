#!/usr/bin/env node
/**
 * Integration tests for the Orchestrator
 * Tests end-to-end workflows including task creation, execution, and completion
 */

import { createTestConnection, MessageCollector, cleanup, sleep } from '../../src/test-utils.js';
import { Task } from '../../src/types.js';

interface TestCase {
    name: string;
    message: string;
    validate: (collector: MessageCollector) => Promise<void>;
    timeoutMs?: number;
}

const TEST_CASES: TestCase[] = [
    {
        name: 'Simple Echo Command',
        message: 'echo "Hello from test"',
        validate: async (collector) => {
            await sleep(5000);
            const assistantMessages = collector.getAssistantMessages();
            if (assistantMessages.length === 0) {
                throw new Error('No assistant messages received');
            }
        },
        timeoutMs: 15000
    },
    {
        name: 'Structured Output - News Retrieval',
        message: 'Use playwright to get the top 3 news headlines from Hacker News',
        validate: async (collector) => {
            await collector.waitForTaskComplete(60000);
            const assistantMessages = collector.getAssistantMessages();

            if (assistantMessages.length === 0) {
                throw new Error('No assistant messages received');
            }

            const lastMessage = assistantMessages[assistantMessages.length - 1];

            // Check if response has real content
            if (lastMessage.content.length < 50) {
                throw new Error('Response too short - likely just "task complete"');
            }

            // Check if it's not just a generic completion message
            if (lastMessage.content.match(/^[✅❌⚠️]?\s*(Task|Worker).*complete/i)) {
                throw new Error('Response is just "task complete" without data');
            }

            console.log(`✅ Response has real content: ${lastMessage.content.substring(0, 100)}...`);
        },
        timeoutMs: 90000
    },
    {
        name: 'File Creation',
        message: 'Create a file called test-output.txt with content "Hello World"',
        validate: async (collector) => {
            await collector.waitForTaskComplete(30000);
            const tasks = Array.from(collector.getTasks().values());

            if (tasks.length === 0) {
                throw new Error('No tasks created');
            }

            const completedTask = tasks.find(t => t.status === 'complete');
            if (!completedTask) {
                throw new Error('No completed tasks found');
            }

            console.log(`✅ Task completed: ${completedTask.name}`);
        },
        timeoutMs: 45000
    },
    {
        name: 'Multiple Tasks',
        message: 'First echo "task1", then echo "task2"',
        validate: async (collector) => {
            await sleep(15000);
            const tasks = Array.from(collector.getTasks().values());

            if (tasks.length < 1) {
                throw new Error('Expected at least 1 task');
            }

            console.log(`✅ Created ${tasks.length} task(s)`);
        },
        timeoutMs: 30000
    },
    {
        name: 'Task with Error Handling',
        message: 'Run a command that will fail: ls /nonexistent/directory',
        validate: async (collector) => {
            await collector.waitForTaskComplete(20000);
            const tasks = Array.from(collector.getTasks().values());

            if (tasks.length === 0) {
                throw new Error('No tasks created');
            }

            const task = tasks[0];
            if (task.status !== 'error' && task.status !== 'complete') {
                throw new Error('Task should have completed or errored');
            }

            console.log(`✅ Task handled error appropriately: status=${task.status}`);
        },
        timeoutMs: 30000
    }
];

/**
 * Run a single test case
 */
async function runTest(testCase: TestCase): Promise<{ passed: boolean; error?: string; duration: number }> {
    const startTime = Date.now();
    let ws;

    try {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🧪 Running: ${testCase.name}`);
        console.log(`${'='.repeat(80)}`);
        console.log(`📝 Message: ${testCase.message}`);
        console.log('');

        // Connect to backend
        ws = await createTestConnection();
        console.log('✅ Connected to backend');

        // Set up message collector
        const collector = new MessageCollector(ws);

        // Wait for init
        await sleep(1000);

        // Send message
        const msg = {
            type: 'chat:send',
            payload: { content: testCase.message }
        };
        ws.send(JSON.stringify(msg));
        console.log('📤 Message sent');

        // Run validation
        await testCase.validate(collector);

        const duration = Date.now() - startTime;
        console.log('');
        console.log(`✅ TEST PASSED in ${(duration / 1000).toFixed(1)}s`);

        return { passed: true, duration };

    } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        console.log('');
        console.log(`❌ TEST FAILED in ${(duration / 1000).toFixed(1)}s`);
        console.log(`   Error: ${errorMessage}`);

        return { passed: false, error: errorMessage, duration };

    } finally {
        if (ws) {
            cleanup(ws);
        }
    }
}

/**
 * Run all integration tests
 */
async function runAllTests() {
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                    ORCHESTRATOR INTEGRATION TESTS                             ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');

    const results = [];

    for (const testCase of TEST_CASES) {
        const result = await runTest(testCase);
        results.push({ name: testCase.name, ...result });

        // Wait between tests
        await sleep(2000);
    }

    // Print summary
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                              TEST SUMMARY                                     ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');
    console.log('');

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    console.log(`📊 Results: ${passed} passed, ${failed} failed (${results.length} total)`);
    console.log(`⏱️  Total duration: ${(totalDuration / 1000).toFixed(1)}s`);
    console.log('');

    console.log('Test Results:');
    console.log('-'.repeat(80));

    results.forEach((result, i) => {
        const status = result.passed ? '✅ PASS' : '❌ FAIL';
        const duration = (result.duration / 1000).toFixed(1);
        console.log(`  ${i + 1}. ${status} ${result.name} (${duration}s)`);
        if (result.error) {
            console.log(`     Error: ${result.error}`);
        }
    });

    console.log('');

    // Exit with appropriate code
    process.exit(failed > 0 ? 1 : 0);
}

// Run tests
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests().catch(error => {
        console.error('Test execution failed:', error);
        process.exit(1);
    });
}
