// The history tab (/hub/:id/history): the lesson's published commit timeline.
//
// This is the one tab that isn't a moved dialog. The editor's HistoryDialog
// reads the repository in *your* browser — the one your own edits are being
// committed to — and a reader of someone else's lesson has no such repository.
// So this one downloads the published packfile (GET /git/:lessonId/pack, see
// apps/api/src/routes/git.js), indexes it, and reads the log out of that.
//
// Two things keep that affordable on a public, server-rendered route:
//
//   - The route is lazy (see App.jsx). isomorphic-git and LightningFS are ~200 KB
//     that nobody reading a lesson should download, so the engine is fetched
//     through loadGitEngine() only once this tab is actually opened.
//   - The clone lands in the *same* repo id the editor uses for this lesson
//     (repoIdFor). If you later open the lesson to edit it, useLessonGit finds
//     the repository already there and skips the download — and if you had
//     edited it before, this tab finds it and skips the download instead. The
//     two are the same clone by design; a lesson's history is one history.
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
import { fetchPack } from "@spelling-creator/core/git/remote";
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
        const git = await loadGitEngine();
        const repoId = repoIdFor(lesson.id);
        const ctx = git.repoCtx(repoId);

        // Already cloned — from a previous visit to this tab, or from having
        // opened the lesson in the editor.
        if (!(await git.repoExists(repoId))) {
          const pack = await fetchPack(lesson.id);
          if (cancelled) return;
          if (!pack) {
            setCommits([]);
            return;
          }
          await git.cloneFromPack({
            ...ctx,
            packfile: pack.packfile,
            filename: `${lesson.id}.pack`,
            head: pack.head,
          });
        }
        if (cancelled) return;

        const log = await git.history({ ...ctx });
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
