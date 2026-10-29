/*
 * 可选个人资料。头像只放在本人 uploads 子目录，不进入学习材料、OCR 或 AI 队列。
 * 先写新文件，再提交用户 JSON，最后回收旧文件；启动与每日清理兜住中断留下的孤立头像。
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { crc32 } from "node:zlib";
import { AppError, type User } from "../../shared/domain.js";
import type { SqliteStore } from "../../shared/store.js";
import { reserveUploadBytes } from "../../shared/upload-budget.js";

export const AVATAR_LIMIT = 2 * 1024 * 1024;
// Profile permission was introduced in this version. A later legal update
// must not revoke that existing permission while old clients are still live.
export const PROFILE_CONSENT_MIN_VERSION = "2026-10-20.2";
const allowsProfile = (version: string) => {
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d{1,3})$/.exec(version);
  if (!match) return false;
  const [date, revision] = PROFILE_CONSENT_MIN_VERSION.split(".");
  return match[1]! > date! || (match[1] === date && Number(match[2]) >= Number(revision));
};
export const profileNickname = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const VERSION = /^[a-f0-9]{32}$/;
const FILE = /^[a-f0-9]{32}\.(?:jpg|png)$/;
const MAX_SIDE = 4096;
const invalidImage = () =>
  new AppError(
    400,
    "IMAGE_INVALID",
    "请选择完整的 JPG 或 PNG 头像，边长不超过 4096 像素",
  );

// Validate the container and dimensions before storing an opaque private image.
// Rendering remains the client's job; SVG and arbitrary URLs are never accepted.
function avatarType(data: Buffer): "png" | "jpg" {
  if (!data.length) throw invalidImage();
  if (data.length > AVATAR_LIMIT)
    throw new AppError(413, "IMAGE_TOO_LARGE", "头像需在 2MB 以内");
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    let offset = 8,
      hasHeader = false,
      imageBytes = 0;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      if (offset + length + 12 > data.length) break;
      const kind = data.toString("ascii", offset + 4, offset + 8);
      const chunk = data.subarray(offset + 8, offset + 8 + length);
      if (
        crc32(data.subarray(offset + 4, offset + 8 + length)) !==
        data.readUInt32BE(offset + 8 + length)
      )
        break;
      if (!hasHeader) {
        if (kind !== "IHDR" || length !== 13) break;
        const width = chunk.readUInt32BE(0),
          height = chunk.readUInt32BE(4);
        if (
          !width ||
          !height ||
          width > MAX_SIDE ||
          height > MAX_SIDE ||
          ![1, 2, 4, 8, 16].includes(chunk[8]!) ||
          ![0, 2, 3, 4, 6].includes(chunk[9]!) ||
          chunk[10] !== 0 ||
          chunk[11] !== 0 ||
          chunk[12]! > 1
        )
          break;
        hasHeader = true;
      } else if (kind === "IHDR") break;
      if (kind === "IDAT") imageBytes += length;
      offset += length + 12;
      if (kind === "IEND") {
        if (length === 0 && imageBytes > 0 && offset === data.length)
          return "png";
        break;
      }
    }
  }
  if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2,
      hasFrame = false,
      hasScan = false,
      scanBytes = 0;
    while (offset + 2 <= data.length) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++]!;
      if (marker === 0xd9) {
        if (hasFrame && hasScan && scanBytes > 0 && offset === data.length)
          return "jpg";
        break;
      }
      if (
        marker === 0xd8 ||
        marker === 0 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        offset + 2 > data.length
      )
        break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 11) break;
        const height = data.readUInt16BE(offset + 3),
          width = data.readUInt16BE(offset + 5);
        const components = data[offset + 7]!;
        if (
          !width ||
          !height ||
          width > MAX_SIDE ||
          height > MAX_SIDE ||
          components < 1 ||
          components > 4 ||
          length !== 8 + 3 * components
        )
          break;
        hasFrame = true;
      }
      if (marker === 0xda) {
        const components = data[offset + 2]!;
        if (
          !hasFrame ||
          components < 1 ||
          components > 4 ||
          length !== 6 + 2 * components
        )
          break;
        hasScan = true;
        offset += length;
        // Entropy bytes may escape FF as FF00 or contain restart markers.
        // Stop at the next marker so progressive JPEG scans are checked too.
        while (offset < data.length) {
          if (data[offset] !== 0xff) {
            scanBytes++;
            offset++;
          } else if (data[offset + 1] === 0) {
            scanBytes++;
            offset += 2;
          } else if (data[offset + 1]! >= 0xd0 && data[offset + 1]! <= 0xd7)
            offset += 2;
          else break;
        }
      } else offset += length;
    }
  }
  throw invalidImage();
}

export class ProfileService {
  private readonly root: string;
  constructor(
    private readonly store: SqliteStore,
    uploadDir: string,
  ) {
    this.root = resolve(uploadDir);
  }
  private user(id: string) {
    const user = this.store.getUser(id);
    if (!user) throw new AppError(404, "NOT_FOUND", "没找到这个账号");
    return user;
  }
  assertConsent(userId: string) {
    const user = this.user(userId);
    const consents = user.consents ?? [];
    let index = consents.length - 1;
    while (index >= 0 && consents[index]!.kind === "guardian") index--;
    const latest = consents[index];
    if (
      latest?.kind !== "docs" ||
      !allowsProfile(latest.version) ||
      !user.ageBand
    )
      throw new AppError(
        403,
        "PROFILE_CONSENT_REQUIRED",
        "请先阅读并同意新版隐私说明，再保存头像和昵称",
      );
    if (
      user.ageBand === "child" &&
      !consents
        .slice(index + 1)
        .some(
          (item) =>
            item.kind === "guardian" &&
            item.scope === "basic" &&
            item.version === latest.version,
        )
    )
      throw new AppError(
        403,
        "GUARDIAN_REQUIRED",
        "请先由监护人同意新版隐私说明",
      );
  }
  private save(user: User) {
    this.store.db
      .prepare("UPDATE users SET data=? WHERE id=?")
      .run(JSON.stringify(user), user.id);
  }
  private path(user: User) {
    const avatar = user.avatar;
    if (
      !avatar ||
      !VERSION.test(avatar.version) ||
      !["jpg", "png"].includes(avatar.type)
    )
      throw new AppError(404, "NOT_FOUND", "还没有设置头像");
    const expected = `${user.id}/profile/${avatar.version}.${avatar.type}`;
    if (avatar.path !== expected)
      throw new AppError(404, "NOT_FOUND", "头像暂时无法读取");
    return join(this.root, expected);
  }
  private remove(path: string) {
    // A failed unlink is retried by the orphan sweep. The committed profile
    // stays authoritative even when the filesystem is temporarily unavailable.
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  update(
    userId: string,
    input: { nickname?: string; image?: Buffer; mime?: string },
  ) {
    this.assertConsent(userId);
    const nickname =
      input.nickname === undefined
        ? undefined
        : profileNickname.parse(input.nickname);
    const old = this.user(userId);
    let avatar = old.avatar;
    let newPath: string | undefined;
    if (input.image) {
      const type = avatarType(input.image);
      if (
        input.mime &&
        ![
          type === "jpg" ? "image/jpeg" : "image/png",
          "application/octet-stream",
        ].includes(input.mime)
      )
        throw invalidImage();
      reserveUploadBytes(this.root, userId, input.image.length);
      const version = randomUUID().replaceAll("-", "");
      const relative = `${userId}/profile/${version}.${type}`;
      const dir = join(this.root, userId, "profile");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      newPath = join(this.root, relative);
      avatar = {
        version,
        path: relative,
        type,
        bytes: input.image.length,
        updatedAt: this.store.now(),
      };
      try {
        writeFileSync(newPath, input.image, { flag: "wx", mode: 0o600 });
      } catch (error) {
        this.remove(newPath);
        throw error;
      }
    }
    let updated: User;
    try {
      updated = this.store.transaction(() => {
        const next = {
          ...this.user(userId),
          ...(nickname === undefined ? {} : { nickname }),
          avatar,
        };
        this.save(next);
        this.store.audit(userId, "profile.updated", userId, {
          nicknameChanged: nickname !== undefined,
          avatarChanged: input.image !== undefined,
        });
        return next;
      });
    } catch (error) {
      if (newPath) this.remove(newPath);
      throw error;
    }
    if (newPath && old.avatar) this.remove(this.path(old));
    return updated;
  }
  clear(userId: string, fields: { avatar?: true; nickname?: true }) {
    const old = this.user(userId);
    const next = this.store.transaction(() => {
      const user = this.user(userId);
      if (fields.avatar) delete user.avatar;
      if (fields.nickname)
        user.nickname = user.authMode === "wechat" ? "微信用户" : "开发者";
      this.save(user);
      this.store.audit(userId, "profile.cleared", userId, {
        nicknameCleared: fields.nickname === true,
        avatarCleared: fields.avatar === true,
      });
      return user;
    });
    if (fields.avatar && old.avatar) this.remove(this.path(old));
    return next;
  }
  image(userId: string, version: string) {
    const user = this.user(userId);
    if (user.avatar?.version !== version)
      throw new AppError(404, "NOT_FOUND", "这张头像已更新或清除");
    const path = this.path(user);
    if (!existsSync(path) || !lstatSync(path).isFile())
      throw new AppError(404, "NOT_FOUND", "头像暂时无法读取");
    return {
      data: readFileSync(path),
      type: user.avatar.type === "jpg" ? "image/jpeg" : "image/png",
    };
  }
  sweepOrphans(now = Date.now()) {
    if (!existsSync(this.root)) return 0;
    let removed = 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^usr_[a-f0-9]{32}$/.test(entry.name))
        continue;
      const dir = join(this.root, entry.name, "profile");
      if (!existsSync(dir) || !lstatSync(dir).isDirectory()) continue;
      const user = this.store.getUser(entry.name);
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !FILE.test(file.name)) continue;
        const path = join(dir, file.name);
        if (user?.avatar?.path === `${entry.name}/profile/${file.name}`)
          continue;
        if (now - lstatSync(path).mtimeMs <= 3600000) continue;
        if (this.remove(path)) removed++;
      }
    }
    return removed;
  }
}
