// The printed lesson's title block and footer text. Most of this is plain
// assembly; the part worth pinning down is how a publication date is read, which
// decides both the "Released …" line and the copyright year.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lessonCopyright, lessonTitleLines } from "./lessonLayout.js";

describe("lessonTitleLines", () => {
  it("leads with the by-line, then the age range and release month", () => {
    expect(
      lessonTitleLines(
        { ageRange: "9-11 years" },
        { author: "Jane Smith", published: "2026-05-14T09:30:00Z" },
      ),
    ).toEqual([
      { text: "By Jane Smith", bold: true },
      { text: "Ages: 9-11 years", bold: false },
      { text: "Released May 2026", bold: false },
    ]);
  });

  it("leaves out whatever the lesson doesn't have", () => {
    expect(lessonTitleLines({}, {})).toEqual([]);
    expect(lessonTitleLines({}, { author: "  " })).toEqual([]);
    expect(lessonTitleLines({ ageRange: "5-7 years" }, {})).toEqual([
      { text: "Ages: 5-7 years", bold: false },
    ]);
  });

  it("ignores a publication date it can't read", () => {
    expect(
      lessonTitleLines({}, { author: "A", published: "not a date" }),
    ).toEqual([{ text: "By A", bold: true }]);
  });
});

describe("lessonCopyright", () => {
  it("names the author and the year it was published", () => {
    expect(
      lessonCopyright({
        author: "Jane Smith",
        published: "2026-05-14T09:30:00Z",
      }),
    ).toBe("© 2026 Jane Smith");
  });

  it("is empty with nobody to attribute it to", () => {
    expect(lessonCopyright({})).toBe("");
    expect(lessonCopyright({ published: "2026-05-14" })).toBe("");
  });

  it("falls back to the current year for an unpublished lesson", () => {
    expect(lessonCopyright({ author: "Jane Smith" })).toBe(
      `© ${new Date().getFullYear()} Jane Smith`,
    );
  });
});

// `new Date("2026-01-01")` is UTC midnight by spec, so reading its *local* month
// and year lands on the previous day — and, on New Year's Day, the previous
// month and year — anywhere west of Greenwich. A calendar day carries no zone,
// so it has to be read as the day it says wherever the reader happens to be.
describe("a date-only publication value, read west of UTC", () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    process.env.TZ = original;
  });

  it("keeps the month and year the date actually names", () => {
    expect(lessonTitleLines({}, { published: "2026-01-01" })).toEqual([
      { text: "Released January 2026", bold: false },
    ]);
    expect(lessonCopyright({ author: "A", published: "2026-01-01" })).toBe(
      "© 2026 A",
    );
  });

  it("still reads a real instant as the instant it is", () => {
    // 00:30 UTC on New Year's Day is still the previous evening in California,
    // and unlike a bare calendar day this one really does name that moment.
    expect(lessonTitleLines({}, { published: "2026-01-01T00:30:00Z" })).toEqual(
      [{ text: "Released December 2025", bold: false }],
    );
  });
});
