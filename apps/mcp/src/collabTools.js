// The tools that put an assistant into a live collaboration session.
//
// These are registered only on a transport that can hold a socket open between
// tool calls — stdio, in practice. The remote (Worker) transport builds a fresh
// McpServer per request and has nowhere to keep a session, so registerTools
// leaves them out there rather than advertising tools that could never work.
//
// One session at a time, held in this closure. An assistant with two sessions
// open has no way to say which one it means, and the room caps a session at ten
// participants anyway; the tools all speak about "the session" for that reason.
//
// The session client itself is collab.js — this file is the MCP surface over it:
// schemas, the authoring standard, and results written for a model that cannot
// see the teacher's screen.

import { z } from "zod";

import { applyPatch } from "./patch.js";
import { joinSession, canJoinSessions, NO_WEBSOCKET } from "./collab.js";

/** The blocks a set of patch operations would touch, by id. */
function touchedBlocks(operations) {
  const ids = [];
  for (const op of operations) {
    if (typeof op?.blockId === "string") ids.push(op.blockId);
  }
  return ids;
}

/**
 * Attach the session tools.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ config: any, auth: any, text: Function, tool: Function, standardFindings: Function }} ctx
 */
export function registerCollabTools(server, ctx) {
  const { config, auth, text, tool } = ctx;

  // The one live session, or null. Deliberately module-free state: it belongs to
  // this server process and dies with it.
  let session = null;

  const wsUrl = async (code) => {
    const base = config.apiUrl.replace(/^http/, "ws");
    const token = await auth.getAccessToken();
    if (!token) {
      throw new Error(
        "Not signed in, so there is no identity to join a session as. Run the `login` helper or set " +
          "SUPABASE_REFRESH_TOKEN, then check with whoami.",
      );
    }
    return `${base}/collab/${encodeURIComponent(code)}?token=${encodeURIComponent(token)}`;
  };

  /** The live session, or a clear error naming what to do instead. */
  const live = () => {
    if (!session || session.closed) {
      throw new Error(
        session
          ? `The collaboration session ended (${session.closedReason}). Join again with join_collab_session if the ` +
              "host is still hosting one, or edit the saved lesson through the hub with patch_lesson."
          : "Not in a collaboration session. Call join_collab_session with the host's share code first. To edit a " +
              "lesson that is saved on the hub instead, use patch_lesson.",
      );
    }
    return session;
  };

  /** The roster and any chat waiting, folded into every result. */
  const roomState = (s) => {
    const chat = s.drainChat();
    return {
      participants: s.participants.map((p) => ({
        name: p.name,
        host: Boolean(p.host),
      })),
      ...(chat.length ? { chat } : {}),
    };
  };

  server.registerTool(
    "join_collab_session",
    {
      title: "Join a live collaboration session",
      description:
        "Join a lesson the user is editing live in the web app, as a participant in the session — the same way " +
        "another teacher would. Ask them to click Collaborate in the editor and read you the share code.\n\n" +
        "WHY THIS AND NOT get_lesson: a live session's document exists only in the session until somebody saves " +
        "it, so the copy on the hub is whatever it was before they started. While a session is running this is the " +
        "real lesson, and patch_lesson would be editing a stale copy that their next save overwrites.\n\n" +
        "THE HOST HAS TO ADMIT YOU. This waits up to two minutes for them to accept the request in the " +
        "collaboration dialog — tell them to expect it. If they decline, that is their answer; don't rejoin " +
        "unless they ask.\n\n" +
        "Once in, you are a visible participant: your edits appear live under their own name, the user watches " +
        "them land, and they can remove you at any moment. Read the lesson with read_collab_doc, change it with " +
        "edit_collab_doc, and talk to the room with send_collab_chat — ask there rather than guessing, since the " +
        "user is right there.",
      inputSchema: {
        code: z
          .string()
          .describe(
            "The session's share code, from the Collaborate dialog in the web editor.",
          ),
      },
    },
    tool(async ({ code }) => {
      if (!canJoinSessions()) throw new Error(NO_WEBSOCKET);
      if (session && !session.closed) {
        throw new Error(
          `Already in session "${session.code}". Call leave_collab_session before joining another — one at a time, ` +
            "so there is never a question about which session an edit is going to.",
        );
      }

      session = await joinSession({ url: await wsUrl(code), code });
      const doc = session.doc();
      return text({
        joined: code,
        title: doc.title,
        sections: (doc.sections || []).map((s, i) => ({
          number: i + 1,
          id: s.id,
          name: s.name,
          blocks: (s.blocks || []).length,
        })),
        ...roomState(session),
        note:
          "You are in the session and this is the live lesson. Anything you change with edit_collab_doc appears " +
          "on their screen as you make it, so make one deliberate edit at a time rather than rewriting in a " +
          "burst — and say what you are doing in the chat.",
      });
    }),
  );

  server.registerTool(
    "read_collab_doc",
    {
      title: "Read the live lesson",
      description:
        "The lesson as the session holds it right now, including edits the user has just made and anything not " +
        "yet saved. Read this before editing rather than trusting an earlier copy — in a live session the " +
        "document moves under you. Also returns anything said in the session's chat since you last looked.",
      inputSchema: {},
    },
    tool(async () => {
      const s = live();
      return text({ doc: s.doc(), ...roomState(s) });
    }),
  );

  server.registerTool(
    "edit_collab_doc",
    {
      title: "Edit the live lesson",
      description:
        "Change the lesson in the session, with the same operations as patch_lesson (call read_collab_doc first " +
        "for the current section and block ids). The edit is merged into the shared document and appears on " +
        "everyone's screen immediately.\n\n" +
        "The session is a CRDT, so your edits and the user's merge as long as they are in different places — but " +
        "two people writing the SAME field is still last-write-wins, and the loser is whoever typed first. So " +
        "this refuses a block another participant's cursor is sitting in: leave it, or ask them in the chat to " +
        "move off it.\n\n" +
        "Nothing here is saved to the hub. The session's document is the user's to keep — they save it from the " +
        "editor — so don't call update_lesson or patch_lesson to 'finish the job'; that writes to the stale copy " +
        "and their next save discards it.\n\n" +
        "The result is checked against the authoring standard and reports what your edit breaks, but it does NOT " +
        "reject: this is the user's live document, and refusing to make a change they asked for because a " +
        "different section is off-standard would be worse than telling them about it.",
      inputSchema: {
        operations: z
          .array(z.record(z.any()))
          .min(1)
          .describe(
            "patch_lesson's operations, applied in order (set_title, set_section_name, add_section, " +
              "remove_section, move_section, add_block, replace_block, remove_block, move_block).",
          ),
      },
    },
    tool(async ({ operations }) => {
      const s = live();

      // Checked at the moment of the edit, not cached: a cursor a second old is
      // a guess about where somebody is now.
      const busy = s.busyBlocks();
      const clashes = touchedBlocks(operations)
        .filter((id) => busy.has(id))
        .map((id) => ({ blockId: id, editedBy: busy.get(id) }));
      if (clashes.length) {
        throw new Error(
          `Someone else's cursor is in ${clashes.length === 1 ? "a block" : "blocks"} this edit would rewrite: ` +
            `${clashes.map((c) => `${c.blockId} (${c.editedBy})`).join(", ")}. Text in a single field doesn't ` +
            "merge — one of you would lose the sentence. Edit somewhere else, or ask in the chat for them to " +
            "move off it and try again.",
        );
      }

      let failed = null;
      const doc = s.edit((current) => {
        try {
          return applyPatch(current, operations);
        } catch (err) {
          failed = err;
          return current;
        }
      });
      if (failed) throw failed;

      const { failures, flags } = ctx.standardFindings({ doc });
      return text({
        applied: operations.length,
        title: doc.title,
        sections: (doc.sections || []).length,
        ...roomState(s),
        // Reported, never enforced. See the tool description.
        ...(failures.length
          ? {
              standardProblems: failures.map(({ code, section, message }) => ({
                code,
                section,
                message,
              })),
            }
          : {}),
        ...(flags.length
          ? {
              standardWarnings: flags.map(({ code, section, message }) => ({
                code,
                section,
                message,
              })),
            }
          : {}),
        note:
          "The edit is live on everyone's screen. It is NOT saved — the user saves the session from the editor " +
          "when they're happy with it.",
      });
    }),
  );

  server.registerTool(
    "send_collab_chat",
    {
      title: "Say something in the session",
      description:
        "Send a message to everyone in the session. This is the channel for asking rather than assuming — which " +
        "section they want next, whether a passage is pitched right, whether you should change something you're " +
        "unsure about. The user is in the room and can answer.\n\n" +
        "Say what you are about to do before a large edit, so nobody watches text rewrite itself with no " +
        "explanation. About one message a second is the room's limit; there is no reason to go near it.",
      inputSchema: {
        text: z.string().min(1).max(2000).describe("The message to send."),
      },
    },
    tool(async ({ text: body }) => {
      const s = live();
      s.say(body);
      return text({ sent: body, ...roomState(s) });
    }),
  );

  server.registerTool(
    "leave_collab_session",
    {
      title: "Leave the session",
      description:
        "Disconnect from the collaboration session. The lesson stays exactly as it is — leaving changes nothing " +
        "the session holds, and frees the participant slot (a room holds ten). Say goodbye in the chat first.",
      inputSchema: {},
    },
    tool(async () => {
      if (!session || session.closed) {
        return text("Not in a collaboration session; nothing to leave.");
      }
      const code = session.code;
      session.close("you left");
      session = null;
      return text(
        `Left session "${code}". The lesson is untouched and whatever you changed is still in the session for ` +
          "the host to save.",
      );
    }),
  );
}
