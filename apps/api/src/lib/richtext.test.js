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
