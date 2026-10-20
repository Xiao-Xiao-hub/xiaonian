"use strict";
// V4.1 G1 · 键盘: the bottom input of 聊一聊 (pages/chat) and 解题 (pages/ask)
// rises above the keyboard itself instead of the page being pushed up.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const keyboard = require(path.join(root, "utils/keyboard.js"));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function fake() {
  return {
    data: { kb: 0 },
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
}

test("the height goes into kb; rising scrolls to the newest message, going down resets", () => {
  const page = fake();
  let scrolled = 0;
  const rise = () => (scrolled += 1);
  assert.equal(keyboard.change(page, { detail: { height: 301.6 } }, rise), 302);
  assert.equal(page.data.kb, 302);
  assert.equal(scrolled, 1);
  // The same height again (some phones repeat it): nothing.
  keyboard.change(page, { detail: { height: 302 } }, rise);
  assert.equal(scrolled, 1);
  // Taller (e.g. the emoji panel): scroll again; shorter: no scroll.
  keyboard.change(page, { detail: { height: 340 } }, rise);
  keyboard.change(page, { detail: { height: 320 } }, rise);
  assert.equal(scrolled, 2);
  keyboard.change(page, { detail: { height: 0 } }, rise);
  assert.equal(page.data.kb, 0);
  keyboard.change(page, { detail: {} }, rise);
  assert.equal(page.data.kb, 0);
  // Blur without a last 0.
  keyboard.change(page, { detail: { height: 280 } });
  keyboard.reset(page);
  assert.equal(page.data.kb, 0);
});

for (const [name, room] of [
  ["chat", "220rpx"],
  ["ask", "340rpx"],
]) {
  test(`pages/${name}: no page push, the composer rides on kb and the page keeps the room`, () => {
    const wxml = read(`pages/${name}/index.wxml`).replace(/\s+/g, " ");
    assert.ok(wxml.includes(`<view class="page${name === "chat" ? " chat-page" : ""}" style="padding-bottom:calc(${room} + {{kb}}px)"`));
    assert.match(wxml, /class="composer( \{\{kb \? 'kb-up' : ''\}\})?" style="bottom:\{\{kb\}\}px"/);
    const composer = wxml.slice(wxml.indexOf('class="composer'));
    const area = composer.slice(composer.indexOf("<textarea"), composer.indexOf("/>", composer.indexOf("<textarea")));
    assert.match(area, / fixed /);
    assert.match(area, /adjust-position="\{\{false\}\}"/);
    assert.match(area, /bindkeyboardheightchange="keyboardHeight"/);
    // V4.2 : the chat page's code is utils/chat-room.js, shared with the tab.
    const js = name === "chat" ? read("utils/chat-room.js") : read(`pages/${name}/index.js`);
    assert.match(js, name === "chat" ? /require\("\.\/keyboard"\)/ : /require\("\.\.\/\.\.\/utils\/keyboard"\)/);
    assert.match(js, /keyboard\.change\(this, ?e(vent)?, ?\(\) ?=> ?this\.toLatest\(\)(, this\.gap)?\)/);
    assert.match(js, /keyboard\.reset\(this\)/);
    assert.match(js, /kb: ?0/);
    if (name === "chat") {
      // No home-bar padding while the input sits on the keyboard.
      assert.match(wxml, /class="composer \{\{kb \? 'kb-up' : ''\}\}"/);
      assert.match(read("pages/chat/index.wxss"), /\.composer\.kb-up \{\s*padding-bottom: 18rpx;/);
    }
  });
}
