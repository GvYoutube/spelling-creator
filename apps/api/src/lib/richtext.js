// Rich text — the Worker's write-side sanitizer for the two places users author
// formatted content: lesson comments and profile bios. Both are written in the
// browser with tiptap (see apps/web/src/components/RichTextInput.jsx) and stored
// as HTML.
//
// HTML arriving from a browser is untrusted: the editor's toolbar is a suggestion,
// not a boundary, and anyone can POST hand-written HTML straight at the Worker. So
// every write path runs the value through `sanitizeRichText` here, which is the
// single authority on what may be stored. It is an allow-list — anything not named
// in RICH_TEXT_TAGS is dropped — so a tag we've never thought of fails closed.
//
// Two properties this file is responsible for:
//
//   1. No stored XSS. The render path (apps/web/src/components/RichText.jsx) injects
//      this HTML with dangerouslySetInnerHTML, so a surviving <script>, an onerror=
//      attribute or a javascript: href would execute in a reader's session. Every
//      attribute is stripped except a validated href.
//   2. No embedded media. Product rule: users may format text, but may not upload or
//      embed images, video, audio or frames. The editor simply has no such buttons,
//      but that only stops honest clients — DROP_TAGS is what actually enforces it,
//      including for media smuggled in as a data: URI.
//
// Sanitizing uses HTMLRewriter, the Workers runtime's native streaming HTML parser.
// That's deliberate: a real parser sees the same tag soup a browser would, whereas a
// regex-based "sanitizer" is the classic way to ship an XSS hole (`<img/src=x
// onerror=...>`, `<scr<script>ipt>`, and so on). It also means no dependency.
//
// The policy itself — the allow-list, the link schemes, what a link is rewritten to
// carry, and the flattening to plain text — is shared with the browser's render-time
// pass in @spelling-creator/core/richText. Only the parser is per-runtime.

import { LINK_REL, LINK_TARGET, MEDIA_TAGS, RICH_TEXT_TAGS, isSafeLink } from '@spelling-creator/core/richText';

// Re-exported so the routes keep importing their rich-text helpers from one place.
export { isRichTextEmpty, richTextToPlain } from '@spelling-creator/core/richText';

const KEEP_TAGS = new Set(RICH_TEXT_TAGS);

// Tags dropped *with their content*, because their content is not prose: script and
// style bodies are code, and the media/embed tags are the ones the product rule
// forbids outright. Everything else unknown (div, span, h1, table...) is unwrapped
// instead — its text is innocent, only the tag is unwanted.
const DROP_TAGS = new Set([
	'script',
	'style',
	'noscript',
	'template',
	'iframe',
	'frame',
	'frameset',
	'object',
	'embed',
	'applet',
	// Media. The product forbids uploading or embedding any of these.
	...MEDIA_TAGS,
	// Interactive/form content has no place in a comment.
	'form',
	'input',
	'button',
	'select',
	'option',
	'textarea',
	'label',
	// Document-level tags, which should never appear in a fragment.
	'html',
	'head',
	'body',
	'meta',
	'link',
	'base',
	'title',
]);

/**
 * Sanitize untrusted rich-text HTML down to the allow-list above. Returns the HTML
 * that is safe to store and later render as HTML.
 *
 * Links that survive are rewritten to carry `rel="nofollow ugc noopener noreferrer"`
 * and `target="_blank"`: user-generated links open away from the app, pass no SEO
 * value to spammers, and cannot reach back through `window.opener`.
 *
 * @param {string} html Untrusted HTML, e.g. straight from a request body.
 * @returns {Promise<string>} Sanitized HTML.
 */
export async function sanitizeRichText(html) {
	const input = typeof html === 'string' ? html : '';
	if (!input) return '';

	const rewriter = new HTMLRewriter()
		// Strip HTML comments everywhere: they carry nothing a user meant to write, and
		// they are a classic parser-confusion vector.
		.onDocument({
			comments(comment) {
				comment.remove();
			},
		})
		.on('*', {
			element(element) {
				const tag = element.tagName.toLowerCase();

				if (DROP_TAGS.has(tag)) {
					// Remove the element *and* its subtree — a <script>'s body is not prose.
					element.remove();
					return;
				}

				if (!KEEP_TAGS.has(tag)) {
					// An unknown-but-harmless wrapper (div, span, h2, table...): drop the tag
					// but keep the text inside it, so a paste from elsewhere loses its layout
					// rather than its words.
					element.removeAndKeepContent();
					return;
				}

				// Read the href before stripping, since removeAttribute mutates the element
				// we would otherwise read it back from.
				const href = tag === 'a' ? element.getAttribute('href') : null;

				// Strip every attribute. This one rule removes onclick=, onerror=, style=,
				// and every attribute we have never heard of, without enumerating them.
				// Snapshot the names first — we are mutating what we iterate.
				for (const name of [...element.attributes].map(([attr]) => attr)) {
					element.removeAttribute(name);
				}

				if (tag === 'a') {
					if (!isSafeLink(href)) {
						// An unusable or hostile link: keep the words, lose the link.
						element.removeAndKeepContent();
						return;
					}
					element.setAttribute('href', href.trim());
					element.setAttribute('target', LINK_TARGET);
					element.setAttribute('rel', LINK_REL);
				}
			},
		});

	return await rewriter.transform(new Response(input)).text();
}
