/*
 * HTTP 传输层：选择后端地址、附加会话 token，统一超时、响应解析与错误。
 * 401 只应清除发起请求所用的旧会话；账号切换后的新 token 不属于旧请求的清理范围。
 */
const config = require("./config");
const session = require("./session");
const clock = require("./clock");
function envVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || "release";
  } catch (error) {
    return "release";
  }
}
function baseUrl() {
  if (envVersion() === "develop") return config.DEV_API_BASE_URL;
  return /^https:\/\//.test(config.API_BASE_URL) ? config.API_BASE_URL : "";
}
function request({ url, method = "GET", data, auth = false, timeout = 15000 }) {
  const current = session.getSession();
  if (auth && !current)
    return Promise.reject(
      Object.assign(new Error("登录过期了，重新打开晓念就好"), {
        code: "AUTH_REQUIRED",
      }),
    );
  const base = baseUrl();
  if (!base)
    return Promise.reject(
      Object.assign(new Error("尚未配置 HTTPS 服务地址"), {
        code: "NO_API_BASE_URL",
      }),
    );
  const header = { "content-type": "application/json" };
  if (current) header.Authorization = `Bearer ${current.token}`;
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${base.replace(/\/$/, "")}${url}`,
      method,
      data,
      header,
      timeout,
      success: ({ statusCode, data: body, header: responseHeaders }) => {
        clock.observe(responseHeaders);
        if (statusCode >= 200 && statusCode < 300) return resolve(body);
        if (statusCode === 401) {
          const latest = session.getSession();
          if (!latest || (current && latest.token === current.token))
            session.clearSession();
        }
        const message =
          body && body.message ? body.message : `请求失败（${statusCode}）`;
        reject(
          Object.assign(new Error(message), {
            code: body && body.code,
            statusCode,
            requestId:
              (body && body.requestId) ||
              (responseHeaders && responseHeaders["x-request-id"]),
          }),
        );
      },
      fail: (error) =>
        reject(
          Object.assign(new Error("网络不太好，检查一下再试"), {
            code: "NETWORK",
            cause: error,
          }),
        ),
    });
  });
}
module.exports = { request, envVersion, baseUrl };
