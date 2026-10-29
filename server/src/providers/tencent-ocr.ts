import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { UsageMeter } from "../shared/usage-ledger.js";
import { boundedResponseText } from "./response-limits.js";
import type { CommercialMeter } from "../shared/commercial-meter.js";

export type OcrLine = {
  text: string;
  confidence: number | null;
  paragraph: number | null;
};
// usage: provider-specific accounting; the OCR job stores it as the job's usage.
export type OcrResult = {
  lines: OcrLine[];
  requestId: string;
  usage?: unknown;
};
export type OcrProvider = {
  readonly configured: boolean;
  recognize(image: Buffer, signal?: AbortSignal): Promise<OcrResult>;
};

export type OcrErrorCode =
  | "OCR_NOT_CONFIGURED"
  | "OCR_TIMEOUT"
  | "OCR_UNAVAILABLE"
  | "OCR_AUTH"
  | "OCR_QUOTA"
  | "OCR_BAD_IMAGE"
  | "OCR_FAILED";

export class OcrError extends Error {
  constructor(
    readonly code: OcrErrorCode,
    message: string,
    readonly billing: "none" | "unknown" = "none",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OcrError";
  }
}

export type Tc3Input = {
  secretId: string;
  secretKey: string;
  service: string;
  host: string;
  action: string;
  timestamp: number; // seconds
  payload: string;
};

const CONTENT_TYPE = "application/json; charset=utf-8";
const SIGNED_HEADERS = "content-type;host;x-tc-action";
const sha256Hex = (data: string) =>
  createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** TC3-HMAC-SHA256 (Tencent Cloud API 3.0) signature for a JSON POST to "/". */
export function tc3Sign(input: Tc3Input) {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10); // must be UTC
  const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${input.host}\nx-tc-action:${input.action.toLowerCase()}\n`;
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    SIGNED_HEADERS,
    sha256Hex(input.payload),
  ].join("\n");
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const scope = `${date}/${input.service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(input.timestamp),
    scope,
    hashedCanonicalRequest,
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(`TC3${input.secretKey}`, date), input.service),
    "tc3_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;
  return {
    canonicalRequest,
    hashedCanonicalRequest,
    stringToSign,
    signature,
    authorization,
  };
}

const responseSchema = z.object({
  Response: z.object({
    RequestId: z.string().default(""),
    Error: z
      .object({ Code: z.string(), Message: z.string().optional() })
      .optional(),
    TextDetections: z
      .array(
        z.object({
          DetectedText: z.string(),
          Confidence: z.number().nullish(),
          AdvancedInfo: z.string().nullish(),
        }),
      )
      .nullish(),
  }),
});

function paragraphOf(advancedInfo: string | null | undefined): number | null {
  if (!advancedInfo) return null;
  try {
    const no: unknown = JSON.parse(advancedInfo)?.Parag?.ParagNo;
    return typeof no === "number" ? no : null;
  } catch {
    return null;
  }
}

const BAD_IMAGE_CODES = new Set([
  "FailedOperation.DownLoadError",
  "FailedOperation.EmptyImageError",
  "FailedOperation.ImageDecodeFailed",
  "FailedOperation.ImageSizeTooLarge",
  "LimitExceeded.TooLargeFileError",
]);

function apiError(code: string, message: string | undefined): OcrError {
  const detail = `（${code}${message ? `: ${message}` : ""}）`;
  if (code.startsWith("AuthFailure"))
    return new OcrError(
      "OCR_AUTH",
      `OCR 服务鉴权失败，请检查密钥配置${detail}`,
    );
  // Checked before the LimitExceeded.* quota prefix: TooLargeFileError is about the image.
  if (BAD_IMAGE_CODES.has(code) || code.startsWith("InvalidParameterValue"))
    return new OcrError(
      "OCR_BAD_IMAGE",
      `图片无法识别，请检查图片格式或大小后重试${detail}`,
    );
  if (
    /^(ResourceUnavailable|ResourcesSoldOut|LimitExceeded|RequestLimitExceeded)/.test(
      code,
    )
  )
    return new OcrError(
      "OCR_QUOTA",
      `OCR 服务额度不足或请求过于频繁，请稍后再试${detail}`,
    );
  return new OcrError("OCR_FAILED", `文字识别失败${detail}`);
}

export type TencentOcrOptions = {
  secretId?: string;
  secretKey?: string;
  region?: string;
  endpoint?: string;
  timeoutMs: number;
  usageMeter?: UsageMeter;
  commercialMeter?: Pick<CommercialMeter, "run">;
};

export class TencentOcr {
  private readonly region: string;
  private readonly endpoint: string;

  constructor(
    private readonly opts: TencentOcrOptions,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.region = opts.region || "ap-guangzhou";
    this.endpoint = opts.endpoint || "ocr.tencentcloudapi.com";
  }

  get configured(): boolean {
    return Boolean(this.opts.secretId && this.opts.secretKey);
  }

  async recognize(image: Buffer, signal?: AbortSignal): Promise<OcrResult> {
    const invoke = () => this.recognizeNow(image, signal);
    return this.opts.commercialMeter
      ? this.opts.commercialMeter.run(
          {
            kind: "ocr",
            provider: this.endpoint,
            model: "GeneralBasicOCR",
            source: "ocr.tencent",
          },
          invoke,
          () => ({ requests: 1 }),
          signal,
        )
      : invoke();
  }

  private async recognizeNow(image: Buffer, signal?: AbortSignal): Promise<OcrResult> {
    const { secretId, secretKey, timeoutMs } = this.opts;
    if (!secretId || !secretKey)
      throw new OcrError("OCR_NOT_CONFIGURED", "现在认不了图，过会儿再试，或者直接打字");

    const action = "GeneralBasicOCR";
    const payload = JSON.stringify({
      ImageBase64: image.toString("base64"),
      LanguageType: "zh",
    });
    const timestamp = Math.floor(this.now() / 1000);
    const { authorization } = tc3Sign({
      secretId,
      secretKey,
      service: "ocr",
      host: this.endpoint,
      action,
      timestamp,
      payload,
    });
    const timeout = AbortSignal.timeout(timeoutMs);

    let status: number;
    let body: unknown;
    signal?.throwIfAborted();
    const finishUsage = this.opts.usageMeter?.start({
      source: "ocr.tencent",
      provider: this.endpoint,
      model: action,
    });
    try {
      const res = await this.fetcher(`https://${this.endpoint}/`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": CONTENT_TYPE,
          Host: this.endpoint,
          "X-TC-Action": action,
          "X-TC-Version": "2018-11-19",
          "X-TC-Timestamp": String(timestamp),
          "X-TC-Region": this.region,
        },
        body: payload,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      status = res.status;
      const text = await boundedResponseText(res);
      try { body = JSON.parse(text); } catch { body = null; }
      const api = body as { Response?: { Error?: { Code?: string } } } | null;
      finishUsage?.({
        status: res.ok && !api?.Response?.Error ? "succeeded" : "failed",
      });
    } catch (error) {
      finishUsage?.({ status: "unknown" });
      if (signal?.aborted) throw error; // caller's own abort, not ours to reinterpret
      if (timeout.aborted)
        throw new OcrError(
          "OCR_TIMEOUT",
          "文字识别超时，请稍后重试",
          "unknown",
          { cause: error },
        );
      // The request may have reached the server before the connection failed.
      throw new OcrError(
        "OCR_UNAVAILABLE",
        "OCR 服务暂时不可用，请稍后重试",
        "unknown",
        { cause: error },
      );
    }

    if (status >= 500)
      throw new OcrError(
        "OCR_UNAVAILABLE",
        `OCR 服务暂时不可用（HTTP ${status}），请稍后重试`,
      );
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success)
      throw new OcrError(
        "OCR_FAILED",
        `文字识别返回了无法解析的结果（HTTP ${status}）`,
      );
    const {
      RequestId: requestId,
      Error: err,
      TextDetections,
    } = parsed.data.Response;
    if (err?.Code === "FailedOperation.ImageNoText")
      return { lines: [], requestId };
    if (err) throw apiError(err.Code, err.Message);
    const lines = (TextDetections ?? []).map((d) => ({
      text: d.DetectedText,
      confidence: d.Confidence ?? null,
      paragraph: paragraphOf(d.AdvancedInfo),
    }));
    return { lines, requestId };
  }
}
