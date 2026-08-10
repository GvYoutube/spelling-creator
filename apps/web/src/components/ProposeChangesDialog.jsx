// Proposing your fork's changes back to the lesson it came from.
//
// You can fork anyone's lesson and do what you like with your copy, but you
// cannot write theirs. This dialog is the way work travels back: it opens a pull
// request against the original, carrying a snapshot of your lesson's history for
// its author — or one of the trusted collaborators they named — to review and
// merge. Nothing in their lesson changes until one of them says so.
//
// All this collects is the covering note. The changes themselves are the
// repository, packed and uploaded by the caller (see EditorPage's
// handleProposeChanges and core/browser/git/sync.js submitPullRequest).

import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { GitPullRequestIcon, InfoIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.jsx";
import { Button } from "./ui/button.jsx";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "./ui/field.jsx";
import { Input } from "./ui/input.jsx";
import { Textarea } from "./ui/textarea.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Spinner } from "./ui/spinner.jsx";
import { PULL_BODY_MAX, PULL_TITLE_MAX } from "@spelling-creator/core/pulls";

/**
 * @param {object}   props
 * @param {boolean}  props.open          Whether the dialog is shown.
 * @param {string}   props.lessonTitle   The lesson being proposed to.
 * @param {boolean}  props.busy          A submission is in flight.
 * @param {() => void} props.onClose     Dismiss handler.
 * @param {(fields: { title: string, body: string }) => void} props.onSubmit
 */
export default function ProposeChangesDialog({
  open,
  lessonTitle,
  busy,
  onClose,
  onSubmit,
}) {
  const { t } = useTranslation("editorTools");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  // Start from a blank note each time, so a withdrawn attempt doesn't leave its
  // wording sitting in the next one.
  useEffect(() => {
    if (open) {
      setTitle("");
      setBody("");
    }
  }, [open]);

  const name = lessonTitle || t("proposeDialog.defaultLessonName");
  const trimmed = title.trim();

  const submit = (e) => {
    e.preventDefault();
    if (!trimmed || busy) return;
    onSubmit({ title: trimmed, body: body.trim() });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose?.();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequestIcon className="size-4" />
            <span>{t("proposeDialog.title", { name })}</span>
          </DialogTitle>
          <DialogDescription>
            {t("proposeDialog.description", { name })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit}>
          <FieldGroup>
            <Alert>
              <InfoIcon />
              <AlertDescription>
                <Trans
                  i18nKey="proposeDialog.notice"
                  ns="editorTools"
                  values={{ name }}
                  components={{ strong: <strong className="font-medium" /> }}
                />
              </AlertDescription>
            </Alert>

            <Field>
              <FieldLabel htmlFor="propose-title">
                {t("proposeDialog.titleLabel")}
              </FieldLabel>
              <Input
                id="propose-title"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("proposeDialog.titlePlaceholder")}
                disabled={busy}
                maxLength={PULL_TITLE_MAX}
              />
              <FieldDescription>
                {t("proposeDialog.titleHint")}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="propose-body">
                {t("proposeDialog.bodyLabel")}
              </FieldLabel>
              <Textarea
                id="propose-body"
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t("proposeDialog.bodyPlaceholder")}
                disabled={busy}
                maxLength={PULL_BODY_MAX}
              />
              <FieldDescription>{t("proposeDialog.bodyHint")}</FieldDescription>
            </Field>
          </FieldGroup>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={busy}
            >
              {t("proposeDialog.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !trimmed}>
              {busy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <GitPullRequestIcon data-icon="inline-start" />
              )}
              {busy ? t("proposeDialog.submitting") : t("proposeDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
