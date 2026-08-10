// Notification bell, shown to signed-in users in the sidebar footer. It polls
// the notification API, shows an unread count as a badge, and opens a menu
// listing notifications (newest first). Opening the menu marks everything read.
//
// The trigger takes its styling from the caller (`className`) because it used
// to sit on the header's --primary surface and now sits on the sidebar's — the
// two need different foreground tokens, and the bell shouldn't have to know
// which. The fallback below is the sidebar's.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { BellIcon } from "lucide-react";
import { cn } from "../lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "./ui/dropdown-menu.jsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import { useAuth } from "../lib/auth.jsx";
import {
  fetchNotifications,
  markNotificationsRead,
} from "@spelling-creator/core/notifications";

// How often to poll for new notifications while the user is signed in.
const POLL_INTERVAL_MS = 30000;

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function NotificationBell({ className }) {
  const { t } = useTranslation("common");
  const { enabled, user, accessToken } = useAuth();
  const navigate = useNavigate();

  const [notifications, setNotifications] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setNotifications(await fetchNotifications(accessToken));
    } catch {
      // Ignore transient failures; the next poll will retry.
    }
  }, [accessToken]);

  // Poll on mount (and whenever the session changes) and then on an interval.
  useEffect(() => {
    if (!accessToken) {
      setNotifications([]);
      return undefined;
    }
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [accessToken, load]);

  // Only signed-in users have notifications.
  if (!enabled || !user) return null;

  const unread = notifications.filter((n) => !n.read).length;

  const openMenu = async () => {
    // Opening the menu marks everything read (optimistically, then on the server).
    if (unread > 0) {
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      try {
        await markNotificationsRead(accessToken);
      } catch {
        // Non-fatal; counts reconcile on the next poll.
      }
    }
  };

  const openNotification = (n) => {
    setMenuOpen(false);
    if (!n.link) return;
    // Internal links route within the app; external ones open in a new tab.
    if (n.link.startsWith("/")) {
      navigate(n.link);
    } else {
      window.open(n.link, "_blank", "noopener");
    }
  };

  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(next) => {
        setMenuOpen(next);
        if (next) openMenu();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={
                unread
                  ? t("notificationBell.ariaLabelUnread", { count: unread })
                  : t("notificationBell.ariaLabel")
              }
              // `relative` is the bell's own (the unread badge is absolutely
              // positioned against it); everything else is the caller's.
              className={cn(
                "relative",
                className ||
                  "inline-flex size-9 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
              )}
            >
              <BellIcon />
              {unread > 0 && (
                <span className="absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("notificationBell.tooltip")}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-[340px] max-w-[90vw] p-0">
        <DropdownMenuLabel className="px-4 py-2 text-base font-normal">
          {t("notificationBell.menuLabel")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mx-0" />

        {notifications.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            {t("notificationBell.empty")}
          </p>
        ) : (
          <div className="max-h-[360px] overflow-y-auto">
            {notifications.map((n) => (
              <DropdownMenuItem
                key={n.id}
                onClick={() => openNotification(n)}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded-none px-4 py-2",
                  !n.link && "cursor-default",
                )}
              >
                <span className="text-sm font-medium">{n.title}</span>
                {n.body && (
                  <span className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {n.body}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(n.createdAt)}
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
