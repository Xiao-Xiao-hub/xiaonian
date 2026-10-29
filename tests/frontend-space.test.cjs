"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const spacePath = require.resolve("../miniprogram/utils/learning-space");
let storage, space;
const map = () => ({
  chapters: [
    { id: "limit", short: "极限", started: true, rank: "基础段", points: [{ id: "a", name: "极限 A", ready: true }] },
    { id: "derivative", short: "导数", started: false, rank: "起步", points: [{ id: "b", name: "导数 B", ready: true }, { id: "draft", name: "未开放", ready: false }] },
    { id: "ode", short: "微分方程", started: true, rank: "重点段", hidden: true, points: [{ id: "hidden", name: "隐藏点", ready: true }] },
  ],
  summary: { todayList: [{ id: "a", done: true, kind: "new" }, { id: "b", done: false, kind: "review" }] },
});
beforeEach(() => {
  storage = new Map();
  global.wx = {
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
  };
  delete require.cache[spacePath];
  space = require(spacePath);
});

test("continuation persists across a cold module load, stores only the pointer, and isolates accounts", () => {
  space.remember("alice", "a", 100);
  assert.deepEqual([...storage.values()], [{ pointId: "a", openedAt: 100 }]);
  delete require.cache[spacePath];
  space = require(spacePath);
  assert.equal(space.continuation(map(), "alice").id, "a");
  assert.equal(space.continuation(map(), "bob").id, "b");
  space.remember("bob", "b", 101);
  space.clear("alice");
  assert.equal(storage.has("zhiye_last_point:alice"), false);
  assert.equal(storage.has("zhiye_last_point:bob"), true);
});

test("clearing an account also removes the unsent text other pages keep on this phone", () => {
  global.wx.getStorageInfoSync = () => ({ keys: [...storage.keys()] });
  const kept = ["zhiye_notes_draft:n1", "zhiye_chat_draft", "zhiye_bs_draft:b1", "zhiye_import_text:alice", "mistake-redo:m1",
    "zhiye_material_ask:x:alice", "practice-draft:p1", "practice-last:p1", "stuck_thread:pt1", "tool_draft:teach:one"];
  for (const key of kept) storage.set(key, { text: "我自己写的话" });
  storage.set("zhiye_session", { token: "t" });
  storage.set("zhiye_theme", "dark");
  space.clear("alice");
  assert.deepEqual(kept.filter((key) => storage.has(key)), []);
  assert.equal(storage.has("zhiye_session"), true, "the session is cleared by its own owner");
  assert.equal(storage.has("zhiye_theme"), true);
});

test("deleted, hidden and unopened pointers fall back to an unfinished visible task", () => {
  for (const id of ["missing", "hidden", "draft"]) {
    space.remember("alice", id, 100);
    assert.equal(space.continuation(map(), "alice").id, "b", id);
    assert.equal(space.continuation(map(), "alice").label, "温故一小步");
  }
  const data = map();
  data.chapters[0].hidden = true;
  space.remember("alice", "a", 100);
  assert.equal(space.continuation(data, "alice").id, "b");
});

test("without a usable task the map remains reachable without inventing a point", () => {
  const data = map();
  data.summary.todayList = [{ id: "a", done: true }, { id: "hidden", done: false }, { id: "draft", done: false }];
  assert.equal(space.continuation(data, "alice").id, null);
  assert.equal(space.continuation(data, "alice").name, "看看学习地图");
});

test("invalid cache and unavailable storage do not block learning", () => {
  storage.set("zhiye_last_point:alice", { pointId: "a", openedAt: "bad" });
  assert.equal(space.continuation(map(), "alice").id, "b");
  space.remember("", "a", 100);
  space.remember("bob", "a", NaN);
  assert.equal(storage.size, 1);
  global.wx = new Proxy({}, { get: () => () => { throw new Error("storage full"); } });
  assert.doesNotThrow(() => space.remember("alice", "a"));
  assert.doesNotThrow(() => space.clear("alice"));
  assert.equal(space.continuation(map(), "alice").id, "b");
});

test("chapter stickers describe server progress and retain hidden chapter status", () => {
  assert.deepEqual(space.stickers(map()), [
    { id: "limit", name: "极限", rank: "基础段", earned: true, hidden: false },
    { id: "derivative", name: "导数", rank: "还没开始", earned: false, hidden: false },
    { id: "ode", name: "微分方程", rank: "重点段", earned: true, hidden: true },
  ]);
});
