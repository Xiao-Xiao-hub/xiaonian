/*
 * 资料导入接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import { finishUpload } from "../../shared/upload-admission.js";
import type { AuthService } from "../auth/service.js";
import type { JobRunner } from "../jobs/runner.js";
import { CARD_KINDS } from "../cards/types.js";
import {
  IMPORT_FILE_LIMIT,
  IMPORT_IMAGE_LIMIT,
  ImportService,
} from "./service.js";

const idParams = z.object({ id: z.string().min(1).max(80) }).strict();
const clientId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const queryBoolean = z
  .enum(["0", "1", "true", "false"])
  .transform((value) => value === "1" || value === "true");
const selection = z
  .object({
    candidateId: z.string().min(1).max(40).optional(),
    quote: z.string().trim().min(1).max(1000).optional(),
    type: z.enum(["spark", "idea", "question", "method"]).optional(),
    // one of the seven kinds (wins over type) and a rewritten summary.
    kind: z.enum(CARD_KINDS).optional(),
    summary: z.string().trim().min(1).max(60).optional(),
    scene: z.enum(["study", "life", "mood"]).optional(),
    title: z.string().trim().min(1).max(16).optional(),
    tags: z.array(z.string().trim().min(1).max(6)).max(3).optional(),
    pointId: z.string().max(80).nullable().optional(),
    mine: z.string().trim().min(10).max(300).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.candidateId) === Boolean(value.quote))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "选一张卡或者一句原文",
      });
    if (value.quote && (!(value.type || value.kind) || !value.scene))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "选好卡的种类再存",
      });
  });

async function upload(req: FastifyRequest, limit: number) {
  try {
    const file = await req.file({
      limits: { fileSize: limit, files: 1, fields: 0 },
    });
    if (!file || file.fieldname !== "file")
      throw new AppError(400, "FILE_REQUIRED", "选一个文件吧");
    return { name: file.filename, data: (await file.toBuffer()) as Buffer };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
      throw new AppError(
        413,
        "FILE_TOO_LARGE",
        `文件超过${limit === IMPORT_IMAGE_LIMIT ? "5" : "10"}MB`,
      );
    if (
      (error as { code?: string }).code === "FST_INVALID_MULTIPART_CONTENT_TYPE"
    )
      throw new AppError(400, "FILE_REQUIRED", "选一个文件吧");
    throw error;
  } finally {
    finishUpload(req);
  }
}

export function registerImportRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; imports: ImportService; runner: JobRunner },
) {
  const { auth, imports, runner } = deps;
  app.post("/v1/imports", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        clientId: clientId.optional(),
        // longer text is accepted; what is past the 20000 kept is
        // offered as the next import (restChars, POST /:id/rest).
        text: z.string().max(60_000),
        own: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const row = imports.createPaste(user.id, body);
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  app.post("/v1/imports/file", async (req) => {
    const user = auth.require(req);
    const query = z
      .object({
        clientId: clientId.optional(),
        start: z.coerce.number().int().positive().default(1),
        own: queryBoolean.optional(),
      })
      .strict()
      .parse(req.query);
    const file = await upload(req, IMPORT_FILE_LIMIT);
    const row = await imports.createFile(
      user.id,
      { ...query, fileName: file.name, data: file.data },
      runner,
    );
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  app.post("/v1/imports/photo", async (req) => {
    const user = auth.require(req);
    const query = z
      .object({
        clientId,
        source: z.enum(["photo", "screenshot"]),
        index: z.coerce.number().int().min(0).max(2),
        count: z.coerce.number().int().min(1).max(3),
        own: queryBoolean.optional(),
      })
      .strict()
      .refine((value) => value.index < value.count, "照片顺序不对，重新选一次")
      .parse(req.query);
    const file = await upload(req, IMPORT_IMAGE_LIMIT);
    const row = imports.addPhoto(
      user.id,
      { ...query, data: file.data },
      runner,
    );
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  // ?open=1 : unfinished imports of the last 7 days, small rows.
  // with all=1, every unfinished import, however old.
  app.get("/v1/imports", async (req) => {
    const user = auth.require(req);
    const { open, all } = z
      .object({ open: queryBoolean.optional(), all: queryBoolean.optional() })
      .parse(req.query ?? {});
    return {
      data: {
        items: open
          ? imports.open(user.id, runner, Boolean(all))
          : imports.list(user.id, runner),
      },
    };
  });
  app.get("/v1/imports/:id", async (req) => {
    const user = auth.require(req);
    return {
      data: imports.detail(user.id, idParams.parse(req.params).id, runner),
    };
  });
  app.patch("/v1/imports/:id", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        own: z.boolean().optional(),
        keepSegments: z.array(z.number().int().positive()).max(500).optional(),
        // the read text after fixing, merging or splitting segments.
        segments: z
          .array(
            z
              .object({
                text: z.string().max(20_000),
                from: z.number().int().positive().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(500)
          .optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.own !== undefined ||
          value.keepSegments !== undefined ||
          value.segments !== undefined,
        "没有要改的",
      )
      .parse(req.body);
    const row = imports.update(user.id, idParams.parse(req.params).id, body);
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  app.post("/v1/imports/:id/read", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({ pages: z.number().int().min(0).max(20) })
      .strict()
      .parse(req.body);
    const row = imports.startRead(
      user.id,
      idParams.parse(req.params).id,
      body.pages,
      runner,
    );
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  app.post("/v1/imports/:id/cards", async (req) => {
    const user = auth.require(req);
    const body = z.object({ clientId }).strict().parse(req.body);
    const row = imports.split(
      user.id,
      idParams.parse(req.params).id,
      body.clientId,
      runner,
    );
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  app.post("/v1/imports/:id/save", async (req) => {
    const user = auth.require(req);
    const body = z
      // all batches are split now, so more candidates can come back.
      .object({ clientId, selections: z.array(selection).min(1).max(48) })
      .strict()
      .parse(req.body);
    const id = idParams.parse(req.params).id;
    const saved = await imports.save(
      user.id,
      id,
      body.selections,
      body.clientId,
    );
    return { data: { import: imports.detail(user.id, id, runner), ...saved } };
  });
  // the text past the limit, as a new import ready to split.
  app.post("/v1/imports/:id/rest", async (req) => {
    const user = auth.require(req);
    const body = z.object({ clientId }).strict().parse(req.body);
    const row = imports.continueRest(
      user.id,
      idParams.parse(req.params).id,
      body.clientId,
    );
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  // the picture of page n (or, for a PDF, the file) picked again
  // after the upload was cleared; POST /:id/read then reads the unread pages.
  app.post("/v1/imports/:id/page", async (req) => {
    const user = auth.require(req);
    const id = idParams.parse(req.params).id;
    const query = z
      .object({ n: z.coerce.number().int().min(1).max(20).optional() })
      .strict()
      .parse(req.query ?? {});
    const pdf = imports.detail(user.id, id, runner).source === "pdf";
    const file = await upload(req, pdf ? IMPORT_FILE_LIMIT : IMPORT_IMAGE_LIMIT);
    const row = await imports.replacePage(
      user.id,
      id,
      { n: query.n, data: file.data },
      runner,
    );
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  app.post("/v1/imports/:id/abandon", async (req) => {
    const user = auth.require(req);
    const row = imports.abandon(user.id, idParams.parse(req.params).id, runner);
    return {
      data: { import: imports.detail(user.id, String(row.id), runner) },
    };
  });
  app.delete("/v1/imports/:id", async (req) => {
    const user = auth.require(req);
    imports.remove(user.id, idParams.parse(req.params).id, runner);
    return { data: { deleted: true } };
  });
}
