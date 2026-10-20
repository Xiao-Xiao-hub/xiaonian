const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const read = (p) => readFileSync(join(__dirname, "../miniprogram", p), "utf8");

test("first visit: hello card until the first card; 试试这样写 stays; search and tabs live on 卡片 (D112)", () => {
  const wxml = read("pages/notes/index.wxml");
  // not before the card count is in, and not while something is due.
  assert.match(wxml, /wx:if="\{\{cardsLoaded && !allTotal && !helloClosed && [^"]*\}\}" class="sticky hi"/);
  assert.match(wxml, /<view class="sec-head"><text class="h">试试这样写/);
  assert.doesNotMatch(wxml, /class="search"|tabs-row/);
  const deck = read("pages/deck/index.wxml");
  assert.match(deck, /<view wx:if="\{\{ready && !guest\}\}" class="search-box"><view class="ico ico-search"\/><input class="search"/);
  assert.match(deck, /<scroll-view class="tabs-row"/);
});

test("saving a card from chat leaves the type to the server unless picked", () => {
  const js = read("pages/collect/index.js");
  // the picked kind goes as kind.
  assert.match(js, /const kind = this\.data\.type \|\| undefined;/);
  assert.doesNotMatch(js, /scene === "study"\s*\?\s*"question"/);
});
