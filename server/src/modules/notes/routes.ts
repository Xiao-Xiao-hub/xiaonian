/*
 * 随心记原始记录接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import type { AuthService } from "../auth/service.js";
import type { JobRunner } from "../jobs/runner.js";
import { itemInput, versionInput, SUPPLEMENT_LIMIT } from "./schema.js";
import {
  NOTE_TEXT_LIMIT,
  NOTE_TITLE_LIMIT,
  type NoteService,
} from "./service.js";

const idParams = z.object({ id: z.string().min(1).max(64) }).strict();
export function registerNoteRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    notes: NoteService;
    runner: JobRunner;
    readOnly?: boolean;
  },
) {
  const { auth, notes, runner } = deps;
  const rejectLegacyWrite = () => {
    if (deps.readOnly)
      throw new AppError(410, "NOTES_READ_ONLY", "请更新小程序");
  };
  app.post("/v1/notes", async (req) => {
    const user = auth.require(req);
    rejectLegacyWrite();
    const body = z
      .object({
        text: z.string().max(NOTE_TEXT_LIMIT),
        clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
      })
      .strict()
      .parse(req.body);
    return { data: notes.create(user.id, body.text, body.clientId) };
  });
  app.get("/v1/notes", async (req) => {
    const user = auth.require(req);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .default(0),
      })
      .strict()
      .parse(req.query);
    return { data: notes.list(user.id, query) };
  });
  // readOnly (only when on) tells the note page to hide what would be
  // refused above.
  app.get("/v1/notes/:id", async (req) => {
    const user = auth.require(req);
    const note = notes.detail(user.id, idParams.parse(req.params).id);
    return { data: deps.readOnly ? { ...note, readOnly: true } : note };
  });
  app.put("/v1/notes/:id", async (req) => {
    const user = auth.require(req);
    rejectLegacyWrite();
    const body = z
      .object({ title: z.string().trim().min(1).max(NOTE_TITLE_LIMIT) })
      .strict()
      .parse(req.body);
    return {
      data: notes.rename(user.id, idParams.parse(req.params).id, body.title),
    };
  });
  app.delete("/v1/notes/:id", async (req) => {
    const user = auth.require(req);
    z.object({}).strict().optional().parse(req.body);
    notes.remove(user.id, idParams.parse(req.params).id);
    return { data: { deleted: true } };
  });
  app.post("/v1/notes/:id/organize", async (req) => {
    const user = auth.require(req);
    rejectLegacyWrite();
    const body = versionInput
      .extend({
        refresh: z.boolean().default(false),
        retryUnknown: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    return {
      data: notes.organize(
        user.id,
        idParams.parse(req.params).id,
        body,
        runner,
      ),
    };
  });
  app.post("/v1/notes/:id/supplements", async (req) => {
    const user = auth.require(req);
    rejectLegacyWrite();
    const body = z
      .object({
        revision: versionInput.shape.revision,
        clientId: z.string().min(16).max(80),
        text: z
          .string()
          .min(1)
          .max(SUPPLEMENT_LIMIT)
          .refine((s) => Boolean(s.trim()), "补充不能为空"),
      })
      .strict()
      .parse(req.body);
    return {
      data: notes.supplement(user.id, idParams.parse(req.params).id, body),
    };
  });
  const itemParams = idParams
    .extend({ itemId: z.string().min(1).max(64) })
    .strict();
  app.put("/v1/notes/:id/items/:itemId", async (req) => {
    const user = auth.require(req);
    rejectLegacyWrite();
    const { id, itemId } = itemParams.parse(req.params);
    const body = versionInput.merge(itemInput).strict().parse(req.body);
    return {
      data: notes.item(user.id, id, itemId, body, {
        group: body.group,
        text: body.text,
      }),
    };
  });
  app.delete("/v1/notes/:id/items/:itemId", async (req) => {
    const user = auth.require(req);
    rejectLegacyWrite();
    const { id, itemId } = itemParams.parse(req.params);
    return {
      data: notes.item(user.id, id, itemId, versionInput.parse(req.body), null),
    };
  });
  app.put("/v1/notes/:id/point", async (req) => {
    const user = auth.require(req);
    rejectLegacyWrite();
    const body = z
      .object({
        pointId: z.string().min(1).max(64).nullable(),
        confirm: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return {
      data: notes.link(user.id, idParams.parse(req.params).id, body.pointId),
    };
  });
}
