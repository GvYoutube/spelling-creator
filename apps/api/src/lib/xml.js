/** XML-escape a value for safe inclusion in a `<loc>` (sitemap) or feed element. */
export function xmlEscape(value) {
	return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
