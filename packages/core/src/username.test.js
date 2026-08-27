import { describe, expect, it } from "vitest";

import {
  DEFAULT_USERNAME_DOMAIN,
  identifierToEmail,
  isEmailAddress,
  isUsername,
  normalizeUsername,
  usernameFromEmail,
  usernameToEmail,
} from "./username.js";

describe("isUsername", () => {
  it("accepts the shapes people actually pick", () => {
    for (const name of ["oliver", "miss.kelly", "year-6", "class_3b", "abc"]) {
      expect(isUsername(name)).toBe(true);
    }
  });

  it("rejects anything that would not survive being an email local part", () => {
    for (const name of [
      "ab", // too short
      "a".repeat(33), // too long
      "has space",
      "with@at",
      "quote'd",
      "comma,separated",
      "", // empty
    ]) {
      expect(isUsername(name)).toBe(false);
    }
  });

  it("rejects leading and trailing punctuation", () => {
    // Otherwise a username could read as punctuation, and `.foo` is not a legal
    // email local part unquoted.
    for (const name of [".oliver", "oliver.", "-oliver", "oliver_"]) {
      expect(isUsername(name)).toBe(false);
    }
  });

  it("is case-insensitive, because somebody will type it differently later", () => {
    expect(isUsername("Oliver")).toBe(true);
    expect(normalizeUsername("  Oliver  ")).toBe("oliver");
  });
});

describe("isEmailAddress", () => {
  it("tells an address from a username", () => {
    expect(isEmailAddress("someone@example.com")).toBe(true);
    expect(isEmailAddress("oliver")).toBe(false);
    expect(isEmailAddress("not@anemail")).toBe(false);
  });
});

describe("usernameToEmail / usernameFromEmail", () => {
  it("round-trips", () => {
    const email = usernameToEmail("Oliver");
    expect(email).toBe(`oliver@${DEFAULT_USERNAME_DOMAIN}`);
    expect(usernameFromEmail(email)).toBe("oliver");
  });

  it("uses a reserved domain by default", () => {
    // RFC 2606 reserves .invalid so it can never resolve — a typo cannot send
    // mail to somebody real.
    expect(DEFAULT_USERNAME_DOMAIN.endsWith(".invalid")).toBe(true);
  });

  it("honours a configured domain", () => {
    expect(usernameToEmail("oliver", "local.test")).toBe("oliver@local.test");
    expect(usernameFromEmail("oliver@local.test", "local.test")).toBe("oliver");
  });

  it("reports a real address as having no username behind it", () => {
    // So the UI shows a real email as itself rather than pretending part of it
    // is a username.
    expect(usernameFromEmail("someone@example.com")).toBe("");
    expect(usernameFromEmail("oliver@other.invalid")).toBe("");
  });
});

describe("identifierToEmail", () => {
  it("passes an address through", () => {
    expect(identifierToEmail("Someone@Example.com")).toEqual({
      email: "someone@example.com",
      kind: "email",
    });
  });

  it("turns a username into its synthetic address", () => {
    expect(identifierToEmail("oliver")).toEqual({
      email: `oliver@${DEFAULT_USERNAME_DOMAIN}`,
      kind: "username",
    });
  });

  it("decides by the value, not by a toggle", () => {
    // This is what lets one field accept either on an instance that has both.
    expect(identifierToEmail("oliver").kind).toBe("username");
    expect(identifierToEmail("oliver@example.com").kind).toBe("email");
  });

  it("returns null for something that is neither", () => {
    for (const input of ["", "  ", "no", "has space", "broken@", "@nope"]) {
      expect(identifierToEmail(input)).toBe(null);
    }
  });
});
