// One proposal's own page (/hub/:id/proposals/:prId).
//
// You can **read** a proposal here — what it changes, block by block, and whether
// it would merge cleanly — but you cannot merge one. That split is the point, and
// it is not the same as the page being read-only for want of trying.
//
// Merging is the reviewer's act: it commits to the lesson's history and pushes it
// under their credentials, which needs the editor's repository. Reading needs none
// of that. Both packs are public exactly as far as the lesson is, so the diff is
// computed right here from the objects themselves — index the proposal's pack
// beside the lesson's, find the commit the two diverged at, and diff. See
// prepareProposalReview in core/browser/git/sync.js.
//
// So "Review & merge" still hands the editor the lesson and the proposal id, and
// the block-by-block merge still happens there. What changed is that nobody has
// to start that merge to find out whether they want it.
//
// There is a third answer between yes and no, too: **try it in a variation**
// (`&try=1`). A diff says what changed; it doesn't say whether the lesson still
// works with the change in it. That route lands the proposal on a variation of
// the reviewer's own, leaves the lesson alone, and leaves the proposal open.
//
// The engine is ~200 KB and is fetched on demand (lib/git/load.js) only once this
// page is open — the same arrangement the History tab uses, and the reason the
// diff arrives after the proposal's text rather than with it.
//
// There is no single-proposal endpoint (see apps/api/src/routes/pulls.js), so
// this reads the lesson's list and picks its one out. The list is small by
// construction — proposals are rare and resolved ones stay — and it also
// carries `canReview`, which is the server's answer to whether this viewer may
// merge at all and is not derivable on the client.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  TriangleAlertIcon,
} from "lucide-react";
import PageBody from "../../components/layout/PageBody.jsx";
import { ChangeChips, ChangeList } from "../../components/ChangeSummary.jsx";
import { Button } from "../../components/ui/button.jsx";
import { Badge } from "../../components/ui/badge.jsx";
import { Alert, AlertDescription } from "../../components/ui/alert.jsx";
import { Avatar, AvatarFallback } from "../../components/ui/avatar.jsx";
import {
  HistorySkeleton,
  ListRowsSkeleton,
} from "../../components/Skeletons.jsx";
import { cn } from "../../lib/utils.js";
import { useAuth } from "../../lib/auth.jsx";
import { loadGitEngine } from "../../lib/git/load.js";
import { repoIdFor } from "@spelling-creator/core/git/doc";
import { fetchPullRequests } from "@spelling-creator/core/pulls";
import { EDIT_REQUEST_KEY } from "@spelling-creator/core/lessons";
import { useLesson } from "./LessonLayout.jsx";

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

/**
 * Whether this would merge on its own, said plainly.
 *
 * The three answers are genuinely different actions for a reviewer, not shades of
 * one: nothing to do, press the button, or set aside ten minutes. A count of
 * conflicting blocks is the honest measure of the last, because that is exactly
 * how many decisions the merge dialog will ask for.
 */
function Mergeability({ changes }) {
  const { t } = useTranslation("lesson");

  if (changes.contained) {
    return (
      <Alert className="mt-4 border-success/40 bg-success/10 text-success">
        <CircleCheckIcon />
        <AlertDescription className="text-success">
          {t("pulls.changes.alreadyIn")}
        </AlertDescription>
      </Alert>
    );
  }

  const count = changes.conflicts.length;
  if (count === 0) {
    return (
      <Alert className="mt-4 border-success/40 bg-success/10 text-success">
        <CircleCheckIcon />
        <AlertDescription className="text-success">
          {t("pulls.changes.clean")}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="mt-4 border-focus/40 bg-focus/10 text-focus">
      <TriangleAlertIcon />
      <AlertDescription className="text-focus">
        {t("pulls.changes.conflicts", { count })}
      </AlertDescription>
    </Alert>
  );
}

export default function LessonProposal() {
  const { t } = useTranslation("lesson");
  const { prId } = useParams();
  const navigate = useNavigate();
  const { accessToken } = useAuth();
  const { lesson, formatDate } = useLesson();

  const [pull, setPull] = useState(null);
  const [canReview, setCanReview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPullRequests(lesson.id, accessToken)
      .then((result) => {
        if (cancelled) return;
        const found = result.pulls.find((p) => p.id === prId);
        setPull(found ?? null);
        setCanReview(result.canReview);
        setError(found ? "" : t("pulls.notFound"));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || t("pulls.loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lesson.id, prId, accessToken, t]);

  // What the proposal changes, worked out from the git objects themselves.
  //
  // Deliberately a second effect rather than part of the fetch above: it needs a
  // 200 KB engine and two packfile downloads, and the proposal's title, author and
  // note should be on screen long before any of that lands. It also fails softly —
  // a proposal whose changes can't be read is still a proposal worth showing, and
  // the reviewer can always open it in the editor.
  //
  // It waits for `ready`, because an unready proposal has no pack to read.
  const [changes, setChanges] = useState(null); // null = still working
  const [changesError, setChangesError] = useState("");
  const ready = pull?.ready;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    setChanges(null);
    setChangesError("");

    (async () => {
      try {
        const engine = await loadGitEngine();
        const result = await engine.prepareProposalReview({
          repoId: repoIdFor(lesson.id),
          lessonId: lesson.id,
          pullId: prId,
          previousHead: pull.previousHead,
          accessToken,
        });
        if (cancelled) return;
        if (!result) {
          setChangesError(t("pulls.changesGone"));
          return;
        }
        setChanges(result);
      } catch (err) {
        if (!cancelled) setChangesError(err.message || t("pulls.changesError"));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lesson.id, prId, ready, pull?.previousHead, accessToken, t]);

  // Same hand-off as the list's "Review & merge" — see the file header. The
  // lesson id goes in the query string as well as sessionStorage because the
  // editor may already have a *different* lesson open, and a proposal is only
  // meaningful against the lesson it was opened on.
  const review = ({ tryIt = false } = {}) => {
    try {
      sessionStorage.setItem(EDIT_REQUEST_KEY, lesson.id);
    } catch {
      /* ignore — the editor just won't preload if storage is unavailable */
    }
    navigate(
      `/editor?pull=${encodeURIComponent(prId)}&lesson=${encodeURIComponent(lesson.id)}` +
        (tryIt ? "&try=1" : ""),
    );
  };

  if (loading) {
    return (
      <PageBody width="reading">
        <ListRowsSkeleton count={2} />
      </PageBody>
    );
  }

  if (error || !pull) {
    return (
      <PageBody width="reading">
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {error || t("pulls.notFound")}
            <Button variant="ghost" size="sm" asChild>
              <RouterLink
                to={`/hub/${lesson.id}/proposals`}
                className="no-underline"
              >
                {t("pulls.backToProposals")}
              </RouterLink>
            </Button>
          </AlertDescription>
        </Alert>
      </PageBody>
    );
  }

  const isOpen = pull.status === "open";

  return (
    <PageBody width="reading">
      <Button variant="ghost" size="sm" asChild className="mb-3 -ml-2">
        <RouterLink to={`/hub/${lesson.id}/proposals`} className="no-underline">
          <ArrowLeftIcon data-icon="inline-start" />
          {t("pulls.backToProposals")}
        </RouterLink>
      </Button>

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-2xl font-semibold">{pull.title}</h2>
        <Badge
          variant="outline"
          className={cn(
            "gap-1",
            pull.status === "merged" &&
              "border-success/40 bg-success/10 text-success",
            pull.status === "closed" && "text-muted-foreground",
            isOpen && "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          {pull.status === "merged" ? (
            <GitMergeIcon />
          ) : pull.status === "closed" ? (
            <GitPullRequestClosedIcon />
          ) : (
            <GitPullRequestIcon />
          )}
          {t(`pulls.status.${pull.status}`)}
        </Badge>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Avatar className="size-6 shrink-0">
          <AvatarFallback className="text-xs">
            {initial(pull.author)}
          </AvatarFallback>
        </Avatar>
        <p className="text-sm text-muted-foreground">
          {pull.authorId ? (
            <RouterLink
              to={`/users/${pull.authorId}`}
              className="text-inherit no-underline hover:underline"
            >
              {pull.author || t("pulls.anonymous")}
            </RouterLink>
          ) : (
            pull.author || t("pulls.anonymous")
          )}
          {pull.createdAt ? ` · ${formatDate(pull.createdAt)}` : ""}
        </p>
      </div>

      {/* A proposal can be updated while it is open, and a reviewer coming back to
          one needs to know that happened before they read it again. */}
      {(pull.revision > 1 || pull.headRef) && (
        <p className="mt-2 text-sm text-muted-foreground">
          {pull.revision > 1 &&
            t("pulls.revision", {
              n: pull.revision,
              when: pull.updatedAt ? formatDate(pull.updatedAt) : "",
            })}
          {pull.revision > 1 && pull.headRef ? " · " : ""}
          {pull.headRef && t("pulls.fromVariation", { name: pull.headRef })}
        </p>
      )}

      {pull.body && (
        <div className="mt-4 rounded-panel border border-border bg-card p-4">
          <p className="text-sm whitespace-pre-wrap">{pull.body}</p>
        </div>
      )}

      {pull.sourceLessonId && (
        <p className="mt-4 text-sm text-muted-foreground">
          <RouterLink
            to={`/hub/${pull.sourceLessonId}`}
            className="text-inherit no-underline hover:underline"
          >
            {t("pulls.viewFork")}
          </RouterLink>
        </p>
      )}

      {/* What it changes, and whether it would land cleanly. Drawn for a closed
          or merged proposal too — "what did that one do?" is a question people
          ask most often about the ones already resolved. */}
      {pull.ready && (
        <section className="mt-6 rounded-panel border border-border bg-card p-4">
          <h3 className="text-base font-medium">
            {t("pulls.changes.heading")}
          </h3>

          {changesError ? (
            <p className="mt-2 text-sm text-muted-foreground">{changesError}</p>
          ) : changes === null ? (
            <HistorySkeleton count={3} />
          ) : changes.ops.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("pulls.changes.none")}
            </p>
          ) : (
            <>
              <ChangeChips ops={changes.ops} className="mt-2" />
              <hr className="my-3 border-border" />
              <ChangeList ops={changes.ops} className="max-h-80" />
            </>
          )}

          {/* What the most recent update did, for a reviewer who has read this
              before. Only drawn when there has been one and its commits are
              still readable. */}
          {changes?.updateOps?.length > 0 && (
            <div className="mt-4 rounded-md border border-border p-3">
              <p className="text-sm font-medium">
                {t("pulls.changes.sinceUpdate")}
              </p>
              <ChangeChips ops={changes.updateOps} className="mt-2" />
              <ChangeList ops={changes.updateOps} className="mt-3 max-h-40" />
            </div>
          )}

          {/* Whether a reviewer would have anything to decide. Worth saying
              before they open the editor, because the usual answer is "no". */}
          {changes && isOpen && <Mergeability changes={changes} />}
        </section>
      )}

      {isOpen && pull.ready && canReview && (
        <div className="mt-6 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => review()}>
              <GitMergeIcon data-icon="inline-start" />
              {t("pulls.review")}
            </Button>
            {/* The middle option, which used to not exist: put it somewhere you
                can look at it. Reading a diff tells you what changed; it doesn't
                tell you whether the lesson still works. */}
            <Button variant="outline" onClick={() => review({ tryIt: true })}>
              <GitBranchIcon data-icon="inline-start" />
              {t("pulls.tryIt")}
            </Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pulls.reviewHint")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("pulls.tryItHint")}
          </p>
        </div>
      )}

      {/* Its own author is the only person who ever sees this: a proposal whose
          changes never finished uploading. Withdraw it and propose again. */}
      {isOpen && !pull.ready && (
        <Alert className="mt-6">
          <AlertDescription>{t("pulls.notUploaded")}</AlertDescription>
        </Alert>
      )}
    </PageBody>
  );
}
