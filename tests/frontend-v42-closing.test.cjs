"use strict";
// V4.2 closing fixes from the full screenshot pass.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("ranks: the footer does not deny the streak the record card shows", () => {
  const wxml = read("pages/ranks/index.wxml");
  assert.match(wxml, /当前连续/);
  assert.doesNotMatch(wxml, /不记连续天数/);
  assert.match(wxml, /经验不看连续天数/);
});

test("capture: the drafts come from the main package, as the import pages' do", () => {
  assert.match(read("pages/capture/index.js"), /require\("\.\.\/\.\.\/utils\/drafts"\)/);
  assert.match(read("pages/import/view.js"), /require\("\.\.\/\.\.\/utils\/drafts"\)/);
  // Same storage keys as before the move, so drafts already kept still open.
  const { draftKey } = require(path.join(root, "utils/drafts.js"));
  assert.equal(draftKey("source", "u1"), "zhiye_import_source:u1");
});
