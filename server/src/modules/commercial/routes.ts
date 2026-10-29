import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthService } from "../auth/service.js";
import type { CommercialBilling } from "../../shared/commercial-billing.js";
import { AppError } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { commercialAllowances } from "./settings.js";
import {
  receivePlaintextGoodsDelivery,
  receiveSecureGoodsDelivery,
  type PaymentEventFormat,
} from "./payment-events.js";
import { CallbackSignatureError, createDirectGoodsPayment, verifyPlaintextCallback } from "./virtual-payment.js";
import { CommercialCatalog, PUBLISHED_COMMERCIAL_GOODS } from "./catalog.js";
import { planChain, quotePlan } from "./plan-chain.js";
import { CommercialOrders } from "./orders.js";
import { createCommercialRuntime, type CommercialPaymentConfig } from "./runtime.js";
import { now as businessNow, type Clock } from "../../shared/time.js";

type Dependencies = {
  auth: Pick<AuthService, "require" | "wechatPaymentSession">;
  store: SqliteStore;
  billing: Pick<CommercialBilling, "accounts" | "pricing">;
  config?: CommercialPaymentConfig;
  clock?: Clock;
};

const purchaseSchema = z.object({
  ageBand: z.enum(["14_17", "adult"]),
  guardianConsent: z.literal(true).optional(),
}).strict();
const createSchema = z.object({
  productId: z.string().min(1).max(128),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  purchase: purchaseSchema,
  /** wx.getSystemInfoSync().platform; plan upgrades need a non-iOS value. */
  platform: z.string().trim().toLowerCase().min(1).max(32).optional(),
}).strict();
const platformQuery = z.object({
  platform: z.string().trim().toLowerCase().min(1).max(32).optional(),
}).passthrough();
const iso = (ms: number) => new Date(ms).toISOString();

const queryText = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.length || value.length > 4096)
    throw new AppError(400, "CALLBACK_INVALID", `${name}无效`);
  return value;
};
const bodyText = (req: FastifyRequest) => {
  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody;
  if (typeof raw === "string" && raw.length) return raw;
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  throw new AppError(400, "CALLBACK_INVALID", "支付通知内容无效");
};
const unavailable = (): never => {
  throw new AppError(503, "COMMERCIAL_PAYMENT_NOT_CONFIGURED", "支付功能尚未配置");
};
const ackType = (format: PaymentEventFormat) => format === "json" ? "application/json" : "application/xml";
const usableConfig = (value: CommercialPaymentConfig | undefined): value is CommercialPaymentConfig =>
  Boolean(value && value.offerId && value.appKey && value.callbackToken &&
    typeof value.getAccessToken === "function" &&
    (value.callbackFormat === "json" || value.callbackFormat === "xml") &&
    (value.callbackMode === "plaintext" ||
      (value.callbackMode === "secure" && value.appId &&
        typeof value.encodingAesKey === "string" && /^[A-Za-z0-9+/]{43}$/.test(value.encodingAesKey))));

export function registerCommercialRoutes(app: FastifyInstance, deps: Dependencies) {
  for (const contentType of ["application/xml", "text/xml"])
    if (!app.hasContentTypeParser(contentType))
      app.addContentTypeParser(contentType, { parseAs: "string" }, (_req, body, done) => done(null, body));
  const catalog = new CommercialCatalog(deps.store);
  const paymentConfig = usableConfig(deps.config) ? deps.config : undefined;
  const runtime = paymentConfig ? createCommercialRuntime({
    store: deps.store,
    billing: deps.billing,
    config: paymentConfig,
    clock: deps.clock,
    logger: app.log,
  }) : undefined;
  const orders = runtime?.orders ?? new CommercialOrders(deps.store, catalog, deps.clock ?? businessNow);
  const configured = (): { runtime: NonNullable<typeof runtime>; config: CommercialPaymentConfig } => {
    if (!runtime || !paymentConfig) unavailable();
    return { runtime: runtime!, config: paymentConfig! };
  };

  app.get("/v1/commercial/catalog", async () => ({
    data: catalog.list().map(item => {
      const available = item.purchasable ? catalog.require(item.id) : undefined;
      const platform = (name: "android" | "ios") => {
        const benefits = available?.[name];
        if (!benefits) return null;
        const freeWeek = commercialAllowances(deps.store).freeWeekCredits;
        return item.kind === "plan"
          ? { weeklyMultiplier: freeWeek > 0 ? Math.round(benefits.weeklyCredits! / freeWeek) || null : null }
          : { credits: benefits.credits };
      };
      return {
        ...item,
        purchasable: item.purchasable && Boolean(runtime) && deps.billing.accounts.enabled(),
        platforms: { android: platform("android"), ios: platform("ios") },
      };
    }),
  }));

  app.get("/v1/commercial/account", async req => {
    const user = deps.auth.require(req);
    const rate = deps.billing.pricing.snapshot("account", "account", "jev").microyuanPerCredit;
    const { platform } = platformQuery.parse(req.query ?? {});
    const at = (deps.clock ?? businessNow)().getTime();
    const chain = planChain(deps.store, user.id, at);
    const current = chain.goodId ? PUBLISHED_COMMERCIAL_GOODS.find(good => good.id === chain.goodId) : undefined;
    return {
      data: {
        ...deps.billing.accounts.view(user.id, rate),
        // The plan chain as one card: highest tier, last expiry, queued periods.
        planChain: current && chain.endsAt !== null ? {
          goodId: current.id,
          name: current.name,
          expiresAt: iso(chain.endsAt),
          queued: chain.segments.filter(item => item.startsAt > at).length,
        } : null,
        // What each plan would do right now; order creation recomputes it.
        planQuotes: PUBLISHED_COMMERCIAL_GOODS.filter(good => good.kind === "plan").map(good => {
          const quote = quotePlan(deps.store, user.id, good, at, platform);
          return {
            goodId: quote.goodId,
            action: quote.action,
            priceCents: quote.priceCents,
            listPriceCents: quote.listPriceCents,
            startsAt: iso(quote.startsAt),
            expiresAt: iso(quote.expiresAt),
            reason: quote.reason,
          };
        }),
      },
    };
  });

  app.post("/v1/commercial/wallet-consent", async req => {
    const user = deps.auth.require(req);
    z.object({ consent: z.literal(true) }).strict().parse(req.body);
    deps.billing.accounts.consentWallet(user.id);
    const rate = deps.billing.pricing.snapshot("account", "account", "jev").microyuanPerCredit;
    return { data: deps.billing.accounts.view(user.id, rate) };
  });

  app.post("/v1/commercial/orders", async req => {
    const { runtime, config } = configured();
    if (!deps.billing.accounts.enabled()) unavailable();
    const body = createSchema.parse(req.body);
    const { user, sessionKey } = deps.auth.wechatPaymentSession(req);
    const order = runtime.orders.create(user.id, body.productId, body.idempotencyKey, body.purchase, {
      ...(body.platform === undefined ? {} : { platform: body.platform }),
    });
    if (order.status !== "created")
      throw new AppError(409, "ORDER_ALREADY_COMPLETED", "订单已完成，不能再次支付");
    const payment = createDirectGoodsPayment({
      offerId: config.offerId,
      productId: order.goodId,
      goodsPrice: order.listPriceCents,
      ...(order.amountCents < order.listPriceCents ? { activitySellingPrice: order.amountCents } : {}),
      outTradeNo: order.id,
      attach: order.id,
      appKey: config.appKey,
      sessionKey,
    });
    return { data: { order, payment } };
  });

  app.get("/v1/commercial/orders", async req => {
    const user = deps.auth.require(req);
    return { data: orders.list(user.id) };
  });

  app.get("/v1/commercial/orders/:id", async req => {
    const user = deps.auth.require(req);
    const id = queryText((req.params as { id?: unknown }).id, "订单号");
    return { data: orders.detail(user.id, id) };
  });

  app.post("/v1/commercial/orders/:id/sync", async req => {
    const { runtime } = configured();
    const user = deps.auth.require(req);
    const id = queryText((req.params as { id?: unknown }).id, "订单号");
    runtime.orders.detail(user.id, id);
    return { data: await runtime.reconciliation.reconcile(runtime.target(id, user.id)) };
  });

  app.get("/v1/commercial/wechat/callback", async (req, reply) => {
    const { config } = configured();
    const query = req.query as Record<string, unknown>;
    const timestamp = queryText(query.timestamp, "timestamp");
    const nonce = queryText(query.nonce, "nonce");
    const echo = queryText(query.echostr, "echostr");
    // URL verification carries a plain signature and echostr in every mode;
    // msg_signature and Encrypt only appear on the later POST pushes.
    const signature = queryText(query.signature, "signature");
    if (!verifyPlaintextCallback({ token: config.callbackToken, signature, timestamp, nonce }))
      throw new AppError(403, "CALLBACK_SIGNATURE_INVALID", "回调签名无效");
    return reply.type("text/plain").send(echo);
  });

  app.post("/v1/commercial/wechat/callback", async (req, reply) => {
    const { runtime, config } = configured();
    const query = req.query as Record<string, unknown>;
    const timestamp = queryText(query.timestamp, "timestamp");
    const nonce = queryText(query.nonce, "nonce");
    const common = {
      orders: runtime.orders,
      verifyPayment: runtime.verifyCallbackPayment,
      token: config.callbackToken,
      timestamp,
      nonce,
      body: bodyText(req),
      observe: runtime.handleCallbackEvent,
    };
    const callback = config.callbackMode === "secure"
      ? receiveSecureGoodsDelivery({
          ...common,
          encodingAesKey: config.encodingAesKey ?? unavailable(),
          appId: config.appId ?? unavailable(),
          signature: queryText(query.msg_signature, "msg_signature"),
          format: config.callbackFormat,
        })
      : receivePlaintextGoodsDelivery({
          ...common,
          signature: queryText(query.signature, "signature"),
          format: config.callbackFormat,
        });
    const result = await callback.catch(error => {
      if (error instanceof CallbackSignatureError)
        throw new AppError(403, "CALLBACK_SIGNATURE_INVALID", "回调签名无效");
      throw error;
    });
    return reply
      .type(config.callbackMode === "secure" ? "text/plain" : ackType(config.callbackFormat))
      .send(result.acknowledgement);
  });

  return Object.freeze({
    runtime,
    pollPending: (limit?: number) => runtime ? runtime.pollPending(limit) : unavailable(),
  });
}
