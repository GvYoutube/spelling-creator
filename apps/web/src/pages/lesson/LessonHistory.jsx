// The history tab (/hub/:id/history): the lesson's published commit timeline.
//
// This is the one tab that isn't a moved dialog. The editor's HistoryDialog
// reads the repository in *your* browser — the one your own edits are being
// committed to — and a reader of someone else's lesson has no such repository.
// So this one downloads the published packfile (GET /git/:lessonId/pack, see
// apps/api/src/routes/git.js), indexes it, and reads the log out of that.
//
// This tab shows the *published* history, and getting that right is subtler
// than it first looks. An earlier version cloned into the repo id the editor
// uses for the same lesson and then read that repository's local branch, on the
// reasoning that a lesson's history is one history and the clone may as well be
// shared. It isn't one history: the editor commits locally on every pause, and
// only a save pushes. So for anyone who had the lesson open in the editor, this
// public tab showed their own unpublished commits — and went stale the moment
// the published head moved on without them. (Caught in review on #40.)
//
// So the objects are still shared — they are content-addressed, and
// re-downloading a pack we already hold is pure waste — but the *ref* is not.
// The published tip is recorded at ORIGIN_REF, never at the local branch, and
// the log is read from that oid. Two consequences worth keeping:
//
//   - Nothing here can clobber editor work. cloneFromPack force-writes
//     refs/heads/main; fetchRemotePack writes only the remote ref.
//   - The head always comes from the same response as the bytes. /refs is asked
//     first because it is cheap, but if the pack has to be downloaded its own
//     X-Git-Head wins — the author replaces the pack in place, so a ref fetched
//     a moment earlier can name a commit those bytes don't contain.
//
// The route is lazy (see App.jsx): isomorphic-git and LightningFS are ~200 KB
// that nobody reading a lesson should download, so the engine is fetched
// through loadGitEngine() only once this tab is actually opened.
//
// A lesson published before histories were stored has no pack at all, which is
// not an error — it just has no timeline to show yet.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitCommitVerticalIcon, GitMergeIcon } from "lucide-react";
import PageBody from "../../components/layout/PageBody.jsx";
import { Alert, AlertDescription } from "../../components/ui/alert.jsx";
import { HistorySkeleton } from "../../components/Skeletons.jsx";
import { timeAgo } from "../../components/HistoryDialog.jsx";
import { loadGitEngine } from "../../lib/git/load.js";
import { fetchPack, fetchRefs } from "@spelling-creator/core/git/remote";
import { repoIdFor } from "@spelling-creator/core/git/doc";
import { useLesson } from "./LessonLayout.jsx";

export default function LessonHistory() {
  const { t } = useTranslation("lesson");
  const { lesson } = useLesson();

  const [commits, setCommits] = useState(null); // null = still loading
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setCommits(null);
    setError("");

    (async () => {
      try {
        const refs = await fetchRefs(lesson.id);
        if (cancelled) return;
        if (!refs?.head) {
          setCommits([]);
          return;
        }

        const git = await loadGitEngine();
        const ctx = git.repoCtx(repoIdFor(lesson.id));

        // Do we already hold the published tip? Reading it is the test — a repo
        // that was never cloned, or one whose objects predate this head, throws
        // here and falls through to the download.
        let log = await git
          .history({ ...ctx, ref: refs.head })
          .catch(() => null);

        if (!log) {
          const pack = await fetchPack(lesson.id);
          if (cancelled) return;
          if (!pack) {
            setCommits([]);
            return;
          }
          await git.fetchRemotePack({
            ...ctx,
            packfile: pack.packfile,
            filename: `${lesson.id}.pack`,
            head: pack.head,
            ref: git.ORIGIN_REF,
          });
          log = await git.history({ ...ctx, ref: pack.head });
        }

        if (!cancelled) setCommits(log);
      } catch (err) {
        if (!cancelled) setError(err.message || t("history.loadError"));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lesson.id, t]);

  if (error) {
    return (
      <PageBody width="reading">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </PageBody>
    );
  }

  if (commits === null) {
    return (
      <PageBody width="reading">
        <HistorySkeleton count={5} />
      </PageBody>
    );
  }

  if (commits.length === 0) {
    return (
      <PageBody width="reading">
        <p className="text-sm text-muted-foreground">{t("history.empty")}</p>
      </PageBody>
    );
  }

  return (
    <PageBody width="reading">
      <ol className="m-0 flex list-none flex-col p-0">
        {commits.map((commit) => (
          <li
            key={commit.oid}
            className="flex items-start gap-3 border-l border-border py-3 pl-4 first:pt-0"
          >
            <span className="-ml-[1.6rem] mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
              {commit.isMerge ? (
                <GitMergeIcon className="size-4" />
              ) : (
                <GitCommitVerticalIcon className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">
                {commit.summary || t("history.noMessage")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {commit.author} · {timeAgo(commit.timestamp)} ·{" "}
                <code className="text-xs">{commit.oid.slice(0, 7)}</code>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </PageBody>
  );
}
