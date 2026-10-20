/*
 * 资料复习页：读取到期材料，展示卡片正反面并提交记得或忘了；不处理地图做题进度。
 * 界面结构与样式见同目录 WXML/WXSS；网络与登录通过 utils 公共模块衔接。
 */
const api = require("../../utils/api");
const gate = require("../../utils/gate");
const studyClock = require("../../utils/study-clock");
const { typeset } = require("../../utils/tex");
const { today, dueText, errorText, highlightNumbers, stripLead, KIND, sourceOf } = require("../../utils/format");
function decorate(card) {
  return {
    ...card,
    kindText: KIND[card.kind],
    parts: highlightNumbers(card.question),
    steps: (card.steps || []).map(stripLead),
    stepBlocks: [],
    points: card.points || [],
    sourceText: sourceOf(card.answer).text,
    sourceTone: sourceOf(card.answer).tone,
    // A problem with no answer and no steps has nothing to check a recall
    // against: no 看答案, no 没记住/记住了 for it.
    checkable: card.kind !== "problem" || Boolean(card.answer) || Boolean((card.steps || []).length),
  };
}
// Due cards one at a time: recall first, then flip, then say whether it stuck.
Page(studyClock.track({
  data: {
    today: "",
    loading: true,
    error: "",
    loadFailed: false,
    cards: [],
    index: 0,
    card: null,
    flipped: false,
    busy: false,
    done: 0,
    upcoming: [],
    counts: { due: 0, total: 0 },
  },
  onShow() {
    if (!gate.check()) return;
    this.setData({ today: today() });
    this.load();
  },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },
  load() {
    this.setData({ loading: true, error: "", loadFailed: false });
    return api
      .get("/v1/reviews")
      .then((list) => {
        this.setData({
          cards: list.due.map(decorate),
          upcoming: list.upcoming.map((item) => ({
            ...item,
            kindText: KIND[item.kind],
            due: dueText(item.dueOn),
          })),
          counts: list.counts,
        });
        this.show(0);
      })
      .catch((error) => {
        if (!api.needsConsent(error)) this.setData({ error: errorText(error), loadFailed: true });
      })
      .finally(() => this.setData({ loading: false }));
  },
  show(index) {
    const card = this.data.cards[index] || null;
    this.setData({ index, card, flipped: false });
    if (!card) return;
    // Formulas in the problem, the points, the answer and the steps are typeset.
    const still = () => this.data.card && this.data.card.id === card.id;
    typeset(
      this,
      [
        ["card.questionBlocks", card.question],
        ...card.points.map((p, i) => [`card.points[${i}].blocks`, p.explanation]),
        ["card.answerBlocks", card.answer ? card.answer.value : "", { inline: true }],
        ...card.steps.map((text, i) => [`card.stepBlocks[${i}]`, text]),
        ["card.textBlocks", card.text],
      ],
      still,
    );
  },
  // Leaves a card that cannot be checked yet for later, without grading it.
  skip() {
    if (this.data.index + 1 < this.data.cards.length) this.show(this.data.index + 1);
  },
  flip() {
    this.setData({ flipped: true });
  },
  remembered() {
    this.answer("remembered");
  },
  forgot() {
    this.answer("forgot");
  },
  answer(outcome) {
    const card = this.data.card;
    if (!card || this.data.busy) return;
    this.setData({ busy: true, error: "" });
    api
      .post(`/v1/reviews/${card.id}`, { outcome })
      .then((next) => {
        wx.showToast({ title: `${dueText(next.dueOn)}再看`, icon: "none" });
        this.setData({ done: this.data.done + 1 });
        if (this.data.index + 1 < this.data.cards.length) this.show(this.data.index + 1);
        else return this.load();
      })
      .catch((error) => !api.needsConsent(error) && this.setData({ error: errorText(error) }))
      .finally(() => this.setData({ busy: false }));
  },
  openCard() {
    const card = this.data.card;
    if (card) api.openMaterial({ id: card.materialId, kind: card.kind, status: "confirmed" });
  },
  openUpcoming(event) {
    const item = this.data.upcoming[event.currentTarget.dataset.index];
    if (item) api.openMaterial({ id: item.materialId, kind: item.kind, status: "confirmed" });
  },
  openLibrary() {
    require("../../utils/learn").backTo("pages/library/index");
  },
}));
