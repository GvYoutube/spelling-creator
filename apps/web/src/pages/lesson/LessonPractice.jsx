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

import { useNavigate } from "react-router-dom";
import InteractiveLesson from "../../components/InteractiveLesson.jsx";
import { useLesson } from "./LessonLayout.jsx";

export default function LessonPractice() {
  const navigate = useNavigate();
  const { lesson, playable, onAnswersSaved } = useLesson();

  if (!playable) return null;

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
