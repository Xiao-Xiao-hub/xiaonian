/*
 * 账号数据与额度接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
import { publicUser, type AuthService } from "../auth/service.js";
import type { AccountService } from "./service.js";
import { AVATAR_LIMIT, ProfileService, profileNickname } from "./profile.js";
export function registerAccountRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    account: AccountService;
    profiles: ProfileService;
  },
) {
  const { auth, account, profiles } = deps;
  app.patch("/v1/me/profile", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({ nickname: profileNickname })
      .strict()
      .parse(req.body);
    return { data: publicUser(profiles.update(user.id, body)) };
  });
  app.post(
    "/v1/me/profile",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      profiles.assertConsent(user.id);
      let image: Buffer | undefined;
      let mime: string | undefined;
      let nickname: string | undefined;
      try {
        // Read the whole bounded form before saving either field. wx.uploadFile
        // may place its text field before or after the binary part.
        for await (const part of req.parts({
          limits: {
            files: 1,
            fileSize: AVATAR_LIMIT,
            fields: 1,
            fieldSize: 128,
            parts: 2,
          },
        })) {
          if (part.type === "file") {
            if (part.fieldname !== "file" || image)
              throw new AppError(400, "VALIDATION_ERROR", "请选择一张头像");
            mime = part.mimetype;
            image = await part.toBuffer();
          } else {
            if (
              part.fieldname !== "nickname" ||
              nickname !== undefined ||
              part.valueTruncated
            )
              throw new AppError(400, "VALIDATION_ERROR", "昵称内容不太对");
            nickname = profileNickname.parse(part.value);
          }
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE")
          throw new AppError(413, "IMAGE_TOO_LARGE", "头像需在 2MB 以内");
        if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE")
          throw new AppError(400, "IMAGE_REQUIRED", "请选择一张头像");
        if (
          ["FST_FILES_LIMIT", "FST_FIELDS_LIMIT", "FST_PARTS_LIMIT"].includes(
            code ?? "",
          )
        )
          throw new AppError(400, "VALIDATION_ERROR", "只需一张头像和一个昵称");
        throw error;
      }
      if (!image) throw new AppError(400, "IMAGE_REQUIRED", "请选择一张头像");
      // Uploading can take time: logout, account erasure or a ban during the
      // stream must take effect before a single file or profile field is saved.
      const current = auth.require(req);
      return {
        data: publicUser(
          profiles.update(current.id, { nickname, image, mime }),
        ),
      };
    },
  );
  app.get("/v1/me/profile/avatar", async (req, reply) => {
    const user = auth.require(req, { allowBanned: true });
    const { v } = z
      .object({ v: z.string().regex(/^[a-f0-9]{32}$/) })
      .strict()
      .parse(req.query);
    const image = profiles.image(user.id, v);
    return reply
      .type(image.type)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .send(image.data);
  });
  app.delete("/v1/me/profile", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    const body = z
      .object({
        avatar: z.literal(true).optional(),
        nickname: z.literal(true).optional(),
      })
      .strict()
      .refine((value) => value.avatar || value.nickname)
      .parse(req.body);
    return { data: publicUser(profiles.clear(user.id, body)) };
  });
  app.get("/v1/me/usage", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: account.usage(user.id) };
  });
  // A file download, so the body is the export itself rather than { data }.
  app.get("/v1/me/export", async (req, reply) => {
    const user = auth.require(req, { allowBanned: true });
    const data = account.export(user);
    const day = data.exportedAt.slice(0, 10);
    return reply
      .type("application/json; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="export-${day}.json"; filename*=UTF-8''${encodeURIComponent(`晓念数据导出-${day}.json`)}`,
      )
      .send(JSON.stringify(data, null, 2));
  });
  // Agreement to the three documents and the age band. Allowed
  // for a stopped account too, like export and deletion.
  app.put("/v1/me/consent", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    const body = z
      .object({
        version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/),
        ageBand: z.enum(["adult", "child"]),
        guardian: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return { data: account.consent(user.id, body) };
  });
  app.get("/v1/me/consent", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: account.consentOf(user) };
  });
  // Revoking: recorded only; the data stays until the user deletes it.
  app.delete("/v1/me/consent", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: account.withdraw(user.id) };
  });
  // 个性化学习推荐 and 学习时长统计.
  app.get("/v1/me/prefs", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    return { data: account.prefs(user) };
  });
  app.put("/v1/me/prefs", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    const body = z
      .object({
        personalized: z.boolean().optional(),
        studyTime: z.boolean().optional(),
      })
      .strict()
      .refine((b) => b.personalized !== undefined || b.studyTime !== undefined)
      .parse(req.body);
    return { data: account.setPrefs(user.id, body) };
  });
  app.delete("/v1/me", async (req) => {
    const user = auth.require(req, { allowBanned: true });
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    account.erase(user.id);
    return { data: { deleted: true } };
  });
}
