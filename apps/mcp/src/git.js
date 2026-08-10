// Forking a lesson and proposing changes back, for an AI assistant.
//
// This is the assistant's version of what the editor does in the browser (see
// packages/core/src/browser/git/sync.js, which is the same flow bound to
// LightningFS). The rule it exists to respect is the hub's, not ours: nobody
// writes a lesson from a fork. Work travels back through a proposal, which a
// human reads and merges. So an assistant asked to change a lesson does not save
// over it — it forks, edits its own copy, and opens a proposal.
//
// ---- Why there is no state between calls ------------------------------------
//
// A repository here lives in memory (core/git/memfs.js) and is thrown away when
// the tool call returns. It doesn't need to survive, because the fork is a real
// hub lesson with its own stored history: the durable state is the fork's row
// (its document) and its packfile in R2. Each call rebuilds exactly what it
// needs by cloning that pack, which means a fork survives the server restarting,
// a conversation being resumed days later, and the remote transport moving a
// connection between Worker instances.
//
// It also means the assistant edits its fork with the ordinary tools —
// patch_lesson, add_image, update_lesson — and only pays for git at the two
// moments that need it: forking, and proposing.
//
// ---- What a proposal contains -----------------------------------------------
//
// One commit, made when the proposal is opened, holding the fork's document as
// it then stands. The intermediate patches aren't separate commits — nothing was
// watching to record them — so the reviewer sees a single change against the
// commit the fork and the lesson diverged from. That diff is the thing being
// reviewed, and it's exact; the fork's own history is what makes it a true
// three-way merge rather than a guess.

import { stripLocalFields } from "@spelling-creator/core/git/doc";
import { memRepo } from "@spelling-creator/core/git/memfs";
import { describeOp } from "@spelling-creator/core/git/ops";
import {
  cloneFromPack,
  fetchRemotePack,
  packRepo,
} from "@spelling-creator/core/git/pack";
import {
  UPSTREAM_REF,
  authorFrom,
  commitDoc,
  pendingOps,
} from "@spelling-creator/core/git/repo";
import { PULL_BODY_MAX, PULL_TITLE_MAX } from "@spelling-creator/core/pulls";

/**
 * The signature to stamp the assistant's commits with.
 *
 * The hub attributes everything to the account whose token this is — the
 * assistant acts as the signed-in user, and there is no separate identity to
 * claim. So the commit carries that user's name, and `proposalBody` below is
 * where the fact that an assistant wrote it is recorded.
 */
async function commitAuthor(api) {
  const me = await api.whoami().catch(() => null);
  return authorFrom({ name: me?.displayName, email: me?.email });
}

/** Trim to a limit on a word boundary where there is one nearby. */
function clamp(value, limit) {
  const text = (value || "").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The proposal's body, with a note saying which assistant wrote it.
 *
 * Worth the line: the hub records the proposal against the account it was opened
 * with, so on a self-proposal the reviewer would otherwise see their own name
 * against changes they didn't write. `client` is the MCP client's own reported
 * name (Claude Desktop, claude.ai, Cursor, …), which is the closest thing to an
 * honest answer available — we know what connected, not what model it drove.
 */
export function proposalBody(body, client) {
  const note = client
    ? `Proposed by an AI assistant via ${client} (Spelling Creator MCP).`
    : "Proposed by an AI assistant via the Spelling Creator MCP server.";
  const text = (body || "").trim();
  if (!text) return note;
  // Keep the whole note: it's the provenance, and it's what tells a reviewer to
  // read the diff rather than assume they wrote it.
  return `${clamp(text, PULL_BODY_MAX - note.length - 2)}\n\n${note}`;
}

/**
 * Build an in-memory repository holding a lesson's history, cloned from its
 * stored pack. The clone carries the original's commit oids, so the fork shares
 * ancestry with it — which is what a reviewer's three-way merge needs.
 */
async function cloneRepo(pack) {
  const ctx = memRepo();
  await cloneFromPack({ ...ctx, ...pack });
  return ctx;
}

/**
 * Fork a lesson into a new private draft owned by the caller.
 *
 * The fork is a genuine clone wherever it can be: its repository is the source
 * lesson's, downloaded and re-uploaded under the new id, with the original's tip
 * recorded at refs/remotes/upstream/main so the fork knows where it came from.
 *
 * A lesson with no stored history (one written before version history, or only
 * ever written over MCP) can't be cloned, so the fork's history is seeded from
 * its document instead. That fork still works — it just shares no commit with
 * the original, so a later merge compares two sides rather than three. The
 * result says which happened, because it changes what a reviewer will see.
 *
 * @returns {Promise<{ lesson: object, head: string, clonedHistory: boolean }>}
 */
export async function forkLesson(api, { lessonId, title }) {
  const source = await api.getLesson(lessonId);
  if (!source.doc?.sections?.length) {
    throw new Error("That lesson has no content to fork.");
  }

  const pack = await api.fetchLessonPack(lessonId);

  // The fork's document. Local-only fields never travel (see core/git/doc.js):
  // the trusted-collaborator list belongs to the lesson it was named on, not to
  // a copy of it, and it must not be carried into a new lesson's document.
  const doc = stripLocalFields(source.doc);
  const forkTitle = (title || "").trim() || source.title;

  // Create the row first: the history is pushed under the new lesson's id, so
  // there has to be a new lesson to push it to. `forkedFrom` is the pointer home.
  const lesson = await api.createLesson({
    title: forkTitle,
    doc: { ...doc, title: forkTitle },
    published: false,
    forkedFrom: lessonId,
  });

  const author = await commitAuthor(api);
  let ctx;
  if (pack) {
    ctx = await cloneRepo(pack);
    // Record where we came from, so a later sync has a base before it fetches
    // anything new.
    await fetchRemotePack({ ...ctx, ...pack, ref: UPSTREAM_REF });

    // The row's document and the history's tip can disagree — a lesson edited
    // over MCP is saved without committing, so its stored pack lags. Commit the
    // difference now, under the fork, so the fork is self-consistent from the
    // start and the proposal's diff later shows only what the assistant changed.
    // A no-op when they already agree, which is the normal case.
    await commitDoc({
      ...ctx,
      doc: { ...doc, title: forkTitle },
      author,
      message: `Fork "${source.title}"\n\nBrings the fork up to the lesson's saved document.\n`,
    });
  } else {
    ctx = memRepo();
    await commitDoc({
      ...ctx,
      doc: { ...doc, title: forkTitle },
      author,
      message: `Fork "${source.title}"\n\nThe original has no stored history, so this fork starts from its current document.\n`,
    });
  }

  const packed = await packRepo(ctx);
  try {
    // A brand-new lesson has no history, so there is nothing to compare and swap
    // against.
    await api.pushLessonPack(lesson.id, {
      packfile: packed.packfile,
      head: packed.head,
      parent: null,
    });
  } catch (err) {
    // The row exists but has no history behind it, which is the one state the
    // rest of this file can't work from. Say so rather than leaving the assistant
    // to rediscover it at propose time — and don't delete the lesson, which is
    // a real copy of the document and the user's to keep or remove.
    throw new Error(
      `The fork was created (${lesson.id}) but its history could not be stored, so changes to it can't be ` +
        `proposed yet. Delete it and fork again. (${err.message})`,
    );
  }

  return { lesson, head: packed.head, clonedHistory: Boolean(pack) };
}

/**
 * Offer a fork's work back to the lesson it came from, as a proposal.
 *
 * Nothing is written to that lesson — not its document, not its history. What
 * travels is a snapshot of the fork's repository, which its author (or a trusted
 * collaborator) reviews and merges from the web app. Snapshotting is what makes
 * the request stable: the fork can carry on changing and what the reviewer read
 * won't move under them.
 *
 * Opening it is two steps — the request, then its pack — because the pack is
 * uploaded against the request's id. If the upload fails the empty request is
 * withdrawn, rather than left in a review queue with nothing in it.
 *
 * @returns {Promise<{ pull: object, lessonId: string, commit: string, ops: object[] }>}
 */
export async function proposeChanges(
  api,
  { forkLessonId, lessonId, title, body, client },
) {
  const fork = await api.getLesson(forkLessonId);
  const target = (lessonId || fork.forkedFrom || "").trim();
  if (!target) {
    throw new Error(
      `Lesson ${forkLessonId} is not a fork of anything, so there is nobody to propose to. ` +
        "Pass lessonId to say which lesson the changes are for, or fork_lesson first.",
    );
  }
  if (target === forkLessonId) {
    throw new Error("A lesson cannot propose changes to itself.");
  }
  if (!fork.doc?.sections?.length) {
    throw new Error("That fork has no content to propose.");
  }

  const forkPack = await api.fetchLessonPack(forkLessonId);
  if (!forkPack) {
    throw new Error(
      `Lesson ${forkLessonId} has no stored history, so there is no fork to propose from. ` +
        "Create the fork with fork_lesson, edit that, then propose.",
    );
  }

  // Commit the fork's document as it now stands. This is the change being
  // proposed: everything the assistant did to the fork since it was created,
  // as one commit against the shared history.
  const ctx = await cloneRepo(forkPack);
  const doc = stripLocalFields(fork.doc);

  // Read the operations before committing so the commit message can itemise them
  // — the proposal's title, then a line per change, which is what the reviewer's
  // history view renders.
  const ops = await pendingOps({ ...ctx, doc });
  if (!ops.length) {
    throw new Error(
      "This fork is identical to what has already been proposed — there is nothing to propose. " +
        "Edit the fork first (patch_lesson on the fork's id), then try again.",
    );
  }

  const author = await commitAuthor(api);
  const commit = await commitDoc({
    ...ctx,
    doc,
    author,
    message: `${clamp(title, PULL_TITLE_MAX)}\n\n${ops.map(describeOp).join("\n")}\n`,
  });

  const packed = await packRepo(ctx);

  // Push the fork's own history before proposing, so the fork's History tab and
  // the proposal agree, and so re-proposing later builds on this commit rather
  // than re-making it.
  await api.pushLessonPack(forkLessonId, {
    packfile: packed.packfile,
    head: packed.head,
    parent: forkPack.head,
  });

  // The target's tip as it stands, recorded on the request so a reviewer can see
  // what it was built against. Informational: the merge finds its own base from
  // the shared ancestry.
  const base = await api.fetchLessonHead(target).catch(() => null);

  const pull = await api.createPull(target, {
    title: clamp(title, PULL_TITLE_MAX),
    body: proposalBody(body, client),
    head: packed.head,
    base,
    sourceLessonId: forkLessonId,
  });

  try {
    const ready = await api.uploadPullPack(target, pull.id, {
      packfile: packed.packfile,
      head: packed.head,
    });
    return {
      pull: ready || pull,
      lessonId: target,
      commit: commit.oid,
      changes: ops.map(describeOp),
    };
  } catch (err) {
    await api.closePull(target, pull.id).catch(() => {});
    throw err;
  }
}
