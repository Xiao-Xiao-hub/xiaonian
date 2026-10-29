import { existsSync, opendirSync, statSync, statfsSync, type Dir } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AppError } from "./domain.js";

const MIB = 1024 * 1024;
export const USER_UPLOAD_BYTES = 2 * 1024 * MIB;
type Scan = { paths: string[]; directory?: Dir; total: number; added: number };
type Snapshot = { at: number; bytes: number; scan?: Scan };
const snapshots = new Map<string, Snapshot>();
function denied(reason: "user" | "disk") {
  console.warn(JSON.stringify({ event: "upload_storage_rejected", reason }));
  throw new AppError(reason === "disk" ? 503 : 429, "UPLOAD_STORAGE_LIMIT",
    reason === "disk" ? "附件空间暂时不足，请稍后再试" : "附件空间已满，清理一些旧图片后再试");
}

// Disk pressure is the only site-wide storage limit; historical file counts
// and other users' bytes do not prevent ordinary uploads as the site grows.
export function hasDiskSpace(path: string, bytes: number) {
  let disk = resolve(path);
  while (!existsSync(disk) && dirname(disk) !== disk) disk = dirname(disk);
  const free = statfsSync(disk);
  return free.bavail * free.bsize - Math.max(0, bytes) >=
    Math.max(2 * 1024 * MIB, free.blocks * free.bsize * 0.1);
}

// Reconcile only this user's tree, at most 1024 entries per request. A large
// existing tree continues on later requests instead of blocking or rejecting
// all uploads. While a scan is incomplete, known bytes and reservations form
// a conservative running count; the disk floor always protects the volume.
export function reserveUploadBytes(root: string, userId: string, bytes: number) {
  root = resolve(root);
  if (bytes < 0 || !Number.isFinite(bytes)) denied("user");
  if (!hasDiskSpace(root, bytes)) denied("disk");
  const key = join(root, userId);
  let usage = snapshots.get(key);
  if (!usage) {
    if (snapshots.size >= 1024) {
      const oldest = snapshots.keys().next().value!;
      snapshots.get(oldest)?.scan?.directory?.closeSync();
      snapshots.delete(oldest);
    }
    usage = { at: 0, bytes: 0 };
    snapshots.set(key, usage);
  }
  if (!usage.scan && Date.now() - usage.at > 60_000)
    usage.scan = { paths: [key], total: 0, added: 0 };
  const scan = usage.scan;
  if (scan) {
    for (let visited = 0; visited < 1024; visited++) {
      if (!scan.directory) {
        const path = scan.paths.pop();
        if (!path) {
          usage.bytes = scan.total + scan.added;
          usage.at = Date.now();
          usage.scan = undefined;
          break;
        }
        try { scan.directory = opendirSync(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          continue;
        }
      }
      const entry = scan.directory.readSync();
      if (!entry) {
        scan.directory.closeSync();
        scan.directory = undefined;
        continue;
      }
      const path = join(scan.directory.path, entry.name);
      if (entry.isDirectory()) scan.paths.push(path);
      else if (entry.isFile()) {
        try { scan.total += statSync(path).size; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  const known = Math.max(usage.bytes, usage.scan ? usage.scan.total + usage.scan.added : 0);
  if (known + bytes > USER_UPLOAD_BYTES) denied("user");
  usage.bytes += bytes;
  if (usage.scan) usage.scan.added += bytes;
}
