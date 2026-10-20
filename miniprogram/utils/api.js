/*
 * 业务请求公共入口：包装 GET/POST、上传下载、任务等待与错误提示。
 * 底层传输交给 request；页面通过这里获得已解包的数据，涉及账号权利的请求保留独立同意规则。
 */
const { request, baseUrl } = require("./request");
const auth = require("./auth");
const gate = require("./gate");
const session = require("./session");
const clock = require("./clock");
const PENDING = ["queued", "running"];
function fail(message, code, extra) {
  return Object.assign(new Error(message), { code }, extra);
}
// The same errors auth.login gives: needsConsent sends CONSENT_REQUIRED
// back to the welcome page and asks a guest with GUEST_MODE.
const notReady = () =>
  gate.state() === "guest"
    ? fail("游客模式不保存、不用 AI，同意后就能用", "GUEST_MODE")
    : fail("先同意用户协议和隐私政策，就能接着用", "CONSENT_REQUIRED");
// Export and account deletion only need the existing session, so they stay
// reachable after the privacy text changes and before it is accepted again.
const ready = (account) =>
  account && session.getSession() ? Promise.resolve() : auth.login();
// Logs in first; after a 401 the session is gone, so one fresh login is tried.
function call(method, url, data, { account = false, timeout = 20000 } = {}) {
  const generation = auth.consentGeneration();
  let owner = (auth.getUser() || {}).id;
  const stillCurrent = (receiving = false) => {
    if (
      generation !== auth.consentGeneration() ||
      (!account && !auth.hasConsent())
    )
      throw notReady();
    const currentOwner = (auth.getUser() || {}).id;
    if (owner && currentOwner !== owner && (currentOwner || receiving))
      throw fail("换了账号，再点一次就好", "SESSION_CHANGED");
    if (!owner) owner = currentOwner;
  };
  const send = () => {
    stillCurrent();
    return request({
      url,
      method,
      // wx.request would otherwise send an empty body.
      data: data === undefined && method !== "GET" ? {} : data,
      auth: true,
      timeout,
    });
  };
  return ready(account)
    .then(send)
    .catch((error) => {
      if (error.statusCode !== 401) throw error;
      stillCurrent();
      return auth.login().then(send);
    })
    .then((body) => {
      // A request already sent can finish after withdrawal, logout or a
      // different login. Its old result must not reach the new page/account.
      stillCurrent(true);
      return body && body.data;
    });
}
const get = (url) => call("GET", url);
const post = (url, data, options) => call("POST", url, data, options);
const put = (url, data) => call("PUT", url, data);
const patch = (url, data) => call("PATCH", url, data);
const del = (url, data, options) => call("DELETE", url, data, options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Polls until the job finishes. `alive` stops polling once the page is gone.
// onUpdate : each polled job, for a page that shows its status.
function waitJob(job, alive, limitMs = 150000, onUpdate) {
  const started = Date.now();
  const poll = (current) => {
    if (!current || !PENDING.includes(current.status))
      return Promise.resolve(current);
    if (!alive()) return Promise.reject(fail("页面已关闭", "CANCELLED"));
    if (Date.now() - started > limitMs)
      return Promise.reject(
        fail("还在处理，过一会儿回来看看", "WAIT_TIMEOUT"),
      );
    return sleep(1500)
      .then(() => get(`/v1/jobs/${current.id}`))
      .then((next) => {
        if (next && typeof onUpdate === "function") onUpdate(next);
        return poll(next);
      });
  };
  return poll(job);
}
const pending = (job) => Boolean(job && PENDING.includes(job.status));
// failed and unknown jobs are both free and can simply be retried.
function jobMessage(job) {
  if (!job) return "";
  if (job.error && job.error.message) return job.error.message;
  return "这次没跑完，可以再试一次";
}
// Native file transfers bypass request, so bind both their send and result
// to the same authorization generation and session as ordinary API requests.
// A retry passes the first attempt's generation and owner so a fresh login
// can only continue the same account.
function transferGuard(account, from) {
  const generation = from ? from.generation : auth.consentGeneration();
  let owner = from ? from.owner : (auth.getUser() || {}).id;
  let token;
  const guard = () => {
    if (
      generation !== auth.consentGeneration() ||
      (!account && !auth.hasConsent())
    )
      throw notReady();
    const current = session.getSession();
    if (
      !current ||
      (owner && owner !== current.user.id) ||
      (token && token !== current.token)
    )
      throw fail("换了账号，再点一次就好", "SESSION_CHANGED");
    owner = current.user.id;
    token = current.token;
    return { Authorization: `Bearer ${token}` };
  };
  guard.state = () => ({ generation, owner });
  return guard;
}
function upload(kind, filePath) {
  return uploadTo(`/v1/materials/image?kind=${kind}`, filePath);
}
// A release build without API_BASE_URL says so, instead of blaming the network.
const noBase = () =>
  Promise.reject(fail("尚未配置 HTTPS 服务地址", "NO_API_BASE_URL"));
// After a 401 the session is cleared and one fresh login is tried, like call.
function uploadTo(url, filePath, formData) {
  if (!baseUrl()) return noBase();
  const first = transferGuard(false);
  return auth
    .login()
    .then(() => sendFile(url, filePath, first, formData))
    .catch((error) => {
      if (error.statusCode !== 401) throw error;
      const retry = transferGuard(false, first.state());
      return auth.login().then(() => sendFile(url, filePath, retry, formData));
    });
}
function sendFile(url, filePath, current, formData) {
  return new Promise((resolve, reject) =>
    wx.uploadFile({
      url: `${baseUrl()}${url}`,
      filePath,
      name: "file",
      ...(formData ? { formData } : {}),
      header: current(),
      // Photos for the chat are read by the vision model before the reply.
      timeout: 90000,
      success: ({ statusCode, data, header }) => {
        clock.observe(header);
        try {
          current();
        } catch (error) {
          return reject(error);
        }
        let body = null;
        try {
          body = JSON.parse(data);
        } catch (error) {
          body = null;
        }
        if (statusCode >= 200 && statusCode < 300 && body)
          return resolve(body.data);
        if (statusCode === 401) session.clearSession();
        reject(
          fail(
            (body && body.message) || `上传失败（${statusCode}）`,
            body && body.code,
            { statusCode },
          ),
        );
      },
      fail: () => reject(fail("没传上去，检查网络再试", "NETWORK")),
    }),
  );
}
// Images need the Authorization header, so they are downloaded before display.
function download(url, what = "原图", { account = false } = {}) {
  if (!baseUrl()) return noBase();
  const current = transferGuard(account);
  return ready(account).then(
    () =>
      new Promise((resolve, reject) =>
        wx.downloadFile({
          url: `${baseUrl()}${url}`,
          header: current(),
          success: ({ statusCode, tempFilePath, header }) => {
            clock.observe(header);
            try {
              current();
            } catch (error) {
              // Only remove the temp file returned by this native download;
              // never expose a prior account's export or image to a new page.
              if (
                tempFilePath &&
                typeof wx.getFileSystemManager === "function"
              ) {
                try {
                  wx.getFileSystemManager().unlink({
                    filePath: tempFilePath,
                    fail() {},
                  });
                } catch (_) {}
              }
              return reject(error);
            }
            if (statusCode === 401) session.clearSession();
            return statusCode === 200
              ? resolve(tempFilePath)
              : reject(fail(`${what}暂时无法打开`, "DOWNLOAD", { statusCode }));
          },
          fail: () => reject(fail(`${what}下载失败，请检查网络`, "NETWORK")),
        }),
      ),
  );
}
// Pages call this from catch: without consent the visitor goes to the welcome
// page; a guest is asked whether to agree (utils/gate.js).
function needsConsent(error) {
  if (!error) return false;
  if (error.code === "GUEST_MODE") {
    gate.ask();
    return true;
  }
  if (error.code !== "CONSENT_REQUIRED") return false;
  // Agreed again while this request was on its way: it was stopped, not refused.
  if (gate.state() === "ok")
    wx.showToast({ title: "刚刚重新同意过，再点一次就好", icon: "none" });
  else gate.check();
  return true;
}
// Paragraphs of the version an artifact was generated from, cited ones marked.
function sourceSheet(material, version, cites) {
  const hit = new Set(cites || []);
  const sheet = (paragraphs, title) => ({
    title,
    lines: paragraphs.map((text, i) => ({
      no: i + 1,
      text,
      hit: hit.has(i + 1),
    })),
  });
  if (version === material.version && material.current)
    return Promise.resolve(
      sheet(material.current.paragraphs, "原文"),
    );
  return get(`/v1/materials/${material.id}/versions/${version}`).then((v) =>
    sheet(v.paragraphs, "原文（后来改过）"),
  );
}
function openMaterial(item, replace) {
  const page =
    item.status !== "confirmed"
      ? "proofread"
      : item.kind === "problem"
        ? "problem"
        : "material";
  const url = `/pages/${page}/index?id=${item.id}`;
  return replace ? wx.redirectTo({ url }) : wx.navigateTo({ url });
}
module.exports = {
  get,
  post,
  put,
  patch,
  del,
  waitJob,
  pending,
  jobMessage,
  upload,
  uploadTo,
  download,
  needsConsent,
  sourceSheet,
  openMaterial,
};
