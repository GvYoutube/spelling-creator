import { beforeEach, describe, expect, it } from "vitest";

import {
  apiUrl,
  configureCore,
  googleClientId,
  hasApi,
  hasGoogleDrive,
  hasMagicLinkAuth,
  hasPasswordAuth,
  hasSupabase,
  hasTurnstile,
  authMode,
  supabaseConfig,
  turnstileSiteKey,
} from "./config.js";
import { imagePublicUrl } from "./browser/imageRef.js";

beforeEach(() => {
  configureCore({
    apiUrl: "",
    supabaseUrl: "",
    supabaseAnonKey: "",
    googleClientId: "",
    turnstileSiteKey: "",
    authMode: "",
  });
});

describe("configureCore", () => {
  it("normalises away a trailing slash so callers can append a path", () => {
    configureCore({ apiUrl: "https://api.example.com/" });
    expect(apiUrl()).toBe("https://api.example.com");

    configureCore({ apiUrl: "https://api.example.com" });
    expect(apiUrl()).toBe("https://api.example.com");
  });

  it("degrades to an empty string rather than throwing when unconfigured", () => {
    // The app is expected to run with no backend at all — the offline editor and
    // the homepage both cope — which is what each module's `import.meta.env`
    // read used to do implicitly.
    expect(apiUrl()).toBe("");
    expect(hasApi()).toBe(false);
  });

  it("merges, so one key can be set without clearing another", () => {
    configureCore({ apiUrl: "https://a.test" });
    configureCore({ somethingElse: true });
    expect(apiUrl()).toBe("https://a.test");
  });

  it("reports whether a backend is configured", () => {
    expect(hasApi()).toBe(false);
    configureCore({ apiUrl: "https://a.test" });
    expect(hasApi()).toBe(true);
  });
});

describe("consumers read the config lazily", () => {
  // This is the property that makes the seam safe: ES imports are hoisted, so
  // configureCore() in main.jsx runs *after* every module in the graph has been
  // evaluated. Anything that captured the value at import time would capture "".
  it("picks up a value configured after the module was imported", () => {
    expect(imagePublicUrl("abc")).toBe("/images/abc");

    configureCore({ apiUrl: "https://api.example.com" });
    expect(imagePublicUrl("abc")).toBe("https://api.example.com/images/abc");

    configureCore({ apiUrl: "https://other.example.com/" });
    expect(imagePublicUrl("abc")).toBe("https://other.example.com/images/abc");
  });
});

describe("supabaseConfig", () => {
  it("needs both halves — neither is usable alone", () => {
    configureCore({ supabaseUrl: "https://x.supabase.co" });
    expect(supabaseConfig()).toBeNull();
    expect(hasSupabase()).toBe(false);

    configureCore({ supabaseUrl: "", supabaseAnonKey: "anon-key" });
    expect(supabaseConfig()).toBeNull();

    configureCore({ supabaseUrl: "https://x.supabase.co" });
    expect(supabaseConfig()).toEqual({
      url: "https://x.supabase.co",
      anonKey: "anon-key",
    });
    expect(hasSupabase()).toBe(true);
  });
});

describe("the optional integrations", () => {
  it("report unavailable rather than throwing when unset", () => {
    // Each of these gates a feature that degrades: the AI dialogs, the Google
    // Docs export and sign-in all explain themselves instead of failing.
    expect(hasGoogleDrive()).toBe(false);
    expect(googleClientId()).toBe("");
    expect(hasTurnstile()).toBe(false);
    expect(turnstileSiteKey()).toBe("");
    expect(hasSupabase()).toBe(false);
  });

  it("become available once configured", () => {
    configureCore({
      googleClientId: "123.apps.googleusercontent.com",
      turnstileSiteKey: "0x4AAA",
    });
    expect(hasGoogleDrive()).toBe(true);
    expect(googleClientId()).toBe("123.apps.googleusercontent.com");
    expect(hasTurnstile()).toBe(true);
    expect(turnstileSiteKey()).toBe("0x4AAA");
  });
});

describe("authMode", () => {
  it("defaults to magic link, the hosted instance's behaviour", () => {
    expect(authMode()).toBe("magic-link");
    expect(hasMagicLinkAuth()).toBe(true);
    expect(hasPasswordAuth()).toBe(false);
  });

  it("offers passwords when asked", () => {
    configureCore({ authMode: "password" });
    expect(hasPasswordAuth()).toBe(true);
    // Password-only is what an instance with no mail server wants: a magic link
    // it cannot send is not a way in.
    expect(hasMagicLinkAuth()).toBe(false);
  });

  it("offers both when asked", () => {
    configureCore({ authMode: "both" });
    expect(hasPasswordAuth()).toBe(true);
    expect(hasMagicLinkAuth()).toBe(true);
  });

  it("treats anything it does not recognise as the default", () => {
    // A typo should leave an instance on magic links, not on an instance nobody
    // can sign in to.
    for (const mode of ["passwords", "PASSWORD", "true", "yes", " "]) {
      configureCore({ authMode: mode });
      expect(authMode()).toBe("magic-link");
    }
  });

  it("trims whitespace, which an env file readily supplies", () => {
    configureCore({ authMode: " both " });
    expect(authMode()).toBe("both");
  });
});
