#!/usr/bin/env node
/**
 * Unit tests for result-parser
 */

import { extractStructuredResult, cleanOutputFromMarkers } from '../../src/result-parser.js';

interface TestCase {
    name: string;
    input: string[];
    expectedResult: any;
    shouldExtract: boolean;
}

const TEST_CASES: TestCase[] = [
    {
        name: 'Valid JSON structured result',
        input: [
            'Some output before',
            '=== STRUCTURED_RESULT ===',
            '{"summary": "Test summary", "result": "test data"}',
            '=== END_STRUCTURED_RESULT ===',
            'Some output after'
        ],
        expectedResult: {
            summary: 'Test summary',
            result: 'test data'
        },
        shouldExtract: true
    },
    {
        name: 'Structured result with artifacts',
        input: [
            '=== STRUCTURED_RESULT ===',
            '{',
            '  "summary": "Created files",',
            '  "artifacts": ["file1.txt", "file2.js"],',
            '  "result": null',
            '}',
            '=== END_STRUCTURED_RESULT ==='
        ],
        expectedResult: {
            summary: 'Created files',
            artifacts: ['file1.txt', 'file2.js'],
            result: null
        },
        shouldExtract: true
    },
    {
        name: 'No structured result markers',
        input: ['Just regular output without markers'],
        expectedResult: null,
        shouldExtract: false
    },
    {
        name: 'Incomplete markers',
        input: [
            '=== STRUCTURED_RESULT ===',
            '{"test": "data"}',
            'No end marker'
        ],
        expectedResult: null,
        shouldExtract: false
    },
    {
        name: 'Invalid JSON in markers',
        input: [
            '=== STRUCTURED_RESULT ===',
            'Invalid JSON{]',
            '=== END_STRUCTURED_RESULT ==='
        ],
        expectedResult: null,
        shouldExtract: false
    },
    {
        name: 'Multiple structured results (should extract first)',
        input: [
            '=== STRUCTURED_RESULT ===',
            '{"summary": "First result"}',
            '=== END_STRUCTURED_RESULT ===',
            'Some text',
            '=== STRUCTURED_RESULT ===',
            '{"summary": "Second result"}',
            '=== END_STRUCTURED_RESULT ==='
        ],
        expectedResult: {
            summary: 'First result'
        },
        shouldExtract: true
    },
    {
        name: 'New format: RESULT_OUTPUT section',
        input: [
            '=== RESULT_OUTPUT ===',
            'Actual result content here',
            'Multiple lines',
            '=== END_RESULT_OUTPUT ===',
            '=== RESULT_METADATA ===',
            '{"summary": "Test summary", "artifacts": ["file.txt"]}',
            '=== END_RESULT_METADATA ==='
        ],
        expectedResult: {
            result: 'Actual result content here\nMultiple lines',
            summary: 'Test summary',
            artifacts: ['file.txt']
        },
        shouldExtract: true
    }
];

const CLEAN_OUTPUT_TESTS = [
    {
        name: 'Remove markers from output',
        input: [
            'Before markers',
            '=== STRUCTURED_RESULT ===',
            '{"data": "test"}',
            '=== END_STRUCTURED_RESULT ===',
            'After markers'
        ],
        expected: ['Before markers', '', 'After markers']
    },
    {
        name: 'No markers to remove',
        input: ['Clean output without any markers'],
        expected: ['Clean output without any markers']
    },
    {
        name: 'Multiple marker sets',
        input: [
            'First',
            '=== STRUCTURED_RESULT ===',
            '{"a": 1}',
            '=== END_STRUCTURED_RESULT ===',
            'Middle',
            'Last'
        ],
        expected: ['First', '', 'Middle', 'Last']
    }
];

/**
 * Run extraction tests
 */
function runExtractionTests() {
    console.log('\n╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                    RESULT PARSER - EXTRACTION TESTS                           ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

    let passed = 0;
    let failed = 0;

    for (const testCase of TEST_CASES) {
        try {
            const result = extractStructuredResult(testCase.input);

            if (testCase.shouldExtract) {
                if (!result) {
                    throw new Error('Expected to extract result but got null');
                }

                // Deep comparison
                const resultStr = JSON.stringify(result);
                const expectedStr = JSON.stringify(testCase.expectedResult);

                if (resultStr !== expectedStr) {
                    throw new Error(`Mismatch:\n  Expected: ${expectedStr}\n  Got: ${resultStr}`);
                }
            } else {
                if (result !== null) {
                    throw new Error(`Expected null but got: ${JSON.stringify(result)}`);
                }
            }

            console.log(`✅ PASS: ${testCase.name}`);
            passed++;

        } catch (error) {
            console.log(`❌ FAIL: ${testCase.name}`);
            console.log(`   ${error instanceof Error ? error.message : String(error)}`);
            failed++;
        }
    }

    return { passed, failed };
}

/**
 * Run clean output tests
 */
function runCleanOutputTests() {
    console.log('\n╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                    RESULT PARSER - CLEAN OUTPUT TESTS                         ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

    let passed = 0;
    let failed = 0;

    for (const testCase of CLEAN_OUTPUT_TESTS) {
        try {
            const result = cleanOutputFromMarkers(testCase.input);

            // Compare arrays
            const resultStr = JSON.stringify(result);
            const expectedStr = JSON.stringify(testCase.expected);

            if (resultStr !== expectedStr) {
                throw new Error(`Mismatch:\n  Expected: ${expectedStr}\n  Got: ${resultStr}`);
            }

            console.log(`✅ PASS: ${testCase.name}`);
            passed++;

        } catch (error) {
            console.log(`❌ FAIL: ${testCase.name}`);
            console.log(`   ${error instanceof Error ? error.message : String(error)}`);
            failed++;
        }
    }

    return { passed, failed };
}

/**
 * Run all unit tests
 */
function runAllTests() {
    console.log('\n');

    const extractionResults = runExtractionTests();
    const cleanResults = runCleanOutputTests();

    const totalPassed = extractionResults.passed + cleanResults.passed;
    const totalFailed = extractionResults.failed + cleanResults.failed;

    console.log('\n╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                              TEST SUMMARY                                     ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝\n');

    console.log(`📊 Extraction Tests: ${extractionResults.passed} passed, ${extractionResults.failed} failed`);
    console.log(`📊 Clean Output Tests: ${cleanResults.passed} passed, ${cleanResults.failed} failed`);
    console.log(`📊 Total: ${totalPassed} passed, ${totalFailed} failed\n`);

    process.exit(totalFailed > 0 ? 1 : 0);
}

// Run tests
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests();
}
