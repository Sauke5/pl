import { describe, expect, it } from "vite-plus/test";
import { resolveApiBaseUrl } from "./api-url";

describe("resolveApiBaseUrl", () => {
  it("keeps Platform requests on the gateway origin despite standalone API settings", () => {
    expect(
      resolveApiBaseUrl("http://localhost:1337", "/doska/", "platform"),
    ).toBe("/doska/api");
    expect(resolveApiBaseUrl("https://other.test", "/", "platform")).toBe(
      "/api",
    );
  });
  it("uses the deployment prefix when no separate API is configured", () => {
    expect(resolveApiBaseUrl(undefined, "/doska/")).toBe("/doska/api");
    expect(resolveApiBaseUrl("/doska/api/", "/doska/")).toBe("/doska/api");
    expect(resolveApiBaseUrl("https://example.test/doska", "/")).toBe(
      "https://example.test/doska/api",
    );
  });
  it("appends /api when the base has no api suffix", () => {
    expect(resolveApiBaseUrl(undefined)).toBe("http://localhost:1337/api");
    expect(resolveApiBaseUrl("http://localhost:1337")).toBe(
      "http://localhost:1337/api",
    );
  });

  it("returns the URL unchanged when it already ends with /api", () => {
    expect(resolveApiBaseUrl("http://localhost:1337/api")).toBe(
      "http://localhost:1337/api",
    );
  });

  it("strips trailing slashes before appending /api", () => {
    expect(resolveApiBaseUrl("http://localhost:1337/")).toBe(
      "http://localhost:1337/api",
    );
    expect(resolveApiBaseUrl("http://localhost:1337/api/")).toBe(
      "http://localhost:1337/api",
    );
  });
});
