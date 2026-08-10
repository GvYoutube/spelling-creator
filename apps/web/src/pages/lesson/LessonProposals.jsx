// The proposals tab (/hub/:id/proposals): changes other people have offered
// back to this lesson from their forks.
//
// PullRequestsSection is the same component that used to sit stacked under the
// lesson; `standalone` is what tells it it's a page now — it shows a loading
// state and an empty state instead of silently rendering nothing, and its rows
// link through to a proposal's own page.

import PullRequestsSection from "../../components/PullRequestsSection.jsx";
import { useLesson } from "./LessonLayout.jsx";

export default function LessonProposals() {
  const { lesson } = useLesson();

  return <PullRequestsSection lessonId={lesson.id} standalone />;
}
