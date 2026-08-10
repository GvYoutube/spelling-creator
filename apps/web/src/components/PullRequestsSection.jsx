// Proposed changes to a lesson: the body of its Proposals tab.
//
// Anyone can fork a lesson, but nobody can write someone else's. To offer work
// back you open a pull request from your fork (the editor's "Propose changes to
// …"), and it lands here — publicly, like a comment, so a lesson's history of
// contributions is visible rather than happening in private.
//
// Who can do what, from this list:
//
//   anyone signed in       nothing but read
//   the person who opened  withdraw their own proposal
//   the lesson's author    review & merge, or decline
//   a trusted collaborator the same as the author (they're who the author trusts
//                          with this lesson — see the collaboration dialog)
//   a moderator            close it, as with any other user-submitted text
//
// "Review & merge" doesn't merge anything here: it opens the lesson in the
// editor with the proposal in hand, because the merge is a real three-way merge
// against the lesson's git history and that lives in the editor (see
// EditorPage's pull-request review effect). What arrives is the usual block-by-
// block merge dialog, and nothing is written until it's confirmed.

import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  XIcon,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Badge } from "./ui/badge.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Avatar, AvatarFallback } from "./ui/avatar.jsx";
import { Spinner } from "./ui/spinner.jsx";
import { ListRowsSkeleton } from "./Skeletons.jsx";
import PageBody from "./layout/PageBody.jsx";
import { cn } from "../lib/utils.js";
import { useAuth } from "../lib/auth.jsx";
import {
  closePullRequest,
  fetchPullRequests,
} from "@spelling-creator/core/pulls";
import { EDIT_REQUEST_KEY } from "@spelling-creator/core/lessons";

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/**
 * @param {object} props
 * @param {string} props.lessonId
 * @param {boolean} [props.standalone]  True when this *is* the page (the
 *   lesson's Proposals tab) rather than a section stacked under the lesson.
 *   A tab someone deliberately opened has to answer them even when the answer
 *   is "none" — and it can afford a loading state, which the stacked version
 *   could not. See the comment on the early return below.
 */
export default function PullRequestsSection({ lessonId, standalone = false }) {
  const { t } = useTranslation("lesson");
  const navigate = useNavigate();
  const { user, accessToken, isModerator } = useAuth();

  const [pulls, setPulls] = useState([]);
  // Whether this viewer may merge or decline these — the server's answer, since
  // it turns on the lesson's trusted-collaborator list. Actions re-check it.
  const [canReview, setCanReview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // The proposals a close is in flight for, so each button spins for its own
  // request and no other. A set rather than one id: closing a second before the
  // first has come back is an ordinary thing to do when clearing a queue, and
  // with a single id the first to finish would clear the other's spinner, put a
  // live button back under the pointer, and invite a duplicate close.
  const [closingIds, setClosingIds] = useState(() => new Set());

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    fetchPullRequests(lessonId, accessToken)
      .then((result) => {
        if (cancelled) return;
        setPulls(result.pulls);
        setCanReview(result.canReview);
        setError("");
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
  }, [lessonId, accessToken, t]);

  useEffect(() => load(), [load]);

  // Open the lesson in the editor with this proposal ready to review. The editor
  // consumes the lesson id from sessionStorage exactly as the "Edit" action does
  // (warning first if there's in-progress work to protect), and picks the
  // proposal up from the query string once the lesson is loaded.
  //
  // The lesson id goes in the query string too, and not only into sessionStorage.
  // The editor may already have a *different* lesson open and its repository
  // ready when we arrive — the one the reviewer was working on — and a proposal
  // is only meaningful against the lesson it was opened on. Naming the target
  // here is what lets the editor wait for the right one instead of reviewing
  // against whatever happened to be loaded (see EditorPage's review effect).
  const review = (pull) => {
    try {
      sessionStorage.setItem(EDIT_REQUEST_KEY, lessonId);
    } catch {
      /* ignore — the editor just won't preload if storage is unavailable */
    }
    navigate(
      `/editor?pull=${encodeURIComponent(pull.id)}&lesson=${encodeURIComponent(lessonId)}`,
    );
  };

  const close = async (pull) => {
    setClosingIds((prev) => new Set(prev).add(pull.id));
    try {
      const updated = await closePullRequest(lessonId, pull.id, accessToken);
      setPulls((prev) =>
        prev.map((p) => (p.id === pull.id ? updated || p : p)),
      );
      toast.success(
        pull.authorId === user?.id
          ? t("pulls.withdrawn")
          : t("pulls.closedToast"),
      );
    } catch (err) {
      toast.error(err.message || t("pulls.closeError"));
    } finally {
      // Only this one — another close may still be in flight.
      setClosingIds((prev) => {
        const next = new Set(prev);
        next.delete(pull.id);
        return next;
      });
    }
  };

  const open = pulls.filter((p) => p.status === "open");
  const resolved = pulls.filter((p) => p.status !== "open");

  // Stacked under a lesson, most lessons have never had a proposal, so this
  // section usually resolves to nothing at all — and it's rendered on a
  // server-rendered page. A skeleton there would put a "Proposed changes"
  // heading into the HTML of every lesson on the hub and then take it away
  // again a moment later. So it stays silent until there is something to show.
  //
  // As a tab of its own none of that applies: the heading is the tab you
  // clicked, and "no proposals yet" is the answer you came for.
  if (!standalone && (loading || (!error && pulls.length === 0))) return null;

  if (standalone && loading) {
    return (
      <PageBody width="reading">
        <ListRowsSkeleton count={3} />
      </PageBody>
    );
  }

  const row = (pull) => {
    const mine = pull.authorId && pull.authorId === user?.id;
    const isOpen = pull.status === "open";
    const canClose = isOpen && (mine || canReview || isModerator);
    const closing = closingIds.has(pull.id);

    return (
      <div key={pull.id} className="flex items-start gap-3 py-3">
        <Avatar className="shrink-0">
          <AvatarFallback>{initial(pull.author)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {standalone ? (
              <RouterLink
                to={`/hub/${lessonId}/proposals/${pull.id}`}
                className="text-sm font-semibold text-inherit no-underline hover:underline"
              >
                {pull.title}
              </RouterLink>
            ) : (
              <span className="text-sm font-semibold">{pull.title}</span>
            )}
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
            {/* Only its own author ever sees this: a proposal whose changes
                never finished uploading. Withdraw it and propose again. */}
            {isOpen && !pull.ready && (
              <Badge variant="outline" className="text-muted-foreground">
                {t("pulls.notUploaded")}
              </Badge>
            )}
          </div>

          <p className="mt-0.5 text-xs text-muted-foreground">
            {pull.authorId ? (
              <button
                type="button"
                onClick={() => navigate(`/users/${pull.authorId}`)}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs text-muted-foreground hover:underline"
              >
                {pull.author || t("pulls.anonymous")}
              </button>
            ) : (
              pull.author || t("pulls.anonymous")
            )}
            {pull.createdAt ? ` · ${formatDate(pull.createdAt)}` : ""}
            {pull.sourceLessonId ? " · " : ""}
            {pull.sourceLessonId && (
              <button
                type="button"
                onClick={() => navigate(`/hub/${pull.sourceLessonId}`)}
                className="cursor-pointer border-0 bg-transparent p-0 text-xs text-muted-foreground hover:underline"
              >
                {t("pulls.viewFork")}
              </button>
            )}
          </p>

          {pull.body && (
            <p className="mt-1.5 text-sm whitespace-pre-wrap">{pull.body}</p>
          )}

          {(canClose || (isOpen && pull.ready && canReview)) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {isOpen &&
                pull.ready &&
                canReview && (
                  // Not while it's being closed: leaving for the editor mid-close
                  // would send the reviewer to merge something that is about to
                  // stop being open.
                  <Button
                    size="sm"
                    onClick={() => review(pull)}
                    disabled={closing}
                  >
                    <GitMergeIcon data-icon="inline-start" />
                    {t("pulls.review")}
                  </Button>
                )}
              {canClose && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => close(pull)}
                  disabled={closing}
                >
                  {closing ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <XIcon data-icon="inline-start" />
                  )}
                  {mine ? t("pulls.withdraw") : t("pulls.close")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const body = (
    <section>
      <h2 className="text-lg font-semibold">
        {t("pulls.heading", { count: open.length })}
      </h2>

      {error ? (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : pulls.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("pulls.emptyState")}
        </p>
      ) : (
        <div className="mt-1 flex flex-col divide-y divide-border">
          {open.map(row)}
          {resolved.map(row)}
        </div>
      )}
    </section>
  );

  // As a tab this component owns its page column; stacked under something else
  // it must not, or it would nest one column inside another. Wrapping the same
  // element rather than swapping the component type — a component built inline
  // is a new type every render, which would remount the whole list each time.
  return standalone ? <PageBody width="reading">{body}</PageBody> : body;
}
