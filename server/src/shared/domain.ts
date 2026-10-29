export type User = {
  id: string;
  nickname: string;
  role: "user";
  openid: string;
  authMode: "dev" | "wechat";
  createdAt: string;
  // Private storage reference; HTTP responses expose only its opaque version.
  avatar?: {
    version: string;
    path: string;
    type: "jpg" | "png";
    bytes: number;
    updatedAt: string;
  };
  moodConsentAt?: string;
  suggestCards?: boolean;
  // v4, all inside the user JSON, no new columns.
  ageBand?: AgeBand;
  consents?: Consent[];
  personalized?: boolean;
  studyTime?: boolean;
};
export type AgeBand = "adult" | "child";
// server/legal 中三份法律文件的版本；必须与小程序 utils/config.js 的 PRIVACY_VERSION 一致。
export const PRIVACY_VERSION = "2026-10-25.1";
export const PREVIOUS_PRIVACY_VERSION = "2026-10-24.1";
// 已发布客户端仍可使用原有业务；记录用户实际阅读的版本，不能把旧同意自动升级。
// 新增的可选头像、昵称写入单独要求当前版本同意。
export const ACCEPTED_PRIVACY_VERSIONS = [
  PRIVACY_VERSION,
  PREVIOUS_PRIVACY_VERSION,
  "2026-10-20.2",
  "2026-10-20.1",
  "2026-10-17.1",
];
// "docs": the three documents; "guardian": a guardian's consent for a child,
// for the basic service or for 心情记录; "withdraw": the consent was revoked.
export type Consent =
  | { kind: "docs"; version: string; at: string }
  | { kind: "guardian"; scope: "basic" | "mood"; version: string; at: string }
  | { kind: "withdraw"; version: string; at: string };
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
