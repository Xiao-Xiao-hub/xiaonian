import { z } from "zod";
import { CARD_KINDS } from "../cards/types.js";

export const sourceSchema = z.enum([
  "paste",
  "photo",
  "screenshot",
  "txt",
  "md",
  "docx",
  "pdf",
]);
export type ImportSource = z.infer<typeof sourceSchema>;

export const segmentSchema = z
  .object({
    n: z.number().int().positive(),
    text: z.string().min(1).max(20_000),
    page: z.number().int().positive().nullable().optional(),
    who: z.enum(["me", "other"]).nullable().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ImportSegment = z.infer<typeof segmentSchema>;

export const pageSchema = z
  .object({
    n: z.number().int().positive(),
    scan: z.boolean(),
    ok: z.boolean(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ImportPage = z.infer<typeof pageSchema>;

export const candidateSchema = z
  .object({
    id: z.string().min(1).max(40),
    type: z.enum(["spark", "idea", "question", "method"]),
    // V4.2 : one of the seven kinds; type stays its four-way value for
    // clients 0.4.0–0.6.0. Missing on candidates split before V4.2.
    kind: z.enum(CARD_KINDS).optional(),
    scene: z.enum(["study", "life"]),
    title: z.string().trim().min(1).max(16),
    summary: z.string().trim().min(1).max(60),
    src: z.array(z.number().int().positive()).min(1).max(8),
    open: z
      .object({
        cat: z.enum(["decide", "verify"]),
        text: z.string().trim().min(1).max(30),
      })
      .strict()
      .nullable()
      .optional(),
    tags: z.array(z.string().trim().min(1).max(6)).max(3),
    pointId: z.string().max(80).nullable().optional(),
    pointConfidence: z.number().min(0).max(1).nullable().optional(),
    moodSuggested: z.boolean().optional(),
    crisis: z.boolean().optional(),
    savedCardId: z.string().max(80).nullable().optional(),
  })
  .strict();
export type ImportCandidate = z.infer<typeof candidateSchema>;

export const splitOutputSchema = z
  .object({
    cards: z
      .array(
        z
          .object({
            // one of the seven kinds; the candidate keeps it as `kind`
            // and its four-way value as `type`.
            type: z.enum(CARD_KINDS),
            scene: z.enum(["study", "life"]),
            title: z.string().trim().min(1).max(16),
            summary: z.string().trim().min(1).max(60),
            src: z.array(z.number().int().positive()).min(1).max(8),
            open: z
              .object({
                cat: z.enum(["decide", "verify"]),
                text: z.string().trim().min(1).max(30),
              })
              .strict()
              .nullable()
              .optional(),
            tags: z.array(z.string().trim().min(1).max(6)).max(3),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export const photoOutputSchema = z
  .object({
    // Empty strings are dropped later, not a failed page.
    paragraphs: z.array(z.string().max(4000)).max(200),
  })
  .strict();
export const screenshotOutputSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            who: z.enum(["me", "other"]),
            text: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .max(300),
  })
  .strict();
// a picture is a chat (lines with who) or a page of text (paragraphs),
// decided in the same call.
export const imageOutputSchema = z
  .object({
    chat: z.boolean().optional(),
    lines: z
      .array(
        z
          .object({
            who: z.enum(["me", "other"]),
            text: z.string().max(2000),
          })
          .strict(),
      )
      .max(300)
      .optional(),
    paragraphs: z.array(z.string().max(4000)).max(200).optional(),
  })
  .strict();
