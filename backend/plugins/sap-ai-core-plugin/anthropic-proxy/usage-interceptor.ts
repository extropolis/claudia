import { Transform, TransformCallback } from 'stream';
import { reportUsage } from '../../../src/usage-reporter.js';

/**
 * A pass-through Transform stream that monitors Anthropic SSE events
 * to extract token usage (input_tokens + output_tokens) and report
 * them to the usage dashboard at the end of the stream.
 *
 * It sits between StreamTransformer and the HTTP response:
 *   sourceStream → StreamTransformer → UsageInterceptor → res
 *
 * The SSE format it reads looks like:
 *   event: message_start
 *   data: {"type":"message_start","message":{...,"usage":{"input_tokens":267,...}}}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{...},"usage":{"output_tokens":59}}
 */
export class UsageInterceptor extends Transform {
    private inputTokens: number = 0;
    private outputTokens: number = 0;
    private model: string;
    private lineBuffer: string = '';

    constructor(model: string) {
        super();
        this.model = model;
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        // Pass ALL bytes through to the response unchanged
        this.push(chunk);

        // Also parse the SSE text to extract token usage
        this.lineBuffer += chunk.toString('utf8');
        const lines = this.lineBuffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        this.lineBuffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;

            try {
                const json = JSON.parse(trimmed.slice(5).trim());

                if (json.type === 'message_start' && json.message?.usage) {
                    this.inputTokens = json.message.usage.input_tokens || 0;
                    console.log(`[UsageInterceptor] input_tokens=${this.inputTokens}`);
                } else if (json.type === 'message_delta' && json.usage) {
                    this.outputTokens = json.usage.output_tokens || 0;
                    console.log(`[UsageInterceptor] output_tokens=${this.outputTokens}`);
                }
            } catch {
                // Non-JSON data lines — ignore
            }
        }

        callback();
    }

    _flush(callback: TransformCallback): void {
        // Process any remaining buffered line
        if (this.lineBuffer) {
            const trimmed = this.lineBuffer.trim();
            if (trimmed.startsWith('data:')) {
                try {
                    const json = JSON.parse(trimmed.slice(5).trim());
                    if (json.type === 'message_delta' && json.usage) {
                        this.outputTokens = json.usage.output_tokens || 0;
                    }
                } catch {}
            }
        }

        // Fire-and-forget usage report at stream end
        if (this.inputTokens > 0 || this.outputTokens > 0) {
            reportUsage({
                tokensInput: this.inputTokens,
                tokensOutput: this.outputTokens,
                model: this.model,
            }).catch(() => {}); // intentionally fire-and-forget
        } else {
            console.log('[UsageInterceptor] No token data found in stream, skipping report');
        }

        callback();
    }
}
