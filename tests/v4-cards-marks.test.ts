import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/src/shared/store.js";
import { CardService, plainText } from "../server/src/modules/cards/service.js";
import { validateTidy } from "../server/src/modules/cards/tidy.js";
import { CrisisSafetyService } from "../server/src/modules/safety/service.js";
import { ResumeService } from "../server/src/modules/resume/service.js";

function setup() {
  const store = new SqliteStore(":memory:");
  const user = store.upsertUser("dev:v4-marks", "甲", "dev").id;
  let date = new Date("2026-10-01T02:00:00.000Z");
  store.db
    .prepare("UPDATE users SET data=json_set(data,'$.createdAt',?) WHERE id=?")
    .run(date.toISOString(), user);
  const clock = () => new Date(date);
  const safety = new CrisisSafetyService({ noul: async () => 0 });
  const cards = new CardService(store, safety, clock);
  const resume = new ResumeService(store, cards, safety, clock);
  return {
    store,
    user,
    cards,
    resume,
    set: (value: string) => {
      date = new Date(value);
    },
  };
}

test("card slots: old field is plain text, slotsMarked keeps the marks", async () => {
  const s = setup();
  try {
    const { card } = await s.cards.create(s.user, {
      text: "求导前要不要先化简",
      type: "method",
    });
    s.cards.applyAIData(s.user, card.id, card.version, {
      summary: "先化简再求导",
      slots: [
        { key: "when", text: "分式求导前" },
        { key: "steps", text: "先[[k:约分]]再求导，[[x!:别漏负号]]" },
      ],
    });
    const detail = s.cards.detail(s.user, card.id);
    const listed = s.cards.list(s.user).data.find((c) => c.id === card.id)!;
    for (const view of [detail, listed]) {
      const plain = JSON.stringify(view.slots);
      assert.ok(!plain.includes("[["), plain);
      assert.ok(!plain.includes("]]"), plain);
      assert.deepEqual(
        (view.slots as { text: string }[]).map((x) => x.text),
        ["分式求导前", "先约分再求导，别漏负号"],
      );
      assert.equal(
        (view.slotsMarked as { text: string }[])[1]!.text,
        "先[[k:约分]]再求导，[[x!:别漏负号]]",
      );
      assert.ok(!String(view.summary).includes("[["));
    }
    // The stored row keeps the original (export reads it as is).
    const row = s.store.db
      .prepare("SELECT slots FROM cards WHERE id=?")
      .get(card.id) as { slots: string };
    assert.ok(row.slots.includes("[[k:约分]]"));
  } finally {
    s.store.close();
  }
});

test("a long slot with a mark is saved without the mark instead of failing the tidy", async () => {
  const s = setup();
  try {
    const { card } = await s.cards.create(s.user, {
      text: "求导前要不要先化简",
      type: "method",
    });
    const words = "先把分式化成最简的形式再求导，可以少写很多步，也不容易在通分的时候把符号弄错，最后再检查定义域";
    assert.equal(words.length, 47);
    const long = `${words.slice(0, 20)}[[k:${words.slice(20, 30)}]]${words.slice(30)}${"啊".repeat(11)}`;
    const view = s.cards.detail(s.user, card.id);
    const data = validateTidy(
      {
        title: "先化简再求导",
        summary: "先化简再求导",
        slots: [
          { key: "when", text: "分式求导前[[k:先化简]]" },
          { key: "steps", text: long },
        ],
        open: [],
        followup: { q: "下一步", options: ["一", "二"] },
        tags: [],
      },
      view,
    );
    const steps = data.slots!.find((x) => x.key === "steps")!.text;
    assert.equal(steps, `${words}${"啊".repeat(11)}`.slice(0, 58));
    assert.ok(steps.length <= 60);
    assert.equal(data.slots!.find((x) => x.key === "when")!.text, "分式求导前[[k:先化简]]");
    s.cards.applyAIData(s.user, card.id, view.version, data);
    const after = s.cards.detail(s.user, card.id);
    assert.deepEqual(
      (after.slotsMarked as { text: string }[]).map((x) => x.text),
      ["分式求导前[[k:先化简]]", steps],
    );
  } finally {
    s.store.close();
  }
});

test("editing slots: unchanged plain text keeps its marks, an edited slot is stored as typed", async () => {
  const s = setup();
  try {
    const { card } = await s.cards.create(s.user, {
      text: "求导前要不要先化简",
      type: "method",
    });
    const tidied = s.cards.applyAIData(s.user, card.id, card.version, {
      slots: [
        { key: "when", text: "[[w:分式]]求导前" },
        { key: "steps", text: "先[[k:约分]]再求导" },
      ],
    });
    const version = tidied.version;
    const before = s.cards.detail(s.user, card.id);
    const edited = await s.cards.update(s.user, card.id, version, {
      slots: [
        { key: "when", text: (before.slots as { text: string }[])[0]!.text },
        { key: "steps", text: "先通分再求导" },
      ],
    });
    const marked = edited.card.slotsMarked as { key: string; text: string }[];
    assert.equal(marked.find((x) => x.key === "when")!.text, "[[w:分式]]求导前");
    assert.equal(marked.find((x) => x.key === "steps")!.text, "先通分再求导");
  } finally {
    s.store.close();
  }
});

test("plainText drops colour marks, formulas inside included", () => {
  const out = plainText("先[[k:约分]]，再看[[f:$x^2$]]的系数");
  assert.ok(!out.includes("[["), out);
  assert.ok(!out.includes("]]"), out);
  assert.ok(out.includes("约分"));
});

test("回顾卡 已完成: closes a card that has 我的话; without it, asks for one line first", async () => {
  const s = setup();
  try {
    const clear = (
      await s.cards.create(s.user, {
        text: "周末去图书馆过第三章",
        type: "idea",
      })
    ).card;
    await s.cards.mine(s.user, clear.id, clear.version, {
      text: "周六上午去图书馆把第三章过一遍",
    });
    s.set("2026-10-03T02:00:00Z");
    const item = s.resume.open(s.user, "v4-done").item!;
    assert.equal(item.card!.id, clear.id);
    assert.equal(item.canClose, true);
    const done = await s.resume.act(s.user, item.id, {
      action: "answer",
      text: "已完成",
    });
    assert.equal(done.crisis, false);
    const closed = s.cards.detail(s.user, clear.id);
    assert.equal(closed.stage, "closed");
    assert.ok(closed.closedAt);
    assert.equal(
      s.cards.list(s.user, { closed: true }).data.some((c) => c.id === clear.id),
      true,
    );
  } finally {
    s.store.close();
  }
  const t = setup();
  try {
    const bare = (
      await t.cards.create(t.user, { text: "想把这周的任务安排清楚", type: "idea" })
    ).card;
    t.set("2026-10-03T02:00:00Z");
    const item = t.resume.open(t.user, "v4-bare").item!;
    assert.equal(item.card!.id, bare.id);
    const reply = await t.resume.act(t.user, item.id, {
      action: "answer",
      text: "已完成",
    });
    assert.equal(reply.offerClose, true);
    assert.notEqual(t.cards.detail(t.user, bare.id).stage, "closed");
  } finally {
    t.store.close();
  }
});

test("回顾卡 还在进行 counts as not now", async () => {
  const s = setup();
  try {
    const card = (
      await s.cards.create(s.user, { text: "想把这周的任务安排清楚", type: "idea" })
    ).card;
    s.set("2026-10-03T02:00:00Z");
    const item = s.resume.open(s.user, "v4-going").item!;
    await s.resume.act(s.user, item.id, { action: "answer", text: "还在进行" });
    assert.equal(s.cards.detail(s.user, card.id).stage, "written");
    assert.notEqual(
      s.resume.list(s.user).find((i) => i.id === item.id)?.state,
      "done",
    );
  } finally {
    s.store.close();
  }
});
