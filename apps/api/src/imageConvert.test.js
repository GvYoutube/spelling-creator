// Image conversion, and specifically that it works on whichever runtime is
// running it.
//
// The interesting part is the WASM loading. `#image-codec-wasm` resolves to a
// different module per runtime — wrangler's bundler on Workers, a read and
// compile off disk in Node — so the Node half is code the Workers project never
// executes, and vice versa. Without a run in each, a broken loader would surface
// as "image uploads are stored uncompressed", quietly, on one host only.

import { describe, expect, it } from 'vitest';

import { jpegDecoderWasm, pngDecoderWasm, webpEncoderWasm } from '#image-codec-wasm';
import { convertImageToWebp } from './imageConvert.js';

/**
 * A valid PNG of `size` x `size` pixels holding a gradient.
 *
 * Built rather than pasted as a base64 blob for two reasons: a literal big
 * enough for WEBP to actually beat would be an unreadable wall of characters,
 * and a gradient is compressible enough that the "keep whichever is smaller"
 * branch doesn't get to decide the test instead of the codec.
 *
 * The deflate stream comes from `CompressionStream`, which both runtimes have —
 * hand-rolling one is a good way to write a test that fails for reasons that
 * have nothing to do with what it is testing.
 */
async function gradientPng(size = 64) {
	const scanlines = new Uint8Array(size * (1 + size * 4));
	let at = 0;
	for (let y = 0; y < size; y += 1) {
		scanlines[at] = 0; // PNG filter type: none
		at += 1;
		for (let x = 0; x < size; x += 1) {
			scanlines[at] = (x * 4) % 256;
			scanlines[at + 1] = (y * 4) % 256;
			scanlines[at + 2] = 128;
			scanlines[at + 3] = 255;
			at += 4;
		}
	}

	const compressed = new Uint8Array(
		await new Response(new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
	);

	const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
	parts.push(pngChunk('IHDR', ihdr(size)));
	parts.push(pngChunk('IDAT', compressed));
	parts.push(pngChunk('IEND', new Uint8Array(0)));
	return concat(parts);
}

function ihdr(size) {
	const data = new Uint8Array(13);
	new DataView(data.buffer).setUint32(0, size);
	new DataView(data.buffer).setUint32(4, size);
	data[8] = 8; // bit depth
	data[9] = 6; // colour type: RGBA
	return data;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const chunk = new Uint8Array(12 + data.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i);
	chunk.set(data, 8);
	view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
	return chunk;
}

function concat(parts) {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

describe('#image-codec-wasm', () => {
	it('resolves each codec to a compiled WebAssembly module', async () => {
		// The per-runtime claim, asserted directly: whichever half of the subpath
		// import this runtime picked, it produced the thing @jsquash's init() wants.
		expect(await webpEncoderWasm()).toBeInstanceOf(WebAssembly.Module);
		expect(await pngDecoderWasm()).toBeInstanceOf(WebAssembly.Module);
		expect(await jpegDecoderWasm()).toBeInstanceOf(WebAssembly.Module);
	});

	it('returns the same module when asked twice', async () => {
		// Compiling is memoised — three binaries is about 700 KB, and an upload
		// should not pay for it more than once.
		expect(await webpEncoderWasm()).toBe(await webpEncoderWasm());
	});
});

describe('convertImageToWebp', () => {
	it('compresses a PNG to WEBP', async () => {
		// End to end: the loader loaded, the decoder decoded, the encoder encoded.
		const png = await gradientPng();
		const result = await convertImageToWebp(png, 'image/png');
		expect(result.contentType).toBe('image/webp');
		expect(result.bytes.byteLength).toBeLessThan(png.byteLength);
	});

	it('normalises a content type carrying parameters', async () => {
		const result = await convertImageToWebp(await gradientPng(), 'image/png; charset=binary');
		expect(result.contentType).toBe('image/webp');
	});

	it('passes through a format it has no decoder for', async () => {
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
		const result = await convertImageToWebp(gif, 'image/gif');
		// GIFs are often animated and SVGs are vectors; neither should be flattened.
		expect(result.contentType).toBe('image/gif');
		expect(result.bytes).toBe(gif);
	});

	it('keeps the original bytes when decoding fails', async () => {
		// Image storage must not fail because one file could not be transcoded.
		const notAPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
		const result = await convertImageToWebp(notAPng, 'image/png');
		expect(result.bytes).toBe(notAPng);
		expect(result.contentType).toBe('image/png');
	});
});
