// The practice tab (/hub/:id/practice) — interactive mode, one step at a time.
//
// InteractiveLesson is still the dialog it always was, and deliberately so: it
// is a full-screen focus mode with its own bottom bars and its own idea of the
// viewport, and turning 750 lines of that inside out to become a page would
// have changed how it behaves, not just where it lives. What the route adds is
// the thing it was missing — a URL. "Start lesson" is now a link someone can
// send to a class, and closing it goes back rather than dropping a modal.
//
// Closing navigates to the overview rather than calling history.back(), because
// a deep link straight to /practice has no history to go back to.

import { Navigate, useNavigate } from "react-router-dom";
import InteractiveLesson from "../../components/InteractiveLesson.jsx";
import { useLesson } from "./LessonLayout.jsx";

export default function LessonPractice() {
  const navigate = useNavigate();
  const { lesson, playable, onAnswersSaved } = useLesson();

  // A lesson whose sections are all empty has nothing to walk through, so
  // LessonTabs hides this tab for it — but the route still matches, and a
  // direct link used to render an empty body under the lesson's header. Send
  // them to the lesson instead, replacing the entry so Back doesn't bounce
  // straight back here.
  if (!playable) return <Navigate to={`/hub/${lesson.id}`} replace />;

  return (
    <InteractiveLesson
      lesson={lesson}
      open
      onOpenChange={(next) => {
        if (!next) navigate(`/hub/${lesson.id}`, { replace: true });
      }}
      onSaved={onAnswersSaved}
    />
  );
}
