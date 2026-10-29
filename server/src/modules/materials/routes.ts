/*
 * 资料与题目原文接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import { finishUpload } from "../../shared/upload-admission.js";
import type { AuthService } from "../auth/service.js";
import { publicJob, type JobRunner } from "../jobs/runner.js";
import { IMAGE_LIMIT, MaterialService } from "./service.js";
const kind = z.enum(["note", "problem"]);
const title = z.string().trim().max(40);
const answer = z.string().trim().max(500);
const idParams = z.object({ id: z.string().min(1).max(64) });
export function registerMaterialRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; materials: MaterialService; runner: JobRunner },
) {
  const { auth, materials, runner } = deps;
  app.post("/v1/materials", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        kind,
        title: title.optional(),
        text: z.string().max(10000),
        answer: answer.optional(),
      })
      .strict()
      .parse(req.body);
    const material = materials.create(user.id, body);
    return { data: materials.detail(user.id, material.id) };
  });
  // wx.uploadFile sends multipart/form-data; kind and title travel in the query string.
  app.post(
    "/v1/materials/image",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      const query = z
        .object({ kind, title: title.optional() })
        .parse(req.query);
      let data: Buffer;
      try {
        const file = await req.file({
          limits: { fileSize: IMAGE_LIMIT, files: 1 },
        });
        if (!file) throw new AppError(400, "IMAGE_REQUIRED", "先选一张图");
        data = await file.toBuffer();
      } catch (error) {
        if (error instanceof AppError) throw error;
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE")
          throw new AppError(
            413,
            "IMAGE_TOO_LARGE",
            "这张图有点大（5MB 以内），裁一下或换一张",
          );
        if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE")
          throw new AppError(400, "IMAGE_REQUIRED", "先选一张图");
        throw error;
      } finally {
        finishUpload(req);
      }
      // Refuse before saving, so a rejected upload leaves no empty material behind.
      runner.checkQueue(user.id);
      runner.checkQuota(user.id, "ocr");
      const material = materials.createFromImage(user.id, { ...query, data });
      const { job } = runner.enqueue({
        userId: user.id,
        kind: "ocr",
        materialId: material.id,
        version: 0,
      });
      return {
        data: {
          material: materials.detail(user.id, material.id),
          job: publicJob(job),
        },
      };
    },
  );
  app.get("/v1/materials", async (req) => {
    const user = auth.require(req);
    const query = z
      .object({
        kind: kind.optional(),
        status: z.enum(["draft", "confirmed"]).optional(),
        q: z.string().trim().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        // V4.2 paging for 我的资料; older clients send none and get the first page.
        offset: z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .default(0),
      })
      .parse(req.query);
    return { data: materials.list(user.id, query) };
  });
  app.get("/v1/materials/:id", async (req) => {
    const user = auth.require(req);
    return { data: materials.detail(user.id, idParams.parse(req.params).id) };
  });
  app.get("/v1/materials/:id/image", async (req, reply) => {
    const user = auth.require(req);
    const { data, type } = materials.image(
      materials.own(user.id, idParams.parse(req.params).id),
    );
    return reply.type(`image/${type === "jpg" ? "jpeg" : type}`).send(data);
  });
  app.get("/v1/materials/:id/versions", async (req) => {
    const user = auth.require(req);
    return { data: materials.versions(user.id, idParams.parse(req.params).id) };
  });
  app.get("/v1/materials/:id/versions/:version", async (req) => {
    const user = auth.require(req);
    const params = idParams
      .extend({ version: z.coerce.number().int().min(1) })
      .parse(req.params);
    materials.own(user.id, params.id);
    const version = materials.version(params.id, params.version);
    if (!version) throw new AppError(404, "NOT_FOUND", "这一版找不到了");
    return {
      data: {
        version: version.version,
        origin: version.origin,
        text: version.text,
        paragraphs: version.paragraphs,
        answer: version.answer,
        createdAt: version.createdAt,
      },
    };
  });
  app.put("/v1/materials/:id", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        expectedVersion: z.number().int().min(0),
        text: z.string().max(10000).optional(),
        answer: answer.nullable().optional(),
        title: title.optional(),
        confirm: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return {
      data: materials.update(user.id, idParams.parse(req.params).id, body),
    };
  });
  app.post("/v1/materials/:id/ocr", async (req) => {
    const user = auth.require(req);
    const material = materials.own(user.id, idParams.parse(req.params).id);
    if (!material.imagePath)
      throw new AppError(400, "NO_IMAGE", "这份资料没有图");
    if (material.currentVersion !== 0)
      throw new AppError(
        409,
        "ALREADY_RECOGNIZED",
        "字已经有了，不用再认一遍",
      );
    const { job } = runner.enqueue({
      userId: user.id,
      kind: "ocr",
      materialId: material.id,
      version: 0,
    });
    return { data: publicJob(job) };
  });
  app.delete("/v1/materials/:id", async (req) => {
    const user = auth.require(req);
    materials.remove(user.id, idParams.parse(req.params).id);
    return { data: { deleted: true } };
  });
}
