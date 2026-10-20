// AI synthetic personas, never real users or a product-model evaluation.
// Reuses buildApp/inject and the existing notes page VM pattern. No network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";
import { PROBLEMS } from "../server/src/modules/learn/problems.js";
import { canonicalInput } from "../server/src/modules/learn/answers.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const require = createRequire(import.meta.url);
const miniRoot = fileURLToPath(new URL("../miniprogram/", import.meta.url));
const pointId = "limit-rules";
const startAt = "2026-10-12T02:00:00.000Z";
// Fixed keyword only: no generated crisis narrative or method.
const crisisFixture = "固定关键词测试：不想活";
const personas = [
  {
    id: "p1",
    name: "林禾",
    experience: "大一新生，第一次准备高数期末",
    emotion: "慌张，担心看过解析仍不会",
    goal: "先找出一道题的卡点，再独立复测",
    jot: "高数极限听过以后还不会，我想先弄清运算法则",
    life: "明天先留出一段时间整理复习顺序",
    study: "求极限时我不知道先用哪条运算法则",
    conclusion: "先把运算法则说清楚，再做一道不看提示的题",
    concern: "已记下不等于已经学会，需看到后续复测结果。",
  },
  {
    id: "p2",
    name: "周澈",
    experience: "大二学生，刚收到竞赛邀请，也有期末任务",
    emotion: "兴奋又犹豫",
    goal: "比较竞赛与复习安排，自己作决定",
    jot: "我想报名竞赛，但要先弄清准备时间会不会挤掉复习",
    life: "我想先问清竞赛安排，再决定是否报名",
    study: "求极限时想先复习运算法则，再安排练习",
    conclusion: "先核对竞赛时间，再给复习留下固定位置",
    concern: "头脑风暴草稿来自大模型，保存前仍需本人改写选择。",
  },
  {
    id: "p3",
    name: "陈遥",
    experience: "大三学生，之前复制笔记很多但回看较少",
    emotion: "平静但怀疑又会变成囤资料",
    goal: "把自编笔记拆成少量卡并验证能否用上",
    jot: "复习资料很多，我想先留下真正能解释清楚的一条",
    life: "我想把资料整理成自己能使用的一句话",
    study: "求极限时我想检查自己是否理解运算法则",
    conclusion: "先选一条笔记改写成自己的话，再独立检验",
    concern: "导入成功只证明内容收录，不证明理解或学习效果。",
  },
  {
    id: "p4",
    name: "许宁",
    experience: "高三学生，刚经历模拟考失利，希望控制记录范围",
    emotion: "低落、谨慎",
    goal: "理清安排，同时能撤回并删除心情记录",
    jot: "考试后我想重新整理计划，先确定今天能做的一件事",
    life: "我想先列出今天的一件小事，再考虑明天",
    study: "求极限时我想从运算法则的条件重新开始",
    conclusion: "先完成一件可以检查的小事，再调整下一步",
    concern: "一键删除与撤回同意是两个动作，需确认后者同时清空记录。",
    mood: true,
  },
];

function fixedServices() {
  const calls: Array<{ kind: string; messages: any[] }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions.q,
        keys = Object.keys(q.criteria ?? {});
      const text = JSON.stringify(body.state);
      const choice = keys.includes(pointId)
        ? pointId
        : keys.includes("life")
          ? /极限|高数/.test(text)
            ? "study"
            : "life"
          : keys.includes("idea")
            ? "idea"
            : keys.includes("none")
              ? "none"
              : keys[0];
      calls.push({ kind: "judge", messages: [] });
      return Response.json({
        answers: {
          q:
            q.type === "noul"
              ? { noul: 0 }
              : { choice, confidence: 0.95, probabilities: { [choice]: 0.95 } },
        },
      });
    }
    const system = String(body.messages?.[0]?.content ?? "");
    let kind: string, content: string;
    if (system.includes("[CARD_TIDY]")) {
      kind = "tidy";
      const source = JSON.parse(body.messages.at(-1).content);
      content = JSON.stringify({
        title: "先理清这件事",
        summary: "把自己的卡点记录下来",
        slots: [],
        open: [],
        followup: { q: "接下来想先做什么", options: ["补充原话", "先放一放"] },
        tags: [],
        // No fabricated quotes are used; auto tidy leaves the user's raw text intact.
      });
      assert.equal(typeof source.quote, "string");
    } else if (system.includes("[BRAINSTORM]")) {
      kind = "brainstorm";
      content = JSON.stringify({
        title: "把想法摆开",
        groups: [
          { name: "共同点", common: "先把问题说清楚", cards: [1, 2, 3] },
        ],
        tensions: [],
        more: [],
        ifs: [],
        directions: [
          { title: "先比较", why: "选中的卡都有下一步", from: [1, 2] },
        ],
        drafts: [{ text: "先比较卡里的想法，再决定下一步", from: [1, 2, 3] }],
        ask: { q: "想先看哪一张", options: ["第一张", "第二张"] },
      });
    } else if (system.includes("[IMPORT_SPLIT]")) {
      kind = "import";
      content = JSON.stringify({
        cards: [
          {
            type: "idea",
            scene: "study",
            title: "极限运算条件",
            summary: "先确认条件再运算",
            src: [1],
            open: null,
            tags: ["极限"],
          },
        ],
      });
    } else {
      assert.ok(body.stream, "Unexpected non-streaming provider request");
      kind = "guide";
      content =
        '你想先从哪一步说起？<guide>{"options":["先说卡点","先列下一步"]}</guide>';
    }
    calls.push({ kind, messages: body.messages });
    if (!body.stream)
      return Response.json({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      });
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return { calls, fetcher };
}

function mountNotes(call: any, userId: string, file = "pages/notes/index.js") {
  let definition: any;
  const nav: string[] = [],
    state: any = { globalData: {} };
  const api = {
    get: (url: string) => call("GET", url),
    post: (url: string, body: any) => call("POST", url, body),
    needsConsent: () => false,
  };
  const sandbox: any = {
      require: (name: string) =>
        name.endsWith("/api")
          ? api
          : name.endsWith("/auth")
            ? {
                getUser: () => ({ id: userId }),
                hasConsent: () => true,
                login: async () => {},
              }
            : name.endsWith("/gate")
              ? { check: () => true, state: () => "ok" }
            : name.endsWith("/chat-entry")
              ? vm.runInContext(
                  `(function (module) {${readFileSync(join(miniRoot, "utils/chat-entry.js"), "utf8")}\nreturn module.exports;})`,
                  sandbox,
                )({ exports: {} })
            : name.endsWith("/theme")
              ? { themed: (v: any) => v }
              : name.endsWith("/format")
                ? { errorText: (e: Error) => e.message }
                : require(
                    join(miniRoot, "utils", `${name.split("/").at(-1)}.js`),
                  ),
      Page: (value: any) => {
        definition = value;
      },
      getApp: () => state,
      wx: {
        navigateTo: (o: any) => nav.push(o.url),
        switchTab: (o: any) => nav.push(o.url),
        showModal() {},
        // a returning user who has seen the tour (随心记 opens it otherwise).
        getStorageSync: (key: string) => (key === "zhiye_onboarded" ? "1" : ""),
      },
      setTimeout: () => 1,
      clearTimeout() {},
    };
  vm.runInNewContext(
    readFileSync(join(miniRoot, file), "utf8"),
    sandbox,
  );
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch: any) {
      Object.assign(this.data, patch);
    },
  };
  page.onLoad();
  return { page, state, nav };
}

for (const persona of personas)
  test(`Synthetic persona ${persona.id}: ${persona.name} complete v2 journey`, async (t) => {
    const store = new SqliteStore(":memory:"),
      fake = fixedServices(),
      clock = { at: new Date(startAt) };
    const steps: any[] = [];
    let passed = false;
    const record = (
      operation: string,
      observed: any,
      confusion = "无阻断；界面像素与真实用户理解未测",
    ) =>
      steps.push({
        step: steps.length + 1,
        at: clock.at.toISOString(),
        operation,
        observed,
        confusion,
        screenshot: null,
      });
    const app = buildApp({
      store,
      fetcher: fake.fetcher,
      now: () => new Date(clock.at),
      env: loadEnv({
        NODE_ENV: "test",
        DEV_LOGIN_ENABLED: "true",
        DATABASE_PATH: ":memory:",
        LOG_LEVEL: "silent",
        UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-personas-upload-")),
        FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-personas-formula-")),
        LLM_API_KEY: "synthetic-only",
        JEV_API_KEY: "synthetic-only",
        JOB_CONCURRENCY: "1",
      }),
    });
    t.after(async () => {
      await app.close();
      const destination = process.env.PERSONA_EVIDENCE_DIR;
      if (destination) {
        mkdirSync(destination, { recursive: true });
        writeFileSync(
          join(destination, `${persona.id}.json`),
          JSON.stringify(
            {
              schema: 1,
              status: passed ? "passed" : "failed",
              executor: "synthetic-fixture",
              kind: "AI模拟测试，不是真实用户",
              productProviders:
                "in-process deterministic fetch replacement; no real model/network",
              persona,
              clock: "buildApp injected now, 2026-10-12 to 2026-10-14",
              layers: [
                "Fastify inject",
                "SQLite :memory:",
                "notes page JS VM with real API",
              ],
              unverified: [
                "full simulator journey",
                "real device",
                "pixel layout",
                "real model quality",
                "learning effect",
                "production",
              ],
              fakeCalls: fake.calls.reduce(
                (sum: any, c) => ({ ...sum, [c.kind]: (sum[c.kind] ?? 0) + 1 }),
                {},
              ),
              steps,
            },
            null,
            2,
          ) + "\n",
        );
      }
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/dev-login",
      payload: { key: `astra-persona-${persona.id}` },
    });
    assert.equal(login.statusCode, 200);
    const { token, user } = login.json().data;
    const request = (method: any, url: string, payload?: any) =>
      app.inject({
        method,
        url,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
    const call = async (method: any, url: string, payload?: any) => {
      const response = await request(method, url, payload);
      assert.equal(
        response.statusCode,
        200,
        `${method} ${url}: ${response.body}`,
      );
      return response.json().data;
    };
    const settled = async (jobId: string) => {
      for (let i = 0; i < 250; i++) {
        const job = await call("GET", `/v1/jobs/${jobId}`);
        if (!["queued", "running"].includes(job.status)) {
          assert.equal(job.status, "succeeded", JSON.stringify(job));
          return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw Error(`Job ${jobId} timed out`);
    };
    const cardReady = async (id: string) => {
      let card = await call("GET", `/v1/cards/${id}`);
      if (card.aiJob) await settled(card.aiJob.id);
      card = await call("GET", `/v1/cards/${id}`);
      return card;
    };
    const send = async (payload: any) => {
      const response = await request("POST", "/v1/chat/send", {
        mode: "auto",
        tone: "light",
        ...payload,
        clientId: `astra-${payload.clientId}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.body
        .split("\n\n")
        .filter((x) => x.startsWith("data: ") && x !== "data: [DONE]")
        .map((x) => JSON.parse(x.slice(6)));
    };

    // The real page handlers create/list a card and transfer its context to chat.
    const notes = mountNotes(call, user.id);
    await notes.page.onShow();
    notes.page.data.text = persona.jot;
    await notes.page.save();
    assert.equal(notes.page.data.saved, true, notes.page.data.error);
    assert.equal(notes.page.data.savedCard.quote, persona.jot);
    assert.equal(notes.page.data.text, "");
    const wxml = readFileSync(join(miniRoot, "pages/notes/index.wxml"), "utf8");
    assert.match(wxml, /记下了/);
    let jot = await cardReady(notes.page.data.savedCard.id);
    jot = (
      await call("POST", `/v1/cards/${jot.id}/mine`, {
        version: jot.version,
        text: persona.jot,
      })
    ).card;
    record(
      "notes VM：输入原话→记下；接口补入我的话→重新读卡",
      { visibleTemplate: "记下了", card: jot },
      persona.concern,
    );
    notes.page.chat({ currentTarget: { dataset: { saved: true } } });
    assert.deepEqual(Array.from(notes.state.globalData.chat.cardIds), [jot.id]);
    assert.equal(notes.nav.at(-1), "/pages/chat/index");
    record("notes VM：收据上的聊一聊", {
      route: notes.nav.at(-1),
      carryCardIds: Array.from(notes.state.globalData.chat.cardIds),
    });

    const collected: any[] = [];
    for (const [scene, text] of [
      ["life", persona.life],
      ["study", persona.study],
    ]) {
      const made = await call("POST", "/v1/chat/threads", {
        entry: "jot",
        text,
        cardIds: [jot.id],
        tone: "light",
      });
      assert.equal(made.thread.scene, scene);
      const events = await send({
        threadId: made.thread.id,
        text,
        clientId: `${persona.id}-${scene}`,
      });
      assert.ok(
        events.some((e) => e.e === "done"),
        JSON.stringify(events),
      );
      assert.ok(
        !events.some((e) =>
          ["error", "crisis", "scene_candidate"].includes(e.e),
        ),
        JSON.stringify(events),
      );
      const provider = fake.calls.filter((c) => c.kind === "guide").at(-1)!;
      assert.ok(
        JSON.stringify(provider.messages).includes(persona.jot),
        "carried original is in the model request",
      );
      record(
        `${scene === "life" ? "生活" : "学习"}引导：带卡并发送自己的问题`,
        { scene: made.thread.scene, events, carriedOriginalPresent: true },
      );
      const saved = await call("POST", "/v1/cards", {
        origin: "chat",
        srcId: made.thread.id,
        quote: text,
        type: "idea",
        title: scene === "life" ? "我的生活安排" : "我的学习卡点",
      });
      const card = await cardReady(saved.card.id);
      assert.equal(card.quote, text);
      assert.equal(card.scene, scene);
      assert.equal(card.srcId, made.thread.id);
      collected.push(card);
      record("从本人对话原话收卡并重新读取", { card });
    }
    const linked = await call("PATCH", `/v1/cards/${collected[0].id}`, {
      version: collected[0].version,
      next: {
        if: "两天后回看",
        then: "说说这件事有无变化",
        on: "2026-10-14",
        by: "user",
      },
    });
    record("为生活卡保存两天后的下一步", linked);
    await call("POST", "/v1/learn/marks", { action: "stuck", pointId });
    const before = await call("GET", `/v1/learn/points/${pointId}?tone=light`);
    assert.equal(before.retest.mode, false);
    record("地图标记卡住了，确认当天还未进入复测模式", {
      retest: before.retest,
    });

    clock.at = new Date("2026-10-14T02:00:00.000Z");
    const resume = await call("POST", "/v1/resume/open", {
      visitId: `${persona.id}-plus-two-days`,
    });
    assert.equal(resume.kind, "item", JSON.stringify(resume));
    assert.equal(resume.item.srcId, collected[0].id, JSON.stringify(resume));
    record("测试时钟+2天→打开接续", resume);
    const acted = await call("POST", `/v1/resume/${resume.item.id}/act`, {
      action: "answer",
      text: persona.conclusion,
    });
    assert.equal(acted.crisis, false);
    record("回答接续并保存自己的变化", acted);

    const brainstorm = (
      await call("POST", "/v1/brainstorms", {
        clientId: `${persona.id}-brain`,
        cardIds: [jot.id, ...collected.map((c) => c.id)],
      })
    ).brainstorm;
    await settled(brainstorm.jobId);
    const ready = await call("GET", `/v1/brainstorms/${brainstorm.id}`);
    assert.ok(ready.result.groups.length);
    await call("PUT", `/v1/brainstorms/${brainstorm.id}/picks`, {
      conclusion: { text: persona.conclusion },
    });
    const savedBrain = await call(
      "POST",
      `/v1/brainstorms/${brainstorm.id}/save`,
      { clientId: `${persona.id}-brain-save` },
    );
    assert.equal(savedBrain.cards.length, 1);
    assert.equal(savedBrain.cards[0].mine, persona.conclusion);
    assert.equal(savedBrain.cards[0].titleBy, "user");
    const reopenedBrain = await call("GET", `/v1/brainstorms/${brainstorm.id}`);
    record("选三张卡头脑风暴→改写结论→保存→重新打开", {
      result: ready.result,
      saved: savedBrain,
      reopenedStatus: reopenedBrain.status,
    });

    const sourceText = `${persona.name}的自编笔记：极限运算前先检查各项极限是否存在。`;
    const imported = (
      await call("POST", "/v1/imports", {
        clientId: `${persona.id}-import`,
        text: sourceText,
        own: true,
      })
    ).import;
    const split = await call("POST", `/v1/imports/${imported.id}/cards`, {
      clientId: `${persona.id}-split`,
    });
    await settled(split.import.job.id);
    const pick = await call("GET", `/v1/imports/${imported.id}`);
    assert.equal(pick.candidates.length, 1);
    const paraphrase = await request(
      "POST",
      `/v1/imports/${imported.id}/save`,
      {
        clientId: `${persona.id}-paraphrase`,
        selections: [
          { candidateId: "c1", mine: "我会先检查每一项极限存在，再开始运算" },
        ],
      },
    );
    assert.equal(paraphrase.statusCode, 400);
    assert.equal(paraphrase.json().code, "IMPORT_MINE");
    record(
      "接口边界探针：尝试把导入原话改写后直接填入我的话",
      paraphrase.json(),
      "已查模板按钮为选一句我的话，接口拒绝不属原文的句子符合设计；这不是已证实的界面缺陷。",
    );
    const importedCards = await call(
      "POST",
      `/v1/imports/${imported.id}/save`,
      {
        clientId: `${persona.id}-import-save`,
        selections: [
          { candidateId: "c1", mine: "极限运算前先检查各项极限是否存在" },
        ],
      },
    );
    assert.equal(importedCards.cards.length, 1);
    assert.equal(importedCards.cards[0].quote, sourceText);
    record("粘贴自己的文字→拆卡→选择→摘取本人原话→保存", {
      candidates: pick.candidates,
      cards: importedCards.cards,
    });

    const retest = await call("GET", `/v1/learn/points/${pointId}?tone=light`);
    assert.equal(retest.retest.mode, true);
    const verdict = await call("POST", `/v1/learn/points/${pointId}/answer`, {
      index: retest.problem.index,
      answer: canonicalInput(PROBLEMS[pointId]![retest.problem.index]!),
      predicted: "yes",
      tone: "light",
    });
    assert.equal(verdict.verdict, "correct");
    assert.ok(verdict.retest);
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) n FROM retests WHERE user_id=? AND point_id=? AND done_at IS NULL",
        )
        .get(user.id, pointId)!.n,
      0,
    );
    record(
      "到期地图复测→不请求提示/解析→提交合成正确答案",
      { mode: retest.retest, verdict },
      "答案由测试夹具提供，未进入大模型或产品语料；不证明人设真的学会。",
    );

    // Fixed-keyword crisis must not reach either classification or generation.
    const callsBefore = fake.calls.length;
    const crisis = await send({
      entry: "jot",
      text: crisisFixture,
      clientId: `${persona.id}-crisis`,
    });
    assert.deepEqual(
      crisis.map((e) => e.e),
      ["crisis"],
    );
    assert.equal(fake.calls.length, callsBefore);
    record("固定关键词触发危机停止引导", { events: crisis, providerCalls: 0 });

    if (persona.mood) {
      const text = "今天考试之后有点难过，想先把感受说清楚";
      const thread = (
        await call("POST", "/v1/chat/threads", {
          entry: "jot",
          text,
          tone: "light",
        })
      ).thread;
      const denied = await request("PATCH", `/v1/chat/threads/${thread.id}`, {
        scene: "mood",
        tone: "light",
      });
      assert.equal(denied.statusCode, 409);
      record("尚未单独同意时尝试心情对话", {
        statusCode: denied.statusCode,
        response: denied.json(),
      });
      await call("PUT", "/v1/me/mood-consent");
      await call("PATCH", `/v1/chat/threads/${thread.id}`, {
        scene: "mood",
        tone: "light",
      });
      const moodEvents = await send({
        threadId: thread.id,
        text,
        clientId: `${persona.id}-mood`,
      });
      assert.ok(moodEvents.some((e) => e.e === "done"));
      const moodCard = await call("POST", "/v1/cards", {
        origin: "chat",
        srcId: thread.id,
        quote: text,
        type: "idea",
        title: "先说清感受",
      });
      await cardReady(moodCard.card.id);
      record("单独同意→心情引导→收心情卡", {
        events: moodEvents,
        list: await call("GET", "/v1/mood"),
      });
      const deleted = await call("DELETE", "/v1/mood");
      assert.ok(store.getUser(user.id)!.moodConsentAt);
      assert.equal(
        (await request("GET", `/v1/cards/${moodCard.card.id}`)).statusCode,
        404,
      );
      record("一键删除心情记录，单独同意仍保留", deleted);
      // Make a second record so withdrawal is tested against live content, not an empty list.
      const second = (
        await call("POST", "/v1/chat/threads", {
          entry: "jot",
          text,
          tone: "light",
        })
      ).thread;
      await call("PATCH", `/v1/chat/threads/${second.id}`, {
        scene: "mood",
        tone: "light",
      });
      await send({
        threadId: second.id,
        text,
        clientId: `${persona.id}-mood-second`,
      });
      const secondCard = await call("POST", "/v1/cards", {
        origin: "chat",
        srcId: second.id,
        quote: text,
        type: "idea",
      });
      await cardReady(secondCard.card.id);
      const withdrawn = await call("DELETE", "/v1/me/mood-consent");
      assert.equal(store.getUser(user.id)!.moodConsentAt, undefined);
      assert.equal(
        (await request("GET", `/v1/cards/${secondCard.card.id}`)).statusCode,
        404,
      );
      assert.equal(
        store.db
          .prepare(
            "SELECT count(*) n FROM threads WHERE user_id=? AND scene='mood'",
          )
          .get(user.id)!.n,
        0,
      );
      assert.equal((await call("GET", `/v1/cards/${jot.id}`)).id, jot.id);
      record("再次写心情内容→撤回同意→确认内容删除且普通卡保留", {
        withdrawn,
        moodList: await call("GET", "/v1/mood"),
        ordinaryCardRetained: true,
      });
    }
    // Fixed seed gives each persona one distinct exploratory branch, reproducibly.
    const exploration = (20261012 + Number(persona.id.slice(1)) * 3) % 4;
    if (exploration === 0) {
      const settings = await call("GET", "/v1/resume/settings");
      await call("PUT", "/v1/resume/settings", { ...settings, mode: "off" });
      const off = await call("POST", "/v1/resume/open", {
        visitId: `${persona.id}-off`,
      });
      assert.equal(off.kind, "none");
      await call("PUT", "/v1/resume/settings", settings);
      record("固定种子探索：关闭接续→打开首页→恢复原设置", {
        seed: 20261012,
        result: off,
        restored: settings,
      });
    } else if (exploration === 1) {
      // search moved to the 卡片 tab.
      const deck = mountNotes(call, user.id, "pages/deck/index.js");
      deck.page.alive = true;
      deck.page.data.consent = true;
      deck.page.data.query = persona.name;
      await deck.page.load(true);
      assert.equal(deck.page.data.cards.length, 1);
      assert.equal(deck.page.data.cards[0].id, importedCards.cards[0].id);
      record("固定种子探索：卡片 VM搜索本人的导入原文", {
        seed: 20261012,
        query: persona.name,
        matchingIds: deck.page.data.cards.map((c: any) => c.id),
      });
    } else if (exploration === 2) {
      const tag = await call("POST", "/v1/tags", { name: "待回看", color: 0 });
      const current = await call("GET", `/v1/cards/${jot.id}`);
      const tagged = await call("PUT", `/v1/cards/${jot.id}/tags`, {
        version: current.version,
        tagIds: [tag.id],
      });
      const filtered = await call("GET", `/v1/cards?tag=${tag.id}`);
      assert.equal(filtered.data.length, 1);
      assert.equal(filtered.data[0].id, jot.id);
      record("固定种子探索：自建标签→给卡打标签→筛选", {
        seed: 20261012,
        tagged,
        matchingIds: filtered.data.map((c: any) => c.id),
      });
    } else {
      const teach = await call(
        "PATCH",
        `/v1/chat/threads/${collected[1].srcId}`,
        { mode: "teach", tone: "light" },
      );
      assert.equal(teach.thread.mode, "teach");
      const explanation = await send({
        threadId: collected[1].srcId,
        text: "我先检查各项极限存在，再应用运算法则",
        clientId: `${persona.id}-teach`,
      });
      assert.ok(explanation.some((e) => e.e === "done"));
      record("固定种子探索：切到讲给AI听→本人解释一步", {
        seed: 20261012,
        mode: teach.thread.mode,
        events: explanation,
      });
    }
    notes.page.onUnload();
    passed = true;
  });
