import { describe, expect, it } from "vite-plus/test";
import { footerLinks } from "./footer-links";

describe("installation email footer links", () => {
  it("does not add links when the caller has not supplied any", () => {
    expect(footerLinks("en")).toEqual([]);
  });

  it.each(["en", "de", "vi", "ja", "zh-tw"] as const)(
    "preserves explicit notification and billing links in %s",
    (locale) => {
      const links = [
        {
          label: "Notifications",
          href: "https://tasks.example.invalid/installation/notifications",
        },
        {
          label: "Billing",
          href: "https://tasks.example.invalid/installation/billing",
        },
      ];
      const result = footerLinks(locale, links);
      expect(result).toEqual(links);
      expect(result).not.toBe(links);
      result.pop();
      expect(links).toHaveLength(2);
    },
  );
});
