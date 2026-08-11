// The editor's version-control controller: keeps a lesson's repository in step
// with the document being edited, and commits periodically.
//
// Why periodically, rather than per edit? A commit per keystroke would be
// unreadable as history and would churn IndexedDB. So edits accumulate in the
// document, and a commit is taken when the user *pauses* (IDLE_MS) — or, if they
// never pause, at least every MAX_WAIT_MS, so a long uninterrupted stretch of
// typing still gets checkpointed. A commit whose tree matches HEAD is skipped
// outright (see repo.js commitDoc), so an idle editor never accretes empty
// commits.
//
// The repository is set up lazily on mount:
//   - a lesson that already has a local repo just opens it
//   - a hub lesson with no local repo clones its published history (so opening
//     the same lesson on another machine brings its whole timeline with it)
//   - anything else gets a fresh repo, seeded with a root commit of the current
//     doc, so there is always a baseline to diff against

import { useCallback, useEffect, useRef, useState } from "react";
import { DRAFT_REPO, repoIdFor } from "@spelling-creator/core/git/doc";
import { loadGitEngine } from "./load.js";
import { fetchPack } from "@spelling-creator/core/git/remote";
import { DEFAULT_BRANCH, toBranchName } from "@spelling-creator/core/git/refs";

// Commit once the user has been still for this long.
const IDLE_MS = 4000;
// ...but never let unsaved work sit longer than this, however fast they type.
const MAX_WAIT_MS = 60000;

/** A doc worth committing. The starter doc (no sections) isn't. */
function worthCommitting(doc) {
  return Boolean(doc && Array.isArray(doc.sections) && doc.sections.length > 0);
}

/**
 * @param {object}  opts.doc         The live editor document.
 * @param {string}  [opts.editingId] The hub lesson being edited, if any.
 * @param {object}  [opts.identity]  { name, email } — stamped on commits.
 * @param {boolean} [opts.enabled]   Set false to disable version control entirely.
 */
export function useLessonGit({ doc, editingId, identity, enabled = true }) {
  const repoId = repoIdFor(editingId);

  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const [lastCommit, setLastCommit] = useState(null); // { oid, at } | null
  const [error, setError] = useState(null);

  // The variations this lesson holds, and which one is being edited. Both come
  // out of the repository (branches, and HEAD) rather than being state of their
  // own — so a reload, a second tab, or publishing a draft all find the same
  // answer the repository already had.
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState(DEFAULT_BRANCH);

  // Bumped to force the setup effect to run again. A fork or an import swaps the
  // repository out from under us *without* changing the repo id (both land in the
  // draft slot), and the effect keys on the id, so it needs telling.
  const [generation, setGeneration] = useState(0);

  // Timers for the two commit triggers, and the wall-clock time the current
  // batch of unsaved edits began (so MAX_WAIT_MS is measured from the first
  // unsaved edit, not the most recent one).
  const idleTimer = useRef(null);
  const dirtySince = useRef(null);

  // Commits are serialised through this promise chain. Two commits racing on one
  // repo would interleave their ref writes, and the loser's work would vanish.
  const queue = useRef(Promise.resolve());

  // The doc, mirrored for the timer callbacks, which outlive any single render.
  const docRef = useRef(doc);
  const identityRef = useRef(identity);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  const run = useCallback((task) => {
    const next = queue.current.then(task, task);
    // Keep the chain alive even if a task rejects, or every later commit dies too.
    queue.current = next.catch(() => {});
    return next;
  }, []);

  // ---- repository setup ----------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    setReady(false);
    run(async () => {
      try {
        // Fetches the git chunk the first time the editor mounts (see load.js).
        const engine = await loadGitEngine();
        const ctx = engine.repoCtx(repoId);

        if (!(await engine.repoExists(repoId))) {
          // A published lesson we don't have locally: bring its history down, so
          // the timeline follows the lesson rather than the browser.
          let cloned = false;
          if (editingId) {
            const pack = await fetchPack(editingId).catch(() => null);
            if (pack) {
              await engine.cloneFromPack({ ...ctx, ...pack });
              cloned = true;
            }
          }
          if (!cloned) await engine.ensureRepo(ctx);
        }

        // Seed a baseline so the first real edit has something to diff against.
        if (!(await engine.headOid(ctx)) && worthCommitting(docRef.current)) {
          await engine.commitDoc({
            ...ctx,
            doc: docRef.current,
            author: identityRef.current,
            message: "Start the lesson\n",
          });
        }

        const head = await engine.headOid(ctx);
        if (cancelled) return;
        setLastCommit(head ? { oid: head, at: Date.now() } : null);
        setPending(
          (await engine.pendingOps({ ...ctx, doc: docRef.current })).length,
        );
        setBranch(await engine.currentBranch(ctx));
        setBranches(await engine.listBranches(ctx));
        setReady(true);
      } catch (err) {
        console.error("[lesson-git] setup failed", err);
        if (!cancelled) {
          setError(err.message || "Version history is unavailable.");
          setReady(false);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [repoId, editingId, enabled, generation, run]);

  /** Re-open the repository — after a fork has swapped a new one into place. */
  const reload = useCallback(() => {
    dirtySince.current = null;
    setGeneration((n) => n + 1);
  }, []);

  /**
   * Throw the current repository away and start a fresh one. Used when the doc is
   * replaced by something with no relationship to it (a Word/JSON import): that
   * lesson's history is not this lesson's history, and grafting the two would be
   * a lie about where the content came from.
   */
  const discard = useCallback(
    () =>
      run(async () => {
        const engine = await loadGitEngine();
        await engine.deleteRepo(repoId);
        dirtySince.current = null;
        setLastCommit(null);
        setPending(0);
        setGeneration((n) => n + 1);
      }),
    [repoId, run],
  );

  // ---- committing ----------------------------------------------------------
  const commitNow = useCallback(
    () =>
      run(async () => {
        const current = docRef.current;
        if (!worthCommitting(current)) return null;

        try {
          const engine = await loadGitEngine();
          const result = await engine.commitDoc({
            ...engine.repoCtx(repoId),
            doc: current,
            author: identityRef.current,
          });
          // Whatever happened, the doc now matches HEAD — clear the dirty state.
          dirtySince.current = null;
          setPending(0);
          if (result) setLastCommit({ oid: result.oid, at: Date.now() });
          return result;
        } catch (err) {
          setError(err.message || "Could not save a version.");
          return null;
        }
      }),
    [repoId, run],
  );

  // ---- the periodic trigger ------------------------------------------------
  useEffect(() => {
    if (!enabled || !ready) return;
    if (!worthCommitting(doc)) return;

    let cancelled = false;

    // Recompute what's outstanding, then decide whether this edit should commit
    // now (we've been dirty too long) or reset the idle countdown.
    run(async () => {
      if (cancelled) return;
      const engine = await loadGitEngine();
      const ops = await engine
        .pendingOps({ ...engine.repoCtx(repoId), doc })
        .catch(() => []);
      if (cancelled) return;
      setPending(ops.length);
      if (ops.length === 0) {
        dirtySince.current = null;
        return;
      }
      if (dirtySince.current === null) dirtySince.current = Date.now();

      if (Date.now() - dirtySince.current >= MAX_WAIT_MS) {
        commitNow();
        return;
      }
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(commitNow, IDLE_MS);
    });

    return () => {
      cancelled = true;
    };
  }, [doc, repoId, ready, enabled, commitNow, run]);

  // Commit whatever is outstanding when the editor goes away (tab hidden, or the
  // component unmounts), so closing the tab mid-edit doesn't lose the checkpoint.
  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      if (document.visibilityState === "hidden") commitNow();
    };
    document.addEventListener("visibilitychange", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [commitNow, enabled]);

  // ---- history -------------------------------------------------------------
  const loadHistory = useCallback(
    () =>
      run(async () => {
        try {
          const engine = await loadGitEngine();
          return await engine.history(engine.repoCtx(repoId));
        } catch {
          return [];
        }
      }),
    [repoId, run],
  );

  /** What a commit changed, as block operations, against its first parent. */
  const diffFor = useCallback(
    (oid) =>
      run(async () => {
        try {
          const engine = await loadGitEngine();
          return await engine.diffFromParent({
            ...engine.repoCtx(repoId),
            oid,
          });
        } catch {
          return [];
        }
      }),
    [repoId, run],
  );

  /** Restore an earlier version. Returns the restored doc for the editor to adopt. */
  const restore = useCallback(
    (oid) =>
      run(async () => {
        const engine = await loadGitEngine();
        const ctx = engine.repoCtx(repoId);
        const result = await engine.restoreCommit({
          ...ctx,
          oid,
          author: identityRef.current,
        });
        const head = await engine.headOid(ctx);
        setLastCommit(head ? { oid: head, at: Date.now() } : null);
        setPending(0);
        dirtySince.current = null;
        return result.doc;
      }),
    [repoId, run],
  );

  // ---- variations ----------------------------------------------------------
  //
  // A variation is a branch, and the four things you can do to one are create,
  // switch, rename and delete. Every one of them commits what's outstanding
  // first: the editor's rule is that work is checkpointed when you pause, so a
  // variation must never be the thing that loses the last few seconds of it.

  const refreshBranches = useCallback(
    () =>
      run(async () => {
        const engine = await loadGitEngine();
        const ctx = engine.repoCtx(repoId);
        const list = await engine.listBranches(ctx);
        setBranches(list);
        setBranch(await engine.currentBranch(ctx));

        // Re-read the tip too. A merge doesn't always leave a commit behind — a
        // fast-forward moves the branch instead (see completeMerge) — so the
        // chip would otherwise still be timing the commit before it.
        const head = await engine.headOid(ctx);
        setLastCommit(head ? { oid: head, at: Date.now() } : null);
        return list;
      }),
    [repoId, run],
  );

  /** Move to a branch and hand back the document as it stands there. */
  const switchBranch = useCallback(
    (name) =>
      run(async () => {
        const engine = await loadGitEngine();
        const ctx = engine.repoCtx(repoId);

        await engine
          .commitDoc({
            ...ctx,
            doc: docRef.current,
            author: identityRef.current,
          })
          .catch(() => null);

        const result = await engine.checkoutBranch({ ...ctx, name });
        dirtySince.current = null;
        setPending(0);
        setBranch(result.name);
        setBranches(await engine.listBranches(ctx));
        const head = await engine.headOid(ctx);
        setLastCommit(head ? { oid: head, at: Date.now() } : null);
        return result.doc;
      }),
    [repoId, run],
  );

  /**
   * Start a variation from where we are and switch to it.
   *
   * `label` is what the author typed; the branch takes the name that survives
   * git's rules (see core/git/refs.js). An empty result means they typed nothing
   * git could keep, which is the caller's to report.
   */
  const createVariation = useCallback(
    (label) =>
      run(async () => {
        const name = toBranchName(label);
        if (!name) throw new Error("Please give this variation a name.");

        const engine = await loadGitEngine();
        const ctx = engine.repoCtx(repoId);

        await engine
          .commitDoc({
            ...ctx,
            doc: docRef.current,
            author: identityRef.current,
          })
          .catch(() => null);

        await engine.createBranch({ ...ctx, name });
        dirtySince.current = null;
        setPending(0);
        setBranch(name);
        setBranches(await engine.listBranches(ctx));
        return name;
      }),
    [repoId, run],
  );

  const renameVariation = useCallback(
    (from, label) =>
      run(async () => {
        const to = toBranchName(label);
        if (!to) throw new Error("Please give this variation a name.");

        const engine = await loadGitEngine();
        const ctx = engine.repoCtx(repoId);
        await engine.renameBranch({ ...ctx, from, to });
        setBranch(await engine.currentBranch(ctx));
        setBranches(await engine.listBranches(ctx));
        return to;
      }),
    [repoId, run],
  );

  const deleteVariation = useCallback(
    (name) =>
      run(async () => {
        const engine = await loadGitEngine();
        const ctx = engine.repoCtx(repoId);
        await engine.deleteBranch({ ...ctx, name });
        setBranches(await engine.listBranches(ctx));
      }),
    [repoId, run],
  );

  /**
   * Take the draft repo's history with us when a draft is first published.
   * Commits everything outstanding first, so nothing is stranded in the draft.
   */
  const adoptDraft = useCallback(
    (lessonId) =>
      run(async () => {
        if (!lessonId || repoId !== DRAFT_REPO) return;
        const engine = await loadGitEngine();
        await engine
          .commitDoc({
            ...engine.repoCtx(DRAFT_REPO),
            doc: docRef.current,
            author: identityRef.current,
          })
          .catch(() => null);
        await engine.adoptDraftRepo(lessonId);
      }),
    [repoId, run],
  );

  return {
    ready,
    pending,
    lastCommit,
    error,
    clearError: () => setError(null),
    repoId,
    branch,
    branches,
    onDefaultBranch: branch === DEFAULT_BRANCH,
    refreshBranches,
    switchBranch,
    createVariation,
    renameVariation,
    deleteVariation,
    commitNow,
    loadHistory,
    diffFor,
    restore,
    adoptDraft,
    reload,
    discard,
    /** Queue work against this lesson's repo (used by the fork/merge flows). */
    run,
  };
}
