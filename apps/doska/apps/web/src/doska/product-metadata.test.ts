import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const origin = "https://tasks.example.invalid";
const html = readFileSync("index.html", "utf8");
const page = new DOMParser().parseFromString(html, "text/html");

describe("portable product metadata", () => {
  it("describes PL and leaves canonical origin to the installation", () => {
    expect(page.documentElement.lang).toBe("ru");
    expect(page.title).toBe("Задачи — PL");
    expect(
      page
        .querySelector('meta[name="application-name"]')
        ?.getAttribute("content"),
    ).toBe("PL");
    expect(page.querySelector('link[rel="canonical"]')).toBeNull();
    expect(
      page.querySelector('meta[property="og:url"],meta[name="twitter:url"]'),
    ).toBeNull();
  });

  it("does not install telemetry or load images/scripts from another deployment", () => {
    for (const script of page.querySelectorAll("script")) {
      expect(script.textContent?.trim()).toBe("");
      expect(new URL(script.getAttribute("src")!, origin).origin).toBe(origin);
    }
    for (const link of page.querySelectorAll("link[href]"))
      expect(new URL(link.getAttribute("href")!, origin).origin).toBe(origin);
    expect(
      page.querySelector(
        'meta[property="og:image"],meta[name="twitter:image"]',
      ),
    ).toBeNull();
  });

  it("uses PL and own-origin assets in the standalone manifest", () => {
    const manifest = JSON.parse(
      readFileSync("public/site.webmanifest", "utf8"),
    );
    expect(manifest.name).toBe("Задачи — PL");
    expect(manifest.short_name).toBe("PL");
    for (const icon of manifest.icons)
      expect(new URL(icon.src, origin).origin).toBe(origin);
  });
});
