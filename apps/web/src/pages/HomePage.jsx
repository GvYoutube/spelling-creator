// The app's landing page, served at "/". It has two faces:
//
//   • Signed out — a marketing splash: a hero whose backdrop is real spelling
//     words from the hub drifting upward (see FloatingWords), followed by a calm
//     run of feature blurbs, each with an illustration beside it.
//   • Signed in — a personal dashboard: the hub's latest-lessons feed and the
//     user's own activity feed side by side (both parsed from Atom with
//     DOMParser), a feed of activity from the people they follow, plus a roomier
//     list of the user's notifications.
//
// The editor itself now lives at /editor; this page is what greets visitors.

import { hasApi } from "@spelling-creator/core/config";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  BellIcon,
  BookMarkedIcon,
  FileTextIcon,
  HistoryIcon,
  ImagePlusIcon,
  PencilIcon,
  RssIcon,
  SparklesIcon,
  SpellCheckIcon,
  Users2Icon,
  UsersIcon,
} from "lucide-react";
import AppHeader from "../components/AppHeader.jsx";
import NavActions, { headerTextTrigger } from "../components/NavActions.jsx";
import FloatingWords from "../components/FloatingWords.jsx";
import { FeedListSkeleton } from "../components/Skeletons.jsx";
import { Button } from "../components/ui/button.jsx";
import { Alert, AlertDescription } from "../components/ui/alert.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
import { cn } from "../lib/utils.js";
import { useAuth } from "../lib/auth.jsx";
import { DocumentMeta } from "../lib/seo.jsx";
import {
  fetchLatestLessons,
  fetchUserActivity,
} from "@spelling-creator/core/browser/feeds";
import { fetchFollowingActivity } from "@spelling-creator/core/users";
import { fetchNotifications } from "@spelling-creator/core/notifications";

// The features shown to signed-out visitors. `image` points at a file under
// apps/web/public/home/ (see that folder's README); a missing file degrades to a
// labelled placeholder. Rows alternate the image left/right down the page.
const FEATURES = [
  {
    key: "editor",
    icon: PencilIcon,
    image: "/home/feature-editor.jpg",
  },
  {
    key: "ai",
    icon: SparklesIcon,
    image: "/home/feature-ai.jpg",
  },
  {
    key: "images",
    icon: ImagePlusIcon,
    image: "/home/feature-images.jpg",
  },
  {
    key: "hub",
    icon: BookMarkedIcon,
    image: "/home/feature-hub.jpg",
  },
  {
    key: "collab",
    icon: UsersIcon,
    image: "/home/feature-collab.jpg",
  },
  {
    key: "export",
    icon: FileTextIcon,
    image: "/home/feature-export.jpg",
  },
];

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

// Turn an absolute feed link (same-origin, e.g. https://site/hub/:id) into an
// app-relative path so it can route client-side without a full page load. Falls
// back to the original string if it isn't parseable.
function toPath(href) {
  if (!href) return "";
  try {
    const u = new URL(href, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search : href;
  } catch {
    return href;
  }
}

// A feature illustration that degrades to a labelled placeholder if the image
// file hasn't been added yet (see public/home/README.md).
function FeatureImage({ src, alt, Icon }) {
  const [broken, setBroken] = useState(false);
  if (broken || !src) {
    return (
      <div className="flex aspect-16/10 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-accent text-primary">
        <Icon className="size-12 opacity-60" />
        <p className="text-xs text-muted-foreground">{alt}</p>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      className="block aspect-16/10 w-full rounded-xl object-cover shadow-[var(--shadow-panel)]"
    />
  );
}

// One alternating feature row: illustration on one side, copy on the other.
function FeatureRow({ feature, flip }) {
  const Icon = feature.icon;
  return (
    <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-2 md:gap-12">
      <div className={cn("order-1", flip ? "md:order-2" : "md:order-1")}>
        <FeatureImage src={feature.image} alt={feature.title} Icon={Icon} />
      </div>
      <div className={cn("order-2", flip ? "md:order-1" : "md:order-2")}>
        <div className="flex flex-col gap-3">
          <div className="flex size-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Icon className="size-5" />
          </div>
          <h3 className="font-serif text-xl font-semibold md:text-2xl">
            {feature.title}
          </h3>
          <p className="text-base text-muted-foreground">{feature.body}</p>
        </div>
      </div>
    </div>
  );
}

// ── Signed-out splash ───────────────────────────────────────────────────────
function LandingView() {
  const { t } = useTranslation("home");
  return (
    <>
      {/* Hero: floating spelling words behind a headline + calls to action.
          A fixed, theme-independent gradient (not tied to --primary, which
          shifts between light/dark) — this banner always shows white text on
          a bold brand-blue-to-violet backdrop, drawn from the same hex values
          as --foreground/--primary-foreground (dark) and --primary (light),
          which are also this design system's real brand colors, in place of
          the old MUI theme.js hex triplet this replaced. */}
      <div
        className="relative flex min-h-[70vh] items-center overflow-hidden text-white md:min-h-[78vh]"
        style={{
          background:
            "linear-gradient(135deg, #14162a 0%, #4f5fd9 55%, #5f3dc4 100%)",
        }}
      >
        <FloatingWords />
        {/* Darkening veil so the headline stays legible over the words. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 40%, rgba(0,0,0,0.15), rgba(0,0,0,0.55))",
          }}
        />
        <div className="relative mx-auto max-w-3xl px-4 py-16 text-center">
          <h1
            className="mb-4 font-serif text-4xl font-semibold md:text-6xl"
            style={{ textShadow: "0 2px 18px rgba(0,0,0,0.4)" }}
          >
            {t("marketing.hero.title")}
          </h1>
          <p
            className="mx-auto mb-8 max-w-xl text-lg opacity-95 md:text-xl"
            style={{ textShadow: "0 1px 10px rgba(0,0,0,0.4)" }}
          >
            {t("marketing.hero.subtitle")}
          </p>
          {/* Hand-styled rather than the shadcn Button variants — this hero
              is a fixed-color surface regardless of app theme (see the note
              above), and Button's variants carry their own dark: overrides
              (meant for a normal page background) that would fight it.
              outline-white for the same reason: the app-wide focus ring in
              globals.css is --ring, which is this gradient's own indigo. */}
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <RouterLink
              to="/editor"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-white px-8 py-3 text-base font-medium text-[#1e2138] no-underline transition-colors focus-visible:outline-white hover:bg-white/90"
            >
              <PencilIcon data-icon="inline-start" />
              {t("marketing.hero.openEditor")}
            </RouterLink>
            <RouterLink
              to="/hub"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-white/70 bg-transparent px-8 py-3 text-base font-medium text-white no-underline transition-colors focus-visible:outline-white hover:border-white hover:bg-white/10"
            >
              <BookMarkedIcon data-icon="inline-start" />
              {t("marketing.hero.browseHub")}
            </RouterLink>
          </div>
        </div>
      </div>

      {/* Calm feature run. */}
      <div className="mx-auto max-w-6xl px-4 py-12 md:py-20">
        <div className="mb-10 text-center md:mb-16">
          <p className="text-sm font-semibold tracking-wide text-primary uppercase">
            {t("marketing.features.eyebrow")}
          </p>
          <h2 className="font-serif text-3xl font-semibold md:text-4xl">
            {t("marketing.features.heading")}
          </h2>
        </div>
        <div className="flex flex-col gap-14 md:gap-24">
          {FEATURES.map((feature, i) => (
            <FeatureRow
              key={feature.key}
              feature={{
                ...feature,
                title: t(`marketing.features.${feature.key}.title`),
                body: t(`marketing.features.${feature.key}.body`),
              }}
              flip={i % 2 === 1}
            />
          ))}
        </div>

        <div className="mt-16 rounded-panel border border-border bg-card p-8 text-center text-card-foreground shadow-(--shadow-panel) md:mt-24 md:p-12">
          <h2 className="mb-1.5 font-serif text-2xl font-semibold md:text-3xl">
            {t("marketing.cta.title")}
          </h2>
          <p className="mb-6 text-muted-foreground">
            {t("marketing.cta.body")}
          </p>
          <Button size="lg" className="px-8" asChild>
            <RouterLink to="/editor" className="no-underline">
              <PencilIcon data-icon="inline-start" />
              {t("marketing.cta.openEditor")}
            </RouterLink>
          </Button>
        </div>
      </div>
    </>
  );
}

// A compact feed list shared by the dashboard's "latest lessons" and "your
// activity" columns. Each entry routes to its lesson/profile page on click.
function FeedList({ entries, emptyText }) {
  const { t } = useTranslation("home");
  const navigate = useNavigate();
  if (entries.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="flex flex-col divide-y divide-border">
      {entries.map((e) => {
        const path = toPath(e.link);
        return (
          <button
            key={e.id || e.link}
            type="button"
            onClick={() => path && navigate(path)}
            className="cursor-pointer rounded-md border-0 bg-transparent px-2 py-2.5 text-left transition-colors hover:bg-accent"
          >
            <p className="truncate text-sm font-medium">
              {e.title || t("dashboard.untitled")}
            </p>
            {e.summary && (
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {e.summary}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {formatDateTime(e.updated)}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// A titled dashboard panel shared by every section below.
function DashboardPanel({ icon: Icon, title, children }) {
  return (
    <div className="rounded-panel border border-border bg-card p-4 text-card-foreground shadow-(--shadow-panel) md:p-6">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-primary" />
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

// ── Signed-in dashboard ─────────────────────────────────────────────────────
function DashboardView() {
  const { t } = useTranslation("home");
  const { user, accessToken, displayName } = useAuth();
  const navigate = useNavigate();

  const [latest, setLatest] = useState([]);
  const [activity, setActivity] = useState([]);
  const [following, setFollowing] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    // Each feed is independent; one failing shouldn't blank the others.
    const [latestRes, activityRes, followingRes, notifRes] =
      await Promise.allSettled([
        hasApi() ? fetchLatestLessons() : Promise.resolve([]),
        user ? fetchUserActivity(user.id) : Promise.resolve([]),
        accessToken ? fetchFollowingActivity(accessToken) : Promise.resolve([]),
        accessToken ? fetchNotifications(accessToken) : Promise.resolve([]),
      ]);
    setLatest(latestRes.status === "fulfilled" ? latestRes.value : []);
    setActivity(activityRes.status === "fulfilled" ? activityRes.value : []);
    setFollowing(followingRes.status === "fulfilled" ? followingRes.value : []);
    setNotifications(notifRes.status === "fulfilled" ? notifRes.value : []);
    setLoading(false);
  }, [user, accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:py-10">
      <div className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">
            {displayName
              ? t("dashboard.welcome.withName", { name: displayName })
              : t("dashboard.welcome.default")}
          </h1>
          <p className="text-muted-foreground">{t("dashboard.subtitle")}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button asChild>
            <RouterLink to="/editor" className="no-underline">
              <PencilIcon data-icon="inline-start" />
              {t("dashboard.newLesson")}
            </RouterLink>
          </Button>
          <Button variant="outline" asChild>
            <RouterLink to="/hub" className="no-underline">
              <BookMarkedIcon data-icon="inline-start" />
              {t("dashboard.hub")}
            </RouterLink>
          </Button>
        </div>
      </div>

      {/* The dashboard layout renders immediately; each feed shows skeleton rows
          until its data arrives, so panels don't jump in as a spinner clears. */}
      <div className="flex flex-col gap-4">
        {/* Latest lessons + your activity, together in one section. */}
        <div className="rounded-panel border border-border bg-card p-4 text-card-foreground shadow-(--shadow-panel) md:p-6">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-8">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <RssIcon className="size-4 text-primary" />
                <h2 className="text-lg font-semibold">
                  {t("dashboard.latestFromHub.title")}
                </h2>
              </div>
              {loading ? (
                <FeedListSkeleton count={5} />
              ) : (
                <FeedList
                  entries={latest.slice(0, 8)}
                  emptyText={t("dashboard.latestFromHub.empty")}
                />
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2">
                <HistoryIcon className="size-4 text-primary" />
                <h2 className="text-lg font-semibold">
                  {t("dashboard.recentActivity.title")}
                </h2>
              </div>
              {loading ? (
                <FeedListSkeleton count={5} />
              ) : (
                <FeedList
                  entries={activity.slice(0, 8)}
                  emptyText={t("dashboard.recentActivity.empty")}
                />
              )}
            </div>
          </div>
        </div>

        {/* Activity from the people this user follows (lessons + comments). */}
        <DashboardPanel
          icon={Users2Icon}
          title={t("dashboard.following.title")}
        >
          {loading ? (
            <FeedListSkeleton count={4} />
          ) : (
            <FeedList
              entries={following.slice(0, 10)}
              emptyText={t("dashboard.following.empty")}
            />
          )}
        </DashboardPanel>

        {/* Notifications, in a roomier view than the header bell. */}
        <DashboardPanel
          icon={BellIcon}
          title={t("dashboard.notifications.title")}
        >
          {loading ? (
            <FeedListSkeleton count={4} />
          ) : notifications.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {t("dashboard.notifications.empty")}
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {notifications.map((n) => {
                const path = n.link?.startsWith("/") ? n.link : null;
                const content = (
                  <>
                    <div className="mb-0.5 flex items-center gap-1.5">
                      {!n.read && (
                        <span className="size-2 shrink-0 rounded-full bg-destructive" />
                      )}
                      <p
                        className={cn(
                          "text-sm",
                          n.read ? "font-medium" : "font-bold",
                        )}
                      >
                        {n.title}
                      </p>
                    </div>
                    {n.body && (
                      <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
                        {n.body}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(n.createdAt)}
                    </p>
                  </>
                );
                return n.link ? (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() =>
                      path
                        ? navigate(path)
                        : window.open(n.link, "_blank", "noopener")
                    }
                    className="cursor-pointer rounded-md border-0 bg-transparent px-2 py-3 text-left transition-colors hover:bg-accent"
                  >
                    {content}
                  </button>
                ) : (
                  <div key={n.id} className="px-2 py-3">
                    {content}
                  </div>
                );
              })}
            </div>
          )}
        </DashboardPanel>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { t } = useTranslation("home");
  const { enabled, loading, user } = useAuth();

  // Wait for the session to resolve before choosing a face, so a returning user
  // doesn't see the marketing splash flash before their dashboard.
  const deciding = enabled && loading;
  const signedIn = enabled && !!user;

  return (
    <div className="min-h-dvh bg-background pb-16 text-foreground">
      <DocumentMeta
        title={t("meta.title")}
        description={t("meta.description")}
      />
      <AppHeader
        title={
          <span className="inline-flex items-center gap-2">
            <SpellCheckIcon className="size-5 shrink-0" />
            {t("header.title")}
          </span>
        }
        titleHref="/"
      >
        {/* headerTextTrigger, not a hand-written copy of it: this link is a
            sibling of the hub link NavActions renders half a centimetre to its
            right, and the two have to read as the same control. */}
        <RouterLink
          to="/editor"
          className={cn(
            headerTextTrigger,
            "mr-1 hidden shrink-0 md:inline-flex",
          )}
        >
          <PencilIcon data-icon="inline-start" />
          {t("header.editor")}
        </RouterLink>
        <NavActions current="home" />
      </AppHeader>

      {deciding ? (
        <div className="flex justify-center py-24">
          <Spinner className="size-8" />
        </div>
      ) : signedIn ? (
        <DashboardView />
      ) : (
        <>
          {!enabled && (
            <div className="mx-auto max-w-6xl px-4 pt-4">
              <Alert className="border-primary/40 bg-primary/10 text-primary">
                <AlertDescription className="text-primary">
                  {t("marketing.accountsDisabled")}
                </AlertDescription>
              </Alert>
            </div>
          )}
          <LandingView />
        </>
      )}
    </div>
  );
}
