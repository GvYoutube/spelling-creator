// Comments on a published lesson, shown beneath the lesson preview in the hub.
// Reading is public; posting needs a signed-in Supabase session (the same one
// that gates publishing). The Worker moderates posts — a comment containing
// profanity is rejected and its reason is surfaced here as an error.
//
// Comments are threaded: a comment may reply to another. The Worker returns a
// flat, oldest-first list where each comment carries a `parentId` (null for a
// top-level comment); we nest replies under their parent here. Posting a reply
// also notifies the parent comment's author and the lesson author — handled
// entirely server-side.
//
// Comments are rich text: written with RichTextInput (tiptap) and stored as
// sanitized HTML, rendered back through RichText. Formatting and links only — no
// images or other media, which the Worker's sanitizer is what actually enforces
// (apps/api/src/lib/richtext.js).
//
// An author may edit their own comment after posting; the thread then shows an
// "edited" marker, so a comment never changes silently under someone reading it.
// Moderators can delete a comment but not rewrite it — see handleCommentEdit.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EllipsisVerticalIcon, Trash2Icon, BanIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert.jsx";
import { Avatar, AvatarFallback } from "./ui/avatar.jsx";
import { Spinner } from "./ui/spinner.jsx";
import { StarRating } from "./ui/star-rating.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.jsx";
import { CommentsSkeleton } from "./Skeletons.jsx";
import RichText from "./RichText.jsx";
import RichTextInput from "./RichTextInput.jsx";
import { cn } from "../lib/utils.js";
import { useAuth } from "../lib/auth.jsx";
import {
  fetchComments,
  postComment,
  updateComment,
  deleteComment,
  COMMENT_BLOCKED_STATUS,
  COMMENT_MAX,
} from "../lib/comments.js";
import { isRichTextEmpty, richTextLength } from "../lib/richText.js";
import { banName } from "../lib/moderation.js";

// How deep replies are allowed to indent before they stop nesting further. Deeper
// replies still thread (they sit under their parent) but share the cap's inset, so
// a long back-and-forth doesn't march off the right edge.
const MAX_INDENT_DEPTH = 4;

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

// Whether a rich-text draft can be submitted: it must say something, and must fit.
function isSubmittable(html) {
  return !isRichTextEmpty(html) && richTextLength(html) <= COMMENT_MAX;
}

// A dismissible post/reply/edit notice. `severity: "warning"` is an expected,
// user-correctable outcome (a profanity block) shown with a title; "error" is
// a genuine failure shown plainly, matching Alert's destructive variant.
function Notice({ notice, blockedTitle, onDismiss }) {
  const { t } = useTranslation("lesson");
  if (!notice) return null;
  const warning = notice.severity === "warning";
  return (
    <Alert
      variant={warning ? undefined : "destructive"}
      className={cn(
        "relative mt-2 pr-9",
        warning && "border-focus/40 bg-focus/10 text-focus",
      )}
    >
      {warning && (
        <AlertTitle className="text-focus">{blockedTitle}</AlertTitle>
      )}
      <AlertDescription className={warning ? "text-focus" : undefined}>
        {notice.message}
      </AlertDescription>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("comments.dismiss")}
        className="absolute top-3 right-3 cursor-pointer rounded-sm border-0 bg-transparent p-0.5 text-current opacity-70 transition-opacity hover:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </Alert>
  );
}

export default function CommentsSection({ lessonId, onRated }) {
  const { t } = useTranslation("lesson");
  const navigate = useNavigate();
  const { enabled: authEnabled, user, accessToken, isModerator } = useAuth();

  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Drafts are rich-text HTML, not plain strings. `draftKey` remounts the editor:
  // tiptap owns its content once mounted, so bumping the key is how we clear the box
  // after a successful post.
  const [draft, setDraft] = useState("");
  const [draftKey, setDraftKey] = useState(0);
  // Optional 1–5 star rating posted with a top-level comment. null = not rating.
  const [ratingValue, setRatingValue] = useState(null);
  const [posting, setPosting] = useState(false);
  // A notice shown under the post box after a failed submit. `severity` is
  // "warning" when the comment was blocked for profanity (an expected,
  // user-correctable outcome) and "error" for genuine failures.
  const [postNotice, setPostNotice] = useState(null);

  // Reply state. Only one reply box is open at a time, keyed by the id of the
  // comment being replied to (`replyTo`).
  const [replyTo, setReplyTo] = useState(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyPosting, setReplyPosting] = useState(false);
  const [replyNotice, setReplyNotice] = useState(null);

  // Edit state, mirroring the reply state: one open editor at a time, keyed by the
  // id of the comment being edited. You may only edit your own comment — the Worker
  // enforces that from the verified session, this just declines to offer the button.
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editNotice, setEditNotice] = useState(null);

  // Group the flat list into parent -> [replies] (preserving the oldest-first
  // order the Worker returns) so we can render the thread recursively.
  const childrenByParent = useMemo(() => {
    const map = new Map();
    for (const c of comments) {
      if (!c.parentId) continue;
      if (!map.has(c.parentId)) map.set(c.parentId, []);
      map.get(c.parentId).push(c);
    }
    return map;
  }, [comments]);
  const topLevel = useMemo(
    () => comments.filter((c) => !c.parentId),
    [comments],
  );

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setComments(await fetchComments(lessonId, accessToken));
    } catch (err) {
      setError(err.message || t("comments.couldNotLoad"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (lessonId) load();
    // Reset the in-progress draft state when switching lessons.
    setDraft("");
    setDraftKey((k) => k + 1);
    setRatingValue(null);
    setPostNotice(null);
    setReplyTo(null);
    setReplyDraft("");
    setReplyNotice(null);
    setEditing(null);
    setEditDraft("");
    setEditNotice(null);
    // Intentionally re-run only when the lesson changes, not when `load` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);

  const submit = async (e) => {
    e.preventDefault();
    if (!isSubmittable(draft) || posting) return;
    setPosting(true);
    setPostNotice(null);
    try {
      const { comment, rating } = await postComment(
        lessonId,
        draft,
        accessToken,
        undefined,
        ratingValue,
      );
      // Append the new comment to the (oldest-first) list and clear the box (the key
      // bump remounts the editor, which is what actually empties it).
      setComments((prev) => [...prev, comment]);
      setDraft("");
      setDraftKey((k) => k + 1);
      // If a rating rode along, hand the lesson page its new average and reset
      // the stars so a follow-up comment doesn't re-submit the same rating.
      if (rating) {
        onRated?.(rating);
        setRatingValue(null);
      }
    } catch (err) {
      // A profanity block is an expected, fixable outcome — show it as a warning
      // (and keep the draft so the user can edit it). Everything else is an error.
      const blocked = err.status === COMMENT_BLOCKED_STATUS;
      setPostNotice({
        severity: blocked ? "warning" : "error",
        message: err.message || t("comments.couldNotPost"),
      });
    } finally {
      setPosting(false);
    }
  };

  const openReply = (id) => {
    setReplyTo(id);
    setReplyDraft("");
    setReplyNotice(null);
  };

  const cancelReply = () => {
    setReplyTo(null);
    setReplyDraft("");
    setReplyNotice(null);
  };

  const submitReply = async (e) => {
    e.preventDefault();
    if (!isSubmittable(replyDraft) || replyPosting || !replyTo) return;
    setReplyPosting(true);
    setReplyNotice(null);
    try {
      const { comment: reply } = await postComment(
        lessonId,
        replyDraft,
        accessToken,
        replyTo,
      );
      // Append; the render derives the thread from parentId, so it lands under
      // the comment it replies to.
      setComments((prev) => [...prev, reply]);
      cancelReply();
    } catch (err) {
      const blocked = err.status === COMMENT_BLOCKED_STATUS;
      setReplyNotice({
        severity: blocked ? "warning" : "error",
        message: err.message || t("comments.couldNotPostReply"),
      });
    } finally {
      setReplyPosting(false);
    }
  };

  // Editing your own comment. Seeded with the comment's current body, so the editor
  // opens showing exactly what's on screen — formatting and all.
  const openEdit = (c) => {
    setEditing(c.id);
    setEditDraft(c.body || "");
    setEditNotice(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditDraft("");
    setEditNotice(null);
  };

  const submitEdit = async (e, c) => {
    e.preventDefault();
    if (!isSubmittable(editDraft) || editSaving) return;
    setEditSaving(true);
    setEditNotice(null);
    try {
      const saved = await updateComment(lessonId, c.id, editDraft, accessToken);
      // Swap the updated comment into place. The Worker returns the stored (sanitized)
      // body and the fresh `editedAt`, so the thread shows what was really saved
      // rather than what we hoped was.
      setComments((prev) =>
        prev.map((item) =>
          item.id === saved.id ? { ...item, ...saved } : item,
        ),
      );
      cancelEdit();
    } catch (err) {
      // Same shape as posting: a profanity block is a fixable warning (keep the
      // draft), anything else is an error.
      const blocked = err.status === COMMENT_BLOCKED_STATUS;
      setEditNotice({
        severity: blocked ? "warning" : "error",
        message: err.message || t("comments.couldNotSaveEdit"),
      });
    } finally {
      setEditSaving(false);
    }
  };

  // Moderator: delete a comment. The Worker cascades its replies, so mirror that
  // locally by dropping the comment and every descendant from the flat list.
  const handleDeleteComment = async (c) => {
    try {
      await deleteComment(c.id, accessToken);
      setComments((prev) => {
        const removed = new Set([c.id]);
        // The list is oldest-first, so a single forward pass catches every
        // descendant (a reply always follows the parent it points at).
        for (const item of prev) {
          if (item.parentId && removed.has(item.parentId)) removed.add(item.id);
        }
        return prev.filter((item) => !removed.has(item.id));
      });
      toast(t("comments.commentDeleted"));
    } catch (err) {
      toast(err.message || t("comments.couldNotDeleteComment"));
    }
  };

  // Moderator: ban the comment author by display name (blocks them from posting
  // further comments or lessons). Existing content is left in place.
  const handleBanAuthor = async (c) => {
    const name = c.author || "";
    if (!name) {
      toast(t("comments.noAuthorNameToBan"));
      return;
    }
    try {
      await banName(name, accessToken);
      toast(t("comments.bannedName", { name }));
    } catch (err) {
      toast(err.message || t("comments.couldNotBanAuthor"));
    }
  };

  // Render a comment and, recursively, its replies. A function (not a component)
  // so it closes over the shared reply state without remounting on every render.
  const renderComment = (c, depth) => {
    const replies = childrenByParent.get(c.id) || [];
    const indented = depth > 0;
    return (
      <div key={c.id}>
        <div className="flex items-start gap-3">
          <Avatar className="shrink-0">
            <AvatarFallback>{initial(c.author)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">
                {c.authorId ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/users/${c.authorId}`)}
                    className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-foreground hover:underline"
                  >
                    {c.author || t("comments.anonymous")}
                  </button>
                ) : (
                  c.author || t("comments.anonymous")
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(c.createdAt)}
                {/* An edit is never silent: say so, so a reader can tell the comment
                    they're looking at isn't necessarily the one that was replied to. */}
                {c.editedAt ? ` · ${t("comments.edited")}` : ""}
              </span>
              {/* Moderator-only actions on this comment. */}
              {isModerator && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("comments.moderateCommentAriaLabel")}
                      className="ml-auto"
                    >
                      <EllipsisVerticalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => handleDeleteComment(c)}>
                      <Trash2Icon />
                      {t("comments.deleteComment")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => handleBanAuthor(c)}>
                      <BanIcon />
                      {t("comments.banAuthorByName")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {/* Editing swaps the body for an editor seeded with it; otherwise the
                stored rich text renders (or plain text, for older comments). */}
            {editing === c.id ? (
              <form onSubmit={(e) => submitEdit(e, c)} className="mt-2">
                <RichTextInput
                  value={editDraft}
                  onChange={setEditDraft}
                  maxLength={COMMENT_MAX}
                  label={t("comments.editYourComment")}
                  disabled={editSaving}
                  autoFocus
                />
                <Notice
                  notice={editNotice}
                  blockedTitle={t("comments.editBlocked")}
                  onDismiss={() => setEditNotice(null)}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelEdit}
                    disabled={editSaving}
                  >
                    {t("comments.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={editSaving || !isSubmittable(editDraft)}
                  >
                    {editSaving && <Spinner data-icon="inline-start" />}
                    {editSaving
                      ? t("comments.saving")
                      : t("comments.saveChanges")}
                  </Button>
                </div>
              </form>
            ) : (
              <RichText value={c.body} />
            )}

            {/* Replying and editing both need a signed-in session; editing further
                needs the comment to be yours (the Worker checks this for real). */}
            {editing !== c.id && authEnabled && user && (
              <div className="mt-1 flex gap-1">
                {replyTo !== c.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto min-w-0 px-1 py-0.5"
                    onClick={() => openReply(c.id)}
                  >
                    {t("comments.reply")}
                  </Button>
                )}
                {c.authorId === user.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto min-w-0 px-1 py-0.5"
                    onClick={() => openEdit(c)}
                  >
                    {t("comments.edit")}
                  </Button>
                )}
              </div>
            )}

            {replyTo === c.id && (
              <form onSubmit={submitReply} className="mt-2">
                <RichTextInput
                  value={replyDraft}
                  onChange={setReplyDraft}
                  maxLength={COMMENT_MAX}
                  label={t("comments.replyToAuthor", {
                    author: c.author || t("comments.anonymous"),
                  })}
                  placeholder={t("comments.replyToAuthorPlaceholder", {
                    author: c.author || t("comments.anonymous"),
                  })}
                  disabled={replyPosting}
                  autoFocus
                />
                <Notice
                  notice={replyNotice}
                  blockedTitle={t("comments.replyBlocked")}
                  onDismiss={() => setReplyNotice(null)}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelReply}
                    disabled={replyPosting}
                  >
                    {t("comments.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={replyPosting || !isSubmittable(replyDraft)}
                  >
                    {replyPosting && <Spinner data-icon="inline-start" />}
                    {replyPosting
                      ? t("comments.posting")
                      : t("comments.postReply")}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>

        {replies.length > 0 && (
          <div
            className={cn(
              "mt-3 flex flex-col gap-3 border-l border-border pl-4",
              !indented && "ml-2",
            )}
          >
            {replies.map((r) =>
              renderComment(r, Math.min(depth + 1, MAX_INDENT_DEPTH)),
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mt-2">
      <hr className="mb-3 border-border" />
      <h2 className="mb-2 text-base font-semibold">
        {t("comments.heading")}
        {!loading && !error
          ? t("comments.commentCountSuffix", { count: comments.length })
          : ""}
      </h2>

      {loading && <CommentsSkeleton />}

      {!loading && error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            {error}
            <Button variant="ghost" size="sm" onClick={load}>
              {t("comments.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !error && (
        <div className="flex flex-col gap-3">
          {topLevel.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("comments.noCommentsYet")}
            </p>
          )}

          {topLevel.map((c) => renderComment(c, 0))}

          <hr className="border-border" />

          {/* Posting needs a signed-in session, mirroring how publishing works. */}
          {!authEnabled ? (
            <p className="text-sm text-muted-foreground">
              {t("comments.signInNotConfigured")}
            </p>
          ) : user ? (
            <form onSubmit={submit}>
              <RichTextInput
                key={draftKey}
                value={draft}
                onChange={setDraft}
                maxLength={COMMENT_MAX}
                label={t("comments.addComment")}
                placeholder={t("comments.addCommentPlaceholder")}
                disabled={posting}
              />
              <Notice
                notice={postNotice}
                blockedTitle={t("comments.commentBlocked")}
                onDismiss={() => setPostNotice(null)}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                {/* Optional star rating for the lesson, posted with the comment. */}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t("comments.rateThisLesson")}
                  </span>
                  <StarRating
                    value={ratingValue}
                    onChange={setRatingValue}
                    disabled={posting}
                    aria-label={t("comments.lessonRatingAriaLabel")}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={posting || !isSubmittable(draft)}
                >
                  {posting && <Spinner data-icon="inline-start" />}
                  {posting ? t("comments.posting") : t("comments.postComment")}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {t("comments.signInToJoin")}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/login")}
              >
                {t("comments.signIn")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
