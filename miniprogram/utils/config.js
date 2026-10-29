module.exports = {
  APP_NAME: "晓念",
  // 开发版连本机后端：scripts/dev-local.sh（或 .ps1）固定在 127.0.0.1:8788，只供开发者工具。
  // 真机联调设置见 docs/runbook.md；上传版使用正式 HTTPS 地址。
  DEV_API_BASE_URL: "http://127.0.0.1:8788",
  // 体验版与正式版只能用已备案、已在小程序后台配置的 HTTPS 域名，不含 /v1。
  API_BASE_URL: "",
  // 开发登录的固定身份：同一个 key 每次登录都是同一个用户，数据不会丢。
  DEV_LOGIN_KEY: "owner",
  PRIVACY_VERSION: "2026-10-25.1",
};
