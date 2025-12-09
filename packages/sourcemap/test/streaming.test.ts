import { describe, it, expect, vi } from 'vitest';
import {
    parseSourceMapStreaming,
    parseSourceMapFromResponse,
    shouldUseStreaming,
} from '../src/streaming.js';
import { SourceMapError, SourceMapErrorCode } from '../src/errors.js';
import {
    STREAMING_THRESHOLD,
    DEFAULT_MAX_SOURCE_MAP_SIZE,
} from '../src/constants.js';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Creates a ReadableStream from a string
 */
function stringToStream(str: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);

    return new ReadableStream({
        start(controller) {
            controller.enqueue(data);
            controller.close();
        },
    });
}

/**
 * Creates a ReadableStream that sends data in chunks
 */
function stringToChunkedStream(
    str: string,
    chunkSize: number,
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);

    let offset = 0;

    return new ReadableStream({
        pull(controller) {
            if (offset >= data.length) {
                controller.close();
                return;
            }

            const chunk = data.slice(offset, offset + chunkSize);
            offset += chunkSize;
            controller.enqueue(chunk);
        },
    });
}

/**
 * Creates a valid source map JSON string
 */
function createValidSourceMap(options?: {
    sources?: string[];
    sourcesContent?: (string | null)[];
    version?: number;
}): string {
    return JSON.stringify({
        version: options?.version ?? 3,
        sources: options?.sources ?? ['index.ts'],
        sourcesContent: options?.sourcesContent ?? ['export default 1;'],
        mappings: 'AAAA',
    });
}

// ============================================================================
// parseSourceMapStreaming
// ============================================================================

describe('parseSourceMapStreaming', () => {
    it('parses a valid source map from stream', async () => {
        const json = createValidSourceMap();
        const stream = stringToStream(json);

        const result = await parseSourceMapStreaming(stream);

        expect(result.sourceMap.version).toBe(3);
        expect(result.sourceMap.sources).toEqual(['index.ts']);
        expect(result.usedStreaming).toBe(true);
        expect(result.bytesProcessed).toBe(json.length);
        expect(result.parseTimeMs).toBeGreaterThan(0);
    });

    it('parses chunked stream correctly', async () => {
        const json = createValidSourceMap({
            sources: ['a.ts', 'b.ts', 'c.ts'],
            sourcesContent: ['const a = 1;', 'const b = 2;', 'const c = 3;'],
        });
        // Use small chunks to test streaming assembly
        const stream = stringToChunkedStream(json, 10);

        const result = await parseSourceMapStreaming(stream);

        expect(result.sourceMap.version).toBe(3);
        expect(result.sourceMap.sources).toHaveLength(3);
    });

    it('calls onProgress callback with bytes read', async () => {
        const json = createValidSourceMap();
        const stream = stringToChunkedStream(json, 20);
        const progressCalls: Array<{
            bytesRead: number;
            totalBytes: number | null;
        }> = [];

        await parseSourceMapStreaming(stream, {
            onProgress: (bytesRead, totalBytes) => {
                progressCalls.push({ bytesRead, totalBytes });
            },
        });

        expect(progressCalls.length).toBeGreaterThan(0);
        // Last call should have total bytes
        const lastCall = progressCalls[progressCalls.length - 1];
        expect(lastCall.bytesRead).toBe(json.length);
    });

    it('throws on invalid JSON', async () => {
        const stream = stringToStream('{ invalid json }');

        await expect(parseSourceMapStreaming(stream)).rejects.toThrow(
            SourceMapError,
        );
        await expect(
            parseSourceMapStreaming(stringToStream('{ invalid json }')),
        ).rejects.toThrow(/Failed to parse/);
    });

    it('throws on invalid source map structure', async () => {
        const stream = stringToStream(JSON.stringify({ version: 2 }));

        await expect(parseSourceMapStreaming(stream)).rejects.toThrow(
            SourceMapError,
        );
    });

    it('throws when stream exceeds maxSize', async () => {
        const json = createValidSourceMap();
        const stream = stringToStream(json);

        // Set maxSize smaller than the content
        await expect(
            parseSourceMapStreaming(stream, { maxSize: 10 }),
        ).rejects.toThrow(SourceMapError);

        // Verify error code
        try {
            await parseSourceMapStreaming(stringToStream(json), {
                maxSize: 10,
            });
        } catch (e) {
            expect(e).toBeInstanceOf(SourceMapError);
            expect((e as SourceMapError).code).toBe(
                SourceMapErrorCode.SOURCE_MAP_TOO_LARGE,
            );
        }
    });

    it('includes size information in error details', async () => {
        const json = createValidSourceMap();
        const stream = stringToStream(json);

        try {
            await parseSourceMapStreaming(stream, { maxSize: 10 });
            expect.fail('Should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(SourceMapError);
            const error = e as SourceMapError;
            expect(error.details?.actualSize).toBeGreaterThan(10);
            expect(error.details?.maxSize).toBe(10);
        }
    });

    it('handles empty stream', async () => {
        const stream = stringToStream('');

        await expect(parseSourceMapStreaming(stream)).rejects.toThrow(
            SourceMapError,
        );
    });

    it('handles source map with all optional fields', async () => {
        const json = JSON.stringify({
            version: 3,
            file: 'bundle.js',
            sourceRoot: 'src/',
            sources: ['index.ts'],
            sourcesContent: ['export default 1;'],
            names: ['foo', 'bar'],
            mappings: 'AAAA',
        });
        const stream = stringToStream(json);

        const result = await parseSourceMapStreaming(stream);

        expect(result.sourceMap.file).toBe('bundle.js');
        expect(result.sourceMap.sourceRoot).toBe('src/');
        expect(result.sourceMap.names).toEqual(['foo', 'bar']);
    });
});

// ============================================================================
// parseSourceMapFromResponse
// ============================================================================

describe('parseSourceMapFromResponse', () => {
    it('parses source map from Response object', async () => {
        const json = createValidSourceMap();
        const response = new Response(json, {
            headers: { 'Content-Type': 'application/json' },
        });

        const result = await parseSourceMapFromResponse(response);

        expect(result.sourceMap.version).toBe(3);
        expect(result.parseTimeMs).toBeGreaterThan(0);
    });

    it('uses non-streaming for small responses with Content-Length', async () => {
        const json = createValidSourceMap();
        const response = new Response(json, {
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(json.length),
            },
        });

        const result = await parseSourceMapFromResponse(response);

        // Small response should not use streaming
        expect(result.usedStreaming).toBe(false);
    });

    it('uses streaming when Content-Length exceeds threshold', async () => {
        const json = createValidSourceMap();
        const response = new Response(json, {
            headers: {
                'Content-Type': 'application/json',
                // Fake a large Content-Length to trigger streaming
                'Content-Length': String(STREAMING_THRESHOLD + 1),
            },
        });

        const result = await parseSourceMapFromResponse(response);

        expect(result.usedStreaming).toBe(true);
    });

    it('uses streaming when no Content-Length header', async () => {
        const json = createValidSourceMap();
        // Response without Content-Length
        const response = new Response(json, {
            headers: { 'Content-Type': 'application/json' },
        });
        // Remove Content-Length by creating stream-based response
        const streamResponse = new Response(stringToStream(json), {
            headers: { 'Content-Type': 'application/json' },
        });

        const result = await parseSourceMapFromResponse(streamResponse);

        expect(result.usedStreaming).toBe(true);
    });

    it('throws when Content-Length exceeds maxSize', async () => {
        const json = createValidSourceMap();
        const response = new Response(json, {
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(DEFAULT_MAX_SOURCE_MAP_SIZE + 1),
            },
        });

        await expect(
            parseSourceMapFromResponse(response, {
                maxSize: DEFAULT_MAX_SOURCE_MAP_SIZE,
            }),
        ).rejects.toThrow(SourceMapError);
    });

    it('includes URL in error when available', async () => {
        const response = new Response('{}', {
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': '1000000000', // 1GB
            },
        });
        // Manually set url property
        Object.defineProperty(response, 'url', {
            value: 'https://example.com/bundle.js.map',
        });

        try {
            await parseSourceMapFromResponse(response, { maxSize: 100 });
            expect.fail('Should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(SourceMapError);
            expect((e as SourceMapError).url).toBe(
                'https://example.com/bundle.js.map',
            );
        }
    });

    it('calls onProgress with estimated total when available', async () => {
        const json = createValidSourceMap();
        const response = new Response(stringToStream(json), {
            headers: {
                'Content-Type': 'application/json',
                // Force streaming with large Content-Length
                'Content-Length': String(STREAMING_THRESHOLD + 1),
            },
        });

        const progressCalls: Array<{
            bytesRead: number;
            totalBytes: number | null;
        }> = [];

        await parseSourceMapFromResponse(response, {
            onProgress: (bytesRead, totalBytes) => {
                progressCalls.push({ bytesRead, totalBytes });
            },
        });

        expect(progressCalls.length).toBeGreaterThan(0);
        // Total should be the Content-Length
        expect(progressCalls[0].totalBytes).toBe(STREAMING_THRESHOLD + 1);
    });

    it('respects custom streamingThreshold', async () => {
        const json = createValidSourceMap();
        const response = new Response(json, {
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': '100', // Small
            },
        });

        // Set a very low threshold to force streaming
        const result = await parseSourceMapFromResponse(response, {
            streamingThreshold: 50,
        });

        expect(result.usedStreaming).toBe(true);
    });
});

// ============================================================================
// shouldUseStreaming
// ============================================================================

describe('shouldUseStreaming', () => {
    it('returns false for small sizes', () => {
        expect(shouldUseStreaming(1000)).toBe(false);
        expect(shouldUseStreaming(1024 * 1024)).toBe(false); // 1MB
        expect(shouldUseStreaming(10 * 1024 * 1024)).toBe(false); // 10MB
    });

    it('returns true for sizes above threshold', () => {
        expect(shouldUseStreaming(STREAMING_THRESHOLD + 1)).toBe(true);
        expect(shouldUseStreaming(100 * 1024 * 1024)).toBe(true); // 100MB
    });

    it('returns false at exactly threshold', () => {
        expect(shouldUseStreaming(STREAMING_THRESHOLD)).toBe(false);
    });

    it('uses custom threshold when provided', () => {
        const customThreshold = 1000;
        expect(shouldUseStreaming(999, customThreshold)).toBe(false);
        expect(shouldUseStreaming(1000, customThreshold)).toBe(false);
        expect(shouldUseStreaming(1001, customThreshold)).toBe(true);
    });

    it('uses default STREAMING_THRESHOLD', () => {
        // STREAMING_THRESHOLD is 50MB
        expect(STREAMING_THRESHOLD).toBe(50 * 1024 * 1024);
        expect(shouldUseStreaming(50 * 1024 * 1024)).toBe(false);
        expect(shouldUseStreaming(50 * 1024 * 1024 + 1)).toBe(true);
    });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('streaming edge cases', () => {
    it('handles UTF-8 content correctly across chunk boundaries', async () => {
        // Create a source map with multi-byte UTF-8 characters
        const json = JSON.stringify({
            version: 3,
            sources: ['日本語.ts', 'émoji.ts'],
            sourcesContent: ['const x = "こんにちは";', 'const y = "🎉🚀";'],
            mappings: 'AAAA',
        });

        // Use small chunks that might split multi-byte characters
        const stream = stringToChunkedStream(json, 5);
        const result = await parseSourceMapStreaming(stream);

        expect(result.sourceMap.sources).toContain('日本語.ts');
        expect(result.sourceMap.sourcesContent?.[0]).toContain('こんにちは');
        expect(result.sourceMap.sourcesContent?.[1]).toContain('🎉🚀');
    });

    it('handles very large sourcesContent array', async () => {
        const sources: string[] = [];
        const sourcesContent: string[] = [];

        for (let i = 0; i < 100; i++) {
            sources.push(`file${i}.ts`);
            sourcesContent.push(`// File ${i}\nexport const x${i} = ${i};`);
        }

        const json = JSON.stringify({
            version: 3,
            sources,
            sourcesContent,
            mappings: 'AAAA',
        });

        const stream = stringToStream(json);
        const result = await parseSourceMapStreaming(stream);

        expect(result.sourceMap.sources).toHaveLength(100);
        expect(result.sourceMap.sourcesContent).toHaveLength(100);
    });

    it('handles source map with null sourcesContent entries', async () => {
        const json = JSON.stringify({
            version: 3,
            sources: ['a.ts', 'b.ts', 'c.ts'],
            sourcesContent: ['content a', null, 'content c'],
            mappings: 'AAAA',
        });

        const stream = stringToStream(json);
        const result = await parseSourceMapStreaming(stream);

        expect(result.sourceMap.sourcesContent?.[0]).toBe('content a');
        expect(result.sourceMap.sourcesContent?.[1]).toBe(null);
        expect(result.sourceMap.sourcesContent?.[2]).toBe('content c');
    });

    it('handles source map without sourcesContent', async () => {
        const json = JSON.stringify({
            version: 3,
            sources: ['a.ts', 'b.ts'],
            mappings: 'AAAA',
        });

        const stream = stringToStream(json);
        const result = await parseSourceMapStreaming(stream);

        expect(result.sourceMap.sourcesContent).toBeUndefined();
    });
});
