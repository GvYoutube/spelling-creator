// Right-hand header cluster shared by every page: a link to the lesson hub, a
// light/dark toggle, and an account control that reflects the Supabase auth
// state (sign in / sign out). Signed-in users also get a notification bell.
//
// The trigger elements below (the hub link, the icon buttons) sit directly on
// AppHeader's colored --primary surface, not on the page's own light/dark
// background — so they're styled from --primary-foreground rather than the
// usual --foreground/--muted-foreground tokens. --primary-foreground flips
// correctly with the theme (near-white text on both the light-mode indigo and
// the dark-mode's own deeper indigo), so this works in both themes. The
// dropdown menu itself isn't constrained the same way — it floats above
// everything as its own surface — so it uses the usual design tokens
// throughout.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  BookMarkedIcon,
  CircleUserIcon,
  ShieldIcon,
  IdCardIcon,
  UserIcon,
  SunIcon,
  MoonIcon,
} from "lucide-react";
import { cn } from "../lib/utils.js";
import { useAuth } from "../lib/auth.jsx";
import { useColorScheme } from "../lib/colorScheme.jsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu.jsx";
import NotificationBell from "./NotificationBell.jsx";
import DisplayNameDialog from "./DisplayNameDialog.jsx";

// See the file header for why these use --primary-foreground rather than
// the usual tokens. bg-transparent and border-0/cursor-pointer are explicit
// (not just hover:bg-primary-foreground/10) because Tailwind's preflight
// reset is off for now (see globals.css), so a plain <button> still gets the
// browser's default gray button chrome.
const iconTrigger =
  "inline-flex size-10 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10";
const outlineTrigger =
  "inline-flex items-center gap-2 rounded-md border border-primary-foreground/60 bg-transparent px-4 py-2 text-sm font-medium text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10";

export default function NavActions({ current }) {
  const { t } = useTranslation("common");
  const { enabled, user, displayName, signOut, isModerator } = useAuth();
  const { resolved, setScheme } = useColorScheme();
  const navigate = useNavigate();
  const [nameDialogOpen, setNameDialogOpen] = useState(false);

  return (
    <>
      {current !== "hub" && (
        <>
          {/* Full button on md+ screens, icon-only below (the AppBar can't
              fit text buttons on narrow screens). */}
          <Tooltip>
            <TooltipTrigger asChild>
              <RouterLink
                to="/hub"
                aria-label={t("nav.lessonHubAriaLabel")}
                className={cn(iconTrigger, "md:hidden")}
              >
                <BookMarkedIcon />
              </RouterLink>
            </TooltipTrigger>
            <TooltipContent>{t("nav.lessonHub")}</TooltipContent>
          </Tooltip>
          <RouterLink
            to="/hub"
            className={cn(outlineTrigger, "hidden md:inline-flex")}
          >
            <BookMarkedIcon data-icon="inline-start" />
            {t("nav.lessonHub")}
          </RouterLink>
        </>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={
              resolved === "dark"
                ? t("nav.switchToLightMode")
                : t("nav.switchToDarkMode")
            }
            onClick={() => setScheme(resolved === "dark" ? "light" : "dark")}
            className={iconTrigger}
          >
            {resolved === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {resolved === "dark"
            ? t("nav.switchToLightMode")
            : t("nav.switchToDarkMode")}
        </TooltipContent>
      </Tooltip>

      {!enabled ? null : user ? (
        <>
          <NotificationBell />
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("nav.accountMenuAriaLabel")}
                    className={iconTrigger}
                  >
                    <CircleUserIcon />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{user.email || t("nav.account")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="flex flex-col">
                <span>{displayName || t("nav.signedIn")}</span>
                <span className="break-all text-xs font-normal text-muted-foreground">
                  {user.email}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate(`/users/${user.id}`)}>
                <UserIcon />
                {t("nav.myProfile")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setNameDialogOpen(true)}>
                <IdCardIcon />
                {t("nav.editDisplayName")}
              </DropdownMenuItem>
              {isModerator && (
                <DropdownMenuItem onClick={() => navigate("/moderation")}>
                  <ShieldIcon />
                  {t("nav.moderation")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={signOut}>
                {t("nav.signOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("nav.accountMenuAriaLabel")}
                  className={iconTrigger}
                >
                  <CircleUserIcon />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("nav.account")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t("nav.signedOut")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/login")}>
              {t("nav.signIn")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {user && (
        <DisplayNameDialog
          open={nameDialogOpen}
          onClose={() => setNameDialogOpen(false)}
        />
      )}
    </>
  );
}
