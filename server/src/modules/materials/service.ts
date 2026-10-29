/*
 * 资料与题目原文：负责收录、图片上传、OCR 校对、原文版本和删除。
 * routes.ts 处理上传与接口校验；识别通过 JobRunner 运行，学习模块只使用用户确认的版本。
 * 图片文件与数据库记录共同构成一份材料；变更和清理必须维持两者的引用关系。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "../../shared/domain.js";
import { reserveUploadBytes } from "../../shared/upload-budget.js";
import type { SqliteStore } from "../../shared/store.js";
import { now as businessNow, type Clock } from "../../shared/time.js";
import type { Job, JobHandler } from "../jobs/runner.js";
import type { OcrLine, OcrProvider } from "../../providers/tencent-ocr.js";
import { readable } from "../render/markdown.js";
export type Kind = "note" | "problem";
export type Material = {
  id: string;
  userId: string;
  kind: Kind;
  title: string;
  status: "draft" | "confirmed";
  currentVersion: number;
  imagePath: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Version = {
  version: number;
  origin: "typed" | "ocr" | "edit";
  text: string;
  paragraphs: string[];
  answer: string | null;
  ocr: { lines: OcrLine[] } | null;
  createdAt: string;
};
export const TEXT_LIMIT = 2000;
export const IMAGE_LIMIT = 5 * 1024 * 1024;
// OCR lines below this confidence (0–100, as reported by the provider) are flagged for proofreading.
const DOUBT_BELOW = 85;
// One paragraph per non-empty line; citations refer to these numbers.
export const splitParagraphs = (text: string) =>
  text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
export const countChars = (text: string) => text.replace(/\s/g, "").length;
export function checkText(text: string) {
  const chars = countChars(text);
  if (!chars) throw new AppError(400, "TEXT_EMPTY", "先写点内容");
  if (chars > TEXT_LIMIT)
    throw new AppError(
      400,
      "TEXT_TOO_LONG",
      `有 ${chars} 字，有点长了（${TEXT_LIMIT} 字以内），拆成几份再放进来`,
    );
  return text.replace(/\r\n?/g, "\n").trim();
}
// Formulas are written out, so a typed problem's title reads as text.
const titleFrom = (text: string) =>
  readable(splitParagraphs(text)[0] ?? "").slice(0, 20);
// Titles made before that still hold TeX; they are shown from the text instead.
const shownTitle = (title: string, text: unknown) =>
  /[\\$]/.test(title) && text ? titleFrom(String(text)) : title;
// Lines of one OCR paragraph are joined; Latin words keep a space between them.
export function ocrText(lines: OcrLine[]) {
  let text = "";
  let previous: OcrLine | undefined;
  for (const line of lines) {
    const value = line.text.trim();
    if (!value) continue;
    if (previous) {
      const sameParagraph =
        line.paragraph !== null && line.paragraph === previous.paragraph;
      text += !sameParagraph
        ? "\n"
        : /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(value)
          ? " "
          : "";
    }
    text += value;
    previous = line;
  }
  return text;
}
const IMAGE_TYPES: [string, number[]][] = [
  ["jpg", [0xff, 0xd8, 0xff]],
  ["png", [0x89, 0x50, 0x4e, 0x47]],
  ["bmp", [0x42, 0x4d]],
];
export const imageType = (data: Buffer) =>
  IMAGE_TYPES.find(([, magic]) => magic.every((b, i) => data[i] === b))?.[0];
const toMaterial = (row: Record<string, unknown>): Material => ({
  id: String(row.id),
  userId: String(row.user_id),
  kind: row.kind as Kind,
  title: String(row.title),
  status: row.status as Material["status"],
  currentVersion: Number(row.current_version),
  imagePath: (row.image_path as string | null) ?? null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});
const toVersion = (row: Record<string, unknown>): Version => ({
  version: Number(row.version),
  origin: row.origin as Version["origin"],
  text: String(row.text),
  paragraphs: JSON.parse(String(row.paragraphs)) as string[],
  answer: (row.answer as string | null) ?? null,
  ocr: row.ocr ? (JSON.parse(String(row.ocr)) as Version["ocr"]) : null,
  createdAt: String(row.created_at),
});
export class MaterialService {
  private readonly uploadRoot: string;
  constructor(
    private readonly store: SqliteStore,
    uploadDir: string,
    private readonly clock: Clock = businessNow,
  ) {
    this.uploadRoot = resolve(uploadDir);
  }
  // Every read goes through the owner check; other users' materials look absent.
  own(userId: string, id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM materials WHERE id=? AND user_id=?")
      .get(id, userId);
    if (!row) throw new AppError(404, "NOT_FOUND", "这份资料找不到了，可能已经删掉");
    return toMaterial(row);
  }
  version(materialId: string, version: number) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM material_versions WHERE material_id=? AND version=?",
      )
      .get(materialId, version);
    return row ? toVersion(row) : undefined;
  }
  private addVersion(
    material: Material,
    origin: Version["origin"],
    text: string,
    answer: string | null,
    ocr: Version["ocr"] = null,
  ) {
    const version = material.currentVersion + 1;
    this.store.db
      .prepare(
        "INSERT INTO material_versions(material_id,version,origin,text,paragraphs,answer,ocr,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        material.id,
        version,
        origin,
        text,
        JSON.stringify(splitParagraphs(text)),
        answer,
        ocr ? JSON.stringify(ocr) : null,
        this.clock().toISOString(),
      );
    this.store.db
      .prepare(
        "UPDATE materials SET current_version=?,title=?,updated_at=? WHERE id=?",
      )
      .run(
        version,
        material.title || titleFrom(text),
        this.clock().toISOString(),
        material.id,
      );
    return version;
  }
  create(
    userId: string,
    input: { kind: Kind; title?: string; text: string; answer?: string },
  ) {
    const text = checkText(input.text);
    const id = `mat_${randomUUID().replaceAll("-", "")}`;
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES(?,?,?,?,'draft',0,?,?)",
        )
        .run(
          id,
          userId,
          input.kind,
          input.title?.trim() || "",
          this.clock().toISOString(),
          this.clock().toISOString(),
        );
      this.addVersion(
        this.own(userId, id),
        "typed",
        text,
        input.kind === "problem" ? input.answer?.trim() || null : null,
      );
    });
    return this.own(userId, id);
  }
  createFromImage(
    userId: string,
    input: { kind: Kind; title?: string; data: Buffer },
  ) {
    const type = imageType(input.data);
    if (!type)
      throw new AppError(
        415,
        "IMAGE_TYPE",
        "这种图打不开，换一张 JPG、PNG 或 BMP",
      );
    const id = `mat_${randomUUID().replaceAll("-", "")}`;
    const relative = `${userId}/${id}.${type}`;
    reserveUploadBytes(this.uploadRoot, userId, input.data.length);
    mkdirSync(join(this.uploadRoot, userId), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.uploadRoot, relative), input.data, { mode: 0o600 });
    this.store.db
      .prepare(
        "INSERT INTO materials(id,user_id,kind,title,status,current_version,image_path,created_at,updated_at) VALUES(?,?,?,?,'draft',0,?,?,?)",
      )
      .run(
        id,
        userId,
        input.kind,
        input.title?.trim() || "",
        relative,
        this.clock().toISOString(),
        this.clock().toISOString(),
      );
    return this.own(userId, id);
  }
  image(material: Material) {
    if (!material.imagePath)
      throw new AppError(404, "NOT_FOUND", "这份资料没有图");
    try {
      return {
        data: readFileSync(join(this.uploadRoot, material.imagePath)),
        type: material.imagePath.split(".").pop()!,
      };
    } catch {
      throw new AppError(404, "NOT_FOUND", "原图找不到了");
    }
  }
  list(
    userId: string,
    filter: {
      kind?: Kind;
      q?: string;
      status?: Material["status"];
      limit: number;
      offset?: number;
    },
  ) {
    // A problem asked in the chat lives in its conversation, not in the list.
    const where = [
      "m.user_id=?",
      "NOT (m.kind='problem' AND EXISTS(SELECT 1 FROM threads t WHERE t.material_id=m.id))",
    ];
    const args: (string | number)[] = [userId];
    if (filter.kind) {
      where.push("m.kind=?");
      args.push(filter.kind);
    }
    if (filter.status) {
      where.push("m.status=?");
      args.push(filter.status);
    }
    if (filter.q) {
      const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(m.title LIKE ? ESCAPE '\\' OR v.text LIKE ? ESCAPE '\\')");
      args.push(like, like);
    }
    args.push(filter.limit, filter.offset ?? 0);
    return (
      this.store.db
        .prepare(
          `SELECT m.*,v.text,EXISTS(SELECT 1 FROM reviews r WHERE r.material_id=m.id) AS in_review FROM materials m LEFT JOIN material_versions v ON v.material_id=m.id AND v.version=m.current_version WHERE ${where.join(" AND ")} ORDER BY m.updated_at DESC,m.rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(...args) as Record<string, unknown>[]
    ).map((row) => {
      const material = toMaterial(row);
      return {
        ...this.summary(material),
        title: shownTitle(material.title, row.text),
        snippet: readable(String(row.text ?? "").slice(0, 400)).slice(0, 60),
        inReview: Boolean(row.in_review),
      };
    });
  }
  summary(material: Material) {
    return {
      id: material.id,
      kind: material.kind,
      title: material.title,
      status: material.status,
      version: material.currentVersion,
      hasImage: Boolean(material.imagePath),
      createdAt: material.createdAt,
      updatedAt: material.updatedAt,
    };
  }
  detail(userId: string, id: string) {
    const material = this.own(userId, id);
    const current = this.version(id, material.currentVersion);
    const ocrJob = material.imagePath
      ? (this.store.db
          .prepare(
            "SELECT id,status,error_code,error_message FROM jobs WHERE material_id=? AND kind='ocr' ORDER BY created_at DESC,rowid DESC LIMIT 1",
          )
          .get(id) as Record<string, string | null> | undefined)
      : undefined;
    return {
      ...this.summary(material),
      current: current
        ? {
            version: current.version,
            origin: current.origin,
            text: current.text,
            paragraphs: current.paragraphs,
            answer: current.answer,
            chars: countChars(current.text),
            // Only the untouched OCR draft has provider confidences to show.
            doubts:
              current.origin === "ocr" && current.ocr
                ? current.ocr.lines
                    .filter(
                      (line) =>
                        line.confidence !== null &&
                        line.confidence < DOUBT_BELOW &&
                        line.text.trim(),
                    )
                    .map((line) => ({
                      text: line.text,
                      confidence: line.confidence,
                    }))
                : null,
            createdAt: current.createdAt,
          }
        : null,
      ocr: ocrJob
        ? {
            jobId: ocrJob.id,
            status: ocrJob.status,
            error: ocrJob.error_code
              ? { code: ocrJob.error_code, message: ocrJob.error_message }
              : null,
          }
        : null,
    };
  }
  versions(userId: string, id: string) {
    this.own(userId, id);
    return (
      this.store.db
        .prepare(
          "SELECT version,origin,text,created_at FROM material_versions WHERE material_id=? ORDER BY version DESC",
        )
        .all(id) as Record<string, unknown>[]
    ).map((row) => ({
      version: Number(row.version),
      origin: row.origin,
      chars: countChars(String(row.text)),
      createdAt: row.created_at,
    }));
  }
  // Optimistic concurrency: the caller states which version it edited.
  update(
    userId: string,
    id: string,
    input: {
      expectedVersion: number;
      text?: string;
      answer?: string | null;
      title?: string;
      confirm?: boolean;
    },
  ) {
    this.store.transaction(() => {
      const material = this.own(userId, id);
      if (material.currentVersion !== input.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "这份内容在别处改过，重新打开再改",
        );
      if (input.title !== undefined) {
        material.title = input.title.trim();
        this.store.db
          .prepare("UPDATE materials SET title=?,updated_at=? WHERE id=?")
          .run(material.title, this.clock().toISOString(), id);
      }
      const current = this.version(id, material.currentVersion);
      const text =
        input.text === undefined ? current?.text : checkText(input.text);
      // An untouched OCR draft may exceed the limit; it must be trimmed before confirming.
      if (input.confirm && text !== undefined) checkText(text);
      const answer =
        material.kind !== "problem"
          ? null
          : input.answer === undefined
            ? (current?.answer ?? null)
            : input.answer?.trim() || null;
      if (text === undefined) {
        if (input.confirm)
          throw new AppError(400, "TEXT_EMPTY", "还没有内容，先打几个字");
      } else if (text !== current?.text || answer !== (current?.answer ?? null))
        this.addVersion(material, "edit", text, answer);
      if (input.confirm)
        this.store.db
          .prepare(
            "UPDATE materials SET status='confirmed',updated_at=? WHERE id=?",
          )
          .run(this.clock().toISOString(), id);
    });
    return this.detail(userId, id);
  }
  // Images live in one folder per user.
  removeImages(userId: string) {
    rmSync(join(this.uploadRoot, userId), { recursive: true, force: true });
  }
  remove(userId: string, id: string) {
    const material = this.own(userId, id);
    this.store.db.prepare("DELETE FROM materials WHERE id=?").run(id);
    if (material.imagePath)
      rmSync(join(this.uploadRoot, material.imagePath), { force: true });
  }
  // OCR fills version 1 of an image material unless the user already typed it.
  ocrHandler(ocr: OcrProvider): JobHandler {
    return {
      quota: "ocr",
      run: async (job: Job, signal: AbortSignal) => {
        const material = this.own(job.userId, job.materialId!);
        const { data } = this.image(material);
        const result = await ocr.recognize(data, signal);
        return {
          output: result,
          usage: result.usage ?? {
            provider: "tencent-ocr",
            calls: 1,
            requestId: result.requestId,
          },
        };
      },
      commit: (job: Job, output: unknown) => {
        const { lines } = output as { lines: OcrLine[] };
        const material = this.own(job.userId, job.materialId!);
        if (material.currentVersion !== 0) return { skipped: true };
        const text = ocrText(lines);
        if (!text) return { version: 0, lines: 0 };
        return {
          version: this.addVersion(material, "ocr", text, null, { lines }),
          lines: lines.length,
        };
      },
    };
  }
}
