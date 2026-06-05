---
title: AI text suggestions
sidebar_position: 4
---

# AI text suggestions

Press **AI text** on any section to open a dialog that generates a block of
lesson text about that section's title. The flow:

1. The section title is used as the subject — there's no separate prompt to fill in.
2. A [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) widget
   verifies the request is coming from a real browser on our domain.
3. The verified token, subject, and document title are POSTed to the companion
   Cloudflare Worker (`apps/api`), which re-checks the token
   server-side before doing any AI work and returns the generated text.
4. The generated text is shown for review; pressing **Insert** adds it as a new
   text block in the section, ready to edit.

The Worker caches text suggestions, so asking about the same subject again
returns the same answer instantly without a billable AI call. A **signed-in**
user who doesn't like a suggestion can **thumbs-down** it: that calls the
Worker's `POST /ai-text/dislike` (gated by a Supabase JWT, like publishing),
which evicts the cached answer so the next try is written fresh. After a
dislike the dialog offers an immediate **Generate fresh** from the now-cleared
cache. Sign-in is required because the action mutates the shared server cache.

This feature requires two environment variables (see [Getting started](./getting-started.md)). The
Worker lives alongside this app in the monorepo at `apps/api`; the frontend only
talks to its HTTP endpoint.
