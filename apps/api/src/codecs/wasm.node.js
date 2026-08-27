// The Node half of `#image-codec-wasm` (see package.json's "imports" and
// ../imageConvert.js).
//
// Node has no wasm-module loader for imports, so each codec's binary is read off
// disk and compiled here. The result is the same `WebAssembly.Module` the
// Workers half gets from wrangler's bundler, so @jsquash's `init()` is handed
// the same thing on both hosts and never falls back to fetching the binary
// itself.
//
// Compiling is deferred and memoised rather than done at import time: the three
// binaries are about 700 KB together, and an instance that never receives an
// image upload should not pay for them at startup. A failed compile clears its
// slot so the next upload retries, matching how imageConvert.js treats a failed
// init.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Resolution goes through `createRequire` rather than `import.meta.resolve`,
// which looks like the more modern choice and is the wrong one here: bundlers and
// test transforms rewrite `import.meta` into a plain object, and the `resolve`
// method does not survive the trip. `createRequire` is an ordinary import that
// nothing rewrites, and it answers the same question.
const resolve = createRequire(import.meta.url).resolve;

/** @type {Map<string, Promise<WebAssembly.Module>>} */
const compiled = new Map();

/**
 * Compile one codec binary, resolved through Node's own module resolution so the
 * path holds wherever the package manager put it — pnpm's layout is not
 * `node_modules/<name>` and hardcoding that would work only by accident.
 *
 * @param {string} specifier A bare specifier for the .wasm file.
 * @returns {Promise<WebAssembly.Module>}
 */
function compile(specifier) {
	let pending = compiled.get(specifier);
	if (!pending) {
		pending = (async () => {
			const bytes = await readFile(resolve(specifier));
			return await WebAssembly.compile(bytes);
		})().catch((e) => {
			compiled.delete(specifier);
			throw e;
		});
		compiled.set(specifier, pending);
	}
	return pending;
}

export const webpEncoderWasm = () => compile('@jsquash/webp/codec/enc/webp_enc_simd.wasm');
export const pngDecoderWasm = () => compile('@jsquash/png/codec/pkg/squoosh_png_bg.wasm');
export const jpegDecoderWasm = () => compile('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm');
