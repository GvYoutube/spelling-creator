# Spelling Lesson Maker

A web app for building and printing [**Spelling**](https://i-asc.org) (also known
as S2C) lessons. Create a document, add named sections, and fill each section with
text and images. Export the finished lesson as a Word document (`.docx`) or print
it to PDF.

Built with **React + Vite + shadcn/ui + Tailwind**, using [`docx`](https://docx.js.org) for Word
export and [`html2pdf.js`](https://github.com/eKoopmans/html2pdf.js) (via
[`mammoth`](https://github.com/mwilliamson/mammoth.js) docx→HTML conversion) for
PDF printing.

## Documentation

Full documentation lives on the docs site under **Web App**:
**https://spellingcreator.org/docs/web-app/overview**

- [Overview & features](https://spellingcreator.org/docs/web-app/overview)
- [Pages & routing](https://spellingcreator.org/docs/web-app/pages-and-routing)
- [Question blocks](https://spellingcreator.org/docs/web-app/question-blocks)
- [AI text suggestions](https://spellingcreator.org/docs/web-app/ai-text-suggestions)
- [AI question suggestions](https://spellingcreator.org/docs/web-app/ai-question-suggestions)
- [AI lesson ideas](https://spellingcreator.org/docs/web-app/ai-lesson-ideas)
- [Search images](https://spellingcreator.org/docs/web-app/search-images)
- [Save to Google Docs](https://spellingcreator.org/docs/web-app/save-to-google-docs)
- [Live collaboration](https://spellingcreator.org/docs/web-app/live-collaboration)
- [Lesson hub & accounts](https://spellingcreator.org/docs/web-app/lesson-hub-and-accounts)
- [Profiles & display names](https://spellingcreator.org/docs/web-app/profiles-and-display-names)
- [Notifications](https://spellingcreator.org/docs/web-app/notifications)
- [Moderation](https://spellingcreator.org/docs/web-app/moderation)
- [Getting started & environment variables](https://spellingcreator.org/docs/web-app/getting-started)
- [How the export pipeline works](https://spellingcreator.org/docs/web-app/export-pipeline)
- [Project structure](https://spellingcreator.org/docs/web-app/project-structure)
- [Installable app & offline use](https://spellingcreator.org/docs/web-app/pwa-and-offline)

The docs source is in `apps/docs/docs/web-app`.

## Quick start

```bash
pnpm install
pnpm dev      # start the dev server (http://localhost:5173)
pnpm build    # production build into dist/
pnpm preview  # preview the production build
```

See **[Getting started](https://spellingcreator.org/docs/web-app/getting-started)**
for the environment variables each feature needs.
