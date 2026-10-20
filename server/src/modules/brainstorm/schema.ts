import { z } from "zod";
import { CARD_KINDS } from "../cards/types.js";

// V4.2 : what a group's shared point is about, as the card slot key it
// fits (only keys some card type has; claim/ask/seed are the conclusion itself).
export const GROUP_SLOTS = [
  "why",
  "when",
  "steps",
  "example",
  "pitfall",
  "known",
  "stuck",
  "cause",
  "expand",
] as const;
// V4.2 : what kind of difference two cards have: 要查证 / 要选择 /
// only a different angle or condition (nothing to settle).
export const TENSION_KINDS = ["verify", "choose", "differ"] as const;
const refs = z.array(z.number().int().positive()).min(1).max(50);

export const brainstormOutputSchema = z
  .object({
    title: z.string().trim().min(1).max(16),
    groups: z
      .array(
        z
          .object({
            name: z.string().trim().max(8),
            common: z.string().trim().min(1).max(30),
            cards: refs,
            slot: z.string().trim().max(12).optional(),
          })
          .strict(),
      )
      .max(8),
    tensions: z
      .array(
        z
          .object({
            a: z.number().int().positive(),
            b: z.number().int().positive(),
            note: z.string().trim().min(1).max(30),
            kind: z.string().trim().max(12).optional(),
          })
          .strict(),
      )
      .max(8),
    more: z
      .array(
        z
          .object({
            type: z.enum(["question", "spark"]),
            title: z.string().trim().min(1).max(16),
            from: refs,
          })
          .strict(),
      )
      .max(8),
    ifs: z
      .array(
        z
          .object({
            if: z.string().trim().min(1).max(20),
            from: refs,
          })
          .strict(),
      )
      .max(5),
    directions: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(16),
            why: z.string().trim().min(1).max(40),
            from: refs,
          })
          .strict(),
      )
      .max(5),
    drafts: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(40),
            from: refs,
            kind: z.string().trim().max(12).optional(),
          })
          .strict(),
      )
      .max(5),
    ask: z
      .object({
        q: z.string().trim().min(1).max(40),
        options: z.array(z.string().trim().min(1).max(12)).max(4),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type BrainstormOutput = z.infer<typeof brainstormOutputSchema>;
type Group = Omit<BrainstormOutput["groups"][number], "slot"> & {
  slot?: (typeof GROUP_SLOTS)[number];
};
type Tension = Omit<BrainstormOutput["tensions"][number], "kind"> & {
  kind?: (typeof TENSION_KINDS)[number];
};
type Draft = Omit<BrainstormOutput["drafts"][number], "kind"> & {
  kind?: (typeof CARD_KINDS)[number];
};
// Results stored before V4.2 G1b have no slot / kind fields.
export type BrainstormResult = Omit<
  BrainstormOutput,
  "groups" | "tensions" | "more" | "ifs" | "directions" | "drafts"
> & {
  groups: Array<Group & { id: string }>;
  tensions: Array<Tension & { id: string }>;
  more: Array<BrainstormOutput["more"][number] & { id: string }>;
  ifs: Array<BrainstormOutput["ifs"][number] & { id: string }>;
  directions: Array<BrainstormOutput["directions"][number] & { id: string }>;
  drafts: Array<Draft & { id: string }>;
};

const choice = z.enum(["depends", "a", "b", "unsure"]);
export const picksSchema = z
  .object({
    title: z.string().trim().min(1).max(16).optional(),
    groups: z
      .array(
        z
          .object({
            id: z.string().regex(/^g\d+$/),
            name: z.string().trim().max(8),
            common: z.string().trim().min(1).max(30),
            cards: refs,
            slot: z.enum(GROUP_SLOTS).optional(),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    tensions: z
      .array(
        z
          .object({
            id: z.string().regex(/^t\d+$/),
            a: z.number().int().positive(),
            b: z.number().int().positive(),
            note: z.string().trim().min(1).max(30),
            kind: z.enum(TENSION_KINDS).optional(),
            choice: choice.optional(),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    more: z
      .array(
        z
          .object({
            id: z.string().regex(/^m\d+$/),
            type: z.enum(["question", "spark"]),
            title: z.string().trim().min(1).max(16),
            from: refs,
            selected: z.boolean().default(false),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    ifs: z
      .array(
        z
          .object({
            id: z.string().regex(/^i\d+$/),
            if: z.string().trim().min(1).max(20),
            from: refs,
            selected: z.boolean().default(false),
            then: z.string().trim().max(100).optional(),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    directions: z
      .array(
        z
          .object({
            id: z.string().regex(/^r\d+$/),
            title: z.string().trim().min(1).max(16),
            why: z.string().trim().min(1).max(40),
            from: refs,
          })
          .strict(),
      )
      .max(3)
      .optional(),
    drafts: z
      .array(
        z
          .object({
            id: z.string().regex(/^d\d+$/),
            text: z.string().trim().min(1).max(40),
            from: refs,
            kind: z.enum(CARD_KINDS).optional(),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    ask: z
      .object({
        q: z.string().trim().min(1).max(40),
        options: z.array(z.string().trim().min(1).max(12)).max(4),
      })
      .strict()
      .nullable()
      .optional(),
    conclusion: z
      .object({
        text: z.string().trim().max(300),
        type: z.enum(["spark", "idea", "question", "method"]).optional(),
        // V4.2 : one of the seven kinds; type stays for old clients.
        kind: z.enum(CARD_KINDS).optional(),
        title: z.string().trim().min(1).max(16).optional(),
        draftId: z
          .string()
          .regex(/^d\d+$/)
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
    pause: z.boolean().optional(),
  })
  .strict();

export type BrainstormPicks = z.infer<typeof picksSchema>;

// 报告: what the picked cards say together. "from" holds 1-based card numbers.
const reportItem = z.object({
  text: z.string().trim().min(1).max(60),
  from: z.array(z.number().int()).max(5),
});
const reportItems = z.array(reportItem).max(5);
export const REPORT_SECTIONS = ["links", "improve", "expand", "advice"] as const;
export const brainstormReportSchema = z.object({
  sections: z.object({
    links: reportItems,
    improve: reportItems,
    expand: reportItems,
    advice: reportItems,
  }),
});
export type BrainstormReportOutput = z.infer<typeof brainstormReportSchema>;
// basis : digest of the groups, differences and directions the
// report was written from; absent on older reports.
export type StoredReport = BrainstormReportOutput & {
  createdAt: string;
  basis?: string;
};
