import { describe, it, expect } from 'vitest';
import { sanitizeRichText, richTextToPlain, isRichTextEmpty } from './richtext.js';

describe('sanitizeRichText - keeps formatting', () => {
	it('keeps the marks and blocks the toolbar produces', async () => {
		const html =
			'<p><strong>bold</strong> <em>it</em> <u>u</u> <s>s</s> <code>c</code></p><ul><li>one</li></ul><ol><li>two</li></ol><blockquote><p>q</p></blockquote>';
		expect(await sanitizeRichText(html)).toBe(html);
	});

	it('unwraps unknown tags but keeps their words', async () => {
		expect(await sanitizeRichText('<div><h1>Hi</h1><span>there</span></div>')).toBe('Hithere');
	});
});

describe('sanitizeRichText - blocks media (the product rule)', () => {
	it('drops img, including a base64 data URI', async () => {
		const out = await sanitizeRichText('<p>a<img src="data:image/png;base64,iVBORw0KGgo=" />b</p>');
		expect(out).toBe('<p>ab</p>');
		expect(out).not.toContain('img');
	});

	it('drops video, audio, iframe, object, embed, svg and their content', async () => {
		const out = await sanitizeRichText(
			'<p>x</p><video src="v.mp4"><source src="v.mp4"></video><audio controls></audio>' +
				'<iframe src="https://evil.com"></iframe><object data="x"></object><embed src="x">' +
				'<svg onload="alert(1)"><circle /></svg>',
		);
		expect(out).toBe('<p>x</p>');
	});

	it('drops an <a> whose href is a data: image', async () => {
		const out = await sanitizeRichText('<p><a href="data:image/png;base64,AAA">pic</a></p>');
		expect(out).toBe('<p>pic</p>');
	});
});

describe('sanitizeRichText - blocks XSS', () => {
	it('drops script tags and their body', async () => {
		expect(await sanitizeRichText('<p>hi</p><script>alert("xss")</script>')).toBe('<p>hi</p>');
	});

	it('drops nested/obfuscated script', async () => {
		const out = await sanitizeRichText('<scr<script>ipt>alert(1)</script>');
		expect(out.toLowerCase()).not.toContain('<script');
	});

	it('strips event-handler and style attributes from allowed tags', async () => {
		const out = await sanitizeRichText('<p onclick="steal()" style="position:fixed" class="x">hi</p>');
		expect(out).toBe('<p>hi</p>');
	});

	it('strips onerror smuggled on an unwrapped tag', async () => {
		const out = await sanitizeRichText('<div onmouseover="alert(1)">hover</div>');
		expect(out).toBe('hover');
	});

	it('rejects a javascript: href but keeps the words', async () => {
		expect(await sanitizeRichText('<p><a href="javascript:alert(1)">click</a></p>')).toBe('<p>click</p>');
	});

	it('rejects javascript: hidden behind ignored control characters', async () => {
		const out = await sanitizeRichText('<p><a href="java\tscript:alert(1)">click</a></p>');
		expect(out).toBe('<p>click</p>');
	});

	it('strips HTML comments', async () => {
		expect(await sanitizeRichText('<p>a</p><!-- [if IE]><script>x</script><![endif] -->')).toBe('<p>a</p>');
	});
});

describe('sanitizeRichText - links', () => {
	it('keeps an http link and forces nofollow/noopener + target', async () => {
		const out = await sanitizeRichText('<p><a href="https://example.com" target="_self">hi</a></p>');
		expect(out).toBe('<p><a href="https://example.com" target="_blank" rel="nofollow ugc noopener noreferrer">hi</a></p>');
	});

	it('keeps mailto, drops relative and protocol-relative hrefs', async () => {
		expect(await sanitizeRichText('<a href="mailto:a@b.com">mail</a>')).toContain('mailto:a@b.com');
		expect(await sanitizeRichText('<a href="/admin">rel</a>')).toBe('rel');
		expect(await sanitizeRichText('<a href="//evil.com">pr</a>')).toBe('pr');
	});
});

describe('richTextToPlain', () => {
	it('flattens blocks to newlines without gluing words', async () => {
		expect(richTextToPlain('<p>one</p><p>two</p>')).toBe('one\ntwo');
		expect(richTextToPlain('<ul><li>a</li><li>b</li></ul>')).toBe('a\nb');
		expect(richTextToPlain('a<br>b')).toBe('a\nb');
	});

	it('decodes entities so the profanity filter sees real words', () => {
		expect(richTextToPlain('<p>Ben &amp; Jerry&#39;s</p>')).toBe("Ben & Jerry's");
		expect(richTextToPlain('<p>a&nbsp;b</p>')).toBe('a b');
	});

	it('passes legacy plain text through unchanged', () => {
		expect(richTextToPlain('just a plain old comment')).toBe('just a plain old comment');
		expect(richTextToPlain('I <3 this')).toBe('I <3 this');
	});

	it('counts what the user wrote, not the markup', () => {
		const html = '<p><strong><em><u>hi</u></em></strong></p>';
		expect(richTextToPlain(html).length).toBe(2);
	});
});

// The cases below were added when the sanitizer moved from HTMLRewriter to
// parse5. Two different reasons, both worth keeping whatever parses next:
//
//   * Mutation XSS — markup that is inert as written, but which a browser
//     re-parses into something that executes. These are the vectors a
//     tree-based sanitizer has to be checked against specifically, because the
//     tree it sanitizes and the tree the browser eventually builds are two
//     different parses of two different strings.
//   * Resource limits. The streaming parser had no tree and so no depth; a
//     tree-building one does, and the input's shape is the caller's choice.
describe('sanitizeRichText - resists mutation XSS', () => {
	it('does not let a comment inside a dropped tag re-open as markup', async () => {
		// The classic: `<style>` content is raw text, so the `</style>` inside the
		// title attribute closes it early on re-parse.
		const out = await sanitizeRichText('<style><!--</style><img src=x onerror=alert(1)>--></style>');
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('<img');
	});

	it('does not let noscript content re-open as markup', async () => {
		const out = await sanitizeRichText('<noscript><p title="</noscript><img src=x onerror=alert(1)>">');
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('<img');
	});

	it('drops foreign content wholesale rather than unwrapping into it', async () => {
		// Inside <svg>, HTML parsing rules change — an unwrapped child would be
		// re-parsed under different rules than it was sanitized under. svg is in
		// DROP_TAGS precisely so that question never arises.
		const out = await sanitizeRichText('<svg><style><a href="</style><img src=1 onerror=alert(1)>">x</a></style></svg>');
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('<img');
	});

	it('drops a math/mglyph nest without promoting anything out of it', async () => {
		const out = await sanitizeRichText('<math><mtext><table><mglyph><style><!--</style><img src onerror=alert(1)>');
		expect(out).not.toContain('onerror');
		expect(out).not.toContain('<img');
	});

	it('escapes text that would otherwise re-parse as a tag', async () => {
		// Serialization has to escape, or a comment reading `<script>` as *text*
		// would come back out as a tag.
		const out = await sanitizeRichText('<p>a &lt;script&gt;alert(1)&lt;/script&gt; b</p>');
		expect(out).toBe('<p>a &lt;script&gt;alert(1)&lt;/script&gt; b</p>');
	});

	it('escapes a quote inside a link href', async () => {
		const out = await sanitizeRichText('<p><a href=\'https://e.test/"onmouseover="alert(1)\'>x</a></p>');
		expect(out).not.toContain('onmouseover="alert');
		expect(out).toContain('&quot;');
	});

	it('rejects an href whose scheme is entity-encoded', async () => {
		const out = await sanitizeRichText('<p><a href="&#106;avascript:alert(1)">x</a></p>');
		expect(out).toBe('<p>x</p>');
	});

	it('rejects an href with a newline inside the scheme', async () => {
		const out = await sanitizeRichText('<p><a href="jav&#x0A;ascript:alert(1)">x</a></p>');
		expect(out).toBe('<p>x</p>');
	});

	it('keeps an unclosed allowed tag closed', async () => {
		// Tag soup is the normal case for hand-written input; the output still has
		// to be well-formed or it changes the shape of the page it lands in.
		expect(await sanitizeRichText('<p><strong>bold')).toBe('<p><strong>bold</strong></p>');
	});

	it('drops a script smuggled inside a template', async () => {
		// parse5 puts template children on `content`, not `childNodes` — a walker
		// that only looked at childNodes would see an empty element and keep it.
		const out = await sanitizeRichText('<template><script>alert(1)</script></template><p>hi</p>');
		expect(out).toBe('<p>hi</p>');
	});
});

describe('sanitizeRichText - bounded by input, not by trust', () => {
	it('survives nesting far deeper than the routes allow through', async () => {
		// The routes cap raw input at 20,000 characters and `<b>` is three of them,
		// so this is a shape a caller can actually send. A recursive walk exhausts
		// the stack here.
		const out = await sanitizeRichText('<b>'.repeat(6600) + 'deep');
		expect(out).toContain('deep');
	});

	it('keeps the words when it flattens past the depth limit', async () => {
		const out = await sanitizeRichText(`${'<b>'.repeat(150)}buried${'</b>'.repeat(150)}`);
		expect(out).toContain('buried');
	});

	it('does not promote a dropped subtree into the text it keeps', async () => {
		// Flattening past the limit must not turn a <script> body into prose.
		const out = await sanitizeRichText(`${'<b>'.repeat(150)}<script>alert(1)</script>ok`);
		expect(out).toContain('ok');
		expect(out).not.toContain('alert(1)');
	});

	it('stays within the depth limit in its output', async () => {
		const out = await sanitizeRichText('<b>'.repeat(500) + 'x');
		// Whatever survives has to be shallow enough for the serializer that just
		// wrote it — and for every reader after it.
		expect(out.split('<b>').length - 1).toBeLessThanOrEqual(100);
	});
});

describe('isRichTextEmpty', () => {
	it("treats an empty editor's markup as empty", () => {
		expect(isRichTextEmpty('<p></p>')).toBe(true);
		expect(isRichTextEmpty('<p><br></p>')).toBe(true);
		expect(isRichTextEmpty('<p>   </p>')).toBe(true);
		expect(isRichTextEmpty('')).toBe(true);
		expect(isRichTextEmpty('<p>hi</p>')).toBe(false);
	});

	it('is empty once media-only content is stripped', async () => {
		expect(isRichTextEmpty(await sanitizeRichText('<p><img src="x.png"></p>'))).toBe(true);
	});
});
