/*
 * 身份与会话：微信登录或开发登录换取业务 token，接口再由 require 校验用户。
 * 数据库保存 token 摘要；开发身份在生产禁用，管理台会话由 admin-session.ts 单独管理。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Env } from "../../config/env.js";
import { SqliteStore, digest } from "../../shared/store.js";
import { AppError, type User } from "../../shared/domain.js";
import { bindCallUser } from "../../shared/call-context.js";
import { AdminSessions, KeyFailures } from "./admin-session.js";
export const publicUser = (user: User) => ({
  id: user.id,
  nickname: user.nickname,
  role: user.role,
  authMode: user.authMode,
  createdAt: user.createdAt,
  avatar: user.avatar ? { version: user.avatar.version } : null,
});
export class AuthService {
  readonly adminSessions: AdminSessions;
  private readonly keyFailures: KeyFailures;
  constructor(
    readonly store: SqliteStore,
    readonly env: Env,
    readonly fetcher: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.adminSessions = new AdminSessions(env, now);
    this.keyFailures = new KeyFailures(now);
  }
  issue(user: User, paymentSessionKey?: string) {
    const token = randomBytes(32).toString("base64url"),
      expiresAt = Date.now() + this.env.SESSION_TTL_SECONDS * 1000;
    this.store.transaction(() => {
      this.store.db
        .prepare("DELETE FROM sessions WHERE expires_at<=?")
        .run(Date.now());
      this.store.db
        .prepare("INSERT INTO sessions VALUES(?,?,?)")
        .run(digest(token), user.id, expiresAt);
      if (paymentSessionKey) {
        this.store.db.prepare(
          "INSERT INTO wechat_payment_sessions(session_hash,session_key,refreshed_at) VALUES(?,?,?)",
        ).run(digest(token), paymentSessionKey, this.store.now());
      }
      this.store.audit(user.id, "session.created", user.id, {
        authMode: user.authMode,
      });
    });
    return {
      token,
      user: publicUser(user),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  // Stable development identity: the same key always maps to the same user, so
  // data created while debugging survives restarts. Never available in production.
  dev(key: string, nickname: string) {
    if (!this.env.DEV_LOGIN_ENABLED || this.env.NODE_ENV === "production")
      throw new AppError(404, "NOT_FOUND", "接口不存在");
    return this.issue(this.store.upsertUser(`dev:${key}`, nickname, "dev"));
  }
  async wechat(code: string) {
    if (!this.env.WECHAT_APP_ID || !this.env.WECHAT_APP_SECRET)
      throw new AppError(503, "WECHAT_NOT_CONFIGURED", "微信登录尚未配置");
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.search = new URLSearchParams({
      appid: this.env.WECHAT_APP_ID,
      secret: this.env.WECHAT_APP_SECRET,
      js_code: code,
      grant_type: "authorization_code",
    }).toString();
    let value: unknown;
    try {
      const response = await this.fetcher(url, {
        signal: AbortSignal.timeout(this.env.WECHAT_HTTP_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error();
      value = await response.json();
    } catch {
      throw new AppError(502, "WECHAT_LOGIN_FAILED", "微信登录服务暂时不可用");
    }
    const data = value as { openid?: unknown; errcode?: unknown; session_key?: unknown };
    if (
      !data ||
      typeof data.openid !== "string" ||
      data.openid.length < 8 ||
      (data.errcode && data.errcode !== 0)
    )
      throw new AppError(401, "INVALID_WECHAT_CODE", "登录凭证失效，请重试");
    // Keep payment keys server-side and tied to the freshly issued business
    // session. Older/mock login responses without a usable key can still log
    // in, but cannot create payment parameters until a fresh wx.login succeeds.
    const paymentKey = typeof data.session_key === "string" &&
      /^[A-Za-z0-9+/]{22}==$/.test(data.session_key) &&
      Buffer.from(data.session_key, "base64").length === 16
      ? data.session_key : undefined;
    return this.issue(this.store.upsertUser(data.openid, "微信用户", "wechat"), paymentKey);
  }
  wechatPaymentSession(req: FastifyRequest) {
    const user = this.require(req);
    if (user.authMode !== "wechat")
      throw new AppError(403, "WECHAT_LOGIN_REQUIRED", "请使用微信登录后购买");
    const row = this.store.db.prepare(
      "SELECT session_key FROM wechat_payment_sessions WHERE session_hash=?",
    ).get(digest(this.token(req)));
    if (!row) throw new AppError(401, "WECHAT_SESSION_REFRESH", "请刷新微信登录后重试");
    return { user, sessionKey: String(row.session_key) };
  }
  token(req: FastifyRequest) {
    const header = req.headers.authorization;
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
      throw new AppError(401, "AUTH_REQUIRED", "登录过期了，重新打开晓念就好");
    return header.slice(7);
  }
  // Quotas follow a verified account across sessions and source addresses.
  // Login attempts remain IP-scoped: a supplied learner token must not change
  // the administrator password-guessing bucket. This lookup deliberately does
  // not throw or bind the request's billing context before authentication.
  rateLimitKey(req: FastifyRequest) {
    const ipKey = `ip:${req.ip}`;
    const route = req.routeOptions.url ?? req.url.split("?")[0];
    if (
      route === "/v1/admin/session" ||
      route === "/v1/auth/dev-login" ||
      route === "/v1/auth/wechat-login"
    ) return ipKey;
    const header = req.headers.authorization;
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return ipKey;
    const row = this.store.db.prepare(
      "SELECT user_id FROM sessions WHERE hash=? AND expires_at>?",
    ).get(digest(header.slice(7)), Date.now());
    if (!row) return ipKey;
    const user = this.store.getUser(String(row.user_id));
    if (
      !user ||
      (user.authMode !== "wechat" &&
        (!this.env.DEV_LOGIN_ENABLED || this.env.NODE_ENV === "production"))
    ) return ipKey;
    return `user:${user.id}`;
  }
  // A banned account  can still sign in, export, erase and log out, as
  // the privacy notice promises; every other route answers ACCOUNT_BANNED.
  require(req: FastifyRequest, opts: { allowBanned?: boolean } = {}): User {
    const row = this.store.db
      .prepare("SELECT user_id FROM sessions WHERE hash=? AND expires_at>?")
      .get(digest(this.token(req)), Date.now()) as
      | { user_id: string }
      | undefined;
    if (!row) throw new AppError(401, "SESSION_EXPIRED", "登录状态已失效");
    const user = this.store.getUser(row.user_id);
    if (!user) throw new AppError(401, "SESSION_EXPIRED", "登录状态已失效");
    if (
      user.authMode !== "wechat" &&
      (!this.env.DEV_LOGIN_ENABLED || this.env.NODE_ENV === "production")
    )
      throw new AppError(401, "DEV_LOGIN_DISABLED", "开发登录已停用");
    if (!opts.allowBanned && this.store.control(user.id).bannedAt)
      throw new AppError(
        403,
        "ACCOUNT_BANNED",
        "账号已被停用。你仍可以在“我的”里导出数据或注销账号，如有疑问请联系维护者",
      );
    bindCallUser(user.id);
    return user;
  }
  logout(req: FastifyRequest) {
    const user = this.require(req, { allowBanned: true });
    this.store.transaction(() => {
      this.store.db
        .prepare("DELETE FROM sessions WHERE hash=?")
        .run(digest(this.token(req)));
      this.store.audit(user.id, "session.revoked", user.id);
    });
  }
  admin(req: FastifyRequest) {
    if (!this.env.ADMIN_API_KEY)
      throw new AppError(503, "ADMIN_DISABLED", "管理入口未配置");
    this.adminSessions.assertOrigin(req);
    if (req.headers["x-admin-key"] !== undefined) {
      // Explicit machine credentials are not ambient cookies; retain this
      // path for monitoring/automation. The web console uses short sessions.
      // Wrong keys are limited per address and audited, like console logins.
      this.keyFailures.assert(req.ip);
      try {
        this.adminKey(req.headers["x-admin-key"]);
      } catch (error) {
        this.keyFailures.fail(req.ip);
        this.store.audit("admin:shared", "admin.key.failed", "admin-api", {
          requestId: req.id,
        });
        throw error;
      }
      return;
    }
    this.adminSessions.require(req);
  }
  adminKey(candidate: unknown) {
    const expected = this.env.ADMIN_API_KEY;
    if (!expected) throw new AppError(503, "ADMIN_DISABLED", "管理入口未配置");
    if (
      typeof candidate !== "string" ||
      !timingSafeEqual(
        Buffer.from(digest(candidate)),
        Buffer.from(digest(expected)),
      )
    )
      throw new AppError(401, "ADMIN_AUTH_REQUIRED", "管理员凭证无效");
  }
}
