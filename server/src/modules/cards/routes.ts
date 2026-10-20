/*
 * 卡片业务接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { CardService } from "./service.js";
import { CARD_FOLLOWS, CARD_KINDS, CARD_SCENES, CARD_TYPES } from "./types.js";
import { slotSchema, openSchema, nextSchema } from "./schema.js";
import type { CardTidyService } from "./tidy.js";
import type { CardMergeService } from "./merge.js";
import type { JobRunner } from "../jobs/runner.js";
const queryBoolean = z
  .enum(["0", "1", "true", "false"])
  .transform((v) => v === "1" || v === "true");
const id = z.object({ id: z.string().min(1).max(80) }).strict();
const type = z.enum(CARD_TYPES),
  kind = z.enum(CARD_KINDS),
  follow = z.enum(CARD_FOLLOWS),
  scene = z.enum(CARD_SCENES);
export function registerCardRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    cards: CardService;
    tidy: CardTidyService;
    merges: CardMergeService;
    runner: JobRunner;
  },
) {
  const { auth, cards } = deps;
  app.get("/v1/cards/stats", async (req) => {
    const userId = auth.require(req).id;
    // scene=study,life when the learner hides 心情卡.
    const { scene: scenes } = z
      .object({
        scene: z
          .string()
          .transform((v) =>
            v
              .split(",")
              .filter((x): x is (typeof CARD_SCENES)[number] =>
                (CARD_SCENES as readonly string[]).includes(x),
              ),
          )
          .optional(),
      })
      .parse(req.query ?? {});
    return { data: cards.stats(userId, scenes) };
  });
  app.get("/v1/cards/learning/:proofId", async (req) => ({
    data: cards.learningCards(
      auth.require(req).id,
      z
        .object({ proofId: z.coerce.number().int().positive() })
        .parse(req.params).proofId,
    ),
  }));
  app.post("/v1/cards/:id/learning-close", async (req) => {
    const body = z
      .object({
        version: z.number().int().positive(),
        proofId: z.number().int().positive(),
        used: z.boolean().optional(),
        text: z.string().max(300).optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: await cards.learningClose(
        auth.require(req).id,
        id.parse(req.params).id,
        body.version,
        body,
      ),
    };
  });
  app.get("/v1/cards", async (req) => {
    const user = auth.require(req);
    const many = <T extends readonly string[]>(values: T) =>
      z
        .string()
        .transform((v) =>
          v.split(",").filter((x): x is T[number] => values.includes(x)),
        )
        .refine((v) => v.length > 0);
    const q = z
      .object({
        type: many(CARD_TYPES).optional(),
        kind: many(CARD_KINDS).optional(),
        tag: z
          .string()
          .transform((v) => v.split(",").filter(Boolean))
          .optional(),
        scene: many(CARD_SCENES).optional(),
        closed: queryBoolean.optional(),
        retest: queryBoolean.optional(),
        point: z.string().optional(),
        q: z.string().max(100).optional(),
        pick: queryBoolean.optional(),
        cursor: z.string().max(200).optional(),
        order: z.enum(["updated", "created", "used"]).optional(),
        favorite: z.enum(["1"]).optional(),
      })
      .strict()
      .parse(req.query);
    return {
      data: cards.list(user.id, {
        ...q,
        search: q.q,
        favorite: q.favorite === "1",
      }),
    };
  });
  app.post("/v1/cards", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        text: z.string().max(2000).optional(),
        quote: z.string().max(2000).optional(),
        type: type.optional(),
        kind: kind.optional(),
        follow: follow.optional(),
        clientId: z.string().min(8).max(80).optional(),
        scene: scene.optional(),
        title: z.string().max(16).optional(),
        mine: z.string().max(300).optional(),
        origin: z.enum(["jot", "chat", "map", "mistake"]).optional(),
        srcId: z.string().max(80).optional(),
        messageId: z.string().max(80).optional(),
        mistakeId: z.string().max(80).optional(),
        pointId: z.string().max(80).optional(),
        remindEvery: z.enum(["day", "week"]).nullable().optional(),
      })
      .strict()
      .parse(req.body);
    return { data: await cards.create(user.id, body) };
  });
  app.post("/v1/cards/merge", async (req) => {
    const body = z
      .object({
        cardIds: z.array(z.string().min(1).max(80)).min(2).max(10),
        clientId: z.string().min(8).max(80),
      })
      .strict()
      .parse(req.body);
    return {
      data: deps.merges.enqueue(auth.require(req).id, body, deps.runner),
    };
  });
  // undo a merge (the originals come back).
  app.post("/v1/cards/:id/unmerge", async (req) => {
    const body = z
      .object({ version: z.number().int().min(1) })
      .strict()
      .parse(req.body);
    return {
      data: cards.unmerge(
        auth.require(req).id,
        id.parse(req.params).id,
        body.version,
      ),
    };
  });
  app.get("/v1/cards/:id", async (req) => {
    const userId = auth.require(req).id,
      cardId = id.parse(req.params).id;
    // merged=1 opens a merged original (read-only on the client).
    const { merged } = z
      .object({ merged: queryBoolean.optional() })
      .parse(req.query ?? {});
    return {
      data: {
        ...cards.detail(userId, cardId, merged === true),
        aiJob: merged === true ? null : deps.tidy.latest(userId, cardId),
      },
    };
  });
  app.post("/v1/cards/:id/tidy", async (req) => {
    const userId = auth.require(req).id,
      cardId = id.parse(req.params).id;
    const body = z
      .object({
        version: z.number().int().min(1),
        retryUnknown: z.boolean().optional(),
        refresh: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: deps.tidy.enqueue(userId, cardId, body.version, deps.runner, body),
    };
  });
  app.post("/v1/cards/:id/answer", async (req) => {
    const body = z
      .object({
        version: z.number().int().min(1),
        kind: z.enum(["open", "followup"]),
        key: z.string().max(40).optional(),
        action: z.enum(["answer", "done", "thinking"]),
        text: z.string().max(300).optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: await cards.answer(
        auth.require(req).id,
        id.parse(req.params).id,
        body.version,
        body,
      ),
    };
  });
  app.patch("/v1/cards/:id", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        version: z.number().int().min(1),
        title: z.string().max(16).optional(),
        summary: z.string().max(60).nullable().optional(),
        slots: z.array(slotSchema).max(8).optional(),
        open: z.array(openSchema).max(3).optional(),
        next: nextSchema.nullable().optional(),
        type: type.optional(),
        kind: kind.optional(),
        follow: follow.optional(),
        scene: scene.optional(),
        pointId: z.string().max(80).nullable().optional(),
        resume: z.enum(["on", "off", "manual"]).optional(),
        remindOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        remindEvery: z.enum(["day", "week"]).nullable().optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: await cards.update(
        user.id,
        id.parse(req.params).id,
        body.version,
        body,
      ),
    };
  });
  app.put("/v1/cards/:id/favorite", async (req) => {
    const user = auth.require(req);
    const body = z.object({ favorite: z.boolean() }).strict().parse(req.body);
    return {
      data: cards.setFavorite(user.id, id.parse(req.params).id, body.favorite),
    };
  });
  app.delete("/v1/cards/:id", async (req) => {
    const user = auth.require(req);
    cards.remove(user.id, id.parse(req.params).id);
    return { data: { deleted: true } };
  });
  app.put("/v1/cards/:id/tags", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        version: z.number().int().min(1),
        tagIds: z.array(z.string().min(1).max(80)).max(3),
      })
      .strict()
      .parse(req.body);
    return {
      data: cards.tagsReplace(
        user.id,
        id.parse(req.params).id,
        body.version,
        body.tagIds,
      ),
    };
  });
  app.post("/v1/cards/:id/mine", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        version: z.number().int().min(1),
        text: z.string().max(300).optional(),
        quote: z.string().max(300).optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: await cards.mine(
        user.id,
        id.parse(req.params).id,
        body.version,
        body,
      ),
    };
  });
  app.post("/v1/cards/:id/supplements", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        version: z.number().int().min(1),
        text: z.string().trim().min(1).max(500),
        clientId: z.string().min(8).max(80).optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: await cards.supplement(
        user.id,
        id.parse(req.params).id,
        body.version,
        body,
      ),
    };
  });
  app.post("/v1/cards/:id/close", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        version: z.number().int().min(1),
        text: z.string().max(300).optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: await cards.close(
        user.id,
        id.parse(req.params).id,
        body.version,
        body.text,
      ),
    };
  });
  app.post("/v1/cards/:id/links", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        version: z.number().int().min(1),
        cardId: z.string().min(1).max(80),
      })
      .strict()
      .parse(req.body);
    return {
      data: cards.link(
        user.id,
        id.parse(req.params).id,
        body.version,
        body.cardId,
      ),
    };
  });
  app.delete("/v1/cards/:id/links/:otherId", async (req) => {
    const user = auth.require(req);
    const p = z
      .object({ id: z.string(), otherId: z.string() })
      .parse(req.params);
    const body = z
      .object({ version: z.number().int().min(1) })
      .strict()
      .parse(req.body);
    return { data: cards.unlink(user.id, p.id, body.version, p.otherId) };
  });
  app.get("/v1/tags", async (req) => ({
    data: cards.tagList(auth.require(req).id),
  }));
  app.post("/v1/tags", async (req) => {
    const u = auth.require(req);
    const b = z
      .object({
        name: z.string().trim().min(1).max(6),
        color: z.number().int().min(0).max(7),
      })
      .strict()
      .parse(req.body);
    return { data: cards.tagCreate(u.id, b.name, b.color) };
  });
  app.patch("/v1/tags/:id", async (req) => {
    const u = auth.require(req);
    const b = z
      .object({
        name: z.string().trim().min(1).max(6).optional(),
        color: z.number().int().min(0).max(7).optional(),
      })
      .strict()
      .parse(req.body);
    return { data: cards.tagUpdate(u.id, id.parse(req.params).id, b) };
  });
  app.delete("/v1/tags/:id", async (req) => {
    cards.tagDelete(auth.require(req).id, id.parse(req.params).id);
    return { data: { deleted: true } };
  });
}
