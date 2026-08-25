// The view behind search_images (see ../src/views.js for the server half).
//
// A Commons search is the one step of authoring that chat is worst at: the
// candidates are pictures, and the assistant can only describe them. This view
// shows them, and turns choosing one into a click — either straight into the
// lesson (when search_images was told which lesson the picture is for) or into a
// message that tells the assistant which file to use.
//
// It runs in a sandboxed iframe with no session and no cookies. It never calls
// the hub API directly: `callServerTool` goes back out through the host to this
// same MCP connection, which is already authenticated, so add_image runs as the
// user with the usual validation and attribution.
//
// Bundled into src/views/imagePicker.html by ../scripts/build-views.mjs.

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

const railEl = document.getElementById("rail");
const summaryEl = document.getElementById("summary");
const statusEl = document.getElementById("status");

const app = new App(
  { name: "Spelling Creator image picker", version: "1.0.0" },
  { availableDisplayModes: ["inline"] },
);

let state = { query: "", images: [], lessonId: "", placement: null };

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// The attribution line Commons requires, kept short enough for a card. The full
// string still travels with the block: add_image sets it as the caption.
function metaLine(image) {
  return [image.license, image.author].filter(Boolean).join(" · ");
}

/** Tell the model what the user just did, so its next turn knows. */
function reportChoice(image, added) {
  const what = added
    ? `added ${image.ref} to lesson ${state.lessonId}`
    : `chose ${image.ref}`;
  return app
    .updateModelContext({
      content: [
        {
          type: "text",
          text:
            `The user ${what} from the image picker for "${state.query}".` +
            (added
              ? " The image block is already in the lesson — don't call add_image for it again."
              : ` Use that ref with add_image. Its caption is: ${image.caption}`),
        },
      ],
    })
    .catch(() => {});
}

async function choose(image, card, button) {
  button.disabled = true;
  setStatus(state.lessonId ? "Adding…" : "Passing your pick along…");
  try {
    if (state.lessonId) {
      const result = await app.callServerTool({
        name: "add_image",
        arguments: {
          lessonId: state.lessonId,
          ref: image.ref,
          ...(state.placement || {}),
        },
      });
      if (result.isError) {
        const detail = result.content?.find((c) => c.type === "text")?.text;
        throw new Error(detail || "The lesson didn't accept that image.");
      }
      card.classList.add("chosen");
      button.textContent = "Added";
      setStatus("Added to the lesson.");
      await reportChoice(image, true);
    } else {
      card.classList.add("chosen");
      button.textContent = "Picked";
      await reportChoice(image, false);
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: `Use ${image.ref} for this lesson.` }],
      });
      setStatus("Picked.");
    }
  } catch (err) {
    button.disabled = false;
    setStatus(err?.message || String(err), true);
  }
}

function card(image) {
  const wrap = el("div", "card");

  const thumb = el("img", "thumb");
  thumb.src = image.previewURL || "";
  thumb.alt = image.description || image.ref;
  thumb.loading = "lazy";
  wrap.append(thumb);

  wrap.append(el("div", "title", image.description || image.ref));
  const meta = metaLine(image);
  if (meta) wrap.append(el("div", "meta", meta));

  const actions = el("div", "actions");
  const chooseBtn = el(
    "button",
    "choose",
    state.lessonId ? "Add to lesson" : "Use this one",
  );
  chooseBtn.addEventListener("click", () => choose(image, wrap, chooseBtn));
  actions.append(chooseBtn);

  if (image.source) {
    const sourceBtn = el("button", "source", "Commons");
    sourceBtn.title = "Open this file's page on Wikimedia Commons";
    sourceBtn.addEventListener("click", () => {
      app.openLink({ url: image.source }).catch(() => {});
    });
    actions.append(sourceBtn);
  }

  wrap.append(actions);
  return wrap;
}

function render() {
  railEl.replaceChildren(...state.images.map(card));
  const count = state.images.length;
  summaryEl.replaceChildren(
    document.createTextNode(`${count} image${count === 1 ? "" : "s"} for `),
    el("strong", null, state.query),
  );
  setStatus(
    state.lessonId
      ? ""
      : "Picking one tells the assistant which file to use — it places the image.",
  );
}

app.ontoolresult = (result) => {
  const data = result.structuredContent;
  if (!data || !Array.isArray(data.images) || !data.images.length) {
    summaryEl.textContent = "No images found.";
    railEl.replaceChildren();
    return;
  }
  state = {
    query: data.query || "",
    images: data.images,
    lessonId: data.lessonId || "",
    placement: data.placement || null,
  };
  render();
};

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  const insets = ctx.safeAreaInsets;
  if (insets) {
    document.body.style.padding =
      `${insets.top || 0}px ${insets.right || 0}px ` +
      `${insets.bottom || 0}px ${insets.left || 0}px`;
  }
}

app.onhostcontextchanged = applyHostContext;
app.onerror = (err) => setStatus(err?.message || String(err), true);

app.connect().then(() => {
  applyHostContext(app.getHostContext());
  // Keeps the host's container in step with the card rail's real height.
  app.setupSizeChangedNotifications();
});
