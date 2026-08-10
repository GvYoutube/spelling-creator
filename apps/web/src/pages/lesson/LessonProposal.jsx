// One proposal's own page (/hub/:id/proposals/:prId).
//
// Read-only, and that is not a shortcut. Merging a proposal is a genuine
// three-way merge against the lesson's git history, and that history lives in
// the editor's browser-side repository (LightningFS + isomorphic-git, loaded on
// demand) — not here, on a page whose whole point is to be cheap enough to
// server-render for a reader. So "Review & merge" does what it has always done:
// hands the editor the lesson and the proposal id, and the block-by-block merge
// happens there, where the objects are.
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
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from "lucide-react";
import PageBody from "../../components/layout/PageBody.jsx";
import { Button } from "../../components/ui/button.jsx";
import { Badge } from "../../components/ui/badge.jsx";
import { Alert, AlertDescription } from "../../components/ui/alert.jsx";
import { Avatar, AvatarFallback } from "../../components/ui/avatar.jsx";
import { ListRowsSkeleton } from "../../components/Skeletons.jsx";
import { cn } from "../../lib/utils.js";
import { useAuth } from "../../lib/auth.jsx";
import { fetchPullRequests } from "@spelling-creator/core/pulls";
import { EDIT_REQUEST_KEY } from "@spelling-creator/core/lessons";
import { useLesson } from "./LessonLayout.jsx";

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
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

  // Same hand-off as the list's "Review & merge" — see the file header. The
  // lesson id goes in the query string as well as sessionStorage because the
  // editor may already have a *different* lesson open, and a proposal is only
  // meaningful against the lesson it was opened on.
  const review = () => {
    try {
      sessionStorage.setItem(EDIT_REQUEST_KEY, lesson.id);
    } catch {
      /* ignore — the editor just won't preload if storage is unavailable */
    }
    navigate(
      `/editor?pull=${encodeURIComponent(prId)}&lesson=${encodeURIComponent(lesson.id)}`,
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

      {isOpen && pull.ready && canReview && (
        <div className="mt-6 border-t border-border pt-4">
          <Button onClick={review}>
            <GitMergeIcon data-icon="inline-start" />
            {t("pulls.review")}
          </Button>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pulls.reviewHint")}
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
