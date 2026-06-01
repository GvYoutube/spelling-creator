// The age ranges a lesson can be pitched at. Stored verbatim on the doc
// (doc.ageRange) so the value is self-describing wherever it's read — including
// in the AI lesson-idea prompt, which uses it directly. An empty value means
// "not set / any age".
export const AGE_RANGES = [
  "3-5 years",
  "5-7 years",
  "7-9 years",
  "9-11 years",
  "11-14 years",
  "14-16 years",
  "16+ years",
];
