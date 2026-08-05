import { beforeEach, describe, expect, it } from "vitest";

import { apiUrl, configureCore, hasApi } from "./config.js";
import { imagePublicUrl } from "./browser/imageRef.js";

beforeEach(() => {
  configureCore({ apiUrl: "" });
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
