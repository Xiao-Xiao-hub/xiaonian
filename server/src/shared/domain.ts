export type User = {
  id: string;
  nickname: string;
  role: "user";
  openid: string;
  authMode: "dev" | "wechat";
  createdAt: string;
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
export const PRIVACY_VERSION = "2026-10-20.1";
// consent also takes the one before (the phone may show the older text).
export const PREVIOUS_PRIVACY_VERSION = "2026-10-17.1";
export const ACCEPTED_PRIVACY_VERSIONS = [
  PRIVACY_VERSION,
  PREVIOUS_PRIVACY_VERSION,
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
