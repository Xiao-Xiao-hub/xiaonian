"use strict";
// the allowance is a share of a daily and a weekly budget; learners
// see used percentages and when each comes back, never yuan or counts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const budgets = require("../miniprogram/utils/budget.js");
const { BANNED_PHRASES } = (() => {
  const text = fs.readFileSync(path.resolve(__dirname, "../server/src/modules/safety/banned-phrases.ts"), "utf8");
  return { BANNED_PHRASES: [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]) };
})();

test("budget lines: percentages, the reset, and a notice only from 80%", () => {
  const now = Date.parse("2026-10-14T02:00:00.000Z");
  const day = "2026-10-14T16:00:00.000Z";
  const week = "2026-10-18T16:00:00.000Z";
  const at = (d, w) => ({ day: { pct: d, resetAt: day }, week: { pct: w, resetAt: week } });
  assert.equal(budgets.valid(null), false);
  assert.equal(budgets.valid({ day: { pct: 1 } }), false);
  assert.equal(budgets.line(at(35, 12)), "今天已用 35% · 本周已用 12%");
  assert.equal(budgets.reset(day, now), "明天 0 点恢复");
  assert.equal(budgets.reset(week, now), "下周一 0 点恢复");
  // Sunday: the week ends tonight.
  assert.equal(budgets.reset(week, Date.parse("2026-10-18T04:00:00.000Z")), "明天 0 点恢复");
  assert.equal(budgets.low(at(79, 79), now), "");
  assert.equal(budgets.low(at(80, 10), now), "今天已用 80%，明天 0 点恢复");
  assert.equal(budgets.low(at(90, 85), now), "本周已用 85%，下周一 0 点恢复");
  assert.equal(budgets.low(at(100, 50), now), "今天的额度用完了，明天 0 点恢复");
  assert.equal(budgets.low(at(100, 100), now), "这周的额度用完了，下周一 0 点恢复");
  assert.equal(budgets.low(undefined, now), "");
});

test("count wording that budgets made wrong is gone from the pages", () => {
  const help = read("pages/help/index.js");
  assert.doesNotMatch(help, /次数|算一次|每天能用几次|今天还能用/);
  const knowledge = fs.readFileSync(path.resolve(__dirname, "../server/src/modules/support/knowledge.ts"), "utf8");
  assert.match(help, /\/v1\/support\/knowledge/);
  assert.match(read("pages/help/index.wxml"), /item\.answer/);
  assert.match(knowledge, /额度怎么算/);
  assert.match(knowledge, /没成功的不扣额度/);
  assert.match(read("pages/teach/index.wxml"), /这次没对上要点，不扣额度。/);
  assert.doesNotMatch(read("pages/teach/index.wxml"), /不算次数/);
  assert.match(read("components/resume-card/index.wxml"), /额度用完了，恢复后再理一遍/);
  const source = read("pages/import/source/index.js");
  assert.match(source, /会用掉一些额度/);
  assert.doesNotMatch(source, /今天的次数|认图的次数/);
  // The ask and note pages read the budget line when the server sends one.
  assert.match(read("pages/ask/index.js"), /budgets\.low\(usage\.budget\)/);
  assert.match(read("pages/note/index.js"), /budgets\.low\(usage\.budget\)/);
  for (const name of ["utils/budget.js", "pages/help/index.js", "pages/profile/index.wxml"]) {
    const text = read(name);
    assert.doesNotMatch(text, /¥|人民币|[0-9] ?元/, `${name}: no yuan for learners`);
    for (const phrase of BANNED_PHRASES) assert.ok(!text.includes(phrase), `${name}: ${phrase}`);
  }
});
