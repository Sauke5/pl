export const defaultSectionOrder = [
  "favorites",
  "problems",
  "directions",
  "reports",
  "events",
  "tools",
  "integrations",
  "wayline",
  "grafana",
] as const;
export type HomeSectionID = (typeof defaultSectionOrder)[number];
export function normalizeSectionOrder(order?: string[]): HomeSectionID[] {
  return [...new Set([...(order || []), ...defaultSectionOrder])].filter(
    (id): id is HomeSectionID =>
      defaultSectionOrder.includes(id as HomeSectionID),
  );
}
