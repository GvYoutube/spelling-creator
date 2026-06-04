---
title: Search images
sidebar_position: 6
---

# Search images

Press **Search images** on any section to open a dialog that searches
[Pixabay](https://pixabay.com) for free images and inserts the one you pick as
an image block. Like the AI features, it goes through the companion
`spelling-creator-cf` Worker rather than calling Pixabay directly, which:

- keeps the Pixabay API key server-side (it is never shipped to the browser),
- lets the Worker enforce Pixabay's **100 requests/minute** limit centrally, and
- works around Pixabay's image CDN sending no CORS headers — the browser can't
  read an image's bytes itself, so the Worker downloads the chosen image and
  returns it as a data URL that drops straight into the DOCX/PDF export.

The flow:

1. Type a search term; a [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/)
   token (the same widget as the AI dialogs) is sent with the request.
2. The Worker verifies the token, calls the Pixabay API with `mode:
"imageSearch"`, and returns normalised hits (preview/webformat URLs, size,
   tags). It edge-caches the Pixabay response for 24 hours, which both satisfies
   Pixabay's caching requirement and keeps request counts well under the limit.
3. Click a result; the app calls the Worker again with `mode: "imageFetch"`,
   which downloads that image and returns it as a data URL.
4. The image is inserted as a new image block, with its caption pre-filled with
   attribution (`Image by {photographer} from Pixabay`) — editable like any other.

Each Worker call consumes its single-use Turnstile token, so the widget is reset
to mint a fresh one between searching and inserting. This feature needs the same
`VITE_API_URL` / `VITE_TURNSTILE_SITE_KEY` as the AI features, plus a
`PIXABAY_API_KEY` secret **on the Worker** (`wrangler secret put PIXABAY_API_KEY`).
