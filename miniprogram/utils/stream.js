/*
 * 流式通信：读取并拼接服务端事件，生成提交标识并分发消息片段。
 * 同一次操作重试应保留 clientId；网络分块不一定与字符或完整事件边界一致。
 */
// A POST whose answer streams back as server-sent events (POST /v1/chat/send).
// The server sends pure ASCII (Chinese as \uXXXX inside JSON), so each byte is one
// character and a frame can be cut anywhere; iOS has no TextDecoder to rely on.
const { baseUrl } = require("./request");
const session = require("./session");
const auth = require("./auth");

function fail(message, code, extra) {
  return Object.assign(new Error(message), { code }, extra);
}
function ascii(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return out;
}
// An error body that did not come from the stream (a rejected request body, a rate
// limit) is ordinary UTF-8 JSON; rebuild it from the byte-per-character text.
function utf8(text) {
  try {
    return decodeURIComponent(escape(text));
  } catch (error) {
    return text;
  }
}
// Complete "data: …" frames in the text so far, and the unfinished rest.
function frames(text) {
  const parts = text.split("\n\n");
  const rest = parts.pop();
  return {
    payloads: parts
      .map((part) => part.replace(/^data: ?/, "").trim())
      .filter(Boolean),
    rest,
  };
}
// Feeds received chunks in, calls onEvent for every event, and remembers the
// raw text so a JSON error body can be read when the status is not 200.
function parser(onEvent) {
  let pending = "";
  let raw = "";
  let done = false;
  return {
    push(buffer) {
      const text = ascii(buffer);
      raw += text;
      const { payloads, rest } = frames(pending + text);
      pending = rest;
      for (const payload of payloads) {
        if (payload === "[DONE]") {
          done = true;
          continue;
        }
        let event;
        try {
          event = JSON.parse(payload);
        } catch (error) {
          continue;
        }
        onEvent(event);
      }
    },
    get raw() {
      return raw;
    },
    get done() {
      return done;
    },
  };
}
function once(url, data, onEvent, control) {
  return new Promise((resolve, reject) => {
    const current = session.getSession();
    const base = baseUrl();
    if (!base) return reject(fail("尚未配置 HTTPS 服务地址", "NO_API_BASE_URL"));
    if (!current)
      return reject(fail("登录过期了，重新打开晓念就好", "AUTH_REQUIRED"));
    const input = parser(onEvent);
    let chunked = false;
    const task = wx.request({
      url: `${base.replace(/\/$/, "")}${url}`,
      method: "POST",
      data,
      header: {
        "content-type": "application/json",
        Authorization: `Bearer ${current.token}`,
      },
      enableChunked: true,
      responseType: "arraybuffer",
      // Long answers with a recheck can take a few minutes.
      timeout: 250000,
      success: ({ statusCode, data: body, header }) => {
        // A client that did not stream hands the whole body over here.
        if (!chunked && body && body.byteLength) input.push(body);
        if (statusCode >= 200 && statusCode < 300)
          return resolve({ finished: input.done });
        let parsed = null;
        try {
          parsed = JSON.parse(utf8(input.raw));
        } catch (error) {
          parsed = null;
        }
        if (statusCode === 401) session.clearSession();
        reject(
          fail(
            (parsed && parsed.message) || `请求失败（${statusCode}）`,
            parsed && parsed.code,
            {
              statusCode,
              requestId:
                (parsed && parsed.requestId) ||
                (header && (header["x-request-id"] || header["X-Request-Id"])),
            },
          ),
        );
      },
      fail: (error) =>
        reject(
          control.aborted
            ? fail("已离开页面", "CANCELLED")
            : fail("网络断了。回答还在写，过一会儿回来就能看到", "NETWORK", {
                cause: error,
              }),
        ),
    });
    task.onChunkReceived(({ data: chunk }) => {
      chunked = true;
      input.push(chunk);
    });
    control.task = task;
  });
}
// Logs in when needed; after a 401 logs in once more and resends the same body,
// whose clientId lets the server recognise the retry.
function send(url, data, onEvent) {
  const control = { aborted: false, task: null };
  const go = () => auth.login().then(() => once(url, data, onEvent, control));
  const promise = go().catch((error) => {
    if (error.statusCode !== 401 || control.aborted) throw error;
    return go();
  });
  return {
    promise,
    abort() {
      control.aborted = true;
      if (control.task) control.task.abort();
    },
  };
}
// 16 characters from [A-Za-z0-9], enough to tell one message from another.
function clientId() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 16; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
module.exports = { send, clientId, parser, frames };
