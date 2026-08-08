// A user's public profile (/users/:id). Shows their chosen display name, bio,
// follower/following counts, and the lessons they've published; the owner can edit
// their bio in place, and any other signed-in user can follow/unfollow them (which
// notifies the followed user and surfaces their activity in the follower's home
// feed). Profiles are keyed by the Supabase user id (the same `authorId` on every
// lesson), so a link survives a display-name change. The "RSS" button points at
// the user's Atom activity feed (lessons + comments) served by the Worker.

import { fetchUserActivity } from "@spelling-creator/core/browser/feeds";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useParams } from "react-router-dom";
import {
  HistoryIcon,
  PencilIcon,
  RssIcon,
  UserCheckIcon,
  UserPlusIcon,
  XIcon,
} from "lucide-react";
import AppHeader from "../components/AppHeader.jsx";
import NavActions from "../components/NavActions.jsx";
import BioDialog from "../components/BioDialog.jsx";
import FollowListDialog from "../components/FollowListDialog.jsx";
import RichText from "../components/RichText.jsx";
import { Button } from "../components/ui/button.jsx";
import { Avatar, AvatarFallback } from "../components/ui/avatar.jsx";
import { Alert, AlertDescription } from "../components/ui/alert.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "../components/ui/tooltip.jsx";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../components/ui/popover.jsx";
import { LessonGridSkeleton } from "../components/Skeletons.jsx";
import { richTextToLine } from "@spelling-creator/core/richText";
import {
  fetchUserProfile,
  setFollowing,
  userFeedUrl,
} from "@spelling-creator/core/users";
import { useAuth } from "../lib/auth.jsx";
import { DocumentMeta } from "../lib/seo.jsx";
import { useServerData } from "../lib/ssr.jsx";

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function initial(name) {
  const s = (name || "").trim();
  return s ? s[0].toUpperCase() : "?";
}

export default function ProfilePage() {
  const { t } = useTranslation("profile");
  const { id } = useParams();
  const { user: me, accessToken, enabled } = useAuth();
  const isOwner = Boolean(me && me.id === id);

  // What the Worker fetched and rendered for this profile, on a server-rendered
  // page load. The profile and its lesson list are public; the activity feed is
  // parsed with DOMParser and stays client-only. See lib/ssr.jsx.
  const serverProfile = useServerData("profile");

  const [profile, setProfile] = useState(serverProfile?.user ?? null);
  const [lessons, setLessons] = useState(serverProfile?.lessons ?? []);
  const [loading, setLoading] = useState(!serverProfile);
  const [error, setError] = useState("");
  const [bioOpen, setBioOpen] = useState(false);

  // Follow state. `followBusy` disables the button (and shows a spinner) while a
  // follow/unfollow request is in flight; `followError` surfaces a failure. The
  // follow flag and counts live on `profile` so a successful toggle just patches
  // it (the server returns the fresh follower count).
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState("");
  // Which connections list the follower/following-count dialog is showing, or null
  // when it's closed.
  const [followListTab, setFollowListTab] = useState(null);

  // Activity popover: lazily parsed from the user's Atom feed on first open.
  const [activityOpen, setActivityOpen] = useState(false);
  const [activity, setActivity] = useState([]);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState("");

  const openActivity = () => {
    setActivityOpen(true);
    if (activityLoaded) return;
    setActivityLoaded(true);
    setActivityLoading(true);
    setActivityError("");
    fetchUserActivity(id)
      .then(setActivity)
      .catch((err) =>
        setActivityError(err.message || t("profilePage.activityLoadError")),
      )
      .finally(() => setActivityLoading(false));
  };

  // `quiet` re-fetches underneath whatever is already on screen, instead of
  // clearing back to a skeleton — used when the server already rendered this
  // profile and we're only upgrading it to the signed-in view.
  const load = useCallback(
    (quiet = false) => {
      if (!id) return;
      if (!quiet) {
        setLoading(true);
        setError("");
      }
      // Pass the token so the server can tell us whether *we* follow this profile.
      return fetchUserProfile(id, accessToken)
        .then(({ user, lessons }) => {
          setProfile(user);
          setLessons(lessons);
        })
        .catch((err) =>
          setError(err.message || t("profilePage.profileLoadError")),
        )
        .finally(() => setLoading(false));
    },
    [id, accessToken, t],
  );

  // Which profile the server-rendered copy is of, or null when there isn't one.
  // Keyed by id rather than a spend-once flag, for the same reason as
  // LessonPage: this effect re-runs whenever `load` changes identity, and a
  // one-shot flag would be burnt by that and re-fetch what we already have.
  const serverProfileId = useRef(serverProfile ? id : null);

  useEffect(() => {
    const hadServerProfile = serverProfileId.current === id;
    // The Worker renders anonymously, which is the complete public profile — a
    // signed-out visitor needs nothing more. A signed-in one does: only an
    // authenticated fetch reports whether *they* follow this person, so they
    // re-fetch quietly rather than dropping back to a skeleton.
    if (hadServerProfile && !accessToken) return;
    serverProfileId.current = null;
    load(hadServerProfile);
  }, [load, accessToken, id]);

  // Follow or unfollow this profile, then patch the local follow flag + count
  // from the server's response so the button and header update immediately.
  const toggleFollow = async () => {
    if (!profile || followBusy) return;
    const next = !profile.isFollowing;
    setFollowBusy(true);
    setFollowError("");
    try {
      const { following, followerCount } = await setFollowing(
        id,
        next,
        accessToken,
      );
      setProfile((p) =>
        p ? { ...p, isFollowing: following, followerCount } : p,
      );
    } catch (err) {
      setFollowError(err.message || t("profilePage.followUpdateError"));
    } finally {
      setFollowBusy(false);
    }
  };

  // The Follow control shows only to a signed-in user viewing someone else.
  const canFollow = Boolean(enabled && me && !isOwner);

  const displayName = profile?.displayName || t("profilePage.anonymousName");
  const bio = profile?.bio || "";
  const followerCount = profile?.followerCount ?? 0;
  const followingCount = profile?.followingCount ?? 0;

  const feedUrl = userFeedUrl(id);

  return (
    <div className="min-h-dvh bg-background pb-16 text-foreground">
      <DocumentMeta
        title={profile ? displayName : t("profilePage.documentTitle")}
        // The bio is rich-text HTML, but a meta/OG description is plain text — raw
        // markup would show up verbatim in search snippets and link previews.
        // Flatten it to one truncated line.
        description={
          profile
            ? richTextToLine(bio) ||
              t("profilePage.metaDescriptionFallback", { name: displayName })
            : undefined
        }
      />
      <AppHeader
        title={t("profilePage.headerTitle")}
        left={
          <RouterLink
            to="/hub"
            className="mr-1 inline-flex shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-4 py-2 text-sm font-medium text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10"
          >
            {t("profilePage.lessonHubLink")}
          </RouterLink>
        }
      >
        <NavActions current="profile" />
      </AppHeader>

      <div className="mx-auto max-w-5xl px-4 pt-6">
        {loading ? (
          <>
            {/* Header placeholder: avatar + name/bio lines, then the lessons grid. */}
            <div className="mb-8 flex items-center gap-4">
              <Skeleton className="size-14 shrink-0 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-6 w-[40%]" />
                <Skeleton className="mt-2 h-4 w-[60%]" />
              </div>
            </div>
            <LessonGridSkeleton count={3} />
          </>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <>
            {/* Profile header: avatar, display name, follower/following counts,
                the Follow button, and the Activity/RSS buttons. */}
            <div className="mb-2 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <Avatar className="size-14 shrink-0">
                <AvatarFallback className="text-xl">
                  {initial(displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-2xl font-semibold">
                  {displayName}
                </h1>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <p className="text-sm text-muted-foreground">
                    {t("profilePage.publishedLessonCount", {
                      count: lessons.length,
                    })}
                  </p>
                  {/* Counts open the connections dialog on the matching tab. */}
                  <button
                    type="button"
                    onClick={() => setFollowListTab("followers")}
                    className="cursor-pointer border-0 bg-transparent p-0 text-sm text-muted-foreground underline-offset-2 hover:underline"
                  >
                    {t("profilePage.followerCount", { count: followerCount })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFollowListTab("following")}
                    className="cursor-pointer border-0 bg-transparent p-0 text-sm text-muted-foreground underline-offset-2 hover:underline"
                  >
                    {t("profilePage.followingCount", {
                      count: followingCount,
                    })}
                  </button>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canFollow && (
                  <Button
                    variant={profile?.isFollowing ? "outline" : "default"}
                    size="sm"
                    onClick={toggleFollow}
                    disabled={followBusy}
                  >
                    {followBusy ? (
                      <Spinner data-icon="inline-start" />
                    ) : profile?.isFollowing ? (
                      <UserCheckIcon data-icon="inline-start" />
                    ) : (
                      <UserPlusIcon data-icon="inline-start" />
                    )}
                    {profile?.isFollowing
                      ? t("profilePage.followingButton")
                      : t("profilePage.followButton")}
                  </Button>
                )}
                {feedUrl && (
                  <>
                    <Popover open={activityOpen} onOpenChange={setActivityOpen}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={openActivity}
                            >
                              <HistoryIcon data-icon="inline-start" />
                              {t("profilePage.activityButton")}
                            </Button>
                          </PopoverTrigger>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t("profilePage.activityTooltip")}
                        </TooltipContent>
                      </Tooltip>
                      <PopoverContent
                        align="end"
                        className="max-h-[360px] w-[340px] max-w-[90vw] overflow-y-auto p-2"
                      >
                        {activityLoading ? (
                          <div className="flex flex-col gap-3 px-2 py-1">
                            {Array.from({ length: 4 }, (_, i) => (
                              <div key={i}>
                                <Skeleton className="h-4 w-[70%]" />
                                <Skeleton className="mt-2 h-4 w-[40%]" />
                              </div>
                            ))}
                          </div>
                        ) : activityError ? (
                          <p className="px-2 py-1.5 text-sm text-destructive">
                            {activityError}
                          </p>
                        ) : activity.length === 0 ? (
                          <p className="px-2 py-1.5 text-sm text-muted-foreground">
                            {t("profilePage.noRecentActivity")}
                          </p>
                        ) : (
                          <div className="flex flex-col">
                            {activity.map((item) => (
                              <a
                                key={item.id}
                                href={item.link}
                                onClick={() => setActivityOpen(false)}
                                className="rounded-sm border-0 bg-transparent px-2 py-1.5 text-left no-underline transition-colors hover:bg-accent"
                              >
                                <p className="truncate text-sm font-medium text-foreground">
                                  {item.title}
                                </p>
                                {(item.summary || item.updated) && (
                                  <p className="line-clamp-2 text-xs text-muted-foreground">
                                    {[item.summary, formatDate(item.updated)]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </p>
                                )}
                              </a>
                            ))}
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="sm" asChild>
                          <a
                            href={feedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="no-underline"
                          >
                            <RssIcon data-icon="inline-start" />
                            {t("profilePage.rssButton")}
                          </a>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t("profilePage.rssTooltip")}
                      </TooltipContent>
                    </Tooltip>
                  </>
                )}
              </div>
            </div>
            {followError && (
              <Alert variant="destructive" className="relative mb-2 pr-9">
                <AlertDescription>{followError}</AlertDescription>
                <button
                  type="button"
                  onClick={() => setFollowError("")}
                  aria-label={t("profilePage.dismiss")}
                  className="absolute top-3 right-3 cursor-pointer rounded-sm border-0 bg-transparent p-0.5 text-current opacity-70 transition-opacity hover:opacity-100"
                >
                  <XIcon className="size-3.5" />
                </button>
              </Alert>
            )}

            {/* Bio. The owner can edit it (or add one when empty). */}
            <div className="mb-8">
              {bio ? (
                <div className="flex items-start gap-1">
                  <RichText value={bio} variant="body1" className="flex-1" />
                  {isOwner && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("profilePage.editBioAriaLabel")}
                          onClick={() => setBioOpen(true)}
                        >
                          <PencilIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t("profilePage.editBioTooltip")}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              ) : isOwner ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setBioOpen(true)}
                >
                  <PencilIcon data-icon="inline-start" />
                  {t("profilePage.addBioButton")}
                </Button>
              ) : null}
            </div>

            <h2 className="mb-3 text-lg font-semibold">
              {t("profilePage.publishedLessonsHeading")}
            </h2>
            {lessons.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("profilePage.noLessonsYet", { name: displayName })}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
                {lessons.map((lesson) => (
                  <RouterLink
                    key={lesson.id}
                    to={`/hub/${lesson.id}`}
                    className="rounded-md border border-border p-4 no-underline transition-colors hover:bg-accent"
                  >
                    <h3 className="truncate text-base font-semibold text-foreground">
                      {lesson.title || t("profilePage.untitledLesson")}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {typeof lesson.sectionCount === "number"
                        ? t("profilePage.sectionCount", {
                            count: lesson.sectionCount,
                          })
                        : ""}
                      {lesson.createdAt
                        ? ` · ${formatDate(lesson.createdAt)}`
                        : ""}
                    </p>
                  </RouterLink>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {isOwner && (
        <BioDialog
          open={bioOpen}
          initial={bio}
          onClose={() => setBioOpen(false)}
          onSaved={(saved) => setProfile((p) => (p ? { ...p, bio: saved } : p))}
        />
      )}

      <FollowListDialog
        open={Boolean(followListTab)}
        userId={id}
        displayName={displayName}
        initialTab={followListTab || "followers"}
        onClose={() => setFollowListTab(null)}
      />
    </div>
  );
}
