import type { FastifyInstance } from "fastify";
import type { AuthService } from "../auth/service.js";
import type { SqliteStore } from "../../shared/store.js";
import { CommercialSettings, commercialSettingsPatchSchema } from "./settings.js";

/** Admin authentication includes the existing same-origin/CSRF session check. */
export function registerCommercialSettingsRoutes(
  app: FastifyInstance,
  deps: { auth: Pick<AuthService, "admin">; store: SqliteStore },
) {
  const settings = new CommercialSettings(deps.store);
  app.get("/v1/admin/commercial/settings", async (req) => {
    deps.auth.admin(req);
    return { data: settings.get() };
  });
  app.put("/v1/admin/commercial/settings", async (req) => {
    deps.auth.admin(req);
    return {
      data: settings.update("admin:shared", commercialSettingsPatchSchema.parse(req.body), req.id),
    };
  });
}
