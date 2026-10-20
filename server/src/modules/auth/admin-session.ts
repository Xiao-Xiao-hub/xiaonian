/*
 * 管理员会话：将管理密钥交换为短期浏览器会话，限制来源、闲置时间与登录失败次数。
 * 由 AuthService 和管理台路由调用；浏览器会话与普通用户 Bearer token 相互独立。
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../../config/env.js";
import { AppError } from "../../shared/domain.js";
import { digest } from "../../shared/store.js";
import type { AuthService } from "./service.js";

const IDLE_MS = 15 * 60_000;
const ABSOLUTE_MS = 8 * 60 * 60_000;
type Session = {
  expiresAt: number;
  absoluteExpiresAt: number;
  keyHash: string;
};

// Wrong machine keys (x-admin-key): at most `max` a minute per client address,
// in memory like the console sessions. Successful calls are not counted.
export class KeyFailures {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = 5,
  ) {}
  private recent(ip: string) {
    const since = this.now() - 60_000;
    const recent = (this.hits.get(ip) ?? []).filter((at) => at > since);
    if (recent.length) this.hits.set(ip, recent);
    else this.hits.delete(ip);
    return recent;
  }
  assert(ip: string) {
    if (this.recent(ip).length >= this.max)
      throw new AppError(429, "ADMIN_KEY_LIMITED", "管理员凭证错误次数过多，请一分钟后再试");
  }
  fail(ip: string) {
    if (this.hits.size >= 4096) this.hits.clear();
    this.hits.set(ip, [...this.recent(ip), this.now()]);
  }
}

// Only hashes live on the server; a restart deliberately revokes every console
// session. The long-lived bootstrap key never becomes a browser session token.
export class AdminSessions {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly env: Env,
    private readonly now: () => number = Date.now,
  ) {}
  get cookieName() {
    return this.env.NODE_ENV === "production"
      ? "__Secure-zhiye_admin"
      : "zhiye_admin";
  }
  assertOrigin(req: FastifyRequest, requireOrigin = false) {
    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    const expected = this.env.ADMIN_ORIGIN || `${req.protocol}://${req.host}`;
    if (
      (requireOrigin && !origin) ||
      (origin !== undefined && origin !== expected) ||
      (fetchSite !== undefined &&
        fetchSite !== "same-origin" &&
        fetchSite !== "none")
    )
      throw new AppError(
        403,
        "ADMIN_ORIGIN_REJECTED",
        "请从管理台同源页面操作",
      );
  }
  private token(req: FastifyRequest) {
    const values = (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${this.cookieName}=`));
    if (values.length !== 1) return undefined;
    const token = values[0]!.slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }
  private prune() {
    const now = this.now();
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= now || session.absoluteExpiresAt <= now)
        this.sessions.delete(key);
  }
  issue(req: FastifyRequest) {
    this.prune();
    // Login rotates an existing browser session instead of accumulating tokens.
    this.revoke(req);
    if (this.sessions.size >= 1024)
      throw new AppError(
        429,
        "ADMIN_SESSION_LIMIT",
        "管理会话较多，请稍后重试",
      );
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      expiresAt: now + IDLE_MS,
      absoluteExpiresAt: now + ABSOLUTE_MS,
      keyHash: digest(this.env.ADMIN_API_KEY!),
    };
    this.sessions.set(digest(token), session);
    return {
      cookie: this.cookie(token, ABSOLUTE_MS / 1000),
      data: this.public(session),
    };
  }
  require(req: FastifyRequest) {
    this.assertOrigin(req, !["GET", "HEAD", "OPTIONS"].includes(req.method));
    const token = this.token(req);
    const hash = token ? digest(token) : "";
    const session = this.sessions.get(hash);
    const now = this.now();
    if (
      !session ||
      !this.env.ADMIN_API_KEY ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      session.keyHash !== digest(this.env.ADMIN_API_KEY)
    ) {
      this.sessions.delete(hash);
      throw new AppError(
        401,
        "ADMIN_SESSION_EXPIRED",
        "管理会话已失效，请重新登录",
      );
    }
    session.expiresAt = Math.min(now + IDLE_MS, session.absoluteExpiresAt);
    return this.public(session);
  }
  revoke(req: FastifyRequest) {
    const token = this.token(req);
    return token ? this.sessions.delete(digest(token)) : false;
  }
  clearCookie() {
    return this.cookie("", 0);
  }
  private cookie(token: string, maxAge: number) {
    return `${this.cookieName}=${token}; Path=/v1/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.env.NODE_ENV === "production" ? "; Secure" : ""}`;
  }
  private public(session: Session) {
    return {
      authenticated: true,
      expiresAt: new Date(session.expiresAt).toISOString(),
      idleTimeoutSec: IDLE_MS / 1000,
      absoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString(),
    };
  }
}

export function registerAdminSessionRoutes(
  app: FastifyInstance,
  auth: AuthService,
) {
  app.post(
    "/v1/admin/session",
    {
      bodyLimit: 1024,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      auth.adminSessions.assertOrigin(req, true);
      const { key } = z
        .object({ key: z.string().min(1).max(256) })
        .strict()
        .parse(req.body);
      try {
        auth.adminKey(key);
      } catch (error) {
        auth.store.audit(
          "admin:shared",
          "admin.login.failed",
          "admin-console",
          { requestId: req.id },
        );
        throw error;
      }
      const session = auth.adminSessions.issue(req);
      auth.store.audit(
        "admin:shared",
        "admin.session.created",
        "admin-console",
        { requestId: req.id },
      );
      reply.header("set-cookie", session.cookie);
      return { data: session.data };
    },
  );
  app.get("/v1/admin/session", async (req) => ({
    data: auth.adminSessions.require(req),
  }));
  app.delete("/v1/admin/session", async (req, reply) => {
    // Idempotent sign-out still checks Origin, even for an expired session.
    auth.adminSessions.assertOrigin(req, true);
    const revoked = auth.adminSessions.revoke(req);
    reply.header("set-cookie", auth.adminSessions.clearCookie());
    if (revoked)
      auth.store.audit(
        "admin:shared",
        "admin.session.revoked",
        "admin-console",
        { requestId: req.id },
      );
    return { data: { revoked: true } };
  });
}
