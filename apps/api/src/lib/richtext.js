// Rich text — the shared contract for the two places users author formatted
// content: lesson comments and profile bios. Both are written in the browser with
// mui-tiptap (see apps/web/src/components/RichTextInput.jsx) and stored as HTML.
//
// HTML arriving from a browser is untrusted: the editor's toolbar is a suggestion,
// not a boundary, and anyone can POST hand-written HTML straight at the Worker. So
// every write path runs the value through `sanitizeRichText` here, which is the
// single authority on what may be stored. It is an allow-list — anything not named
// in KEEP_TAGS is dropped — so a tag we've never thought of fails closed.
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

// The formatting a user may keep. Deliberately small: the marks and blocks the
// editor's toolbar can produce, and nothing else. `b`/`i` are here because pasted
// content often carries them (tiptap normalises its own output to strong/em).
const KEEP_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a']);

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
	'img',
	'picture',
	'source',
	'video',
	'audio',
	'track',
	'canvas',
	'svg',
	'math',
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

// The only schemes a stored link may use. `javascript:` executes; `data:` is an HTML
// and media smuggling channel (`data:text/html,...`, `data:image/png;base64,...`), so
// both are rejected along with anything else exotic. Relative and protocol-relative
// hrefs are rejected too — user-generated links point outward, at real destinations.
const LINK_PROTOCOLS = /^(?:https?:|mailto:)/i;

// Characters browsers ignore inside a URL scheme. `java\tscript:alert(1)` navigates
// perfectly well while sailing past a naive prefix check, so strip these before
// testing the scheme. Matching control characters is precisely the point here, which
// is what no-control-regex objects to — hence the deliberate exemption.
// eslint-disable-next-line no-control-regex
const URL_IGNORED_CHARS = /[\u0000-\u0020]/g;

/**
 * Whether a link target is safe to store.
 * @param {string} href
 * @returns {boolean}
 */
function isSafeLink(href) {
	const value = typeof href === 'string' ? href.trim() : '';
	if (!value) return false;
	return LINK_PROTOCOLS.test(value.replace(URL_IGNORED_CHARS, ''));
}

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
					element.setAttribute('target', '_blank');
					element.setAttribute('rel', 'nofollow ugc noopener noreferrer');
				}
			},
		});

	return await rewriter.transform(new Response(input)).text();
}

// Named entities that survive sanitizing and matter when we flatten to text.
const ENTITIES = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&apos;': "'",
	'&nbsp;': ' ',
};

/**
 * Flatten rich-text HTML to plain text.
 *
 * Everything downstream of storage wants text, not markup: the profanity filter (which
 * must scan words, not tag names), the length limit (which should bound what a user
 * *wrote*, not how much markup it took), the Atom feed's <summary>, notification
 * bodies, and meta descriptions. Rendering markup into any of those shows readers a
 * mouthful of angle brackets.
 *
 * Safe to run on legacy plain-text values too — every comment and bio written before
 * rich text is a bare string, and one with no tags passes through unchanged.
 *
 * @param {string} html
 * @returns {string} Plain text, with block boundaries collapsed to newlines.
 */
export function richTextToPlain(html) {
	const input = typeof html === 'string' ? html : '';
	if (!input) return '';

	return (
		input
			// Block boundaries become line breaks so words don't run together.
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(?:p|div|li|blockquote|pre|h[1-6]|tr)\s*>/gi, '\n')
			.replace(/<[^>]*>/g, '')
			.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
			.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
			.replace(/&[a-z]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
			// Collapse runs of spaces (including the non-breaking ones just decoded), then
			// tidy the line breaks the block rules introduced.
			.replace(/[^\S\n]+/g, ' ')
			.replace(/ ?\n ?/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim()
	);
}

/**
 * Whether a rich-text value carries no actual words. An "empty" editor still emits
 * markup (`<p></p>`), so a plain `!html` check would happily store a blank comment.
 * @param {string} html
 * @returns {boolean}
 */
export function isRichTextEmpty(html) {
	return richTextToPlain(html) === '';
}
