export const CRISIS_WORDS = [
  "不想活",
  "想死",
  "自杀",
  "轻生",
  "割腕",
] as const;

export function hasCrisisWords(text: string): boolean {
  return CRISIS_WORDS.some((word) => text.includes(word));
}
