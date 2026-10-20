import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Jev } from "../server/src/providers/jev.js";
import { MIGRATIONS, SqliteStore } from "../server/src/shared/store.js";
import { MistakeService } from "../server/src/modules/mistakes/service.js";
import {
  dueOffset,
  LearnService,
} from "../server/src/modules/learn/service.js";
import { addDays, chinaDate } from "../server/src/shared/time.js";
import { ToolLinkService } from "../server/src/modules/learn/tool-links.js";
import { fakeServices, makeApp } from "./fixtures.js";

const POINT = "application-taylor-limit";
function fakeMatcher() {
  const control = { choice: POINT, confidence: 0.9, hold: false, fail: false };
  const calls: {
    state: Record<string, unknown>;
    criteria: Record<string, string>;
  }[] = [];
  const release: (() => void)[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const q = body.questions.q;
    if (!q.criteria?.[POINT])
      return new Response(
        JSON.stringify({
          answers: {
            q: {
              choice: "limit",
              confidence: 0.9,
              probabilities: { limit: 0.9 },
            },
          },
        }),
      );
    calls.push({ state: body.state, criteria: q.criteria });
    if (control.hold)
      await new Promise<void>((resolve, reject) => {
        release.push(resolve);
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        );
      });
    if (control.fail) throw new Error("synthetic matcher failure");
    return new Response(
      JSON.stringify({
        answers: {
          q: {
            choice: control.choice,
            confidence: control.confidence,
            probabilities: { [control.choice]: control.confidence },
          },
        },
      }),
    );
  }) as typeof fetch;
  return { control, calls, release, fetcher };
}
function setup(t: TestContext, configured = true) {
  const store = new SqliteStore(":memory:");
  const clock = { at: new Date("2026-10-05T01:00:00Z") };
  const matcher = fakeMatcher();
  const jev = new Jev(
    { apiKey: configured ? "fake" : undefined, timeoutMs: 1000 },
    matcher.fetcher,
  );
  const logs: unknown[] = [];
  const links = new ToolLinkService(
    store,
    jev,
    () => clock.at,
    (error) => logs.push(error),
  );
  const mistakes = new MistakeService(
    store,
    jev,
    () => clock.at,
    undefined,
    links,
  );
  const learn = new LearnService(store, () => clock.at);
  const user = store.upsertUser("dev:owner", "owner", "dev");
  const other = store.upsertUser("dev:other", "other", "dev");
  let sequence = 0;
  const material = (owner = user.id) => {
    const id = `mat_test_${++sequence}`,
      iso = clock.at.toISOString();
    store.db
      .prepare(
        "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES(?,?,'problem','test','confirmed',1,?,?)",
      )
      .run(id, owner, iso, iso);
    store.db
      .prepare(
        "INSERT INTO material_versions(material_id,version,origin,text,paragraphs,created_at) VALUES(?,1,'typed',?,'[]',?)",
      )
      .run(id, "用泰勒展开求极限。", iso);
    return id;
  };
  const wrong = (id: string, owner = user.id, sourceVersion?: number) =>
    mistakes.judged(
      owner,
      id,
      "-999",
      "incorrect",
      null,
      "limit",
      sourceVersion,
    );
  const row = (id = POINT, owner = user.id) =>
    store.db
      .prepare("SELECT * FROM map_points WHERE user_id=? AND point_id=?")
      .get(owner, id);
  const mistake = (id: string, owner = user.id) =>
    store.db
      .prepare("SELECT * FROM mistakes WHERE user_id=? AND material_id=?")
      .get(owner, id)!;
  const version2 = (id: string) => {
    store.db
      .prepare(
        "INSERT INTO material_versions(material_id,version,origin,text,paragraphs,created_at) VALUES(?,2,'edit',?,'[]',?)",
      )
      .run(id, "新题面，求导数。", clock.at.toISOString());
    store.db
      .prepare("UPDATE materials SET current_version=2 WHERE id=?")
      .run(id);
  };
  t.after(async () => {
    await links.stop();
    store.close();
  });
  return {
    store,
    clock,
    matcher,
    logs,
    links,
    mistakes,
    learn,
    user,
    other,
    material,
    wrong,
    row,
    mistake,
    version2,
  };
}

test("tool links: cross-chapter high confidence links a first mistake without awarding progress", async (t) => {
  const s = setup(t),
    id = s.material();
  s.learn.mark(s.user.id, "self", POINT);
  const before = s.learn.summary(s.user.id);
  s.wrong(id);
  await s.links.idle();
  assert.equal(s.matcher.calls.length, 1);
  assert.equal(Object.keys(s.matcher.calls[0]!.criteria).length, 90);
  assert.equal(s.matcher.calls[0]!.state.chapterHint, "limit");
  assert.ok(s.matcher.calls[0]!.criteria[POINT]);
  assert.ok(s.matcher.calls[0]!.criteria["derivative-chain"]);
  assert.equal(s.mistake(id).chapter, "limit");
  assert.equal(s.mistake(id).map_point_id, POINT);
  assert.equal(s.mistake(id).map_version, 1);
  assert.equal(s.row()?.red, 1);
  assert.equal(s.row()?.correct_at, null);
  assert.equal(s.row()?.due_on, null);
  assert.ok(s.row()?.self_at);
  assert.equal(s.learn.point(s.user.id, POINT).red, true);
  assert.equal(s.learn.summary(s.user.id).xp, before.xp);
  assert.deepEqual(s.mistakes.forMaterial(s.user.id, id)?.mapPoint, {
    id: POINT,
    name: "泰勒公式求极限",
    chapterId: "application",
  });
  assert.deepEqual(
    s.mistakes.list(s.user.id).items[0]?.mapPoint, // list() pages, {items, more}
    s.mistakes.forMaterial(s.user.id, id)?.mapPoint,
  );
  assert.deepEqual(s.logs, []);
});

test("tool links: cached repeat after today's review resets due and completion, preserves score and interval", async (t) => {
  const s = setup(t),
    id = s.material();
  s.learn.answer(s.user.id, POINT, "-1/12", 0);
  s.wrong(id);
  await s.links.idle();
  assert.equal(s.row()?.due_on, "2026-10-05");
  const reviewed = s.learn.answer(s.user.id, POINT, "-1/12", 0);
  assert.equal(reviewed.counted, "review");
  const before = { ...s.row() },
    summary = s.learn.summary(s.user.id);
  assert.equal(before.reviewed_on, "2026-10-05");
  s.learn.mark(s.user.id, "unred", POINT);
  assert.equal(s.row()?.red, 0);
  s.wrong(id); // Existing record used to return before this hook.
  assert.equal(s.matcher.calls.length, 1);
  assert.equal(s.mistake(id).wrong, 2);
  assert.equal(s.row()?.red, 1);
  assert.equal(s.row()?.due_on, "2026-10-05");
  assert.equal(s.row()?.reviewed_on, null);
  for (const field of [
    "correct_at",
    "interval",
    "self_at",
    "seen_at",
    "practice_on",
  ])
    assert.equal(s.row()?.[field], before[field]);
  const after = s.learn.summary(s.user.id);
  assert.equal(after.xp, summary.xp);
  assert.equal(after.level, summary.level);
  assert.equal(after.todayList.find((p) => p.id === POINT)?.done, false);
  const unred = s.learn.mark(s.user.id, "unred", POINT);
  assert.equal(unred.red, false);
  assert.equal(unred.state, "due");
  assert.equal(s.row()?.due_on, "2026-10-05");
  assert.equal(s.row()?.reviewed_on, null);
  assert.equal(s.learn.summary(s.user.id).xp, summary.xp);
});

test("tool links: graded errors use the same repeat hook and preserve the original chapter classifier", async (t) => {
  const s = setup(t),
    id = s.material();
  const bad = "**结论**：第 2 步有误，符号写反了。";
  s.mistakes.graded(s.user.id, id, bad, 1);
  await s.links.idle();
  assert.equal(s.mistake(id).source, "grade");
  assert.equal(s.mistake(id).chapter, "limit");
  assert.equal(s.row()?.red, 1);
  s.learn.mark(s.user.id, "unred", POINT);
  s.mistakes.graded(s.user.id, id, bad, 1);
  assert.equal(s.row()?.red, 1);
  assert.equal(s.mistake(id).wrong, 2);
  assert.equal(s.matcher.calls.length, 1);
  s.version2(id);
  s.learn.mark(s.user.id, "unred", POINT);
  s.mistakes.graded(s.user.id, id, bad, 1);
  await s.links.idle();
  assert.equal(s.row()?.red, 0);
  assert.equal(s.matcher.calls.length, 1);
});

test("tool links migration ten: legacy mistakes and learning progress survive without inferred links", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "zhiye-tool-links-upgrade-")),
    "app.sqlite",
  );
  const old = new DatabaseSync(path),
    iso = "2026-10-03T00:00:00Z";
  try {
    old.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)",
    );
    for (let i = 0; i < 9; i++) {
      old.exec(MIGRATIONS[i]!);
      old.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(i + 1, iso);
    }
    old
      .prepare("INSERT INTO users VALUES(?,?,?)")
      .run("u", "dev:u", '{"id":"u"}');
    old
      .prepare(
        "INSERT INTO materials(id,user_id,kind,title,status,current_version,created_at,updated_at) VALUES('m','u','problem','old','confirmed',1,?,?)",
      )
      .run(iso, iso);
    old
      .prepare(
        "INSERT INTO mistakes(id,user_id,material_id,source,answer,chapter,status,due_on,created_at,updated_at) VALUES('k','u','m','judge','1','limit','open','2026-10-04',?,?)",
      )
      .run(iso, iso);
    old
      .prepare(
        "INSERT INTO map_points(user_id,point_id,correct_at,due_on,interval,red,reviewed_on,updated_at) VALUES('u',?,?,'2026-10-10',21,1,'2026-10-03',?)",
      )
      .run(POINT, iso, iso);
  } finally {
    old.close();
  }
  for (let pass = 0; pass < 2; pass++) {
    const store = new SqliteStore(path);
    try {
      const mistake = store.db
        .prepare("SELECT * FROM mistakes WHERE id='k'")
        .get()!;
      assert.equal(mistake.answer, "1");
      assert.equal(mistake.chapter, "limit");
      assert.equal(mistake.map_point_id, null);
      assert.equal(mistake.map_version, null);
      const point = store.db
        .prepare("SELECT * FROM map_points WHERE user_id='u'")
        .get()!;
      assert.equal(point.correct_at, iso);
      assert.equal(point.red, 1);
      assert.equal(point.due_on, "2026-10-10");
      assert.equal(point.reviewed_on, "2026-10-03");
      assert.equal(point.interval, 21);
      assert.equal(point.tool_epoch, 0);
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM schema_migrations WHERE version=10",
          )
          .get()?.n,
        1,
      );
    } finally {
      store.close();
    }
  }
});

test("tool links: a completed review cycle can become due again, hidden chapters stay outside today's list", async (t) => {
  const s = setup(t),
    id = s.material();
  s.learn.answer(s.user.id, POINT, "-1/12", 0);
  s.store.db
    .prepare(
      "UPDATE map_points SET due_on=NULL,interval=63,reviewed_on='2026-10-05' WHERE user_id=?",
    )
    .run(s.user.id);
  s.learn.chapter(s.user.id, "hide", "application");
  const xp = s.learn.summary(s.user.id).xp;
  s.wrong(id);
  await s.links.idle();
  assert.equal(s.row()?.due_on, "2026-10-05");
  assert.equal(s.row()?.interval, 63);
  assert.equal(s.row()?.reviewed_on, null);
  assert.ok(!s.learn.summary(s.user.id).todayList.some((p) => p.id === POINT));
  assert.equal(s.learn.summary(s.user.id).xp, xp);
});

test("tool links: a review brought forward by a red dot keeps its interval when correct (D049)", async (t) => {
  const s = setup(t),
    id = s.material();
  const due = (days: number) =>
    addDays(chinaDate(s.clock.at.getTime()), days + dueOffset(POINT));
  s.learn.answer(s.user.id, POINT, "-1/12", 0);
  s.store.db
    .prepare(
      "UPDATE map_points SET interval=21,due_on=NULL,reviewed_on='2026-10-04' WHERE user_id=?",
    )
    .run(s.user.id);
  s.store.db
    .prepare("UPDATE map_points SET due_on='2026-10-05' WHERE user_id=?")
    .run(s.user.id);
  // A normal due review still climbs the ladder.
  assert.deepEqual(s.learn.answer(s.user.id, POINT, "-1/12", 0).review, {
    interval: 63,
  });
  assert.equal(s.row()?.red_due, 0);
  // Wrong in a tool: red, due today, marked as red-triggered.
  s.wrong(id);
  await s.links.idle();
  assert.equal(s.row()?.due_on, "2026-10-05");
  assert.equal(s.row()?.red_due, 1);
  // Correct on the same day: the interval stays 63, the date moves from today.
  assert.deepEqual(s.learn.answer(s.user.id, POINT, "-1/12", 0).review, {
    interval: 63,
  });
  assert.equal(s.row()?.interval, 63);
  assert.equal(s.row()?.due_on, due(63));
  assert.equal(s.row()?.red_due, 0);
  // Red-triggered, then wrong, then correct: the lapse rule restarts at 7.
  s.learn.mark(s.user.id, "unred", POINT);
  s.wrong(id);
  assert.equal(s.row()?.red_due, 1);
  assert.equal(s.learn.answer(s.user.id, POINT, "5", 0).counted, "lapse");
  assert.equal(s.row()?.red_due, 0);
  assert.equal(s.learn.answer(s.user.id, POINT, "-1/12", 0).counted, "lapse");
  s.clock.at = new Date(s.clock.at.getTime() + 86_400_000);
  assert.deepEqual(s.learn.answer(s.user.id, POINT, "-1/12", 0).review, {
    interval: 7,
  });
  assert.equal(s.row()?.due_on, due(7));
  // A red dot on a point never answered correctly does not mark a review.
  s.wrong(s.material(s.other.id), s.other.id);
  await s.links.idle();
  assert.equal(s.row(POINT, s.other.id)?.red, 1);
  assert.equal(s.row(POINT, s.other.id)?.red_due, 0);
});

test("tool links: low confidence and none are cached, unavailable and failed classification leave progress untouched", async (t) => {
  for (const [choice, confidence] of [
    [POINT, 0.69],
    ["none", 1],
  ] as const) {
    const s = setup(t),
      id = s.material();
    s.matcher.control.choice = choice;
    s.matcher.control.confidence = confidence;
    s.wrong(id);
    await s.links.idle();
    s.wrong(id);
    await s.links.idle();
    assert.equal(s.row(), undefined);
    assert.equal(s.matcher.calls.length, 1);
    assert.equal(s.mistake(id).map_point_id, null);
    assert.equal(s.mistake(id).map_version, 1);
  }
  const off = setup(t, false),
    offId = off.material();
  off.wrong(offId);
  await off.links.idle();
  assert.equal(off.row(), undefined);
  assert.equal(off.matcher.calls.length, 0);
  const bad = setup(t),
    badId = bad.material();
  bad.matcher.control.fail = true;
  bad.wrong(badId);
  await bad.links.idle();
  assert.equal(bad.row(), undefined);
  assert.equal(bad.mistake(badId).wrong, 1);
  assert.equal(bad.mistake(badId).map_version, null);
  assert.equal(bad.logs.length, 1);
  bad.matcher.control.fail = false;
  bad.wrong(badId);
  await bad.links.idle();
  assert.equal(bad.row()?.red, 1);
  assert.equal(bad.matcher.calls.length, 2);
});

test("tool links: wrong input is classified at the threshold; correct and unsure tools never alter the map", async (t) => {
  const s = setup(t),
    first = s.material();
  s.mistakes.judged(s.user.id, first, "right", "correct", null);
  s.mistakes.judged(s.user.id, first, "?", "unsure", null);
  s.mistakes.graded(s.user.id, first, "**结论**：过程正确");
  await s.links.idle();
  assert.equal(s.row(), undefined);
  assert.equal(s.matcher.calls.length, 0);
  s.matcher.control.confidence = 0.7;
  s.wrong(first);
  await s.links.idle();
  const row = s.row();
  s.clock.at = new Date("2026-10-06T01:00:00Z");
  s.mistakes.judged(s.user.id, first, "right", "correct", null);
  s.mistakes.graded(s.user.id, first, "**结论**：过程正确");
  assert.equal(s.mistake(first).status, "mastered");
  assert.deepEqual(s.row(), row);
  assert.equal(s.matcher.calls.length, 1);
});

test("tool links: same-version concurrent errors share one call and use the latest error snapshot", async (t) => {
  const s = setup(t),
    id = s.material();
  s.matcher.control.hold = true;
  s.wrong(id);
  await tick();
  s.learn.mark(s.user.id, "unred", POINT);
  s.wrong(id); // New error after dismiss may re-add the red dot.
  assert.equal(s.matcher.calls.length, 1);
  s.matcher.release.shift()!();
  await s.links.idle();
  assert.equal(s.mistake(id).wrong, 2);
  assert.equal(s.row()?.red, 1);
});

test("tool links: late classifications cannot undo a newer unred, first lighting, repeat correct, or review", async (t) => {
  for (const action of ["unred", "lit", "again", "review"] as const) {
    const s = setup(t),
      id = s.material();
    if (action === "again" || action === "review")
      s.learn.answer(s.user.id, POINT, "-1/12", 0);
    if (action === "review")
      s.store.db
        .prepare("UPDATE map_points SET due_on='2026-10-05' WHERE user_id=?")
        .run(s.user.id);
    s.matcher.control.hold = true;
    s.wrong(id);
    await tick();
    if (action === "unred") s.learn.mark(s.user.id, "unred", POINT);
    else
      assert.equal(
        s.learn.answer(s.user.id, POINT, "-1/12", 0).counted,
        action,
      );
    const current = s.row();
    s.matcher.release.shift()!();
    await s.links.idle();
    assert.equal(
      s.mistake(id).map_point_id,
      POINT,
      "association itself remains useful",
    );
    assert.deepEqual(s.row(), current, action);
  }
});

test("tool links: seeing or self-marking while classification waits does not suppress the red dot", async (t) => {
  const s = setup(t),
    id = s.material();
  s.matcher.control.hold = true;
  s.wrong(id);
  await tick();
  s.learn.mark(s.user.id, "seen", POINT);
  s.learn.mark(s.user.id, "self", POINT);
  s.matcher.release.shift()!();
  await s.links.idle();
  assert.equal(s.row()?.red, 1);
  assert.ok(s.row()?.seen_at);
  assert.ok(s.row()?.self_at);
});

test("tool links: stale material versions, deletes and wrong owners cannot attach late results", async (t) => {
  for (const change of ["version", "material", "mistake", "user"] as const) {
    const s = setup(t),
      id = s.material();
    s.matcher.control.hold = true;
    s.wrong(id);
    await tick();
    if (change === "version") s.version2(id);
    else if (change === "material")
      s.store.db.prepare("DELETE FROM materials WHERE id=?").run(id);
    else if (change === "mistake")
      s.mistakes.remove(s.user.id, String(s.mistake(id).id));
    else s.store.db.prepare("DELETE FROM users WHERE id=?").run(s.user.id);
    s.matcher.release.shift()!();
    await s.links.idle();
    assert.equal(s.row(), undefined, change);
    if (change === "version") {
      assert.equal(s.mistake(id).map_version, null);
      s.matcher.control.hold = false;
      s.matcher.control.choice = "derivative-chain";
      s.wrong(id, s.user.id, 1);
      await s.links.idle();
      assert.equal(
        s.matcher.calls.length,
        1,
        "old attempt cannot link the new version",
      );
      s.wrong(id, s.user.id, 2);
      await s.links.idle();
      assert.equal(s.mistake(id).map_version, 2);
      assert.equal(s.row("derivative-chain")?.red, 1);
    }
  }
  const s = setup(t),
    id = s.material();
  s.wrong(id, s.other.id);
  await s.links.idle();
  assert.equal(s.matcher.calls.length, 0);
  assert.equal(s.mistakes.forMaterial(s.other.id, id), null);
});

test("tool links: cache expires after material edit and an old public association disappears", async (t) => {
  const s = setup(t),
    id = s.material();
  s.wrong(id);
  await s.links.idle();
  s.version2(id);
  assert.equal(s.mistakes.forMaterial(s.user.id, id)?.mapPoint, null);
  s.matcher.control.choice = "derivative-chain";
  s.wrong(id);
  await s.links.idle();
  assert.equal(s.matcher.calls.length, 2);
  assert.equal(
    s.mistakes.forMaterial(s.user.id, id)?.mapPoint?.id,
    "derivative-chain",
  );
});

test("tool links: classification writes use response Beijing date, and shutdown aborts safely", async (t) => {
  const s = setup(t),
    id = s.material();
  s.learn.answer(s.user.id, POINT, "-1/12", 0);
  s.matcher.control.hold = true;
  s.wrong(id);
  await tick();
  s.clock.at = new Date("2026-10-05T16:00:00Z");
  s.matcher.release.shift()!();
  await s.links.idle();
  assert.equal(s.row()?.due_on, "2026-10-06");
  const stopped = setup(t),
    second = stopped.material();
  stopped.matcher.control.hold = true;
  stopped.wrong(second);
  await tick();
  await stopped.links.stop();
  assert.equal(stopped.row(), undefined);
  assert.equal(stopped.logs.length, 0);
  stopped.wrong(second);
  await stopped.links.idle();
  assert.equal(stopped.matcher.calls.length, 1);
});

test("tool links: nested feedback transactions and rollback do not start invalid work", async (t) => {
  const s = setup(t),
    id = s.material();
  s.store.transaction(() => s.wrong(id));
  await s.links.idle();
  s.learn.mark(s.user.id, "unred", POINT);
  s.store.transaction(() => s.wrong(id)); // Cached path reuses outer transaction.
  assert.equal(s.row()?.red, 1);
  const other = s.material();
  assert.throws(() =>
    s.store.transaction(() => {
      s.wrong(other);
      throw new Error("rollback");
    }),
  );
  await s.links.idle();
  assert.equal(s.matcher.calls.length, 1);
  assert.equal(s.mistakes.forMaterial(s.user.id, other), null);
});

test("tool links API: actual feedback job, strict unred, isolated export and correct-only no-call", async (t) => {
  const store = new SqliteStore(":memory:");
  const services = fakeServices();
  const original = services.fetcher,
    matcher = fakeMatcher();
  services.fetcher = (async (url, init) => {
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      const q = JSON.parse(String(init?.body)).questions.q;
      if (q.criteria?.[POINT] || q.criteria?.limit)
        return matcher.fetcher(url, init);
    }
    return original(url, init);
  }) as typeof fetch;
  const app = makeApp(
    services,
    {},
    () => new Date("2026-10-05T01:00:00Z"),
    store,
  );
  t.after(() => app.close());
  const login = async (key: string) => {
    const { token, user } = (
      await app.inject({
        method: "POST",
        url: "/v1/auth/dev-login",
        payload: { key },
      })
    ).json().data;
    const call = (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET",
        url,
        payload: payload as string,
        headers: { authorization: `Bearer ${token}` },
      });
    return { call, userId: user.id as string };
  };
  const { call, userId } = await login("owner"),
    { call: other } = await login("other");
  const id = (
    await call("POST", "/v1/materials", {
      kind: "problem",
      text: "用泰勒展开求极限。",
      answer: "2",
    })
  ).json().data.id;
  await call("PUT", `/v1/materials/${id}`, {
    expectedVersion: 1,
    confirm: true,
  });
  assert.equal(
    (await call("GET", `/v1/materials/${id}/study`)).json().data.mapPoint,
    null,
  );
  assert.equal(
    (await other("GET", `/v1/materials/${id}/study`)).statusCode,
    404,
  );
  assert.equal(
    matcher.calls.length,
    0,
    "reading study does not classify a point",
  );
  const attempt = async (answer: string) => {
    const response = await call("POST", `/v1/materials/${id}/attempts`, {
      answer,
    });
    assert.equal(response.statusCode, 200, response.body);
    const { job } = response.json().data;
    for (let i = 0; i < 100; i++) {
      const status = (await call("GET", `/v1/jobs/${job.id}`)).json().data;
      if (!["queued", "running"].includes(status.status)) {
        assert.equal(status.status, "succeeded", JSON.stringify(status));
        return;
      }
      await tick();
    }
    assert.fail("feedback did not finish");
  };
  await attempt("1");
  for (
    let i = 0;
    i < 100 &&
    !store.db
      .prepare("SELECT red FROM map_points WHERE user_id=? AND point_id=?")
      .get(userId, POINT);
    i++
  )
    await tick();
  assert.equal(
    (await call("GET", `/v1/learn/points/${POINT}`)).json().data.red,
    true,
  );
  assert.equal(
    (await other("GET", `/v1/learn/points/${POINT}`)).json().data.red,
    false,
  );
  const linked = (await call("GET", `/v1/materials/${id}/study`)).json().data
    .mapPoint;
  assert.equal(linked.id, POINT);
  assert.equal(linked.chapterId, "application");
  assert.equal(typeof linked.name, "string");
  assert.deepEqual(Object.keys(linked).sort(), ["chapterId", "id", "name"]);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/learn/marks",
        payload: { action: "unred", pointId: POINT },
      })
    ).statusCode,
    401,
  );
  for (const payload of [
    { action: "unred", pointId: POINT, red: true },
    { action: "unred", pointId: POINT, index: 0 },
    { action: "red", pointId: POINT },
  ])
    assert.equal(
      (await call("POST", "/v1/learn/marks", payload)).statusCode,
      400,
    );
  assert.equal(
    (
      await call("POST", "/v1/learn/marks", {
        action: "unred",
        pointId: "missing",
      })
    ).statusCode,
    404,
  );
  const unred = (
    await call("POST", "/v1/learn/marks", { action: "unred", pointId: POINT })
  ).json().data;
  assert.equal(unred.red, false);
  const row = store.db
    .prepare("SELECT * FROM map_points WHERE user_id=? AND point_id=?")
    .get(userId, POINT);
  await attempt("2");
  assert.deepEqual(
    store.db
      .prepare("SELECT * FROM map_points WHERE user_id=? AND point_id=?")
      .get(userId, POINT),
    row,
  );
  assert.equal(matcher.calls.length, 1);
  const exported = (await call("GET", "/v1/me/export")).json();
  assert.equal(exported.mistakes[0].mapPointId, POINT);
  assert.equal(exported.mistakes[0].mapVersion, 1);
  assert.deepEqual((await other("GET", "/v1/me/export")).json().mistakes, []);
  assert.deepEqual(
    (await call("GET", `/v1/materials/${id}/study`)).json().data.mapPoint,
    linked,
  );
  assert.equal(
    matcher.calls.length,
    1,
    "a correct answer and its study read reuse the existing link",
  );
  const edited = await call("PUT", `/v1/materials/${id}`, {
    expectedVersion: 1,
    text: "求复合函数的导数。",
    confirm: true,
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(
    (await call("GET", `/v1/materials/${id}/study`)).json().data.mapPoint,
    null,
  );
  assert.equal(
    matcher.calls.length,
    1,
    "an edited source hides the stale link without reclassifying",
  );
});
