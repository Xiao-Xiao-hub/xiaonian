// Drives the mini program page code against the real API (fake AI services),
// so page logic and response shapes are checked together without devtools.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeServices, makeApp, NOTE, PROBLEM, type App } from "./fixtures.js";
import { seedSample } from "./learn-sample.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { addDays, chinaDate } from "../server/src/shared/time.js";
import { CALC_MAP } from "../server/src/modules/learn/calc-map.js";
import { BANK, PROBLEMS } from "../server/src/modules/learn/problems.js";
import {
  levelOf,
  LEVEL_DIVISOR,
  need,
  REVIEW_INTERVALS,
  TIER_XP,
  TODAY_REVIEWS,
} from "../server/src/modules/learn/summary.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL("../miniprogram/", import.meta.url));
const realSetTimeout = globalThis.setTimeout;
// Job polling waits 1.5 s between checks; only that delay is shortened.
globalThis.setTimeout = ((fn: () => void, ms?: number) =>
  realSetTimeout(fn, ms === 1500 ? 5 : ms)) as typeof setTimeout;

type Nav = { kind: string; url?: string };
function mountWx(app: App) {
  // 随心记 opens the tour once for anyone agreed who has not seen it;
  // these journeys are about the pages after it, so the tour counts as seen.
  const storage = new Map<string, unknown>([["zhiye_onboarded", "1"]]);
  const nav: Nav[] = [];
  const shared: { fileName: string; body: string }[] = [];
  const g = globalThis as any;
  g.wx = {
    getStorageSync: (key: string) => structuredClone(storage.get(key) ?? ""),
    setStorageSync: (key: string, value: unknown) =>
      storage.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => storage.delete(key),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getPrivacySetting: (o: any) => o.success({ needAuthorization: false }),
    request(o: any) {
      app
        .inject({
          method: o.method,
          url: o.url.replace(/^https?:\/\/[^/]+/, ""),
          headers: o.header,
          payload: o.method === "GET" ? undefined : JSON.stringify(o.data),
        })
        .then((res) =>
          o.success({
            statusCode: res.statusCode,
            data: res.body ? res.json() : "",
            header: res.headers,
          }),
        )
        .catch((error) => o.fail({ errMsg: String(error) }));
    },
    downloadFile(o: any) {
      app
        .inject({
          method: "GET",
          url: o.url.replace(/^https?:\/\/[^/]+/, ""),
          headers: o.header,
        })
        .then((res) => {
          const dir = mkdtempSync(join(tmpdir(), "zhiye-download-"));
          const tempFilePath = join(dir, "file");
          writeFileSync(tempFilePath, res.rawPayload);
          o.success({ statusCode: res.statusCode, tempFilePath });
        })
        .catch(() => o.fail({ errMsg: "downloadFile:fail" }));
    },
    shareFileMessage(o: any) {
      shared.push({
        fileName: o.fileName,
        body: readFileSync(o.filePath, "utf8"),
      });
      o.success();
    },
    setNavigationBarTitle() {},
    showToast() {},
    showModal: (o: any) => {
      o.success?.({ confirm: true });
      o.complete?.();
    },
    showActionSheet: (o: any) => o.success && o.success({ tapIndex: 0 }),
    navigateTo: (o: any) => nav.push({ kind: "navigateTo", url: o.url }),
    redirectTo: (o: any) => nav.push({ kind: "redirectTo", url: o.url }),
    navigateBack: () => nav.push({ kind: "navigateBack" }),
    switchTab: (o: any) => nav.push({ kind: "switchTab", url: o.url }),
    reLaunch: (o: any) => nav.push({ kind: "reLaunch", url: o.url }),
    stopPullDownRefresh() {},
    setNavigationBarColor() {},
    setBackgroundColor() {},
    setTabBarStyle() {},
    setTabBarItem() {},
    pageScrollTo() {},
  };
  g.getCurrentPages = () => [];
  const appState = { globalData: {} as Record<string, unknown> };
  g.getApp = () => appState;
  return { nav, shared, appState, storage };
}
// Loads a page definition and runs onLoad/onShow like the framework would.
function open(name: string, query: Record<string, string> = {}) {
  let definition: any;
  (globalThis as any).Page = (value: any) => {
    definition = value;
  };
  const file = require.resolve(`${ROOT}pages/${name}/index.js`);
  delete require.cache[file];
  require(file);
  const page: any = { ...definition, data: structuredClone(definition.data) };
  page.route = `pages/${name}/index`;
  // Supports the "a.b" paths the pages use.
  page.setData = (patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split(".");
      let target = page.data;
      for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      target[parts.at(-1)!] = value;
    }
  };
  page.onLoad?.(query);
  page.onShow?.();
  return page;
}
// v4 moved agreement to the welcome page; the old home card did this.
function agree(home: any) {
  require(`${ROOT}utils/auth.js`).recordConsent();
  home.setData({ consent: true });
  return home.load();
}
async function until<T>(read: () => T, label: string): Promise<NonNullable<T>> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value as NonNullable<T>;
    if (Date.now() - started > 5000) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
}
const input = (value: string) => ({ detail: { value } });
function scalarAnswer(id: string, index = 0) {
  const problem = PROBLEMS[id]![index]!;
  assert.ok(
    problem.kind !== "multi" && problem.kind !== "choice",
    "scalar fixture",
  );
  return problem.answer;
}
const tap = (dataset: Record<string, unknown>) => ({
  currentTarget: { dataset },
});
// V4.1 G4 : numbers go in on the number pad (components/numpad), which
// hands the page every blank's value at once.
const typeIn = (page: any, ...values: string[]) =>
  page.onPad({ detail: { values, active: 0 } });
// 0.6.0 : the right answer as the point page takes it: the right option
// of each question of a bank choice problem, else the numbers on the pad.
function answerRight(page: any, id: string, index = 0) {
  const problem = BANK[id]![index]!;
  if (problem.kind === "choice")
    problem.questions.forEach((q, question) =>
      page.chooseOption(tap({ question, id: q.answer })),
    );
  else if (problem.kind === "multi")
    typeIn(page, ...problem.parts.map((part) => part.answer));
  else typeIn(page, problem.answer);
}
// Capture typed text, then confirm it on the proofread page; returns the material id.
async function collect(nav: Nav[], kind: string, text: string) {
  const before = nav.length;
  const capture = open("capture", { kind });
  capture.useText();
  capture.onText(input(text));
  capture.submit();
  const to = await until(
    () => nav.slice(before).find((n) => n.url?.startsWith("/pages/proofread/")),
    "capture redirect",
  );
  const id = to.url!.split("id=")[1]!;
  const proof = open("proofread", { id });
  await until(() => !proof.data.loading && proof.data.text, "proofread load");
  assert.equal(proof.data.confirmed, false);
  proof.onTitle(input(kind === "note" ? "水循环" : "打折"));
  proof.confirm();
  const page = kind === "note" ? "material" : "problem";
  await until(
    () => nav.some((n) => n.url === `/pages/${page}/index?id=${id}`),
    "open after confirm",
  );
  return id;
}

test("note pages: consent, capture, proofread, cited explanation, follow-up and quiz", async () => {
  const services = fakeServices();
  const app = makeApp(services);
  const { nav } = mountWx(app);

  const home = open("home");
  assert.equal(home.data.consent, false);
  agree(home);
  await until(() => home.data.consent && !home.data.loading, "home load");
  assert.equal(home.data.error, "");
  assert.deepEqual(home.data.recent, []);

  const id = await collect(nav, "note", NOTE);

  const material = open("material", { id });
  await until(() => material.data.points.length, "explanation");
  assert.equal(material.data.material.title, "水循环");
  assert.equal(material.data.points[0].cite, "第 1 段");
  material.openSource(
    tap({ cites: [1], version: material.data.explain.version }),
  );
  await until(() => material.data.sheet, "source sheet");
  assert.deepEqual(
    material.data.sheet.lines.map((l: any) => l.hit),
    [true, false],
  );
  material.onQuestion(input("降水有什么用？"));
  material.ask();
  await until(() => material.data.answers.length, "follow-up answer");
  assert.equal(material.data.answers[0].data.question, "降水有什么用？");
  assert.equal(material.data.answers[0].cite, "第 2 段");
  assert.equal(material.data.errors.ask, "");
  material.onUnload();

  const quiz = open("practice", { id, mode: "quiz" });
  await until(() => quiz.data.question, "quiz");
  assert.equal(quiz.data.question.type, "choice");
  quiz.submit(); // nothing picked yet
  assert.equal(quiz.data.result, null);
  quiz.pick(tap({ index: 1 }));
  quiz.submit();
  await until(() => quiz.data.result, "choice judged");
  assert.equal(quiz.data.result.tone, "good");
  assert.deepEqual(
    quiz.data.question.options.map((o: any) => o.cls),
    ["", "right", ""],
  );
  quiz.openSource();
  await until(() => quiz.data.sheet, "quiz source");
  quiz.next();
  assert.equal(quiz.data.question.type, "short");
  quiz.onText(input("把水送回地面"));
  quiz.submit();
  await until(() => quiz.data.result, "short answer judged");
  assert.equal(quiz.data.result.reference, "把水送回地面");
  assert.equal(quiz.data.result.compare, true);
  quiz.next();
  assert.equal(quiz.data.finished, true);
  quiz.onUnload();
  const reopened = open("practice", { id, mode: "quiz" });
  await until(() => reopened.data.finished, "finished quiz reopened");
  assert.equal(services.llm.filter((c) => c.kind === "quiz").length, 1);

  home.onShow();
  await until(() => !home.data.loading && home.data.resume, "resume card");
  assert.equal(home.data.resume.id, id);
  await app.close();
});

test("problem pages: hints level by level, probe-first feedback and variants", async () => {
  const services = fakeServices();
  const app = makeApp(services);
  const { nav } = mountWx(app);
  agree(open("home"));

  const id = await collect(nav, "problem", PROBLEM);
  const problem = open("problem", { id });
  await until(() => problem.data.material, "problem load");
  assert.ok(problem.data.parts.some((p: any) => p.num && p.text === "60"));
  problem.nextHint();
  await until(() => problem.data.levels.length === 1, "first hint");
  assert.equal(problem.data.nextLabel, "再给一点提示");
  problem.nextHint();
  await until(() => problem.data.levels.length === 2, "second hint");
  assert.equal(problem.data.answer, null);

  const practice = open("practice", { id, mode: "problem" });
  await until(() => practice.data.parts.length, "problem shown");
  practice.onText(input("50"));
  practice.submit();
  await until(() => practice.data.result, "first attempt");
  assert.equal(practice.data.result.title, "还差一点");
  assert.equal(practice.data.result.mark, "cross-red");
  assert.equal(practice.data.result.revealed, false);
  assert.equal(practice.data.result.reference, "");
  assert.equal(practice.data.result.cause, "计算失误");
  practice.again();
  practice.onText(input("52 元"));
  practice.submit();
  await until(() => practice.data.result, "second attempt");
  assert.equal(practice.data.result.revealed, true);
  assert.equal(practice.data.result.reference, "48 元");
  assert.equal(practice.data.result.sourceText, "算过一遍，对得上");
  assert.match(practice.data.result.explanation, /60×0.8=48/);

  // Two wrong tries opened the full solution on the hint page too.
  problem.onShow();
  await until(() => problem.data.levels.length === 3, "solution opened");
  assert.equal(problem.data.answer.check, "60*0.8 = 48");
  assert.equal(problem.data.nextLabel, "");

  const variant = open("practice", { id, mode: "variant" });
  await until(() => variant.data.target, "variant drawn");
  const first = variant.data.target.id;
  assert.match(variant.data.target.data.question, /^一件衣服原价 \d+ 元/);
  variant.peekAnswer();
  await until(() => variant.data.peek, "variant answer");
  assert.equal(variant.data.peek.sourceText, "算过一遍，对得上");
  variant.onText(input(variant.data.peek.value));
  variant.submit();
  await until(() => variant.data.result, "variant judged");
  assert.equal(variant.data.result.tone, "good");
  const calls = services.llm.length;
  variant.newVariant();
  await until(
    () => !variant.data.waiting && variant.data.target.id !== first,
    "redraw",
  );
  assert.equal(variant.data.result, null);
  assert.equal(services.llm.length, calls);

  // Both wrong tries went to the 错题本 as one problem; the variant did not.
  const book = open("mistakes");
  await until(() => !book.data.loading && book.data.items.length, "mistakes");
  const [mistake] = book.data.items;
  assert.equal(book.data.items.length, 1);
  assert.equal(mistake.materialId, id);
  assert.equal(mistake.wrong, 2);
  assert.equal(mistake.answer, "52 元");
  assert.equal(mistake.cause, "计算失误");
  assert.equal(mistake.when, "明天重做");
  // Collected on the problem page, it is redone there.
  assert.equal(mistake.threadId, null);
  book.redo(tap({ id: mistake.id }));
  assert.equal(nav.at(-1)!.url, `/pages/problem/index?id=${id}`);

  const home = open("home");
  await until(() => home.data.home && !home.data.loading, "home summary");
  assert.equal(home.data.streak.title, "连续学习 1 天");
  assert.equal(home.data.week.at(-1).active, true);
  assert.deepEqual(home.data.home.todayStats, {
    asked: 0,
    answered: 3,
    correct: 1,
  });
  assert.deepEqual(
    home.data.tasks.map((t: any) => t.key),
    ["resume"],
  );
  assert.equal(home.data.home.mistakes.open, 1);
  assert.equal(home.data.weak[0].pct, 100);

  book.mark(tap({ id: mistake.id }));
  await until(
    () => book.data.counts && book.data.counts.mastered === 1,
    "mastered",
  );
  assert.deepEqual(book.data.shown, []);
  book.setStatus(tap({ status: "mastered" }));
  await until(() => book.data.shown.length === 1, "mastered list");
  // one state word on every page (utils/point-look.js); 我会了 reads 标了会.
  assert.equal(book.data.shown[0].when, "标了会");
  await app.close();
});

test("review pages: add from the material page, recall, flip and move up a box", async () => {
  const clock = { at: new Date() };
  const app = makeApp(fakeServices(), {}, () => clock.at);
  const { nav } = mountWx(app);
  const home = open("home");
  agree(home);
  const id = await collect(nav, "note", NOTE);
  const material = open("material", { id });
  await until(() => material.data.points.length, "explanation");
  assert.equal(material.data.review, null);
  material.addReview();
  await until(() => material.data.review, "added to review");
  assert.equal(material.data.review.box, 1);
  assert.match(material.data.reviewText, /再提醒你看$/);

  const review = open("review");
  await until(() => !review.data.loading, "review load");
  assert.equal(review.data.card, null);
  assert.equal(review.data.upcoming.length, 1);
  assert.equal(review.data.upcoming[0].materialId, id);

  clock.at = new Date(clock.at.getTime() + 86_400_000);
  review.onShow();
  await until(() => review.data.card, "due card");
  assert.equal(review.data.card.prompt, "不看原文，说出这份资料的 1 个重点。");
  assert.equal(review.data.flipped, false);
  review.flip();
  review.remembered();
  await until(() => review.data.done === 1 && !review.data.loading, "answered");
  assert.equal(review.data.card, null);
  assert.equal(review.data.upcoming[0].box, 2);

  home.onShow();
  await until(
    () =>
      home.data.review.total === 1 &&
      home.data.review.due === 0 &&
      home.data.review.next.startsWith("下一次："),
    "home review count",
  );
  material.removeReview();
  await until(() => material.data.review === null, "removed");
  await app.close();
});

test("library and profile pages: filter, search, delete, usage, export and erasure", async () => {
  const app = makeApp(fakeServices());
  const { nav, shared } = mountWx(app);
  agree(open("home"));
  const note = await collect(nav, "note", NOTE);
  const problem = await collect(nav, "problem", PROBLEM);

  const library = open("library");
  const shown = (count: number) => () =>
    !library.data.loading && library.data.items.length === count;
  await until(shown(2), "library");
  library.setKind(tap({ kind: "problem" }));
  await until(shown(1), "problem filter");
  assert.equal(library.data.items[0].id, problem);
  library.setKind(tap({ kind: "" }));
  await until(shown(2), "all kinds");
  library.onQuery(input("蒸发"));
  library.search();
  await until(() => library.data.searched === "蒸发", "search");
  assert.deepEqual(
    library.data.items.map((i: any) => i.id),
    [note],
  );
  library.clearQuery();
  await until(shown(2), "search cleared");
  const index = library.data.items.findIndex((i: any) => i.id === problem);
  library.manageItem(tap({ index }));
  await until(shown(1), "deleted");
  assert.equal(library.data.items[0].id, note);

  const profile = open("profile");
  await until(() => profile.data.usage.length, "usage");
  // the allowance is today's and this week's budget, in percent.
  assert.deepEqual(
    profile.data.usage.map((u: any) => [u.k, u.pct]),
    [
      ["今天", 0],
      ["本周", 0],
    ],
  );
  // On a Sunday the week comes back tomorrow as well.
  assert.equal(profile.data.usage[0].reset, "明天 0 点恢复");
  assert.match(profile.data.usage[1].reset, /^(明天|下周一) 0 点恢复$/);
  assert.equal(profile.data.budget, "今天已用 0% · 本周已用 0%");
  profile.exportData();
  await until(() => shared.length, "export sent");
  assert.match(shared[0]!.fileName, /^晓念数据导出-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = JSON.parse(shared[0]!.body);
  assert.deepEqual(
    exported.materials.map((m: any) => m.id),
    [note],
  );
  const before = nav.length;
  profile.deleteAccount();
  await until(
    () => nav.slice(before).some((n) => n.url === "/pages/notes/index"),
    "back home",
  );
  assert.equal(require(`${ROOT}utils/gate.js`).state(), "none");
  // Consent is gone too, so home asks again instead of logging in silently.
  assert.equal(open("home").data.consent, false);
  await app.close();
});

test("learning map pages: home entry, rank card and the whole map from the sample", async () => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  const { nav } = mountWx(app);
  // The same user dev-login gives the mini program (DEV_LOGIN_KEY "owner").
  const user = store.upsertUser("dev:owner", "开发者", "dev");
  seedSample(store, user.id, chinaDate());
  // The sample's review points were done a week before today.
  const [, month, day] = addDays(chinaDate(), -7).split("-").map(Number);
  const reviewMeta = `${month}/${day} 做对的，再看一眼`;

  const home = open("home");
  agree(home);
  await until(() => home.data.consent && !home.data.loading, "home load");
  home.openLearn();
  assert.equal(nav.at(-1)!.url, "/pages/learn/index");

  const learn = open("learn");
  await until(() => learn.data.card, "learn load");
  assert.equal(learn.data.error, "");
  const card = learn.data.card;
  assert.equal(card.subtitle, "高数上 · 同济第八版 · 89 个点");
  assert.equal(card.level, 10);
  assert.equal(card.correctText, "27/89");
  assert.equal(card.xpText, "经验 66/76，再得 10 升到 Lv.11");
  assert.deepEqual(
    card.chips.map((c: any) =>
      [c.short, c.started ? c.rank : "还没开始", c.ext].join(" "),
    ),
    [
      "极限 重点段 1",
      "导数 基础段 0",
      "中值与应用 基础段 0",
      "不定积分 还没开始 0",
      "定积分 还没开始 0",
      "微分方程 还没开始 0",
    ],
  );
  assert.equal(card.next, "中值与应用再做对 1 个重点，就升重点段");
  assert.deepEqual(card.book, {
    rank: "起步",
    stamp: "start",
    text: "已到基础段 3/6",
  });
  assert.equal(
    card.week,
    "本周做对 4 个 · +60 经验 · 2 个点该复习，做一题就亮",
  );
  assert.equal(card.todaySide, "2 个复习 · 1 个新的");
  assert.deepEqual(
    card.today.map((t: any) => [t.name, t.meta, t.done]),
    [
      ["等价无穷小替换", reviewMeta, false],
      ["复合函数求导", reviewMeta, false],
      ["最大值最小值应用题", "中值与应用 · 重点", true],
    ],
  );
  learn.openMap();
  assert.match(nav.at(-1)!.url!, /^\/pages\/map\/index(?:\?id=.+)?$/);

  const map = open("map");
  await until(() => map.data.chapter && !map.data.loading, "map load");
  assert.equal(map.map.summary.correct, 27);
  assert.equal(map.map.summary.total, 89);
  assert.equal(map.map.summary.book.rank, "起步");
  assert.equal(map.map.summary.book.reached, 3);
  assert.equal(map.map.summary.book.of, 6);
  assert.deepEqual(
    map.map.chapters.map((chapter: any) => [
      `${chapter.book} ${chapter.label} · ${chapter.points.length} 个点`,
      chapter.started ? chapter.rank : "还没开始",
    ]),
    [
      ["第 1 章 函数与极限 · 17 个点", "重点段"],
      ["第 2 章 导数与微分 · 12 个点", "基础段"],
      ["第 3 章 微分中值定理与导数的应用 · 19 个点", "基础段"],
      ["第 4 章 不定积分 · 7 个点", "还没开始"],
      ["第 5、6 章 定积分及其应用 · 19 个点", "还没开始"],
      ["第 7 章 微分方程 · 15 个点", "还没开始"],
    ],
  );
  const limit = map.map.chapters[0];
  assert.deepEqual(
    ["limit-equivalent", "limit-1-to-inf", "limit-discontinuity"].map((id) => {
      const point = limit.points.find((entry: any) => entry.id === id);
      return [point.id, point.state, point.red];
    }),
    [
      ["limit-equivalent", "due", false],
      ["limit-1-to-inf", "correct", false],
      ["limit-discontinuity", "none", true],
    ],
  );
  assert.equal(
    map.map.chapters[1].points.filter((point: any) => point.hard).length,
    0,
  ); // 导数没有难点
  assert.ok(
    map.map.chapters[3].points.every((point: any) => point.state === "none"),
  );
  await app.close();
});

test("point page: a new point beyond today's completed slot, wrong, unsure, then right with a level-up and a chapter rank-up", async () => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  const { nav } = mountWx(app);
  const user = store.upsertUser("dev:owner", "开发者", "dev");
  seedSample(store, user.id, chinaDate());
  agree(open("home"));

  const learn = open("learn");
  await until(() => learn.data.card, "learn load");
  const fresh = learn.data.card.today.find((t: any) => t.kind === "new");
  assert.equal(fresh.id, "application-optimization");
  assert.equal(fresh.done, true);
  // C1 keeps the sample and the rule: today's new-point slot is already done.
  // Another unlit point can still be opened from the chapter or map.
  learn.openPoint(tap({ id: "application-taylor-limit" }));
  assert.equal(
    nav.at(-1)!.url,
    "/pages/point/index?id=application-taylor-limit",
  );

  const page = open("point", { id: "application-taylor-limit" });
  await until(() => page.data.point, "point load");
  const p = page.data.point;
  assert.equal(page.data.error, "");
  assert.equal(p.name, "泰勒公式求极限");
  assert.equal(p.tier, "重点");
  assert.equal(p.meta, "3.3 · 第 3 章 中值与应用");
  assert.deepEqual(
    p.prereqs.map((q: any) => [q.name, q.state]),
    [
      ["麦克劳林公式", "做对了"],
      ["等价无穷小替换", "该复习"],
    ],
  );
  // V4.1 G4 : the bank problem, filled on the number pad.
  assert.equal(p.problem.format, "blanks");
  assert.equal(p.problem.kindText, "填空题");
  assert.deepEqual(p.problem.blanks, [{ label: "", note: "写精确值", var: "x" }]);
  assert.equal(p.problem.index, 0);
  assert.equal(p.problem.total, 4);
  assert.ok(p.problem.blocks.length);
  assert.equal(page.data.correct, false);
  // Opening the page records 看过 once.
  await until(
    () =>
      store.db
        .prepare(
          "SELECT seen_at FROM map_points WHERE user_id=? AND point_id=?",
        )
        .get(user.id, p.id),
    "seen mark",
  );

  // 我会了 and back again.
  await page.toggleSelf();
  assert.equal(page.data.self, true);
  await page.toggleSelf();
  assert.equal(page.data.self, false);

  // Submit stays off while the box is empty or only spaces.
  await page.submit();
  assert.equal(page.data.result, null);
  assert.equal(page.data.canSubmit, false);
  typeIn(page, "   ");
  assert.equal(page.data.canSubmit, false);
  typeIn(page, "1/");
  assert.equal(page.data.canSubmit, false, "a fraction needs its denominator");

  // A wrong answer now shows the solution, so it settles the problem and makes
  // the point practice for today; that is checked on another point at
  // the end. Here: unsure first (nothing settles), then right.
  typeIn(page, "-0.0833");
  assert.equal(page.data.canSubmit, true);
  await page.submit();
  let r = page.data.result;
  assert.equal(r.tone, "unsure");
  assert.equal(r.text, "小数换成分数、根号、π 或 e 再交");
  assert.equal(r.solution, null);
  assert.equal(r.xp, 0);
  assert.equal(page.data.done, false);

  typeIn(page, "-1/12");
  await page.submit();
  r = page.data.result;
  assert.equal(r.tone, "good");
  assert.equal(r.text, "做对了");
  assert.ok(r.solution.answer.length, "the right answer");
  assert.ok(r.solution.explanation, "the solution");
  assert.equal(r.read, null);
  assert.equal(r.xp, 20);
  assert.deepEqual(r.levelUp, {
    level: 11,
    text: "升到 Lv.11",
    sub: "经验 10/84，再得 74 升到 Lv.12",
  });
  assert.equal(r.progress.label, "中值与应用 · 重点");
  assert.equal(r.progress.count, "做对 5/6，要 5");
  assert.deepEqual(
    r.progress.cells.map((c: any) => (c.fresh ? `${c.cls}*` : c.cls)),
    ["correct", "correct", "correct", "correct*", "correct", ""],
  );
  assert.deepEqual(r.rank, {
    rank: "重点段",
    stamp: "key",
    text: "中值与应用 升到重点段",
  });
  assert.equal(r.next.text, "下一个：泰勒余项与误差估计 · 难点");
  assert.equal(page.data.done, true);
  assert.equal(page.data.correct, true);

  // The sheet rises by itself and can be closed and reopened.
  assert.equal(page.data.sheetOpen, true);
  const sheet = page.data.sheet;
  assert.equal(sheet.title, "中值与应用 升到 重点段");
  assert.equal(sheet.line, "这一章作业和考试里最常考的方法，大部分你做对过。");
  assert.equal(sheet.jump, "");
  assert.equal(sheet.next.rank, "难点段");
  assert.equal(sheet.next.gap, "还差 4 个难点");
  assert.equal(sheet.next.count, "做对 0/5，要 4 · 看过 1");
  assert.deepEqual(
    sheet.next.cells.map((c: any) => c.cls),
    ["", "", "seen", "", ""],
  );
  page.closeSheet();
  assert.equal(page.data.sheetOpen, false);
  page.openSheet();
  assert.equal(page.data.sheetOpen, true);
  page.openNext();
  assert.deepEqual(nav.at(-1), {
    kind: "redirectTo",
    url: "/pages/point/index?id=application-taylor-remainder",
  });
  page.goMap();
  assert.deepEqual(nav.at(-1), { kind: "navigateTo", url: "/pages/map/index" });
  // 接着做这一章 and the head line open the chapter page.
  page.openChapter();
  assert.deepEqual(nav.at(-1), {
    kind: "navigateTo",
    url: "/pages/chapter/index?id=application",
  });
  // With the learn page under this one, 回学习首页 goes back to it.
  const g = globalThis as any;
  g.getCurrentPages = () => [
    { route: "pages/learn/index" },
    { route: "pages/point/index" },
  ];
  page.goLearn();
  assert.equal(nav.at(-1)!.kind, "switchTab");
  g.getCurrentPages = () => [
    { route: "pages/learn/index" },
    { route: "pages/chapter/index", options: { id: "application" } },
    { route: "pages/point/index", options: { id: "application-taylor-limit" } },
  ];
  page.openChapter();
  assert.deepEqual(nav.at(-1), { kind: "navigateBack" });
  g.getCurrentPages = () => [];
  page.goLearn();
  assert.deepEqual(nav.at(-1), {
    kind: "switchTab",
    url: "/pages/learn/index",
  });

  // The learn page shows the new numbers when it comes back.
  learn.onShow();
  await until(
    () => !learn.data.loading && learn.data.card.correctText === "28/89",
    "learn reload",
  );
  assert.equal(learn.data.card.level, 11);
  assert.equal(learn.data.card.xpText, "经验 10/84，再得 74 升到 Lv.12");

  // Answering again counts no more XP.
  const again = open("point", { id: "application-taylor-limit" });
  await until(() => again.data.point, "point reload");
  assert.equal(again.data.correct, true);
  // The bank serves the next one not yet done right.
  assert.equal(again.data.point.problem.index, 1);
  answerRight(again, "application-taylor-limit", 1);
  await again.submit();
  assert.equal(
    again.data.result.text,
    "做对了。这个点之前做对过，这次不加经验。",
  );
  assert.equal(again.data.result.xp, 0);
  assert.equal(again.data.result.levelUp, null);
  assert.equal(again.data.sheet, null);

  // A prerequisite opens in place of this page.
  again.openPrereq(tap({ id: "application-taylor-expand" }));
  assert.deepEqual(nav.at(-1), {
    kind: "redirectTo",
    url: "/pages/point/index?id=application-taylor-expand",
  });

  // Wrong on a new point: the solution shows, the problem is settled and the
  // point is practice today, so the right answer after it lights nothing.
  const wrong = open("point", { id: "application-taylor-remainder" });
  await until(() => wrong.data.point, "wrong point load");
  const wrongProblem = BANK["application-taylor-remainder"]![wrong.data.point.problem.index]!;
  if (wrongProblem.kind === "choice")
    wrongProblem.questions.forEach((q, question) =>
      wrong.chooseOption(
        tap({ question, id: q.options.find((o) => o.id !== q.answer)!.id }),
      ),
    );
  else typeIn(wrong, ...(wrongProblem.kind === "multi" ? wrongProblem.parts.map(() => "12345") : ["12345"]));
  await wrong.submit();
  r = wrong.data.result;
  assert.equal(r.tone, "bad");
  assert.match(r.text, /看看下面的解法|不对/);
  assert.ok(r.solution, "the solution");
  assert.equal(r.xp, 0);
  assert.equal(r.levelUp, null);
  assert.equal(r.progress, null);
  assert.equal(wrong.data.done, true);
  assert.equal(wrong.data.point.practice, true);
  await app.close();
});

test("learning reviews: unsure, lapse, retry, next interval and today's completed list", async () => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  const { nav } = mountWx(app);
  const user = store.upsertUser("dev:owner", "开发者", "dev");
  const today = chinaDate();
  seedSample(store, user.id, today);
  agree(open("home"));
  const learn = open("learn");
  await until(() => learn.data.card, "review list");
  const initial = learn.data.card;
  const first = initial.today[0];
  assert.equal(first.id, "limit-equivalent");
  learn.openPoint(tap({ id: first.id }));
  assert.equal(nav.at(-1)!.url, "/pages/point/index?id=limit-equivalent");
  const limit = open("point", { id: first.id });
  await until(() => limit.data.point && !limit.data.loading, "review point");
  const index = PROBLEMS[first.id]!.length > 1 ? 1 : 0;
  assert.equal(limit.data.point.problem.index, index);
  assert.equal(limit.data.point.review, true);
  assert.equal(limit.data.point.cell, "due");
  assert.equal(limit.data.point.stateText, "该复习");
  assert.equal(limit.data.correct, true);
  assert.match(
    readFileSync(`${ROOT}pages/point/index.wxml`, "utf8"),
    /好几天没碰了，再做一遍巩固下/,
  );

  // The pad only types numbers; a zero denominator is what it cannot judge.
  typeIn(limit, "4/0");
  await limit.submit();
  assert.equal(limit.data.result.tone, "unsure");
  assert.equal(limit.data.done, false);
  assert.equal(limit.data.point.review, true);
  // 这题有问题 sends the answer the server just judged.
  await limit.report("judge");
  const report = store.db
    .prepare(
      "SELECT verdict, answer, problem_index FROM map_reports WHERE user_id=? AND point_id=?",
    )
    .get(user.id, first.id) as any;
  assert.deepEqual({ ...report }, { verdict: "unsure", answer: "4/0", problem_index: index });
  await learn.load();
  assert.equal(learn.data.card.today[0].done, false);

  typeIn(limit, "0");
  await limit.submit();
  assert.equal(limit.data.result.text, "不对，看看下面的解法。明天再回头看看这个点");
  assert.equal(limit.data.result.standard, null);
  assert.ok(limit.data.result.solution);
  assert.equal(limit.data.point.review, true);
  assert.equal(limit.data.point.cell, "due");
  // Settled with the solution shown : 下一题 is next.
  assert.equal(limit.data.done, true);
  await learn.load();
  assert.equal(
    learn.data.card.today.find((t: any) => t.id === first.id).done,
    true,
  );
  assert.equal(learn.data.card.todaySide, "2 个复习 · 1 个新的");
  assert.equal(
    learn.data.card.week,
    "本周做对 4 个 · +60 经验 · 1 个点该复习，做一题就亮",
  );

  await limit.nextProblem();
  const next = index + 1;
  assert.equal(limit.data.point.problem.index, next);
  assert.equal(limit.data.done, false);
  const reviewAnswer = scalarAnswer(first.id, next);
  typeIn(limit, reviewAnswer);
  await limit.submit();
  assert.equal(limit.data.result.text, "这次做对了，明天再回头看看");
  assert.equal(limit.data.result.standard, null);
  assert.equal(limit.data.result.xp, 0);
  assert.equal(limit.data.result.levelUp, null);
  assert.equal(limit.data.sheet, null);
  assert.equal(limit.data.book, null);
  assert.equal(limit.data.point.review, true);
  assert.equal(limit.data.point.cell, "due");
  assert.equal(limit.data.point.stateText, "该复习");
  assert.equal(limit.data.point.problem.index, next);
  assert.deepEqual(limit.data.answers, [reviewAnswer]);
  // Returning to the same problem keeps the work; the server's pick (the
  // first one not yet done right, the review being tomorrow) discards it.
  await limit.load({ index: next });
  assert.deepEqual(limit.data.answers, [reviewAnswer]);
  assert.equal(limit.data.done, true);
  await limit.load();
  assert.equal(limit.data.point.problem.index, 0);
  assert.deepEqual(limit.data.answers, [""]);
  assert.equal(limit.data.result, null);
  assert.equal(limit.data.done, false);

  const chain = open("point", { id: "derivative-chain" });
  await until(() => chain.data.point && !chain.data.loading, "chain review");
  assert.equal(chain.data.point.review, true);
  answerRight(chain, chain.id, chain.data.point.problem.index);
  await chain.submit();
  assert.equal(chain.data.result.text, "做对了，21 天后再回头看看");
  assert.equal(chain.data.point.cell, "correct");
  assert.equal(chain.data.point.review, false);
  learn.onShow();
  await until(
    () => !learn.data.loading && learn.data.card.todaySide === "今天的做完了",
    "completed today",
  );
  assert.equal(learn.data.card.today.length, 3);
  assert.ok(learn.data.card.today.every((t: any) => t.done));
  assert.equal(
    learn.data.card.today.find((t: any) => t.kind === "new").id,
    "application-optimization",
  );
  assert.ok(
    learn.data.card.today.every((t: any) => !t.meta.includes("做对 +")),
  );
  assert.equal(learn.data.card.week, "本周做对 4 个 · +60 经验");
  assert.equal(learn.data.card.correctText, initial.correctText);
  assert.equal(learn.data.card.xpText, initial.xpText);
  assert.deepEqual(learn.data.card.chips, initial.chips);

  const map = open("map");
  await until(() => map.data.chapter && !map.data.loading, "map after reviews");
  for (const [id, state] of [
    ["limit-equivalent", "correct"],
    ["derivative-chain", "correct"],
  ])
    assert.equal(
      map.map.chapters
        .flatMap((chapter: any) => chapter.points)
        .find((point: any) => point.id === id).state,
      state,
    );
  const chapter = open("chapter", { id: "limit" });
  await until(() => chapter.data.chapter, "chapter after reviews");
  const limitRow = chapter.data.chapter.tiers
    .flatMap((t: any) => t.rows)
    .find((p: any) => p.id === first.id);
  assert.equal(limitRow.status, "做对了");

  // A completed new-point slot does not prevent another point from lighting up.
  const fresh = open("point", { id: "application-taylor-limit" });
  await until(() => fresh.data.point && !fresh.data.loading, "extra new point");
  answerRight(fresh, fresh.id, fresh.data.point.problem.index);
  await fresh.submit();
  assert.equal(fresh.data.result.xp, 20);
  assert.equal(fresh.data.sheetOpen, true);
  await learn.load();
  assert.equal(learn.data.card.todaySide, "今天的做完了");
  assert.equal(learn.data.card.correctText, "28/89");

  store.db
    .prepare(
      "UPDATE map_points SET interval=63, due_on=? WHERE user_id=? AND point_id=?",
    )
    .run(today, user.id, "derivative-chain");
  const final = open("point", { id: "derivative-chain" });
  await until(() => final.data.point && !final.data.loading, "final review");
  answerRight(final, final.id, final.data.point.problem.index);
  await final.submit();
  assert.equal(
    final.data.result.text,
    "做对了。这个点以后不再提醒，想练随时能做。",
  );
  assert.equal(final.data.point.review, false);
  assert.equal(final.data.point.cell, "correct");
  assert.equal(final.data.result.xp, 0);
  // The right answer comes with the solution, choice or number.
  assert.ok(final.data.result.solution.answer.length);
  assert.equal(final.data.sheet, null);
  await app.close();
});

test("point page serializes refresh and submission so an old result cannot attach to a new problem", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  mountWx(app);
  const user = store.upsertUser("dev:owner", "开发者", "dev");
  seedSample(store, user.id, chinaDate());
  const id = "limit-equivalent";
  // BANK serves PROBLEMS as they are now (a read-only view).
  const original = PROBLEMS[id]!;
  PROBLEMS[id] = [
    original[0]!,
    { kind: "number", text: "计算 $2+2$。", answer: "4" },
  ];
  t.after(async () => {
    PROBLEMS[id] = original;
    await app.close();
  });
  agree(open("home"));
  const point = open("point", { id });
  await until(
    () => point.data.point && !point.data.loading,
    "review before queued requests",
  );
  assert.equal(point.data.point.problem.index, 1);
  typeIn(point, "4");

  const wx = (globalThis as any).wx;
  const request = wx.request;
  const base = `/v1/learn/points/${id}`;
  let heldGet: any;
  let heldAnswer: any;
  let holdGet = true;
  let holdAnswer = false;
  let gets = 0;
  let answers = 0;
  wx.request = (options: any) => {
    const route = options.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    // A refresh reads the point and its bank problem side by side; holding
    // the problem holds the refresh.
    if (route === `${base}/practice` && options.method === "GET") {
      gets++;
      if (holdGet) {
        assert.equal(heldGet, undefined, "refresh requests are coalesced");
        heldGet = options;
        return;
      }
    }
    if (route === `${base}/submit`) {
      answers++;
      if (holdAnswer) {
        heldAnswer = options;
        return;
      }
    }
    return request(options);
  };
  const loading = point.load();
  assert.equal(point.load(), loading);
  await until(() => heldGet, "held refresh");
  await point.submit();
  assert.equal(
    answers,
    0,
    "submitting while a refreshed question is loading is blocked",
  );
  typeIn(point, "7");
  assert.deepEqual(point.data.answers, ["4"], "loading cannot change the input");
  const firstGet = heldGet;
  heldGet = undefined;
  holdGet = false;
  request(firstGet);
  await loading;

  holdAnswer = true;
  const submitting = point.submit();
  await until(() => heldAnswer, "held submission");
  assert.equal(answers, 1);
  assert.equal(heldAnswer.data.index, 1);
  const queued = point.load();
  const alsoQueued = point.load();
  point.onShow();
  assert.equal(
    gets,
    1,
    "onShow and explicit refreshes wait until submission finishes",
  );
  typeIn(point, "7");
  assert.deepEqual(
    point.data.answers,
    ["4"],
    "submission keeps its input and problem together",
  );
  holdGet = true;
  request(heldAnswer);
  await submitting;
  assert.equal(point.data.point.problem.index, 1);
  assert.equal(point.data.result.text, "做对了，21 天后再回头看看");
  assert.equal(point.lastAnswer, "4");
  assert.equal(point.lastAnswerIndex, 1);
  await until(() => heldGet, "queued refresh after submission");
  assert.equal(gets, 2, "queued refreshes share one request");
  await point.report("judge");
  assert.equal(
    store.db
      .prepare("SELECT verdict FROM map_reports WHERE user_id=?")
      .get(user.id)!.verdict,
    "correct",
  );
  const nextGet = heldGet;
  heldGet = undefined;
  holdGet = false;
  request(nextGet);
  await Promise.all([queued, alsoQueued]);
  assert.equal(point.data.point.problem.index, 0);
  assert.deepEqual(point.data.answers, [""]);
  assert.equal(point.data.result, null);
  assert.equal(point.data.done, false);
  assert.equal(point.lastAnswer, "");
  assert.equal(point.lastAnswerIndex, undefined);
  await point.report("unclear");
  const report = store.db
    .prepare(
      "SELECT answer FROM map_reports WHERE user_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(user.id)!;
  assert.equal(
    report.answer,
    null,
    "the previous question's answer is not attached to a new report",
  );
});

test("point page blocks submission while a self-mark response is pending", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  mountWx(app);
  agree(open("home"));
  const id = "limit-rules";
  const point = open("point", { id });
  await until(
    () => point.data.point && !point.data.loading,
    "new point before delayed self-mark",
  );
  answerRight(point, id, point.data.point.problem.index);

  const wx = (globalThis as any).wx;
  const request = wx.request;
  let releaseMark: (() => void) | undefined;
  let answers = 0;
  wx.request = (options: any) => {
    const route = options.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (route === `/v1/learn/points/${id}/submit`) answers++;
    if (route === "/v1/learn/marks" && options.data.action === "self") {
      // The server has applied the mark. Only its response is delayed, so a
      // later answer could otherwise be overwritten by this stale UI state.
      return request({
        ...options,
        success: (response: any) => {
          releaseMark = () => options.success(response);
        },
      });
    }
    return request(options);
  };
  t.after(async () => {
    releaseMark?.();
    wx.request = request;
    await app.close();
  });

  const marking = point.toggleSelf();
  await until(() => releaseMark, "self-mark response held after the write");
  await point.submit();
  assert.equal(
    answers,
    0,
    "an in-flight self-mark must finish before submitting the answer",
  );
  releaseMark!();
  releaseMark = undefined;
  await marking;
  assert.equal(point.data.self, true);
  await point.submit();
  assert.equal(answers, 1);
  assert.equal(point.data.done, true);
  assert.equal(point.data.correct, true);
  assert.equal(point.data.self, false);
  assert.equal(point.data.point.cell, "correct");
  assert.equal(point.data.point.stateText, "做对了");
});

test("point page keeps a judged result that arrives while the app is in the background", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  mountWx(app);
  agree(open("home"));
  const id = "limit-rules";
  const point = open("point", { id });
  await until(() => point.data.point && !point.data.loading, "point loaded");
  answerRight(point, id, point.data.point.problem.index);
  const wx = (globalThis as any).wx;
  const request = wx.request;
  let release: (() => void) | undefined;
  wx.request = (options: any) => {
    const route = options.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (route.endsWith("/submit"))
      return request({
        ...options,
        success: (response: any) => {
          release = () => options.success(response);
        },
      });
    return request(options);
  };
  t.after(async () => {
    wx.request = request;
    await app.close();
  });
  const submitting = point.submit();
  await until(() => release, "answer recorded, response held");
  point.onHide(); // e.g. switched to a WeChat chat while judging
  release!();
  await submitting;
  point.onShow();
  await until(
    () => !point.data.loading && !point.loadRequest,
    "refresh on return",
  );
  assert.equal(point.data.done, true);
  assert.equal(
    point.data.result.xp,
    TIER_XP[point.data.point.tier as keyof typeof TIER_XP],
  );
  assert.equal(point.data.point.cell, "correct");
  // Closing the page, unlike hiding it, still discards a late response.
  const again = open("point", { id: "limit-squeeze" });
  await until(() => again.data.point && !again.data.loading, "second point");
  answerRight(again, "limit-squeeze", again.data.point.problem.index);
  release = undefined;
  const late = again.submit();
  await until(() => release, "second response held");
  again.onUnload();
  release!();
  await late;
  assert.equal(again.data.result, null);
});

test("learning home ignores an older refresh after today's reviews are complete", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  mountWx(app);
  const user = store.upsertUser("dev:owner", "开发者", "dev");
  seedSample(store, user.id, chinaDate());
  agree(open("home"));
  const learn = open("learn");
  await until(
    () => learn.data.card && !learn.data.loading,
    "initial daily list",
  );
  assert.notEqual(learn.data.card.todaySide, "今天的做完了");

  const wx = (globalThis as any).wx;
  const request = wx.request;
  let holdMap = true;
  let releaseOld: (() => void) | undefined;
  wx.request = (options: any) => {
    const route = options.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (holdMap && route === "/v1/learn/map" && options.method === "GET") {
      // Save the already-computed response, rather than delaying its request:
      // this snapshot still contains the two unfinished reviews.
      return request({
        ...options,
        success: (response: any) => {
          releaseOld = () => options.success(response);
        },
      });
    }
    return request(options);
  };
  t.after(async () => {
    releaseOld?.();
    wx.request = request;
    await app.close();
  });
  const oldLoad = learn.load();
  await until(() => releaseOld, "older home response held");
  holdMap = false;

  for (const id of ["limit-equivalent", "derivative-chain"]) {
    const point = open("point", { id });
    await until(
      () => point.data.point && !point.data.loading,
      "review loaded while old home response is pending",
    );
    answerRight(point, id, point.data.point.problem.index);
    await point.submit();
    assert.equal(point.data.done, true);
  }
  // Returning to the home page must get a fresh snapshot, even if its earlier
  // pull-to-refresh response has not arrived yet.
  await learn.load();
  assert.equal(learn.data.card.todaySide, "今天的做完了");
  assert.ok(learn.data.card.today.every((entry: any) => entry.done));
  releaseOld!();
  releaseOld = undefined;
  await oldLoad;
  assert.equal(learn.data.card.todaySide, "今天的做完了");
  assert.ok(learn.data.card.today.every((entry: any) => entry.done));
  assert.doesNotMatch(learn.data.card.week, /个点该复习/);
  assert.equal(learn.data.error, "");
  assert.equal(learn.data.loading, false);
});

test("point page: a temporarily unavailable problem says 题目准备中 and 我会了 still works", async (t) => {
  const saved = PROBLEMS["limit-epsilon-n"]!;
  delete PROBLEMS["limit-epsilon-n"];
  t.after(() => {
    PROBLEMS["limit-epsilon-n"] = saved;
  });
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  mountWx(app);
  agree(open("home"));
  const page = open("point", { id: "limit-epsilon-n" });
  await until(() => page.data.point, "point load");
  assert.equal(page.data.point.problem, null);
  await page.toggleSelf();
  assert.equal(page.data.self, true);
  assert.equal(page.data.fail, "");
  await app.close();
});

test("point page: 404 has no 重试, 看过 is sent after a load that works, practice lights nothing", async () => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  mountWx(app);
  const user = store.upsertUser("dev:owner", "开发者", "dev");
  agree(open("home"));
  const seenAt = (id: string) =>
    store.db
      .prepare("SELECT seen_at FROM map_points WHERE user_id=? AND point_id=?")
      .get(user.id, id);

  const missing = open("point", { id: "no-such-point" });
  await until(() => missing.data.error, "404");
  assert.equal(missing.data.canRetry, false);
  // A first load that fails, then 重试 that works: 看过 is recorded then, once.
  missing.id = "limit-rules";
  await missing.load();
  assert.equal(missing.data.point.id, "limit-rules");
  await until(() => seenAt("limit-rules"), "seen after retry");
  const first = (seenAt("limit-rules") as { seen_at: string }).seen_at;
  await missing.load();
  assert.equal((seenAt("limit-rules") as { seen_at: string }).seen_at, first);

  // 看过解析 today: a right answer is practice; the point stays unlit and self-assessed.
  store.db
    .prepare(
      "UPDATE map_points SET practice_on=?, self_at=? WHERE user_id=? AND point_id=?",
    )
    .run(chinaDate(), new Date().toISOString(), user.id, "limit-rules");
  const page = open("point", { id: "limit-rules" });
  await until(() => page.data.point, "point load");
  assert.equal(page.data.self, true);
  typeIn(page, "1/2");
  await page.submit();
  assert.equal(
    page.data.result.text,
    "做对了。今天只算练习，明天再做对就算数。",
  );
  assert.equal(page.data.correct, false);
  assert.equal(page.data.self, true);
  await app.close();
});

test("chapter page: from the learn chip, next rank, 把剩下的标为会了 and undo, 这章不学 and back", async () => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  const { nav } = mountWx(app);
  const user = store.upsertUser("dev:owner", "开发者", "dev");
  seedSample(store, user.id, chinaDate());
  agree(open("home"));

  const learn = open("learn");
  await until(() => learn.data.card, "learn load");
  const chip = learn.data.card.chips.find((c: any) => c.short === "中值与应用");
  learn.openChapter(tap({ id: chip.id }));
  assert.deepEqual(nav.at(-1), {
    kind: "navigateTo",
    url: "/pages/chapter/index?id=application",
  });
  // 下一步 opens the chapter it names; 段位和等级怎么算 opens the ranks page.
  assert.equal(learn.data.card.nextId, "application");
  learn.openNext();
  assert.equal(nav.at(-1)!.url, "/pages/chapter/index?id=application");
  learn.openRanks();
  assert.equal(nav.at(-1)!.url, "/pages/ranks/index");

  const page = open("chapter", { id: "application" });
  await until(() => page.data.chapter, "chapter load");
  let c = page.data.chapter;
  assert.equal(page.data.error, "");
  assert.equal(c.meta, "第 3 章 微分中值定理与导数的应用 · 19 个点 · 3.1—3.8");
  assert.equal(c.short, "中值与应用");
  assert.equal(c.rank, "基础段");
  assert.equal(c.countText, "做对 9/19 个点");
  assert.equal(c.next.rank, "重点段");
  assert.equal(c.next.gap, "还差 1 个重点");
  assert.deepEqual(
    c.next.rows.map((r: any) => [r.name, r.section]),
    [
      ["泰勒公式求极限", "3.3"],
      ["函数图形的描绘", "3.6"],
    ],
  );
  // S8/S9 makes either remaining key point available for this rank.
  assert.deepEqual(
    c.next.rows.map((r: any) => r.status),
    ["", ""],
  );
  assert.equal(c.next.note, "做对其中任一个，就升重点段。");
  assert.equal(c.next.jump, "");
  assert.deepEqual(
    c.tiers.map((t: any) => [t.tier, t.count, t.side]),
    [
      ["基础", "做对 5/6，要 5 · 标了会 1", "达标"],
      ["重点", "做对 4/6，要 5", "还差 1"],
      ["难点", "做对 0/5，要 4", "还差 4"],
      ["拓展", "做对 0/2 · 不设段", ""],
    ],
  );
  assert.deepEqual(
    c.tiers[1].rows.map((r: any) => [r.name, r.push ? "做对就升段" : r.status]),
    [
      ["洛必达法则", "做对了"],
      ["其他未定式的极限", "做对了"],
      ["麦克劳林公式", "做对了"],
      ["泰勒公式求极限", "做对就升段"],
      ["最大值最小值应用题", "做对了"],
      ["函数图形的描绘", "做对就升段"],
    ],
  );
  assert.deepEqual(
    c.tiers[2].rows.map((r: any) => r.status),
    // All hard points now have problems; the seen mark is still shown.
    ["", "", "看过", "", ""],
  );
  assert.equal(c.tiers[0].rows[5].status, "标了会");
  assert.equal(c.rest, 9);
  assert.match(c.restNote, /^其余 9 个还没做对/);
  assert.equal(c.selfCount, 1);
  page.openPoint(tap({ id: "application-sketch" }));
  assert.deepEqual(nav.at(-1), {
    kind: "navigateTo",
    url: "/pages/point/index?id=application-sketch",
  });
  page.goMap();
  assert.deepEqual(nav.at(-1), { kind: "navigateTo", url: "/pages/map/index" });

  // A point page left in the stack, returned to after 把剩下的标为会了.
  const sketch = open("point", { id: "application-sketch" });
  await until(() => sketch.data.point && !sketch.data.loading, "sketch load");
  assert.equal(sketch.data.self, false);

  // 把剩下的标为会了, then the undo link.
  await page.selfRest();
  sketch.onShow();
  await until(() => sketch.data.self === true, "point page reread on show");
  c = page.data.chapter;
  assert.equal(page.data.fail, "");
  assert.equal(c.rest, 0);
  assert.equal(c.selfCount, 10);
  assert.equal(c.tiers[2].count, "做对 0/5，要 4 · 标了会 5");
  assert.equal(c.countText, "做对 9/19 个点");
  assert.equal(c.rank, "基础段");
  // Both points still needed are self-assessed now (spec §7).
  assert.equal(c.next.note, "还差的 1 个重点你标了会，做对就升重点段。");
  page.confirmUnself(); // showModal confirms in this stub.
  await until(
    () => !page.data.busy && page.data.chapter.selfCount === 0,
    "unselfRest",
  );
  c = page.data.chapter;
  assert.equal(c.rest, 10);
  sketch.onShow();
  await until(() => sketch.data.self === false, "point page after the undo");
  assert.equal(c.tiers[0].count, "做对 5/6，要 5");
  // 看过 survives the undo.
  assert.equal(c.tiers[2].rows[2].status, "看过");

  // A chapter without 难点 (导数) and one not started (不定积分).
  const derivative = open("chapter", { id: "derivative" });
  await until(() => derivative.data.chapter, "derivative load");
  const d = derivative.data.chapter;
  assert.equal(d.next.rank, "难点段");
  assert.equal(d.next.gap, "还差 3 个重点");
  assert.deepEqual(d.next.rows, []);
  assert.equal(d.next.jump, "本章没有难点，重点达标就连升两段");
  assert.equal(d.tiers[2].none, true);
  const indefinite = open("chapter", { id: "indefinite" });
  await until(() => indefinite.data.chapter, "indefinite load");
  const i = indefinite.data.chapter;
  assert.equal(i.started, false);
  assert.equal(i.countText, "做对 0/7 个点");
  assert.equal(i.next.rank, "基础段");
  assert.equal(i.next.gap, "还差 2 个基础");
  assert.equal(i.tiers[3].none, true);
  assert.equal(i.rest, 7);

  // 这章不学 on four chapters: the book rank is the lowest of 极限 and 中值与应用.
  for (const id of ["derivative", "indefinite", "definite", "ode"]) {
    await page.hideChapter(id);
    assert.equal(page.data.fail, "");
  }
  learn.onShow();
  await until(
    () => !learn.data.loading && learn.data.card.book?.rank === "基础段",
    "learn reload",
  );
  assert.equal(learn.data.card.book.text, "已到基础段 2/2");
  assert.equal(learn.data.card.correctText, "21/36");
  // The chapter page's own menu, and the banner on a hidden chapter.
  const sheets: any[] = [];
  const pick = (globalThis as any).wx.showActionSheet;
  (globalThis as any).wx.showActionSheet = (o: any) => {
    sheets.push({ itemList: o.itemList, alertText: o.alertText });
    pick(o);
  };
  page.openMenu(); // showActionSheet picks 这章不学 in this stub.
  await until(
    () => !page.data.busy && page.data.chapter.hidden,
    "hide by menu",
  );
  // The board's line under 这章不学; none under 恢复这一章.
  page.openMenu();
  await until(
    () => !page.data.busy && !page.data.chapter.hidden,
    "unhide by menu",
  );
  assert.deepEqual(sheets, [
    { itemList: ["这章先放着"], alertText: "先放着的章不算进全书段位和做对数，随时能放回来" },
    { itemList: ["放回来"], alertText: undefined },
  ]);
  await page.hideChapter();
  // The last chapter left cannot go: the server's message shows.
  const limit = open("chapter", { id: "limit" });
  await until(() => limit.data.chapter, "limit load");
  const toasts: string[] = [];
  (globalThis as any).wx.showToast = (o: { title: string }) =>
    toasts.push(o.title);
  await limit.hideChapter("limit");
  // A rule, not a failure: a toast where the tap was, no red bar.
  assert.equal(limit.data.fail, "");
  assert.deepEqual(toasts, ["最后一章先留着吧"]);
  assert.equal(limit.data.chapter.hidden, false);
  await page.restore();
  assert.equal(page.data.chapter.hidden, false);
  for (const id of ["derivative", "indefinite", "definite", "ode"])
    await page.unhideChapter(id);
  learn.onShow();
  await until(
    () => !learn.data.loading && learn.data.card.book?.rank === "起步",
    "learn reload after unhide",
  );
  assert.equal(learn.data.card.book.text, "已到基础段 3/6");

  // v2 全书地图直接切章节；章节动作仍走同一 marks contract.
  const map = open("map");
  await until(() => map.data.chapter && !map.data.loading, "map load");
  map.selectChapter(tap({ id: "ode" }));
  assert.equal(map.data.chapterId, "ode");
  sheets.length = 0;
  await map.markChapter("hide", "ode");
  assert.equal(map.map.chapters.find((c: any) => c.id === "ode").hidden, true);
  await map.markChapter("unhide", "ode");
  assert.equal(map.map.chapters.find((c: any) => c.id === "ode").hidden, false);
  assert.equal(map.data.fail, "");
  // The last chapter on the map: the 409 shows as a toast where the tap was.
  for (const id of [
    "limit",
    "derivative",
    "application",
    "indefinite",
    "definite",
  ])
    await map.markChapter("hide", id);
  toasts.length = 0;
  await map.markChapter("hide", "ode");
  assert.deepEqual(toasts, ["最后一章先留着吧"]);
  assert.equal(map.data.fail, "");
  for (const id of [
    "limit",
    "derivative",
    "application",
    "indefinite",
    "definite",
  ])
    await map.markChapter("unhide", id);

  // An unknown chapter has no 重试.
  const missing = open("chapter", { id: "no-such-chapter" });
  await until(() => missing.data.error, "unknown chapter");
  assert.equal(missing.data.error, "没找到这一章");
  assert.equal(missing.data.canRetry, false);
  await app.close();
});

test("point page: the book rank-up card after 这章不学 on four chapters, and 这题有问题", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  const { nav } = mountWx(app);
  const user = store.upsertUser("dev:owner", "开发者", "dev");
  seedSample(store, user.id, chinaDate());
  agree(open("home"));
  const reports = () =>
    store.db
      .prepare(
        "SELECT point_id, reason, answer, verdict FROM map_reports WHERE user_id=? ORDER BY created_at, rowid",
      )
      .all(user.id)
      .map((row) => ({ ...(row as object) })) as {
      point_id: string;
      reason: string;
      answer: string | null;
      verdict: string | null;
    }[];

  const chapter = open("chapter", { id: "application" });
  await until(() => chapter.data.chapter, "chapter load");
  for (const id of ["derivative", "indefinite", "definite", "ode"]) {
    await chapter.hideChapter(id);
    assert.equal(chapter.data.fail, "");
  }

  const page = open("point", { id: "application-taylor-limit" });
  await until(() => page.data.point, "point load");
  // 这题有问题 before any answer: no answer is sent.
  await page.report("unclear");
  assert.equal(page.data.fail, "");
  assert.deepEqual(reports(), [
    {
      point_id: "application-taylor-limit",
      reason: "unclear",
      answer: null,
      verdict: null,
    },
  ]);

  // Right the first time: a wrong answer shows the solution and would make
  // the point practice for today.
  assert.equal(page.data.book, null);
  assert.equal(page.data.bookOpen, false);
  typeIn(page, "-1/12");
  await page.submit();
  const r = page.data.result;
  assert.equal(r.tone, "good");
  // The book rises with 中值与应用: the full-screen card shows, not the sheet.
  assert.equal(page.data.bookOpen, true);
  assert.equal(page.data.sheetOpen, false);
  const book = page.data.book;
  assert.equal(book.rank, "重点段");
  assert.equal(book.stamp, "key");
  assert.equal(book.title, "高数上 全书 升到 重点段");
  assert.equal(book.line, "每一章的重点也大部分做对过。");
  assert.deepEqual(
    book.chapters.map((c: any) => [c.short, c.rank, c.stamp]),
    [
      ["极限", "重点段", "key"],
      ["中值与应用", "重点段", "key"],
    ],
  );
  // 好 goes back to the result; its chapter row still opens the chapter sheet.
  page.closeBook();
  assert.equal(page.data.bookOpen, false);
  // The result's 全书 row opens the book card again.
  page.openBook();
  assert.equal(page.data.bookOpen, true);
  page.closeBook();
  assert.equal(r.rank.text, "中值与应用 升到重点段");
  page.openSheet();
  assert.equal(page.data.sheetOpen, true);
  assert.equal(page.data.sheet.title, "中值与应用 升到 重点段");
  assert.equal(page.data.sheet.next.gap, "还差 4 个难点");
  assert.equal(page.data.sheet.next.note, "");
  page.goMap();
  assert.deepEqual(nav.at(-1), { kind: "navigateTo", url: "/pages/map/index" });
  // Leaving closes both, so coming back to this page shows the result.
  assert.equal(page.data.sheetOpen, false);
  assert.equal(page.data.bookOpen, false);
  page.setData({ bookOpen: true });
  page.openChapter();
  assert.deepEqual(nav.at(-1), {
    kind: "navigateTo",
    url: "/pages/chapter/index?id=application",
  });
  assert.equal(page.data.bookOpen, false);
  page.openSheet();
  page.goLearn();
  assert.equal(page.data.sheetOpen, false);

  // 这题有问题 after answering sends the last answer submitted on this page.
  page.openReport(); // showActionSheet picks 我的答案是对的，判错了 in this stub.
  await until(
    () => reports().length === 2 && !page.data.reporting,
    "report by sheet",
  );
  await page.report("problem");
  assert.deepEqual(reports().slice(1), [
    {
      point_id: "application-taylor-limit",
      reason: "judge",
      answer: "-1/12",
      verdict: "correct",
    },
    {
      point_id: "application-taylor-limit",
      reason: "problem",
      answer: "-1/12",
      verdict: "correct",
    },
  ]);
  assert.equal(page.data.fail, "");

  // Keep the unavailable-content fallback covered with an explicit fixture.
  const unavailable = PROBLEMS["limit-epsilon-n"]!;
  delete PROBLEMS["limit-epsilon-n"];
  t.after(() => {
    PROBLEMS["limit-epsilon-n"] = unavailable;
  });
  const none = open("point", { id: "limit-epsilon-n" });
  await until(() => none.data.point, "no problem load");
  assert.equal(none.data.point.problem, null);
  const toasts: string[] = [];
  (globalThis as any).wx.showToast = (o: { title: string }) =>
    toasts.push(o.title);
  await none.report("other");
  // The link is at the bottom: a toast, not the answer box's line.
  assert.deepEqual(toasts, ["题还在出，稍等"]);
  assert.equal(none.data.fail, "");
  assert.equal(reports().length, 3);
  await app.close();
});

test("ranks page: every number is the rule number in summary.ts", () => {
  mountWx(makeApp(fakeServices(), {}, undefined, new SqliteStore(":memory:")));
  require(`${ROOT}utils/auth.js`).recordConsent();
  const page = open("ranks");
  const d = page.data;
  assert.deepEqual(
    d.ranks.map((r: any) => r.rank),
    ["起步", "基础段", "重点段", "难点段"],
  );
  assert.ok(d.ranks.every((r: any) => r.line));
  for (const { tier, xp } of d.xp)
    assert.equal(xp, TIER_XP[tier as keyof typeof TIER_XP]);
  assert.equal(d.xp.length, 4);
  for (const { n, need: k } of [...d.sample, ...d.example])
    assert.equal(k, need(n));
  assert.deepEqual(
    d.sample.map((x: any) => x.n),
    [6, 3],
  );
  // 中值与应用's ranked tiers have 6, 6 and 5 points.
  const application = CALC_MAP.chapters.find((c) => c.id === "application")!;
  assert.deepEqual(
    d.example.map((x: any) => [x.tier, x.n]),
    ["基础", "重点", "难点"].map((t) => [
      t,
      application.points.filter((p) => p.tier === t).length,
    ]),
  );
  assert.deepEqual(
    d.levels.map((l: any) => l.level),
    [2, 5, 10, 15, 20],
  );
  for (const { level, xp } of d.levels) {
    assert.equal(xp, LEVEL_DIVISOR * (level - 1) ** 2);
    assert.equal(levelOf(xp).level, level);
    assert.equal(levelOf(xp - 1).level, level - 1);
  }
  const points = CALC_MAP.chapters.flatMap((c) => c.points);
  const total = points.reduce((n, p) => n + TIER_XP[p.tier], 0);
  assert.equal(d.total, total);
  assert.equal(d.total, 1590);
  assert.equal(d.maxLevel, levelOf(total).level);
  assert.equal(d.maxLevel, 20);
  assert.equal(d.points, points.length);
  assert.equal(d.dueDays, REVIEW_INTERVALS[0]);
  assert.equal(d.reviewDays, REVIEW_INTERVALS[1]);
  assert.equal(d.finalReviewDays, REVIEW_INTERVALS[2]);
  const ranksCopy = readFileSync(`${ROOT}pages/ranks/index.wxml`, "utf8")
    .replaceAll("{{dueDays}}", String(d.dueDays))
    .replaceAll("{{reviewDays}}", String(d.reviewDays))
    .replaceAll("{{finalReviewDays}}", String(d.finalReviewDays));
  assert.ok(
    ranksCopy.includes(
      "回头看看时做对，格子亮回来，但不再加经验。下次是 21 天后，再下次是 63 天后；63 天那次也做对，之后就不再提醒，想练随时能做。",
    ),
  );
  assert.ok(
    ranksCopy.includes(
      "回头看看时做错，格子保持浅色，间隔回到 7 天，明天再出一次。",
    ),
  );
  assert.ok(!ranksCopy.includes("收进错题本"));
  // The first due date is spread ±2 days by point (dueOffset), not exactly 7.
  assert.match(
    readFileSync(`${ROOT}pages/ranks/index.wxml`, "utf8"),
    /大约 \{\{dueDays\}\} 天后（按点错开，前后差一两天）/,
  );
  assert.equal(d.todayReviews, TODAY_REVIEWS);
});

test("learning map pages: without consent go to the welcome page", async () => {
  const app = makeApp(
    fakeServices(),
    {},
    undefined,
    new SqliteStore(":memory:"),
  );
  const { nav } = mountWx(app);
  for (const name of ["map", "chapter"]) {
    const before = nav.length;
    const page = open(name);
    await until(
      () =>
        nav
          .slice(before)
          .some(
            (n) => n.kind === "reLaunch" && n.url === "/pages/welcome/index",
          ),
      `${name} to welcome`,
    );
    assert.equal(page.data.error, "");
  }
  await app.close();
});

test("quick notes: preserve failed draft, single save, title edit after session expiry and confirmed delete", async (t) => {
  const services = fakeServices();
  services.judge.noul = 0;
  const app = makeApp(services, {}, undefined, new SqliteStore(":memory:"));
  t.after(() => app.close());
  const { nav } = mountWx(app);
  const learn = open("learn");
  // v4: no consent sends the learn tab to the welcome page (gate.check).
  assert.ok(nav.some((n) => n.kind === "reLaunch" && n.url === "/pages/welcome/index"));
  agree(learn);
  await until(() => learn.data.card, "new consent entry");
  const list = open("notes");
  await until(() => !list.data.loading, "notes loaded");
  const original = "  我卡在换元这一步\n\n$u = x^2$，先记下来。  ";
  list.onText(input(original));
  const wx = (globalThis as any).wx;
  const send = wx.request;
  let fail = true;
  let posts = 0;
  wx.request = (o: any) => {
    if (o.method === "POST" && o.url.endsWith("/v1/cards")) {
      posts++;
      if (fail) {
        o.fail({ errMsg: "request:fail" });
        return;
      }
    }
    send(o);
  };
  await list.save();
  assert.equal(list.data.text, original);
  assert.ok(list.data.error);
  assert.equal(list.data.recent.length, 0);
  assert.equal(list.data.saving, false, "failed save releases the submit lock");
  fail = false;
  const saved = list.save();
  list.save();
  await saved;
  assert.equal(posts, 2, "failed request plus exactly one successful request");
  assert.ok(list.data.savedCard, list.data.error || "card was not saved");
  assert.equal(list.data.text, "");
  const id = list.data.savedCard.id;
  const card = open("card", { id });
  await until(() => card.data.card, "card detail");
  assert.equal(card.data.card.quote, original.trim());
  card.openEditor();
  card.editInput({ ...tap({ key: "title" }), ...input("   我的换元卡点   ") });
  const session = require(`${ROOT}utils/session.js`);
  const expired = session.getSession();
  session.setSession({ ...expired, expiresAt: "2000-01-01T00:00:00Z" });
  await card.saveEdit();
  assert.equal(card.data.card.title, "我的换元卡点");
  assert.equal(card.data.edit, false);
  assert.equal(card.data.card.quote, original.trim());
  card.openEditor();
  card.editInput({ ...tap({ key: "title" }), ...input("断网时保留这个标题") });
  session.setSession({
    ...session.getSession(),
    expiresAt: "2000-01-01T00:00:00Z",
  });
  wx.request = (o: any) => o.fail({ errMsg: "request:fail" });
  await card.saveEdit();
  // The expired session cannot safely attribute the network failure to the old
  // owner, so it leaves the editor and its draft intact without writing stale UI.
  assert.equal(card.data.error, "");
  assert.equal(card.data.editor.title, "断网时保留这个标题");
  assert.equal(card.data.edit, true);
  wx.request = send;
  card.cancelEdit();
  card.onShow();
  await until(() => card.data.card && !card.data.loading, "card relogin");
  wx.showModal = (o: any) => {
    o.success({ confirm: false });
    o.complete?.();
  };
  card.remove();
  await list.load(true);
  assert.equal(list.data.recent.length, 1, "cancel keeps the card");
  session.setSession({
    ...session.getSession(),
    expiresAt: "2000-01-01T00:00:00Z",
  });
  wx.showModal = (o: any) => {
    o.success({ confirm: true });
    o.complete?.();
  };
  card.remove();
  await until(() => !card.data.busy, "confirmed deletion");
  assert.deepEqual(nav.at(-1), {
    kind: "navigateBack",
  });
  await list.load(true);
  assert.equal(list.data.recent.length, 0);
});

test("quick notes: pagination and an older refresh cannot overwrite a newer list", async (t) => {
  const services = fakeServices();
  services.judge.noul = 0;
  const app = makeApp(services, {}, undefined, new SqliteStore(":memory:"));
  t.after(() => app.close());
  mountWx(app);
  const learn = open("learn");
  agree(learn);
  await until(() => learn.data.card, "login");
  const api = require(`${ROOT}utils/api.js`);
  for (let i = 0; i < 53; i++)
    await api.post("/v1/cards", { text: `纸条 ${i}` });
  const list = open("deck");
  await until(() => !list.data.loading, "first page");
  assert.equal(list.data.cards.length, 40);
  assert.ok(list.data.cursor);
  await list.more();
  assert.equal(list.data.cards.length, 53);
  assert.equal(new Set(list.data.cards.map((x: any) => x.id)).size, 53);
  assert.equal(list.data.cursor, "");
  const wx = (globalThis as any).wx;
  const send = wx.request;
  let release: (() => void) | undefined;
  let hold = true;
  wx.request = (o: any) => {
    if (hold && o.method === "GET" && o.url.includes("/v1/cards?")) {
      hold = false;
      send({
        ...o,
        success: (result: any) => {
          release = () => o.success(result);
        },
      });
    } else send(o);
  };
  const old = list.load(true);
  await until(() => release, "held old list");
  const newest = await api.post("/v1/cards", { text: "新的想法" });
  await list.load(true);
  assert.equal(list.data.cards[0].id, newest.card.id);
  release!();
  await old;
  assert.equal(list.data.cards[0].id, newest.card.id);
  assert.equal(list.data.loading, false);
});

test("learning tab: revoked consent invalidates a pending map response", async (t) => {
  const app = makeApp(
    fakeServices(),
    {},
    undefined,
    new SqliteStore(":memory:"),
  );
  t.after(() => app.close());
  mountWx(app);
  const learn = open("learn");
  agree(learn);
  await until(() => learn.data.card, "login");
  const wx = (globalThis as any).wx;
  const send = wx.request;
  let release: (() => void) | undefined;
  wx.request = (o: any) => {
    if (o.url.endsWith("/v1/learn/map"))
      send({
        ...o,
        success: (result: any) => {
          release = () => o.success(result);
        },
      });
    else send(o);
  };
  const pending = learn.load();
  await until(() => release, "map held");
  learn.onHide();
  require(`${ROOT}utils/auth.js`).clearConsent();
  learn.onShow();
  release!();
  await pending;
  assert.equal(learn.data.card, null);
  assert.equal(learn.data.loading, false);
});

test("learning tab: a stale server session refreshes under the current owner without a stuck loader", async (t) => {
  const app = makeApp(
    fakeServices(),
    {},
    undefined,
    new SqliteStore(":memory:"),
  );
  t.after(() => app.close());
  mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`);
  auth.recordConsent();
  require(`${ROOT}utils/session.js`).setSession({
    token: "old-server-session",
    user: { id: "old-user", nickname: "旧账号" },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const learn = open("learn");
  await until(() => learn.data.card && !learn.data.loading, "fresh owner map");
  assert.notEqual(auth.getUser().id, "old-user");
  assert.equal(learn.owner, auth.getUser().id);
  assert.equal(learn.data.error, "");
});

test("multi point: partial verdict, hint, confirmed explanation, snapshot report and next-day lighting", async (t) => {
  let now = new Date();
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, () => now, store);
  t.after(() => app.close());
  mountWx(app);
  const learn = open("learn");
  agree(learn);
  await until(() => learn.data.card, "login");
  // A bank multi: every blank a number on the pad.
  const page = open("point", { id: "limit-one-sided" });
  await until(() => page.data.point && !page.data.loading, "multi point");
  const problem = BANK[page.id]![page.data.point.problem.index]!;
  assert.equal(problem.kind, "multi");
  if (problem.kind !== "multi") throw new Error("multi fixture");
  assert.equal(page.data.point.problem.kindText, "多空题");
  assert.deepEqual(
    page.data.point.problem.blanks.map((b: any) => b.label),
    problem.parts.map((part) => part.label),
  );
  const answers = problem.parts.map((part) => part.answer);
  assert.deepEqual(page.data.answers, ["", ""]);
  typeIn(page, answers[0]!, "");
  assert.equal(page.data.canSubmit, false);
  typeIn(page, answers[0]!, "4/0");
  await page.submit();
  assert.equal(page.data.result.tone, "unsure");
  assert.deepEqual(
    page.data.result.items.map((x: any) => x.tone),
    ["good", "unsure"],
  );
  assert.ok(page.data.result.items.every((x: any) => !x.standard));
  assert.equal(page.data.done, false);
  page.showHint();
  await until(() => page.data.hint && !page.data.helpBusy, "hint");
  assert.ok(page.data.hint.length);
  assert.equal(page.data.point.practice, true);
  const wx = (globalThis as any).wx;
  wx.showModal = (o: any) => {
    o.success({ confirm: false });
    o.complete?.();
  };
  page.showExplanation();
  assert.equal(page.data.explanation, null);
  wx.showModal = (o: any) => {
    o.success({ confirm: true });
    o.complete?.();
  };
  page.showExplanation();
  await until(
    () => page.data.explanation && !page.data.helpBusy,
    "explanation",
  );
  assert.equal(page.data.point.practice, true);
  typeIn(page, ...answers);
  await page.submit();
  assert.equal(page.data.result.tone, "good");
  assert.match(page.data.result.text, /今天只算练习/);
  assert.equal(page.data.correct, false);
  assert.equal(page.data.result.xp, 0);
  assert.ok(page.data.result.solution.answer.length);
  page.data.answers[0] = "unsubmitted edit";
  await page.report("judge");
  const report = store.db
    .prepare(
      "SELECT answer_json,problem_index FROM map_reports WHERE point_id=?",
    )
    .get(page.id)!;
  assert.deepEqual(JSON.parse(report.answer_json as string), answers);
  assert.equal(report.problem_index, 0);
  now = new Date(now.getTime() + 86400000);
  await page.load();
  assert.equal(page.data.point.practice, false);
  assert.equal(page.data.done, false);
  assert.equal(page.data.explanation, null);
  assert.deepEqual(page.data.answers, ["", ""]);
  if (page.data.point.retestMode)
    page.choosePrediction(tap({ prediction: "yes" }));
  answerRight(page, page.id, page.data.point.problem.index);
  await page.submit();
  assert.equal(page.data.correct, true);
  assert.equal(page.data.result.xp, 10);
});

test("choice point: every question required, one wrong day stays practice, next day can light", async (t) => {
  let now = new Date();
  const app = makeApp(
    fakeServices(),
    {},
    () => now,
    new SqliteStore(":memory:"),
  );
  t.after(() => app.close());
  mountWx(app);
  const learn = open("learn");
  agree(learn);
  await until(() => learn.data.card, "login");
  const page = open("point", { id: "limit-order" });
  await until(() => page.data.point && !page.data.loading, "choice point");
  const problem = BANK[page.id]![0]!;
  if (problem.kind !== "choice") throw new Error("choice fixture");
  const select = (question: number, id: string) =>
    page.chooseOption(tap({ question, id }));
  select(0, "not-an-option");
  assert.equal(page.data.canSubmit, false);
  select(0, problem.questions[0]!.answer);
  assert.equal(page.data.canSubmit, false);
  problem.questions.forEach((q, i) =>
    select(
      i,
      i === 1 ? q.options.find((o) => o.id !== q.answer)!.id : q.answer,
    ),
  );
  assert.equal(page.data.canSubmit, true);
  await page.submit();
  assert.equal(page.data.result.tone, "bad");
  assert.equal(page.data.point.practice, true);
  assert.ok(
    page.data.result.items.every((item: any) => item.standard === null),
  );
  // Settled with the right options shown : no changing the answer,
  // and no part says 可以再试.
  assert.equal(page.data.done, true);
  assert.ok(
    page.data.result.items.every((item: any) => !/可以再试/.test(item.text)),
  );
  assert.ok(page.data.result.items.some((item: any) => item.text === "不对"));
  assert.deepEqual(
    page.data.result.solution.options,
    problem.questions.map((q) => q.answer),
  );
  const picked = page.data.answers.slice();
  select(1, problem.questions[1]!.answer);
  assert.deepEqual(page.data.answers, picked);
  // 下一题, right the same day: practice only.
  await page.nextProblem();
  assert.equal(page.data.point.problem.index, 1);
  answerRight(page, page.id, 1);
  await page.submit();
  assert.equal(page.data.result.tone, "good");
  assert.equal(page.data.correct, false);
  assert.equal(page.data.result.xp, 0);
  assert.match(page.data.result.text, /今天只算练习/);
  assert.doesNotMatch(page.data.result.text, /看过解析/);
  now = new Date(now.getTime() + 86400000);
  await page.load();
  assert.equal(page.data.done, false);
  assert.equal(page.data.point.practice, false);
  if (page.data.point.retestMode)
    page.choosePrediction(tap({ prediction: "yes" }));
  answerRight(page, page.id, page.data.point.problem.index);
  await page.submit();
  assert.equal(page.data.correct, true);
  assert.ok(page.data.result.xp > 0);
});

// V4.1 G4 : the pad types numbers only, so a multi whose blanks are
// expressions in t (authored) comes as single choice; nothing is typed.
test("expression multi in t comes as choice on the point page", async (t) => {
  const app = makeApp(
    fakeServices(),
    {},
    undefined,
    new SqliteStore(":memory:"),
  );
  t.after(() => app.close());
  mountWx(app);
  const learn = open("learn");
  agree(learn);
  await until(() => learn.data.card, "login");
  assert.equal(PROBLEMS["ode-system"]![0]!.kind, "multi");
  const page = open("point", { id: "ode-system" });
  await until(() => page.data.point && !page.data.loading, "system point");
  const shown = page.data.point.problem;
  assert.equal(shown.format, "choice");
  assert.deepEqual(shown.blanks, []);
  answerRight(page, page.id, shown.index);
  await page.submit();
  assert.equal(page.data.result.tone, "good");
});

test("S10 notes: two-stage organize, confirmed drafts, three groups, manual edits and explicit association", async (t) => {
  const services = fakeServices();
  const store = new SqliteStore(":memory:");
  const app = makeApp(services, {}, undefined, store);
  t.after(() => app.close());
  const { appState } = mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`);
  const api = require(`${ROOT}utils/api.js`);
  auth.recordConsent();
  await auth.login();
  const point = open("point", { id: "limit-rules" });
  await until(() => point.data.point && !point.data.loading, "context point");
  point.rememberStuck();
  assert.deepEqual(appState.globalData.noteContext, {
    pointId: "limit-rules",
    name: point.data.point.name,
  });
  await until(
    () =>
      store.db
        .prepare("SELECT seen_at FROM map_points WHERE point_id='limit-rules'")
        .get()?.seen_at,
    "point seen committed",
  );
  const before = (await api.get("/v1/learn/map")).summary;
  const list = open("notes");
  await until(
    () => !list.data.loading && list.data.context,
    "context consumed",
  );
  assert.equal(appState.globalData.noteContext, null);
  assert.equal(list.data.text, "");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n, 0);
  const original =
    "  想复习高数\n<view>原话不是页面标签</view>，还没决定从哪里开始。  ";
  const saved = await api.post("/v1/notes", { text: original });
  const query = {
    id: saved.id,
    organize: "1",
    pointId: "limit-rules",
    pointName: point.data.point.name,
  };
  appState.globalData.noteOrganize = saved.id;
  const page = open("note", query);
  t.after(() => page.onUnload());
  await until(
    () => page.data.note?.result && !page.data.loading && !page.data.busy,
    "organized note",
  );
  assert.equal(page.data.note.text, original);
  assert.deepEqual(
    page.data.groups.map((group: any) => [group.id, group.items.length]),
    [
      ["clear", 1],
      ["decide", 1],
      ["verify", 1],
    ],
  );
  assert.equal(page.data.note.pointId, null);
  assert.equal(
    services.llm.filter((call) => call.kind === "note_organize").length,
    1,
  );
  const wx = (globalThis as any).wx;
  wx.showModal = (o: any) => o.success({ confirm: false });
  page.linkPoint();
  assert.equal((await api.get(`/v1/notes/${page.id}`)).pointId, null);
  wx.showModal = (o: any) => o.success({ confirm: true });
  page.linkPoint();
  await until(
    () => page.data.note.pointId === "limit-rules" && !page.data.busy,
    "confirmed association",
  );
  assert.deepEqual((await api.get("/v1/learn/map")).summary, before);
  const option = page.data.note.result.question.options[0];
  page.chooseAnswer(tap({ id: option.id }));
  assert.match(page.data.supplement, /我的选择/);
  assert.equal(page.data.note.supplements.length, 0);
  await page.saveSupplement();
  assert.equal(page.data.note.supplements.length, 1);
  assert.equal(page.data.note.resultStale, true);
  assert.equal(
    services.llm.length,
    1,
    "saving a selected draft never calls AI",
  );
  const item = page.data.note.result.items[0];
  page.editItem(tap({ id: item.id }));
  page.onItemText(input("我自己改过的事项"));
  page.onItemGroup(input("1"));
  await page.saveItem();
  assert.equal(
    page.data.note.result.items.find((entry: any) => entry.id === item.id)
      .edited,
    true,
  );
  assert.equal(page.data.groups[1].items.length, 2);
  page.removeItem(tap({ id: item.id }));
  await until(
    () => page.data.note.result.items.length === 2 && !page.data.busy,
    "delete one item",
  );
  assert.equal(page.data.note.text, original);
  assert.equal(services.llm.length, 1);
  page.edit();
  page.onTitle(input("我起的标题"));
  await page.saveTitle();
  wx.showModal = (o: any) => o.success({ confirm: false });
  page.refresh();
  assert.equal(services.llm.length, 1);
  wx.showModal = (o: any) => {
    assert.match(o.content, /换掉现在这份/);
    o.success({ confirm: true });
  };
  page.refresh();
  await until(
    () =>
      page.data.note.result.items.length === 3 &&
      !page.data.note.resultStale &&
      !page.data.busy &&
      !page.data.loading,
    "confirmed replacement",
  );
  assert.equal(page.data.note.title, "我起的标题");
  assert.equal(page.data.note.pointId, "limit-rules");
  assert.equal(page.data.note.supplements.length, 1);
  assert.equal(page.data.note.text, original);
  await until(() => page.data.usage?.used === 2, "note allowance");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n, 1);
});

test("S10 notes: organize=1 from another mini program, without the in-app mark, organizes nothing", async (t) => {
  const services = fakeServices();
  const store = new SqliteStore(":memory:");
  const app = makeApp(services, {}, undefined, store);
  t.after(() => app.close());
  mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`);
  auth.recordConsent();
  await auth.login();
  const wx = (globalThis as any).wx,
    send = wx.request;
  let organizes = 0;
  wx.request = (o: any) => {
    if (o.method === "POST" && o.url.endsWith("/organize")) organizes++;
    send(o);
  };
  const api = require(`${ROOT}utils/api.js`);
  const saved = await api.post("/v1/notes", { text: "别人家的链接不能替我整理" });
  const page = open("note", { id: saved.id, organize: "1" });
  t.after(() => page.onUnload());
  await until(() => page.data.note && !page.data.loading, "note shown");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(organizes, 0);
  assert.equal(page.data.note.text, "别人家的链接不能替我整理");
});

test("S10 notes: organize transport failure preserves one saved note and retry uses the same ID", async (t) => {
  const services = fakeServices();
  const store = new SqliteStore(":memory:");
  const app = makeApp(services, {}, undefined, store);
  t.after(() => app.close());
  mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`);
  auth.recordConsent();
  await auth.login();
  const wx = (globalThis as any).wx,
    send = wx.request;
  let fail = true,
    creates = 0;
  wx.request = (o: any) => {
    if (o.method === "POST" && o.url.endsWith("/v1/notes")) creates++;
    if (fail && o.method === "POST" && o.url.endsWith("/organize"))
      return o.fail({ errMsg: "synthetic network failure" });
    send(o);
  };
  const api = require(`${ROOT}utils/api.js`);
  const saved = await api.post("/v1/notes", { text: "先留下这句原话" });
  (globalThis as any).getApp().globalData.noteOrganize = saved.id;
  const page = open("note", { id: saved.id, organize: "1" });
  t.after(() => page.onUnload());
  await until(() => page.data.error && !page.data.busy, "organize failed");
  assert.match(page.data.error, /原话存好了/);
  assert.equal(page.data.note.text, "先留下这句原话");
  assert.equal(creates, 1);
  fail = false;
  await page.organize();
  await until(
    () => page.data.note.result && !page.data.loading,
    "retry organized",
  );
  assert.equal(creates, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n, 1);
  assert.equal(services.llm.length, 1);
});

test("S10 notes: supplement conflict keeps draft and a lost acknowledgement retries idempotently", async (t) => {
  const app = makeApp(fakeServices());
  t.after(() => app.close());
  mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`),
    api = require(`${ROOT}utils/api.js`);
  auth.recordConsent();
  await auth.login();
  const saved = await api.post("/v1/notes", { text: "需要补充的原话" });
  const page = open("note", { id: saved.id });
  t.after(() => page.onUnload());
  await until(() => page.data.note && !page.data.loading, "detail");
  page.onSupplement(input("本页尚未保存的草稿"));
  await api.post(`/v1/notes/${saved.id}/supplements`, {
    revision: saved.revision,
    clientId: "other-view-supplement-01",
    text: "另一处新增的补充",
  });
  await page.saveSupplement();
  assert.equal(page.data.conflict, true);
  assert.equal(page.data.supplement, "本页尚未保存的草稿");
  assert.match(page.data.supplementError, /新内容/);
  await page.load();
  assert.equal(page.data.conflict, false);
  const wx = (globalThis as any).wx,
    send = wx.request;
  let lose = true;
  wx.request = (o: any) => {
    if (lose && o.method === "POST" && o.url.endsWith("/supplements")) {
      lose = false;
      return send({
        ...o,
        success: () => o.fail({ errMsg: "synthetic lost acknowledgement" }),
      });
    }
    send(o);
  };
  await page.saveSupplement();
  assert.equal(page.data.supplement, "本页尚未保存的草稿");
  assert.ok(page.data.supplementError);
  await page.load();
  await page.saveSupplement();
  assert.equal(page.data.note.supplements.length, 2);
  assert.equal(page.data.supplement, "");
  assert.equal(page.data.note.supplements[1].text, "本页尚未保存的草稿");
});

test("S10 notes: unknown organizing waits for explicit confirmation before consuming another allowance", async (t) => {
  const services = fakeServices(),
    real = services.fetcher;
  let fail = true;
  services.fetcher = (async (url, init) => {
    if (fail) throw new Error("synthetic interrupted model response");
    return real(url, init);
  }) as typeof fetch;
  const app = makeApp(services);
  t.after(() => app.close());
  mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`),
    api = require(`${ROOT}utils/api.js`);
  auth.recordConsent();
  await auth.login();
  const saved = await api.post("/v1/notes", { text: "想理清楚复习顺序" });
  (globalThis as any).getApp().globalData.noteOrganize = saved.id;
  const page = open("note", { id: saved.id, organize: "1" });
  t.after(() => page.onUnload());
  await until(
    () =>
      page.data.note?.aiJob?.status === "unknown" &&
      !page.data.loading &&
      !page.data.busy,
    "unknown result",
  );
  assert.match(page.data.jobText, /没理完/);
  // an unknown job is not charged; only the confirmed retry that succeeds counts.
  assert.equal((await api.get("/v1/me/usage")).notes.used, 0);
  page.onHide();
  await page.onShow();
  assert.equal(
    (await api.get("/v1/me/usage")).notes.used,
    0,
    "returning to detail never retries unknown automatically",
  );
  const wx = (globalThis as any).wx;
  wx.showModal = (o: any) => {
    assert.match(o.content, /1 次/);
    o.success({ confirm: false });
  };
  page.retryOrganize();
  assert.equal((await api.get("/v1/me/usage")).notes.used, 0);
  fail = false;
  wx.showModal = (o: any) => o.success({ confirm: true });
  page.retryOrganize();
  await until(
    () => page.data.note.result && !page.data.loading && !page.data.busy,
    "explicit retry completed",
  );
  assert.equal((await api.get("/v1/me/usage")).notes.used, 1);
});

test("S10 notes: hidden polling stops, returning reloads, and another identity cannot receive a stale detail", async (t) => {
  const services = fakeServices(),
    real = services.fetcher;
  let releaseModel = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  services.fetcher = (async (url, init) => {
    await gate;
    return real(url, init);
  }) as typeof fetch;
  const app = makeApp(services);
  let page: any;
  t.after(async () => {
    releaseModel();
    page?.onUnload();
    await app.close();
  });
  mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`),
    api = require(`${ROOT}utils/api.js`),
    session = require(`${ROOT}utils/session.js`);
  auth.recordConsent();
  await auth.login();
  const saved = await api.post("/v1/notes", { text: "只属于这个账号的想法" });
  const wx = (globalThis as any).wx,
    send = wx.request;
  let releasePoll: (() => void) | undefined,
    polls = 0;
  wx.request = (o: any) => {
    if (o.url.includes("/v1/jobs/")) {
      polls++;
      return send({
        ...o,
        success: (result: any) => {
          releasePoll = () => o.success(result);
        },
      });
    }
    send(o);
  };
  (globalThis as any).getApp().globalData.noteOrganize = saved.id;
  page = open("note", { id: saved.id, organize: "1" });
  await until(() => releasePoll, "poll pending");
  page.onHide();
  const hidden = structuredClone(page.data);
  releasePoll!();
  releaseModel();
  await new Promise((resolve) => realSetTimeout(resolve, 30));
  assert.equal(polls, 1);
  assert.deepEqual(page.data, hidden, "hidden response never updates the page");
  wx.request = send;
  await page.onShow();
  await until(
    () => page.data.note.result && !page.data.loading,
    "returning result",
  );
  page.onSupplement(input("还没提交的私人草稿"));
  let releaseDetail: (() => void) | undefined;
  wx.request = (o: any) => {
    if (o.url.endsWith(`/v1/notes/${saved.id}`))
      return send({
        ...o,
        success: (result: any) => {
          releaseDetail = () => o.success(result);
        },
      });
    send(o);
  };
  const stale = page.load();
  await until(() => releaseDetail, "detail held");
  const other = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key: "second-owner" },
    })
  ).json().data;
  session.setSession(other);
  releaseDetail!();
  await stale;
  assert.equal(page.data.note, null);
  assert.equal(page.data.supplement, "");
  assert.equal(page.data.context, null);
  assert.equal(page.data.linkedPoint, null);
  assert.match(page.data.error, /换了账号/);
});

test("U4 learning space: continue last visible point, cancel context without saving, and erase or revoke local pointers", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const { storage, appState } = mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`),
    api = require(`${ROOT}utils/api.js`),
    space = require(`${ROOT}utils/learning-space.js`);
  auth.recordConsent();
  await auth.login();
  const userId = auth.getUser().id;
  const point = open("point", { id: "limit-rules" });
  await until(() => point.data.point && !point.data.loading, "point loaded");
  assert.equal(
    (storage.get(`zhiye_last_point:${userId}`) as any).pointId,
    "limit-rules",
  );
  const learn = open("learn");
  await until(() => learn.data.card && !learn.data.loading, "learning space");
  assert.equal(learn.data.card.continuation.label, "继续上次");
  assert.equal(learn.data.card.continuation.id, "limit-rules");
  await api.post("/v1/learn/marks", { action: "hide", chapterId: "limit" });
  await learn.load();
  assert.notEqual(learn.data.card.continuation.id, "limit-rules");
  assert.notEqual(learn.data.card.continuation.label, "继续上次");
  point.rememberStuck();
  const list = open("notes");
  await until(
    () => list.data.context && !list.data.loading,
    "quick note context",
  );
  list.clearContext();
  list.onHide();
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notes").get()?.n, 0);
  assert.equal(appState.globalData.noteContext, null);
  const privacy = open("privacy");
  privacy.revoke();
  await until(() => !privacy.data.canRevoke, "revoked");
  assert.equal(storage.has(`zhiye_last_point:${userId}`), false);
  auth.recordConsent();
  await auth.login();
  space.remember(userId, "limit-rules");
  appState.globalData.noteContext = {
    pointId: "limit-rules",
    name: "极限运算",
  };
  const profile = open("profile");
  await until(
    () => profile.data.usage.length && !profile.data.loading,
    "profile",
  );
  profile.deleteAccount();
  await until(
    () => !profile.data.busy && !profile.data.usage.length,
    "account erased",
  );
  assert.equal(storage.has(`zhiye_last_point:${userId}`), false);
  assert.equal(appState.globalData.noteContext, undefined);
});

test("U4 point: a deferred response after identity change or revocation writes no pointer, seen mark or page data", async (t) => {
  for (const change of ["identity", "consent"] as const) {
    await t.test(change, async (t) => {
      const store = new SqliteStore(":memory:");
      const app = makeApp(fakeServices(), {}, undefined, store);
      t.after(() => app.close());
      const { storage } = mountWx(app);
      const auth = require(`${ROOT}utils/auth.js`),
        session = require(`${ROOT}utils/session.js`);
      auth.recordConsent();
      await auth.login();
      const wx = (globalThis as any).wx,
        send = wx.request;
      let release: (() => void) | undefined,
        marks = 0;
      wx.request = (o: any) => {
        if (o.method === "POST" && o.url.endsWith("/learn/marks")) marks++;
        if (o.url.includes("/learn/points/limit-rules?"))
          return send({
            ...o,
            success: (result: any) => {
              release = () => o.success(result);
            },
          });
        send(o);
      };
      const point = open("point", { id: "limit-rules" });
      t.after(() => point.onUnload());
      await until(() => release, "deferred point response");
      const pending = point.loadRequest;
      if (change === "identity") {
        const other = (
          await app.inject({
            method: "POST",
            url: "/v1/auth/dev-login",
            payload: { key: "second-owner" },
          })
        ).json().data;
        session.setSession(other);
      } else auth.clearConsent();
      release!();
      await pending;
      assert.equal(point.data.point, null);
      assert.equal(marks, 0);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM map_points").get()?.n,
        0,
      );
      assert.equal(
        [...storage.keys()].some((key) => key.startsWith("zhiye_last_point:")),
        false,
      );
    });
  }
});

test("S11 tool pages: actual point associations navigate without lighting; missing or unrelated points fall back to map", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  const { nav } = mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`),
    api = require(`${ROOT}utils/api.js`);
  auth.recordConsent();
  await auth.login();
  const id = await collect(nav, "problem", PROBLEM);
  const practice = open("practice", { id });
  t.after(() => practice.onUnload());
  await until(
    () => practice.data.material && !practice.data.loading,
    "practice material",
  );
  practice.onText(input("50"));
  practice.submit();
  await until(
    () => practice.data.result && !practice.data.judging,
    "wrong attempt",
  );
  await until(
    () =>
      store.db
        .prepare("SELECT map_version FROM mistakes WHERE material_id=?")
        .get(id)?.map_version === 1,
    "no-match cache",
  );
  assert.equal(practice.data.mapPoint, null);
  const noJump = nav.length;
  practice.openMap();
  assert.equal(
    nav.length,
    noJump,
    "unknown wrong answer has no invented association",
  );
  // A persisted association is an explicit synthetic fixture, not a model claim.
  store.db
    .prepare(
      "UPDATE mistakes SET map_point_id='limit-rules',map_version=1 WHERE material_id=?",
    )
    .run(id);
  await practice.syncMapPoint();
  assert.equal(practice.data.mapPoint.id, "limit-rules");
  const before = (await api.get("/v1/learn/map")).summary;
  const wx = (globalThis as any).wx,
    send = wx.request;
  let mapWrites = 0;
  wx.request = (o: any) => {
    if (o.method !== "GET" && o.url.includes("/v1/learn/")) mapWrites++;
    send(o);
  };
  practice.openMap();
  assert.equal(nav.at(-1)!.url, "/pages/point/index?id=limit-rules");
  const book = open("mistakes");
  t.after(() => book.onUnload());
  await until(
    () => book.data.items.length && !book.data.loading,
    "mistake list",
  );
  assert.equal(book.data.items[0].mapPoint.id, "limit-rules");
  book.openMap(tap({ id: book.data.items[0].id }));
  assert.equal(nav.at(-1)!.url, "/pages/point/index?id=limit-rules");
  const userId = auth.getUser().id,
    now = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO threads(id,user_id,title,material_id,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "thread_s11",
      userId,
      "合成导航验收",
      id,
      JSON.stringify({ problem: PROBLEM }),
      now,
      now,
    );
  const message = (messageId: string, kind: string, data: unknown) =>
    store.db
      .prepare(
        "INSERT INTO messages(id,thread_id,user_id,role,kind,content,data,status,created_at) VALUES(?,?,?,'assistant',?,'',?,'done',?)",
      )
      .run(messageId, "thread_s11", userId, kind, JSON.stringify(data), now);
  message("judge_s11", "judge", {
    judged: { answer: "48", verdict: "correct" },
  });
  const ask = open("ask");
  t.after(() => ask.onUnload());
  await ask.open("thread_s11");
  assert.equal(ask.data.error, "");
  assert.equal(ask.data.thread.mistake.mapPoint.id, "limit-rules");
  assert.ok(ask.data.actions.some((action: any) => action.key === "map"));
  ask.openPoint();
  assert.equal(nav.at(-1)!.url, "/pages/point/index?id=limit-rules");
  ask.act(tap({ key: "map" }));
  assert.equal(nav.at(-1)!.url, "/pages/point/index?id=limit-rules");
  message("similar_s11", "similar", {
    similar: {
      question: "另一道合成同类题",
      answer: "2",
      solution: "合成解法",
      revealed: true,
    },
  });
  message("judge_similar_s11", "judge", {
    similarOf: "similar_s11",
    judged: { answer: "2", verdict: "correct" },
  });
  await ask.open("thread_s11");
  ask.openMap();
  assert.equal(
    nav.at(-1)!.url,
    "/pages/map/index",
    "ordinary similar questions never borrow the original point association",
  );
  store.db
    .prepare("UPDATE mistakes SET map_point_id=NULL WHERE material_id=?")
    .run(id);
  await book.load();
  assert.equal(book.data.items[0].mapPoint, null);
  const oldCount = nav.length;
  book.openMap(tap({ id: book.data.items[0].id }));
  assert.equal(nav.length, oldCount);
  practice.again();
  practice.onText(input("48"));
  practice.submit();
  await until(
    () => practice.data.result?.correct && !practice.data.judging,
    "correct tool retry",
  );
  await practice.syncMapPoint();
  practice.openMap();
  assert.equal(nav.at(-1)!.url, "/pages/map/index");
  assert.equal(mapWrites, 0, "navigation never sends learn marks or answers");
  const after = (await api.get("/v1/learn/map")).summary;
  assert.equal(after.xp, before.xp);
  assert.equal(after.correct, before.correct);
  assert.equal(
    store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM map_points WHERE correct_at IS NOT NULL",
      )
      .get()?.n,
    0,
  );
});

test("S10 notes: expected organize errors are readable while unexpected errors retain diagnostics", async (t) => {
  const app = makeApp(fakeServices(), { LLM_API_KEY: "" });
  t.after(() => app.close());
  mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`),
    api = require(`${ROOT}utils/api.js`);
  auth.recordConsent();
  await auth.login();
  const saved = await api.post("/v1/notes", {
    text: "先存下来，等整理可以用了再试",
  });
  (globalThis as any).getApp().globalData.noteOrganize = saved.id;
  const page = open("note", { id: saved.id, organize: "1" });
  t.after(() => page.onUnload());
  await until(() => page.data.error && !page.data.busy, "unconfigured model");
  assert.match(page.data.error, /原话存好了.*现在理不了/);
  assert.doesNotMatch(page.data.error, /请求|未配置/);
  const wx = (globalThis as any).wx,
    send = wx.request;
  let code = "DAILY_LIMIT";
  wx.request = (o: any) => {
    if (o.method === "POST" && o.url.endsWith("/organize"))
      return o.success({
        statusCode: 429,
        data: {
          code,
          message: "synthetic diagnostic",
          requestId: "synthetic-request-id",
        },
        header: {},
      });
    send(o);
  };
  await page.organize();
  // a budget message from the server is shown as it is; anything
  // else falls back to a plain one.
  assert.match(page.data.error, /额度用完了.*先写下来/);
  assert.doesNotMatch(page.data.error, /synthetic|请求/);
  code = "UNEXPECTED_NOTE_ERROR";
  await page.organize();
  assert.match(page.data.error, /synthetic diagnostic/);
  // the request id goes to the log only.
  assert.doesNotMatch(page.data.error, /synthetic-request-id/);
});

test("U4 profile: cold login binds all three deferred responses to their original identity", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  mountWx(app);
  const first = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key: "owner" },
    })
  ).json().data;
  const headers = { authorization: `Bearer ${first.token}` };
  const saved = (
    await app.inject({
      method: "POST",
      url: "/v1/notes",
      headers,
      payload: { text: "账号 A 的合成纸条" },
    })
  ).json().data;
  const job = (
    await app.inject({
      method: "POST",
      url: `/v1/notes/${saved.id}/organize`,
      headers,
      payload: {
        revision: saved.revision,
        resultVersion: saved.resultVersion,
        refresh: false,
      },
    })
  ).json().data.job;
  await until(
    () =>
      store.db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id)
        ?.status === "succeeded",
    "owner A allowance",
  );
  // A's budget is used up, so a stale A response would show 100%.
  store.db
    .prepare("UPDATE users SET quota=? WHERE id=?")
    .run(JSON.stringify({ budget: { day: 0 } }), first.user.id);
  store.db
    .prepare(
      "INSERT INTO map_points(user_id,point_id,seen_at,updated_at) VALUES(?,'limit-rules',?,?)",
    )
    .run(first.user.id, new Date().toISOString(), new Date().toISOString());
  const auth = require(`${ROOT}utils/auth.js`),
    session = require(`${ROOT}utils/session.js`);
  auth.recordConsent();
  assert.equal(session.getSession(), null);
  const wx = (globalThis as any).wx,
    send = wx.request;
  const releases: (() => void)[] = [];
  let holding = true;
  wx.request = (o: any) => {
    if (
      holding &&
      ["/v1/chat/usage", "/v1/me/usage", "/v1/learn/map"].some((url) =>
        o.url.endsWith(url),
      )
    )
      return send({
        ...o,
        success: (result: any) => {
          releases.push(() => o.success(result));
        },
      });
    send(o);
  };
  const profile = open("profile");
  t.after(() => profile.onUnload());
  await until(() => releases.length === 3, "A responses held after cold login");
  assert.equal(auth.getUser().id, first.user.id);
  const other = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key: "profile-second-owner" },
    })
  ).json().data;
  session.setSession(other);
  holding = false;
  releases.forEach((release) => release());
  await until(
    () =>
      !profile.data.loading &&
      profile.owner === other.user.id &&
      profile.data.usage.length,
    "B profile reload",
  );
  assert.equal(
    profile.data.usage.find((entry: any) => entry.k === "今天").pct,
    0,
  );
  // The chapter stickers are on 学习 now; 我的 keeps no copy of them.
  assert.equal(profile.data.stickers, undefined);
});

test("U4 learning: cold login cannot relabel a deferred A map as the newly signed-in B account", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  mountWx(app);
  const first = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key: "owner" },
    })
  ).json().data;
  const lit = await app.inject({
    method: "POST",
    url: "/v1/learn/points/limit-rules/answer",
    headers: { authorization: `Bearer ${first.token}` },
    payload: { answer: scalarAnswer("limit-rules"), index: 0 },
  });
  assert.equal(lit.json().data.counted, "lit");
  const auth = require(`${ROOT}utils/auth.js`),
    session = require(`${ROOT}utils/session.js`);
  auth.recordConsent();
  assert.equal(session.getSession(), null);
  const wx = (globalThis as any).wx,
    send = wx.request;
  let release: (() => void) | undefined,
    holding = true;
  wx.request = (o: any) => {
    if (holding && o.url.endsWith("/v1/learn/map"))
      return send({
        ...o,
        success: (result: any) => {
          release = () => o.success(result);
        },
      });
    send(o);
  };
  const page = open("learn");
  t.after(() => page.onUnload());
  await until(() => release, "A map held after cold login");
  assert.equal(auth.getUser().id, first.user.id);
  const other = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key: "learning-second-owner" },
    })
  ).json().data;
  session.setSession(other);
  holding = false;
  release!();
  await until(
    () => !page.data.loading && page.owner === other.user.id && page.data.card,
    "B learning map reload",
  );
  assert.equal(page.data.card.correctText, "0/89");
  assert.match(page.data.card.xpText, /^经验 0\//);
  assert.equal(page.data.card.level, 1);
});

test("U4 point: returning during an old load discards it and coalesces one fresh read", async (t) => {
  const store = new SqliteStore(":memory:");
  const app = makeApp(fakeServices(), {}, undefined, store);
  t.after(() => app.close());
  mountWx(app);
  const auth = require(`${ROOT}utils/auth.js`);
  auth.recordConsent();
  await auth.login();
  const wx = (globalThis as any).wx,
    send = wx.request;
  const releases: (() => void)[] = [];
  let gets = 0,
    marks = 0;
  wx.request = (o: any) => {
    if (o.method === "POST" && o.url.endsWith("/v1/learn/marks")) marks++;
    if (o.url.includes("/v1/learn/points/limit-rules?")) {
      gets++;
      return send({
        ...o,
        success: (result: any) => {
          releases.push(() => o.success(result));
        },
      });
    }
    send(o);
  };
  const page = open("point", { id: "limit-rules" });
  t.after(() => page.onUnload());
  await until(() => releases.length === 1, "first response held");
  page.onHide();
  page.onShow();
  const resumed = page.load();
  releases[0]!();
  await until(() => releases.length === 2, "one fresh response held");
  assert.equal(page.data.point, null);
  assert.equal(marks, 0);
  assert.equal(gets, 2);
  assert.equal(
    page.load(),
    page.loadRequest,
    "same visible session shares the fresh read",
  );
  releases[1]!();
  await resumed;
  assert.equal(page.data.point.id, "limit-rules");
  assert.equal(page.data.loading, false);
  assert.equal(gets, 2);
  await until(
    () =>
      store.db
        .prepare("SELECT seen_at FROM map_points WHERE point_id='limit-rules'")
        .get()?.seen_at,
    "one current seen mark",
  );
  assert.equal(marks, 1);
});
