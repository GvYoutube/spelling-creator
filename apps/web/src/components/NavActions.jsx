// Right-hand AppBar cluster shared by every page: a link to the lesson hub, a
// light/dark toggle, and an account control that reflects the Supabase auth
// state (sign in / sign out). Signed-in users also get a notification bell.
//
// This still renders inside every page's MUI <AppBar color="primary">, which
// hasn't migrated yet (that happens per-page, later in the migration) — so
// the *trigger* elements below (the hub link, the icon buttons) intentionally
// use plain white-on-transparent classes to stay legible on that still-MUI
// colored bar, rather than the new semantic tokens (bg-card etc.), which
// assume a light/dark page background this isn't sitting on yet. The dropdown
// menu itself isn't constrained the same way — it floats above everything as
// its own surface — so it uses the real design tokens throughout. Revisit the
// trigger styling once each page's header is rebuilt on the new design.

import { useState } from "react";
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

// Interim AppBar-inherit styling — see the file header. bg-transparent and
// border-0/cursor-pointer are explicit here (not just hover:bg-white/10)
// because Tailwind's preflight reset is off for now (see globals.css), so a
// plain <button> still gets the browser's default gray button chrome.
const iconTrigger =
  "inline-flex size-10 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-white transition-colors hover:bg-white/10";
const outlineTrigger =
  "inline-flex items-center gap-2 rounded-md border border-white/60 bg-transparent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10";

export default function NavActions({ current }) {
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
                aria-label="lesson hub"
                className={cn(iconTrigger, "md:hidden")}
              >
                <BookMarkedIcon />
              </RouterLink>
            </TooltipTrigger>
            <TooltipContent>Lesson hub</TooltipContent>
          </Tooltip>
          <RouterLink
            to="/hub"
            className={cn(outlineTrigger, "hidden md:inline-flex")}
          >
            <BookMarkedIcon data-icon="inline-start" />
            Lesson hub
          </RouterLink>
        </>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={
              resolved === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"
            }
            onClick={() => setScheme(resolved === "dark" ? "light" : "dark")}
            className={iconTrigger}
          >
            {resolved === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {resolved === "dark" ? "Switch to light mode" : "Switch to dark mode"}
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
                    aria-label="account menu"
                    className={iconTrigger}
                  >
                    <CircleUserIcon />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{user.email || "Account"}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="flex flex-col">
                <span>{displayName || "Signed in"}</span>
                <span className="break-all text-xs font-normal text-muted-foreground">
                  {user.email}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate(`/users/${user.id}`)}>
                <UserIcon />
                My profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setNameDialogOpen(true)}>
                <IdCardIcon />
                Edit display name
              </DropdownMenuItem>
              {isModerator && (
                <DropdownMenuItem onClick={() => navigate("/moderation")}>
                  <ShieldIcon />
                  Moderation
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={signOut}>Sign out</DropdownMenuItem>
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
                  aria-label="account menu"
                  className={iconTrigger}
                >
                  <CircleUserIcon />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Account</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Signed out</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/login")}>
              Sign in
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
