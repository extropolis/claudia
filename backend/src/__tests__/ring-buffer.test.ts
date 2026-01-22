import { describe, it, expect, beforeEach } from 'vitest';
import { BufferRingBuffer } from '../ring-buffer.js';

describe('BufferRingBuffer', () => {
    let buffer: BufferRingBuffer;

    beforeEach(() => {
        buffer = new BufferRingBuffer(100); // 100 byte max for testing
    });

    describe('initialization', () => {
        it('should start empty', () => {
            expect(buffer.size()).toBe(0);
            expect(buffer.length()).toBe(0);
        });

        it('should use default max size if not provided', () => {
            const defaultBuffer = new BufferRingBuffer();
            expect(defaultBuffer.size()).toBe(0);
        });
    });

    describe('push', () => {
        it('should add a buffer chunk', () => {
            const chunk = Buffer.from('hello');
            buffer.push(chunk);

            expect(buffer.size()).toBe(5);
            expect(buffer.length()).toBe(1);
        });

        it('should add multiple chunks', () => {
            buffer.push(Buffer.from('hello'));
            buffer.push(Buffer.from('world'));

            expect(buffer.size()).toBe(10);
            expect(buffer.length()).toBe(2);
        });

        it('should remove oldest chunks when max size exceeded', () => {
            // Max size is 100 bytes
            const chunk1 = Buffer.from('a'.repeat(40)); // 40 bytes
            const chunk2 = Buffer.from('b'.repeat(40)); // 40 bytes
            const chunk3 = Buffer.from('c'.repeat(40)); // 40 bytes - this should push chunk1 out

            buffer.push(chunk1);
            buffer.push(chunk2);
            expect(buffer.size()).toBe(80);

            buffer.push(chunk3);
            // Total would be 120, so oldest chunk should be removed
            expect(buffer.size()).toBeLessThanOrEqual(100);
            expect(buffer.length()).toBe(2);
        });

        it('should handle single large chunk that exceeds max', () => {
            const largeChunk = Buffer.from('x'.repeat(150)); // Exceeds max of 100
            buffer.push(largeChunk);

            // Should still keep the chunk even if it exceeds max
            // (only removes old chunks, won't truncate current)
            expect(buffer.length()).toBe(1);
            expect(buffer.size()).toBe(150);
        });
    });

    describe('size and length', () => {
        it('should correctly report size after additions', () => {
            buffer.push(Buffer.from('12345')); // 5 bytes
            expect(buffer.size()).toBe(5);

            buffer.push(Buffer.from('67890')); // 5 more bytes
            expect(buffer.size()).toBe(10);
        });

        it('should correctly report length after additions', () => {
            buffer.push(Buffer.from('a'));
            buffer.push(Buffer.from('b'));
            buffer.push(Buffer.from('c'));

            expect(buffer.length()).toBe(3);
        });
    });

    describe('getLastBytes', () => {
        it('should return all content when asking for more bytes than stored', () => {
            buffer.push(Buffer.from('hello'));
            const result = buffer.getLastBytes(100);

            expect(result).toBe('hello');
        });

        it('should return last N bytes when content is longer', () => {
            buffer.push(Buffer.from('hello world'));
            const result = buffer.getLastBytes(5);

            expect(result).toBe('world');
        });

        it('should work across multiple chunks', () => {
            buffer.push(Buffer.from('hello'));
            buffer.push(Buffer.from(' '));
            buffer.push(Buffer.from('world'));
            const result = buffer.getLastBytes(6);

            expect(result).toBe(' world');
        });

        it('should handle empty buffer', () => {
            const result = buffer.getLastBytes(10);
            expect(result).toBe('');
        });
    });

    describe('toBuffer', () => {
        it('should concatenate all chunks', () => {
            buffer.push(Buffer.from('hello'));
            buffer.push(Buffer.from(' '));
            buffer.push(Buffer.from('world'));

            const result = buffer.toBuffer();
            expect(result.toString()).toBe('hello world');
        });

        it('should return empty buffer when empty', () => {
            const result = buffer.toBuffer();
            expect(result.length).toBe(0);
        });
    });

    describe('toString', () => {
        it('should convert all content to string', () => {
            buffer.push(Buffer.from('hello'));
            buffer.push(Buffer.from(' world'));

            expect(buffer.toString()).toBe('hello world');
        });

        it('should handle unicode', () => {
            buffer.push(Buffer.from('hello 世界 🌍'));

            expect(buffer.toString()).toBe('hello 世界 🌍');
        });

        it('should return empty string when empty', () => {
            expect(buffer.toString()).toBe('');
        });
    });

    describe('clear', () => {
        it('should remove all chunks', () => {
            buffer.push(Buffer.from('hello'));
            buffer.push(Buffer.from('world'));
            expect(buffer.size()).toBeGreaterThan(0);

            buffer.clear();

            expect(buffer.size()).toBe(0);
            expect(buffer.length()).toBe(0);
            expect(buffer.toString()).toBe('');
        });
    });

    describe('getChunks', () => {
        it('should return all chunks', () => {
            const chunk1 = Buffer.from('hello');
            const chunk2 = Buffer.from('world');
            buffer.push(chunk1);
            buffer.push(chunk2);

            const chunks = buffer.getChunks();
            expect(chunks).toHaveLength(2);
            expect(chunks[0]).toBe(chunk1);
            expect(chunks[1]).toBe(chunk2);
        });

        it('should return empty array when empty', () => {
            const chunks = buffer.getChunks();
            expect(chunks).toHaveLength(0);
        });
    });

    describe('reduce', () => {
        it('should reduce over all chunks', () => {
            buffer.push(Buffer.from('hello'));
            buffer.push(Buffer.from('world'));

            const totalLength = buffer.reduce((acc, chunk) => acc + chunk.length, 0);
            expect(totalLength).toBe(10);
        });

        it('should return initial value for empty buffer', () => {
            const result = buffer.reduce((acc, chunk) => acc + chunk.length, 42);
            expect(result).toBe(42);
        });

        it('should allow concatenating chunks', () => {
            buffer.push(Buffer.from('hello'));
            buffer.push(Buffer.from(' '));
            buffer.push(Buffer.from('world'));

            const combined = buffer.reduce((acc, chunk) => acc + chunk.toString(), '');
            expect(combined).toBe('hello world');
        });
    });

    describe('edge cases', () => {
        it('should handle rapid successive pushes', () => {
            for (let i = 0; i < 100; i++) {
                buffer.push(Buffer.from(`item${i}`));
            }

            // Should not exceed max size too much
            expect(buffer.size()).toBeLessThanOrEqual(200); // Allow some slack for last push
        });

        it('should handle empty buffer pushes', () => {
            buffer.push(Buffer.from(''));
            buffer.push(Buffer.from('hello'));
            buffer.push(Buffer.from(''));

            expect(buffer.length()).toBe(3);
            expect(buffer.toString()).toBe('hello');
        });

        it('should handle binary data', () => {
            const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
            buffer.push(binaryData);

            const result = buffer.toBuffer();
            expect(result.equals(binaryData)).toBe(true);
        });
    });
});
