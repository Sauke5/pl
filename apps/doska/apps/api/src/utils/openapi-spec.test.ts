import { describe, expect, it } from "vite-plus/test";
import { normalizeApiServerUrl } from "./openapi-spec";

describe("portable OpenAPI server URLs", () => {
  it("uses the current origin without a configured public endpoint", () => {
    expect(normalizeApiServerUrl()).toBe("/api");
    expect(normalizeApiServerUrl("")).toBe("/api");
    expect(normalizeApiServerUrl("/api/")).toBe("/api");
    expect(normalizeApiServerUrl("/doska/")).toBe("/doska/api");
  });

  it("preserves an explicitly configured installation prefix", () => {
    expect(normalizeApiServerUrl("https://tasks.example.invalid/doska/")).toBe(
      "https://tasks.example.invalid/doska/api",
    );
    expect(
      normalizeApiServerUrl("https://tasks.example.invalid/doska/api/"),
    ).toBe("https://tasks.example.invalid/doska/api");
  });
});
