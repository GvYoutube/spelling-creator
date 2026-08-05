// A dialog that lists a user's followers and the users they follow, in two tabs.
// Opened from the follower/following counts on a profile page. Each row links to
// that user's profile. Lists are public (lib/users.fetchFollowList) and loaded
// lazily per tab on first view; the caches are cleared when the dialog closes so a
// reopen reflects any follows made since. A tab shows skeleton rows while loading,
// an error alert on failure, and a friendly empty state otherwise.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.jsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.jsx";
import { Avatar, AvatarFallback } from "./ui/avatar.jsx";
import { Alert, AlertDescription } from "./ui/alert.jsx";
import { Skeleton } from "./ui/skeleton.jsx";
import { fetchFollowList } from "@spelling-creator/core/users";
import { richTextToLine } from "../lib/richText.js";

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

// A few placeholder rows (avatar + name line) while a tab's list loads.
function RowsSkeleton({ count = 5 }) {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2">
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="h-4" style={{ width: `${60 - i * 6}%` }} />
        </div>
      ))}
    </div>
  );
}

/**
 * @param {object} props
 * @param {boolean} props.open           Whether the dialog is shown.
 * @param {string}  props.userId         The profile whose connections to list.
 * @param {string}  [props.displayName]  That user's name, for the empty-state copy.
 * @param {"followers"|"following"} [props.initialTab]  Which tab to open on.
 * @param {() => void} [props.onClose]   Dismiss handler.
 */
export default function FollowListDialog({
  open,
  userId,
  displayName,
  initialTab = "followers",
  onClose,
}) {
  const { t } = useTranslation("profile");
  const navigate = useNavigate();
  const name = displayName || t("followList.defaultUserLabel");
  const [tab, setTab] = useState(initialTab);
  // Per-tab load state: { loading, error, users }. null means "not requested yet".
  const [state, setState] = useState({ followers: null, following: null });
  // Which tabs have been kicked off, so switching back and forth doesn't refetch.
  const requested = useRef({});

  // Open on the requested tab; clear caches on close so a reopen is fresh.
  useEffect(() => {
    if (open) {
      setTab(initialTab);
    } else {
      requested.current = {};
      setState({ followers: null, following: null });
    }
  }, [open, initialTab]);

  // Load the active tab's list on first view.
  useEffect(() => {
    if (!open || !userId || requested.current[tab]) return;
    requested.current[tab] = true;
    let active = true;
    setState((s) => ({ ...s, [tab]: { loading: true, error: "", users: [] } }));
    fetchFollowList(userId, tab)
      .then((users) => {
        if (active)
          setState((s) => ({
            ...s,
            [tab]: { loading: false, error: "", users },
          }));
      })
      .catch((err) => {
        if (active)
          setState((s) => ({
            ...s,
            [tab]: {
              loading: false,
              error: err.message || t("followList.loadError"),
              users: [],
            },
          }));
      });
    return () => {
      active = false;
    };
  }, [open, userId, tab, t]);

  const openProfile = (id) => {
    onClose?.();
    navigate(`/users/${id}`);
  };

  const current = state[tab];
  const emptyText =
    tab === "followers"
      ? t("followList.noFollowers", { name })
      : t("followList.noFollowing", { name });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose?.()}>
      <DialogContent className="sm:max-w-sm p-0 gap-0">
        <DialogHeader className="p-4 pb-0">
          <DialogTitle>{t("followList.title")}</DialogTitle>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="gap-0">
          <TabsList className="mx-4 mt-3 grid w-auto grid-cols-2">
            <TabsTrigger value="followers">
              {t("followList.followersTab")}
            </TabsTrigger>
            <TabsTrigger value="following">
              {t("followList.followingTab")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="min-h-[240px] border-t border-border py-2">
          {!current || current.loading ? (
            <RowsSkeleton />
          ) : current.error ? (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertDescription>{current.error}</AlertDescription>
              </Alert>
            </div>
          ) : current.users.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {emptyText}
            </p>
          ) : (
            <div className="flex flex-col">
              {current.users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => openProfile(u.id)}
                  className="flex cursor-pointer items-center gap-3 border-0 bg-transparent px-4 py-2 text-left transition-colors hover:bg-accent"
                >
                  <Avatar>
                    <AvatarFallback>{initial(u.displayName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {u.displayName || t("followList.anonymousName")}
                    </p>
                    {/* Bios are rich-text HTML; this is a one-line subtitle, so
                        show the words and drop the markup. */}
                    {richTextToLine(u.bio, 80) && (
                      <p className="truncate text-sm text-muted-foreground">
                        {richTextToLine(u.bio, 80)}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
