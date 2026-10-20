import {
  bytes,
  costLabel,
  dateTime,
  duration,
  jobTotals,
  mapReportTable,
  pageSlice,
  percent,
  ratio,
  queuePending,
  number,
  usageTrend,
} from "./model.mjs";

/*
 * 管理台浏览器入口：负责管理员会话、页面导航、数据请求和十一页 DOM 渲染。
 * 阅读顺序：页面常量与状态 → 会话及请求 → 公用 DOM 组件 → 各业务页渲染。
 * model.mjs 保存纯格式化与统计函数；本文件处理浏览器副作用，session/pageRequest 拦截过期响应。
 */

const $ = (selector) => document.querySelector(selector);
const content = $("#page-content");
const pages = {
  overview: ["工作台", "WORKBENCH", "先处理待办，再看学习、消耗与服务。"],
  feedback: [
    "反馈处理",
    "FEEDBACK",
    "学生点“这题有问题”或反馈生成内容后，在这里核对并标记处理。",
  ],
  users: ["用户管理", "USERS", "查找账号、停用或恢复，单独调整每日额度。"],
  jobs: ["任务总览", "JOBS", "关注任务是否完成，服务原因失败的任务可以重试。"],
  ai: [
    "AI 接口",
    "MODELS",
    "多个接口按顺序使用，一个不可用时自动切换到下一个。",
  ],
  settings: ["额度设置", "LIMITS", "全体用户的每日、每周额度和模型价格，保存后立即生效。"],
  bank: ["题库", "PROBLEM BANK", "学习地图全部题目，按待处理反馈多少排序，只读。"],
  quality: [
    "材料与质量",
    "QUALITY",
    "资料与题目的核对进度，用户对生成结果和地图题的反馈计数。",
  ],
  usage: [
    "用量与维护",
    "USAGE",
    "追踪调用、额度与存储，让每一份消耗有据可查。",
  ],
  audit: ["操作记录", "AUDIT TRAIL", "关键操作由服务端留痕，便于核对与追踪。"],
  operations: [
    "运行状态",
    "SERVICE HEALTH",
    "查看当前服务状态与依赖健康情况。",
  ],
};
const JOB_KINDS = {
  ocr: "文字识别",
  explain: "资料讲解",
  ask: "追问",
  quiz: "自测题",
  hints: "分级提示",
  variant: "同类题",
  feedback: "作答讲评",
  notes_organize: "随心记整理",
  note_organize: "随心记整理",
  notes: "随心记整理",
  chat: "问 AI",
  verify: "草稿批改",
};
const JOB_STATUS = {
  queued: "排队",
  running: "进行中",
  succeeded: "成功",
  failed: "失败",
  unknown: "结果未知",
};
const MATERIAL_KINDS = { note: "资料／笔记", problem: "题目／错题" };
const ARTIFACT_KINDS = {
  explain: "资料讲解",
  answer: "追问回答",
  quiz: "自测题",
  hints: "分级提示",
  variant: "同类题",
};
const REPORT_REASONS = {
  wrong: "内容有错误",
  unclear: "讲得不清楚",
  citation: "出处对不上",
  other: "其他问题",
};
const BUCKETS = {
  ai: "讲解和出题",
  ocr: "图片识别",
  notes: "AI 整理",
  chat: "对话",
  photos: "拍题识别",
  brainstorm: "头脑风暴",
  import: "导入",
};
const ACTIONS = {
  "session.created": "用户登录",
  "session.revoked": "用户退出",
  "account.deleted": "注销账号",
  "admin.session.created": "管理员登录",
  "admin.session.revoked": "管理员退出",
  "admin.login.failed": "管理员登录失败",
  "admin.key.failed": "管理密钥错误",
  "user.banned": "停用账号",
  "user.unbanned": "恢复账号",
  "user.quota.updated": "调整个人额度",
  "feedback.handled": "反馈已处理",
  "feedback.reopened": "反馈重新打开",
  "job.retried": "重试任务",
  "settings.limits.updated": "调整全局额度",
  "settings.budget.updated": "调整费用额度",
  "settings.prices.updated": "调整模型价格",
  "ai.endpoint.created": "新增 AI 接口",
  "ai.endpoint.updated": "修改 AI 接口",
  "ai.endpoint.deleted": "删除 AI 接口",
  "ai.endpoint.tested": "测试 AI 接口",
  "ai.order.updated": "调整接口顺序",
  "ai.thinking.updated": "调整思考程度",
};
const AUDIT_GROUPS = {
  "": "全部动作",
  "user.": "账号管理",
  "feedback.": "反馈处理",
  "job.": "任务重试",
  "ai.": "AI 接口",
  "settings.": "额度设置",
  "admin.": "管理员会话",
  "session.": "学习用户登录",
  "account.": "注销账号",
};
const CALL_SOURCES = {
  "llm.json": "学习 / 整理",
  "llm.stream": "问 AI",
  "llm.test": "接口测试",
  jev: "答案判定",
  "ocr.tencent": "文字识别",
};
const LIMIT_NAMES = BUCKETS;
const SCENARIOS = {
  "chat.study": ["问 AI、学习对话", "问 AI 和学习对话"],
  "chat.life": ["生活对话", "生活话题对话"],
  "chat.mood": ["心情对话", "心情话题对话"],
  card_tidy: ["随心记整理", "整理学生的随手记录"],
  import_split: ["导入拆卡", "把导入材料拆成卡片"],
  brainstorm: ["头脑风暴", "把卡片摆开、对一对并形成结论"],
  map_stuck: ["卡住了引导", "学习地图卡住时给出引导"],
  vision: ["看图识别", "照片、截图和扫描页"],
  recheck: ["批改与复核", "判定作答对错、复核答案，建议开高"],
  study: ["讲解与出题", "资料讲解、自测题、分级提示、同类题"],
  judge: ["判断", "卡片种类、场景、安全检查等原来交给 Jev 的判断"],
};
const FORMATS = {
  none: "不传思考参数",
  reasoning_effort: "reasoning_effort（OpenAI、混元等）",
  thinking_type: "thinking.type（智谱、火山方舟等）",
  enable_thinking: "enable_thinking（通义、硅基流动等）",
};
const LEVELS = { off: "关闭", low: "低", medium: "中", high: "高", max: "最高" };
const MAP_REASONS = {
  judge: "判对判错有问题",
  problem: "题目本身有错",
  unclear: "看不懂题目",
  other: "其他问题",
};
const VERDICTS = { correct: "判为正确", incorrect: "判为错误", unsure: "无法确定" };
const PROBLEM_KINDS = {
  number: "数值",
  expr: "表达式",
  antiderivative: "不定积分",
  multi: "多空",
  choice: "选择",
};
// 刷新时保留页面筛选条件；新建管理会话时恢复默认筛选。
// ── 页面筛选状态与会话代际 ──
// session 标识当前管理会话，pageRequest 标识当前页请求；退出或切页后拒绝旧响应写入。
const blankState = () => ({
  feedback: { status: "open", type: "all", point: "" },
  users: { q: "", filter: "all", page: 1, id: "" },
  audit: { action: "", from: "", to: "" },
  bank: { chapter: "", q: "", reported: false },
  ai: { editing: "" },
});
let state = blankState();
let authenticated = false;
let session = 0;
let page = "overview";
let pageRequest = 0;
let idleTimer;
let lastActivity = 0;
let authPending = true;
const aborters = new Set();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function button(label, onClick, className = "button small") {
  const element = node("button", label, className);
  element.type = "button";
  element.addEventListener("click", onClick);
  return element;
}
function badge(status, label) {
  const kind = ["ready", "ok", "succeeded"].includes(status)
    ? "success"
    : ["error", "failed"].includes(status)
      ? "danger"
      : ["unknown", "not_ready", "degraded"].includes(status)
        ? "warning"
        : "";
  return node("span", label || status, `badge ${kind}`);
}
function notice(message, kind = "") {
  const element = $("#notice");
  element.textContent = message;
  element.className = `notice ${kind}`;
  element.hidden = !message;
}
function errorText(error) {
  return error instanceof Error ? error.message : "请求失败，请重试。";
}
function isAbort(error) {
  return error?.name === "AbortError";
}

// ── 请求与会话管理 ──
async function api(
  path,
  options = {},
  { authFailure = true, allowUnavailable = false, timeoutMs = 15000 } = {},
) {
  if (
    !/^\/v1\/admin(?:\/|$)/.test(path) &&
    !["/health/live", "/health/ready"].includes(path)
  )
    throw new Error("管理台只能请求同源管理接口。");
  const epoch = session;
  const controller = new AbortController();
  aborters.add(controller);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    const response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    const payload =
      response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok && !(allowUnavailable && response.status === 503)) {
      if (
        response.status === 401 &&
        authenticated &&
        epoch === session &&
        authFailure
      )
        clearSession("管理会话已失效，请重新登录。");
      const defaultMessage =
        response.status === 401
          ? "访问密钥无效或会话已过期，请重新登录。"
          : response.status === 429
            ? "操作过于频繁，请稍后重试。"
            : `请求失败（HTTP ${response.status}），请重试。`;
      const requestId =
        payload.requestId || response.headers.get("x-request-id");
      const error = new Error(
        `${payload.message || defaultMessage}${requestId ? ` · 请求编号 ${requestId}` : ""}`,
      );
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (timedOut) throw new Error("请求超时，请检查连接后重试。");
    if (error instanceof TypeError)
      throw new Error("无法连接服务，请检查网络或服务状态。");
    throw error;
  } finally {
    clearTimeout(timeout);
    aborters.delete(controller);
  }
}
function dataList(payload) {
  if (!Array.isArray(payload.data))
    throw new Error("服务返回的数据格式不符合约定，请联系维护者。");
  return payload.data;
}
function activity() {
  if (!authenticated || Date.now() - lastActivity < 1000) return;
  lastActivity = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => logout("连续 15 分钟无操作，已自动退出。"),
    15 * 60 * 1000,
  );
}
function clearSession(message = "") {
  authenticated = false;
  session += 1;
  pageRequest += 1;
  clearTimeout(idleTimer);
  lastActivity = 0;
  aborters.forEach((controller) => controller.abort());
  aborters.clear();
  state = blankState();
  $("#admin-token").value = "";
  content.replaceChildren();
  $("#workspace").hidden = true;
  $("#login-screen").hidden = false;
  $("#login-error").textContent = message;
  $("#login-error").hidden = !message;
  setAuthPending(false);
  $("#admin-token").focus();
}
function setAuthPending(pending, label = "正在验证…") {
  authPending = pending;
  $("#login-submit").disabled = pending;
  $("#admin-token").disabled = pending;
  $("#login-submit").textContent = pending ? label : "安全登录 →";
}
async function logout(message = "") {
  if (authPending) return;
  clearSession(message);
  setAuthPending(true, "正在退出…");
  const epoch = session;
  try {
    await api(
      "/v1/admin/session",
      { method: "DELETE" },
      { authFailure: false },
    );
  } catch (error) {
    if (epoch === session && !isAbort(error)) {
      $("#login-error").textContent =
        "本页已退出，服务端注销尚未确认。请检查连接；原会话将在服务端到期。";
      $("#login-error").hidden = false;
    }
  } finally {
    if (epoch === session) setAuthPending(false);
  }
}
async function enterSession(result, epoch) {
  if (epoch !== session) return;
  if (!result.data?.authenticated) throw new Error("管理会话响应不符合约定。");
  authenticated = true;
  $("#admin-token").value = "";
  $("#login-screen").hidden = true;
  $("#workspace").hidden = false;
  $("#connection-label").textContent = "管理会话已连接";
  setAuthPending(false);
  activity();
  await navigate("overview");
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (authPending) return;
  const token = $("#admin-token").value.trim();
  if (!token) return;
  const epoch = ++session;
  setAuthPending(true);
  $("#admin-token").value = "";
  $("#login-error").hidden = true;
  try {
    const result = await api(
      "/v1/admin/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: token }),
      },
      { authFailure: false },
    );
    await enterSession(result, epoch);
  } catch (error) {
    if (epoch === session && !isAbort(error)) {
      $("#login-error").textContent = errorText(error);
      $("#login-error").hidden = false;
    }
  } finally {
    if (epoch === session) setAuthPending(false);
  }
});
$("#logout").addEventListener("click", () => logout());
$("#refresh").addEventListener("click", () => loadPage());
$("#navigation").addEventListener("click", (event) => {
  const target = event.target.closest("[data-page]");
  if (!target) return;
  // 菜单切换始终打开该页面的主视图，不沿用上次下钻的详情。
  state.users.id = "";
  state.feedback.point = "";
  state.ai.editing = "";
  void navigate(target.dataset.page);
});
document.addEventListener("pointerdown", activity, { passive: true });
document.addEventListener("keydown", activity, { passive: true });
// 浏览器页面隐藏时清空 DOM 并中止未完成读取；即使浏览器无法发送退出请求，服务端仍按会话期限失效。
window.addEventListener("pagehide", () => clearSession());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void restoreSession();
});
document.addEventListener("visibilitychange", () => {
  if (
    authenticated &&
    !document.hidden &&
    Date.now() - lastActivity >= 15 * 60 * 1000
  )
    logout("连续 15 分钟无操作，已自动退出。");
});
async function restoreSession() {
  const epoch = ++session;
  setAuthPending(true, "正在检查会话…");
  try {
    const result = await api("/v1/admin/session", {}, { authFailure: false });
    await enterSession(result, epoch);
  } catch (error) {
    // 会话不存在是正常的退出状态。其他错误需要显示，避免把断网误报成凭证无效。
    if (epoch === session && !isAbort(error) && error.status !== 401) {
      $("#login-error").textContent = errorText(error);
      $("#login-error").hidden = false;
    }
  } finally {
    if (epoch === session) setAuthPending(false);
  }
}
void restoreSession();

// ── 导航与页面数据装配 ──
async function navigate(next) {
  if (!pages[next]) return;
  page = next;
  const [title, kicker, description] = pages[page];
  $("#page-title").textContent = title;
  $("#page-kicker").textContent = kicker;
  $("#page-description").textContent = description;
  $("#breadcrumb-current").textContent = title;
  document.title = `${title} · 晓念管理台`;
  document.querySelectorAll("[data-page]").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === page);
    if (item.dataset.page === page) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  await loadPage();
  if (page === next && authenticated) $("#main").focus({ preventScroll: true });
}
async function loadPage() {
  if (!authenticated) return;
  const request = ++pageRequest;
  const epoch = session;
  const view = page;
  $("#refresh").disabled = true;
  content.setAttribute("aria-busy", "true");
  const loading = node("div", "正在同步数据…", "loading");
  loading.setAttribute("role", "status");
  content.replaceChildren(loading);
  $("#mode-tag").textContent = "正在同步";
  $("#mode-tag").className = "mode-tag";
  notice("");
  const query = (params) => {
    const text = Object.entries(params)
      .filter(([, value]) => value !== "" && value !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    return text ? `?${text}` : "";
  };
  const fetchers = {
    overview: () =>
      Promise.all([
        api("/v1/admin/overview"),
        api("/v1/admin/jobs"),
        api("/v1/admin/usage"),
        api("/v1/admin/todo"),
      ]),
    feedback: () =>
      api(
        `/v1/admin/feedback${query({
          status: state.feedback.status,
          type: state.feedback.point ? "map" : state.feedback.type,
          point: state.feedback.point,
        })}`,
      ),
    users: () =>
      Promise.all([
        api(
          `/v1/admin/users${query({
            q: state.users.q,
            filter: state.users.filter === "all" ? "" : state.users.filter,
            page: state.users.page > 1 ? state.users.page : "",
          })}`,
        ),
        state.users.id
          ? api(`/v1/admin/users/${encodeURIComponent(state.users.id)}`)
          : null,
      ]),
    jobs: () => api("/v1/admin/jobs"),
    ai: () => api("/v1/admin/ai"),
    settings: () => api("/v1/admin/settings"),
    bank: () => api("/v1/admin/bank"),
    quality: () => api("/v1/admin/quality"),
    usage: () => api("/v1/admin/usage"),
    audit: () => api(`/v1/admin/audit${query(state.audit)}`),
    operations: () =>
      Promise.all([
        api("/v1/admin/operations"),
        api("/health/live"),
        api("/health/ready", {}, { allowUnavailable: true }),
      ]),
  };
  try {
    const result = await fetchers[view]();
    if (request !== pageRequest || epoch !== session) return;
    content.replaceChildren();
    if (view === "overview")
      renderOverview(result[0].data, result[1].data, result[2].data, result[3].data);
    if (view === "feedback") renderFeedback(result.data);
    if (view === "users") renderUsers(result[0].data, result[1]?.data);
    if (view === "jobs") renderJobs(result.data);
    if (view === "ai") renderAi(result.data);
    if (view === "settings") renderSettings(result.data);
    if (view === "bank") renderBank(result.data);
    if (view === "quality") renderQuality(result.data);
    if (view === "usage") renderUsage(result.data);
    if (view === "audit") renderAudit(dataList(result));
    if (view === "operations")
      renderOperations(result[0].data, result[1], result[2]);
    $("#updated-at").textContent =
      `更新于 ${new Intl.DateTimeFormat("zh-CN", { timeStyle: "short" }).format(new Date())}`;
    $("#mode-tag").textContent = "数据已同步";
    $("#mode-tag").className = "mode-tag synced";
  } catch (error) {
    if (request !== pageRequest || epoch !== session || isAbort(error)) return;
    notice(errorText(error), "error");
    $("#mode-tag").textContent = "同步失败";
    $("#mode-tag").className = "mode-tag failed";
    const empty = emptyState(
      "数据加载失败",
      "请检查服务状态后重试，已有数据不会被修改。",
    );
    empty.append(button("重新加载", () => loadPage()));
    content.replaceChildren(empty);
  } finally {
    if (request === pageRequest) {
      $("#refresh").disabled = false;
      content.setAttribute("aria-busy", "false");
    }
  }
}
// ── 共用 DOM 组件 ──
// 外部文字通过文本节点展示；业务页面在下方组合这些组件。
function emptyState(title, explanation) {
  const wrapper = node("div", null, "empty");
  const symbol = node("span", "◇", "empty-symbol");
  symbol.setAttribute("aria-hidden", "true");
  wrapper.append(symbol, node("h3", title), node("p", explanation));
  return wrapper;
}
function panel(title, description) {
  const wrapper = node("section", null, "panel");
  const heading = node("div", null, "panel-heading");
  const text = node("div");
  text.append(node("h2", title));
  if (description) text.append(node("p", description));
  heading.append(text);
  wrapper.append(heading);
  return { wrapper, heading };
}
function table(headers, rows, emptyTitle, emptyDescription) {
  if (!rows.length) return emptyState(emptyTitle, emptyDescription);
  const wrapper = node("div", null, "table-wrap");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute(
    "aria-label",
    `${headers[0]}等${headers.length}列数据，可水平滚动`,
  );
  const element = node("table");
  const head = node("thead");
  const headerRow = node("tr");
  headers.forEach((text) => {
    const cell = node("th", text);
    cell.scope = "col";
    headerRow.append(cell);
  });
  head.append(headerRow);
  const body = node("tbody");
  rows.forEach((row) => {
    const tr = node("tr");
    row.forEach((value) => {
      const cell = node("td");
      if (value instanceof Node) cell.append(value);
      else cell.textContent = String(value ?? "—");
      tr.append(cell);
    });
    body.append(tr);
  });
  element.append(head, body);
  wrapper.append(element);
  return wrapper;
}
function paginatedTable(
  container,
  headers,
  items,
  map,
  requestedPage,
  onPage,
  emptyTitle,
  emptyDescription,
) {
  const result = pageSlice(items, requestedPage);
  container.append(
    table(headers, result.rows.map(map), emptyTitle, emptyDescription),
  );
  if (result.total <= 20) return;
  const footer = node("div", null, "pager");
  footer.append(node("span", `共 ${result.total} 条`));
  const actions = node("div", null, "pager-actions");
  const prev = button("上一页", () => onPage(result.page - 1));
  const next = button("下一页", () => onPage(result.page + 1));
  prev.disabled = result.page <= 1;
  next.disabled = result.page >= result.pages;
  actions.append(prev, node("span", `${result.page} / ${result.pages}`), next);
  footer.append(actions);
  container.append(footer);
}
function detailList(entries) {
  const list = node("dl", null, "detail-list");
  entries.forEach(([name, value]) => {
    const row = node("div");
    const description = node("dd");
    description.append(
      value instanceof Node
        ? value
        : document.createTextNode(String(value ?? "—")),
    );
    row.append(node("dt", name), description);
    list.append(row);
  });
  return list;
}
function stat(label, value, note, highlight = false) {
  const card = node(
    "article",
    null,
    `stat-card${highlight ? " highlight" : ""}`,
  );
  card.append(
    node("p", label, "stat-label"),
    node("p", value, "stat-value"),
    node("p", note, "stat-note"),
  );
  return card;
}
function sortedRecent(items) {
  return [...items].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  );
}

// ── 表单与管理动作共用方法 ──
function send(path, method, body, options) {
  return api(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
    options,
  );
}
function control(tag, { type, value, placeholder, label, min, max } = {}) {
  const element = node(tag, null, tag === "select" ? "select" : "input");
  if (type) element.type = type;
  if (value !== undefined && value !== null) element.value = String(value);
  if (placeholder) element.placeholder = placeholder;
  if (label) element.setAttribute("aria-label", label);
  if (min !== undefined) element.min = String(min);
  if (max !== undefined) element.max = String(max);
  return element;
}
function choose(options, value, label) {
  const element = control("select", { label });
  Object.entries(options).forEach(([key, text]) => {
    const option = node("option", text);
    option.value = key;
    if (key === value) option.selected = true;
    element.append(option);
  });
  element.value = value;
  return element;
}
function field(label, input, hint) {
  const wrapper = node("label", null, "field");
  wrapper.append(node("span", label, "field-label"), input);
  if (hint) wrapper.append(node("span", hint, "field-hint"));
  return wrapper;
}
function toolbar(...children) {
  const bar = node("div", null, "toolbar");
  bar.append(...children);
  return bar;
}
// 一次只执行一个管理动作，成功后重载页面并提示结果；失败保留当前页，让管理员修正输入。
async function act(trigger, task, success) {
  if (trigger) trigger.disabled = true;
  try {
    const result = await task();
    await loadPage();
    notice(typeof success === "function" ? success(result) : success);
    return result;
  } catch (error) {
    if (!isAbort(error)) notice(errorText(error), "error");
  } finally {
    if (trigger) trigger.disabled = false;
  }
}
// 删除等操作需要再次点击确认，不依赖浏览器原生弹窗。
function confirmButton(label, onConfirm, className = "button small danger") {
  let armed = false;
  const element = button(
    label,
    () => {
      if (!armed) {
        armed = true;
        element.textContent = `再点一次确认${label}`;
        element.classList.add("armed");
        return;
      }
      armed = false;
      element.textContent = label;
      void onConfirm(element);
    },
    className,
  );
  return element;
}
function shortTime(value) {
  return value ? dateTime(value) : "—";
}

function usageLedger(summary) {
  return summary.ledger?.totals || summary.llm || {};
}
function trendPanel(rows, title = "近 7 日调用趋势") {
  const section = panel(
    title,
    "北京时间 · 外部服务网络调用次数，不等于已扣费次数",
  );
  const data = usageTrend(rows);
  if (!data.length) {
    section.wrapper.append(
      emptyState(
        "暂无用量记录",
        "开始使用 AI 或文字识别后，这里会显示已记录的调用。",
      ),
    );
    return section.wrapper;
  }
  const body = node("div", null, "trend-body");
  const chart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chart.setAttribute("viewBox", "0 0 700 200");
  chart.setAttribute("role", "img");
  chart.setAttribute(
    "aria-label",
    `近 ${data.length} 日共记录 ${number(data.reduce((total, row) => total + row.calls, 0))} 次调用，下方可展开每日明细。`,
  );
  chart.classList.add("trend-chart");
  const svgNode = (tag, attrs, text) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([key, value]) =>
      element.setAttribute(key, String(value)),
    );
    if (text !== undefined) element.textContent = text;
    chart.append(element);
  };
  [32, 92, 152].forEach((y) =>
    svgNode("line", { x1: 18, y1: y, x2: 682, y2: y, class: "chart-grid" }),
  );
  const spacing = 660 / data.length;
  data.forEach((row, index) => {
    const center = 20 + spacing * (index + 0.5);
    const height = row.height * 112;
    svgNode("rect", {
      x: center - 16,
      y: 152 - Math.max(2, height),
      width: 32,
      height: Math.max(2, height),
      rx: 7,
      class: row.calls ? "chart-bar" : "chart-bar zero",
    });
    svgNode(
      "text",
      {
        x: center,
        y: 140 - height,
        class: "chart-count",
        "text-anchor": "middle",
      },
      number(row.calls),
    );
    svgNode(
      "text",
      { x: center, y: 183, class: "chart-date", "text-anchor": "middle" },
      String(row.date || "")
        .slice(5)
        .replace("-", "/"),
    );
  });
  body.append(chart);
  const details = node("details", null, "trend-details");
  details.append(
    node("summary", "查看每日调用与 token 明细"),
    table(
      ["日期", "调用次数", "已报告 token", "结果未知"],
      data.map((row) => [
        row.date,
        number(row.calls),
        number(row.tokens),
        number(row.unknownJobs),
      ]),
      "暂无记录",
      "",
    ),
  );
  section.wrapper.append(body, details);
  return section.wrapper;
}
// ── 业务页面渲染 ──
function renderOverview(summary, jobs, usage, todo) {
  const totals = jobTotals(jobs.kinds);
  const ledger = usageLedger(usage);
  const open = todo.feedback.map + todo.feedback.artifact;
  const items = [
    {
      label: "待处理反馈",
      note: open
        ? `地图题 ${todo.feedback.map} 条 · 生成内容 ${todo.feedback.artifact} 条`
        : "暂时没有待处理的反馈",
      state: open ? "warning" : "success",
      mark: open ? String(open) : "✓",
      page: "feedback",
    },
    {
      label: "失败任务",
      note: `近 24 小时失败 ${todo.jobs.failed24h} 次 · 结果未知 ${todo.jobs.unknown24h} 次 · 可重试 ${todo.jobs.retryable} 个`,
      state: todo.jobs.retryable || todo.jobs.unknown24h ? "warning" : "success",
      mark: todo.jobs.retryable ? String(todo.jobs.retryable) : "✓",
      page: "jobs",
    },
    {
      label: "AI 接口",
      note: !todo.ai.enabled
        ? "没有启用的接口，学生用不了 AI 功能"
        : `启用 ${todo.ai.enabled} 个（识图 ${todo.ai.vision} 个）${todo.ai.cooling ? ` · ${todo.ai.cooling} 个刚出错正在冷却` : " · 全部正常"}`,
      state: !todo.ai.enabled ? "danger" : todo.ai.cooling ? "warning" : "success",
      mark: !todo.ai.enabled || todo.ai.cooling ? "!" : "✓",
      page: "ai",
    },
    // 没有配置价格的模型按现有价格中的最高费率核算额度。
    ...(todo.ai.unpriced?.length
      ? [
          {
            label: "模型价格",
            note: `${todo.ai.unpriced.join("、")} 还没填价格，暂按最高价扣学生额度`,
            state: "warning",
            mark: String(todo.ai.unpriced.length),
            page: "settings",
          },
        ]
      : []),
    // 统计服务商已响应但没有返回 token 用量的调用。
    ...(todo.ai.noUsage24h
      ? [
          {
            label: "用量缺失",
            note: `近 24 小时有 ${todo.ai.noUsage24h} 次模型调用没返回用量，已按字数估算扣学生额度`,
            state: "warning",
            mark: String(todo.ai.noUsage24h),
            page: "ai",
          },
        ]
      : []),
    {
      label: "用户",
      note: `共 ${number(todo.users.total)} 人 · 今日新增 ${number(todo.users.newToday)} · 已停用 ${todo.users.banned} · 单独调额 ${todo.users.overrides}`,
      state: "neutral",
      mark: "↗",
      page: "users",
    },
  ];
  const attention = panel("待办", "点一行直接去处理");
  const body = node("div", null, "attention-list");
  items.forEach((item) => {
    const row = button("", () => navigate(item.page), "attention-item");
    const text = node("span", null, "attention-copy");
    text.append(node("strong", item.label), node("span", item.note));
    const arrow = node("span", "→", "attention-arrow");
    arrow.setAttribute("aria-hidden", "true");
    row.append(
      node("span", item.mark, `attention-mark ${item.state}`),
      text,
      arrow,
    );
    body.append(row);
  });
  attention.wrapper.append(body);
  const stats = node("div", null, "stats-grid");
  stats.append(
    stat("当前用户", number(summary.users), "当前保留的注册账号", true),
    stat("今日服务调用", number(ledger.calls), "北京时间 · 记录的网络尝试"),
    stat(
      "近 7 日任务成功率",
      percent(totals.successRate),
      "成功 ÷ 已结束任务（含结果未知）",
    ),
    stat(
      "待完成任务",
      number(queuePending(jobs.queue)),
      "全部排队与进行中的任务，含较早任务",
    ),
  );
  const columns = node("div", null, "two-columns overview-columns");
  columns.append(attention.wrapper, trendPanel(usage.ledger?.trend || usage.trend));
  content.append(stats, columns);
  content.append(
    node(
      "p",
      `服务本次已运行 ${duration(summary.uptimeSec)}。`,
      "field-hint",
    ),
  );
}
function renderJobs(summary) {
  const totals = jobTotals(summary.kinds);
  const stats = node("div", null, "stats-grid");
  stats.append(
    stat("近 7 天任务", totals.total, `北京时间 ${summary.from} 起`, true),
    stat("成功率", percent(totals.successRate), "只计已结束的任务"),
    stat("失败", totals.failed, "确定失败，可以重试"),
    stat("结果未知", totals.unknown, "可能已计费，不会自动重试"),
  );
  content.append(stats);
  const kinds = panel(
    "按任务类型",
    "用时从提交算到完成（含排队），只统计成功任务；P95 表示 95% 的任务不超过该用时",
  );
  kinds.wrapper.append(
    table(
      [
        "任务",
        "排队",
        "进行中",
        "成功",
        "失败",
        "结果未知",
        "平均用时",
        "P95 用时",
      ],
      summary.kinds.map((kind) => [
        JOB_KINDS[kind.kind] || kind.kind,
        kind.queued,
        kind.running,
        kind.succeeded,
        kind.failed,
        kind.unknown,
        duration(kind.avgSec),
        duration(kind.p95Sec),
      ]),
      "暂无任务类型",
      "服务端没有返回任务类型。",
    ),
  );
  if (summary.queue) {
    const queue = node("div", null, "queue-strip");
    queue.append(
      node("strong", "当前队列"),
      node(
        "span",
        `排队 ${number(summary.queue.queued)} · 进行中 ${number(summary.queue.running)}`,
      ),
      node(
        "span",
        `最久排队 ${duration(summary.queue.oldestQueuedSec)} · 最久运行 ${duration(summary.queue.oldestRunningSec)}`,
      ),
    );
    content.append(queue);
  }
  const failures = panel(
    "最近失败与结果未知",
    "最多 50 条，只有错误类型和说明，不含用户内容。修好 AI 接口后可以重试：沿用原任务，不再扣学生当天的额度；结果未知的任务可能已经计费，不提供重试。",
  );
  failures.wrapper.append(
    table(
      ["时间", "任务", "状态", "错误码", "说明", "任务编号", "操作"],
      summary.recent.map((job) => [
        dateTime(job.createdAt),
        JOB_KINDS[job.kind] || job.kind,
        badge(job.status, JOB_STATUS[job.status]),
        node("span", job.code || "—", "mono"),
        job.message || "—",
        node("span", job.id, "mono"),
        job.retryable
          ? button("重试", (event) =>
              act(
                event.currentTarget,
                () => send(`/v1/admin/jobs/${encodeURIComponent(job.id)}/retry`, "POST"),
                "已重新排队，稍后刷新查看结果。",
              ),
            )
          : "—",
      ]),
      "暂无失败任务",
      "失败或结果未知的任务会在这里列出。",
    ),
  );
  content.append(kinds.wrapper, failures.wrapper);
}
function renderQuality(summary) {
  const sum = (items, key) =>
    items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const size = (item) => item.draft + item.confirmed;
  const kind = (name) =>
    summary.materials.find((item) => item.kind === name) || {
      draft: 0,
      confirmed: 0,
    };
  const drafts = sum(summary.materials, "draft");
  const reports = summary.generated.reduce(
    (total, item) =>
      total + Object.values(item.reports).reduce((a, b) => a + b, 0),
    0,
  );
  const stats = node("div", null, "stats-grid");
  stats.append(
    stat("资料／笔记", size(kind("note")), "当前保存的全部资料", true),
    stat("题目／错题", size(kind("problem")), "当前保存的全部题目"),
    stat(
      "待核对",
      percent(ratio(drafts, drafts + sum(summary.materials, "confirmed"))),
      `${drafts} 份收录后还没确认原文`,
    ),
    stat(
      "用户反馈",
      reports,
      `涉及 ${sum(summary.generated, "reported")} 份生成结果`,
    ),
  );
  content.append(stats);
  const materials = panel(
    "资料与题目",
    "待核对：收录后还没确认原文，还不能讲解、出题或给提示",
  );
  materials.wrapper.append(
    table(
      ["类型", "已确认", "待核对", "待核对比例", "图片收录"],
      summary.materials.map((item) => [
        MATERIAL_KINDS[item.kind] || item.kind,
        item.confirmed,
        item.draft,
        percent(ratio(item.draft, size(item))),
        item.images,
      ]),
      "暂无资料",
      "用户收录资料或题目后会在这里统计。",
    ),
  );
  const feedback = panel(
    "生成结果与用户反馈",
    "按生成类型累计；用户填写的反馈备注是个人原文，不在这里显示",
  );
  feedback.wrapper.append(
    table(
      ["生成类型", "份数", "被反馈", ...Object.values(REPORT_REASONS)],
      summary.generated.map((item) => [
        ARTIFACT_KINDS[item.kind] || item.kind,
        item.count,
        item.reported
          ? `${item.reported}（${percent(ratio(item.reported, item.count))}）`
          : 0,
        ...Object.keys(REPORT_REASONS).map(
          (reason) => item.reports[reason] ?? 0,
        ),
      ]),
      "暂无生成结果",
      "用户生成讲解、自测或提示后会在这里统计。",
    ),
  );
  const mapReports = mapReportTable(summary.mapReports);
  const map = panel(
    "地图题反馈",
    "学习地图里“这题有问题”的条数，按反馈多少排；学生附带的答案不在这里显示",
  );
  map.wrapper.append(
    table(
      mapReports.headers,
      mapReports.rows,
      "暂无地图题反馈",
      "用户在知识点页点“这题有问题”后会在这里统计。",
    ),
  );
  content.append(materials.wrapper, feedback.wrapper, map.wrapper);
}
function renderUsage(summary) {
  const ledger = usageLedger(summary);
  const stats = node("div", null, "stats-grid");
  stats.append(
    stat(
      "今日服务调用",
      number(ledger.calls),
      "匿名消耗总账 · 网络尝试次数",
      true,
    ),
    stat(
      "今日已报告 token",
      number((ledger.promptTokens || 0) + (ledger.completionTokens || 0)),
      "仅合计供应商实际报告的数量",
    ),
    stat(
      "今日结果未知",
      number(ledger.unknown ?? 0),
      "可能已计费，请到供应商核账",
    ),
    stat(
      "实际费用",
      costLabel(summary.cost),
      "调用和 token 数不能直接当作账单",
    ),
  );
  content.append(stats);
  const coverage = node("div", null, "scope-note");
  coverage.append(
    node("strong", "消耗统计口径"),
    node("p", summary.cost?.note || "实际费用以供应商账单为准。"),
  );
  if (summary.ledger?.startedAt)
    coverage.append(
      node(
        "p",
        `开始记账：${dateTime(summary.ledger.startedAt)}（北京时间）。累计记录 ${number(summary.ledger.cumulative?.calls)} 次网络调用。`,
      ),
    );
  const details = node("details");
  details.append(node("summary", "了解统计范围与未报告用量"));
  (summary.coverage?.limitations || []).forEach((text) =>
    details.append(node("p", text)),
  );
  details.append(
    node(
      "p",
      `今日 ${number(ledger.unreported ?? 0)} 次调用未完整报告 token；其中可能包含不按 token 计量的 OCR 或判定服务，不能按零消耗理解。`,
    ),
  );
  coverage.append(details);
  content.append(coverage);
  const model = panel(
    "今日服务与模型",
    "按来源、供应商和模型聚合，不包含用户或输入内容",
  );
  model.wrapper.append(
    table(
      [
        "调用来源",
        "供应商 / 模型",
        "尝试次数",
        "输入 token",
        "输出 token",
        "未知 / 进行中",
        "token 未全报",
      ],
      (summary.ledger?.providers || []).map((item) => {
        const service = node("span", item.provider || "未标识", "cell-title");
        service.append(node("span", item.model || "未标识模型", "cell-detail"));
        return [
          node(
            "span",
            CALL_SOURCES[item.source] || item.source || "—",
            "cell-kind",
          ),
          service,
          number(item.calls),
          number(item.promptTokens),
          number(item.completionTokens),
          `${number(item.unknown)} / ${number(item.pending)}`,
          number(item.unreported),
        ];
      }),
      "今日暂无服务调用",
      "使用 AI、判定或文字识别后，这里会按服务记录消耗。",
    ),
  );
  content.append(model.wrapper, trendPanel(summary.ledger?.trend || []));
  const quota = panel(
    `今日额度 · 北京时间 ${summary.date}`,
    "按无内容额度凭证统计；各额度独立计数，删除学习内容不会返还已用额度。“用到八成”“已用完”按全局额度计算，单独调过额度的用户以用户管理里为准",
  );
  quota.wrapper.append(
    table(
      ["额度", "每人每天", "今日计量", "使用人数", "用到八成以上", "已用完"],
      summary.buckets.map((item) => [
        BUCKETS[item.bucket] || item.bucket,
        number(item.limit),
        number(item.jobs),
        number(item.users),
        number(item.nearLimit),
        number(item.atLimit),
      ]),
      "暂无额度配置",
      "请检查服务的每日额度配置。",
    ),
  );
  content.append(quota.wrapper);
  const storage = panel(
    "存储与备份",
    "存储占用来自本次检查，备份是否成功需核对执行记录",
  );
  const body = node("div", null, "panel-body storage-body");
  body.append(
    detailList([
      ["数据库逻辑大小", bytes(summary.storage.databaseBytes)],
      [
        "原图",
        `${number(summary.storage.uploads.files)} 张 · ${bytes(summary.storage.uploads.bytes)}`,
      ],
      ["数据库结构版本", summary.storage.schemaVersion],
    ]),
    node(
      "p",
      "备份时先停止应用与后台任务，再运行 backup-bundle，保存数据库和被引用原图；恢复到全新目录并验证。不要只复制正在使用的数据库。",
      "field-hint",
    ),
  );
  storage.wrapper.append(body);
  content.append(storage.wrapper);
}
function renderAudit(entries) {
  const action = choose(AUDIT_GROUPS, state.audit.action, "动作类型");
  const from = control("input", { type: "date", value: state.audit.from, label: "开始日期" });
  const to = control("input", { type: "date", value: state.audit.to, label: "结束日期" });
  const apply = () => {
    state.audit = { action: action.value, from: from.value, to: to.value };
    return loadPage();
  };
  content.append(
    toolbar(
      field("动作", action),
      field("从（北京时间）", from),
      field("到", to),
      button("筛选", apply, "button small primary"),
      button("清除", () => {
        state.audit = blankState().audit;
        return loadPage();
      }),
    ),
  );
  const section = panel(
    "审计日志",
    "符合条件的最近最多 500 条，记录由服务端生成，不可编辑或删除",
  );
  content.append(section.wrapper);
  const draw = (pageNumber) => {
    section.wrapper
      .querySelectorAll(".table-wrap,.pager,.empty")
      .forEach((child) => child.remove());
    paginatedTable(
      section.wrapper,
      ["时间", "操作人", "动作", "资源", "详情"],
      sortedRecent(entries),
      (entry) => {
        const details = node("details", null, "audit-details");
        details.append(
          node("summary", "展开详情"),
          node("pre", JSON.stringify(entry.details ?? {}, null, 2)),
        );
        return [
          dateTime(entry.createdAt),
          entry.actor === "admin:shared" ? "管理员" : entry.actor || "—",
          badge("", ACTIONS[entry.action] || entry.action),
          node("span", entry.resourceId || "—", "mono"),
          details,
        ];
      },
      pageNumber,
      draw,
      "暂无审计记录",
      "登录等关键操作后，服务端会留下记录。",
    );
  };
  draw(1);
}
function renderOperations(operations, live, ready) {
  const stats = node("div", null, "stats-grid");
  stats.append(
    stat(
      "服务存活",
      live.status === "ok" ? "正常" : "待检查",
      `本次已运行 ${duration(live.uptimeSec)}`,
      live.status === "ok",
    ),
    stat(
      "数据库",
      operations.database === "ok" ? "已连接" : "待检查",
      "以本次健康检查为准",
    ),
    stat(
      "进程请求数",
      number(operations.metrics?.requestCount),
      "服务进程本次启动以来累计",
    ),
    stat(
      "进程错误数",
      number(operations.metrics?.errorCount),
      "结合服务日志与请求编号排查",
    ),
  );
  content.append(stats);
  const columns = node("div", null, "two-columns");
  const environment = panel("运行环境", "进程级指标，服务重启后重新累计");
  const body = node("div", null, "panel-body");
  body.append(
    detailList([
      ["运行模式", operations.mode === "production" ? "生产环境" : "开发环境"],
      ["启动时间", dateTime(operations.startedAt)],
      [
        "就绪检查",
        badge(ready.status, ready.status === "ready" ? "就绪" : "尚未就绪"),
      ],
      [
        "平均请求用时",
        typeof operations.metrics?.avgDurationMs === "number"
          ? `${operations.metrics.avgDurationMs} ms`
          : "—",
      ],
      [
        "进程内存 / JS 堆",
        `${bytes(operations.process?.rssBytes)} / ${bytes(operations.process?.heapUsedBytes)}`,
      ],
      ["Node.js", operations.process?.nodeVersion || "—"],
      [
        "调用记账",
        badge(
          operations.accounting?.status || "unknown",
          operations.accounting?.status === "ok"
            ? "写入正常"
            : operations.accounting?.status === "degraded"
              ? `记录失败 ${number(operations.accounting.writeFailures)} 次`
              : "未返回状态",
        ),
      ],
    ]),
  );
  if (ready.note) body.append(node("p", ready.note, "field-hint"));
  if (operations.accounting?.status === "degraded")
    body.append(
      node(
        "p",
        "有调用计量写入失败，请排查数据库写入，并核对供应商账单。不能把未完成记录当作零消耗。",
        "inline-error",
      ),
    );
  environment.wrapper.append(body);
  const integrations = panel(
    "服务接入",
    "已配置表示凭证就位，实际连通与费用仍需供应商核对",
  );
  const integrationBody = node("div", null, "panel-body");
  const names = {
    wechat: "微信登录",
    ai: "AI 生成",
    judge: "答案判定",
    ocr: "文字识别",
  };
  Object.entries(operations.integrations || {}).forEach(([key, configured]) => {
    const row = node("div", null, "status-line");
    row.append(
      node("span", names[key] || key),
      badge(configured ? "ready" : "unknown", configured ? "已配置" : "未配置"),
    );
    integrationBody.append(row);
  });
  if (!Object.keys(operations.integrations || {}).length)
    integrationBody.append(node("p", "服务未返回接入状态。", "muted"));
  integrations.wrapper.append(integrationBody);
  columns.append(environment.wrapper, integrations.wrapper);
  content.append(columns);
  const security = panel(
    "管理访问保护",
    "管理会话与学习账号分离，权限由服务端校验",
  );
  const securityBody = node("div", null, "panel-body");
  const state = operations.security || {};
  securityBody.append(
    detailList([
      [
        "短期管理会话",
        badge(
          state.adminSessions ? "ready" : "unknown",
          state.adminSessions ? "已启用" : "待核对",
        ),
      ],
      [
        "闲置 / 最长时限",
        `${duration(state.adminIdleTimeoutSec)} / ${duration(state.adminAbsoluteTimeoutSec)}`,
      ],
      ["Cookie 传输限制", state.secureCookies ? "仅 HTTPS" : "本地开发 HTTP"],
      [
        "管理员来源配置",
        state.adminOriginConfigured ? "已配置" : "本地同源检查",
      ],
      [
        "开发登录入口",
        badge(
          state.devLoginEnabled ? "unknown" : "ready",
          state.devLoginEnabled ? "已开启 · 开发环境使用" : "已关闭",
        ),
      ],
      [
        "可信代理模式",
        state.proxyMode === "loopback" ? "仅本机反向代理" : "不信任代理头",
      ],
    ]),
  );
  security.wrapper.append(securityBody);
  const backup = panel(
    "备份与发布巡检",
    "把执行结果留在运维记录里，定期验证能够恢复",
  );
  const backupBody = node("div", null, "panel-body");
  const backupNote = node("div", null, "scope-note compact");
  backupNote.append(
    badge("unknown", "备份状态未接入"),
    node(
      "p",
      operations.backup?.note || "请按运维手册定期备份，并在独立目录验证恢复。",
    ),
  );
  backupBody.append(backupNote);
  const steps = node("ol", null, "maintenance-steps");
  [
    ["检查异常", "查看任务积压、失败和结果未知，使用请求编号关联日志。"],
    [
      "停服备份",
      "停止应用和任务后打包数据库及引用原图；校验哈希，并在新目录演练恢复。",
    ],
    [
      "验证再更新",
      "完成测试与迁移检查，保留旧版本及可恢复备份，更新后复查就绪状态。",
    ],
  ].forEach(([title, text]) => {
    const item = node("li");
    item.append(node("strong", title), node("p", text));
    steps.append(item);
  });
  backupBody.append(steps);
  backup.wrapper.append(backupBody);
  const lower = node("div", null, "two-columns");
  lower.append(security.wrapper, backup.wrapper);
  content.append(lower);
}

// ── 反馈处理 ──
// 保留学生看到的题面与提交的答案，供维护者区分题目错误和判定错误；TeX 按源码文字展示。
function problemBlock(problem) {
  const block = node("div", null, "problem-block");
  if (!problem) {
    block.append(node("p", "旧记录没有保存是哪一道题。", "muted"));
    return block;
  }
  block.append(node("p", problem.text, "tex"));
  const answers = node("div", null, "answer-lines");
  if (problem.kind === "multi")
    problem.parts.forEach((part) =>
      answers.append(node("p", `${part.label}：${part.answer}`, "mono")),
    );
  else if (problem.kind === "choice")
    problem.questions.forEach((question, index) => {
      const right = question.options.find((o) => o.id === question.answer);
      answers.append(
        node(
          "p",
          `第 ${index + 1} 问 ${question.prompt} → ${question.answer}. ${right?.text ?? ""}`,
          "tex",
        ),
      );
    });
  else answers.append(node("p", problem.answer, "mono"));
  block.append(node("p", "参考答案", "field-label"), answers);
  if (problem.hint || problem.explanation) {
    const more = node("details");
    more.append(node("summary", "提示与解析"));
    if (problem.hint) more.append(node("p", `提示：${problem.hint}`, "tex"));
    if (problem.explanation)
      more.append(node("p", `解析：${problem.explanation}`, "tex"));
    block.append(more);
  }
  block.append(
    node(
      "p",
      problem.teacherReviewed ? "已经教师审定" : "AI 起草 · 未经教师审定",
      "field-hint",
    ),
  );
  return block;
}
function answerText(value) {
  if (value === null || value === undefined || value === "") return "（没有附作答）";
  return Array.isArray(value) ? value.join(" ｜ ") : String(value);
}
function understoodText(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (!Array.isArray(value)) return String(value);
  return value
    .map(
      (item, index) =>
        `第 ${index + 1} 空：${item.read ?? "—"}（${VERDICTS[item.verdict] || item.verdict || "—"}）`,
    )
    .join("\n");
}
function handleBar(item) {
  const bar = node("div", null, "handle-bar");
  const path = `/v1/admin/feedback/${item.type}/${encodeURIComponent(item.id)}`;
  if (item.handledAt) {
    bar.append(
      badge("succeeded", `已处理 · ${shortTime(item.handledAt)}`),
      node("span", item.handledNote || "", "muted"),
      button("重新打开", (event) =>
        act(event.currentTarget, () => send(path, "PUT", { handled: false }), "已重新打开。"),
      ),
    );
    return bar;
  }
  const note = control("input", {
    placeholder: "处理说明（可不填），如：已改题 / 判定没问题",
    label: "处理说明",
  });
  note.maxLength = 200;
  bar.append(
    note,
    button(
      "标记已处理",
      (event) =>
        act(
          event.currentTarget,
          () => send(path, "PUT", { handled: true, note: note.value.trim() || undefined }),
          "已标记处理。",
        ),
      "button small primary",
    ),
  );
  return bar;
}
function renderFeedback(data) {
  const status = choose(
    { open: "待处理", handled: "已处理", all: "全部" },
    state.feedback.status,
    "处理状态",
  );
  const type = choose(
    { all: "全部来源", map: "地图题", artifact: "生成内容" },
    state.feedback.type,
    "反馈来源",
  );
  const apply = () => {
    state.feedback.status = status.value;
    state.feedback.type = type.value;
    return loadPage();
  };
  status.addEventListener("change", apply);
  type.addEventListener("change", apply);
  const bar = toolbar(field("状态", status), field("来源", type));
  if (state.feedback.point)
    bar.append(
      badge("", `只看知识点 ${state.feedback.point}`),
      button("看全部", () => {
        state.feedback.point = "";
        return loadPage();
      }),
    );
  content.append(
    bar,
    node(
      "p",
      "这里显示学生反馈时的原因、备注和当时的作答，用来判断题目或判定是否有错；学生的笔记、随心记和问 AI 对话不在管理台显示。",
      "scope-note compact",
    ),
  );
  if (!data.items.length) {
    content.append(
      emptyState(
        state.feedback.status === "open" ? "没有待处理的反馈" : "没有符合条件的反馈",
        "学生在知识点页点“这题有问题”或反馈生成内容后，会出现在这里。",
      ),
    );
    return;
  }
  const list = node("div", null, "card-list");
  data.items.forEach((item) => {
    const card = node("article", null, "feedback-card");
    const head = node("div", null, "card-head");
    if (item.type === "map") {
      head.append(
        badge("", "地图题"),
        node("strong", `${item.chapter} · ${item.pointName}`),
        node(
          "span",
          item.problemIndex === null ? "" : item.problemIndex === 0 ? "初始题" : "复习题",
          "muted",
        ),
        badge("warning", MAP_REASONS[item.reason] || item.reason),
        node("span", shortTime(item.createdAt), "muted"),
      );
      const columns = node("div", null, "two-columns feedback-columns");
      const left = node("div");
      left.append(node("p", "题目", "field-label"), problemBlock(item.problem));
      const right = node("div");
      right.append(
        node("p", "学生作答", "field-label"),
        node("p", answerText(item.answer), "mono answer-box"),
        node("p", "系统理解为", "field-label"),
        node("p", understoodText(item.understood), "mono answer-box"),
        node("p", "判定结果", "field-label"),
        item.verdict
          ? badge(item.verdict === "correct" ? "succeeded" : "unknown", VERDICTS[item.verdict] || item.verdict)
          : node("span", "—"),
        node("p", null, "spacer"),
        button("在题库中查看", () => {
          state.bank = { ...blankState().bank, q: item.pointId };
          return navigate("bank");
        }),
      );
      columns.append(left, right);
      card.append(head, columns, handleBar(item));
    } else {
      head.append(
        badge("", "生成内容"),
        node("strong", ARTIFACT_KINDS[item.artifactKind] || item.artifactKind),
        badge("warning", REPORT_REASONS[item.reason] || item.reason),
        node("span", item.model ? `模型 ${item.model}` : "", "muted"),
        node("span", shortTime(item.createdAt), "muted"),
      );
      const body = node("div", null, "panel-body compact");
      body.append(
        node("p", "学生备注", "field-label"),
        node("p", item.note || "（没有填写备注）", "answer-box"),
        node(
          "p",
          "生成内容来自学生自己的资料，管理台不显示原文；同一模型反复被反馈时，可以在 AI 接口页调整顺序或思考程度。",
          "field-hint",
        ),
      );
      card.append(head, body, handleBar(item));
    }
    list.append(card);
  });
  content.append(list);
}

// ── 用户管理 ──
const yuan = (value) => `¥${Number(value || 0).toFixed(2)}`;
// 对照当天和本周的金额预算，展示已使用额度。
function spendSummary(spend, budget) {
  return `今日 ${yuan(spend.day)}/${yuan(budget.day)} · 本周 ${yuan(spend.week)}/${yuan(budget.week)}`;
}
function usageSummary(today, limits) {
  return ["chat", "ai", "notes"]
    .map((bucket) => `${LIMIT_NAMES[bucket]} ${today[bucket]}/${limits[bucket]}`)
    .join(" · ");
}
function renderUsers(list, detail) {
  if (detail) renderUserDetail(detail);
  const search = control("input", {
    value: state.users.q,
    placeholder: "用户编号开头或昵称",
    label: "搜索用户",
  });
  const filter = choose(
    { all: "全部用户", banned: "已停用", custom: "单独调过额度" },
    state.users.filter,
    "筛选",
  );
  const submit = () => {
    state.users = { ...state.users, q: search.value.trim(), filter: filter.value, page: 1 };
    return loadPage();
  };
  const form = node("form", null, "toolbar");
  form.append(
    field("搜索", search),
    field("筛选", filter),
    button("搜索", submit, "button small primary"),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  filter.addEventListener("change", submit);
  const section = panel(
    `用户 · 共 ${number(list.total)} 人`,
    "按最近活跃排序。今日用量按北京时间，额度含单独调整；不显示微信标识和学习内容。",
  );
  section.wrapper.append(
    table(
      ["用户", "登录方式", "注册时间", "最近活跃", "今日用量", "状态", ""],
      list.items.map((user) => {
        const name = node("span", user.nickname || "—", "cell-title");
        name.append(node("span", user.id, "cell-detail mono"));
        const limits = { ...list.global, ...user.quota };
        return [
          name,
          user.authMode === "wechat" ? "微信" : "开发身份",
          shortTime(user.createdAt),
          shortTime(user.lastActiveAt),
          user.spend && list.budget
            ? spendSummary(user.spend, list.budget)
            : usageSummary(user.today, limits),
          user.bannedAt
            ? badge("failed", "已停用")
            : Object.keys(user.quota).length
              ? badge("unknown", "单独额度")
              : badge("succeeded", "正常"),
          button("查看", () => {
            state.users.id = user.id;
            return loadPage();
          }),
        ];
      }),
      "没有找到用户",
      "换个关键词，或清空筛选条件。",
    ),
  );
  if (list.pages > 1) {
    const footer = node("div", null, "pager");
    footer.append(node("span", `共 ${list.total} 人`));
    const actions = node("div", null, "pager-actions");
    const go = (page) => {
      state.users.page = page;
      return loadPage();
    };
    const prev = button("上一页", () => go(list.page - 1));
    const next = button("下一页", () => go(list.page + 1));
    prev.disabled = list.page <= 1;
    next.disabled = list.page >= list.pages;
    actions.append(prev, node("span", `${list.page} / ${list.pages}`), next);
    footer.append(actions);
    section.wrapper.append(footer);
  }
  content.append(form, section.wrapper);
}
function renderUserDetail(user) {
  const path = `/v1/admin/users/${encodeURIComponent(user.id)}`;
  const section = panel(
    `${user.nickname || "用户"} · ${user.bannedAt ? "已停用" : "正常"}`,
    "只显示计数与额度，不显示资料、笔记或对话内容",
  );
  section.heading.append(
    button("返回列表", () => {
      state.users.id = "";
      return loadPage();
    }),
  );
  const body = node("div", null, "panel-body");
  body.append(
    detailList([
      ["用户编号", node("span", user.id, "mono")],
      ["登录方式", user.authMode === "wechat" ? "微信" : "开发身份"],
      ["注册时间", shortTime(user.createdAt)],
      ["最近活跃", shortTime(user.lastActiveAt)],
      [
        "学习数据",
        `资料 ${user.counts.materials} · 随心记 ${user.counts.notes} · 问 AI 对话 ${user.counts.threads} · 已掌握知识点 ${user.counts.mapPoints} · 未掌握错题 ${user.counts.mistakes}`,
      ],
      ["反馈与任务", `提交反馈 ${user.counts.reports} 条 · 近 7 天任务 ${user.counts.jobs7d} 个`],
      [
        "本月估算费用",
        `${user.monthlyCost?.amount == null ? "—" : `¥${user.monthlyCost.amount.toFixed(4)}`} · 估算 · 含失败的调用，删除的内容不计`,
      ],
      ...(user.budget
        ? [
            [
              "额度消耗",
              `今日 ${yuan(user.budget.day.spent)} / ${yuan(user.budget.day.budget)}（${user.budget.day.pct}%）· 本周 ${yuan(user.budget.week.spent)} / ${yuan(user.budget.week.budget)}（${user.budget.week.pct}%）· 本月 ${yuan(user.budget.month)}`,
            ],
          ]
        : []),
    ]),
  );
  if (user.budget) {
    // 账号单独的金额预算；输入框留空表示跟随全局设置。
    const own = {};
    const grid = node("div", null, "quota-grid");
    [["day", "每日额度（元）"], ["week", "每周额度（元）"]].forEach(([key, name]) => {
      own[key] = control("input", {
        type: "number",
        min: 0,
        max: 100000,
        value: user.budget.overrides[key] ?? "",
        placeholder: `全局 ${user.budget.global[key]}`,
        label: name,
      });
      grid.append(field(name, own[key]));
    });
    const saveBudget = button(
      "保存费用额度",
      () => {
        const budget = {};
        for (const [key, input] of Object.entries(own)) {
          const text = String(input.value).trim();
          if (text && !/^\d+(\.\d{1,2})?$/.test(text))
            return notice("费用额度要填 0 或正数（最多两位小数），留空表示跟随全局。", "error");
          budget[key] = text ? Number(text) : null;
        }
        return act(saveBudget, () => send(`${path}/quota`, "PUT", { budget }), "额度已保存，立即生效。");
      },
      "button small primary",
    );
    body.append(
      node("h3", "费用额度", "section-title"),
      node("p", "按模型实际用量折算成钱扣，学生只看到百分比；留空表示跟随全局。", "field-hint"),
      grid,
      toolbar(saveBudget),
    );
  }
  // 次数额度留空表示跟随全局上限。
  const inputs = {};
  const quota = node("div", null, "quota-grid");
  Object.entries(LIMIT_NAMES).forEach(([bucket, name]) => {
    const input = control("input", {
      type: "number",
      min: 0,
      max: 10000,
      value: user.quota[bucket] ?? "",
      placeholder: `全局 ${user.global[bucket]}`,
      label: name,
    });
    inputs[bucket] = input;
    quota.append(
      field(
        name,
        input,
        `今日已用 ${user.usage[bucket].used} / ${user.usage[bucket].limit}`,
      ),
    );
  });
  const saveQuota = button(
    "保存额度",
    () => {
      const body = {};
      for (const [bucket, input] of Object.entries(inputs)) {
        const text = String(input.value).trim();
        if (text && !/^\d+$/.test(text))
          return notice(`${LIMIT_NAMES[bucket]}要填 0 或正整数，留空表示跟随全局。`, "error");
        body[bucket] = text ? Number(text) : null;
      }
      return act(saveQuota, () => send(`${path}/quota`, "PUT", body), "额度已保存，立即生效。");
    },
    "button small primary",
  );
  body.append(
    node("h3", user.budget ? "每日次数（旧版显示用）" : "每日额度", "section-title"),
    node(
      "p",
      user.budget
        ? "已按费用额度扣，这里的次数只给旧版小程序显示剩余，不再拦。"
        : "留空表示跟随全局额度；填 0 表示当天不能使用这一项。",
      "field-hint",
    ),
    quota,
    toolbar(saveQuota),
  );
  // 停用账号后，用户仍可按隐私说明导出数据和注销账号。
  body.append(node("h3", "账号状态", "section-title"));
  if (user.bannedAt) {
    body.append(
      node(
        "p",
        `已于 ${shortTime(user.bannedAt)} 停用${user.banReason ? `，原因：${user.banReason}` : ""}。`,
      ),
      toolbar(
        button("恢复账号", (event) =>
          act(event.currentTarget, () => send(`${path}/ban`, "PUT", { banned: false }), "账号已恢复。"),
        ),
      ),
    );
  } else {
    const reason = control("input", { placeholder: "停用原因（会记进操作记录）", label: "停用原因" });
    reason.maxLength = 200;
    body.append(
      node(
        "p",
        "停用后学生不能再使用任何学习功能，但仍可以登录、导出自己的数据和注销账号。",
        "field-hint",
      ),
      toolbar(
        reason,
        confirmButton("停用账号", (trigger) =>
          act(
            trigger,
            () => send(`${path}/ban`, "PUT", { banned: true, reason: reason.value.trim() || undefined }),
            "账号已停用。",
          ),
        ),
      ),
    );
  }
  if (user.history.length) {
    const history = node("details");
    history.append(node("summary", `管理操作记录（${user.history.length}）`));
    user.history.forEach((entry) =>
      history.append(
        node(
          "p",
          `${shortTime(entry.createdAt)} · ${ACTIONS[entry.action] || entry.action}${entry.details?.reason ? ` · ${entry.details.reason}` : ""}`,
        ),
      ),
    );
    body.append(history);
  }
  section.wrapper.append(body);
  content.append(section.wrapper);
}

// ── 外部大模型接口配置 ──
function endpointForm(view, endpoint) {
  const editing = Boolean(endpoint);
  const section = panel(
    editing ? `修改接口 · ${endpoint.alias}` : "新增接口",
    "任何兼容 OpenAI 格式（/chat/completions）的服务都可以接入",
  );
  const value = endpoint ?? {
    alias: "",
    baseUrl: "",
    model: "",
    vision: false,
    thinkingFormat: "none",
    extraBody: {},
    timeoutMs: 90000,
    enabled: true,
  };
  const alias = control("input", { value: value.alias, placeholder: "如：智谱主力", label: "名称" });
  const baseUrl = control("input", {
    value: value.baseUrl,
    placeholder: "https://open.bigmodel.cn/api/paas/v4",
    label: "接口地址",
  });
  const apiKey = control("input", {
    type: "password",
    placeholder: editing ? `留空保持原密钥（${endpoint.keyHint}）` : "API Key",
    label: "密钥",
  });
  apiKey.autocomplete = "off";
  const model = control("input", { value: value.model, placeholder: "如：glm-4.6", label: "模型名" });
  const format = choose(FORMATS, value.thinkingFormat, "思考参数格式");
  const vision = choose({ no: "只处理文字", yes: "能识图（多模态）" }, value.vision ? "yes" : "no", "识图");
  const timeout = control("input", {
    type: "number",
    min: 5,
    max: 120,
    value: Math.round(value.timeoutMs / 1000),
    label: "超时秒数",
  });
  const enabled = choose({ yes: "启用", no: "停用" }, value.enabled ? "yes" : "no", "状态");
  const extra = control("textarea", {
    value: Object.keys(value.extraBody || {}).length ? JSON.stringify(value.extraBody, null, 2) : "",
    placeholder: '可不填。需要时写 JSON，如 {"top_p": 0.8}',
    label: "附加参数",
  });
  const grid = node("div", null, "form-grid");
  grid.append(
    field("名称", alias, "后台显示用，不能重名"),
    field("模型名", model),
    field("接口地址", baseUrl, "填到 /v1 或 /v4 这一级，不要带 /chat/completions"),
    field("密钥", apiKey, "保存后不会再显示，只显示末 4 位"),
    field("思考参数格式", format, "不同厂商开关“思考”的参数不同；不确定就选“不传”"),
    field("识图", vision, "能识图的接口才会用于拍题识别"),
    field("超时（秒）", timeout),
    field("状态", enabled),
  );
  const save = button(
    editing ? "保存修改" : "添加接口",
    () => {
      let extraBody = {};
      if (String(extra.value).trim()) {
        try {
          extraBody = JSON.parse(extra.value);
        } catch {
          return notice("附加参数不是有效的 JSON。", "error");
        }
        if (!extraBody || typeof extraBody !== "object" || Array.isArray(extraBody))
          return notice("附加参数要写成 JSON 对象，如 {\"top_p\": 0.8}。", "error");
      }
      const body = {
        alias: alias.value.trim(),
        baseUrl: baseUrl.value.trim(),
        model: model.value.trim(),
        thinkingFormat: format.value,
        vision: vision.value === "yes",
        timeoutMs: Math.round(Number(timeout.value) * 1000),
        enabled: enabled.value === "yes",
        extraBody,
      };
      if (editing) body.apiKey = apiKey.value.trim();
      else if (apiKey.value.trim()) body.apiKey = apiKey.value.trim();
      else return notice("新增接口需要填写密钥。", "error");
      return act(
        save,
        async () => {
          await send(
            editing ? `/v1/admin/ai/endpoints/${encodeURIComponent(endpoint.id)}` : "/v1/admin/ai/endpoints",
            editing ? "PUT" : "POST",
            body,
          );
          state.ai.editing = "";
        },
        editing ? "接口已保存。" : "接口已添加，建议点“测试”确认能用。",
      );
    },
    "button small primary",
  );
  const body = node("div", null, "panel-body");
  body.append(
    grid,
    field("附加参数", extra, "原样合并进每次请求；不能覆盖 model、messages、stream、response_format"),
    toolbar(
      save,
      button("取消", () => {
        state.ai.editing = "";
        return loadPage();
      }),
    ),
  );
  section.wrapper.append(body);
  return section.wrapper;
}
function renderAi(view) {
  const endpoints = view.endpoints;
  if (state.ai.editing)
    content.append(
      endpointForm(
        view,
        state.ai.editing === "new" ? null : endpoints.find((e) => e.id === state.ai.editing),
      ),
    );
  const note = node("div", null, "scope-note");
  note.append(
    node("strong", "自动切换"),
    node(
      "p",
      "每次调用按下面的顺序找第一个可用接口；接口没额度、密钥失效、繁忙或连不上时自动换下一个，出错的接口冷却一会儿（额度和密钥问题 10 分钟，繁忙或连不上 1 分钟）后再试。识图只用标了“识图”的接口。问 AI 的回答一旦开始输出就不再切换。",
    ),
  );
  content.append(note);
  const section = panel(`接口 · ${endpoints.length} 个`, "近 24 小时统计不含测试调用");
  section.heading.append(
    button(
      "新增接口",
      () => {
        state.ai.editing = "new";
        return loadPage();
      },
      "button small primary",
    ),
  );
  const list = node("div", null, "card-list");
  if (!endpoints.length)
    list.append(emptyState("还没有接口", "新增一个接口后，学生才能使用 AI 讲解、整理和问 AI。"));
  const order = endpoints.map((e) => e.id);
  const move = (index, step, trigger) => {
    const ids = [...order];
    [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
    return act(trigger, () => send("/v1/admin/ai/order", "PUT", { ids }), "顺序已保存。");
  };
  endpoints.forEach((endpoint, index) => {
    const card = node("article", null, `endpoint-card${endpoint.enabled ? "" : " disabled"}`);
    const head = node("div", null, "card-head");
    head.append(
      node("span", String(index + 1), "order-mark"),
      node("strong", endpoint.alias),
      badge(endpoint.enabled ? "succeeded" : "", endpoint.enabled ? "启用" : "停用"),
    );
    if (endpoint.vision) head.append(badge("", "识图"));
    if (endpoint.health.coolingUntil)
      head.append(badge("unknown", `冷却到 ${shortTime(endpoint.health.coolingUntil)}`));
    const stats = endpoint.last24h;
    const body = node("div", null, "panel-body compact");
    body.append(
      detailList([
        ["模型", node("span", endpoint.model, "mono")],
        ["地址", node("span", endpoint.baseUrl, "mono")],
        ["密钥", endpoint.keyHint],
        ["思考参数", FORMATS[endpoint.thinkingFormat] || endpoint.thinkingFormat],
        ["超时", `${Math.round(endpoint.timeoutMs / 1000)} 秒`],
        [
          "近 24 小时",
          `调用 ${stats.calls} · 成功 ${stats.succeeded} · 失败 ${stats.failed} · 未知 ${stats.unknown} · 平均 ${stats.avgMs ?? "—"} ms · token ${number(stats.promptTokens)}/${number(stats.completionTokens)}`,
        ],
        [
          "最近状态",
          endpoint.health.lastError
            ? `${shortTime(endpoint.health.lastError.at)} 出错：${endpoint.health.lastError.code} ${endpoint.health.lastError.message}`
            : endpoint.health.lastOkAt
              ? `${shortTime(endpoint.health.lastOkAt)} 调用成功`
              : "本次启动后还没有调用",
        ],
      ]),
    );
    const level = choose(LEVELS, "off", "测试时的思考程度");
    const test = button("测试", () =>
      act(
        test,
        () =>
          send(
            `/v1/admin/ai/endpoints/${encodeURIComponent(endpoint.id)}/test`,
            "POST",
            { level: level.value },
            { timeoutMs: endpoint.timeoutMs + 10000 },
          ),
        (result) =>
          result.data.result.ok
            ? `测试通过：${result.data.result.model}，用时 ${result.data.result.ms} ms，token ${result.data.result.promptTokens ?? "—"}/${result.data.result.completionTokens ?? "—"}。`
            : `测试失败：${result.data.result.code} ${result.data.result.message}`,
      ),
    );
    const up = button("上移", (event) => move(index, -1, event.currentTarget));
    const down = button("下移", (event) => move(index, 1, event.currentTarget));
    up.disabled = index === 0;
    down.disabled = index === endpoints.length - 1;
    const path = `/v1/admin/ai/endpoints/${encodeURIComponent(endpoint.id)}`;
    body.append(
      toolbar(
        field("测试思考程度", level),
        test,
        up,
        down,
        button("修改", () => {
          state.ai.editing = endpoint.id;
          return loadPage();
        }),
        button(endpoint.enabled ? "停用" : "启用", (event) =>
          act(
            event.currentTarget,
            () => send(path, "PUT", { enabled: !endpoint.enabled }),
            endpoint.enabled ? "已停用，不再参与调用。" : "已启用。",
          ),
        ),
        confirmButton("删除", (trigger) => act(trigger, () => api(path, { method: "DELETE" }), "接口已删除。")),
      ),
    );
    card.append(head, body);
    list.append(card);
  });
  section.wrapper.append(list);
  content.append(section.wrapper);
  // 按使用场景设置思考程度。
  const thinking = panel(
    "思考程度",
    "按用途设置；思考越深越准，但更慢、更贵。接口的思考参数格式选“不传”时这里不起作用",
  );
  const selects = {};
  const grid = node("div", null, "form-grid");
  Object.entries(SCENARIOS).forEach(([key, [name, hint]]) => {
    selects[key] = choose(LEVELS, view.thinking[key], name);
    grid.append(field(name, selects[key], hint));
  });
  const saveThinking = button(
    "保存思考程度",
    () =>
      act(
        saveThinking,
        () =>
          send(
            "/v1/admin/ai/thinking",
            "PUT",
            Object.fromEntries(Object.entries(selects).map(([key, select]) => [key, select.value])),
          ),
        "思考程度已保存，下一次调用生效。",
      ),
    "button small primary",
  );
  const thinkingBody = node("div", null, "panel-body");
  thinkingBody.append(grid, toolbar(saveThinking));
  thinking.wrapper.append(thinkingBody);
  content.append(thinking.wrapper);

  // 按场景选择接口；留空时跟随全局接口顺序。
  const routes = view.routes && typeof view.routes === "object" ? view.routes : {};
  const routeOptions = { "": "跟随全局顺序" };
  endpoints.forEach((endpoint) => {
    routeOptions[endpoint.id] = endpoint.alias;
  });
  const routing = panel(
    "按场景选择接口",
    "留空沿用全局顺序；每个场景只显示当前列表的第一个接口。",
  );
  const routeGrid = node("div", null, "form-grid");
  Object.entries(SCENARIOS).forEach(([key, [name, hint]]) => {
    const current = Array.isArray(routes[key]) ? routes[key][0] || "" : "";
    const select = choose(routeOptions, current, name);
    select.addEventListener("change", (event) => {
      const value = event.currentTarget.value;
      act(
        event.currentTarget,
        () => send("/v1/admin/ai/routes", "PUT", { [key]: value ? [value] : [] }),
        "接口选择已保存，下一次调用生效。",
      );
    });
    routeGrid.append(field(name, select, hint));
  });
  const routingBody = node("div", null, "panel-body");
  routingBody.append(routeGrid);
  routing.wrapper.append(routingBody);
  content.append(routing.wrapper);
}

// ── 金额预算与价格 ──
function renderBudget(budget) {
  const section = panel(
    "费用额度（全体用户）",
    `按模型实际用量折算成钱扣；每天北京时间零点、每周一零点恢复。单个用户在用户管理里另设。每天另有 ${budget.safetyCap} 次的隐藏上限防止异常刷量。`,
  );
  const inputs = {};
  const grid = node("div", null, "form-grid");
  [["day", "每日（元）"], ["week", "每周（元）"]].forEach(([key, name]) => {
    inputs[key] = control("input", { type: "number", min: 0, max: 100000, value: budget.current[key], label: name });
    grid.append(field(name, inputs[key], `部署默认 ${budget.defaults[key]}`));
  });
  const save = button(
    "保存",
    () => {
      const body = {};
      for (const [key, input] of Object.entries(inputs)) {
        const text = String(input.value).trim();
        if (!/^\d+(\.\d{1,2})?$/.test(text))
          return notice("费用额度要填 0 或正数（最多两位小数）。", "error");
        body[key] = Number(text);
      }
      return act(save, () => send("/v1/admin/settings/budget", "PUT", body), "额度已保存，立即生效。");
    },
    "button small primary",
  );
  const reset = confirmButton(
    "恢复部署默认",
    (trigger) => act(trigger, () => send("/v1/admin/settings/budget", "PUT", budget.defaults), "已恢复部署默认额度。"),
    "button small",
  );
  const body = node("div", null, "panel-body");
  body.append(grid, toolbar(save, reset));
  section.wrapper.append(body);
  content.append(section.wrapper);
}
const PRICE_FIELDS = [
  ["host", "接口域名", "留空表示任何域名"],
  ["model", "模型", ""],
  ["input", "输入 ¥/百万", ""],
  ["output", "输出 ¥/百万", ""],
  ["cached", "缓存 ¥/百万", ""],
  ["note", "备注", ""],
];
function renderPrices(prices) {
  const section = panel(
    "模型价格",
    "每百万 token 的人民币价格，按“接口域名 + 模型”匹配，域名留空则任何域名都按这一行。没有价格的模型按表里最高价扣学生额度。",
  );
  const body = node("div", null, "panel-body");
  if (prices.unpriced.length)
    body.append(
      node(
        "p",
        `还没填价格（暂按最高价）：${prices.unpriced.map((row) => `${row.alias}（${row.host} · ${row.model}）`).join("、")}`,
        "notice error",
      ),
    );
  const rows = node("div", null, "price-rows");
  const addRow = (row = {}) => {
    const line = node("div", null, "form-grid price-row");
    line.inputs = {};
    PRICE_FIELDS.forEach(([key, name, hint]) => {
      const numeric = ["input", "output", "cached"].includes(key);
      line.inputs[key] = control("input", {
        type: numeric ? "number" : "text",
        min: numeric ? 0 : undefined,
        value: row[key] ?? "",
        placeholder: hint,
        label: name,
      });
      line.append(field(name, line.inputs[key]));
    });
    line.append(button("删除", () => line.remove(), "button small danger"));
    rows.append(line);
  };
  prices.rows.forEach(addRow);
  const save = button(
    "保存价格",
    () => {
      const list = [];
      for (const line of rows.children) {
        const value = (key) => String(line.inputs[key].value).trim();
        const row = { host: value("host"), model: value("model"), note: value("note") };
        if (!row.model) return notice("每一行都要填模型名。", "error");
        for (const key of ["input", "output", "cached"]) {
          if (!/^\d+(\.\d+)?$/.test(value(key)))
            return notice(`${row.model} 的价格要填 0 或正数。`, "error");
          row[key] = Number(value(key));
        }
        list.push(row);
      }
      return act(save, () => send("/v1/admin/settings/prices", "PUT", { rows: list }), "价格已保存，立即生效。");
    },
    "button small primary",
  );
  const reset = confirmButton(
    "恢复预置价格",
    (trigger) => act(trigger, () => send("/v1/admin/settings/prices", "PUT", { rows: prices.defaults }), "已恢复预置价格。"),
    "button small",
  );
  body.append(rows, toolbar(button("加一行", () => addRow()), save, reset));
  section.wrapper.append(body);
  content.append(section.wrapper);
}

// ── 全局次数额度 ──
function renderSettings(data) {
  if (data.budget) renderBudget(data.budget);
  if (data.prices) renderPrices(data.prices);
  const { current, defaults } = data.limits;
  const section = panel(
    data.budget ? "每日次数（旧版显示用）" : "每日额度（全体用户）",
    data.budget
      ? "已按费用额度扣；这里的次数只给旧版小程序换算“还剩几次”，不再拦"
      : "北京时间每天零点重置；单个用户的特殊额度在用户管理里设置，优先于这里",
  );
  const inputs = {};
  const grid = node("div", null, "form-grid");
  Object.entries(LIMIT_NAMES).forEach(([bucket, name]) => {
    inputs[bucket] = control("input", {
      type: "number",
      min: 0,
      max: 10000,
      value: current[bucket],
      label: name,
    });
    grid.append(field(name, inputs[bucket], `部署默认 ${defaults[bucket]}`));
  });
  const save = button(
    "保存",
    () => {
      const body = {};
      for (const [bucket, input] of Object.entries(inputs)) {
        const text = String(input.value).trim();
        if (!/^\d+$/.test(text))
          return notice(`${LIMIT_NAMES[bucket]}要填 0 或正整数。`, "error");
        body[bucket] = Number(text);
      }
      return act(save, () => send("/v1/admin/settings/limits", "PUT", body), "额度已保存，立即生效。");
    },
    "button small primary",
  );
  const reset = confirmButton(
    "恢复部署默认",
    (trigger) => act(trigger, () => send("/v1/admin/settings/limits", "PUT", defaults), "已恢复部署默认额度。"),
    "button small",
  );
  const body = node("div", null, "panel-body");
  body.append(
    grid,
    node(
      "p",
      "“讲解和出题”“AI 整理”“头脑风暴”“导入”按发起的任务计数；“对话”按回答次数，“图片识别”“拍题识别”按图片张数。已经用掉的次数不会因为调低额度而返还。",
      "field-hint",
    ),
    toolbar(save, reset),
  );
  section.wrapper.append(body);
  content.append(section.wrapper);
}

// ── 题库（只读） ──
function renderBank(data) {
  const chapter = choose(
    { "": "全部章节", ...Object.fromEntries(data.chapters.map((c) => [c.id, c.label])) },
    state.bank.chapter,
    "章节",
  );
  const search = control("input", {
    value: state.bank.q,
    placeholder: "知识点名称或编号",
    label: "搜索知识点",
  });
  const reported = choose(
    { all: "全部知识点", reported: "只看有反馈的" },
    state.bank.reported ? "reported" : "all",
    "反馈",
  );
  const apply = () => {
    state.bank = {
      chapter: chapter.value,
      q: String(search.value).trim(),
      reported: reported.value === "reported",
    };
    content.replaceChildren();
    renderBank(data);
  };
  chapter.addEventListener("change", apply);
  reported.addEventListener("change", apply);
  const form = node("form", null, "toolbar");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    apply();
  });
  form.append(
    field("章节", chapter),
    field("反馈", reported),
    field("搜索", search),
    button("搜索", apply, "button small primary"),
  );
  const q = state.bank.q.toLowerCase();
  const points = data.points.filter(
    (point) =>
      (!state.bank.chapter || point.chapterId === state.bank.chapter) &&
      (!state.bank.reported || point.reports.total > 0) &&
      (!q || point.name.toLowerCase().includes(q) || point.pointId.toLowerCase().includes(q)),
  );
  content.append(
    form,
    node(
      "p",
      `共 ${data.points.length} 个知识点、${data.problems} 道题；当前显示 ${points.length} 个。题目改动需要改代码（server/src/modules/learn/problems.ts）后重新部署。`,
      "scope-note compact",
    ),
  );
  if (!points.length) {
    content.append(emptyState("没有符合条件的知识点", "换个章节或关键词。"));
    return;
  }
  const list = node("div", null, "card-list");
  points.forEach((point) => {
    const item = node("details", null, "bank-point");
    const summary = node("summary");
    summary.append(
      node("strong", `${point.chapter} · ${point.name}`),
      node("span", `${point.section} · ${point.tier}`, "muted"),
    );
    if (point.reports.open) summary.append(badge("unknown", `待处理反馈 ${point.reports.open}`));
    else if (point.reports.total) summary.append(badge("", `反馈 ${point.reports.total}`));
    item.append(summary);
    const body = node("div", null, "panel-body compact");
    body.append(node("p", point.pointId, "mono muted"));
    point.problems.forEach((problem) => {
      body.append(
        node(
          "h3",
          `${problem.index === 0 ? "初始题" : "复习题"} · ${PROBLEM_KINDS[problem.kind] || problem.kind}`,
          "section-title",
        ),
        problemBlock(problem),
      );
    });
    if (!point.problems.length) body.append(node("p", "题目准备中。", "muted"));
    if (point.reports.total)
      body.append(
        button("查看这个知识点的反馈", () => {
          state.feedback = { status: "all", type: "map", point: point.pointId };
          return navigate("feedback");
        }),
      );
    item.append(body);
    list.append(item);
  });
  content.append(list);
}
