/*
 * 资料学习与题目练习：基于确认后的原文生成讲解、追问、自测、提示和同类题。
 * routes.ts 接收请求，prompts.ts 约定模型输入输出，JobRunner 执行任务并保存生成结果。
 * 结果关联材料版本；规则能够判定的答案优先本地核对，不能确定时保留不确定状态。
 */
import { randomUUID } from "node:crypto";
import type { ZodTypeAny } from "zod";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import {
  ProviderError,
  type ChatMessage,
  type LlmClient,
  type LlmUsage,
} from "../../providers/llm.js";
import {
  checkClaims,
  checkedText,
  type ClaimItem,
  type Claims,
} from "../../shared/claims.js";
import {
  parseCheck,
  sameAntiderivative,
  sameConstant,
  sameFunction,
} from "../../shared/verify.js";
import { similarPrompt } from "../chat/prompts.js";
import type { Jev } from "../../providers/jev.js";
import {
  checkTemplate,
  compareNumericAnswers,
  evaluateNumber,
  formatNumber,
  parseNumber,
  sameNumber,
  sampleVariant,
  type VariantTemplate,
} from "../../shared/math.js";
import {
  JobError,
  publicJob,
  toJob,
  type Job,
  type JobHandler,
} from "../jobs/runner.js";
import type { Material, MaterialService } from "../materials/service.js";
import { answerText } from "../render/markdown.js";
import type { MistakeService } from "../mistakes/service.js";
import { now as businessNow, type Clock } from "../../shared/time.js";
import {
  PROMPT_VERSION,
  askPrompt,
  explainPrompt,
  feedbackPrompt,
  hintsPrompt,
  hintsRecheck,
  quizPrompt,
  variantPrompt,
  type Hints,
  type Quiz,
  type VariantPlan,
} from "./prompts.js";
export type ArtifactKind = "explain" | "answer" | "quiz" | "hints" | "variant";
export type Artifact = {
  id: string;
  userId: string;
  materialId: string;
  version: number;
  kind: ArtifactKind;
  jobId: string | null;
  data: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
};
// user: typed in by the learner; rule: checked by the program (arithmetic, or the
// claims in shared/claims.ts); ai: model draft.
export type Reference = {
  value: string;
  source: "user" | "rule" | "ai";
  check?: string;
  note?: string;
  // The program disagreed with this answer even after a second try.
  disputed?: boolean;
  // Added when read back: the value as plain text for the screen.
  text?: string;
  // The program-checked answer (mathjs) that answers are judged against.
  key?: string;
};
export type HintsData = Hints & { answer: Reference | null; model?: string };
type VariantData = {
  question: string;
  answer: string;
  key?: string;
  source: Reference["source"];
  check?: string;
  solution?: string;
  template?: VariantTemplate;
  original?: Record<string, number>;
};
type Verdict = "correct" | "incorrect" | "unsure";
export type AttemptResult = {
  verdict: Verdict;
  judge: "choice" | "rule" | "jev" | "none";
  confidence: number | null;
  reference: Reference | null;
  cause: { key: string; label: string; confidence: number } | null;
  comment: string;
  explanation: string;
  citations: number[];
  revealSolution: boolean;
};
type FeedbackOutput = { result: AttemptResult; hints?: HintsData };
// "-\frac{1}{6}" is shown as "-1/6": answers are often written in TeX.
const withText = (r: AttemptResult): AttemptResult =>
  r.reference
    ? {
        ...r,
        reference: {
          ...r.reference,
          text: answerText(r.reference.value),
        },
      }
    : r;
type Prompt = { messages: ChatMessage[]; schema: ZodTypeAny };
// Error causes offered to Jev; the descriptions are the decision rules.
const CAUSES: Record<string, [label: string, rule: string]> = {
  misread: ["审题偏差", "把题目问的量弄错了，例如求成了中间量、差值或另一个量"],
  concept: ["概念不清", "对相关概念、定义、公式或规则的理解有误"],
  method: ["方法有误", "解题思路或步骤不对、漏了步骤或顺序颠倒"],
  calc: ["计算失误", "方法正确，但计算过程中算错了数"],
  unit: ["单位或格式", "数值本身对，但单位、精度或书写形式不符合要求"],
  other: ["其他", "从回答中看不出具体原因，或不属于以上情况"],
};
// These prompts contain no material, model output or answer until the solution opens.
const HIDDEN_GUIDANCE: Record<string, string> = {
  misread: "先核对题目问的是什么，再检查是否用上了所有条件。",
  concept: "先回想这道题涉及的概念，再对照已有提示。",
  method: "先检查解题顺序和使用的方法，再对照已有提示。",
  calc: "先重新检查计算过程，再对照已有提示试一次。",
  unit: "先核对题目要求的单位和格式，再检查自己的答案。",
  constant: "原函数求对了，只差积分常数：不定积分要写成“原函数 + C”。",
  sign: "大小求对了，只是符号反了：检查展开式、求导或移项里的正负号。",
};
// Found by the program, not offered to Jev: an indefinite integral right but
// for its constant. Saying so gives nothing away.
const MISSING_C = { key: "constant", label: "漏写常数 C", confidence: 1 };
// Likewise a number or function right but for its sign.
const WRONG_SIGN = { key: "sign", label: "符号反了", confidence: 1 };
const hiddenGuidance = (cause: AttemptResult["cause"]) =>
  HIDDEN_GUIDANCE[cause?.key ?? ""] ??
  "先核对题目条件和自己的答案，再看看已有提示。";
const newId = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;
const mathText = (expression: string) =>
  expression.replace(/×/g, "*").replace(/÷/g, "/");
// The model may write units with ASCII powers ("m/s^2"); write them the way problems do
// ("m/s²"), which also lets the number rule read the reference answer.
const unitText = (unit: string) =>
  unit.replace(/\^(-?\d+)/g, (_, power: string) =>
    [...power].map((c) => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(c)]).join(""),
  );
function toArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    materialId: String(row.material_id),
    version: Number(row.version),
    kind: row.kind as ArtifactKind,
    jobId: (row.job_id as string | null) ?? null,
    data: JSON.parse(String(row.data)) as Record<string, unknown>,
    state: JSON.parse(String(row.state)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}
// Calculus and similar problems: a bare number in the model's "expression"
// proves nothing about them, only the program's claims do.
const CALCULUS =
  /\\(?:lim|int|iint|oint|sum|prod|partial)|\\frac\s*\{\s*d|极限|导数|求导|微分|积分|级数|偏导|渐近线|拐点|极值|单调|∫|∑|\blim\b/i;
// what "再练一道" can offer for a problem, decided as planVariant
// would: "similar" when the program checks each new problem (calculus, or
// claims to check), "numbers" when the answer is a number an expression
// computes, null when neither (concept and proof problems): no button then.
export function variantKind(hints: HintsData): "numbers" | "similar" | null {
  if (!hints.complete || !hints.answer) return null;
  if (hints.checks?.length || CALCULUS.test(hints.levels.join("\n")))
    return "similar";
  return hints.expression && parseNumber(hints.answer.value) !== null
    ? "numbers"
    : null;
}
// Reference answer for a problem, labelled by how far it can be trusted.
export function referenceFor(
  hints: Hints,
  given: string | null,
  claims: Claims | null = null,
  problem = "",
  key: string | null = null,
): Reference | null {
  if (!hints.complete) return null;
  let computed: number | null = null;
  if (hints.expression && !claims && !CALCULUS.test(problem))
    try {
      computed = evaluateNumber(mathText(hints.expression), {});
    } catch {
      computed = null;
    }
  const conflict = (value: string, who: string) => {
    const stated = parseNumber(value);
    return computed !== null && stated !== null && !sameNumber(computed, stated)
      ? `按算式 ${hints.expression} 验算得 ${formatNumber(computed)}，与${who}的答案不一致，请再核对。`
      : "";
  };
  const disputed =
    claims?.state === "conflict"
      ? `程序核对和这个答案不一致：${claims.findings.join("；")}`
      : "";
  // a learner's answer the program disagrees with is disputed like a
  // model's one; judging it would mark right answers wrong (report B).
  if (given) {
    const against = conflict(given, "你提供") || (disputed ? `${disputed}。请再核对。` : "");
    return against
      ? { value: given, source: "user", disputed: true, note: `${against}这次先不按它判对错。` }
      : { value: given, source: "user", note: hints.note };
  }
  if (claims?.state === "pass")
    return {
      value: hints.finalAnswer,
      source: "rule",
      check: checkedText(claims),
      ...(key ? { key } : {}),
    };
  if (disputed)
    return {
      value: hints.finalAnswer,
      source: "ai",
      disputed: true,
      note: `${disputed}。这个答案可能有误，判题时不作依据。`,
    };
  const stated = parseNumber(hints.finalAnswer);
  if (computed !== null && stated !== null && sameNumber(computed, stated))
    return {
      value: hints.finalAnswer,
      source: "rule",
      check: `${hints.expression} = ${formatNumber(computed)}`,
    };
  const drift = conflict(hints.finalAnswer, " AI 给出");
  return drift
    ? { value: hints.finalAnswer, source: "ai", disputed: true, note: `${drift}这次先不按它判对错。` }
    : { value: hints.finalAnswer, source: "ai", note: hints.note };
}
// Program comparison for maths answers the number rule cannot read: constants
// written in LaTeX (\frac{9}{2} = 4.5), equal functions, and indefinite integrals
// (equal up to a constant; the learner has to write the constant as well).
// Anything it cannot settle is left to Jev.
const WITH_C = /\+\s*[Cc](?:_?\d)?\s*$/;
export function mathEquivalent(
  reference: string,
  answer: string,
): boolean | null {
  if (WITH_C.test(reference.trim())) {
    const same = sameAntiderivative(reference, answer);
    if (same === null) return null;
    return same && WITH_C.test(answer.trim());
  }
  if (sameConstant(reference, answer) === true) return true;
  if (sameFunction(reference, answer) === true) return true;
  return null;
}
export function oppositeSign(reference: string, answer: string) {
  // Zero has no sign; integrals are left to missingConstant.
  if (WITH_C.test(reference.trim()) || sameConstant(reference, "0") === true)
    return false;
  const minus = `-(${answer.replace(/\$/g, "")})`;
  return (
    sameConstant(reference, minus) === true ||
    sameFunction(reference, minus) === true
  );
}
export function missingConstant(reference: string, answer: string) {
  return (
    WITH_C.test(reference.trim()) &&
    !WITH_C.test(answer.trim()) &&
    sameAntiderivative(reference, answer) === true
  );
}
export class StudyService {
  constructor(
    private readonly store: SqliteStore,
    private readonly materials: MaterialService,
    private readonly llm: LlmClient,
    private readonly jev: Jev,
    private readonly mistakes?: MistakeService,
    private readonly clock: Clock = businessNow,
  ) {}
  artifact(userId: string, id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM artifacts WHERE id=? AND user_id=?")
      .get(id, userId);
    if (!row) throw new AppError(404, "NOT_FOUND", "内容不存在或已删除");
    return toArtifact(row);
  }
  latest(materialId: string, kind: ArtifactKind, version: number) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM artifacts WHERE material_id=? AND kind=? AND version=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(materialId, kind, version);
    return row ? toArtifact(row) : undefined;
  }
  private save(
    owner: {
      userId: string;
      materialId: string;
      version: number;
      jobId: string | null;
    },
    kind: ArtifactKind,
    data: unknown,
  ) {
    const id = newId("art");
    this.store.db
      .prepare(
        "INSERT INTO artifacts(id,user_id,material_id,version,kind,job_id,data,state,created_at) VALUES(?,?,?,?,?,?,?,'{}',?)",
      )
      .run(
        id,
        owner.userId,
        owner.materialId,
        owner.version,
        kind,
        owner.jobId,
        JSON.stringify(data),
        this.clock().toISOString(),
      );
    return id;
  }
  private owner(job: Job, version = job.version!) {
    return {
      userId: job.userId,
      materialId: job.materialId!,
      version,
      jobId: job.id,
    };
  }
  // The model that actually answered wins over the first configured one, which
  // may have been skipped by failover.
  private stamp(data: object) {
    return { model: this.llm.model, ...data, prompt: PROMPT_VERSION };
  }
  setState(artifact: Artifact, patch: Record<string, unknown>) {
    const state = { ...artifact.state, ...patch };
    this.store.db
      .prepare("UPDATE artifacts SET state=? WHERE id=?")
      .run(JSON.stringify(state), artifact.id);
    return state;
  }
  // The exact version the job was created for, even if the text moved on since.
  private source(job: Job, version = job.version!) {
    try {
      const material = this.materials.own(job.userId, job.materialId!);
      const found = this.materials.version(material.id, version);
      if (found) return { material, version: found };
    } catch {
      // Deleted meanwhile; reported below.
    }
    throw new JobError(
      "SOURCE_MISSING",
      "资料已删除或内容已变化，请刷新后重试",
    );
  }
  // Generation needs proofread, confirmed text.
  ready(userId: string, materialId: string, kind?: Material["kind"]) {
    const material = this.materials.own(userId, materialId);
    if (material.status !== "confirmed" || material.currentVersion < 1)
      throw new AppError(409, "NOT_CONFIRMED", "这份内容还没确认，先看看认得对不对");
    if (kind && material.kind !== kind)
      throw new AppError(
        400,
        "WRONG_KIND",
        kind === "problem"
          ? "只有题目可以使用这个功能"
          : "只有资料可以使用这个功能",
      );
    return material;
  }
  private generate(
    kind: ArtifactKind,
    build: (job: Job) => Prompt,
    shape: (data: unknown, job: Job) => object = (data) => data as object,
  ): JobHandler {
    return {
      quota: "ai",
      run: async (job, signal) => {
        const { messages, schema } = build(job);
        const { data, usage } = await this.llm.json(messages, schema, signal);
        return { output: { ...shape(data, job), model: usage.model }, usage };
      },
      commit: (job, output) => ({
        artifactId: this.save(
          this.owner(job),
          kind,
          this.stamp(output as object),
        ),
      }),
    };
  }
  handlers(): Record<string, JobHandler> {
    return {
      explain: this.generate("explain", (job) => {
        const { material, version } = this.source(job);
        return explainPrompt(material.title, version.paragraphs);
      }),
      ask: this.generate(
        "answer",
        (job) => {
          const { material, version } = this.source(job);
          return askPrompt(
            material.title,
            version.paragraphs,
            String(job.params.question),
          );
        },
        (data, job) => ({ question: job.params.question, ...(data as object) }),
      ),
      quiz: this.generate("quiz", (job) => {
        const { material, version } = this.source(job);
        return quizPrompt(material.title, version.paragraphs);
      }),
      hints: {
        quota: "ai",
        run: async (job, signal) => {
          const usage: LlmUsage[] = [];
          const { version } = this.source(job);
          const output = await this.makeHints(
            version.text,
            version.answer,
            signal,
            usage,
          );
          return { output, usage };
        },
        commit: (job, output) => ({
          artifactId: this.save(
            this.owner(job),
            "hints",
            this.stamp(output as object),
          ),
        }),
      },
      variant: {
        quota: "ai",
        run: (job, signal) => this.planVariant(job, signal),
        commit: (job, output) => {
          const { variant, hints } = output as {
            variant: object;
            hints?: HintsData;
          };
          this.keepHints(job, job.version!, hints);
          return {
            artifactId: this.save(this.owner(job), "variant", variant),
          };
        },
      },
      feedback: {
        quota: "ai",
        run: (job, signal) => this.judge(job, signal),
        commit: (job, output) =>
          this.commitFeedback(job, output as FeedbackOutput),
      },
    };
  }
  // Stored hints for this version, or freshly generated ones (saved on commit).
  private async hintsFor(
    job: Job,
    version: number,
    signal: AbortSignal,
    usage: LlmUsage[],
  ) {
    const stored = this.latest(job.materialId!, "hints", version);
    if (stored)
      return { hints: stored.data as unknown as HintsData, fresh: false };
    const source = this.source(job, version).version;
    const hints = await this.makeHints(
      source.text,
      source.answer,
      signal,
      usage,
    );
    return { hints, fresh: true };
  }
  // Hints whose answer the program checks. When the program disagrees, the model
  // gets one more try with reasoning on; if it still disagrees (or the second try
  // drops its checks) the answer is kept but marked as disputed.
  private async makeHints(
    text: string,
    given: string | null,
    signal: AbortSignal,
    usage: LlmUsage[],
  ): Promise<HintsData> {
    const { messages, schema } = hintsPrompt(text, given);
    const first = await this.llm.json(messages, schema, signal);
    usage.push(first.usage);
    let hints: Hints = first.data;
    let model = first.usage.model;
    // A learner's own answer is the reference; whichever it is, it has to say
    // what the program's checks confirmed (V4.2: the learner's too).
    const settle = async (h: Hints, c: Claims | null) =>
      this.settle(text, given || h.finalAnswer, h.checks, c);
    let { claims, key } = await settle(
      hints,
      hints.complete ? await checkClaims(hints.checks, text, this.jev) : null,
    );
    if (claims?.state === "conflict")
      try {
        const again = await this.llm.json(
          [
            ...messages,
            { role: "assistant", content: JSON.stringify(first.data) },
            hintsRecheck(claims.findings),
          ],
          schema,
          signal,
          { scenario: "recheck" },
        );
        usage.push(again.usage);
        const second = again.data.complete
          ? await checkClaims(again.data.checks, text, this.jev)
          : null;
        if (second) {
          hints = again.data;
          model = again.usage.model;
          ({ claims, key } = await settle(again.data, second));
        }
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        const spent = (error as { usage?: LlmUsage }).usage;
        if (spent) usage.push(spent);
      }
    return {
      ...hints,
      model,
      answer: referenceFor(hints, given, claims, text, key),
    };
  }
  // Hints generated as a side effect are kept unless some were stored meanwhile.
  private keepHints(job: Job, version: number, fresh?: HintsData) {
    const stored = this.latest(job.materialId!, "hints", version);
    if (stored || !fresh) return stored;
    const id = this.save(this.owner(job, version), "hints", this.stamp(fresh));
    return this.artifact(job.userId, id);
  }
  private async planVariant(job: Job, signal: AbortSignal) {
    const source = this.source(job).version;
    const usage: LlmUsage[] = [];
    const { hints, fresh } = await this.hintsFor(
      job,
      job.version!,
      signal,
      usage,
    );
    const extra = fresh ? { hints } : {};
    if (!hints.complete || !hints.answer)
      throw new JobError(
        "PROBLEM_INCOMPLETE",
        "题目条件不完整，补全后才能出同类题",
      );
    // Calculus answers are confirmed by the program one new problem at a time.
    if (CALCULUS.test(source.text) || hints.checks?.length)
      return {
        output: {
          ...extra,
          variant: this.stamp(
            await this.checkedVariant(job, source.text, signal, usage),
          ),
        },
        usage,
      };
    const { messages, schema } = variantPrompt(
      source.text,
      hints.answer.value,
      hints.expression,
    );
    const planned = await this.llm.json(messages, schema, signal);
    usage.push(planned.usage);
    const plan: VariantPlan = planned.data;
    // Without a computable answer there is nothing to confirm a new problem by.
    if (!plan.numeric)
      throw Object.assign(
        new JobError(
          "VARIANT_UNRELIABLE",
          "这道题的答案没法用程序核对，暂时不出同类题",
        ),
        { usage },
      );
    try {
      const template = checkTemplate({
        text: plan.template,
        vars: plan.vars,
        answer: mathText(plan.answer),
        constraints: plan.constraints,
        unit: plan.unit || undefined,
      });
      // Fed the original numbers, the template must reproduce the original answer.
      const expected = parseNumber(hints.answer.value);
      if (
        expected === null ||
        !sameNumber(evaluateNumber(template.answer, plan.original), expected)
      )
        throw new Error("template does not reproduce the original answer");
      return {
        output: {
          ...extra,
          variant: this.stamp(this.drawVariant(template, plan.original)),
        },
        usage,
      };
    } catch (error) {
      throw Object.assign(
        new JobError(
          "VARIANT_UNRELIABLE",
          "这次没能生成可靠的同类题，请再试一次",
        ),
        { usage, cause: error },
      );
    }
  }
  // A new problem of the same kind whose answer the program confirmed.
  private async checkedVariant(
    job: Job,
    problem: string,
    signal: AbortSignal,
    usage: LlmUsage[],
  ): Promise<VariantData> {
    const last = this.latest(job.materialId!, "variant", job.version!);
    const avoid = last
      ? [String((last.data as { question?: unknown }).question ?? "")]
      : [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { messages, schema } = similarPrompt(
        problem,
        avoid.filter(Boolean),
      );
      let made;
      try {
        made = await this.llm.json(messages, schema, signal);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        const spent = (error as { usage?: LlmUsage }).usage;
        if (spent) usage.push(spent);
        continue;
      }
      usage.push(made.usage);
      const { claims, key } = await this.settle(
        made.data.question,
        made.data.answer,
        made.data.checks,
        await checkClaims(made.data.checks, made.data.question, this.jev),
      );
      if (claims?.state !== "pass") continue;
      return {
        question: made.data.question,
        answer: made.data.answer,
        ...(key ? { key } : {}),
        source: "rule",
        check: checkedText(claims),
        solution: made.data.solution,
      };
    }
    throw Object.assign(
      new JobError(
        "VARIANT_UNRELIABLE",
        "这次没能出一道答案经过核对的同类题，请再试一次",
      ),
      { usage },
    );
  }
  drawVariant(
    template: VariantTemplate,
    original: Record<string, number>,
  ): VariantData {
    const sample = sampleVariant(template, { avoid: original });
    const values = Object.entries(sample.values)
      .map(([name, value]) => `${name}=${formatNumber(value, 6)}`)
      .join("，");
    return {
      question: sample.text,
      answer: `${sample.answerText}${template.unit ? ` ${unitText(template.unit)}` : ""}`,
      source: "rule",
      check: `按 ${template.answer} 计算（${values}），得 ${sample.answerText}`,
      template,
      original,
    };
  }
  // New numbers from the last numeric template, without another model call.
  redrawVariant(userId: string, material: Material) {
    const last = this.latest(material.id, "variant", material.currentVersion);
    const data = last?.data as
      | (VariantData & { model?: string; prompt?: string })
      | undefined;
    if (!last || !data?.template || !data.original) return undefined;
    let drawn: VariantData;
    try {
      drawn = this.drawVariant(data.template, data.original);
    } catch {
      return undefined;
    }
    return this.save(
      {
        userId,
        materialId: material.id,
        version: last.version,
        jobId: last.jobId,
      },
      "variant",
      { ...drawn, model: data.model, prompt: data.prompt },
    );
  }
  private attemptRows(where: string, ...args: string[]) {
    return (
      this.store.db
        .prepare(
          `SELECT a.*,j.status AS job_status,j.error_code,j.error_message FROM attempts a LEFT JOIN jobs j ON j.id=a.job_id WHERE ${where} ORDER BY a.created_at DESC,a.rowid DESC LIMIT 20`,
        )
        .all(...args) as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      artifactId: (row.artifact_id as string | null) ?? null,
      jobId: (row.job_id as string | null) ?? null,
      item: Number(row.item),
      version: Number(row.version),
      answer: String(row.answer),
      status: row.result ? "done" : String(row.job_status ?? "unknown"),
      error:
        !row.result && row.error_code
          ? {
              code: String(row.error_code),
              message: String(row.error_message),
            }
          : null,
      result: row.result
        ? withText(JSON.parse(String(row.result)) as AttemptResult)
        : null,
      createdAt: String(row.created_at),
    }));
  }
  attempt(userId: string, id: string) {
    const found = this.attemptRows("a.id=? AND a.user_id=?", id, userId)[0];
    if (!found) throw new AppError(404, "NOT_FOUND", "作答记录不存在");
    return found;
  }
  // Records an attempt. Quiz choices are judged at once; everything else needs a feedback job.
  submit(
    userId: string,
    materialId: string,
    input: {
      answer: string;
      artifactId?: string;
      item?: number;
      choice?: number;
      clientKey?: string;
    },
  ): { id: string; needsJob: boolean; jobId?: string } {
    // Sent again with the same key (the reply was lost): the first attempt,
    // still being judged or judged, not a second one.
    if (input.clientKey) {
      const kept = this.store.db
        .prepare(
          "SELECT id,job_id FROM attempts WHERE user_id=? AND material_id=? AND client_key=?",
        )
        .get(userId, materialId, input.clientKey) as
        | { id: string; job_id: string | null }
        | undefined;
      if (kept)
        return { id: kept.id, needsJob: false, jobId: kept.job_id ?? undefined };
    }
    const material = this.ready(userId, materialId);
    let version = material.currentVersion;
    let answer = input.answer.trim();
    let result: AttemptResult | null = null;
    let quiz: Artifact | undefined;
    const item = input.item ?? 0;
    if (input.artifactId) {
      const target = this.artifact(userId, input.artifactId);
      if (
        target.materialId !== materialId ||
        !["quiz", "variant"].includes(target.kind)
      )
        throw new AppError(400, "BAD_TARGET", "作答对象不匹配");
      version = target.version;
      if (target.kind === "quiz") {
        quiz = target;
        const question = (target.data as unknown as Quiz).questions[item];
        if (!question) throw new AppError(400, "BAD_TARGET", "题目不存在");
        if (question.type === "choice") {
          const picked = question.options[input.choice ?? -1];
          if (picked === undefined)
            throw new AppError(400, "CHOICE_REQUIRED", "请选择一个选项");
          answer = picked;
          const correct = input.choice === question.answer;
          result = {
            verdict: correct ? "correct" : "incorrect",
            judge: "choice",
            confidence: 1,
            reference: {
              value: question.options[question.answer]!,
              source: "ai",
            },
            cause: null,
            comment: correct
              ? "答对了。"
              : "这个选项不对，看看解析和原文依据。",
            explanation: question.explanation,
            citations: question.citations,
            revealSolution: true,
          };
        }
      }
    } else if (material.kind !== "problem")
      throw new AppError(400, "BAD_TARGET", "资料请从自测题开始作答");
    if (!answer) throw new AppError(400, "ANSWER_REQUIRED", "请先写下你的答案");
    const id = newId("att");
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO attempts(id,user_id,material_id,artifact_id,item,version,answer,result,created_at,client_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          userId,
          materialId,
          input.artifactId ?? null,
          item,
          version,
          answer,
          result ? JSON.stringify(result) : null,
          this.clock().toISOString(),
          input.clientKey ?? null,
        );
      if (result && quiz) this.markAnswered(quiz, item);
    });
    return { id, needsJob: !result };
  }
  linkJob(attemptId: string, jobId: string) {
    this.store.db
      .prepare("UPDATE attempts SET job_id=? WHERE id=?")
      .run(jobId, attemptId);
  }
  // Used when the feedback job could not be queued (e.g. daily limit).
  discardAttempt(attemptId: string) {
    this.store.db.prepare("DELETE FROM attempts WHERE id=?").run(attemptId);
  }
  private markAnswered(quiz: Artifact, item: number) {
    const answered = new Set(
      (quiz.state.answered as number[] | undefined) ?? [],
    );
    answered.add(item);
    this.setState(quiz, { answered: [...answered].sort() });
  }
  private async judge(
    job: Job,
    signal: AbortSignal,
  ): Promise<{ output: FeedbackOutput; usage: LlmUsage[] }> {
    const attempt = this.attempt(job.userId, String(job.params.attemptId));
    const usage: LlmUsage[] = [];
    const empty = {
      cause: null,
      comment: "",
      explanation: "",
      citations: [],
      revealSolution: true,
    };
    if (attempt.artifactId) {
      const target = this.artifact(job.userId, attempt.artifactId);
      if (target.kind === "quiz") {
        const question = (target.data as unknown as Quiz).questions[
          attempt.item
        ];
        if (!question || question.type !== "short")
          throw new JobError("BAD_TARGET", "题目不存在");
        const verdict = await this.equivalent(
          question.stem,
          question.answer,
          attempt.answer,
          signal,
          "points",
        );
        const comment = {
          correct: "答对了，意思到位。",
          incorrect: "和参考要点不一致，对照解析和原文再看看。",
          unsure: "暂时判断不了，请对照参考要点自己检查。",
        }[verdict.verdict];
        return {
          output: {
            result: {
              ...empty,
              ...verdict,
              comment,
              reference: { value: question.answer, source: "ai" },
              explanation: question.explanation,
              citations: question.citations,
            },
          },
          usage,
        };
      }
      const data = target.data as unknown as VariantData;
      const reference: Reference = {
        value: data.answer,
        source: data.source,
        check: data.check,
      };
      const verdict = await this.equivalent(
        data.question,
        data.key ?? data.answer,
        attempt.answer,
        signal,
      );
      const detail = await this.diagnose(
        data.question,
        reference,
        attempt.answer,
        verdict.verdict,
        data.check ?? "",
        signal,
        usage,
      );
      return {
        output: {
          result: {
            ...empty,
            ...verdict,
            ...detail,
            reference,
            explanation: data.check ?? "",
          },
        },
        usage,
      };
    }
    const source = this.source(job, attempt.version).version;
    const { hints, fresh } = await this.hintsFor(
      job,
      attempt.version,
      signal,
      usage,
    );
    const extra = fresh ? { hints } : {};
    if (!hints.complete || !hints.answer)
      return {
        output: {
          ...extra,
          result: {
            ...empty,
            verdict: "unsure",
            judge: "none",
            confidence: null,
            reference: null,
            comment: `题目条件可能不完整：${(hints.missing || "缺少解题需要的条件").replace(/[。.!！?？；;，,\s]+$/u, "")}。请回到原文补全后再作答。`,
          },
        },
        usage,
      };
    const solution = hints.levels[2] ?? "";
    // The program disagreed with the reference: neither "right" nor "wrong" holds.
    if (hints.answer.disputed)
      return {
        output: {
          ...extra,
          result: {
            ...empty,
            verdict: "unsure",
            judge: "none",
            confidence: null,
            reference: hints.answer,
            comment:
              "参考答案没有通过程序核对，这次暂时判断不了对错。可以展开完整解析自己对照，或在“问 AI”里让它重新算一遍。",
            explanation: solution,
          },
        },
        usage,
      };
    const verdict = await this.equivalent(
      source.text,
      hints.answer.key ?? hints.answer.value,
      attempt.answer,
      signal,
    );
    const detail =
      verdict.verdict === "correct"
        ? {
            cause: null,
            comment: `答案与参考答案一致。回顾一下关键一步：${hints.levels[1] ?? ""}`,
          }
        : await this.diagnose(
            source.text,
            hints.answer,
            attempt.answer,
            verdict.verdict,
            solution,
            signal,
            usage,
            // A hidden result shows fixed guidance, so skip the feedback model.
            this.opensSolution(job, attempt.id, verdict.verdict),
          );
    return {
      output: {
        ...extra,
        result: {
          ...empty,
          ...verdict,
          ...detail,
          reference: hints.answer,
          explanation: solution,
        },
      },
      usage,
    };
  }
  // An answer judged outside a material, against a known answer (a similar
  // problem in the chat): the same comparison, without a job or feedback.
  judgeAnswer(
    question: string,
    reference: string,
    answer: string,
    beforeRemote?: () => void,
  ) {
    return this.equivalent(
      question,
      reference,
      answer,
      new AbortController().signal,
      "answer",
      beforeRemote,
    );
  }
  // Whether an answer says what its checks confirmed: the model can put the
  // right value in its checks and a wrong one in its answer. With
  // one check that states an answer the program compares the two, and that
  // answer is the key to judge by; "none" and "inf" are check tokens, not
  // answers anyone writes, so those and the rest (extrema, intervals) go to Jev.
  async agreement(
    question: string,
    answer: string,
    raw: unknown[],
    items: ClaimItem[],
  ): Promise<{ state: Verdict; key: string | null }> {
    try {
      const keyed = raw
        .map((c) => parseCheck(c))
        .filter(
          (c) =>
            c !== null &&
            "answer" in c &&
            !/^(?:[+-]?inf|none)$/i.test(c.answer.trim()),
        );
      if (keyed.length === 1 && "answer" in keyed[0]!) {
        const c = keyed[0];
        const anti = c.kind === "antiderivative";
        const key = anti ? `${c.answer} + C` : c.answer;
        // "y' = …" and "\lim … = 9/2" give their right-hand side.
        let shown = answer.replace(/\$/g, "").split("=").pop()!.trim();
        if (anti && !WITH_C.test(shown)) shown += " + C";
        const { verdict } = await this.judgeAnswer(question, key, shown);
        return { state: verdict, key: verdict === "correct" ? key : null };
      }
      if (!this.jev.configured) return { state: "unsure", key: null };
      const yes = await this.jev.noul(
        {
          question,
          answer,
          checks: JSON.stringify(raw),
          checked: items
            .map(
              (i) =>
                `${i.tex}：${i.detail}${i.computed ? `（程序结果 ${i.computed}）` : ""}`,
            )
            .join("\n"),
        },
        "给出的最终答案，和程序核对得出的结论是否一致、没有矛盾？",
      );
      const state: Verdict =
        yes >= 0.7 ? "correct" : yes <= 0.3 ? "incorrect" : "unsure";
      return { state, key: null };
    } catch {
      return { state: "unsure", key: null };
    }
  }
  // Passed claims, settled against the answer stated with them. A disagreement
  // is a conflict, so the model gets its second look; doubt leaves nothing
  // confirmed.
  async settle(
    question: string,
    answer: string,
    raw: unknown[],
    claims: Claims | null,
  ): Promise<{ claims: Claims | null; key: string | null }> {
    if (claims?.state !== "pass" || !answer.trim())
      return { claims, key: null };
    const { state, key } = await this.agreement(
      question,
      answer,
      raw,
      claims.items,
    );
    if (state === "correct") return { claims, key };
    const mark = (status: ClaimItem["status"], detail: string) =>
      claims.items.map((i) =>
        i.status === "pass" ? { ...i, status, detail } : i,
      );
    if (state === "incorrect")
      return {
        claims: {
          state: "conflict",
          items: mark("fail", `写出的答案 ${answer} 和程序核对的结果不一致`),
          findings: [`最终答案 ${answer} 和程序核对的结果不一致`],
        },
        key: null,
      };
    return {
      claims: {
        state: "unverified",
        items: mark(
          "unknown",
          "写出的答案和程序核对的结果是否一致，暂时确认不了",
        ),
        findings: [],
      },
      key: null,
    };
  }
  // Compare unambiguous numeric answers locally; preserve units and prose for Jev.
  private async equivalent(
    question: string,
    reference: string,
    answer: string,
    signal: AbortSignal,
    mode: "answer" | "points" = "answer",
    beforeRemote?: () => void,
  ): Promise<Pick<AttemptResult, "verdict" | "judge" | "confidence">> {
    const numeric =
      mode === "answer" ? compareNumericAnswers(reference, answer) : null;
    if (numeric !== null)
      return {
        verdict: numeric ? "correct" : "incorrect",
        judge: "rule",
        confidence: 1,
      };
    const maths = mode === "answer" ? mathEquivalent(reference, answer) : null;
    if (maths !== null)
      return {
        verdict: maths ? "correct" : "incorrect",
        judge: "rule",
        confidence: 1,
      };
    if (!this.jev.configured)
      return { verdict: "unsure", judge: "none", confidence: null };
    beforeRemote?.();
    const yes = await this.jev.noul(
      { question, reference, answer },
      mode === "points"
        ? "学生的回答是否表达出了参考要点的主要意思？措辞不同但意思对也算。"
        : "学生的最终答案与参考答案是否等价？必须结合题目检查数值、单位、方向和适用条件。不同量级单位必须换算后比较，不能只比较数字，例如 1 升等于 1000 毫升，但不等于 1 毫升。否定、方向相反或条件不同不算等价；只允许不改变含义的书写差异。",
      signal,
    );
    const verdict: Verdict =
      yes >= 0.7 ? "correct" : yes <= 0.3 ? "incorrect" : "unsure";
    return {
      verdict,
      judge: "jev",
      confidence: verdict === "incorrect" ? 1 - yes : yes,
    };
  }
  private async diagnose(
    question: string,
    reference: Reference,
    answer: string,
    verdict: Verdict,
    solution: string,
    signal: AbortSignal,
    usage: LlmUsage[],
    explain = true,
  ): Promise<Pick<AttemptResult, "cause" | "comment">> {
    if (verdict === "correct") return { cause: null, comment: "答对了。" };
    let cause: AttemptResult["cause"] = null;
    if (
      verdict === "incorrect" &&
      missingConstant(reference.key ?? reference.value, answer)
    )
      cause = MISSING_C;
    else if (
      verdict === "incorrect" &&
      oppositeSign(reference.key ?? reference.value, answer)
    )
      cause = WRONG_SIGN;
    else if (verdict === "incorrect" && this.jev.configured) {
      const pick = await this.jev.choice(
        { question, reference: reference.value, answer },
        "学生这次答错了，现有作答能支持哪一种可能原因？如果只收到最终答案，不能据此断言中间用了什么方法或算错了哪一步；证据不足时必须选 other，不要猜测学生的计算过程。",
        Object.fromEntries(
          Object.entries(CAUSES).map(([key, [, rule]]) => [key, rule]),
        ),
        signal,
      );
      const label = CAUSES[pick.choice]?.[0];
      if (label && pick.choice !== "other" && pick.confidence >= 0.5)
        cause = { key: pick.choice, label, confidence: pick.confidence };
    }
    if (!explain) return { cause, comment: hiddenGuidance(cause) };
    if (!this.llm.configured)
      return {
        cause,
        comment: cause
          ? `可能的原因：${cause.label}。对照提示再想一想。`
          : "对照提示再想一想。",
      };
    const { messages, schema } = feedbackPrompt({
      question,
      reference: reference.value,
      answer,
      cause: cause?.label ?? null,
      solution,
    });
    const result = await this.llm.json(messages, schema, signal);
    usage.push(result.usage);
    return { cause, comment: result.data.comment };
  }
  private commitFeedback(job: Job, output: FeedbackOutput) {
    const attempt = this.attempt(job.userId, String(job.params.attemptId));
    const result = { ...output.result };
    const hints = this.keepHints(job, attempt.version, output.hints);
    if (attempt.artifactId) {
      const target = this.artifact(job.userId, attempt.artifactId);
      if (target.kind === "quiz") this.markAnswered(target, attempt.item);
      else this.setState(target, { revealed: 1 });
    } else {
      result.revealSolution = this.opensSolution(
        job,
        attempt.id,
        result.verdict,
      );
      if (!result.revealSolution) {
        // Gate the stored result, even if the feedback model disclosed the answer.
        // Missing-condition messages have no reference and must remain visible.
        if (result.reference) result.comment = hiddenGuidance(result.cause);
        result.explanation = "";
        result.reference = null;
      } else if (hints) this.setState(hints, { revealed: 3 });
    }
    this.store.db
      .prepare("UPDATE attempts SET result=? WHERE id=?")
      .run(JSON.stringify(result), attempt.id);
    // An answer to the problem itself (not to a generated item) feeds the 错题本.
    if (!attempt.artifactId)
      this.mistakes?.judged(
        job.userId,
        job.materialId!,
        attempt.answer,
        result.verdict,
        result.cause?.label ?? null,
        undefined,
        attempt.version,
      );
    return { attemptId: attempt.id, verdict: result.verdict };
  }
  // Probe first: the full solution opens after a correct answer, two wrong ones,
  // or once the learner has opened the last hint level anyway.
  private opensSolution(job: Job, attemptId: string, verdict: Verdict) {
    const attempt = this.attempt(job.userId, attemptId);
    const earlier = (
      this.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM attempts WHERE material_id=? AND version=? AND artifact_id IS NULL AND id<>? AND json_extract(result,'$.verdict')='incorrect'",
        )
        .get(job.materialId!, attempt.version, attemptId) as { n: number }
    ).n;
    const hints = this.latest(job.materialId!, "hints", attempt.version);
    return (
      verdict === "correct" ||
      earlier + (verdict === "incorrect" ? 1 : 0) >= 2 ||
      Number(hints?.state.revealed ?? 0) >= 3
    );
  }
  // Hints open level by level; a variant's answer opens on request.
  reveal(userId: string, artifactId: string, level: number) {
    const artifact = this.artifact(userId, artifactId);
    if (artifact.kind !== "hints" && artifact.kind !== "variant")
      throw new AppError(400, "BAD_TARGET", "这项内容不需要展开");
    const max = artifact.kind === "hints" ? 3 : 1;
    const revealed = Math.min(
      max,
      Math.max(Number(artifact.state.revealed ?? 0), level),
    );
    const state = this.setState(artifact, { revealed });
    const material = this.materials.own(userId, artifact.materialId);
    return this.view({ ...artifact, state }, material.currentVersion);
  }
  report(userId: string, artifactId: string, reason: string, note?: string) {
    this.artifact(userId, artifactId);
    this.store.db
      .prepare(
        "INSERT INTO reports(id,user_id,artifact_id,reason,note,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        newId("rep"),
        userId,
        artifactId,
        reason,
        note ?? null,
        this.clock().toISOString(),
      );
  }
  // Answers stay hidden until the learner has tried or asked for them.
  view(artifact: Artifact, currentVersion: number) {
    const revealed = Number(artifact.state.revealed ?? 0);
    let data: Record<string, unknown> = artifact.data;
    if (artifact.kind === "hints") {
      const hints = artifact.data as unknown as HintsData;
      data = {
        complete: hints.complete,
        missing: hints.missing,
        levels: hints.levels.slice(0, revealed),
        levelCount: hints.levels.length,
        answer: revealed >= 3 ? hints.answer : null,
        variant: variantKind(hints),
      };
    } else if (artifact.kind === "quiz") {
      const answered = new Set(
        (artifact.state.answered as number[] | undefined) ?? [],
      );
      data = {
        questions: (artifact.data as unknown as Quiz).questions.map((q, i) => {
          if (answered.has(i)) return q;
          const { answer: _answer, explanation: _explanation, ...open } = q;
          return open;
        }),
      };
    } else if (artifact.kind === "variant") {
      const variant = artifact.data as unknown as VariantData;
      data = {
        question: variant.question,
        ...(revealed
          ? {
              answer: variant.answer,
              source: variant.source,
              check: variant.check,
              ...(variant.solution ? { solution: variant.solution } : {}),
            }
          : {}),
      };
    }
    return {
      id: artifact.id,
      kind: artifact.kind,
      version: artifact.version,
      stale: artifact.version < currentVersion,
      data,
      state: artifact.state,
      createdAt: artifact.createdAt,
    };
  }
  state(userId: string, materialId: string) {
    const detail = this.materials.detail(userId, materialId);
    const all = (
      this.store.db
        .prepare(
          "SELECT * FROM artifacts WHERE material_id=? ORDER BY created_at,rowid",
        )
        .all(materialId) as Record<string, unknown>[]
    ).map(toArtifact);
    const show = (a: Artifact | undefined) =>
      a ? this.view(a, detail.version) : null;
    const last = (kind: ArtifactKind) =>
      all.filter((a) => a.kind === kind).at(-1);
    // Latest job per kind, so a reopened page can resume waiting.
    const jobs: Record<string, ReturnType<typeof publicJob>> = {};
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM jobs WHERE material_id=? AND kind IN ('explain','ask','quiz','hints','variant') ORDER BY created_at,rowid",
      )
      .all(materialId) as Record<string, unknown>[])
      jobs[String(row.kind)] = publicJob(toJob(row));
    const review = this.store.db
      .prepare("SELECT box,due_on FROM reviews WHERE material_id=?")
      .get(materialId) as { box: number; due_on: string } | undefined;
    return {
      material: detail,
      mapPoint:
        this.mistakes?.forMaterial(userId, materialId)?.mapPoint ?? null,
      explain: show(last("explain")),
      answers: all
        .filter((a) => a.kind === "answer")
        .map((a) => this.view(a, detail.version)),
      quiz: show(last("quiz")),
      hints: show(last("hints")),
      variant: show(last("variant")),
      attempts: this.attemptRows("a.material_id=?", materialId),
      jobs,
      review: review ? { box: review.box, dueOn: review.due_on } : null,
    };
  }
}
