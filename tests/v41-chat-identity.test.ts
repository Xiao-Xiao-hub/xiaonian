import assert from "node:assert/strict";
import test from "node:test";
import { IDENTITY_RULE } from "../server/src/shared/identity.js";
import {
  practicePrompt,
  similarChoicePrompt,
  similarPrompt,
  tutorSystem,
} from "../server/src/modules/chat/prompts.js";
import { guideSystem, teachSystem } from "../server/src/modules/chat/guide-prompts.js";
import { WRAP_SYSTEM } from "../server/src/modules/chat/service.js";
import {
  DRAFT_SYSTEM,
  STUCK_RULE,
  TEACH_REVIEW_SYSTEM,
  teachReference,
} from "../server/src/modules/chat/tools-prompts.js";
import {
  askPrompt,
  explainPrompt,
  feedbackPrompt,
  hintsPrompt,
  quizPrompt,
  variantPrompt,
} from "../server/src/modules/study/prompts.js";
import { notePrompt } from "../server/src/modules/notes/schema.js";
import { TIDY_SYSTEM } from "../server/src/modules/cards/tidy.js";
import { mergeSystem } from "../server/src/modules/cards/merge.js";
import { BRAINSTORM_SYSTEM, REPORT_SYSTEM } from "../server/src/modules/brainstorm/service.js";
import { SPLIT_SYSTEM } from "../server/src/modules/imports/service.js";
import type { ChatMessage } from "../server/src/providers/llm.js";

const system = (messages: ChatMessage[]) => String(messages[0]!.content);

// every prompt whose output a user reads tells the model not to name
// itself. Judging and recognition prompts are left out on purpose.
test("every user-facing prompt carries the identity rule", () => {
  assert.match(IDENTITY_RULE, /不说模型名/);
  assert.match(IDENTITY_RULE, /只说自己是晓念的学习助手/);
  const prompts: Record<string, string> = {
    tutorAuto: tutorSystem("auto", {}),
    tutorSolution: tutorSystem("solution", { problem: "1+1", note: "[P1] x" }),
    tutorGrade: tutorSystem("grade", {}),
    guideLife: guideSystem("life", true),
    guideMood: guideSystem("mood", false),
    teach: teachSystem(false),
    teachDone: teachSystem(true),
    // the four study tools.
    teachPoint: teachSystem(false, teachReference({ name: "极限", keys: ["a", "b"] })),
    teachTopic: teachSystem(true, teachReference({ topic: "泰勒公式" })),
    tutorStuck: `${tutorSystem("auto", { problem: "1+1" })}\n\n${STUCK_RULE}`,
    draftGrade: DRAFT_SYSTEM,
    teachReview: TEACH_REVIEW_SYSTEM,
    wrap: WRAP_SYSTEM,
    similar: system(similarPrompt("求 1+1", []).messages),
    similarChoice: system(similarChoicePrompt("求 1+1", []).messages),
    practice: system(practicePrompt("极限", "极限", ["计算"], []).messages),
    explain: system(explainPrompt("t", ["p"]).messages),
    ask: system(askPrompt("t", ["p"], "q").messages),
    quiz: system(quizPrompt("t", ["p"]).messages),
    hints: system(hintsPrompt("1+1", null).messages),
    variant: system(variantPrompt("1+1", "2", "1+1").messages),
    feedback: system(
      feedbackPrompt({ question: "q", reference: "r", answer: "a", cause: null, solution: "s" }).messages,
    ),
    note: system(notePrompt([{ id: "s1", text: "一段话" }])),
    tidy: TIDY_SYSTEM,
    merge: mergeSystem("idea"),
    brainstorm: BRAINSTORM_SYSTEM,
    report: REPORT_SYSTEM,
    split: SPLIT_SYSTEM,
  };
  for (const [name, text] of Object.entries(prompts))
    assert.ok(text.includes(IDENTITY_RULE), `${name} lacks the identity rule`);
});
