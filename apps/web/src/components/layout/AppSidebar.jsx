// The app's left-hand navigation, and the new home of everything that used to
// live in the header's right-hand cluster (NavActions.jsx, now deleted): the
// hub link, the install button, the light/dark toggle, notifications and the
// account menu.
//
// Moving them here is what lets the top bar shrink to a breadcrumb (PageBar.jsx).
// The old bar was the app's --primary surface *and* its whole navigation, so
// every page spent its first 64px restating the same controls; the sidebar
// holds them once, and a collapsed rail gives them back as 3rem.
//
// The "Your lessons" group is the one part that fetches. It is deliberately
// signed-in-only and client-only: the Worker's render is anonymous (see
// lib/ssr.jsx), so on a server-rendered page this group is simply absent and
// appears when the session resolves after hydration. Nothing here may block
// first paint.

import { hasApi } from "@spelling-creator/core/config";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Link as RouterLink,
  useMatch,
  useNavigate,
  useResolvedPath,
} from "react-router-dom";
import {
  BookMarkedIcon,
  CircleUserIcon,
  CloudIcon,
  FileTextIcon,
  HouseIcon,
  IdCardIcon,
  LibraryIcon,
  LogOutIcon,
  MoonIcon,
  PlusIcon,
  ShieldIcon,
  SpellCheckIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";
import { fetchMyLessons } from "@spelling-creator/core/lessons";
import { cn } from "../../lib/utils.js";
import { useAuth } from "../../lib/auth.jsx";
import { useColorScheme } from "../../lib/colorScheme.jsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "../ui/sidebar.jsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.jsx";
import DisplayNameDialog from "../DisplayNameDialog.jsx";
import InstallAppButton from "../InstallAppButton.jsx";
import NotificationBell from "../NotificationBell.jsx";

// How many of your own lessons the sidebar lists before it stops and points at
// the hub. Long enough to be a shortcut, short enough that the nav above it
// never scrolls out of reach.
const MY_LESSON_LIMIT = 6;

// Shared styling for the footer's icon controls. Unlike the header cluster they
// replace, these sit on the sidebar surface rather than on --primary, so they
// take the ordinary sidebar tokens instead of --primary-foreground.
// bg-transparent and border-0 are explicit so a <button> doesn't pick up the
// browser's default chrome.
const utilityTrigger = cn(
  "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md",
  "border-0 bg-transparent text-sidebar-foreground no-underline transition-colors",
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
);

/**
 * A destination in the nav, highlighted when the route is on it.
 *
 * `end` defaults to true so /hub stops being highlighted once you're inside
 * /hub/:id — the lesson has its own place in the breadcrumb, and two things
 * claiming to be "where you are" reads as a bug.
 */
function NavItem({ to, icon: Icon, label, end = true }) {
  const resolved = useResolvedPath(to);
  const match = useMatch({ path: resolved.pathname, end });

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={Boolean(match)} tooltip={label}>
        <RouterLink to={to} className="no-underline">
          <Icon />
          <span>{label}</span>
        </RouterLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export default function AppSidebar() {
  const { t } = useTranslation("common");
  const { enabled, user, accessToken, displayName, signOut, isModerator } =
    useAuth();
  const { resolved, setScheme } = useColorScheme();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [nameDialogOpen, setNameDialogOpen] = useState(false);

  // null while the fetch is in flight (or when there's nobody to fetch for),
  // which is what the skeleton keys off.
  const [myLessons, setMyLessons] = useState(null);

  // Guarded against its own staleness rather than left to resolve whenever.
  // These are lesson titles, drafts included, and the request outlives the
  // session that authorised it: sign out (or sign in as someone else) while one
  // is in flight and the response would arrive to paint the previous user's
  // private drafts into the new one's sidebar. The flag is captured per effect
  // run, so only the newest run may write.
  useEffect(() => {
    if (!hasApi() || !accessToken) {
      setMyLessons(null);
      return;
    }
    let current = true;
    setMyLessons(null);
    fetchMyLessons(accessToken)
      .then((lessons) => {
        if (current) setMyLessons(lessons);
      })
      .catch(() => {
        // Non-fatal: the group renders empty. Navigation still works, and the
        // hub lists the same lessons.
        if (current) setMyLessons([]);
      });
    return () => {
      current = false;
    };
  }, [accessToken]);

  // On a phone the sidebar is a sheet *over* the page, so following a link has
  // to close it or you land on the new page with the sheet still covering it.
  // On desktop it sits beside the page and stays put.
  //
  // Bound to the nav regions rather than the whole sidebar, because the footer
  // holds the theme toggle and the account menu and neither is navigation. The
  // two things down there that *do* navigate call this themselves — the account
  // menu's items especially, since Radix portals the menu outside the sidebar
  // where no ancestor handler of ours would ever see the click.
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  const dark = resolved === "dark";

  return (
    // "icon", not "offcanvas", and not configurable: collapsing this leaves a
    // rail you can still navigate from rather than taking navigation off the
    // page, and it means "collapsed" is one thing wherever you do it. The
    // editor used to pass its own value here, which is how the app ended up
    // with two sidebars of different widths.
    <Sidebar collapsible="icon">
      <SidebarHeader onClick={closeOnMobile}>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip={t("nav.appName")}>
              <RouterLink to="/" className="no-underline">
                <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <SpellCheckIcon className="size-4" />
                </div>
                {/* Explicitly hidden in the rail. The sidebar's own icon-mode CSS only
                    truncates a *span* child, and clips the rest with overflow-hidden —
                    which is enough when the icon fills the 32px button, and isn't here:
                    a size-4 icon leaves room for the first letter of each line to show
                    through the 48px rail. */}
                <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate font-serif font-semibold">
                    {t("nav.appName")}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t("nav.appTagline")}
                  </span>
                </div>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent onClick={closeOnMobile}>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {/* The one action rather than a destination, so it leads and
                  carries the app's accent — this is a lesson-making tool
                  before it is a place to browse.

                  `?new=1` rather than plain /editor, and it is the difference
                  between a button that means what it says and one that doesn't:
                  the editor holds a library of lessons now, so opening it
                  resumes whichever you last had open. This asks for another one.
                  (Pressing it while already in an empty lesson stays put rather
                  than stacking up untitled empties — see EditorPage.) */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip={t("nav.newLesson")}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
                >
                  <RouterLink to="/editor?new=1" className="no-underline">
                    <PlusIcon />
                    <span>{t("nav.newLesson")}</span>
                  </RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Straight to the library panel, which is the list of what this
                  browser is holding. Deliberately a link to the panel rather
                  than the titles inline: the editor rewrites a lesson's title as
                  it is typed, and a copy of it in the sidebar would spend the
                  whole session one keystroke behind. */}
              <NavItem
                to="/editor/lessons"
                icon={LibraryIcon}
                label={t("nav.onThisDevice")}
              />

              <NavItem to="/" icon={HouseIcon} label={t("nav.home")} />
              <NavItem
                to="/hub"
                icon={BookMarkedIcon}
                label={t("nav.lessonHub")}
              />
              {user && (
                <NavItem
                  to={`/users/${user.id}`}
                  icon={UserIcon}
                  label={t("nav.myProfile")}
                />
              )}
              {isModerator && (
                <NavItem
                  to="/moderation"
                  icon={ShieldIcon}
                  label={t("nav.moderation")}
                />
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Signed-out visitors have no lessons to list, and the collapsed rail
            has no room to show them — in both cases the group is absent rather
            than empty. */}
        {hasApi() && user && (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>{t("nav.yourLessons")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {myLessons === null ? (
                  // A skeleton, not a spinner — the list's real shape, held
                  // until the fetch lands.
                  Array.from({ length: 3 }, (_, i) => (
                    <SidebarMenuItem key={i}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))
                ) : myLessons.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    {t("nav.noLessonsYet")}
                  </p>
                ) : (
                  <>
                    {myLessons.slice(0, MY_LESSON_LIMIT).map((lesson) => (
                      <SidebarMenuItem key={lesson.id}>
                        <SidebarMenuButton
                          asChild
                          tooltip={lesson.title || t("nav.untitledLesson")}
                        >
                          <RouterLink
                            to={`/hub/${lesson.id}`}
                            className="no-underline"
                          >
                            {/* A draft and a published lesson look the same in
                                a list of titles; the icon is the only thing
                                that says which is which. */}
                            {lesson.published === false ? (
                              <CloudIcon className="text-muted-foreground" />
                            ) : (
                              <FileTextIcon className="text-muted-foreground" />
                            )}
                            <span>
                              {lesson.title || t("nav.untitledLesson")}
                            </span>
                          </RouterLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                    {myLessons.length > MY_LESSON_LIMIT && (
                      <SidebarMenuItem>
                        <SidebarMenuButton asChild size="sm">
                          <RouterLink
                            to="/hub"
                            className="text-muted-foreground no-underline"
                          >
                            <span>
                              {t("nav.seeAllLessons", {
                                count: myLessons.length,
                              })}
                            </span>
                          </RouterLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )}
                  </>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        {/* The utility row: install, theme, notifications. All three were icon
            buttons on the old header bar and stay icon buttons here. They stack
            when the rail is collapsed, where there's only one column. */}
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          <InstallAppButton className={utilityTrigger} />
          <button
            type="button"
            aria-label={
              dark ? t("nav.switchToLightMode") : t("nav.switchToDarkMode")
            }
            onClick={() => setScheme(dark ? "light" : "dark")}
            className={utilityTrigger}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </button>
          {enabled && user && <NotificationBell className={utilityTrigger} />}
        </div>

        <SidebarMenu>
          <SidebarMenuItem>
            {!enabled ? null : user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* size="lg" drops the button's padding entirely in the rail
                      (`group-data-[collapsible=icon]:p-0!`), which is right for
                      the header above, where a size-8 tile fills the 32px
                      button edge to edge. Here the child is a bare 16px icon,
                      so p-0 left it pinned to the button's left edge at half
                      the weight of the utility icons directly above it —
                      small and visibly off-centre. Centring it and taking it
                      to 24px in the rail only; expanded, it stays 16px beside
                      the name and email, where it is a label and not a target.
                      The `[&>svg]` override outranks the variant's own
                      `[&>svg]:size-4` on specificity, being nested inside the
                      group selector. */}
                  <SidebarMenuButton
                    size="lg"
                    tooltip={displayName || t("nav.account")}
                    className="group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&>svg]:size-6"
                  >
                    <CircleUserIcon />
                    {/* Hidden in the rail for the same reason as the header's —
                        see the comment there. */}
                    <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                      <span className="truncate text-sm font-medium">
                        {displayName || t("nav.signedIn")}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {user.email}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                {/* side="top" because the trigger is at the bottom of the
                    viewport — the menu has nowhere to go but up. */}
                <DropdownMenuContent side="top" align="start" className="w-56">
                  <DropdownMenuLabel className="flex flex-col">
                    <span>{displayName || t("nav.signedIn")}</span>
                    <span className="break-all text-xs font-normal text-muted-foreground">
                      {user.email}
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      closeOnMobile();
                      navigate(`/users/${user.id}`);
                    }}
                  >
                    <UserIcon />
                    {t("nav.myProfile")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setNameDialogOpen(true)}>
                    <IdCardIcon />
                    {t("nav.editDisplayName")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={signOut}>
                    <LogOutIcon />
                    {t("nav.signOut")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <SidebarMenuButton asChild tooltip={t("nav.signIn")}>
                <RouterLink
                  to="/login"
                  onClick={closeOnMobile}
                  className="no-underline"
                >
                  <CircleUserIcon />
                  <span>{t("nav.signIn")}</span>
                </RouterLink>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />

      {user && (
        <DisplayNameDialog
          open={nameDialogOpen}
          onClose={() => setNameDialogOpen(false)}
        />
      )}
    </Sidebar>
  );
}
