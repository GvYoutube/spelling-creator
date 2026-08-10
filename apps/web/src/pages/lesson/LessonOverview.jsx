// The lesson's overview tab: the document itself, with an "About" rail beside
// it — the repo-page shape, where the README is the page and the facts about it
// sit to one side.
//
// The rail is where the header's button row went. Print, Word and Fork used to
// be three ghost buttons squeezed onto the app bar next to the page title, and
// duplicated into an overflow menu for phones; here they are simply a list, in
// the one place on the page that is about the lesson-as-an-object rather than
// about its content.
//
// The document column keeps its reading width. The page around it got wider;
// prose set to the full width of a desktop screen is harder to read, not
// easier, and this is text a child is meant to work through.

import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import {
  CalendarIcon,
  FileDownIcon,
  GitForkIcon,
  LayersIcon,
  PrinterIcon,
  UserIcon,
} from "lucide-react";
import PageBody from "../../components/layout/PageBody.jsx";
import { Button } from "../../components/ui/button.jsx";
import { Spinner } from "../../components/ui/spinner.jsx";
import LessonSummary from "../../components/LessonSummary.jsx";
import LessonView from "../../components/LessonView.jsx";
import MyLessonAnswers from "../../components/MyLessonAnswers.jsx";
import { useLesson } from "./LessonLayout.jsx";

// One line of the About rail: an icon, a label, and a value.
function Fact({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <span className="text-muted-foreground">{label}</span>{" "}
        <span className="break-words">{children}</span>
      </div>
    </div>
  );
}

export default function LessonOverview() {
  const { t } = useTranslation("lesson");
  const { lesson, busy, handleExport, forkLesson, answersSaved, formatDate } =
    useLesson();

  return (
    <PageBody className="flex flex-col gap-6 @min-[52rem]/page:flex-row">
      <div className="min-w-0 flex-1">
        {/* On-device AI summary, above the lesson itself so a reader can decide
            whether to read on. Renders nothing unless the browser supports the
            Summarizer API. */}
        <LessonSummary doc={lesson.doc} />

        {/* LessonView draws the lesson in the app's theme, light or dark, the
            same way interactive mode does — the panel frame around it makes it
            read as a page floating on the app's background. The printout look
            lives in the docx/PDF export, not here. */}
        <div className="overflow-hidden rounded-panel border border-border bg-card shadow-(--shadow-panel)">
          <LessonView doc={lesson.doc} />
        </div>

        {/* The reader's own saved run-throughs of this lesson, visible to
            nobody else — including the lesson's author. Renders nothing when
            signed out or when there are none (see MyLessonAnswers). */}
        <div className="mt-6">
          <MyLessonAnswers lessonId={lesson.id} refreshToken={answersSaved} />
        </div>
      </div>

      {/* Stacked, the rail sits under the lesson — that is what someone came
          for, and the facts about it are a footnote until there's room to put
          them beside it. The breakpoint is the page column's own width, so
          collapsing the sidebar can bring the rail alongside without the window
          changing size at all. */}
      <aside className="order-last w-full shrink-0 @min-[52rem]/page:w-64">
        <div className="flex flex-col gap-3 @min-[52rem]/page:sticky @min-[52rem]/page:top-[calc(var(--header-h)+3.5rem)]">
          <h3 className="text-sm font-semibold">{t("about.heading")}</h3>

          <Fact icon={UserIcon} label={t("about.author")}>
            {lesson.authorId ? (
              <RouterLink
                to={`/users/${lesson.authorId}`}
                className="text-inherit no-underline hover:underline"
              >
                {lesson.author || t("lessonPage.anonymous")}
              </RouterLink>
            ) : (
              lesson.author || t("lessonPage.anonymous")
            )}
          </Fact>

          {typeof lesson.sectionCount === "number" && (
            <Fact icon={LayersIcon} label={t("about.sections")}>
              {t("lessonPage.sectionCount", { count: lesson.sectionCount })}
            </Fact>
          )}

          {lesson.ageRange && (
            <Fact icon={UserIcon} label={t("about.ageRange")}>
              {lesson.ageRange}
            </Fact>
          )}

          {lesson.createdAt && (
            <Fact icon={CalendarIcon} label={t("about.published")}>
              {formatDate(lesson.createdAt)}
            </Fact>
          )}

          {/* Where this lesson came from, when it came from somewhere. A fork
              that hides its origin is the one thing a lesson host shouldn't do. */}
          {lesson.sourceLessonId && (
            <Fact icon={GitForkIcon} label={t("about.forkedFrom")}>
              <RouterLink
                to={`/hub/${lesson.sourceLessonId}`}
                className="text-inherit no-underline hover:underline"
              >
                {t("about.theOriginal")}
              </RouterLink>
            </Fact>
          )}

          <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={() => handleExport("pdf")}
              disabled={Boolean(busy)}
            >
              {busy === "pdf" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PrinterIcon data-icon="inline-start" />
              )}
              {t("lessonPage.printPdf")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={() => handleExport("docx")}
              disabled={Boolean(busy)}
            >
              {busy === "docx" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FileDownIcon data-icon="inline-start" />
              )}
              {t("lessonPage.downloadWord")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={forkLesson}
              disabled={Boolean(busy)}
            >
              <GitForkIcon data-icon="inline-start" />
              {t("lessonPage.fork")}
            </Button>
          </div>
        </div>
      </aside>
    </PageBody>
  );
}
