---
title: Save to Google Docs
sidebar_position: 7
---

# Save to Google Docs

Press **Save to Google Docs** in the toolbar to upload the current lesson straight
to the signed-in user's Google Drive as an editable Google Doc. The flow is
entirely client-side:

1. [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/overview)
   issues a short-lived OAuth2 access token, prompting the user to sign in and
   consent the first time.
2. The app builds the same docx as **Export DOCX**, then uploads it to the Drive
   `files` endpoint as `multipart/related`, asking Drive to store it as
   `application/vnd.google-apps.document` so it is converted to a Google Doc.
3. On success a toast offers an **Open** link to the new doc.

The app requests only the [`drive.file`](https://developers.google.com/drive/api/guides/api-specific-auth)
scope, so it can touch only the files it creates — never the user's existing
Drive contents. The button is hidden unless `VITE_GOOGLE_CLIENT_ID` is set (see
[Environment variables](./getting-started.md#environment-variables)). The OAuth client must list every origin the app is
served from (e.g. `http://localhost:5173` and the production URL) under
**Authorised JavaScript origins**, and the Google Drive API must be enabled for
the project.
