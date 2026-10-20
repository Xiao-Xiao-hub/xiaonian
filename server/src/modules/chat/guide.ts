import { z } from "zod";
import { BANNED_PHRASES } from "../safety/banned-phrases.js";
import { CARD_KINDS, kindType, type CardKind } from "../cards/types.js";

// V4.2 : the model names one of the seven kinds; type (the four-way value
// older clients read) follows from it. An older prompt's type alone still parses.
const cardSchema = z.object({
  type: z.enum(["spark", "idea", "question", "method"]).optional(),
  kind: z.enum(CARD_KINDS).optional(),
  title: z.string().max(100),
}).strict().refine((card) => card.type !== undefined || card.kind !== undefined);
// quote stays optional for messages stored before V4.2; it is no longer asked for or kept.
export type Guide = { quote?: string; options: string[]; spot?: string; add?: boolean;
  card?: { type: "spark" | "idea" | "question" | "method"; kind?: CardKind; title: string }; end?: boolean; problem?: boolean };
// The first n characters by code point, so an emoji is never cut in half.
export const cut = (text: string, n: number) => Array.from(text).slice(0, n).join("");
const schema = z.object({ quote: z.string().max(500).optional(), options: z.array(z.string()).default([]), spot: z.string().max(500).optional(), add: z.boolean().optional(), card: cardSchema.optional(), end: z.boolean().optional(), problem: z.unknown().optional() }).passthrough();
export const normalize = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
export const fromUser = (value: string | undefined, messages: string[]) => {
  const needle = normalize(value ?? "");
  return Boolean(needle) && messages.some((text) => normalize(text).includes(needle));
};
export function splitGuide(text: string) {
  const at = text.search(/<guide/i);
  if (at < 0) return { visible: text.trimEnd(), raw: null as string | null };
  const raw = text.slice(at).replace(/^<guide[^>]*>/i, "").replace(/<\/guide>[\s\S]*$/i, "");
  return { visible: text.slice(0, at).trimEnd(), raw: raw.trim() };
}
export function visibleGuide(text: string) {
  const at = text.search(/<(?:verify|guide)/i);
  if (at >= 0) return text.slice(0, at);
  const partial = text.match(/<(?:v?e?r?i?f?y?|g?u?i?d?e?)$/i);
  return partial ? text.slice(0, partial.index) : text;
}
const banned = [...BANNED_PHRASES].sort((a, b) => b.length - a.length);
export const hasBannedPhrase = (text: string) => banned.some((phrase) => text.includes(phrase));
export function filterBannedPhrases(text: string) {
  let blocked = false;
  for (const phrase of banned) {
    if (!text.includes(phrase)) continue;
    blocked = true;
    text = text.split(phrase).join("这类说法");
  }
  return { text, blocked };
}
// Keep a possible prefix of a forbidden phrase buffered until the next chunk.
export function safeVisibleGuide(text: string, final = false) {
  const filtered = filterBannedPhrases(visibleGuide(text));
  if (final) return filtered;
  let hold = 0;
  for (const phrase of banned)
    for (let length = 1; length < phrase.length; length++)
      if (filtered.text.endsWith(phrase.slice(0, length))) hold = Math.max(hold, length);
  return { text: hold ? filtered.text.slice(0, -hold) : filtered.text, blocked: filtered.blocked };
}
export function parseGuide(raw: string | null, userMessages: string[], study = false): Guide | null {
  if (!raw) return null;
  let json: unknown;
  try { json = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { return null; }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return null;
  const value = parsed.data;
  const spot = study || !fromUser(value.spot, userMessages) || hasBannedPhrase(value.spot ?? "") ? undefined : value.spot;
  const options = value.options.map((v) => filterBannedPhrases(cut(v.trim(), 12)).text)
    .filter(Boolean).slice(0, 4);
  const kind = value.card?.kind;
  const card = !study && value.card
    ? { type: kind ? kindType(kind) : value.card.type!, ...(kind ? { kind } : {}),
      title: filterBannedPhrases(cut(value.card.title.trim(), 16)).text }
    : undefined;
  return { options, ...(spot ? { spot } : {}), ...(!study && value.add ? { add: true } : {}),
    ...(card?.title ? { card } : {}), ...(!study && value.end ? { end: true } : {}),
    ...(study && typeof value.problem === "boolean" ? { problem: value.problem } : {}) };
}
