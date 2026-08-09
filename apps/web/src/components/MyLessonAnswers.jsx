// "Your answers" — the signed-in reader's own saved run-throughs of this lesson,
// from interactive mode (InteractiveLesson.jsx).
//
// This panel is only ever rendered for the person who wrote the answers. The
// Worker scopes every read to the verified caller (see the privacy note in
// apps/api/src/routes/lessonResponses.js), so there is no version of this
// component that could show someone else's work even if it were asked to — not
// for the lesson's author, not for a moderator. It renders nothing at all when
// signed out, and nothing when the reader has never worked through this lesson,
// so it never advertises a feature by leaving an empty box on the page.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  LockIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { ListRowsSkeleton } from "./Skeletons.jsx";
import { hasApi } from "@spelling-creator/core/config";
import {
  deleteLessonResponse,
  fetchMyLessonResponses,
} from "@spelling-creator/core/lessonResponses";
import { useAuth } from "../lib/auth.jsx";

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// One saved run-through, collapsed to its date until opened. A learner who has
// been through a lesson several times gets a list they can scan, not several
// screens of unrolled answers.
function SavedRun({ response, onDelete, deleting }) {
  const { t } = useTranslation("interactive");
  const [open, setOpen] = useState(false);
  const answered = response.answers.filter((a) =>
    (a.answer || "").trim(),
  ).length;

  return (
    <div className="py-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start font-normal"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          <span className="truncate">
            {formatDateTime(response.completedAt)}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {t("saved.answeredCount", {
              answered,
              total: response.answers.length,
            })}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("saved.delete")}
          disabled={deleting}
          onClick={() => onDelete(response.id)}
        >
          <Trash2Icon />
        </Button>
      </div>

      {open && (
        <div className="mt-1 flex flex-col divide-y divide-border rounded-md border border-border">
          {response.answers.map((answer, index) => (
            <div key={answer.blockId || index} className="px-3 py-2.5">
              <p className="text-sm text-muted-foreground">
                {answer.prompt || t("step.noQuestionText")}
              </p>
              <p className="mt-1 text-sm whitespace-pre-wrap">
                {(answer.answer || "").trim() || (
                  <span className="text-muted-foreground italic">
                    {t("summary.skipped")}
                  </span>
                )}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The signed-in reader's saved run-throughs of one lesson.
 *
 * @param {string} props.lessonId
 * @param {number} [props.refreshToken]  Bump to re-fetch — the lesson page does
 *                                       this when a run-through is saved.
 */
export default function MyLessonAnswers({ lessonId, refreshToken = 0 }) {
  const { t } = useTranslation("interactive");
  const { user, accessToken, loading: authLoading } = useAuth();

  const [responses, setResponses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setResponses(await fetchMyLessonResponses(lessonId, accessToken));
    } catch (err) {
      setError(err.message || t("saved.couldNotLoad"));
    } finally {
      setLoading(false);
    }
  }, [lessonId, accessToken, t]);

  useEffect(() => {
    // Wait for the session before deciding there's nothing to fetch, or a
    // signed-in reader's answers would be skipped on a cold page load.
    if (authLoading || !hasApi() || !accessToken || !lessonId) {
      setResponses([]);
      return;
    }
    load();
  }, [authLoading, accessToken, lessonId, refreshToken, load]);

  const handleDelete = async (responseId) => {
    setDeletingId(responseId);
    try {
      await deleteLessonResponse(lessonId, responseId, accessToken);
      setResponses((current) =>
        current.filter((response) => response.id !== responseId),
      );
      toast(t("saved.deleted"));
    } catch (err) {
      toast(err.message || t("saved.couldNotDelete"));
    } finally {
      setDeletingId(null);
    }
  };

  // Signed out, no backend, or nothing saved yet: render nothing rather than an
  // empty panel. There is no call to action here — the way to fill this in is to
  // work through the lesson, which the page already offers above.
  if (!hasApi() || !user) return null;
  if (!loading && !error && responses.length === 0) return null;

  return (
    <section className="rounded-panel border border-border bg-card p-4 shadow-(--shadow-panel)">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">{t("saved.heading")}</h2>
        <LockIcon className="size-4 text-muted-foreground" />
      </div>
      <p className="mb-2 text-sm text-muted-foreground">
        {t("saved.privateNote")}
      </p>

      {loading && <ListRowsSkeleton count={2} />}

      {!loading && error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {error}
            <Button variant="ghost" size="sm" onClick={load}>
              {t("saved.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !error && (
        <div className="flex flex-col divide-y divide-border">
          {responses.map((response) => (
            <SavedRun
              key={response.id}
              response={response}
              deleting={deletingId === response.id}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}
