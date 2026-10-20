import { z } from "zod";
import { type LlmClient, ProviderError } from "./llm.js";
import { OcrError, type OcrErrorCode, type OcrResult } from "./tencent-ocr.js";

const PROMPT =
  '你是文字识别引擎。只输出一个 JSON 对象 {"paragraphs": string[]}。按阅读顺序转写图片里的全部文字：保持原文，不改写、不解题、不补全，标点照原样（中文的全角标点仍写全角）；同一段里因排版换行断开的句子接成一行，段与段分开。算式照原样写，上标用 ²、³ 或 ^ 表示。看不清的字写 □。图片里没有文字时输出 {"paragraphs": []}。';
const schema = z.object({ paragraphs: z.array(z.string()).max(200) });
const CODES: Record<string, OcrErrorCode> = {
  AI_NOT_CONFIGURED: "OCR_NOT_CONFIGURED",
  AI_TIMEOUT: "OCR_TIMEOUT",
  AI_UNAVAILABLE: "OCR_UNAVAILABLE",
  AI_BUSY: "OCR_UNAVAILABLE",
  AI_AUTH: "OCR_AUTH",
};
const MESSAGES: Partial<Record<OcrErrorCode, string>> = {
  OCR_NOT_CONFIGURED: "这张图没认出来，换一张或者直接打字",
  OCR_TIMEOUT: "认图有点慢，过会儿再试，或者直接打字",
  OCR_UNAVAILABLE: "现在认不了图，过会儿再试，或者直接打字",
  OCR_AUTH: "这张图没认出来，换一张或者直接打字",
  OCR_FAILED: "这张图没认出来，换一张或者直接打字",
};
const mimeOf = (image: Buffer) =>
  image[0] === 0x89 && image[1] === 0x50 ? "image/png" : "image/jpeg";
// GLM rejects BMP ("图片输入格式/解析错误"), so refuse it without a model call.
const isBmp = (image: Buffer) => image[0] === 0x42 && image[1] === 0x4d;

// OCR through a multimodal chat model; used when Tencent OCR has no keys.
// Each transcribed paragraph becomes one line with its own paragraph number.
export class VisionOcr {
  constructor(private readonly model: LlmClient) {}
  get configured() {
    return this.model.configured;
  }
  async recognize(image: Buffer, signal?: AbortSignal): Promise<OcrResult> {
    if (isBmp(image))
      throw new OcrError(
        "OCR_BAD_IMAGE",
        "BMP 图认不了，换成 JPG 或 PNG，或者直接打字",
      );
    try {
      const { data, usage } = await this.model.json(
        [
          { role: "system", content: PROMPT },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeOf(image)};base64,${image.toString("base64")}`,
                },
              },
              { type: "text", text: "转写这张图片里的文字。" },
            ],
          },
        ],
        schema,
        signal,
      );
      return {
        lines: data.paragraphs.map((text, paragraph) => ({
          text,
          confidence: null,
          paragraph,
        })),
        requestId: "",
        usage,
      };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const code = CODES[error.code] ?? "OCR_FAILED";
      throw Object.assign(
        new OcrError(code, MESSAGES[code]!, error.billing, { cause: error }),
        { usage: (error as { usage?: unknown }).usage },
      );
    }
  }
}
