// 0.6.0 “AI 再出一道” : the points an AI-made problem can be checked
// for, the check kinds that fit each (see shared/claims.ts) and what to make.
// Every other point has no AI problem: its answers are proofs, words or
// numbers the program cannot confirm, so the button is hidden.
export type PointPractice = { kinds: string[]; scope: string };

const LIMIT = ["limit"];
const DERIVATIVE = ["derivative"];
const ANTIDERIVATIVE = ["antiderivative"];
const DEFINITE = ["definite"];

export const POINT_PRACTICE: Record<string, PointPractice> = {
  "limit-one-sided": {
    kinds: LIMIT,
    scope: "求一个单侧极限（x 从左侧或右侧趋于某一点），如含 e^{1/x}、arctan(1/x)、|x|/x 的式子",
  },
  "limit-rules": {
    kinds: LIMIT,
    scope: "求一个函数极限：0/0 型约去公因式或根式有理化，或 x→∞ 时多项式之比",
  },
  "limit-important-sin": {
    kinds: LIMIT,
    scope: "求一个含三角函数的 0/0 型极限，用第一个重要极限 sin x/x→1",
  },
  "limit-important-e": {
    kinds: LIMIT,
    scope: "求一个 1^∞ 型极限，凑成第二个重要极限 (1+1/x)^x→e",
  },
  "limit-equivalent": {
    kinds: LIMIT,
    scope: "求一个 0/0 型极限，用等价无穷小替换乘除中的因子",
  },
  "limit-1-to-inf": {
    kinds: LIMIT,
    scope: "求一个幂指函数的 1^∞ 型极限",
  },
  "derivative-rules": {
    kinds: DERIVATIVE,
    scope: "给出显式函数 y=f(x)，用求导公式和四则运算法则求 y′",
  },
  "derivative-chain": {
    kinds: DERIVATIVE,
    scope: "给出显式复合函数 y=f(x)，用链式法则求 y′",
  },
  "derivative-second": {
    kinds: DERIVATIVE,
    scope: "给出显式函数 y=f(x)，求二阶导数 y″（核对项加 \"order\":2）",
  },
  "derivative-log": {
    kinds: DERIVATIVE,
    scope: "给出显式幂指函数 y=u(x)^{v(x)}，用对数求导法求 y′",
  },
  "application-lhopital": {
    kinds: LIMIT,
    scope: "求一个 0/0 或 ∞/∞ 型极限，用洛必达法则",
  },
  "application-lhopital-other": {
    kinds: LIMIT,
    scope: "求一个 0·∞、∞−∞ 或 0^0、∞^0 型极限，先变形再用洛必达法则",
  },
  "application-taylor-limit": {
    kinds: LIMIT,
    scope: "求一个 0/0 型极限，用麦克劳林公式展开到合适的阶",
  },
  "application-monotonic": {
    kinds: ["monotonic"],
    scope: "给一个具体函数，问它的一个单调增加或单调减少区间",
  },
  "application-extremum": {
    kinds: ["extremum"],
    scope: "给一个具体函数，求它的极大值或极小值（写数值）",
  },
  "application-root-count": {
    kinds: ["roots"],
    scope: "给一个具体函数，问方程在给定区间内实根的个数",
  },
  "indefinite-basic": {
    kinds: ANTIDERIVATIVE,
    scope: "求一个不定积分：先拆项或恒等变形，再用基本积分公式",
  },
  "indefinite-substitution-1": {
    kinds: ANTIDERIVATIVE,
    scope: "求一个不定积分，用第一类换元法（凑微分）",
  },
  "indefinite-root-sub": {
    kinds: ANTIDERIVATIVE,
    scope: "求一个含根式 √(ax+b) 的不定积分，用根式代换",
  },
  "indefinite-trig-sub": {
    kinds: ANTIDERIVATIVE,
    scope: "求一个含 √(a²−x²)、√(a²+x²) 或 √(x²−a²) 的不定积分，用三角代换",
  },
  "indefinite-parts": {
    kinds: ANTIDERIVATIVE,
    scope: "求一个不定积分，用分部积分法",
  },
  "indefinite-rational": {
    kinds: ANTIDERIVATIVE,
    scope: "求一个有理函数的不定积分，拆成部分分式",
  },
  "indefinite-trig-rational": {
    kinds: ANTIDERIVATIVE,
    scope: "求一个三角函数有理式的不定积分，用三角恒等式或万能代换",
  },
  "definite-newton-leibniz": {
    kinds: DEFINITE,
    scope: "计算一个上下限都是具体数的定积分，用牛顿-莱布尼茨公式，可以含绝对值或分段",
  },
  "definite-substitution": {
    kinds: DEFINITE,
    scope: "计算一个上下限都是具体数的定积分，用换元法，积分限跟着换",
  },
  "definite-symmetry": {
    kinds: DEFINITE,
    scope: "计算一个对称区间 [−a,a] 上的定积分，用奇偶性化简",
  },
  "definite-parts": {
    kinds: DEFINITE,
    scope: "计算一个上下限都是具体数的定积分，用分部积分法",
  },
};
