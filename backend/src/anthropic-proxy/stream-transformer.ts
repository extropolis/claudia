import { Transform, TransformCallback } from 'stream';

/**
 * Transforms Bedrock stream events to Anthropic SSE format with event types.
 *
 * Bedrock returns:
 *   data: {"type":"message_start", ...}
 *
 * Anthropic clients expect:
 *   event: message_start
 *   data: {"type":"message_start", ...}
 */
export class StreamTransformer extends Transform {
    private buffer: string = '';

    constructor() {
        super({ readableObjectMode: false, writableObjectMode: false });
    }

    _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
        this.buffer += chunk.toString('utf8');

        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);

            if (line.startsWith('data:')) {
                const json = this.parseJson(line.slice(5));
                if (json && json.type) {
                    this.push(`event: ${json.type}\n`);
                    this.push(`data: ${JSON.stringify(json)}\n\n`);
                }
            }
        }
        callback();
    }

    _flush(callback: TransformCallback): void {
        if (this.buffer.length > 0) {
            const line = this.buffer.trim();
            if (line.startsWith('data:')) {
                const json = this.parseJson(line.slice(5));
                if (json && json.type) {
                    this.push(`event: ${json.type}\n`);
                    this.push(`data: ${JSON.stringify(json)}\n\n`);
                }
            }
        }
        callback();
    }

    private parseJson(str: string): any {
        try {
            return JSON.parse(str);
        } catch {
            return null;
        }
    }
}
