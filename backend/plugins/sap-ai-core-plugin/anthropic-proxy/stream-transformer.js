import { Transform } from 'stream';
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
    chunks = [];
    totalLength = 0;
    MAX_BUFFER_SIZE = 100 * 1024 * 1024; // 100MB safety limit
    constructor() {
        super({ readableObjectMode: false, writableObjectMode: false });
    }
    _transform(chunk, encoding, callback) {
        try {
            this.processChunk(chunk);
            callback();
        }
        catch (error) {
            callback(error);
        }
    }
    _flush(callback) {
        try {
            if (this.totalLength > 0) {
                // Process remaining data
                const buffer = Buffer.concat(this.chunks, this.totalLength);
                this.processLine(buffer);
            }
            callback();
        }
        catch (error) {
            callback(error);
        }
    }
    processChunk(chunk) {
        let remaining = chunk;
        while (remaining.length > 0) {
            // Check for safety limit
            if (this.totalLength + remaining.length > this.MAX_BUFFER_SIZE) {
                throw new Error('StreamTransformer buffer exceeded maximum size');
            }
            const newlineIdx = remaining.indexOf(10); // \n
            if (newlineIdx === -1) {
                // No newline in this chunk, just buffer it all
                this.chunks.push(remaining);
                this.totalLength += remaining.length;
                break;
            }
            // Newline found
            const lineChunk = remaining.subarray(0, newlineIdx);
            // Construct the full line from buffer + new chunk part
            this.chunks.push(lineChunk);
            this.totalLength += lineChunk.length;
            const fullLine = Buffer.concat(this.chunks, this.totalLength);
            // Process the line
            this.processLine(fullLine);
            // Reset buffer
            this.chunks = [];
            this.totalLength = 0;
            // Move past the newline
            remaining = remaining.subarray(newlineIdx + 1);
        }
    }
    processLine(lineBuffer) {
        // Skip empty lines
        if (lineBuffer.length === 0)
            return;
        const line = lineBuffer.toString('utf8').trim();
        if (line.startsWith('data:')) {
            const jsonPart = line.slice(5);
            // Quick check if it might be JSON before parsing
            if (jsonPart.trim().startsWith('{')) {
                const json = this.parseJson(jsonPart);
                if (json && json.type) {
                    this.push(`event: ${json.type}\n`);
                    this.push(`data: ${JSON.stringify(json)}\n\n`);
                }
            }
        }
    }
    parseJson(str) {
        try {
            return JSON.parse(str);
        }
        catch {
            return null;
        }
    }
}
