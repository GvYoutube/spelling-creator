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
// Parsing uses parse5, a WHATWG-conformant HTML parser. Using a real parser is the
// non-negotiable part: it sees the same tag soup a browser would, whereas a
// regex-based "sanitizer" is the classic way to ship an XSS hole (`<img/src=x
// onerror=...>`, `<scr<script>ipt>`, and so on).
//
// It used to be HTMLRewriter, the Workers runtime's own streaming parser. parse5
// replaced it for one reason: it runs in every runtime, and HTMLRewriter runs in
// one. A self-hosted instance would otherwise need a second sanitizer, and two
// implementations of a security boundary that have to agree is a worse thing to own
// than a dependency — the drift would be silent, and it would be an XSS hole. The
// browser's render-time DOMPurify pass stays as it is: that one is defence in depth
// against rows written by an older Worker, not a second copy of this policy.
//
// The policy itself — the allow-list, the link schemes, what a link is rewritten to
// carry, and the flattening to plain text — is shared with the browser's render-time
// pass in @spelling-creator/core/richText. Only the parser is per-runtime, and now
// it need not even be that.

import { parseFragment, serialize } from 'parse5';

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

/** parse5 marks a node's kind with `nodeName`; these two are not elements. */
const TEXT_NODE = '#text';
const COMMENT_NODE = '#comment';

/**
 * How deeply nested an element may be before it is flattened to its text.
 *
 * This is a real limit, not a formality. The routes cap raw input at 20,000
 * characters, and `<b>` is three of them — so a caller can hand us a tree nearly
 * 7,000 levels deep, which is enough to exhaust the JavaScript stack in any
 * tree-shaped walk, this file's or parse5's serializer's. The streaming parser
 * this replaced never had to care; a tree-building one does.
 *
 * 100 is far past anything real: the editor's deepest possible output is a mark
 * inside a paragraph inside a list item inside a list inside a blockquote, which
 * is five. Anything past the limit keeps its words and loses its tags, which is
 * what happens to unrecognised markup everywhere else in this file.
 */
const MAX_DEPTH = 100;

/**
 * The value of one attribute on a parse5 element, matched by local name
 * regardless of namespace prefix.
 *
 * Namespace-insensitive on purpose: inside foreign content a browser will honour
 * `xlink:href`, and reading only the unprefixed name would miss it. Nothing that
 * carries a prefixed href survives this sanitizer today — the foreign-content
 * roots (`svg`, `math`) are dropped with their subtrees — but the lookup should
 * not be the reason that holds.
 */
function attributeValue(node, name) {
	const found = (node.attrs || []).find((attr) => attr.name.toLowerCase() === name);
	return found ? found.value : null;
}

/** Whether a node is an element this sanitizer removes along with its subtree. */
const isDropped = (node) => Boolean(node.tagName) && DROP_TAGS.has(node.tagName.toLowerCase());

/** A parse5 text node holding `value`. */
const textNode = (value) => ({ nodeName: TEXT_NODE, value, parentNode: null });

/**
 * Every word inside a subtree, with all markup discarded.
 *
 * Used only past MAX_DEPTH, and iterative for exactly the reason the depth limit
 * exists — the thing it is called on is by definition too deep to recurse over.
 * Dropped subtrees stay dropped: a `<script>` body is not text we want promoted
 * into the document just because it was buried deeply enough.
 */
function subtreeText(root) {
	let text = '';
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node.nodeName === TEXT_NODE) {
			text += node.value;
			continue;
		}
		if (isDropped(node)) continue;
		const children = node.childNodes || [];
		// Pushed in reverse so popping walks them left to right.
		for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
	}
	return text;
}

/**
 * The list of nodes that should stand in `node`'s place — empty to drop it, one
 * node to keep it, or its children to unwrap it.
 *
 * `resolved` holds the already-computed replacement for each child, which is why
 * the caller has to work bottom-up. Returning a list is what makes unwrapping
 * fall out for free: an unknown wrapper returns its own transformed children and
 * the parent splices them in where it stood.
 */
function replacementFor(node, depth, resolved) {
	// Anything that is neither text, comment nor a named element — a doctype, a
	// stray document node — has no place in stored prose. The fragment root has no
	// tagName either, so it is exempted by the caller rather than here.
	const tag = node.tagName ? node.tagName.toLowerCase() : '';
	if (!tag) return [];
	if (DROP_TAGS.has(tag)) return [];

	// Past the limit the subtree was never walked, so there is nothing to splice —
	// keep its words as one flat text node and drop every tag it contained.
	if (depth >= MAX_DEPTH) {
		const text = subtreeText(node);
		return text ? [textNode(text)] : [];
	}

	const children = [];
	for (const child of node.childNodes || []) {
		// Comments carry nothing a user meant to write, and are a classic
		// parser-confusion vector. Dropped everywhere.
		if (child.nodeName === COMMENT_NODE) continue;
		if (child.nodeName === TEXT_NODE) {
			children.push(child);
			continue;
		}
		children.push(...(resolved.get(child) || []));
	}

	if (!KEEP_TAGS.has(tag)) {
		// An unknown-but-harmless wrapper (div, span, h2, table...): drop the tag
		// but keep the text inside it, so a paste from elsewhere loses its layout
		// rather than its words.
		return children;
	}

	// Read the href before stripping, since the strip is what we would otherwise
	// read it back from.
	const href = tag === 'a' ? attributeValue(node, 'href') : null;

	// Strip every attribute. This one rule removes onclick=, onerror=, style=, and
	// every attribute we have never heard of, without enumerating them.
	node.attrs = [];

	if (tag === 'a') {
		if (!isSafeLink(href)) {
			// An unusable or hostile link: keep the words, lose the link.
			return children;
		}
		// Links that survive open away from the app, pass no SEO value to spammers,
		// and cannot reach back through `window.opener`.
		node.attrs = [
			{ name: 'href', value: href.trim() },
			{ name: 'target', value: LINK_TARGET },
			{ name: 'rel', value: LINK_REL },
		];
	}

	node.childNodes = children;
	for (const child of children) child.parentNode = node;
	return [node];
}

/**
 * Transform a parsed fragment in place, returning its new child list.
 *
 * Iterative rather than recursive, because the input's nesting depth is chosen by
 * whoever sent it — see MAX_DEPTH. The walk is pre-order into an array, then run
 * back to front: the reverse of a pre-order traversal reaches every node before
 * its parent, which is the ordering a bottom-up rewrite needs, without a second
 * tree walk or a visited flag on the nodes themselves.
 */
function transformFragment(root) {
	/** @type {{ node: object, depth: number }[]} */
	const preorder = [];
	const stack = [{ node: root, depth: 0 }];
	while (stack.length > 0) {
		const frame = stack.pop();
		preorder.push(frame);
		// Never descend into a subtree that is going to be removed wholesale, and
		// never descend past the limit — both of those are handled where the node's
		// replacement is computed.
		if (frame.depth >= MAX_DEPTH || isDropped(frame.node)) continue;
		const children = frame.node.childNodes || [];
		for (let i = children.length - 1; i >= 0; i -= 1) {
			const child = children[i];
			// Text and comments are leaves; their handling is inlined above, so they
			// never need a frame of their own.
			if (child.nodeName === TEXT_NODE || child.nodeName === COMMENT_NODE) continue;
			stack.push({ node: child, depth: frame.depth + 1 });
		}
	}

	const resolved = new Map();
	for (let i = preorder.length - 1; i >= 1; i -= 1) {
		const { node, depth } = preorder[i];
		resolved.set(node, replacementFor(node, depth, resolved));
	}

	// The root is the fragment itself, which is kept — only its children change.
	const children = [];
	for (const child of root.childNodes || []) {
		if (child.nodeName === COMMENT_NODE) continue;
		if (child.nodeName === TEXT_NODE) {
			children.push(child);
			continue;
		}
		children.push(...(resolved.get(child) || []));
	}
	return children;
}

/**
 * Sanitize untrusted rich-text HTML down to the allow-list above. Returns the HTML
 * that is safe to store and later render as HTML.
 *
 * Links that survive are rewritten to carry `rel="nofollow ugc noopener noreferrer"`
 * and `target="_blank"`: user-generated links open away from the app, pass no SEO
 * value to spammers, and cannot reach back through `window.opener`.
 *
 * Async, though nothing in it awaits: every caller already awaits it (it used to
 * wrap a streaming parser), and the boundary is a bad place for a signature change
 * whose only benefit is cosmetic — a missed `await` here would store a Promise's
 * stringification as somebody's comment.
 *
 * @param {string} html Untrusted HTML, e.g. straight from a request body.
 * @returns {Promise<string>} Sanitized HTML.
 */
export async function sanitizeRichText(html) {
	const input = typeof html === 'string' ? html : '';
	if (!input) return '';

	// Parsed as a fragment, as the browser does for innerHTML, so the input is
	// treated as body content rather than a whole document — an implied <html> or
	// <head> would otherwise be invented around it and then dropped.
	const fragment = parseFragment(input);
	fragment.childNodes = transformFragment(fragment);
	return serialize(fragment);
}
