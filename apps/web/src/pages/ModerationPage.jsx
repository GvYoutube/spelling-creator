// Moderation dashboard at /moderation — the cross-cutting console for the
// privilege layer (per-content actions like deleting a comment or shadowbanning
// a lesson live inline on those items; this page handles the lists). Visible to
// moderators and admins; admin-only sections (pending deletion requests and
// moderator management) are hidden for plain moderators and, as defence in depth,
// rejected server-side too.
//
// Authorisation is never decided here: the page reads `isModerator`/`isAdmin`
// from the auth context only to choose what to render, and every action calls a
// Worker endpoint that re-derives the caller's role from the database.

import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftIcon,
  Trash2Icon,
  XIcon,
  TriangleAlertIcon,
} from "lucide-react";
import AppHeader from "../components/AppHeader.jsx";
import NavActions from "../components/NavActions.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Field, FieldLabel } from "../components/ui/field.jsx";
import { Input } from "../components/ui/input.jsx";
import { Alert, AlertDescription } from "../components/ui/alert.jsx";
import { Spinner } from "../components/ui/spinner.jsx";
import IconActionButton from "../components/IconActionButton.jsx";
import { ListRowsSkeleton } from "../components/Skeletons.jsx";
import { useAuth } from "../lib/auth.jsx";
import {
  listBans,
  banName,
  unbanName,
  banIp,
  unbanIp,
  listModerators,
  addModerator,
  removeModerator,
  listDeleteRequests,
  resolveDeleteRequest,
  listShadowbannedLessons,
  setShadowban,
} from "../lib/moderation.js";

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// A titled card wrapper shared by every section.
function Section({ title, children }) {
  return (
    <div className="rounded-panel border border-border bg-card p-5 text-card-foreground shadow-(--shadow-panel)">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}

// A removable pill — banned names/IPs, matching MUI Chip's onDelete shape.
function RemovableBadge({ label, onRemove, removeLabel }) {
  return (
    <Badge variant="secondary" className="gap-1 py-1 pr-1 pl-2.5">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="cursor-pointer rounded-full border-0 bg-transparent p-0.5 text-secondary-foreground transition-colors hover:bg-foreground/10"
      >
        <XIcon className="size-3" />
      </button>
    </Badge>
  );
}

// --- Bans (names for all mods; IPs for admins) ---------------------------
function BansSection({ accessToken, isAdmin, onToast }) {
  const { t } = useTranslation("moderation");
  const [names, setNames] = useState([]);
  const [ips, setIps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [ipDraft, setIpDraft] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { names: n, ips: i } = await listBans(accessToken);
      setNames(n);
      setIps(i);
    } catch (err) {
      setError(err.message || t("bans.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const addName = async () => {
    const name = nameDraft.trim();
    if (!name) return;
    try {
      await banName(name, accessToken);
      setNameDraft("");
      onToast(t("bans.toasts.nameBanned", { name }));
      load();
    } catch (err) {
      onToast(err.message || t("bans.toasts.nameBanFailed"));
    }
  };

  const liftName = async (nameLower) => {
    try {
      await unbanName(nameLower, accessToken);
      onToast(t("bans.toasts.nameBanLifted"));
      load();
    } catch (err) {
      onToast(err.message || t("bans.toasts.liftBanFailed"));
    }
  };

  const addIp = async () => {
    const ip = ipDraft.trim();
    if (!ip) return;
    try {
      await banIp(ip, "", accessToken);
      setIpDraft("");
      onToast(t("bans.toasts.ipBanned", { ip }));
      load();
    } catch (err) {
      onToast(err.message || t("bans.toasts.ipBanFailed"));
    }
  };

  const liftIp = async (ip) => {
    try {
      await unbanIp(ip, accessToken);
      onToast(t("bans.toasts.ipBanLifted"));
      load();
    } catch (err) {
      onToast(err.message || t("bans.toasts.liftBanFailed"));
    }
  };

  return (
    <Section title={t("bans.title")}>
      {loading ? (
        <ListRowsSkeleton />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="mb-2 text-sm font-medium">
              {t("bans.names.heading")}
            </h3>
            <div className="mb-2 flex items-end gap-2">
              <Field>
                <FieldLabel htmlFor="ban-name" className="sr-only">
                  {t("bans.names.label")}
                </FieldLabel>
                <Input
                  id="ban-name"
                  placeholder={t("bans.names.label")}
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addName()}
                />
              </Field>
              <Button onClick={addName} disabled={!nameDraft.trim()}>
                {t("bans.names.ban")}
              </Button>
            </div>
            {names.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("bans.names.empty")}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {names.map((n) => (
                  <RemovableBadge
                    key={n.name_lower}
                    label={n.display_name || n.name_lower}
                    onRemove={() => liftName(n.name_lower)}
                    removeLabel={t("bans.names.liftLabel", {
                      name: n.display_name || n.name_lower,
                    })}
                  />
                ))}
              </div>
            )}
          </div>

          {isAdmin && (
            <>
              <hr className="border-border" />
              <div>
                <h3 className="mb-2 text-sm font-medium">
                  {t("bans.ips.heading")}
                </h3>
                <div className="mb-2 flex items-end gap-2">
                  <Field>
                    <FieldLabel htmlFor="ban-ip" className="sr-only">
                      {t("bans.ips.label")}
                    </FieldLabel>
                    <Input
                      id="ban-ip"
                      placeholder={t("bans.ips.label")}
                      value={ipDraft}
                      onChange={(e) => setIpDraft(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addIp()}
                    />
                  </Field>
                  <Button onClick={addIp} disabled={!ipDraft.trim()}>
                    {t("bans.ips.ban")}
                  </Button>
                </div>
                {ips.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("bans.ips.empty")}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {ips.map((i) => (
                      <RemovableBadge
                        key={i.ip}
                        label={i.ip}
                        onRemove={() => liftIp(i.ip)}
                        removeLabel={t("bans.ips.liftLabel", { ip: i.ip })}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Section>
  );
}

// --- Shadowbanned lessons (mod+) -----------------------------------------
function ShadowbannedSection({ accessToken, onToast }) {
  const { t } = useTranslation("moderation");
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setLessons(await listShadowbannedLessons(accessToken));
    } catch (err) {
      setError(err.message || t("shadowbanned.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const restore = async (lessonId) => {
    try {
      await setShadowban(lessonId, false, accessToken);
      onToast(t("shadowbanned.toasts.restored"));
      setLessons((prev) => prev.filter((l) => l.id !== lessonId));
    } catch (err) {
      onToast(err.message || t("shadowbanned.toasts.restoreFailed"));
    }
  };

  return (
    <Section title={t("shadowbanned.title")}>
      {loading ? (
        <ListRowsSkeleton />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : lessons.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("shadowbanned.empty")}
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {lessons.map((l) => (
            <div
              key={l.id}
              className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <RouterLink
                  to={`/hub/${l.id}`}
                  className="block truncate text-sm font-medium text-primary hover:underline"
                >
                  {l.title || t("shadowbanned.untitledLesson")}
                </RouterLink>
                <p className="text-xs text-muted-foreground">
                  {l.author || t("common.anonymous")}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => restore(l.id)}>
                {t("shadowbanned.restore")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// --- Pending lesson-deletion requests (admin) ----------------------------
function DeleteRequestsSection({ accessToken, onToast }) {
  const { t } = useTranslation("moderation");
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setRequests(await listDeleteRequests(accessToken));
    } catch (err) {
      setError(err.message || t("deleteRequests.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const resolve = async (requestId, approve) => {
    try {
      await resolveDeleteRequest(requestId, approve, accessToken);
      onToast(
        approve
          ? t("deleteRequests.toasts.approved")
          : t("deleteRequests.toasts.denied"),
      );
      setRequests((prev) => prev.filter((r) => r.id !== requestId));
    } catch (err) {
      onToast(err.message || t("deleteRequests.toasts.resolveFailed"));
    }
  };

  return (
    <Section title={t("deleteRequests.title")}>
      {loading ? (
        <ListRowsSkeleton />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("deleteRequests.empty")}
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {requests.map((r) => (
            <div key={r.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <RouterLink
                    to={`/hub/${r.lessonId}`}
                    className="block truncate text-sm font-medium text-primary hover:underline"
                  >
                    {r.lessonTitle || t("deleteRequests.deletedLesson")}
                  </RouterLink>
                  <p className="text-xs text-muted-foreground">
                    {r.lessonAuthor || t("common.anonymous")} ·{" "}
                    {formatDate(r.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => resolve(r.id, true)}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    {t("deleteRequests.approve")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => resolve(r.id, false)}
                  >
                    {t("deleteRequests.deny")}
                  </Button>
                </div>
              </div>
              {r.reason && (
                <p className="mt-1 text-sm">&ldquo;{r.reason}&rdquo;</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// --- Moderators (admin) ---------------------------------------------------
function ModeratorsSection({ accessToken, onToast }) {
  const { t } = useTranslation("moderation");
  const [moderators, setModerators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setModerators(await listModerators(accessToken));
    } catch (err) {
      setError(err.message || t("moderators.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const add = async () => {
    const email = emailDraft.trim();
    if (!email) return;
    setAdding(true);
    try {
      await addModerator(email, accessToken);
      setEmailDraft("");
      onToast(t("moderators.toasts.added", { email }));
      load();
    } catch (err) {
      onToast(err.message || t("moderators.toasts.addFailed"));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (userId) => {
    try {
      await removeModerator(userId, accessToken);
      onToast(t("moderators.toasts.removed"));
      setModerators((prev) => prev.filter((m) => m.userId !== userId));
    } catch (err) {
      onToast(err.message || t("moderators.toasts.removeFailed"));
    }
  };

  return (
    <Section title={t("moderators.title")}>
      <div className="mb-3 flex items-end gap-2">
        <Field className="min-w-[240px]">
          <FieldLabel htmlFor="moderator-email" className="sr-only">
            {t("moderators.emailLabel")}
          </FieldLabel>
          <Input
            id="moderator-email"
            placeholder={t("moderators.emailLabel")}
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !adding && add()}
          />
        </Field>
        <Button onClick={add} disabled={adding || !emailDraft.trim()}>
          {adding && <Spinner data-icon="inline-start" />}
          {t("moderators.addButton")}
        </Button>
      </div>
      {loading ? (
        <ListRowsSkeleton />
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : moderators.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("moderators.empty")}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {moderators.map((m) => (
            <div
              key={m.userId}
              className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
            >
              <p className="text-sm break-all">{m.email || m.userId}</p>
              <IconActionButton
                tooltip={t("moderators.removeTooltip")}
                onClick={() => remove(m.userId)}
                destructive
              >
                <Trash2Icon />
              </IconActionButton>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

export default function ModerationPage() {
  const { t } = useTranslation("moderation");
  const { loading, user, accessToken, roleLoading, isModerator, isAdmin } =
    useAuth();

  // Auth resolves in two async stages on a reload: first the Supabase session is
  // restored from storage (`loading`), then the user's role is looked up from the
  // Worker (`roleLoading`). We must wait for BOTH before judging access —
  // otherwise a real moderator gets bounced/flashed in the gap. We deliberately
  // do NOT redirect a signed-out user away: during hydration `user` is briefly
  // null even for a signed-in person, so we show an inline prompt that self-heals
  // once the session lands, rather than navigating off the page.
  const resolvingAuth = loading || (user && roleLoading);
  const showSignIn = !loading && !user;
  const showAccessNotice = !resolvingAuth && user && !isModerator;

  return (
    <div className="min-h-screen bg-background pb-16">
      <AppHeader
        title={t("page.title")}
        left={
          <RouterLink
            to="/hub"
            className="mr-1 inline-flex shrink-0 items-center gap-2 rounded-md border-0 bg-transparent px-4 py-2 text-sm font-medium text-primary-foreground no-underline transition-colors hover:bg-primary-foreground/10"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            {t("page.lessonHub")}
          </RouterLink>
        }
      >
        <NavActions current="moderation" />
      </AppHeader>

      <div className="mx-auto max-w-3xl px-4 pt-6">
        {resolvingAuth ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-8" />
          </div>
        ) : showSignIn ? (
          <Alert>
            <AlertDescription className="flex items-center justify-between gap-2">
              {t("page.signInPrompt")}
              <Button variant="ghost" size="sm" asChild>
                <RouterLink to="/login" className="no-underline">
                  {t("page.signIn")}
                </RouterLink>
              </Button>
            </AlertDescription>
          </Alert>
        ) : showAccessNotice ? (
          <Alert className="border-focus/40 bg-focus/10 text-focus">
            <TriangleAlertIcon />
            <AlertDescription className="flex items-center justify-between gap-2 text-focus">
              {t("page.noAccess")}
              <Button variant="ghost" size="sm" asChild>
                <RouterLink to="/hub" className="text-focus no-underline">
                  {t("page.backToHub")}
                </RouterLink>
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          isModerator && (
            <div className="flex flex-col gap-4">
              {isAdmin && (
                <DeleteRequestsSection
                  accessToken={accessToken}
                  onToast={toast}
                />
              )}
              <ShadowbannedSection accessToken={accessToken} onToast={toast} />
              <BansSection
                accessToken={accessToken}
                isAdmin={isAdmin}
                onToast={toast}
              />
              {isAdmin && (
                <ModeratorsSection accessToken={accessToken} onToast={toast} />
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
