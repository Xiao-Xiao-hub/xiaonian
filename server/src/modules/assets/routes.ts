/*
 * 公开静态资源入口：仅提供项目允许对外访问的资源，供页面使用同源地址加载。
 * 这是产品静态资源通道，不是用户上传文件的浏览入口。
 */
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppError } from "../../shared/domain.js";
// server/assets, from src/modules/assets in development and from
// dist/modules/assets in the image alike.
export const ASSET_DIR = fileURLToPath(new URL("../../../assets/", import.meta.url));
const FILE = /^[a-z0-9-]+\.(webp|png)$/;
const TYPES = { webp: "image/webp", png: "image/png" } as const;
// Public on purpose, like /v1/formula: <image> cannot send the session header,
// and these are the app's own pictures (mascot poses, 3D icons), the same for
// everyone. Kept out of the 2 MB package.
export function registerAssetRoutes(app: FastifyInstance, dir = ASSET_DIR) {
  app.get(
    "/v1/assets/:file",
    { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { file } = z.object({ file: z.string().max(64) }).parse(req.params);
      const ext = FILE.exec(file)?.[1] as keyof typeof TYPES | undefined;
      const body = ext
        ? await readFile(join(dir, file)).catch(() => null)
        : null;
      if (!ext || !body) throw new AppError(404, "NOT_FOUND", "图片不存在");
      return reply
        .header("cache-control", "public, max-age=604800")
        .header("cross-origin-resource-policy", "cross-origin")
        .type(TYPES[ext])
        .send(body);
    },
  );
}
