import type { EmailLocale } from "../templates/resolve-locale";
import type { FooterLink } from "./email-footer";

export function footerLinks(
  _locale: EmailLocale,
  leading: FooterLink[] = [],
): FooterLink[] {
  return [...leading];
}
