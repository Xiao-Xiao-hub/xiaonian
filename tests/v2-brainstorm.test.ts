import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../server/src/index.js";
import { loadEnv } from "../server/src/config/env.js";
import { SqliteStore } from "../server/src/shared/store.js";

const usage = { prompt_tokens: 5, completion_tokens: 4 };
const good = {
  title: "把几张卡摆开",
  groups: [{ name: "共同", common: "都在整理复习", cards: [1, 2] }],
  tensions: [{ a: 1, b: 2, note: "先理解还是先练习" }],
  more: [{ type: "question", title: "怎样安排复习", from: [1] }],
  ifs: [{ if: "能找到共同卡点", from: [1, 2] }],
  directions: [{ title: "比较卡点", why: "两张卡都提到复习", from: [1, 2] }],
  drafts: [{ text: "先找共同卡点再安排练习", from: [1, 2] }],
  ask: { q: "先看哪一部分", options: ["共同点", "矛盾"] },
};
type FakeOptions = { output?: typeof good; hold?: Promise<void> };
function fakeFetcher(options: FakeOptions = {}) {
  const calls: Array<{
    system: string;
    prompt: string;
    body: Record<string, unknown>;
  }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages?: Array<{ content: string }>;
      questions?: { q: { type: string } };
    } & Record<string, unknown>;
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = body.questions!.q;
      return new Response(
        JSON.stringify({
          answers: {
            q:
              q.type === "noul"
                ? { noul: 0 }
                : {
                    choice: "idea",
                    confidence: 0.9,
                    probabilities: { idea: 0.9 },
                  },
          },
        }),
      );
    }
    const system = String(body.messages?.[0]?.content ?? ""),
      prompt = String(body.messages?.at(-1)?.content ?? "");
    calls.push({ system, prompt, body });
    if (!system.includes("[BRAINSTORM]"))
      throw new Error(`unexpected model call: ${system}`);
    if (options.hold) await options.hold;
    const content = JSON.stringify(options.output ?? good);
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}`,
        `data: ${JSON.stringify({ choices: [], usage })}`,
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  return { fetcher, calls };
}

function setup(
  options: {
    fake?: FakeOptions;
    env?: Record<string, string>;
    now?: Date;
  } = {},
) {
  const store = new SqliteStore(":memory:"),
    fake = fakeFetcher(options.fake),
    clock = { at: options.now ?? new Date("2026-10-12T02:00:00.000Z") },
    app = buildApp({
      store,
      fetcher: fake.fetcher,
      now: () => clock.at,
      env: loadEnv({
        NODE_ENV: "test",
        DEV_LOGIN_ENABLED: "true",
        DATABASE_PATH: ":memory:",
        UPLOAD_DIR: mkdtempSync(join(tmpdir(), "zhiye-brainstorm-")),
        FORMULA_DIR: mkdtempSync(join(tmpdir(), "zhiye-formula-")),
        LOG_LEVEL: "silent",
        LLM_API_KEY: "fake",
        JEV_API_KEY: "fake",
        DAILY_BRAINSTORM_LIMIT: "10",
        JOB_CONCURRENCY: "1",
        ...options.env,
      }),
    });
  return { app, store, fake, clock };
}

async function login(app: ReturnType<typeof buildApp>, key = "brain-owner") {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/dev-login",
    payload: { key },
  });
  const token = response.json().data.token as string;
  return {
    token,
    call: (
      method: "GET" | "POST" | "PUT" | "DELETE",
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        payload,
      }),
  };
}

function userId(store: SqliteStore, key = "brain-owner") {
  return String(
    store.db.prepare("SELECT id FROM users WHERE openid=?").get(`dev:${key}`)!
      .id,
  );
}

function card(
  store: SqliteStore,
  owner: string,
  id: string,
  options: {
    scene?: "study" | "life" | "mood";
    crisis?: boolean;
    pointId?: string;
    mistakeId?: string;
    sawAnswer?: boolean;
    origin?: "jot" | "import";
    srcId?: string;
    closed?: boolean;
  } = {},
) {
  const at = "2026-10-12T01:00:00.000Z";
  store.db
    .prepare(
      `INSERT INTO cards(id,user_id,type,scene,title,title_by,mine,mine_at,quote,quote_on,origin,src_id,mistake_id,point_id,saw_answer,crisis,closed_at,created_at,updated_at)
       VALUES(?,?, 'idea',?,?, 'user',?,?,?,date(?,'+8 hours'),?,?,?,?,?,?,?, ?,?)`,
    )
    .run(
      id,
      owner,
      options.scene ?? "life",
      `${id}标题`,
      `${id}是我自己写下的一段完整内容`,
      at,
      `${id}原话`,
      at,
      options.origin ?? "jot",
      options.srcId ?? null,
      options.mistakeId ?? null,
      options.pointId ?? null,
      options.sawAnswer ? 1 : 0,
      options.crisis ? 1 : 0,
      options.closed ? at : null,
      at,
      at,
    );
}

async function settle(
  call: Awaited<ReturnType<typeof login>>["call"],
  jobId: string,
) {
  for (let i = 0; i < 80; i++) {
    const response = await call("GET", `/v1/jobs/${jobId}`),
      job = response.json().data;
    if (["succeeded", "failed", "unknown"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("job did not settle");
}

async function startReady(
  f: ReturnType<typeof setup>,
  call: Awaited<ReturnType<typeof login>>["call"],
  ids: string[],
  clientId = "brain-1",
) {
  const response = await call("POST", "/v1/brainstorms", {
    clientId,
    cardIds: ids,
  });
  assert.equal(response.statusCode, 200, response.body);
  const initial = response.json().data.brainstorm;
  const job = await settle(call, initial.jobId);
  assert.equal(job.status, "succeeded", JSON.stringify(job));
  const detail = await call("GET", `/v1/brainstorms/${initial.id}`);
  return detail.json().data;
}

test("generation uses only selected owned snapshots, computes facts and deduplicates quota", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const auth = await login(f.app),
    owner = userId(f.store);
  f.store.db
    .prepare(
      "INSERT INTO materials(id,user_id,kind,title,status,created_at,updated_at) VALUES(?,?, 'problem','题','confirmed',?,?)",
    )
    .run("mat1", owner, f.clock.at.toISOString(), f.clock.at.toISOString());
  f.store.db
    .prepare(
      "INSERT INTO materials(id,user_id,kind,title,status,created_at,updated_at) VALUES(?,?, 'problem','题2','confirmed',?,?)",
    )
    .run("mat2", owner, f.clock.at.toISOString(), f.clock.at.toISOString());
  for (let i = 1; i <= 2; i++)
    f.store.db
      .prepare(
        "INSERT INTO mistakes(id,user_id,material_id,source,cause,status,due_on,created_at,updated_at) VALUES(?,?,?,'judge','条件没检查','open','2026-10-12',?,?)",
      )
      .run(
        `mist${i}`,
        owner,
        i === 1 ? "mat1" : `mat${i}`,
        f.clock.at.toISOString(),
        f.clock.at.toISOString(),
      );
  card(f.store, owner, "c1", {
    scene: "study",
    pointId: "limit-equivalent",
    mistakeId: "mist1",
    sawAnswer: true,
  });
  card(f.store, owner, "c2", {
    scene: "study",
    pointId: "limit-equivalent",
    mistakeId: "mist2",
    sawAnswer: true,
  });
  card(f.store, owner, "c3", { scene: "study", pointId: "limit-equivalent" });
  card(f.store, owner, "not-selected");
  const ready = await startReady(f, auth.call, ["c3", "c1", "c2"]);
  assert.equal(ready.scene, "study");
  assert.equal(ready.facts.sawAnswer, 2);
  assert.deepEqual(ready.facts.mistakeCauses, [
    { cause: "条件没检查", count: 2 },
  ]);
  assert.ok(ready.facts.commonPrereqs.length > 0);
  assert.match(f.fake.calls[0]!.prompt, /c1标题/);
  assert.doesNotMatch(f.fake.calls[0]!.prompt, /not-selected/);
  assert.match(f.fake.calls[0]!.prompt, /★/);
  // the answer is capped to what the pages show (thinking on top).
  assert.equal(f.fake.calls[0]!.body.max_tokens, 4096 + 16384);
  const retried = await auth.call("POST", "/v1/brainstorms", {
    clientId: "new-client-within-window",
    cardIds: ["c1", "c2", "c3"],
  });
  assert.equal(retried.json().data.brainstorm.id, ready.id);
  assert.equal(
    Number(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM quota_receipts WHERE kind='brainstorm'",
        )
        .get()!.n,
    ),
    1,
  );
  f.clock.at = new Date(f.clock.at.getTime() + 11 * 60_000);
  const refreshed = await startReady(
    f,
    auth.call,
    ["c1", "c2", "c3"],
    "after-window",
  );
  assert.notEqual(refreshed.id, ready.id);
  assert.equal(f.fake.calls.length, 2);
  assert.equal(
    Number(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM quota_receipts WHERE kind='brainstorm'",
        )
        .get()!.n,
    ),
    2,
  );
});

test("selection rejects count, foreign, crisis and mood without consent before generation", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const one = await login(f.app),
    two = await login(f.app, "brain-other"),
    owner = userId(f.store),
    other = userId(f.store, "brain-other");
  card(f.store, owner, "a");
  card(f.store, owner, "b");
  card(f.store, other, "foreign");
  card(f.store, owner, "risk", { crisis: true });
  card(f.store, owner, "mood", { scene: "mood" });
  assert.equal(
    (
      await one.call("POST", "/v1/brainstorms", {
        clientId: "few",
        cardIds: ["a", "b"],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await one.call("POST", "/v1/brainstorms", {
        clientId: "own",
        cardIds: ["a", "b", "foreign"],
      })
    ).json().code,
    "CARD_NOT_AVAILABLE",
  );
  assert.equal(
    (
      await one.call("POST", "/v1/brainstorms", {
        clientId: "risk",
        cardIds: ["a", "b", "risk"],
      })
    ).json().code,
    "CRISIS_CONTENT",
  );
  assert.equal(
    (
      await one.call("POST", "/v1/brainstorms", {
        clientId: "mood",
        cardIds: ["a", "b", "mood"],
      })
    ).json().code,
    "MOOD_CONSENT_REQUIRED",
  );
  assert.equal(f.fake.calls.length, 0);
  f.store.db
    .prepare(
      "UPDATE users SET data=json_set(data,'$.moodConsentAt',?) WHERE id=?",
    )
    .run(f.clock.at.toISOString(), owner);
  const allowed = await one.call("POST", "/v1/brainstorms", {
    clientId: "mood-allowed",
    cardIds: ["a", "b", "mood"],
  });
  assert.equal(allowed.statusCode, 200, allowed.body);
  await settle(one.call, allowed.json().data.brainstorm.jobId);
  const moodView = await one.call(
    "GET",
    `/v1/brainstorms/${allowed.json().data.brainstorm.id}`,
  );
  assert.equal(moodView.json().data.scene, "mood");
  void two;
});

test("quota failure preserves the picked selection without starting a model call", async (t) => {
  // the day's ¥1 budget is already spent (¥1.40 of glm-5.3 output).
  const f = setup({ env: { DAILY_BUDGET_CNY: "1" } });
  t.after(() => f.app.close());
  const auth = await login(f.app),
    owner = userId(f.store);
  f.store.db
    .prepare(
      "INSERT INTO quota_spend(source,source_id,user_id,usage,created_at) VALUES('job','used-brainstorm',?,?,?)",
    )
    .run(
      owner,
      JSON.stringify({ provider: "open.bigmodel.cn", model: "glm-5.3", promptTokens: 0, completionTokens: 50000 }),
      f.clock.at.toISOString(),
    );
  for (const id of ["a", "b", "c"]) card(f.store, owner, id);
  const response = await auth.call("POST", "/v1/brainstorms", {
    clientId: "quota",
    cardIds: ["a", "b", "c"],
  });
  assert.equal(response.statusCode, 429);
  const row = f.store.db
    .prepare("SELECT status,job_id FROM brainstorms WHERE user_id=?")
    .get(owner)!;
  assert.equal(row.status, "picked");
  assert.equal(row.job_id, null);
  assert.equal(f.fake.calls.length, 0);
});

test("program validation drops unsupported numbers, fixes group coverage and rejects all-invalid refs", async (t) => {
  const output = {
    ...good,
    groups: [
      { name: "一组", common: "共同复习", cards: [1, 2] },
      { name: "重复", common: "还是复习", cards: [2] },
    ],
    more: [{ type: "question" as const, title: "7天完成吗", from: [1] }],
  };
  const f = setup({ fake: { output } });
  t.after(() => f.app.close());
  const auth = await login(f.app),
    owner = userId(f.store);
  for (const id of ["a", "b", "c", "d", "e", "f"]) card(f.store, owner, id);
  const ready = await startReady(f, auth.call, ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(ready.result.more, []);
  assert.equal(ready.result.groups.at(-1).name, "没归组");
  assert.deepEqual(ready.result.groups.at(-1).cards, [3, 4, 5, 6]);

  const bad = setup({
    fake: {
      output: {
        ...good,
        groups: [],
        tensions: [],
        more: [{ type: "question", title: "没有依据", from: [99] }],
        ifs: [],
        directions: [],
        drafts: [],
      },
    },
  });
  t.after(() => bad.app.close());
  const badAuth = await login(bad.app),
    badOwner = userId(bad.store);
  for (const id of ["a", "b", "c"]) card(bad.store, badOwner, id);
  const started = await badAuth.call("POST", "/v1/brainstorms", {
    clientId: "bad",
    cardIds: ["a", "b", "c"],
  });
  const job = await settle(badAuth.call, started.json().data.brainstorm.jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "AI_BAD_OUTPUT");
});

test("editable picks save AI/user provenance, links and uses exactly once", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const auth = await login(f.app),
    owner = userId(f.store);
  for (const id of ["a", "b", "c"]) card(f.store, owner, id);
  f.store.db
    .prepare(
      "INSERT INTO tags(id,user_id,name,color,by,created_at) VALUES('tag1',?,'复习',0,'user',?)",
    )
    .run(owner, f.clock.at.toISOString());
  for (const id of ["a", "b"])
    f.store.db
      .prepare(
        "INSERT INTO card_tags(card_id,tag_id,user_id) VALUES(?,'tag1',?)",
      )
      .run(id, owner);
  const ready = await startReady(f, auth.call, ["a", "b", "c"]);
  const picks = {
    groups: [{ ...ready.result.groups[0], common: "我改过的共同点" }],
    tensions: [{ ...ready.result.tensions[0], choice: "depends" }],
    more: [{ ...ready.result.more[0], title: "我改后的问题", selected: true }],
    ifs: [{ ...ready.result.ifs[0], selected: true, then: "先核对两张卡" }],
    conclusion: {
      text: ready.result.drafts[0].text,
      draftId: ready.result.drafts[0].id,
    },
  };
  const edited = await auth.call(
    "PUT",
    `/v1/brainstorms/${ready.id}/picks`,
    picks,
  );
  assert.equal(edited.statusCode, 200, edited.body);
  const saved = await auth.call("POST", `/v1/brainstorms/${ready.id}/save`, {
    clientId: "save1",
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const body = saved.json().data;
  assert.equal(body.cards.length, 2);
  assert.equal(
    body.cards.find((item: CardViewLike) => item.type === "question").summaryBy,
    "user",
  );
  const conclusion = body.cards.find(
    (item: CardViewLike) => item.type === "idea",
  ) as CardViewLike;
  assert.equal(conclusion.mine, null);
  assert.equal(conclusion.summary, ready.result.drafts[0].text);
  assert.equal(conclusion.titleBy, "ai");
  assert.equal(conclusion.slots[0].by, "user");
  // the stance in words, not its id.
  assert.equal(conclusion.open[0].answer, "看情况");
  assert.equal(conclusion.next.then, "先核对两张卡");
  assert.deepEqual(
    conclusion.tags.map((tag: { name: string }) => tag.name),
    ["复习"],
  );
  assert.equal(
    Number(
      f.store.db
        .prepare("SELECT sum(use_count) n FROM cards WHERE id IN ('a','b','c')")
        .get()!.n,
    ),
    3,
  );
  assert.equal(
    Number(
      f.store.db
        .prepare("SELECT count(*) n FROM card_uses WHERE ref_id=?")
        .get(ready.id)!.n,
    ),
    3,
  );
  assert.equal(
    Number(
      f.store.db
        .prepare("SELECT count(*) n FROM card_links WHERE brainstorm_id=?")
        .get(ready.id)!.n,
    ),
    3,
  );
  const retry = await auth.call("POST", `/v1/brainstorms/${ready.id}/save`, {
    clientId: "save2",
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(
    Number(
      f.store.db
        .prepare("SELECT sum(use_count) n FROM cards WHERE id IN ('a','b','c')")
        .get()!.n,
    ),
    3,
  );
  assert.equal(
    Number(
      f.store.db
        .prepare("SELECT count(*) n FROM cards WHERE origin='brainstorm'")
        .get()!.n,
    ),
    2,
  );
});

type CardViewLike = {
  type: string;
  mine: string | null;
  summary: string | null;
  titleBy: string;
  slots: Array<{ by: string }>;
  open: Array<{ answer?: string }>;
  next: { then: string };
  tags: Array<{ name: string }>;
};

test("save crisis is rejected before cards or uses are written", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const auth = await login(f.app),
    owner = userId(f.store);
  for (const id of ["a", "b", "c"]) card(f.store, owner, id);
  const ready = await startReady(f, auth.call, ["a", "b", "c"]);
  await auth.call("PUT", `/v1/brainstorms/${ready.id}/picks`, {
    conclusion: { text: "我不想活了，现在准备伤害自己" },
  });
  const response = await auth.call("POST", `/v1/brainstorms/${ready.id}/save`, {
    clientId: "unsafe",
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "CRISIS_CONTENT");
  assert.equal(
    Number(
      f.store.db
        .prepare("SELECT count(*) n FROM cards WHERE origin='brainstorm'")
        .get()!.n,
    ),
    0,
  );
  assert.equal(
    Number(f.store.db.prepare("SELECT count(*) n FROM card_uses").get()!.n),
    0,
  );
});

test("delete during generation tombstones the job and late output cannot recreate the record", async (t) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = setup({ fake: { hold } });
  t.after(() => f.app.close());
  const auth = await login(f.app),
    owner = userId(f.store);
  for (const id of ["a", "b", "c"]) card(f.store, owner, id);
  const started = await auth.call("POST", "/v1/brainstorms", {
    clientId: "late",
    cardIds: ["a", "b", "c"],
  });
  const view = started.json().data.brainstorm;
  assert.equal(
    (await auth.call("DELETE", `/v1/brainstorms/${view.id}`)).statusCode,
    200,
  );
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    f.store.db.prepare("SELECT 1 FROM brainstorms WHERE id=?").get(view.id),
    undefined,
  );
  const job = f.store.db
    .prepare(
      "SELECT status,params,params_hash,result,error_code FROM jobs WHERE id=?",
    )
    .get(view.jobId)!;
  assert.equal(job.status, "failed");
  assert.equal(job.params, '{"deleted":true}');
  assert.equal(job.params_hash, `deleted:${view.jobId}`);
  assert.equal(job.result, null);
  assert.equal(job.error_code, "BRAINSTORM_DELETED");
});

test("suggestions can be fetched by compact batch key and dismissed permanently", async (t) => {
  const f = setup();
  t.after(() => f.app.close());
  const auth = await login(f.app),
    owner = userId(f.store);
  for (const id of ["a", "b", "c"])
    card(f.store, owner, id, { scene: "study", pointId: "limit-equivalent" });
  for (const id of ["i1", "i2", "i3"])
    card(f.store, owner, id, { origin: "import", srcId: "imp_batch" });
  const chapter = await auth.call(
    "GET",
    "/v1/brainstorms/suggest?kind=chapter&sourceId=limit",
  );
  assert.equal(chapter.statusCode, 200, chapter.body);
  assert.equal(chapter.json().data.items[0].sourceId, "limit");
  assert.deepEqual(chapter.json().data.items[0].cardIds.sort(), [
    "a",
    "b",
    "c",
  ]);
  const imported = await auth.call(
    "GET",
    "/v1/brainstorms/suggest?kind=import&sourceId=imp_batch",
  );
  assert.equal(imported.json().data.items[0].count, 3);
  await auth.call("POST", "/v1/brainstorms/suggest/dismiss", {
    kind: "import",
    sourceId: "imp_batch",
  });
  const hidden = await auth.call(
    "GET",
    "/v1/brainstorms/suggest?kind=import&sourceId=imp_batch",
  );
  assert.deepEqual(hidden.json().data.items, []);
});

test("brainstorm never displays generated prohibited wording", async (t) => {
  const f = setup({ fake: { output: { ...good, title: "心理咨询" } } });
  t.after(() => f.app.close());
  const auth = await login(f.app),
    owner = userId(f.store);
  for (const id of ["a", "b", "c"]) card(f.store, owner, id);
  const started = await auth.call("POST", "/v1/brainstorms", {
    clientId: "banned",
    cardIds: ["a", "b", "c"],
  });
  const job = await settle(auth.call, started.json().data.brainstorm.jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "AI_BAD_OUTPUT");
  const detail = await auth.call(
    "GET",
    `/v1/brainstorms/${started.json().data.brainstorm.id}`,
  );
  assert.equal(detail.json().data.result, null);
});
