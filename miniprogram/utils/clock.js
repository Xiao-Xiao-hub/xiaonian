/*
 * 展示时钟：从响应头观察服务端时间偏差，用于日期等界面文案。
 * 该偏差不用于网络超时、轮询、会话过期或动画计时，避免展示时间影响请求生命周期。
 */
let offsetMs = 0;
let synced = false;

function headerValue(headers, name) {
  if (!headers) return "";
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find(
    (item) => item.toLowerCase() === wanted,
  );
  return key ? headers[key] : "";
}

// The server clock is authoritative for calendar labels. This offset never
// feeds polling, network timeouts, session expiry or animation timing.
function observe(headers, receivedAt = Date.now()) {
  const value = headerValue(headers, "x-service-time");
  const serverAt = Date.parse(String(value || ""));
  if (!Number.isFinite(serverAt) || !Number.isFinite(receivedAt)) return false;
  offsetMs = serverAt - receivedAt;
  synced = true;
  return true;
}

function now(realNow = Date.now()) {
  return realNow + offsetMs;
}

function reset() {
  offsetMs = 0;
  synced = false;
}

module.exports = { observe, now, synced: () => synced, reset };
