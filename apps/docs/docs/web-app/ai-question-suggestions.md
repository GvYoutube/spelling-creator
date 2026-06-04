---
title: AI question suggestions
sidebar_position: 5
---

# AI question suggestions

Press **AI question** on any section to open a dialog that suggests a structured
question block. It uses the same Turnstile-verified Worker as the text
suggester, just in a different mode. The flow:

1. Pick a question type (the same five types as the **Add question** menu).
2. The section title is used as the subject; the section's existing text is sent
   as context so the question is answerable from the lesson.
3. Turnstile verifies the request, then the verified token, subject, type, and
   context are POSTed to the Worker with `mode: "question"`.
4. The Worker asks the model for JSON matching that question type (prompt,
   options, answer, etc.) and returns it.
5. The suggestion is inserted as a new, fully editable question block of that
   type, with option indexes mapped back onto option ids in
   `src/lib/questions.js`.
