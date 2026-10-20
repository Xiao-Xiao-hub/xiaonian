/*
 * 资料学习与题目练习接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import { publicJob, type JobRunner } from "../jobs/runner.js";
import type { Material } from "../materials/service.js";
import type { ArtifactKind, StudyService } from "./service.js";
const idParams = z.object({ id: z.string().min(1).max(64) });
const refreshBody = z
  .object({ refresh: z.boolean().default(false) })
  .strict()
  .default({});
export function registerStudyRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; study: StudyService; runner: JobRunner },
) {
  const { auth, study, runner } = deps;
  const enqueue = (
    userId: string,
    material: Material,
    kind: string,
    options: { params?: Record<string, unknown>; refresh?: boolean } = {},
  ) =>
    publicJob(
      runner.enqueue({
        userId,
        kind,
        materialId: material.id,
        version: material.currentVersion,
        ...options,
      }).job,
    );
  app.get("/v1/materials/:id/study", async (req) => {
    const user = auth.require(req);
    return { data: study.state(user.id, idParams.parse(req.params).id) };
  });
  // Nothing is queued when a result for the current text exists, unless refreshing.
  for (const [path, kind, materialKind] of [
    ["explain", "explain", "note"],
    ["quiz", "quiz", "note"],
    ["hints", "hints", "problem"],
  ] as const)
    app.post(`/v1/materials/:id/${path}`, async (req) => {
      const user = auth.require(req);
      const { refresh } = refreshBody.parse(req.body ?? undefined);
      const material = study.ready(
        user.id,
        idParams.parse(req.params).id,
        materialKind,
      );
      if (
        !refresh &&
        study.latest(material.id, kind as ArtifactKind, material.currentVersion)
      )
        return { data: { job: null } };
      return { data: { job: enqueue(user.id, material, kind, { refresh }) } };
    });
  app.post("/v1/materials/:id/ask", async (req) => {
    const user = auth.require(req);
    const { question } = z
      .object({ question: z.string().trim().min(1).max(200) })
      .strict()
      .parse(req.body);
    const material = study.ready(user.id, idParams.parse(req.params).id, "note");
    return {
      data: { job: enqueue(user.id, material, "ask", { params: { question } }) },
    };
  });
  // "Practise another": new numbers from the last template when there is one.
  app.post("/v1/materials/:id/variant", async (req) => {
    const user = auth.require(req);
    const { refresh } = refreshBody.parse(req.body ?? undefined);
    const material = study.ready(
      user.id,
      idParams.parse(req.params).id,
      "problem",
    );
    const artifactId = refresh
      ? undefined
      : study.redrawVariant(user.id, material);
    if (artifactId) return { data: { job: null, artifactId } };
    return {
      data: { job: enqueue(user.id, material, "variant", { refresh: true }) },
    };
  });
  app.post("/v1/materials/:id/attempts", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        answer: z.string().max(500).default(""),
        artifactId: z.string().min(1).max(64).optional(),
        item: z.number().int().min(0).max(2).optional(),
        choice: z.number().int().min(0).max(3).optional(),
        // the same key again returns the attempt it first made.
        clientKey: z
          .string()
          .regex(/^[A-Za-z0-9_-]{8,64}$/)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const materialId = idParams.parse(req.params).id;
    const attempt = study.submit(user.id, materialId, body);
    let job = null;
    if (attempt.jobId) job = runner.get(attempt.jobId) ?? null;
    else if (attempt.needsJob) {
      try {
        job = runner.enqueue({
          userId: user.id,
          kind: "feedback",
          materialId,
          params: { attemptId: attempt.id },
        }).job;
      } catch (error) {
        study.discardAttempt(attempt.id);
        throw error;
      }
      study.linkJob(attempt.id, job.id);
    }
    return {
      data: {
        attempt: study.attempt(user.id, attempt.id),
        job: job ? publicJob(job) : null,
      },
    };
  });
  app.get("/v1/attempts/:id", async (req) => {
    const user = auth.require(req);
    return { data: study.attempt(user.id, idParams.parse(req.params).id) };
  });
  app.post("/v1/artifacts/:id/reveal", async (req) => {
    const user = auth.require(req);
    const { level } = z
      .object({ level: z.number().int().min(1).max(3) })
      .strict()
      .parse(req.body);
    return {
      data: study.reveal(user.id, idParams.parse(req.params).id, level),
    };
  });
  app.post("/v1/artifacts/:id/report", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        reason: z.enum(["wrong", "unclear", "citation", "other"]),
        note: z.string().trim().max(200).optional(),
      })
      .strict()
      .parse(req.body);
    study.report(user.id, idParams.parse(req.params).id, body.reason, body.note);
    return { data: { reported: true } };
  });
}
