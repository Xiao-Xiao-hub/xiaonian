// v4 star map : hand-placed star centres, one coordinate system per
// chapter, in the logical px of the far view on a 375-wide phone.
// 第一章的手工坐标已经向上调整 150 个逻辑像素。
// `label` is where the name sits: "below" the star or to its "left".
// `routes` overrides the drawn polyline of one edge ("from>to"), only where the
// rules in map-lines.ts would cross a star or a name.
export type LabelSide = "below" | "left";
export type StarPos = { x: number; y: number; label: LabelSide };
export type ChapterPos = {
  width: number;
  height: number;
  points: Record<string, StarPos>;
  routes?: Record<string, [number, number][]>;
};
const b = (x: number, y: number): StarPos => ({ x, y, label: "below" });
const l = (x: number, y: number): StarPos => ({ x, y, label: "left" });

export const MAP_POS: Record<string, ChapterPos> = {
  limit: {
    width: 375,
    height: 470,
    points: {
      "limit-function": l(128, 42),
      "limit-one-sided": l(128, 84),
      "limit-infinitesimal": l(128, 126),
      "limit-epsilon-n": l(335, 84),
      "limit-epsilon-delta": l(335, 126),
      "limit-rules": b(128, 174),
      "limit-squeeze": b(48, 174),
      "limit-monotone": b(262, 174),
      "limit-important-sin": b(48, 260),
      "limit-order": b(128, 260),
      "limit-important-e": b(208, 260),
      "limit-continuity": b(290, 260),
      "limit-equivalent": b(128, 340),
      "limit-discontinuity": b(208, 340),
      "limit-uniform": b(335, 340),
      "limit-1-to-inf": b(128, 420),
      "limit-zero-theorem": b(250, 420),
    },
  },
  derivative: {
    width: 375,
    height: 480,
    points: {
      "derivative-definition": b(128, 42),
      "derivative-piecewise": b(48, 126),
      "derivative-rules": b(128, 126),
      "derivative-tangent": b(48, 210),
      "derivative-chain": b(128, 210),
      "derivative-differential": b(208, 210),
      "derivative-second": b(128, 294),
      "derivative-log": b(208, 294),
      "derivative-higher": b(48, 378),
      "derivative-parametric": b(128, 378),
      "derivative-implicit": b(208, 378),
      "derivative-related-rates": l(335, 440),
    },
  },
  application: {
    width: 420,
    height: 500,
    points: {
      "application-lhopital": b(48, 42),
      "application-mvt": b(128, 42),
      "application-mvt-proof": b(208, 42),
      "application-cauchy": l(380, 90),
      "application-lhopital-other": b(48, 126),
      "application-monotonic": b(128, 126),
      "application-inequality": b(208, 126),
      "application-taylor-expand": b(288, 126),
      "application-taylor-remainder": b(380, 126),
      "application-asymptote": b(48, 210),
      "application-convexity": b(128, 210),
      "application-extremum": b(208, 210),
      "application-taylor-limit": b(288, 210),
      "application-sketch": b(128, 294),
      "application-optimization": b(208, 294),
      "application-root-count": l(380, 300),
      "application-curvature": b(128, 378),
      "application-curvature-center": l(380, 420),
      "application-newton": l(380, 460),
    },
  },
  indefinite: {
    width: 375,
    height: 330,
    points: {
      "indefinite-basic": b(128, 42),
      "indefinite-substitution-1": b(128, 126),
      "indefinite-root-sub": b(48, 210),
      "indefinite-trig-sub": b(128, 210),
      "indefinite-parts": b(208, 210),
      "indefinite-rational": b(288, 210),
      "indefinite-trig-rational": l(335, 280),
    },
  },
  definite: {
    width: 470,
    height: 620,
    points: {
      "definite-concept": b(200, 42),
      "definite-ftc-derivative": b(120, 126),
      "definite-properties": b(200, 126),
      "definite-mvt-proof": l(430, 170),
      "definite-ftc-limit": b(120, 210),
      "definite-newton-leibniz": b(200, 210),
      "definite-riemann-sum": l(430, 250),
      "definite-reflection": b(40, 294),
      "definite-substitution": b(120, 294),
      "definite-parts": b(280, 294),
      "definite-symmetry": b(360, 294),
      "definite-improper-inf": b(134, 378),
      "definite-area": b(200, 378),
      "definite-physics": l(430, 420),
      "definite-area-polar": b(200, 462),
      "definite-volume": b(280, 462),
      "definite-arc-length": b(360, 462),
      "definite-improper-unbounded": b(134, 546),
      "definite-improper-test": l(430, 590),
    },
  },
  ode: {
    width: 400,
    height: 680,
    points: {
      "ode-concept": b(48, 42),
      "ode-separable": b(208, 126),
      "ode-homogeneous": b(288, 126),
      "ode-integral-equation": b(128, 210),
      "ode-linear": b(208, 210),
      "ode-modeling": b(288, 210),
      "ode-reduce-order": b(208, 294),
      "ode-bernoulli": l(368, 294),
      "ode-structure": b(48, 378),
      "ode-variation": b(368, 378),
      "ode-const-homog": b(48, 462),
      "ode-system": l(368, 500),
      "ode-nonhomog-exp": b(48, 546),
      "ode-euler": l(368, 590),
      "ode-nonhomog-trig": b(48, 630),
    },
  },
};
