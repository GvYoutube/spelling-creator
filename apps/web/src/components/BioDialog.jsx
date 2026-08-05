// A small dialog for editing your public bio — the "about me" shown on your
// profile page. Mirrors DisplayNameDialog: saving goes through the Worker
// (lib/profile.setBio), which validates length and profanity before storing it in
// user_metadata; on success we refresh the session so `user` reflects the change.
//
// The bio is rich text, written with the same editor as a comment (RichTextInput):
// formatting and links, but no images or other media. The Worker sanitizes whatever
// arrives, so what it stores is only ever what the allow-list permits.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlertIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.jsx";
import { Button } from "./ui/button.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Spinner } from "./ui/spinner.jsx";
import RichTextInput from "./RichTextInput.jsx";
import { useAuth } from "../lib/auth.jsx";
import { setBio, BIO_MAX } from "@spelling-creator/core/profile";
import { richTextLength } from "../lib/richText.js";

/**
 * @param {object}     props
 * @param {boolean}    props.open       Whether the dialog is shown.
 * @param {string}     [props.initial]  The current bio to seed the field with.
 * @param {() => void} [props.onClose]  Dismiss handler.
 * @param {(bio: string) => void} [props.onSaved]  Called with the saved bio so the
 *                                       profile page can update without a refetch.
 */
export default function BioDialog({ open, initial = "", onClose, onSaved }) {
  const { t } = useTranslation("profile");
  const { accessToken, refreshSession } = useAuth();
  // The bio as rich-text HTML. `editorKey` remounts the editor when the dialog
  // reopens — tiptap owns its content after mount, so re-seeding it needs a remount.
  const [html, setHtml] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Seed the editor with the current bio each time it opens.
  useEffect(() => {
    if (open) {
      setHtml(initial || "");
      setEditorKey((k) => k + 1);
      setError("");
    }
  }, [open, initial]);

  // Measured over the words, not the markup — the same way the Worker measures it.
  const tooLong = richTextLength(html) > BIO_MAX;

  const save = async (e) => {
    e.preventDefault();
    setError("");
    if (tooLong) return;
    setSaving(true);
    try {
      const saved = await setBio(html, accessToken);
      // Pull the new metadata into the session so the UI reflects it elsewhere.
      await refreshSession();
      if (onSaved) onSaved(saved);
      if (onClose) onClose();
    } catch (err) {
      setError(err.message || t("bioDialog.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose?.();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("bioDialog.title")}</DialogTitle>
          <DialogDescription>{t("bioDialog.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save}>
          <div className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <RichTextInput
              key={editorKey}
              value={html}
              onChange={setHtml}
              maxLength={BIO_MAX}
              label={t("bioDialog.fieldLabel")}
              placeholder={t("bioDialog.placeholder")}
              disabled={saving}
              autoFocus
            />
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={saving}
            >
              {t("bioDialog.cancel")}
            </Button>
            <Button type="submit" disabled={saving || tooLong}>
              {saving && <Spinner data-icon="inline-start" />}
              {t("bioDialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
