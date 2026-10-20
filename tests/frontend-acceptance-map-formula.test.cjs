const test = require('node:test');
const assert = require('node:assert/strict');
const { starLayout } = require('../miniprogram/pages/map/stars');

test('map keeps legible short formulas and directs oversized formulas to detail', () => {
  const formula = (w) => [{ t: 'p', c: [{ t: 'math', w, h: 1.5, id: `math-${w}` }] }];
  const short = formula(3), long = formula(40);
  const layout = starLayout({
    points: [
      { id: 'short', name: 'Short', pos: { x: 50, y: 50 }, formulaBlocks: [short] },
      { id: 'long', name: 'Long', pos: { x: 50, y: 250 }, formulaBlocks: [long] },
    ],
  });
  assert.equal(layout.cards[0].formulaLong, false);
  assert.equal(layout.cards[1].formulaLong, true);
  assert.deepEqual(layout.cards[1].formula, long); // Full content remains available.
});

test('map text-only and absent formula data retain their existing fallback', () => {
  const layout = starLayout({ points: [
    { id: 'text', pos: { x: 50, y: 50 }, formulas: ['x=1'] },
    { id: 'empty', pos: { x: 50, y: 250 } },
  ] });
  assert.equal(layout.cards[0].formulaText, 'x=1');
  assert.equal(layout.cards[0].formulaLong, false);
  assert.equal(layout.cards[1].formulaLong, false);
});
