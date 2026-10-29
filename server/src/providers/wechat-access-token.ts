import { AppError } from "../shared/domain.js";

/** Server-only stable access token, coalescing concurrent refreshes. */
export class WechatAccessToken {
  private cached?: { value: string; until: number };
  private pending?: Promise<string>;
  constructor(private readonly opts: {
    appId: string; appSecret: string; fetcher?: typeof fetch; now?: () => number;
  }) {}
  get(): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && now < this.cached.until) return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending;
    const request = this.refresh().finally(() => { if (this.pending === request) this.pending = undefined; });
    this.pending = request;
    return request;
  }
  private async refresh() {
    const failure = () => new AppError(503, "WECHAT_TOKEN_UNAVAILABLE", "微信服务暂不可用，请稍后再试");
    let response: Response;
    try {
      response = await (this.opts.fetcher ?? fetch)("https://api.weixin.qq.com/cgi-bin/stable_token", {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ grant_type: "client_credential", appid: this.opts.appId, secret: this.opts.appSecret, force_refresh: false }),
      });
    } catch { throw failure(); }
    if (!response.ok) throw failure();
    let raw: unknown;
    try { raw = await response.json(); } catch { throw failure(); }
    const body = raw as { access_token?: unknown; expires_in?: unknown; errcode?: unknown } | null;
    if (!body || (body.errcode !== undefined && body.errcode !== 0) || typeof body.access_token !== "string" ||
      !body.access_token || typeof body.expires_in !== "number" || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0)
      throw failure();
    this.cached = { value: body.access_token, until: (this.opts.now ?? Date.now)() + Math.max(0, body.expires_in - 60) * 1000 };
    return this.cached.value;
  }
}
