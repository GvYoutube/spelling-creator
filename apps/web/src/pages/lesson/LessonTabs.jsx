// The lesson's tab bar.
//
// Real links, not a Tabs widget: each tab is a route, so it is shareable, the
// back button walks them, and the Worker can server-render any of them. That is
// the whole reason the lesson page was split up — a `<Tabs>` would have given
// the look of this and none of it.
//
// It scrolls horizontally rather than wrapping or collapsing, because a phone
// can't fit six labels and a wrapped second row would push the lesson itself
// below the fold on the page whose entire job is to show the lesson.

import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import {
  FileTextIcon,
  GitPullRequestIcon,
  HistoryIcon,
  MessagesSquareIcon,
  PlayIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { PAGE_WIDTHS } from "../../components/layout/PageBody.jsx";

// `end` on the overview only: it lives at the layout's index path, so without
// it every tab would light it up as well as itself.
const TABS = [
  { to: ".", end: true, icon: FileTextIcon, key: "overview" },
  { to: "practice", icon: PlayIcon, key: "practice", playableOnly: true },
  { to: "discussion", icon: MessagesSquareIcon, key: "discussion" },
  { to: "proposals", icon: GitPullRequestIcon, key: "proposals" },
  { to: "history", icon: HistoryIcon, key: "history" },
];

export default function LessonTabs({ playable }) {
  const { t } = useTranslation("lesson");

  return (
    <div className="sticky top-(--header-h) z-30 mt-4 border-b border-border bg-background/80 backdrop-blur-(--glass-blur)">
      {/* Full-bleed underline, column-aligned links: the border runs the width
          of the page, the tabs line up with the lesson beneath them. */}
      <nav
        className={cn(
          "mx-auto flex w-full gap-1 overflow-x-auto px-4",
          PAGE_WIDTHS.wide,
        )}
      >
        {TABS.filter((tab) => !tab.playableOnly || playable).map(
          ({ to, end, icon: Icon, key }) => (
            <NavLink
              key={key}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm no-underline transition-colors",
                  isActive
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {t(`tabs.${key}`)}
            </NavLink>
          ),
        )}
      </nav>
    </div>
  );
}
