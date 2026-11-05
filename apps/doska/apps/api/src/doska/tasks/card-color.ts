export const cardColors = [
  "blue",
  "cyan",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
] as const;
export type CardColor = (typeof cardColors)[number];
