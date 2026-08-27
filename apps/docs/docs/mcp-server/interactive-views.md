---
title: Interactive views (MCP Apps)
---

# Interactive views (MCP Apps)

Everything the [tools](./tools.md) do happens in the assistant's chat window. The
assistant describes the lesson it wrote, lists image candidates as text, hands over a
URL to a proposal and asks the user to go read it. The maker itself — the thing with the
editor, the section layout, the picture — is somewhere the user has to go **next**, in
another tab, after the conversation.

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) closes that gap. It
is the first official MCP extension (SEP-1865, stable 2026-01-26), and it lets a server
return a small **interactive interface** alongside a tool's result: the host fetches an
HTML resource the server declares and renders it inline in the conversation — in a
sandboxed iframe on web and desktop, and in a native WebView on mobile, which is the same
sandbox from the view's side but not the same renderer. Claude supports it for custom
connectors as well as directory ones, and over both of this server's transports: a
[remote](./remote-mode.md) connection, and a local stdio one in the desktop app.

The point is not decoration. It's that the parts of authoring that are genuinely visual —
choosing a photograph, reading a diff, seeing which of fifteen questions failed
validation — stop being described and start being **shown, in place**, without leaving
the conversation the lesson is being written in.

## Where this stands

`search_images` ships a view: the candidates come back as a picker instead of a text
list, and choosing one calls `add_image` directly. Everything else is text-only and
works exactly as documented in [Tools](./tools.md). See
[The rest of the surface](#the-rest-of-the-surface) for what's next and why.

Nothing here is required. A host that doesn't do MCP Apps — Claude Code in a terminal,
say — never reads the `ui://` resource and gets the same text result it always did; the
`_meta.ui` a tool carries is simply inert to it. That's why the server registers views
unconditionally rather than branching on the capability. The text path stays the
contract; views are an enhancement on top of it.

What a tool **says** does branch, in exactly one place, and it's worth knowing why. See
[Say the right thing to each client](#say-the-right-thing-to-each-client).

## How it fits together

```text
   MCP server                    Host (Claude)                  View (iframe)
   ──────────                    ─────────────                  ─────────────
   tool + ui:// resource   ──▶   fetches the resource     ──▶   renders
                                 renders the sandbox
   tools/call              ◀──   proxies the call         ◀──   user picks something
```

Three things follow from that shape, and they're the whole design:

**The view is a bundle this server ships**, not the maker in an iframe. That's not a
preference — Claude's sandbox applies `frame-src 'self' blob: data:` and the spec's
`frameDomains` escape hatch is
[restricted in Claude pending security review](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines#content-security-policy).
So a view is a self-contained HTML document served from a `ui://` URI, built here and
inlined into the server the same way [`standards.md`](./overview.md) is.

**The view calls tools, not the API.** It has no Supabase session and no cookies — it's a
sandboxed frame on an opaque origin. But the MCP connection it hangs off is already
authenticated ([remote mode](./remote-mode.md)'s OAuth grant, or the stdio server's
token), so a `tools/call` from the view runs as the same user with the same validation
and attribution as one from the model. Nothing new to authorise, and no second auth path
to keep safe. The picker calls the ordinary `add_image` this way; a tool that existed
only to serve a view could go further and declare `visibility: ["app"]`, which hides it
from the model altogether so it never takes up room in the context.

Proxying is a capability the host declares (`serverTools`), though, and a view has to read
it rather than assume it — the picker checks before it offers a button that would place an
image, and falls back to telling the assistant which file was chosen when the host won't
carry the call.

**What the user does in the view goes back to the model.** A view can push a note into
the model's context (`ui/update-model-context`) or send a follow-up turn
(`ui/message`), so a choice made by clicking is a thing the assistant knows about and can
build on — rather than a silent side effect it then contradicts. It can also ask the host
to open a link (`ui/open-link`), which is how a view hands off to the real maker for work
that belongs there.

## Say the right thing to each client

A view changes who is doing the work, and a tool result that ignores that fights it.

`search_images` returns a list of photographs. In a terminal that list is addressed to the
assistant, because the assistant is the only one who can act on it — "choose the best
`ref` and call `add_image`" is the correct and only useful thing to say. Send those same
words to a host that just drew twelve cards and the assistant does what it was told: it
picks from prose descriptions of images it cannot see, adds one, and reports it — while
the user is still reading the picker. The picker didn't fail; it was talked over. The
choice it existed to hand across was taken back a second before the user could make it.

So the tool asks who is looking, through `rendersViews()` in `src/views.js`:

```js
const ui = getUiCapability(server.server.getClientCapabilities());
```

That reads the `io.modelcontextprotocol/ui` entry the host declared at initialisation —
the same negotiation that decides whether the view is fetched at all — and when it's
there, `search_images` leads its result with an instruction to stop: end the turn, add
nothing, wait to be told what the user clicked. The candidates still follow, in the text
block and in `structuredContent` alike, so the model can still answer "the fox one, please"
without searching again. Only the instruction changes.

Two things about the shape of that, both learned the hard way:

- **The instruction goes first, as its own content block.** A rule appended to a JSON blob
  is a rule read after the model has already met the list and decided what to do with it.
- **It has to be blunt.** "The user may pick one" reads as permission to pick first. What
  works is naming the stop and the reason: they can see the pictures, you cannot.

The same applies to any future view: what the model is told has to match what the user can
already see, or the two race. Registration stays unconditional — the branch belongs in the
words, not in the wiring.

## Writing a view

A view's source is `apps/mcp/views/<name>.{html,js}`, built by
`pnpm --filter @spelling-creator/mcp build:views` into one self-contained
`src/views/<name>.html` — bundle inlined, nothing left to fetch. That output is committed,
so the server keeps having no build step of its own; see
[Development](./development.md) for why and when to rebuild. Registration uses
[`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps)'s
server helpers rather than raw `_meta`:

- `registerAppTool` registers the tool and links it to its UI with
  `_meta.ui.resourceUri`.
- `registerAppResource` serves the HTML under a `ui://` URI with the
  `text/html;profile=mcp-app` mime type.

A few host-specific requirements are worth stating plainly, because getting them wrong
fails **silently** — Claude reports that a widget rendered and then shows nothing:

- **Set `_meta.ui.domain`** to
  `sha256("<the /mcp endpoint URL>").slice(0, 32) + ".claudemcpcontent.com"`. It's
  deterministic and self-computed, not a credential — it gives the view a stable origin,
  which is also what an API would allowlist for CORS if a view ever needed to fetch one
  directly. The documented purpose is that CORS case, but Claude is widely reported to
  fetch the resource, announce that a widget rendered, and then show nothing when the
  field is missing, so treat it as required.
- **Inline everything.** Scripts pulled from a CDN at runtime are blocked unless their
  origin is declared in `_meta.ui.csp.resourceDomains`, and have been observed to crash
  the view mid-load even then. The build produces one file with no external references.
- **Version the `ui://` URI** when a view's markup changes shape. Hosts cache resources
  independently of the server, and an old client holding an old template must keep
  working — so serve the old URI as well as the new one rather than mutating one in
  place.

Beyond that, Claude's
[design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines)
are worth following closely, since they're what makes a view feel like part of the
product rather than an embedded web page: use the host's CSS custom properties
(`--color-background-primary`, `--font-text-md-size`, `--border-radius-md`, …) instead of
hardcoded colours so light and dark mode both work; keep inline cards to their content
height with no nested vertical scrolling, since on mobile a vertical drag inside a view
scrolls the conversation rather than the view; prefer visible controls to dropdowns and
popovers, which get clipped by the container; and use skeletons rather than spinners
while loading — the same rule the [web app](/web-app/overview) follows.

## Trying one without a host

A view can't be exercised from the test suite — that needs something to render it. So
`test/views.test.js` covers the half that a connection can see, through an in-memory MCP
client: that the `ui://` resource is listed and readable, under the mime type hosts look
for, self-contained, carrying the origin and the CSP entry, with the tool's `_meta`
pointing at it. That's the wiring a host silently refuses to render without, and all of it
is checkable without ever rendering anything.

The capability branch is checkable there too, and is: a client that declares
`io.modelcontextprotocol/ui` gets the hands-off result, a plain one still gets "choose the
best `ref`". Both are only what a `tools/call` returns, so neither needs a renderer.

The view's own behaviour — that it draws the candidates, that a click calls `add_image`
with the right arguments, that it degrades when the host won't proxy that call — is
checked by hand against a host. The two ways to get one:

- **A stub host.** A page that iframes the built HTML, answers `ui/initialize` with a
  `hostContext`, then sends the tool result as a `ui/notifications/tool-result`
  notification is enough to render the view and watch the `tools/call` it sends back. Fast
  to throw together, and it will catch the things that actually break — a corrupted
  bundle, a card that wraps, a click that sends the wrong arguments.
- **A real one.** The [ext-apps repo](https://github.com/modelcontextprotocol/ext-apps)
  ships `examples/basic-host`, and Claude Desktop renders a local stdio server directly
  (or a remote one through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)).

## The rest of the surface

`search_images` went first because it is the interaction chat is worst at: picking a
photograph from prose descriptions of photographs. The rest, roughly in order of how much
a view would buy:

| Tool                                        | View                                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `propose_changes` / `list_lesson_proposals` | The diff, with merge and decline in place                         |
| `create_lesson` / `patch_lesson`            | The lesson as the maker lays it out, with its validation findings |
| `list_my_lessons` / `list_hub_lessons`      | A browsable card list rather than a text table                    |

The proposals one is the most interesting, because the text version has a shape a view
would delete outright: `propose_changes` today hands over a URL, tells the assistant to
stop, and offers polling as the way to find out what the human decided. A view is that
whole exchange, in the conversation, resolved by a click.

## Alternatives considered

**Deep links that arrive signed in.** Tools already return a `url` for the lesson or
proposal they touched, but following one can land on a login wall, and lands on the
lesson's page rather than at the thing that just changed. A short-lived signed ticket on
that URL would open the maker at the right place, already authenticated. It doesn't
compete with views — it's what makes leaving the conversation cheap, and it's the only
lever available in a client that renders no UI at all.

**Pairing with a live maker tab.** The web app already has
[live collaboration](/web-app/live-collaboration): a `CollabRoom` Durable Object,
server-verified Supabase identity, and CRDT merging per field. An MCP server that joined
that room as a participant would let a user keep the maker open and watch the
assistant's edits land while they type alongside them — the strongest "built in" feeling
available here, and the one that needs no view bundle at all. It is also the largest
piece of work, since it means speaking the room's binary protocol from the server side.

**Bringing the assistant into the maker.** The inverse: an agent loop in `apps/api` over
this same tool layer, driving a chat panel in the editor. That's a different product
decision, not a protocol one — it changes who pays for the model, where the existing
Turnstile-gated [AI helpers](/web-app/ai-text-suggestions) fit, and how much of the
assistant's behaviour this repo owns.
