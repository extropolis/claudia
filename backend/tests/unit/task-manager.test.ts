#!/usr/bin/env node
/**
 * Unit tests for TaskManager
 */

import { TaskManager } from '../../src/task-manager.js';
import { Task, TaskStatus } from '../../src/types.js';

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

/**
 * Test task creation
 */
function testTaskCreation(): TestResult {
    try {
        const manager = new TaskManager();
        const task = manager.createTask('Test Task', 'Test description');

        if (!task.id) throw new Error('Task ID not set');
        if (task.name !== 'Test Task') throw new Error('Task name incorrect');
        if (task.status !== 'pending') throw new Error('Initial status should be pending');
        if (!task.createdAt) throw new Error('Creation time not set');

        return { name: 'Task Creation', passed: true };
    } catch (error) {
        return {
            name: 'Task Creation',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Test task status updates
 */
function testStatusUpdates(): TestResult {
    try {
        const manager = new TaskManager();
        const task = manager.createTask('Test Task', 'Test description');

        // Update to running
        manager.updateStatus(task.id, 'running');
        let updated = manager.getTask(task.id);
        if (!updated || updated.status !== 'running') {
            throw new Error('Status not updated to running');
        }
        if (!updated.startedAt) {
            throw new Error('Start time not set');
        }

        // Update to complete
        manager.updateStatus(task.id, 'complete');
        updated = manager.getTask(task.id);
        if (!updated || updated.status !== 'complete') {
            throw new Error('Status not updated to complete');
        }
        if (!updated.completedAt) {
            throw new Error('Completion time not set');
        }

        return { name: 'Status Updates', passed: true };
    } catch (error) {
        return {
            name: 'Status Updates',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Test task output appending
 */
function testOutputAppending(): TestResult {
    try {
        const manager = new TaskManager();
        const task = manager.createTask('Test Task', 'Test description');

        manager.appendOutput(task.id, 'Line 1');
        manager.appendOutput(task.id, 'Line 2');
        manager.appendOutput(task.id, 'Line 3');

        const updated = manager.getTask(task.id);
        if (!updated) throw new Error('Task not found');
        if (updated.output.length !== 3) {
            throw new Error(`Expected 3 output lines, got ${updated.output.length}`);
        }
        if (updated.output[0] !== 'Line 1') {
            throw new Error('First output line incorrect');
        }

        return { name: 'Output Appending', passed: true };
    } catch (error) {
        return {
            name: 'Output Appending',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Test task completion with exit code
 */
function testTaskCompletion(): TestResult {
    try {
        const manager = new TaskManager();
        const task = manager.createTask('Test Task', 'Test description');

        // Complete with success
        manager.completeTask(task.id, 0);
        let updated = manager.getTask(task.id);
        if (!updated) throw new Error('Task not found');
        if (updated.status !== 'complete') {
            throw new Error('Status should be complete for exit code 0');
        }
        if (updated.exitCode !== 0) {
            throw new Error('Exit code not set');
        }

        // Create another task and complete with error
        const task2 = manager.createTask('Test Task 2', 'Test description');
        manager.completeTask(task2.id, 1);
        updated = manager.getTask(task2.id);
        if (!updated) throw new Error('Task 2 not found');
        if (updated.status !== 'error') {
            throw new Error('Status should be error for non-zero exit code');
        }

        return { name: 'Task Completion', passed: true };
    } catch (error) {
        return {
            name: 'Task Completion',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Test task hierarchy (parent-child)
 */
function testTaskHierarchy(): TestResult {
    try {
        const manager = new TaskManager();
        const parentTask = manager.createTask('Parent Task', 'Parent description');
        const childTask = manager.createTask('Child Task', 'Child description', parentTask.id);

        if (childTask.parentId !== parentTask.id) {
            throw new Error('Child task parent ID not set correctly');
        }

        const children = manager.getChildTasks(parentTask.id);
        if (children.length !== 1) {
            throw new Error(`Expected 1 child task, got ${children.length}`);
        }
        if (children[0].id !== childTask.id) {
            throw new Error('Child task not found in parent\'s children');
        }

        return { name: 'Task Hierarchy', passed: true };
    } catch (error) {
        return {
            name: 'Task Hierarchy',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Test task listing and filtering
 */
function testTaskListing(): TestResult {
    try {
        const manager = new TaskManager();

        // Create multiple tasks
        const task1 = manager.createTask('Task 1', 'Description 1');
        const task2 = manager.createTask('Task 2', 'Description 2');
        const task3 = manager.createTask('Task 3', 'Description 3');

        manager.updateStatus(task1.id, 'complete');
        manager.updateStatus(task2.id, 'running');

        const allTasks = manager.getAllTasks();
        if (allTasks.length !== 3) {
            throw new Error(`Expected 3 tasks, got ${allTasks.length}`);
        }

        // Filter manually since no getTasksByStatus method
        const runningTasks = allTasks.filter(t => t.status === 'running');
        if (runningTasks.length !== 1) {
            throw new Error(`Expected 1 running task, got ${runningTasks.length}`);
        }

        const completeTasks = allTasks.filter(t => t.status === 'complete');
        if (completeTasks.length !== 1) {
            throw new Error(`Expected 1 complete task, got ${completeTasks.length}`);
        }

        return { name: 'Task Listing', passed: true };
    } catch (error) {
        return {
            name: 'Task Listing',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Test task deletion
 */
function testTaskDeletion(): TestResult {
    try {
        const manager = new TaskManager();
        const task = manager.createTask('Test Task', 'Test description');

        const taskId = task.id;
        manager.deleteTask(taskId);

        const deleted = manager.getTask(taskId);
        if (deleted !== undefined) {
            throw new Error('Task should be deleted');
        }

        const allTasks = manager.getAllTasks();
        if (allTasks.length !== 0) {
            throw new Error('Task list should be empty after deletion');
        }

        return { name: 'Task Deletion', passed: true };
    } catch (error) {
        return {
            name: 'Task Deletion',
            passed: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Run all tests
 */
function runAllTests() {
    console.log('\n╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                         TASK MANAGER UNIT TESTS                               ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

    const tests = [
        testTaskCreation,
        testStatusUpdates,
        testOutputAppending,
        testTaskCompletion,
        testTaskHierarchy,
        testTaskListing,
        testTaskDeletion
    ];

    const results: TestResult[] = tests.map(test => test());

    console.log('Test Results:');
    console.log('-'.repeat(80));

    let passed = 0;
    let failed = 0;

    results.forEach((result, i) => {
        if (result.passed) {
            console.log(`✅ PASS: ${result.name}`);
            passed++;
        } else {
            console.log(`❌ FAIL: ${result.name}`);
            console.log(`   ${result.error}`);
            failed++;
        }
    });

    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                              TEST SUMMARY                                     ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

    console.log(`📊 Results: ${passed} passed, ${failed} failed (${results.length} total)\n`);

    process.exit(failed > 0 ? 1 : 0);
}

// Run tests
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests();
}
