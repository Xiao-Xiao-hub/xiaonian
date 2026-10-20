/*
 * 学习地图接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 公开地图和题库可供游客读取；涉及个人进度或写操作时通过 auth 取用户，状态转换由 LearnService 负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { Block, MarkdownRenderer } from "../render/markdown.js";
import { INK, toneSchema } from "../render/routes.js";
import { MAX_INPUT } from "./judge.js";
import { MAX_PARTS, MAX_TOTAL_INPUT } from "./answers.js";
import { MAP_CARDS } from "./map-cards.js";
import { bankProblem, type BankProblem } from "./bank.js";
import { BANK } from "./problems.js";
import type { LearnService } from "./service.js";
type Tone = keyof typeof INK;
type CardBlocks = { formulaBlocks: Block[][]; keyBlocks: Block[][] };
const idParams = z.object({ id: z.string().min(1).max(64) });
const pointIdSchema = z.string().min(1).max(64);
const problemIndex = z.number().int().min(0).max(100).optional();
const prediction = z.enum(["yes", "unsure", "no"]);
const answerInput = z.union([
  z.string().min(1).max(MAX_INPUT),
  z
    .array(z.string().min(1).max(MAX_INPUT))
    // One item: a single-choice problem.
    .min(1)
    .max(MAX_PARTS)
    .refine(
      (parts) =>
        parts.reduce((n, part) => n + part.length, 0) <= MAX_TOTAL_INPUT,
    ),
]);
export function registerLearnRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    learn: LearnService;
    markdown: MarkdownRenderer;
    // How long rendered card blocks are reused before they are drawn again.
    cardTtlMs?: number;
    // Render both tones' cards in the background soon after start; off under
    // `node --test`.
    prewarm?: boolean;
  },
) {
  const { auth, learn, markdown } = deps;
  const cardTtlMs = deps.cardTtlMs ?? 12 * 3600_000;
  // TeX from the judge, shown as one inline formula.
  const formula = (tex: string | null | undefined, ink: string) =>
    tex ? markdown.render(`$${tex.trim()}$`, ink) : null;
  // V4 card blocks of one point per tone. They expire, so the formulas go
  // through render again now and then: that keeps their images clear of the
  // daily prune, and draws one again if it was pruned anyway.
  const cardCache = new Map<string, { at: number; blocks: Promise<CardBlocks> }>();
  const cardOf = (id: string, tone: Tone) => {
    const cacheKey = `${tone}:${id}`;
    const hit = cardCache.get(cacheKey);
    let found = hit && Date.now() - hit.at < cardTtlMs ? hit.blocks : undefined;
    if (!found) {
      const card = MAP_CARDS[id];
      if (!card) return Promise.resolve(undefined);
      found = (async () => {
        const formulaBlocks: Block[][] = [];
        for (const tex of card.formulas)
          formulaBlocks.push((await formula(tex, INK[tone]))!);
        const keyBlocks: Block[][] = [];
        for (const key of card.keys)
          keyBlocks.push(await markdown.render(key, INK[tone]));
        return { formulaBlocks, keyBlocks };
      })();
      const entry = { at: Date.now(), blocks: found };
      found.catch(() => {
        if (cardCache.get(cacheKey) === entry) cardCache.delete(cacheKey);
      });
      cardCache.set(cacheKey, entry);
    }
    return found;
  };
  const cardBlocks = async (tone: Tone) => {
    const out = new Map<string, CardBlocks>();
    for (const id of Object.keys(MAP_CARDS)) out.set(id, (await cardOf(id, tone))!);
    return out;
  };
  // The first ?cards=1 of a tone takes about 2 s of formula drawing; do it
  // before anyone asks, one tone after the other.
  if (deps.prewarm ?? !process.env.NODE_TEST_CONTEXT) {
    const warm = setTimeout(() => {
      (async () => {
        for (const tone of Object.keys(INK) as Tone[]) await cardBlocks(tone);
        await warmBank();
      })().catch((error: unknown) =>
        app.log.warn({ err: error }, "map card prewarm failed"),
      );
    }, 10_000);
    warm.unref();
    app.addHook("onClose", async () => clearTimeout(warm));
  }
  const withCards = async <
    T extends { chapters: { points: { id: string }[] }[] },
  >(
    map: T,
    tone: Tone,
  ) => {
    const blocks = await cardBlocks(tone);
    return {
      ...map,
      chapters: map.chapters.map((chapter) => ({
        ...chapter,
        points: chapter.points.map((point) => ({
          ...point,
          ...blocks.get(point.id)!,
        })),
      })),
    };
  };
  // ---- 0.6.0 题库  ---------------------------------------------------
  // Rendered bank blocks, reused like the cards: TTL'd so the formula images
  // stay clear of the daily prune; a failed render is dropped and redrawn.
  const blockCache = new Map<string, { at: number; value: Promise<unknown> }>();
  const cached = <T>(key: string, make: () => Promise<T>): Promise<T> => {
    const hit = blockCache.get(key);
    if (hit && Date.now() - hit.at < cardTtlMs) return hit.value as Promise<T>;
    const value = make();
    const entry = { at: Date.now(), value };
    value.catch(() => {
      if (blockCache.get(key) === entry) blockCache.delete(key);
    });
    blockCache.set(key, entry);
    return value;
  };
  const md = (text: string, tone: Tone) => markdown.render(text, INK[tone]);
  const problemBlocks = (problem: BankProblem, pointId: string, tone: Tone) =>
    cached(`p:${tone}:${pointId}:${problem.index}`, async () => {
      const questions = [];
      for (const question of problem.questions ?? []) {
        const options = [];
        for (const option of question.options)
          options.push({ ...option, blocks: await md(option.text, tone) });
        questions.push({
          ...question,
          blocks: question.prompt ? await md(question.prompt, tone) : [],
          options,
        });
      }
      return {
        ...problem,
        blocks: await md(problem.text, tone),
        ...(problem.questions ? { questions } : {}),
      };
    });
  const solutionBlocks = (
    pointId: string,
    index: number,
    solution: {
      correct: { options: string[] | null; text: string };
      explanation: string | null;
    },
    tone: Tone,
  ) =>
    cached(`s:${tone}:${pointId}:${index}`, async () => ({
      correct: {
        options: solution.correct.options,
        blocks: await md(solution.correct.text, tone),
      },
      explanation: solution.explanation
        ? await md(solution.explanation, tone)
        : null,
    }));
  // The static half of a detail page: intro, formulas with notes, keys and
  // the worked example, rendered.
  const detailBlocks = (
    detail: ReturnType<LearnService["detail"]>,
    tone: Tone,
  ) =>
    cached(`d:${tone}:${detail.id}`, async () => {
      const card = await cardOf(detail.id, tone);
      const formulas = [];
      for (const [i, formula] of detail.formulas.entries())
        formulas.push({
          tex: formula.tex,
          blocks: card!.formulaBlocks[i]!,
          note: formula.note,
          noteBlocks: await md(formula.note, tone),
        });
      return {
        intro: await md(detail.intro, tone),
        formulas,
        keys: detail.keys.map((text, i) => ({
          text,
          blocks: card!.keyBlocks[i]!,
        })),
        example: detail.example
          ? {
              problem: await problemBlocks(
                detail.example.problem,
                detail.id,
                tone,
              ),
              solution: await solutionBlocks(
                detail.id,
                detail.example.problem.index,
                detail.example,
                tone,
              ),
            }
          : null,
      };
    });
  const renderDetail = async (
    detail: ReturnType<LearnService["detail"]>,
    tone: Tone,
  ) => {
    const { intro, formulas, keys, example, ...rest } = detail;
    const blocks = await detailBlocks(detail, tone);
    return { ...rest, introText: intro, ...blocks };
  };
  // After the cards: every bank problem and detail page of both tones, one
  // after the other, so the first 练题 page does not wait for its formulas.
  const warmBank = async () => {
    for (const tone of Object.keys(INK) as Tone[])
      for (const pointId of Object.keys(MAP_CARDS)) {
        await detailBlocks(learn.detail(undefined, pointId), tone);
        const problems = BANK[pointId] ?? [];
        for (const [index, problem] of problems.entries())
          await problemBlocks(
            bankProblem(problem, index, problems.length),
            pointId,
            tone,
          );
      }
  };
  app.get("/v1/learn/bank", async (req) => {
    const user = auth.require(req);
    z.object({ tone: toneSchema }).passthrough().parse(req.query);
    return { data: learn.bank(user.id) };
  });
  app.get(
    "/v1/learn/bank/public",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async () => ({ data: learn.bank() }),
  );
  app.get("/v1/learn/points/:id/detail", async (req) => {
    const user = auth.require(req);
    const { tone } = z.object({ tone: toneSchema }).passthrough().parse(req.query);
    const id = idParams.parse(req.params).id;
    return { data: await renderDetail(learn.detail(user.id, id), tone) };
  });
  app.post("/v1/learn/points/:id/example-shown", async (req) => {
    const user = auth.require(req);
    const id = idParams.parse(req.params).id;
    return { data: learn.exampleShown(user.id, id) };
  });
  app.get(
    "/v1/learn/points/:id/detail/public",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      const { tone } = z.object({ tone: toneSchema }).passthrough().parse(req.query);
      const id = idParams.parse(req.params).id;
      return { data: await renderDetail(learn.detail(undefined, id), tone) };
    },
  );
  app.get("/v1/learn/points/:id/practice", async (req) => {
    const user = auth.require(req);
    const query = z
      .object({
        index: z.coerce.number().int().min(0).max(100).optional(),
        after: z.coerce.number().int().min(0).max(100).optional(),
        tone: toneSchema,
      })
      .strict()
      .parse(req.query);
    const id = idParams.parse(req.params).id;
    const found = learn.practiceProblem(user.id, id, query.index, query.after);
    return {
      data: {
        ...found,
        problem: await problemBlocks(found.problem, id, query.tone),
      },
    };
  });
  app.post("/v1/learn/points/:id/submit", async (req) => {
    const user = auth.require(req);
    const id = idParams.parse(req.params).id;
    const body = z
      .object({
        answer: answerInput,
        index: z.number().int().min(0).max(100),
        predicted: prediction.optional(),
        tone: toneSchema,
      })
      .strict()
      .parse(req.body);
    const result = learn.submit(
      user.id,
      id,
      body.answer,
      body.index,
      body.predicted,
    );
    const ink = INK[body.tone];
    const items = [];
    for (const { format, ...item } of result.items ?? [])
      items.push({
        ...item,
        read:
          format === "math"
            ? await formula(item.read, ink)
            : item.read
              ? await markdown.render(item.read, ink)
              : null,
      });
    const { standard: _, ...rest } = result as typeof result & {
      standard?: unknown;
    };
    return {
      data: {
        ...rest,
        ...(result.items
          ? { items: items.map(({ standard: _s, ...item }) => item) }
          : {}),
        read: await formula(result.read, ink),
        solution: result.solution
          ? await solutionBlocks(id, body.index, result.solution, body.tone)
          : null,
      },
    };
  });
  app.get("/v1/learn/map", async (req) => {
    const user = auth.require(req);
    const query = z.object({ view: z.enum(["task", "relation"]).optional(),
      level: z.enum(["far", "mid", "near"]).optional(), tone: toneSchema,
      // V4 clients ask for the rendered card blocks; the first render of all
      // 89 cards takes about 2 s per tone, which old clients need not wait for.
      cards: z.enum(["1"]).optional() }).passthrough().parse(req.query);
    learn.track(user.id, "map_open", { view: query.view ?? "task", level: query.level ?? "mid" });
    const map = learn.map(user.id);
    return { data: query.cards ? await withCards(map, query.tone) : map };
  });
  // the star map for visitors who have not logged in. No progress, no
  // events. About 122 KB each, so 60 a minute per address.
  app.get(
    "/v1/learn/map/public",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      const { tone } = z
        .object({ tone: toneSchema })
        .passthrough()
        .parse(req.query);
      return { data: await withCards(learn.publicMap(), tone) };
    },
  );
  app.get("/v1/learn/map/graph", async (req) => {
    const user = auth.require(req);
    const { chapter } = z.object({ chapter: z.string().min(1).max(64) }).strict().parse(req.query);
    learn.track(user.id, "view_switch", { view: "relation", chapterId: chapter });
    return { data: learn.graph(chapter) };
  });
  app.get("/v1/me/settings", async (req) => {
    const user = auth.require(req);
    return { data: learn.settings(user.id) };
  });
  app.put("/v1/me/settings", async (req) => {
    const user = auth.require(req);
    const body = z.object({ taughtTo: z.union([
      z.enum(["none", "all"]), z.string().regex(/^\d+\.\d+$/),
    ]) }).strict().parse(req.body);
    return { data: learn.setSettings(user.id, body.taughtTo) };
  });
  app.post("/v1/learn/map/events", async (req) => {
    const user = auth.require(req);
    const body = z.object({
      name: z.enum(["map_zoom", "node_open", "group_toggle", "view_switch", "next_tap"]),
      pointId: pointIdSchema.optional(), chapterId: z.string().min(1).max(64).optional(),
      view: z.enum(["task", "relation"]).optional(),
      level: z.enum(["far", "mid", "near"]).optional(),
      open: z.boolean().optional(),
    }).strict().parse(req.body);
    const { name, ...data } = body;
    const event: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(data))
      if (value !== undefined) event[key] = typeof value === "boolean" ? Number(value) : value;
    return { data: learn.track(user.id, name, event) };
  });
  app.post("/v1/learn/points/:id/stuck", async (req, reply) => {
    const user = auth.require(req);
    const id = idParams.parse(req.params).id;
    const { text } = z.object({ text: z.string().trim().min(1).max(500) }).strict().parse(req.body);
    learn.mark(user.id, "stuck", id);
    // a reply the student is no longer waiting for is kept unpaid.
    // (req.raw.destroyed is true once the body is read; the response and the
    // socket close only when the student is gone.)
    const waiting = () => !reply.raw.destroyed && !req.raw.socket?.destroyed;
    return { data: await learn.stuckGuide(user.id, id, text, waiting) };
  });
  // the help of the current 卡住了 (running, ready or failed), to come
  // back to after leaving the page; { help: null } when there is none.
  app.get("/v1/learn/points/:id/stuck", async (req) => {
    const user = auth.require(req);
    return { data: learn.stuckHelp(user.id, idParams.parse(req.params).id) };
  });
  app.get("/v1/learn/points/:id", async (req) => {
    const user = auth.require(req);
    const { tone } = z
      .object({ tone: toneSchema })
      .passthrough()
      .parse(req.query);
    const point = learn.point(user.id, idParams.parse(req.params).id);
    const card = await cardOf(point.id, tone);
    let problem = point.problem && {
      ...point.problem,
      blocks: await markdown.render(point.problem.text, INK[tone]),
    };
    if (problem?.kind === "choice") {
      const questions = [];
      for (const question of problem.questions) {
        const options = [];
        for (const option of question.options)
          options.push({
            ...option,
            blocks: await markdown.render(option.text, INK[tone]),
          });
        questions.push({
          ...question,
          blocks: await markdown.render(question.prompt, INK[tone]),
          options,
        });
      }
      problem = { ...problem, questions };
    }
    // The 练一题 page's dark kp card draws its first formula in the dark tone.
    const dark = tone === "dark" ? card : await cardOf(point.id, "dark");
    return {
      data: {
        ...point,
        ...card,
        kpFormulaBlocks: dark?.formulaBlocks[0] ?? null,
        problem,
      },
    };
  });
  app.get("/v1/learn/points/:id/hint", async (req) => {
    const user = auth.require(req);
    const { index, predicted, tone } = z
      .object({
        index: z.coerce.number().int().min(0).max(100).optional(),
        predicted: prediction.optional(),
        tone: toneSchema,
      })
      .strict()
      .parse(req.query);
    const content = learn.content(
      user.id,
      idParams.parse(req.params).id,
      "hint",
      index,
    );
    const blocks = await markdown.render(content.text, INK[tone]);
    const marked = learn.help(
      user.id,
      idParams.parse(req.params).id,
      "hint",
      content.index,
      predicted,
    );
    return {
      data: {
        ...content,
        blocks,
        ...marked,
      },
    };
  });
  app.post("/v1/learn/points/:id/answer", async (req) => {
    const user = auth.require(req);
    const id = idParams.parse(req.params).id;
    const body = z
      .object({
        answer: answerInput,
        index: problemIndex,
        predicted: prediction.optional(),
        tone: toneSchema,
      })
      .strict()
      .parse(req.body);
    const result = learn.answer(
      user.id,
      id,
      body.answer,
      body.index,
      body.predicted,
    );
    const ink = INK[body.tone];
    const items = [];
    for (const item of result.items ?? []) {
      const { format, ...publicItem } = item;
      const render = (value: string | null | undefined) =>
        format === "math"
          ? formula(value, ink)
          : value
            ? markdown.render(value, ink)
            : null;
      items.push({
        ...publicItem,
        read: await render(item.read),
        ...("standard" in item
          ? { standard: await render(item.standard) }
          : {}),
      });
    }
    // `standard` is present only on a correct verdict.
    return {
      data: {
        ...result,
        ...(result.items ? { items } : {}),
        read: await formula(result.read, ink),
        ...("standard" in result
          ? { standard: await formula(result.standard, ink) }
          : {}),
      },
    };
  });
  app.post("/v1/learn/marks", async (req) => {
    const user = auth.require(req);
    const body = z
      .discriminatedUnion("action", [
        z
          .object({
            action: z.literal("explanation"),
            pointId: pointIdSchema,
            index: problemIndex,
            predicted: prediction.optional(),
            tone: toneSchema,
          })
          .strict(),
        z
          .object({
            action: z.literal("hint"),
            pointId: pointIdSchema,
            index: problemIndex,
            predicted: prediction.optional(),
            tone: toneSchema,
          })
          .strict(),
        z
          .object({
            action: z.enum([
              "seen",
              "self",
              "unself",
              "unred",
              "stuck",
              "unstuck",
            ]),
            pointId: pointIdSchema,
          })
          .strict(),
        z
          .object({
            action: z.enum(["selfRest", "unselfRest", "hide", "unhide"]),
            chapterId: z.string().min(1).max(64),
          })
          .strict(),
      ])
      .parse(req.body);
    if (body.action === "explanation" || body.action === "hint") {
      const content = learn.content(
        user.id,
        body.pointId,
        body.action,
        body.index,
      );
      const blocks = await markdown.render(content.text, INK[body.tone]);
      const marked = learn.help(
        user.id,
        body.pointId,
        body.action,
        content.index,
        body.predicted,
      );
      return { data: { ...content, blocks, ...marked } };
    }
    return {
      data:
        "pointId" in body
          ? learn.mark(user.id, body.action, body.pointId)
          : learn.chapter(user.id, body.action, body.chapterId),
    };
  });
  app.post("/v1/learn/points/:id/report", async (req) => {
    const user = auth.require(req);
    const id = idParams.parse(req.params).id;
    const body = z
      .object({
        reason: z.enum(["judge", "problem", "unclear", "other"]),
        answer: answerInput.optional(),
        index: problemIndex,
        // 0.6.0 : the answer is to the bank form of the problem.
        form: z.literal("bank").optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: learn.report(
        user.id,
        id,
        body.reason,
        body.answer,
        body.index,
        body.form,
      ),
    };
  });
}
