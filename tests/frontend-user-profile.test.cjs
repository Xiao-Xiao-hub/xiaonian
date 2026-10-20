"use strict";
// 微信原生事件与网络均为合成输入；验证资料编辑顺序，不代表真机授权验收。
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram");
const mod = (file) => require(path.join(root, file));
let storage, app, requests, uploads, moves, pages;
const user = (id = "A", nickname = "微信用户", avatar = null) => ({ id, nickname, avatar });
function signIn(value = user(), token = "synthetic-session") {
  mod("utils/session.js").setSession({
    token, user: value, expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
}
function openPage(file = "pages/profile/index.js") {
  let page;
  global.Page = (value) => { page = value; };
  delete require.cache[require.resolve(path.join(root, file))];
  mod(file);
  page.data = structuredClone(page.data);
  page.setData = function (patch) { Object.assign(this.data, patch); };
  page.alive = true;
  page.owner = (mod("utils/auth.js").getUser() || {}).id;
  page.loadVersion = 0;
  pages.push(page);
  return page;
}
function event(page, detail) {
  return { detail, currentTarget: { dataset: { edit: page.editId, input: page.data.nicknameInputId } } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  for (const key of Object.keys(require.cache)) if (key.startsWith(root + path.sep)) delete require.cache[key];
  storage = new Map(); app = { globalData: {} }; requests = []; uploads = []; moves = []; pages = [];
  global.getApp = () => app;
  global.wx = {
    getStorageSync: (key) => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    getAppBaseInfo: () => ({ SDKVersion: "3.8.6" }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    canIUse: () => true,
    getPrivacySetting: (options) => options.success({ needAuthorization: false }),
    requirePrivacyAuthorize: (options) => options.success(),
    showToast() {},
    showModal: (options) => options.success({ confirm: true }),
    reLaunch: ({ url }) => moves.push(url),
    switchTab: ({ url }) => moves.push(url),
    request: (options) => {
      requests.push(options);
      const nickname = options.method !== "DELETE" && options.data && options.data.nickname;
      options.success({ statusCode: 200, data: { data: user("A", nickname || "微信用户") } });
    },
    uploadFile: (options) => {
      uploads.push(options);
      options.success({ statusCode: 200, data: JSON.stringify({ data: user("A", options.formData && options.formData.nickname || "微信用户", { version: "avatar-new" }) }) });
    },
    downloadFile: (options) => options.success({ statusCode: 200, tempFilePath: "/synthetic/avatar.png" }),
  };
  signIn();
  mod("utils/auth.js").recordConsent();
});
afterEach(() => {
  for (const page of pages) if (page.discardProfile) page.discardProfile();
});

test("profile inputs wait for native privacy authorization; refusal stays optional", async () => {
  let authorize;
  wx.getPrivacySetting = (options) => options.success({ needAuthorization: true });
  wx.requirePrivacyAuthorize = (options) => { authorize = options; };
  const page = openPage();
  const opening = page.editProfile();
  assert.equal(page.data.profileReady, false);
  assert.equal(page.data.profileAuthorizing, true);
  authorize.fail();
  await opening;
  assert.equal(page.data.profileReady, false);
  assert.equal(page.data.profileAuthorizing, false);
  assert.match(page.data.profileError, /跳过/);
  assert.equal(requests.length + uploads.length, 0);
  page.cancelProfile();
  assert.equal(page.data.editingProfile, false);
});

test("old platform retains default profile and offers an upgrade without requesting user info", async () => {
  wx.getAppBaseInfo = () => ({ SDKVersion: "2.29.1" });
  wx.getUserInfo = wx.getUserProfile = () => assert.fail("legacy user info must not run");
  const page = openPage();
  await page.editProfile(true);
  assert.equal(page.data.profileUnsupported, true);
  assert.equal(page.data.profileReady, false);
  page.cancelProfile();
  assert.equal(mod("utils/profile.js").prompted("A"), true);
  assert.equal(requests.length + uploads.length, 0);
});

test("avatar selection is only a draft; cancellation preserves the saved account", async () => {
  const page = openPage();
  await page.editProfile();
  page.chooseAvatar(event(page, { avatarUrl: "/synthetic/picked.jpg" }));
  page.chooseAvatar(event(page, {}));
  assert.equal(page.data.draftAvatar, "/synthetic/picked.jpg");
  assert.equal(uploads.length, 0);
  page.cancelProfile();
  assert.equal(page.data.draftAvatar, "");
  assert.equal(mod("utils/auth.js").getUser().avatar, null);
});

test("submit waits for nickname review and commits avatar plus nickname together", async () => {
  const page = openPage();
  await page.editProfile();
  page.chooseAvatar(event(page, { avatarUrl: "/synthetic/picked.jpg" }));
  page.nicknameInput(event(page, { value: "晓晓" }));
  page.saveProfile({ detail: { value: { nickname: "晓晓" } } });
  assert.equal(page.data.profileWaiting, true);
  assert.equal(uploads.length, 0);
  page.nicknameBlur(event(page, { value: "晓晓" }));
  page.nicknameReview(event(page, { pass: true, timeout: false }));
  await settle();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].filePath, "/synthetic/picked.jpg");
  assert.deepEqual(uploads[0].formData, { nickname: "晓晓" });
  assert.equal(mod("utils/auth.js").getUser().nickname, "晓晓");
  assert.equal(page.data.name, "晓晓");
  assert.equal(page.data.editingProfile, false);
  assert.equal(mod("utils/profile.js").prompted("A"), true);
});

test("review can finish before blur and form submit without losing the accepted value", async () => {
  const page = openPage();
  await page.editProfile();
  page.nicknameInput(event(page, { value: "小河" }));
  page.nicknameReview(event(page, { pass: true }));
  page.nicknameBlur(event(page, { value: "小河" }));
  page.saveProfile({ detail: { value: { nickname: "小河" } } });
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PATCH");
  assert.equal(page.data.name, "小河");
});

for (const review of [{ pass: false }, { pass: true, timeout: true }]) {
  test(`nickname rejection or timeout cannot save (${JSON.stringify(review)})`, async () => {
    const page = openPage();
    await page.editProfile();
    page.nicknameInput(event(page, { value: "待检查" }));
    page.nicknameBlur(event(page, { value: "待检查" }));
    const oldEvent = event(page, { pass: true });
    page.saveProfile({ detail: { value: { nickname: "待检查" } } });
    page.nicknameReview(event(page, review));
    page.nicknameReview(oldEvent);
    await settle();
    assert.equal(requests.length + uploads.length, 0);
    assert.equal(page.data.draftNickname, "");
    assert.equal(page.data.profileWaiting, false);
    assert.match(page.data.profileError, /检查/);
  });
}

test("form's sanitized value must match the reviewed draft", async () => {
  const page = openPage();
  await page.editProfile();
  page.nicknameInput(event(page, { value: "候选名" }));
  page.nicknameReview(event(page, { pass: true }));
  page.saveProfile({ detail: { value: { nickname: "" } } });
  await settle();
  assert.equal(requests.length, 0);
  assert.match(page.data.profileError, /确认内容/);
});

test("a failed upload keeps the draft and the previous confirmed profile", async () => {
  wx.uploadFile = (options) => options.fail();
  const page = openPage();
  await page.editProfile();
  page.chooseAvatar(event(page, { avatarUrl: "/synthetic/picked.jpg" }));
  page.saveProfile({ detail: { value: { nickname: "" } } });
  await settle();
  assert.equal(page.data.profileSaving, false);
  assert.equal(page.data.editingProfile, true);
  assert.equal(page.data.draftAvatar, "/synthetic/picked.jpg");
  assert.equal(mod("utils/auth.js").getUser().avatar, null);
});

test("an old avatar callback and save response cannot cross accounts or restore an old session", async () => {
  let upload;
  wx.uploadFile = (options) => { upload = options; };
  const page = openPage();
  await page.editProfile();
  const oldPicker = event(page, { avatarUrl: "/synthetic/late.jpg" });
  page.chooseAvatar(event(page, { avatarUrl: "/synthetic/first.jpg" }));
  page.saveProfile({ detail: { value: { nickname: "" } } });
  await settle();
  signIn(user("B", "另一个账号"), "new-synthetic-session");
  page.discardProfile();
  await page.editProfile();
  page.chooseAvatar(oldPicker);
  upload.success({ statusCode: 200, data: JSON.stringify({ data: user("A", "旧账号", { version: "old" }) }) });
  await settle();
  assert.equal(mod("utils/auth.js").getUser().id, "B");
  assert.equal(mod("utils/session.js").getSession().token, "new-synthetic-session");
  assert.equal(page.data.draftAvatar, "");
  assert.notEqual(page.data.name, "旧账号");
});

test("privacy revocation invalidates an unfinished profile save", async () => {
  let request;
  wx.request = (options) => { request = options; };
  const page = openPage();
  await page.editProfile();
  page.nicknameInput(event(page, { value: "新昵称" }));
  page.nicknameReview(event(page, { pass: true }));
  page.saveProfile({ detail: { value: { nickname: "新昵称" } } });
  await settle();
  mod("utils/auth.js").clearConsent();
  request.success({ statusCode: 200, data: { data: user("A", "新昵称") } });
  await settle();
  assert.equal(mod("utils/auth.js").getUser().nickname, "微信用户");
  assert.notEqual(page.data.name, "新昵称");
});

test("first-time profile prompt can be skipped once per account", async () => {
  const page = openPage();
  page.profileSetupReturn = "/pages/onboard/index";
  await page.editProfile(true);
  page.cancelProfile();
  assert.equal(mod("utils/profile.js").prompted("A"), true);
  assert.deepEqual(moves, ["/pages/onboard/index"]);
  assert.equal(requests.length + uploads.length, 0);
  signIn(user("B"));
  assert.equal(mod("utils/profile.js").prompted("B"), false);
  mod("utils/profile.js").clearPrompt("A");
  assert.equal(mod("utils/profile.js").prompted("A"), false);
});

test("native picker hide/show preserves the same account's draft", async () => {
  const page = openPage();
  await page.editProfile();
  page.nicknameInput(event(page, { value: "还在编辑" }));
  const pickerEvent = event(page, { avatarUrl: "/synthetic/selected.jpg" });
  page.load = async () => {};
  page.onHide();
  await page.onShow();
  page.chooseAvatar(pickerEvent);
  assert.equal(page.data.editingProfile, true);
  assert.equal(page.data.draftNickname, "还在编辑");
  assert.equal(page.data.draftAvatar, "/synthetic/selected.jpg");
});

test("save finishes while hidden, releases busy and applies only on returning to the same account", async () => {
  let request;
  wx.request = (options) => { request = options; };
  const page = openPage();
  await page.editProfile();
  page.nicknameInput(event(page, { value: "保存中的名字" }));
  page.nicknameReview(event(page, { pass: true }));
  page.saveProfile({ detail: { value: { nickname: "保存中的名字" } } });
  await settle();
  page.onHide();
  request.success({ statusCode: 200, data: { data: user("A", "保存中的名字") } });
  await settle();
  assert.equal(page.data.profileSaving, false);
  assert.notEqual(page.data.name, "保存中的名字", "hidden response does not repaint personal content");
  page.load = async () => {};
  await page.onShow();
  assert.equal(page.data.name, "保存中的名字");
  assert.equal(page.data.editingProfile, false);
  await page.editProfile();
  assert.equal(page.data.profileReady, true);
});

test("nickname timeout while hidden releases waiting and lets the user retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = openPage();
  await page.editProfile();
  page.nicknameInput(event(page, { value: "等待审核" }));
  page.saveProfile({ detail: { value: { nickname: "等待审核" } } });
  const oldReview = event(page, { pass: true });
  page.onHide();
  t.mock.timers.tick(10001);
  assert.equal(page.data.nicknamePending, false);
  assert.equal(page.data.profileWaiting, false);
  page.load = async () => {};
  await page.onShow();
  page.nicknameReview(oldReview);
  assert.equal(requests.length, 0);
  page.nicknameInput(event(page, { value: "重新填写" }));
  assert.equal(page.data.draftNickname, "重新填写");
  page.cancelProfile();
  assert.equal(page.data.editingProfile, false);
});

test("an older profile read cannot overwrite a completed edit", async () => {
  const api = mod("utils/api.js");
  let oldRead;
  api.get = (url) => url === "/v1/auth/me"
    ? new Promise((resolve) => { oldRead = resolve; })
    : Promise.resolve({});
  const page = openPage();
  const loading = page.load();
  await settle();
  await page.editProfile();
  page.nicknameInput(event(page, { value: "刚刚保存" }));
  page.nicknameReview(event(page, { pass: true }));
  page.saveProfile({ detail: { value: { nickname: "刚刚保存" } } });
  await settle();
  oldRead(user("A", "过去的名字"));
  await loading;
  assert.equal(mod("utils/auth.js").getUser().nickname, "刚刚保存");
  assert.equal(page.data.name, "刚刚保存");
});

test("profile refresh merges into the current session without replacing renewed credentials", () => {
  const sessions = mod("utils/session.js");
  signIn(user("A"), "renewed-synthetic-session");
  assert.equal(sessions.updateUser(user("A", "新资料")), true);
  assert.equal(sessions.getSession().token, "renewed-synthetic-session");
  assert.equal(sessions.updateUser(user("B", "不属于当前账号")), false);
  assert.equal(sessions.getSession().user.nickname, "新资料");
});

test("restoring the default profile removes only profile fields and keeps the account", async () => {
  signIn(user("A", "已有名字", { version: "saved-avatar" }));
  const page = openPage();
  await page.editProfile();
  page.resetProfile();
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "DELETE");
  assert.deepEqual(requests[0].data, { avatar: true, nickname: true });
  assert.equal(mod("utils/auth.js").getUser().id, "A");
  assert.equal(mod("utils/auth.js").getUser().nickname, "微信用户");
  assert.equal(page.data.avatarPath, "");
  assert.equal(page.data.name, "");
});

test("cancelled or failed restore preserves the saved profile and editable draft", async () => {
  signIn(user("A", "已有名字", { version: "saved-avatar" }));
  const page = openPage();
  await page.editProfile();
  page.chooseAvatar(event(page, { avatarUrl: "/synthetic/draft.jpg" }));
  wx.showModal = (options) => options.success({ confirm: false });
  page.resetProfile();
  assert.equal(requests.length, 0);
  assert.equal(page.data.draftAvatar, "/synthetic/draft.jpg");
  wx.showModal = (options) => options.success({ confirm: true });
  wx.request = (options) => options.fail();
  page.resetProfile();
  await settle();
  assert.equal(mod("utils/auth.js").getUser().nickname, "已有名字");
  assert.equal(page.data.profileSaving, false);
  assert.equal(page.data.draftAvatar, "/synthetic/draft.jpg");
});

test("restore confirmation belongs to the account that opened it", async () => {
  signIn(user("A", "已有名字"));
  let modal;
  wx.showModal = (options) => { modal = options; };
  const page = openPage();
  await page.editProfile();
  page.resetProfile();
  signIn(user("B", "另一个账号"), "another-synthetic-session");
  modal.success({ confirm: true });
  await settle();
  assert.equal(requests.length, 0);
  assert.equal(mod("utils/auth.js").getUser().nickname, "另一个账号");
});

test("welcome suggests optional profile for adult and child, but skips a saved or declined profile", async () => {
  const auth = mod("utils/auth.js");
  auth.saveConsent = async () => {};
  for (const age of ["adult", "child"]) {
    const welcome = openPage("pages/welcome/index.js");
    welcome.pick({ currentTarget: { dataset: { age } } });
    await settle();
    assert.equal(moves.at(-1), "/pages/profile/index");
    assert.equal(app.globalData.profileSetup.owner, "A");
    assert.equal(app.globalData.profileSetup.next, "/pages/onboard/index");
  }
  mod("utils/profile.js").markPrompted("A");
  const returning = openPage("pages/welcome/index.js");
  returning.pick({ currentTarget: { dataset: { age: "adult" } } });
  await settle();
  assert.equal(moves.at(-1), "/pages/onboard/index");
  mod("utils/profile.js").clearPrompt("A");
  signIn(user("A", "已设置"));
  const named = openPage("pages/welcome/index.js");
  named.pick({ currentTarget: { dataset: { age: "adult" } } });
  await settle();
  assert.equal(moves.at(-1), "/pages/onboard/index");
});

test("a profile refreshed from the server is not prompted again from an older local session", async () => {
  const page = openPage();
  app.globalData.profileSetup = { owner: "A", next: "/pages/onboard/index" };
  page.load = async () => { signIn(user("A", "其他设备已设置")); };
  await page.onShow();
  assert.equal(page.data.editingProfile, false);
  assert.equal(mod("utils/profile.js").prompted("A"), true);
  assert.deepEqual(moves, ["/pages/onboard/index"]);
  assert.equal(app.globalData.profileSetup, undefined);
});
