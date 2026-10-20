import { z } from "zod";
import type { CardType } from "./types.js";

export const SLOT_KEYS: Record<CardType, readonly string[]> = {
  spark: ["seed", "expand"],
  idea: ["claim", "why"],
  question: ["ask", "known", "stuck", "cause"],
  method: ["when", "steps", "example", "pitfall"],
};
// The editor's names for the slots, for words moved into 补充.
export const SLOT_LABELS: Record<string, string> = {
  seed: "关键",
  expand: "还能往哪想",
  claim: "我认为",
  why: "因为",
  ask: "想问的",
  known: "已经知道的",
  stuck: "卡在",
  cause: "错在",
  when: "什么时候用",
  steps: "步骤",
  example: "例子",
  pitfall: "容易错",
};
export const slotSchema = z
  .object({
    key: z.string().min(1).max(20),
    text: z.string().max(60),
    by: z.enum(["user", "ai"]).optional(),
  })
  .strict();
export const openSchema = z
  .object({
    key: z.string().min(1).max(40),
    cat: z.enum(["decide", "verify"]),
    text: z.string().max(30),
    quote: z.string().max(30).optional(),
    by: z.enum(["user", "ai"]).optional(),
    answer: z.string().max(300).optional(),
    done: z.boolean().optional(),
  })
  .strict();
export const nextSchema = z
  .object({
    if: z.string().max(100),
    then: z.string().max(100),
    on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    by: z.enum(["user", "ai"]).optional(),
  })
  .strict();
export const normalized = (text: string) =>
  text.replace(/[\s\p{P}\p{S}]/gu, "");
export const isQuote = (quote: string, sources: string[]) =>
  Boolean(normalized(quote)) &&
  sources.some((source) => normalized(source).includes(normalized(quote)));
