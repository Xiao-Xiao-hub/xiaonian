/*
 * 对话与学习工具接口层：把 HTTP 路径、查询和请求体转换为服务调用。
 * 从 auth 获取当前用户，并校验外部输入；数据归属、版本和状态转换仍由对应服务负责。
 * 新增接口时同步维护 API 文档，并在 tests 中验证正常流程与权限、版本冲突等边界。
 */
import type { FastifyInstance } from "fastify";
import { finishUpload } from "../../shared/upload-admission.js";
import type { ServerResponse } from "node:http";
import { z, ZodError } from "zod";
import { AppError } from "../../shared/domain.js";
import { safeError } from "../../shared/logging.js";
import { rejectionEvent } from "../../shared/request-safety.js";
import { onResponseEnd } from "../../shared/response-lifecycle.js";
import type { AuthService } from "../auth/service.js";
import { CARD_FOLLOWS } from "../cards/types.js";
import { IMAGE_LIMIT } from "../materials/service.js";
import { INK, toneSchema } from "../render/routes.js";
import { ATTACH_FILE_LIMIT, type ChatEvent, type ChatService } from "./service.js";
const idParams = z.object({ id: z.string().min(1).max(64) });
const clientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const toneQuery = z.object({ tone: toneSchema }).passthrough();
const sendBody = z
  .object({
    threadId: z.string().min(1).max(64).optional(),
    text: z.string().max(2000).optional(),
    problem: z
      .object({
        text: z.string().trim().min(1).max(1500),
        // a photo has up to 8 problems: one asked, 7 left.
        pending: z.array(z.string().trim().min(1).max(1500)).max(7).optional(),
      })
      .strict()
      .optional(),
    imageId: z.string().min(1).max(64).optional(),
    attachmentIds: z.array(z.string().min(1).max(64)).max(4).optional(),
    steps: z.array(z.string().trim().min(1).max(500)).min(1).max(40).optional(),
    mode: z.enum(["auto", "solution", "grade"]).default("auto"),
    entry: z.literal("jot").optional(),
    origin: z.literal("solve").optional(),
    sceneChoice: z.enum(["life", "mood"]).optional(),
    cardIds: z.array(z.string().min(1).max(80)).max(3).optional(),
    teachDone: z.boolean().optional(),
    // 拍一道题 → 做到一半卡住 : hint from where the learner stopped.
    stuck: z.boolean().optional(),
    quote: z.string().trim().min(1).max(500).optional(),
    clientId,
    tone: toneSchema,
  })
  .strict();
// The mini program decodes chunks byte by byte (iOS has no TextDecoder), so every
// frame is pure ASCII: non-ASCII characters travel as \uXXXX escapes.
export const ascii = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
export const sseFrame = (event: ChatEvent | string) =>
  `data: ${typeof event === "string" ? event : ascii(event)}\n\n`;
export function writeSse(raw: Pick<ServerResponse, "writableLength" | "write" | "destroy">, frame: string) {
  // Stop retaining output for a client that has stopped reading. The answer
  // continues in its bounded provider slot and can be reopened from history.
  if (raw.writableLength + Buffer.byteLength(frame) > 262144) {
    raw.destroy();
    return false;
  }
  raw.write(frame);
  return true;
}
const failure = (error: unknown) => {
  if (error instanceof AppError)
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  if (error instanceof ZodError)
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      message: "填的内容不太对，再看一下",
    };
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "出了点问题，过一会儿再试",
  };
};
export function registerChatRoutes(
  app: FastifyInstance,
  deps: { auth: AuthService; chat: ChatService },
) {
  const { auth, chat } = deps;
  const streams = new Map<string, number>();
  let streamCount = 0;
  const ink = (tone: "light" | "dark") => INK[tone];
  // Server-sent events over a POST; the answer keeps going (and is saved) even if
  // the phone drops the connection, so reopening the thread shows it.
  app.post(
    "/v1/chat/send",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const user = auth.require(req);
      const body = sendBody.parse(req.body);
      if (streamCount >= 64 || (streams.get(user.id) ?? 0) >= 2)
        throw new AppError(429, "STREAM_BUSY", "当前对话较多，请稍后再试");
      streamCount++;
      streams.set(user.id, (streams.get(user.id) ?? 0) + 1);
      reply.hijack();
      const raw = reply.raw;
      let started = false,
        open = true;
      let released = false;
      let idle: NodeJS.Timeout | undefined, lifetime: NodeJS.Timeout | undefined;
      const release = () => {
        if (released) return;
        released = true;
        open = false;
        clearTimeout(idle);
        clearTimeout(lifetime);
        streamCount--;
        const remaining = (streams.get(user.id) ?? 1) - 1;
        if (remaining) streams.set(user.id, remaining);
        else streams.delete(user.id);
      };
      const finish = onResponseEnd(raw, release);
      // A dead connection must not start a new generation. Already running
      // answers retain their provider/billing bounds and are saved to history.
      if (!open) return;
      const closeSlow = () => {
        finish();
        raw.destroy();
        req.log.warn({ event: "stream_timeout", route: "/v1/chat/send" }, "stream closed");
      };
      idle = setTimeout(closeSlow, 180_000);
      lifetime = setTimeout(closeSlow, 1_800_000);
      idle.unref();
      lifetime.unref();
      const emit = (event: ChatEvent) => {
        if (!open) return;
        idle?.refresh();
        if (!started) {
          started = true;
          raw.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
            "x-request-id": req.id,
          });
        }
        if (!writeSse(raw, sseFrame(event))) finish();
      };
      try {
        await chat.send(user.id, { ...body, tone: ink(body.tone) }, emit);
        chat.finishSendBilling(true);
      } catch (error) {
        try {
          chat.finishSendBilling(false);
        } catch (billingError) {
          req.log.error(
            { ...safeError(billingError), requestId: req.id },
            "chat billing release failed",
          );
        }
        const f = failure(error);
        const event = rejectionEvent(f.status, f.code, "/v1/chat/send");
        if (event) req.log.warn({ event, code: f.code, route: "/v1/chat/send", status: f.status }, "chat request rejected");
        if (f.status >= 500)
          req.log.error(
            { ...safeError(error), requestId: req.id },
            "chat send failed",
          );
        if (!started) {
          if (open) {
            raw.writeHead(f.status, {
              "content-type": "application/json; charset=utf-8",
              "x-request-id": req.id,
            });
            raw.end(
              ascii({ code: f.code, message: f.message, requestId: req.id }),
            );
          }
          return;
        }
        emit({ e: "error", code: f.code, message: f.message });
      } finally {
        try {
          if (open && !raw.writableEnded) raw.end(sseFrame("[DONE]"));
        } finally { finish(); }
      }
    },
  );
  app.get("/v1/chat/threads", async (req) => {
    const user = auth.require(req);
    // kind : 聊一聊 lists "chat", the 解题 page "solve"; left out, all of them.
    // tool (ask / grade / teach) for one study tool's history,
    // before (an updatedAt) for the page after it.
    // V4.2 : limit / cardId / q (words in the title) narrow it; any of
    // before / limit / cardId / q adds `next` (the before for the following
    // page, null at the end). `next` is opaque ("updatedAt|id");
    // before still takes a plain updatedAt.
    const { kind, tool, before, limit, cardId, q } = z
      .object({
        kind: z.enum(["chat", "solve"]).optional(),
        tool: z.enum(["ask", "grade", "teach"]).optional(),
        before: z.string().min(1).max(160).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cardId: z.string().min(1).max(80).optional(),
        q: z.string().trim().min(1).max(40).optional(),
      })
      .passthrough()
      .parse(req.query ?? {});
    const threads = chat.list(user.id, kind, tool, before, { limit, cardId, q });
    const paged =
      limit !== undefined || before !== undefined || cardId !== undefined || q !== undefined;
    const full = threads.length === Math.min(100, limit ?? 100);
    return {
      data: {
        threads,
        usage: chat.usage(user.id),
        ...(paged
          ? {
              next: full
                ? `${threads.at(-1)!.updatedAt}|${threads.at(-1)!.id}`
                : null,
            }
          : {}),
      },
    };
  });
  app.post("/v1/chat/threads", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        entry: z.literal("jot").optional(),
        text: z.string().trim().min(1).max(2000).optional(),
        mode: z.enum(["guide", "teach"]).optional(),
        cardIds: z.array(z.string().min(1).max(80)).max(3).optional(),
        pointId: z.string().min(1).max(80).optional(),
        brainstormId: z.string().min(1).max(80).optional(),
        origin: z.literal("solve").optional(),
        // 讲一遍 on the learner's own topic, without a map point.
        topic: z.string().trim().min(1).max(60).optional(),
        tone: toneSchema,
      })
      .strict()
      .parse(req.body ?? {});
    return {
      data: {
        thread: await chat.createGuideThread(user.id, body.entry, body.text, {
          mode: body.mode,
          cardIds: body.cardIds,
          pointId: body.pointId,
          brainstormId: body.brainstormId,
          origin: body.origin,
          topic: body.topic,
        }),
      },
    };
  });
  app.patch("/v1/chat/threads/:id", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        scene: z.enum(["study", "life", "mood"]).optional(),
        mode: z.enum(["guide", "teach"]).optional(),
        // V4.2 : 先聊到这儿 (true), or taken back (false).
        ended: z.boolean().optional(),
        tone: toneSchema,
      })
      .strict()
      .refine(
        (value) =>
          value.scene !== undefined ||
          value.mode !== undefined ||
          value.ended !== undefined,
      )
      .parse(req.body ?? {});
    const id = idParams.parse(req.params).id;
    if (body.scene === undefined && body.mode === undefined)
      return {
        data: { thread: await chat.setEnded(user.id, id, body.ended!, ink(body.tone)) },
      };
    const thread = await chat.setScene(user.id, id, body.scene, ink(body.tone), body.mode);
    return {
      data: {
        thread:
          body.ended === undefined
            ? thread
            : await chat.setEnded(user.id, id, body.ended, ink(body.tone)),
      },
    };
  });
  app.put("/v1/chat/threads/:id/cards", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        cardIds: z.array(z.string().min(1).max(80)).max(3),
        dismissIds: z.array(z.string().min(1).max(80)).max(100).optional(),
        tone: toneSchema,
      })
      .strict()
      .parse(req.body ?? {});
    return {
      data: {
        thread: await chat.setCards(
          user.id,
          idParams.parse(req.params).id,
          body.cardIds,
          body.dismissIds ?? [],
          ink(body.tone),
        ),
      },
    };
  });
  app.post("/v1/chat/threads/:id/suggest-cards", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        text: z.string().max(2000).optional(),
        omitIds: z.array(z.string().min(1).max(80)).max(100).optional(),
        dismissIds: z.array(z.string().min(1).max(80)).max(100).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return {
      data: {
        cards: await chat.suggestCards(
          user.id,
          idParams.parse(req.params).id,
          body.text,
          body.omitIds ?? body.dismissIds ?? [],
        ),
      },
    };
  });
  app.post("/v1/chat/threads/:id/wrap", async (req) => {
    const user = auth.require(req),
      threadId = idParams.parse(req.params).id;
    const body = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("open") }).strict(),
        z.object({ action: z.literal("dismiss") }).strict(),
        z
          .object({
            action: z.literal("save"),
            draftId: z.string().min(1).max(80),
            picks: z.array(z.string().min(1).max(40)).min(1).max(3),
            edits: z
              .array(
                z
                  .object({
                    key: z.string().min(1).max(40),
                    title: z.string().max(16),
                  })
                  .strict(),
              )
              .max(3)
              .optional(),
            mine: z.string().max(300).optional(),
            next: z
              .object({ if: z.string().max(100), then: z.string().max(100) })
              .strict()
              .nullable()
              .optional(),
            // V4.2 : the save page's reminder choice, saved with the cards.
            follow: z.enum(CARD_FOLLOWS).optional(),
            remindEvery: z.enum(["day", "week"]).optional(),
          })
          .strict(),
      ])
      .parse(req.body ?? {});
    if (body.action === "dismiss") return { data: { dismissed: true } };
    return {
      data:
        body.action === "open"
          ? await chat.openWrap(user.id, threadId)
          : await chat.saveWrap(user.id, threadId, body),
    };
  });
  app.get("/v1/me/suggest-cards", async (req) => ({
    data: chat.suggestSetting(auth.require(req).id),
  }));
  app.put("/v1/me/suggest-cards", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(req.body ?? {});
    return { data: chat.setSuggestSetting(user.id, body.enabled) };
  });
  app.get("/v1/chat/threads/:id", async (req) => {
    const user = auth.require(req);
    const { tone } = toneQuery.parse(req.query);
    return {
      data: await chat.thread(
        user.id,
        idParams.parse(req.params).id,
        ink(tone),
      ),
    };
  });
  app.delete("/v1/chat/threads/:id", async (req) => {
    const user = auth.require(req);
    chat.remove(user.id, idParams.parse(req.params).id);
    return { data: { deleted: true } };
  });
  app.get("/v1/chat/messages/:id", async (req) => {
    const user = auth.require(req);
    const { tone } = toneQuery.parse(req.query);
    return {
      data: await chat.messageView(
        user.id,
        idParams.parse(req.params).id,
        ink(tone),
      ),
    };
  });
  app.get("/v1/chat/usage", async (req) => {
    const user = auth.require(req);
    return { data: chat.usage(user.id) };
  });
  // wx.uploadFile sends multipart/form-data; the skin tone travels in the query.
  app.post(
    "/v1/chat/scan",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      const { tone } = toneQuery.parse(req.query);
      // the tool the photo was taken in; left out, as before.
      const { purpose } = z
        .object({
          purpose: z.enum(["problem", "draft", "homework", "grade"]).optional(),
        })
        .passthrough()
        .parse(req.query ?? {});
      let data: Buffer;
      try {
        const file = await req.file({
          limits: { fileSize: IMAGE_LIMIT, files: 1 },
        });
        if (!file) throw new AppError(400, "IMAGE_REQUIRED", "选一张照片");
        data = await file.toBuffer();
      } catch (error) {
        if (error instanceof AppError) throw error;
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE")
          throw new AppError(
            413,
            "IMAGE_TOO_LARGE",
            "照片太大了，裁小一点再试",
          );
        if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE")
          throw new AppError(400, "IMAGE_REQUIRED", "选一张照片");
        throw error;
      } finally {
        finishUpload(req);
      }
      return { data: await chat.scan(user.id, data, ink(tone), purpose) };
    },
  );
  // A photo or a document for the next message. wx.uploadFile names the
  // part after the temp file, so the real file name travels in the query.
  app.post(
    "/v1/chat/attachments",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      const query = z
        .object({
          name: z.string().max(200).optional(),
          threadId: z.string().min(1).max(64).optional(),
          // V4.2 : read a document on from this character.
          from: z.coerce.number().int().min(0).max(10_000_000).optional(),
        })
        .passthrough()
        .parse(req.query ?? {});
      let data: Buffer, fallback: string;
      try {
        const file = await req.file({
          limits: { fileSize: ATTACH_FILE_LIMIT, files: 1, fields: 0 },
        });
        if (!file || file.fieldname !== "file")
          throw new AppError(400, "FILE_REQUIRED", "选一个文件吧");
        fallback = file.filename;
        data = await file.toBuffer();
      } catch (error) {
        if (error instanceof AppError) throw error;
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE")
          throw new AppError(
            413,
            "FILE_TOO_LARGE",
            "文件超过 10 MB，换一份小一点的",
          );
        if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE")
          throw new AppError(400, "FILE_REQUIRED", "选一个文件吧");
        throw error;
      } finally {
        finishUpload(req);
      }
      return {
        data: await chat.attach(user.id, {
          data,
          name: query.name?.trim() || fallback,
          threadId: query.threadId,
          from: query.from,
        }),
      };
    },
  );
  app.delete("/v1/chat/attachments/:id", async (req) => {
    const user = auth.require(req);
    const { id } = idParams.parse(req.params);
    chat.detach(user.id, id);
    return { data: { ok: true } };
  });
  // A page of homework, graded problem by problem in the background.
  app.post(
    "/v1/chat/homework",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      const body = z
        .object({ imageId: z.string().min(1).max(64), tone: toneSchema })
        .strict()
        .parse(req.body ?? {});
      return {
        data: await chat.homework(user.id, body.imageId, ink(body.tone)),
      };
    },
  );
  app.post("/v1/chat/threads/:id/homework/:index", async (req) => {
    const user = auth.require(req);
    const { id, index } = z
      .object({
        id: z.string().min(1).max(64),
        index: z.coerce.number().int().min(0).max(5),
      })
      .parse(req.params);
    // again : grade a graded problem once more after its reading
    // was corrected.
    const body = z
      .object({
        text: z.string().trim().min(1).max(1500).optional(),
        steps: z.array(z.string().trim().min(1).max(500)).min(1).max(40),
        again: z.boolean().optional(),
        tone: toneSchema,
      })
      .strict()
      .parse(req.body ?? {});
    return {
      data: await chat.gradeHomework(
        user.id,
        id,
        index,
        { text: body.text, steps: body.steps, again: body.again },
        ink(body.tone),
      ),
    };
  });
  // 整页作业 : put one graded problem of the page into 错题本 by hand.
  app.post("/v1/chat/threads/:id/homework/:index/mistake", async (req) => {
    const user = auth.require(req);
    const { id, index } = z
      .object({
        id: z.string().min(1).max(64),
        index: z.coerce.number().int().min(0).max(5),
      })
      .parse(req.params);
    const { tone } = z
      .object({ tone: toneSchema })
      .strict()
      .parse(req.body ?? {});
    return {
      data: await chat.homeworkMistake(user.id, id, index, ink(tone)),
    };
  });
  // 批改草稿 : one problem and its steps, graded step by step (JSON).
  app.post(
    "/v1/chat/drafts",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      const body = z
        .object({
          problem: z.string().trim().min(1).max(1500),
          steps: z
            .array(z.string().trim().min(1).max(500))
            .min(1)
            .max(40),
          imageId: z.string().min(1).max(64).optional(),
          // the same submission is graded once (a retry waits for it).
          clientId: clientId.optional(),
          tone: toneSchema,
        })
        .strict()
        .parse(req.body ?? {});
      return {
        data: await chat.gradeDraft(
          user.id,
          {
            problem: body.problem,
            steps: body.steps,
            imageId: body.imageId,
            clientId: body.clientId,
          },
          ink(body.tone),
        ),
      };
    },
  );
  // 讲一遍 → 讲完了 : compare what was said with the point's key points.
  app.post(
    "/v1/chat/threads/:id/teach-review",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      // text : what was still unsent in the box, said last.
      // clientId : the same 讲完了 asked again is reviewed once.
      const body = z
        .object({
          tone: toneSchema,
          text: z.string().max(2000).optional(),
          clientId: clientId.optional(),
        })
        .strict()
        .parse(req.body ?? {});
      return {
        data: await chat.teachReview(
          user.id,
          idParams.parse(req.params).id,
          ink(body.tone),
          body.text,
          body.clientId,
        ),
      };
    },
  );
  app.get("/v1/chat/images/:id", async (req, reply) => {
    const user = auth.require(req);
    const { data, type } = chat.image(user.id, idParams.parse(req.params).id);
    return reply.type(type === "png" ? "image/png" : "image/jpeg").send(data);
  });
  app.post("/v1/chat/threads/:id/answer", async (req) => {
    const user = auth.require(req);
    const body = z
      .object({
        answer: z.string().trim().min(1).max(500),
        clientId,
        tone: toneSchema,
      })
      .strict()
      .parse(req.body);
    const out = await chat.answer(
      user.id,
      idParams.parse(req.params).id,
      body.answer,
      body.clientId,
    );
    return { data: await chat.answerViews(user.id, out, ink(body.tone)) };
  });
  app.post(
    "/v1/chat/threads/:id/similar",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      // clientId : the same request asked again makes one problem.
      const { tone, clientId: cid } = z
        .object({ tone: toneSchema, clientId: clientId.optional() })
        .strict()
        .parse(req.body ?? {});
      return {
        data: await chat.similar(
          user.id,
          idParams.parse(req.params).id,
          ink(tone),
          cid,
        ),
      };
    },
  );
  app.post(
    "/v1/chat/practice",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const user = auth.require(req);
      // pointId (0.6.0 “AI 再出一道”): a problem for one map point.
      // clientId : the same request asked again makes one problem.
      const body = z
        .object({
          chapter: z.string().min(1).max(32).optional(),
          pointId: z.string().min(1).max(64).optional(),
          clientId: clientId.optional(),
          tone: toneSchema,
        })
        .strict()
        .refine((b) => !!b.chapter !== !!b.pointId, {
          message: "chapter 和 pointId 二选一",
        })
        .parse(req.body ?? {});
      return {
        data: await chat.practice(
          user.id,
          body.chapter,
          ink(body.tone),
          body.pointId,
          body.clientId,
        ),
      };
    },
  );
  app.post("/v1/chat/messages/:id/answer", async (req) => {
    const user = auth.require(req);
    // choice : the option picked on a choice problem, from 0.
    const body = z
      .object({
        answer: z.string().trim().min(1).max(500).optional(),
        choice: z.number().int().min(0).max(3).optional(),
        clientId,
        tone: toneSchema,
      })
      .strict()
      .refine((b) => b.answer !== undefined || b.choice !== undefined)
      .parse(req.body);
    const out = await chat.answerSimilar(
      user.id,
      idParams.parse(req.params).id,
      body.answer,
      body.clientId,
      body.choice,
    );
    return { data: await chat.answerViews(user.id, out, ink(body.tone)) };
  });
  app.post("/v1/chat/messages/:id/mistake", async (req) => {
    const user = auth.require(req);
    const { tone } = z
      .object({ tone: toneSchema })
      .strict()
      .parse(req.body ?? {});
    return {
      data: await chat.addMistake(
        user.id,
        idParams.parse(req.params).id,
        ink(tone),
      ),
    };
  });
  app.post("/v1/chat/messages/:id/reveal", async (req) => {
    const user = auth.require(req);
    const { tone } = z
      .object({ tone: toneSchema })
      .strict()
      .parse(req.body ?? {});
    return {
      data: await chat.reveal(
        user.id,
        idParams.parse(req.params).id,
        ink(tone),
      ),
    };
  });
}
