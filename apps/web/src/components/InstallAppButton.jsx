// The "Install app" control in the header (see NavActions.jsx, which renders
// it). Absent unless the browser has told us the app is installable, or we're
// on iOS Safari where installing is a manual Share-sheet action — the detection
// lives in ../lib/useInstallPrompt.js.
//
// On Chromium it calls the deferred prompt directly. On iOS there is no API, so
// it opens a dialog spelling out the two taps instead.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon, SquarePlusIcon, ShareIcon } from "lucide-react";
import { useInstallPrompt } from "../lib/useInstallPrompt.js";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog.jsx";

/**
 * @param {object} props
 * @param {string} props.className  NavActions' shared icon-trigger styling — the
 *                                  button sits on AppHeader's --primary surface,
 *                                  so it can't style itself from the usual tokens.
 */
export default function InstallAppButton({ className }) {
  const { t } = useTranslation("common");
  const { canInstall, needsManual, install } = useInstallPrompt();
  const [helpOpen, setHelpOpen] = useState(false);

  if (!canInstall) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("install.ariaLabel")}
            onClick={() => (needsManual ? setHelpOpen(true) : install())}
            className={className}
          >
            <DownloadIcon />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t("install.tooltip")}</TooltipContent>
      </Tooltip>

      {needsManual && (
        <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("install.iosTitle")}</DialogTitle>
              <DialogDescription>
                {t("install.iosDescription")}
              </DialogDescription>
            </DialogHeader>
            <ol className="m-0 flex list-none flex-col gap-3 p-0 text-sm">
              <li className="flex items-center gap-3">
                <ShareIcon className="shrink-0 text-muted-foreground" />
                {t("install.iosStepShare")}
              </li>
              <li className="flex items-center gap-3">
                <SquarePlusIcon className="shrink-0 text-muted-foreground" />
                {t("install.iosStepAdd")}
              </li>
            </ol>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
