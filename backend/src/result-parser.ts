import { StructuredTaskResult } from '@claudia/shared';

/**
 * Parse structured result from task output
 * Supports two formats:
 * 
 * 1. Section-based (ROBUST, PREFERRED):
 * === RESULT_OUTPUT ===
 * Actual content here...
 * Multiline allowed.
 * === END_RESULT_OUTPUT ===
 * === RESULT_METADATA ===
 * { "summary": "...", "artifacts": [] }
 * === END_RESULT_METADATA ===
 * 
 * 2. JSON-block (LEGACY):
 * === STRUCTURED_RESULT ===
 * { ... }
 * === END_STRUCTURED_RESULT ===
 */
export function extractStructuredResult(output: string[]): StructuredTaskResult | null {
    const fullOutput = output.join('\n');

    // 1. Try the robust section-based format (New format)
    const resultStartMarker = '=== RESULT_OUTPUT ===';
    const resultEndMarker = '=== END_RESULT_OUTPUT ===';
    const metadataStartMarker = '=== RESULT_METADATA ===';
    const metadataEndMarker = '=== END_RESULT_METADATA ===';

    const resultStartIdx = fullOutput.indexOf(resultStartMarker);
    const resultEndIdx = fullOutput.indexOf(resultEndMarker);

    if (resultStartIdx !== -1 && resultEndIdx !== -1) {
        const result = fullOutput.substring(resultStartIdx + resultStartMarker.length, resultEndIdx).trim();
        let structured: StructuredTaskResult = { result };

        // Look for metadata
        const metaStartIdx = fullOutput.indexOf(metadataStartMarker);
        const metaEndIdx = fullOutput.indexOf(metadataEndMarker);

        if (metaStartIdx !== -1 && metaEndIdx !== -1) {
            try {
                const metaJson = fullOutput.substring(metaStartIdx + metadataStartMarker.length, metaEndIdx).trim();
                const metadata = JSON.parse(metaJson);
                structured = { ...structured, ...metadata };
            } catch (e) {
                console.error('[ResultParser] Failed to parse result metadata:', e);
            }
        }

        console.log('[ResultParser] Extracted result from sections format');
        return structured;
    }

    // 2. Fallback to the JSON block format (Old format)
    const jsonStartMarker = '=== STRUCTURED_RESULT ===';
    const jsonEndMarker = '=== END_STRUCTURED_RESULT ===';

    const jsonStartIdx = fullOutput.indexOf(jsonStartMarker);
    const jsonEndIdx = fullOutput.indexOf(jsonEndMarker);

    if (jsonStartIdx === -1 || jsonEndIdx === -1 || jsonStartIdx >= jsonEndIdx) {
        return null;
    }

    // Extract JSON content between markers
    let jsonStr = fullOutput.substring(jsonStartIdx + jsonStartMarker.length, jsonEndIdx).trim();

    try {
        return parseJsonResult(jsonStr);
    } catch (error) {
        console.error('[ResultParser] Failed to parse structured result (first attempt):', error);
        return null;
    }
}

function parseJsonResult(jsonStr: string): StructuredTaskResult {
    // Basic parse
    const parsed = JSON.parse(jsonStr) as StructuredTaskResult;
    console.log('[ResultParser] Extracted structured result (JSON):', {
        hasResult: !!parsed.result,
        resultLength: parsed.result?.length || 0,
        artifactsCount: parsed.artifacts?.length || 0,
        summary: parsed.summary
    });
    return parsed;
}

/**
 * Remove structured result markers from output for cleaner display
 */
export function cleanOutputFromMarkers(output: string[]): string[] {
    let fullOutput = output.join('\n');

    // Remove new format sections
    const resultStartMarker = '=== RESULT_OUTPUT ===';
    const resultEndMarker = '=== END_RESULT_OUTPUT ===';
    const metadataStartMarker = '=== RESULT_METADATA ===';
    const metadataEndMarker = '=== END_RESULT_METADATA ===';

    let startIdx = fullOutput.indexOf(resultStartMarker);
    let endIdx = fullOutput.indexOf(resultEndMarker);

    if (startIdx !== -1 && endIdx !== -1) {
        fullOutput = fullOutput.substring(0, startIdx) +
            fullOutput.substring(endIdx + resultEndMarker.length);
    }

    startIdx = fullOutput.indexOf(metadataStartMarker);
    endIdx = fullOutput.indexOf(metadataEndMarker);

    if (startIdx !== -1 && endIdx !== -1) {
        fullOutput = fullOutput.substring(0, startIdx) +
            fullOutput.substring(endIdx + metadataEndMarker.length);
    }

    // Remove old format section
    const jsonStartMarker = '=== STRUCTURED_RESULT ===';
    const jsonEndMarker = '=== END_STRUCTURED_RESULT ===';

    startIdx = fullOutput.indexOf(jsonStartMarker);
    endIdx = fullOutput.indexOf(jsonEndMarker);

    if (startIdx !== -1 && endIdx !== -1) {
        fullOutput = fullOutput.substring(0, startIdx) +
            fullOutput.substring(endIdx + jsonEndMarker.length);
    }

    return fullOutput.split('\n');
}
