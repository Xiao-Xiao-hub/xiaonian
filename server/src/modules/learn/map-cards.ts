// v4 knowledge cards : for each of the 89 points, 1–3 formulas (TeX
// without `$`; the first goes on the map card) and exactly 3 key points.
// Keys are Markdown with inline `$…$` and at most one colour mark each
// (`[[k:…]]` 重点, `[[w:…]]` 方法, `[[f:…]]` 公式, `[[x:…]]` 易错, `!` after
// the letter for the stronger one). Scope and wording follow 同济《高等数学》
// 第八版上册. Drafted by AI and cross-checked by another model; not reviewed
// by a teacher.
export type MapCard = { formulas: string[]; keys: [string, string, string] };

// One colour mark: a known letter, optional `!`, no nesting.
export const CARD_MARK = /\[\[([kwfx])!?:((?:(?!\[\[|\]\]).)+?)\]\]/g;
// Problems with one key: bad or nested marks, more than one mark, too long.
export function keyProblems(key: string): string[] {
  const problems: string[] = [];
  const marks = [...key.matchAll(CARD_MARK)];
  const bare = key.replace(CARD_MARK, "$2");
  if (/\[\[|\]\]/.test(bare)) problems.push("bad mark");
  if (marks.length > 1) problems.push("more than one mark");
  const visible = Array.from(bare.replace(/\$[^$]*\$/g, "x")).length;
  if (visible > 34) problems.push(`too long (${visible})`);
  if (!bare.trim()) problems.push("empty");
  return problems;
}

export const MAP_CARDS: Record<string, MapCard> = {
  // ---------- 第 1 章 函数与极限 ----------
  "limit-function": {
    formulas: [
      "(f\\circ g)(x)=f[g(x)]",
      "y=f(x)\\Leftrightarrow x=f^{-1}(y)",
    ],
    keys: [
      "能复合的前提：[[x:内层的值域要落在外层的定义域里]]",
      "求反函数：先解出 $x$，再把 $x$、$y$ 对调",
      "反函数和原函数的图形[[k:关于 $y=x$ 对称]]",
    ],
  },
  "limit-epsilon-n": {
    formulas: [
      "\\forall\\varepsilon>0,\\ \\exists N\\in\\mathbb{N}_+,\\ n>N\\Rightarrow|x_n-a|<\\varepsilon",
    ],
    keys: [
      "[[k:$\\varepsilon$ 先任意给定，$N$ 跟着 $\\varepsilon$ 找]]，$N$ 不唯一",
      "证明思路：[[w:从 $|x_n-a|<\\varepsilon$ 倒推 $n$ 要多大]]",
      "可以先把 $|x_n-a|$ 适当放大，再解出 $N$",
    ],
  },
  "limit-epsilon-delta": {
    formulas: [
      "\\forall\\varepsilon>0,\\ \\exists\\delta>0,\\ 0<|x-x_0|<\\delta\\Rightarrow|f(x)-A|<\\varepsilon",
    ],
    keys: [
      "[[x:$0<|x-x_0|$ 表示不看 $x_0$ 这一点]]",
      "常先限定 $|x-x_0|<1$，再放缩找 $\\delta$",
      "最后 $\\delta$ 取几个限制里最小的那个",
    ],
  },
  "limit-one-sided": {
    formulas: [
      "\\lim_{x\\to x_0}f(x)=A\\Leftrightarrow f(x_0^-)=f(x_0^+)=A",
    ],
    keys: [
      "[[k!:极限存在 ⇔ 左右极限都存在且相等]]",
      "分段点、$e^{1/x}$、$\\arctan\\frac{1}{x}$ 在 0 处要分左右算",
      "极限和 $f(x_0)$ 有没有定义、等于多少无关",
    ],
  },
  "limit-infinitesimal": {
    formulas: [
      "\\lim f(x)=A\\Leftrightarrow f(x)=A+\\alpha,\\ \\alpha\\to0",
      "f(x)\\to\\infty\\Rightarrow\\frac{1}{f(x)}\\to0",
    ],
    keys: [
      "无穷小是[[k:极限为 0 的变量]]，不是很小的数",
      "无穷大的倒数是无穷小，非零无穷小的倒数是无穷大",
      "[[x:无穷大一定无界，无界不一定是无穷大]]",
    ],
  },
  "limit-rules": {
    formulas: [
      "\\lim[f(x)\\pm g(x)]=\\lim f(x)\\pm\\lim g(x)",
      "\\lim\\frac{f(x)}{g(x)}=\\frac{\\lim f(x)}{\\lim g(x)}\\ (\\lim g(x)\\ne0)",
    ],
    keys: [
      "四则法则的前提：[[x:各部分的极限都存在]]",
      "$\\frac{0}{0}$ 型先[[w:约分或有理化]]；$x\\to\\infty$ 时多项式之比同除最高次幂",
      "有界函数乘无穷小，仍是无穷小",
    ],
  },
  "limit-squeeze": {
    formulas: [
      "y_n\\le x_n\\le z_n,\\ \\lim y_n=\\lim z_n=a\\Rightarrow\\lim x_n=a",
    ],
    keys: [
      "[[k:上下两边的极限必须相等]]，才能夹出结果",
      "$n$ 项和：[[w:用最小项和最大项各乘 $n$ 来夹]]",
      "放得太松，两边极限不相等，就夹不出来",
    ],
  },
  "limit-monotone": {
    formulas: [
      "\\{x_n\\}\\ \\text{单调有界}\\Rightarrow\\lim_{n\\to\\infty}x_n\\ \\text{存在}",
      "x_{n+1}=f(x_n),\\ x_n\\to a,\\ f\\ \\text{在}\\ a\\ \\text{连续}\\Rightarrow a=f(a)",
    ],
    keys: [
      "[[k:单调有界数列必有极限]]",
      "递推数列：[[w:先用归纳法证单调、有界]]",
      "[[x:先证极限存在，才能对递推式两边取极限]]",
    ],
  },
  "limit-important-sin": {
    formulas: [
      "\\lim_{x\\to0}\\frac{\\sin x}{x}=1",
      "\\lim_{x\\to0}\\frac{1-\\cos x}{x^2}=\\frac{1}{2}",
    ],
    keys: [
      "[[k:$\\sin$ 里面和分母要是同一个趋于 0 的量]]",
      "[[x:$x\\to\\infty$ 时 $\\frac{\\sin x}{x}\\to0$]]，不是 1",
      "常用 $1-\\cos x=2\\sin^2\\frac{x}{2}$ 来凑",
    ],
  },
  "limit-important-e": {
    formulas: [
      "\\lim_{x\\to\\infty}\\left(1+\\frac{1}{x}\\right)^x=e",
      "\\lim_{x\\to0}(1+x)^{\\frac{1}{x}}=e",
    ],
    keys: [
      "[[k:$1^\\infty$ 型]]都往它上凑",
      "[[w:底数里加的量和指数要互为倒数]]",
      "[[x:底数趋于 1、指数趋于 $\\infty$ 才是 $1^\\infty$ 型]]",
    ],
  },
  "limit-order": {
    formulas: [
      "\\lim\\frac{\\beta}{\\alpha}=0\\Rightarrow\\beta=o(\\alpha)",
      "\\lim\\frac{\\beta}{\\alpha}=1\\Rightarrow\\alpha\\sim\\beta",
      "\\lim\\frac{\\beta}{\\alpha^k}=c\\ne0\\ (k>0)\\Rightarrow\\beta\\text{ 是 }\\alpha\\text{ 的 }k\\text{ 阶无穷小}",
    ],
    keys: [
      "比值的极限：[[k:0 是高阶，1 是等价]]，非零常数是同阶",
      "$\\frac{\\beta}{\\alpha^k}\\to c\\ne0$，$\\beta$ 是 $\\alpha$ 的 $k$ 阶无穷小",
      "比较的两个量要是同一变化过程中的无穷小",
    ],
  },
  "limit-equivalent": {
    formulas: [
      "\\sin x\\sim\\tan x\\sim\\arcsin x\\sim x\\ (x\\to0)",
      "1-\\cos x\\sim\\frac{1}{2}x^2\\ (x\\to0)",
      "e^x-1\\sim\\ln(1+x)\\sim x\\ (x\\to0)",
    ],
    keys: [
      "[[k!:只替换乘除里的因子]]",
      "[[x:加减里别直接换]]，如 $\\tan x-\\sin x$",
      "先确认被换的量趋于 0，$x$ 可换成任一趋于 0 的式子",
    ],
  },
  "limit-1-to-inf": {
    formulas: [
      "u^v=e^{v\\ln u}\\ (u>0)",
      "u\\to1,\\ v\\to\\infty:\\ \\lim u^v=e^{\\lim v(u-1)}",
    ],
    keys: [
      "[[k:先认出 $1^\\infty$ 型]]，再化成 $e$ 的指数",
      "[[w:写成 $e^{v\\ln u}$，再用 $\\ln u\\sim u-1$]]",
      "指数上的极限算出来，别忘了最后放回 $e$ 上",
    ],
  },
  "limit-continuity": {
    formulas: [
      "\\lim_{x\\to x_0}f(x)=f(x_0)",
      "f(x_0^-)=f(x_0^+)=f(x_0)",
    ],
    keys: [
      "连续 = [[k:极限存在且等于函数值]]",
      "分段点要[[w:分别算左、右极限]]，再和函数值比",
      "初等函数在定义区间内都连续",
    ],
  },
  "limit-discontinuity": {
    formulas: [
      "\\text{可去：}\\lim_{x\\to x_0}f(x)\\ \\text{存在，但}\\ f(x_0)\\ \\text{无定义或不等于它}",
      "\\text{跳跃：}f(x_0^-)\\ne f(x_0^+)",
    ],
    keys: [
      "[[k:左右极限都存在]]是第一类，否则是第二类",
      "第一类里，左右极限相等是可去，不等是跳跃",
      "第二类常见无穷间断、振荡间断（如 $\\sin\\frac{1}{x}$ 在 0 处）",
    ],
  },
  "limit-zero-theorem": {
    formulas: [
      "f\\in C[a,b],\\ f(a)f(b)<0\\Rightarrow\\exists\\xi\\in(a,b),\\ f(\\xi)=0",
    ],
    keys: [
      "[[k:闭区间上连续、两端异号]]，缺一不可",
      "证方程有根：[[w:移项构造 $F(x)$，找两点异号]]",
      "只保证至少一个根，唯一还要加单调性",
    ],
  },
  "limit-uniform": {
    formulas: [
      "\\forall\\varepsilon>0,\\exists\\delta>0,\\ \\forall x_1,x_2\\in I,\\ |x_1-x_2|<\\delta\\Rightarrow|f(x_1)-f(x_2)|<\\varepsilon",
    ],
    keys: [
      "[[k:$\\delta$ 只和 $\\varepsilon$ 有关]]，对区间上所有点都管用",
      "闭区间上连续的函数一定一致连续",
      "反例：$\\frac{1}{x}$ 在 $(0,1)$ 内连续，但不一致连续",
    ],
  },

  // ---------- 第 2 章 导数与微分 ----------
  "derivative-definition": {
    formulas: [
      "f'(x_0)=\\lim_{\\Delta x\\to0}\\frac{f(x_0+\\Delta x)-f(x_0)}{\\Delta x}",
      "f'(x_0)=\\lim_{x\\to x_0}\\frac{f(x)-f(x_0)}{x-x_0}",
    ],
    keys: [
      "导数就是[[k:函数增量与自变量增量之比的极限]]",
      "[[w:凑成 $\\frac{f(x_0+\\square)-f(x_0)}{\\square}$]]，$\\square\\to0$",
      "[[x:可导必连续，连续不一定可导]]，如 $|x|$ 在 0 处",
    ],
  },
  "derivative-tangent": {
    formulas: [
      "y-y_0=f'(x_0)(x-x_0)",
      "y-y_0=-\\frac{1}{f'(x_0)}(x-x_0)\\ (f'(x_0)\\ne0)",
    ],
    keys: [
      "切线斜率就是[[k:$f'(x_0)$]]",
      "法线和切线垂直，斜率是 $-\\frac{1}{f'(x_0)}$",
      "[[x:$f'(x_0)=0$ 时法线是竖直线 $x=x_0$]]",
    ],
  },
  "derivative-piecewise": {
    formulas: [
      "f'(x_0)\\ \\text{存在}\\Leftrightarrow f'_-(x_0)=f'_+(x_0)",
      "f'_-(x_0)=\\lim_{x\\to x_0^-}\\frac{f(x)-f(x_0)}{x-x_0}",
    ],
    keys: [
      "分段点[[x:要用定义求左右导数]]，别直接套公式",
      "可导 ⇔ 左右导数都存在且相等",
      "[[w:先查连续]]：不连续就一定不可导",
    ],
  },
  "derivative-rules": {
    formulas: [
      "(uv)'=u'v+uv'",
      "\\left(\\frac{u}{v}\\right)'=\\frac{u'v-uv'}{v^2}",
      "(x^\\mu)'=\\mu x^{\\mu-1}",
    ],
    keys: [
      "[[k:基本求导公式要背熟]]，后面都靠它",
      "乘积：一个求导乘另一个，两项相加",
      "[[x:商的分子是 $u'v-uv'$，顺序别反]]",
    ],
  },
  "derivative-chain": {
    formulas: [
      "\\frac{dy}{dx}=\\frac{dy}{du}\\cdot\\frac{du}{dx}",
      "[f(g(x))]'=f'(g(x))\\,g'(x)",
    ],
    keys: [
      "[[w:由外往里一层层求导，再相乘]]",
      "[[x:别漏了最里层的导数]]",
      "例：$(\\sin x^2)'=2x\\cos x^2$",
    ],
  },
  "derivative-second": {
    formulas: [
      "y''=\\frac{d}{dx}\\left(\\frac{dy}{dx}\\right)",
      "(e^{ax})''=a^2e^{ax}",
    ],
    keys: [
      "二阶导数就是[[k:对一阶导数再求一次导]]",
      "先把一阶导数化简，再求二阶",
      "运动中，位移的二阶导数是加速度",
    ],
  },
  "derivative-higher": {
    formulas: [
      "(uv)^{(n)}=\\sum_{k=0}^{n}C_n^ku^{(n-k)}v^{(k)}",
      "(\\sin x)^{(n)}=\\sin\\left(x+\\frac{n\\pi}{2}\\right)",
      "\\left(\\frac{1}{x+a}\\right)^{(n)}=\\frac{(-1)^nn!}{(x+a)^{n+1}}",
    ],
    keys: [
      "[[w:先求前几阶，找出规律]]",
      "莱布尼茨公式：[[k:系数和二项式展开一样]]",
      "一个因子是多项式时，它的高阶导很快为 0，只剩几项",
    ],
  },
  "derivative-implicit": {
    formulas: ["x^2+y^2=1\\Rightarrow2x+2y\\,y'=0", "\\frac{d}{dx}\\left(y^2\\right)=2y\\,y'"],
    keys: [
      "[[w:两边对 $x$ 求导，把 $y$ 看成 $x$ 的函数]]",
      "[[x:对 $y$ 的函数求导，别漏乘 $y'$]]",
      "求二阶导时，把求出的 $y'$ 代回去",
    ],
  },
  "derivative-log": {
    formulas: [
      "y=u^v\\ (u>0)\\Rightarrow\\ln y=v\\ln u",
      "\\frac{y'}{y}=v'\\ln u+\\frac{vu'}{u}",
    ],
    keys: [
      "适合[[k:幂指函数和多个因子连乘除]]",
      "[[w:先取对数再求导]]，最后乘回 $y$",
      "[[x:$x^x$ 不能套幂函数或指数函数的公式]]",
    ],
  },
  "derivative-parametric": {
    formulas: [
      "\\frac{dy}{dx}=\\frac{y'(t)}{x'(t)}\\ (x'(t)\\ne0)",
      "\\frac{d^2y}{dx^2}=\\frac{d}{dt}\\left(\\frac{dy}{dx}\\right)\\Big/x'(t)",
    ],
    keys: [
      "一阶：[[k:$y$ 对 $t$ 的导数除以 $x$ 对 $t$ 的导数]]",
      "[[x:二阶导不是 $\\frac{y''(t)}{x''(t)}$]]",
      "二阶：一阶的结果对 $t$ 求导，再除以 $x'(t)$",
    ],
  },
  "derivative-related-rates": {
    formulas: ["\\frac{dy}{dt}=f'(x)\\frac{dx}{dt}"],
    keys: [
      "[[w:先写出变量间的关系式，再两边对 $t$ 求导]]",
      "已知一个变化率，求另一个变化率",
      "[[x:求完导再代入那一时刻的数值]]",
    ],
  },
  "derivative-differential": {
    formulas: ["dy=f'(x)\\,dx", "\\Delta y=dy+o(\\Delta x)"],
    keys: [
      "[[f:$dy=f'(x)dx$]]，求微分就是求导再乘 $dx$",
      "一元函数可微与可导等价",
      "微分形式不变：$u$ 是中间变量时 $dy=f'(u)du$ 也成立",
    ],
  },

  // ---------- 第 3 章 微分中值定理与导数的应用 ----------
  "application-mvt": {
    formulas: [
      "f(b)-f(a)=f'(\\xi)(b-a),\\ \\xi\\in(a,b)",
      "f(a)=f(b)\\Rightarrow\\exists\\xi\\in(a,b),\\ f'(\\xi)=0",
    ],
    keys: [
      "条件：[[k:闭区间上连续，开区间内可导]]",
      "罗尔定理多一条：两端函数值相等",
      "拉格朗日：曲线上有一点的切线平行于两端连线",
    ],
  },
  "application-mvt-proof": {
    formulas: [
      "F(x)=e^xf(x)\\Rightarrow F'(x)=e^x[f(x)+f'(x)]",
      "F(x)=xf(x)\\Rightarrow F'(x)=f(x)+xf'(x)",
    ],
    keys: [
      "[[w:把结论里的 $\\xi$ 换成 $x$，看它是谁的导数]]",
      "构造出 $F$ 后，验证它满足罗尔定理的条件",
      "要两个不同的中值点，常[[w:分成两段各用一次中值定理]]",
    ],
  },
  "application-cauchy": {
    formulas: [
      "\\frac{f(b)-f(a)}{g(b)-g(a)}=\\frac{f'(\\xi)}{g'(\\xi)},\\ \\xi\\in(a,b)\\ (g'(x)\\ne0)",
    ],
    keys: [
      "[[k:分子分母用的是同一个 $\\xi$]]",
      "条件里还要求 $g'(x)\\ne0$",
      "[[x:不能分子分母各用一次拉格朗日]]，两个 $\\xi$ 未必相同",
    ],
  },
  "application-lhopital": {
    formulas: ["\\lim\\frac{f(x)}{g(x)}=\\lim\\frac{f'(x)}{g'(x)}"],
    keys: [
      "[[x!:只用于 $\\frac{0}{0}$ 或 $\\frac{\\infty}{\\infty}$ 型]]",
      "[[w:分子分母分别求导]]，不是对整个商求导",
      "还要[[x:导数之比的极限存在或为 $\\infty$]]",
    ],
  },
  "application-lhopital-other": {
    formulas: ["fg=\\frac{f}{1/g}", "u^v=e^{v\\ln u}\\ (u>0)"],
    keys: [
      "$0\\cdot\\infty$：[[w:把一个因子放到分母上]]，化成分式",
      "$\\infty-\\infty$：先通分或有理化",
      "$0^0$、$1^\\infty$、$\\infty^0$：先化成 $e^{v\\ln u}$",
    ],
  },
  "application-taylor-expand": {
    formulas: [
      "e^x=1+x+\\frac{x^2}{2!}+\\cdots+\\frac{x^n}{n!}+o(x^n)",
      "\\sin x=x-\\frac{x^3}{3!}+o(x^3)",
      "\\ln(1+x)=x-\\frac{x^2}{2}+\\frac{x^3}{3}+o(x^3)",
    ],
    keys: [
      "[[k:$e^x$、$\\sin x$、$\\cos x$、$\\ln(1+x)$、$(1+x)^\\alpha$ 要背熟]]",
      "$x^n$ 项的系数是 $\\frac{f^{(n)}(0)}{n!}$",
      "带皮亚诺余项 $o(x^n)$ 的展开只管 $x\\to0$ 附近",
    ],
  },
  "application-taylor-limit": {
    formulas: [
      "\\tan x-\\sin x=\\frac{x^3}{2}+o(x^3)",
      "x-\\sin x=\\frac{x^3}{6}+o(x^3)",
    ],
    keys: [
      "适合[[k:加减里不能等价替换]]的情况",
      "[[w:展开到能确定分子、分母的最低非零项]]",
      "[[x:展开的阶数不够，结果会算错]]",
    ],
  },
  "application-taylor-remainder": {
    formulas: [
      "R_n(x)=\\frac{f^{(n+1)}(\\xi)}{(n+1)!}(x-x_0)^{n+1}",
      "|R_n(x)|\\le\\frac{M}{(n+1)!}|x-x_0|^{n+1}",
    ],
    keys: [
      "拉格朗日余项能[[k:估计误差有多大]]",
      "$\\xi$ 在 $x_0$ 和 $x$ 之间",
      "[[w:用 $|f^{(n+1)}|$ 的上界 $M$ 放大]]",
    ],
  },
  "application-monotonic": {
    formulas: [
      "f'(x)>0\\Rightarrow f(x)\\ \\text{单调增加}",
      "f'(x)<0\\Rightarrow f(x)\\ \\text{单调减少}",
    ],
    keys: [
      "[[w:用驻点和导数不存在的点把区间分段]]",
      "每段看 $f'(x)$ 的正负",
      "[[x:个别点 $f'=0$ 不影响单调]]，如 $x^3$",
    ],
  },
  "application-inequality": {
    formulas: [
      "F=f-g\\in C[a,b],\\ F(a)=0,\\ F'(x)>0\\ (a<x<b)\\Rightarrow F(x)>0\\ (a<x\\le b)",
    ],
    keys: [
      "[[w:移项作差，构造 $F(x)$]]",
      "用 $F$ 的单调性或最值证 $F(x)>0$",
      "一阶导看不出正负时，再求二阶导",
    ],
  },
  "application-convexity": {
    formulas: [
      "f''(x)>0\\Rightarrow\\text{凹}",
      "f''(x)<0\\Rightarrow\\text{凸}",
    ],
    keys: [
      "同济的说法：[[x:$f''>0$ 是凹，$f''<0$ 是凸]]",
      "拐点是连续曲线上[[k:凹凸发生改变的点]]",
      "$f''(x_0)=0$ 不一定是拐点，拐点写成 $(x_0,f(x_0))$",
    ],
  },
  "application-extremum": {
    formulas: [
      "f'(x_0)=0,\\ f''(x_0)<0\\Rightarrow\\text{极大值}",
      "f'(x_0)=0,\\ f''(x_0)>0\\Rightarrow\\text{极小值}",
    ],
    keys: [
      "可能的极值点：[[k:驻点和导数不存在的点]]",
      "第一充分条件：看两侧 $f'(x)$ 是否变号",
      "闭区间最值：[[w:比较候选点和端点的函数值]]",
    ],
  },
  "application-optimization": {
    formulas: ["f'(x)=0"],
    keys: [
      "[[w:设变量、列目标函数、写清定义域]]",
      "求导找驻点",
      "实际问题[[k:确有最值且驻点唯一]]，它就是最值点",
    ],
  },
  "application-root-count": {
    formulas: [
      "f\\ \\text{在}\\ [a,b]\\ \\text{上连续且严格单调},\\ f(a)f(b)<0\\Rightarrow\\text{恰有一个根}",
    ],
    keys: [
      "[[w:按单调区间分段，每段看两端符号]]",
      "零点定理保证有根，单调保证最多一个",
      "含参数时，可分离参数，看水平线和曲线交几次",
    ],
  },
  "application-asymptote": {
    formulas: [
      "\\lim_{x\\to x_0^+}f(x)=\\infty\\ \\text{或}\\ \\lim_{x\\to x_0^-}f(x)=\\infty\\Rightarrow x=x_0",
      "\\lim_{x\\to\\infty}f(x)=b\\Rightarrow y=b",
      "k=\\lim_{x\\to\\infty}\\frac{f(x)}{x},\\ b=\\lim_{x\\to\\infty}[f(x)-kx]",
    ],
    keys: [
      "铅直渐近线：[[k:找让函数趋于 $\\infty$ 的点]]",
      "斜渐近线：先求 $k$，再求 $b$",
      "[[x:$x\\to+\\infty$ 和 $x\\to-\\infty$ 要分开看]]",
    ],
  },
  "application-sketch": {
    formulas: ["f'\\ \\text{的符号定单调},\\ f''\\ \\text{的符号定凹凸}"],
    keys: [
      "[[w:定义域、奇偶性、$f'$ 和 $f''$ 列表、渐近线]]",
      "列表把单调、凹凸、极值、拐点放在一起看",
      "再描几个特殊点，按列表的结果分段连线",
    ],
  },
  "application-curvature": {
    formulas: [
      "K=\\frac{|y''|}{(1+y'^2)^{3/2}}",
      "\\rho=\\frac{1}{K}",
    ],
    keys: [
      "[[f:分母是 $(1+y'^2)$ 的 $\\frac{3}{2}$ 次方]]",
      "曲率半径是曲率的倒数",
      "直线曲率为 0，半径为 $R$ 的圆曲率为 $\\frac{1}{R}$",
    ],
  },
  "application-curvature-center": {
    formulas: [
      "\\alpha=x-\\frac{y'(1+y'^2)}{y''}",
      "\\beta=y+\\frac{1+y'^2}{y''}",
    ],
    keys: [
      "曲率中心在[[k:法线上，曲线凹的那一侧]]",
      "到曲线上该点的距离等于曲率半径",
      "曲率圆和曲线在该点切线、凹向、曲率都相同",
    ],
  },
  "application-newton": {
    formulas: ["x_{n+1}=x_n-\\frac{f(x_n)}{f'(x_n)}"],
    keys: [
      "切线法：[[k:用切线与 $x$ 轴的交点逼近根]]",
      "先用零点定理和单调性，定出只含一个根的区间",
      "二分法：每次取中点，把区间缩小一半",
    ],
  },

  // ---------- 第 4 章 不定积分 ----------
  "indefinite-basic": {
    formulas: [
      "\\int x^\\mu dx=\\frac{x^{\\mu+1}}{\\mu+1}+C\\ (\\mu\\ne-1)",
      "\\int\\frac{1}{x}dx=\\ln|x|+C",
    ],
    keys: [
      "[[x:不定积分别忘了 $+C$]]",
      "积分是求导的逆运算，[[w:结果求导可以验算]]",
      "$\\int\\frac{1}{x}dx$ 的结果要带绝对值",
    ],
  },
  "indefinite-substitution-1": {
    formulas: [
      "\\int f[\\varphi(x)]\\varphi'(x)\\,dx=\\left[\\int f(u)\\,du\\right]_{u=\\varphi(x)}",
      "x\\,dx=\\frac{1}{2}d(x^2)",
    ],
    keys: [
      "[[w:把 $\\varphi'(x)dx$ 凑成 $d\\varphi(x)$]]",
      "常见：$\\frac{1}{x}dx=d(\\ln|x|)$，$\\cos x\\,dx=d(\\sin x)$",
      "[[x:最后要把 $u$ 换回 $x$]]",
    ],
  },
  "indefinite-root-sub": {
    formulas: ["\\sqrt[n]{ax+b}=t\\Rightarrow x=\\frac{t^n-b}{a}"],
    keys: [
      "[[w:令根式整体为 $t$]]，去掉根号",
      "同时有 $\\sqrt{x}$ 和 $\\sqrt[3]{x}$ 时，令 $x=t^6$",
      "[[x:换元后 $dx$ 也要跟着换]]",
    ],
  },
  "indefinite-trig-sub": {
    formulas: [
      "\\sqrt{a^2-x^2}:\\ x=a\\sin t",
      "\\sqrt{a^2+x^2}:\\ x=a\\tan t",
      "\\sqrt{x^2-a^2}:\\ x=a\\sec t",
    ],
    keys: [
      "[[w:看根号里的形式选代换]]",
      "回代时画直角三角形找三角函数值",
      "限定 $t$ 的范围，开根号时符号才确定",
    ],
  },
  "indefinite-parts": {
    formulas: ["\\int u\\,dv=uv-\\int v\\,du"],
    keys: [
      "按“反对幂三指”的顺序优先选 $u$",
      "目标是让 $\\int v\\,du$ 比原来好算",
      "$e^x\\sin x$ 型[[w:分部两次后解方程]]",
    ],
  },
  "indefinite-rational": {
    formulas: [
      "\\frac{A}{(x-a)^k},\\ \\frac{Mx+N}{(x^2+px+q)^k}\\ (p^2-4q<0)",
    ],
    keys: [
      "[[x:假分式先做除法]]，化成多项式加真分式",
      "分母因式分解，[[w:拆成部分分式]]",
      "不可约二次单因式项，配方后积成 $\\ln$ 和 $\\arctan$",
    ],
  },
  "indefinite-trig-rational": {
    formulas: [
      "u=\\tan\\frac{x}{2}",
      "\\sin x=\\frac{2u}{1+u^2},\\ \\cos x=\\frac{1-u^2}{1+u^2},\\ dx=\\frac{2}{1+u^2}du",
    ],
    keys: [
      "[[k:万能代换总能化成有理函数的积分]]",
      "计算量大，[[w:能凑微分就先别用]]",
      "只含 $\\tan x$ 时，可直接令 $u=\\tan x$",
    ],
  },

  // ---------- 第 5、6 章 定积分及其应用 ----------
  "definite-concept": {
    formulas: [
      "\\int_a^bf(x)dx=\\lim_{\\lambda\\to0}\\sum_{i=1}^nf(\\xi_i)\\Delta x_i",
    ],
    keys: [
      "几何意义：[[k:曲边梯形面积的代数和]]",
      "$x$ 轴下方的部分算负",
      "定积分是一个数，和积分变量用什么字母无关",
    ],
  },
  "definite-properties": {
    formulas: [
      "m(b-a)\\le\\int_a^bf(x)dx\\le M(b-a)",
      "\\int_a^bf(x)dx=\\int_a^cf(x)dx+\\int_c^bf(x)dx",
    ],
    keys: [
      "估值：[[w:先求 $f$ 在区间上的最大值和最小值]]",
      "$a<b$ 且 $f\\le g$ 时，$\\int_a^bf\\,dx\\le\\int_a^bg\\,dx$",
      "保序的推论：$a<b$ 时 $\\left|\\int_a^bf\\,dx\\right|\\le\\int_a^b|f|\\,dx$",
    ],
  },
  "definite-riemann-sum": {
    formulas: [
      "\\lim_{n\\to\\infty}\\frac{1}{n}\\sum_{i=1}^nf\\left(\\frac{i}{n}\\right)=\\int_0^1f(x)dx",
    ],
    keys: [
      "[[w:提出 $\\frac{1}{n}$，把每项凑成 $f(\\frac{i}{n})$]]",
      "$\\frac{i}{n}$ 对应 $x$，$\\frac{1}{n}$ 对应 $dx$",
      "凑不成这个形式时，可先用夹逼放缩",
    ],
  },
  "definite-mvt-proof": {
    formulas: [
      "\\int_a^bf(x)dx=f(\\xi)(b-a),\\ \\xi\\in[a,b]",
    ],
    keys: [
      "条件：[[k:$f$ 在闭区间上连续]]",
      "$f(\\xi)$ 就是 $f$ 在 $[a,b]$ 上的平均值",
      "常和罗尔定理配合：先找出两个函数值相等的点",
    ],
  },
  "definite-ftc-derivative": {
    formulas: [
      "\\frac{d}{dx}\\int_a^xf(t)dt=f(x)\\ (f\\ \\text{连续})",
      "\\frac{d}{dx}\\int_{\\psi(x)}^{\\varphi(x)}f(t)dt=f[\\varphi(x)]\\varphi'(x)-f[\\psi(x)]\\psi'(x)",
    ],
    keys: [
      "[[k:上限代入被积函数，再乘上限的导数]]",
      "下限是变量时，减去同样的一项",
      "被积函数含 $x$ 时，[[x:只能提出与积分变量无关的因子]]",
    ],
  },
  "definite-ftc-limit": {
    formulas: [
      "\\lim_{x\\to0}\\frac{\\int_0^xf(t)dt}{g(x)}=\\lim_{x\\to0}\\frac{f(x)}{g'(x)}\\ (\\frac{0}{0}\\ \\text{型},\\ f\\ \\text{连续})",
    ],
    keys: [
      "多是[[k:$\\frac{0}{0}$ 型，用洛必达]]",
      "变限积分求导后，常再配合等价替换",
      "[[x:求导时上下限的导数别漏乘]]",
    ],
  },
  "definite-newton-leibniz": {
    formulas: ["\\int_a^bf(x)dx=F(b)-F(a)"],
    keys: [
      "[[k:$F$ 是 $f$ 的任意一个原函数]]",
      "条件：$f$ 在 $[a,b]$ 上连续",
      "[[x:区间内有无界点就不能直接用]]，如 $\\int_{-1}^1\\frac{1}{x^2}dx$",
    ],
  },
  "definite-substitution": {
    formulas: [
      "\\int_a^bf(x)dx=\\int_\\alpha^\\beta f[\\varphi(t)]\\varphi'(t)dt\\ (\\varphi(\\alpha)=a,\\ \\varphi(\\beta)=b)",
    ],
    keys: [
      "[[k!:换元必换限]]",
      "换限后直接算，不用换回原变量",
      "只凑微分、不写出新变量时，上下限不变",
    ],
  },
  "definite-symmetry": {
    formulas: [
      "f\\ \\text{连续且为奇函数}:\\ \\int_{-a}^af(x)dx=0",
      "f\\ \\text{连续且为偶函数}:\\ \\int_{-a}^af(x)dx=2\\int_0^af(x)dx",
    ],
    keys: [
      "[[w:对称区间先看奇偶]]",
      "拆开后，奇函数那部分直接为 0",
      "周期为 $T$ 的函数，在任一长 $T$ 的区间上积分相等",
    ],
  },
  "definite-parts": {
    formulas: ["\\int_a^bu\\,dv=[uv]_a^b-\\int_a^bv\\,du"],
    keys: [
      "选 $u$ 的方法和不定积分一样",
      "[[x:$uv$ 那一项也要代上下限]]",
      "$\\int_0^{\\pi/2}\\sin^nx\\,dx$ 有递推公式，可直接用",
    ],
  },
  "definite-reflection": {
    formulas: [
      "\\int_a^bf(x)dx=\\int_a^bf(a+b-x)dx",
      "\\int_0^\\pi xf(\\sin x)dx=\\frac{\\pi}{2}\\int_0^\\pi f(\\sin x)dx",
    ],
    keys: [
      "[[w:令 $x=a+b-t$]]，积分区间不变",
      "和原式相加，常能消掉难积的部分",
      "适合被积函数在区间两端有对称关系的题",
    ],
  },
  "definite-improper-inf": {
    formulas: [
      "\\int_a^{+\\infty}f(x)dx=\\lim_{t\\to+\\infty}\\int_a^tf(x)dx",
      "\\int_1^{+\\infty}\\frac{dx}{x^p}:\\ p>1\\ \\text{收敛}",
    ],
    keys: [
      "[[k:先积到 $t$，再让 $t$ 取极限]]",
      "[[x:两端都是无穷要拆开]]，两段都收敛才收敛",
      "$\\int_1^{+\\infty}\\frac{dx}{x^p}$：$p>1$ 收敛，$p\\le1$ 发散",
    ],
  },
  "definite-improper-unbounded": {
    formulas: [
      "\\int_a^bf(x)dx=\\lim_{t\\to a^+}\\int_t^bf(x)dx",
      "\\int_0^1\\frac{dx}{x^q}:\\ q<1\\ \\text{收敛}",
    ],
    keys: [
      "[[x!:先找瑕点]]，别当普通定积分算",
      "瑕点在区间内部，要拆成两段",
      "$\\int_0^1\\frac{dx}{x^q}$：$q<1$ 收敛，$q\\ge1$ 发散",
    ],
  },
  "definite-improper-test": {
    formulas: [
      "0\\le f(x)\\le g(x):\\ \\int_a^{+\\infty}g\\,dx\\ \\text{收敛}\\Rightarrow\\int_a^{+\\infty}f\\,dx\\ \\text{收敛}",
    ],
    keys: [
      "[[w:找一个 $p$ 积分来比较]]",
      "大的收敛，小的也收敛；小的发散，大的也发散",
      "绝对收敛的反常积分一定收敛",
    ],
  },
  "definite-area": {
    formulas: [
      "A=\\int_a^b[f(x)-g(x)]dx",
      "A=\\int_c^d[\\psi(y)-\\varphi(y)]dy",
    ],
    keys: [
      "[[w:先画图、求交点]]，定出积分限",
      "对 $x$ 积分是上减下，对 $y$ 积分是右减左",
      "选积分变量，尽量让区域不用分块",
    ],
  },
  "definite-area-polar": {
    formulas: ["A=\\frac{1}{2}\\int_\\alpha^\\beta\\rho^2(\\theta)d\\theta"],
    keys: [
      "[[x:别漏了前面的 $\\frac{1}{2}$]]",
      "先定 $\\theta$ 的范围，看曲线转多少",
      "利用对称性，只算一部分再乘倍数",
    ],
  },
  "definite-volume": {
    formulas: [
      "V_x=\\pi\\int_a^bf^2(x)dx",
      "V_y=2\\pi\\int_a^bx|f(x)|dx\\ (0\\le a<b)",
    ],
    keys: [
      "绕 $x$ 轴：[[k:把截面圆的面积 $\\pi f^2$ 积起来]]",
      "绕 $y$ 轴常用柱壳法，被积式是 $2\\pi x|f(x)|$",
      "截面是圆环时，[[x:外半径平方减内半径平方，再乘 $\\pi$]]",
    ],
  },
  "definite-arc-length": {
    formulas: [
      "s=\\int_a^b\\sqrt{1+y'^2}\\,dx",
      "s=\\int_\\alpha^\\beta\\sqrt{x'^2(t)+y'^2(t)}\\,dt",
      "s=\\int_\\alpha^\\beta\\sqrt{\\rho^2+\\rho'^2}\\,d\\theta",
    ],
    keys: [
      "[[k:直角、参数、极坐标三种形式]]",
      "根号里常能凑成完全平方",
      "[[x:弧长的积分下限要小于上限]]",
    ],
  },
  "definite-physics": {
    formulas: ["W=\\int_a^bF(x)dx", "dF=\\rho g\\,x\\,l(x)\\,dx"],
    keys: [
      "[[w:元素法：取一小段，写出 $dW$ 或 $dF$ 再积分]]",
      "抽水做功：每层水的重力乘它被提升的高度",
      "水压力：深 $x$ 处压强 $\\rho gx$，乘小横条面积",
    ],
  },

  // ---------- 第 7 章 微分方程 ----------
  "ode-concept": {
    formulas: ["F(x,y,y',\\cdots,y^{(n)})=0"],
    keys: [
      "[[k:阶数看出现的最高阶导数]]",
      "通解里独立任意常数的个数等于阶数",
      "特解：用初始条件定出常数",
    ],
  },
  "ode-separable": {
    formulas: [
      "\\frac{dy}{dx}=f(x)g(y)\\Rightarrow\\int\\frac{dy}{g(y)}=\\int f(x)dx",
    ],
    keys: [
      "[[w:$x$、$y$ 各归一边，两边积分]]",
      "两边积分后只写一个常数 $C$",
      "[[x:除以 $g(y)$ 时，可能丢掉 $g(y)=0$ 的解]]",
    ],
  },
  "ode-homogeneous": {
    formulas: [
      "\\frac{dy}{dx}=\\varphi\\left(\\frac{y}{x}\\right)",
      "u=\\frac{y}{x},\\ \\frac{dy}{dx}=u+x\\frac{du}{dx}",
    ],
    keys: [
      "[[w:令 $u=\\frac{y}{x}$，化成可分离变量方程]]",
      "[[x:$y'=u+xu'$，别漏了前面的 $u$]]",
      "解完把 $u$ 换回 $\\frac{y}{x}$",
    ],
  },
  "ode-linear": {
    formulas: [
      "y'+P(x)y=Q(x)",
      "y=e^{-\\int P(x)dx}\\left[\\int Q(x)e^{\\int P(x)dx}dx+C\\right]",
    ],
    keys: [
      "[[k:先化成标准形 $y'+P(x)y=Q(x)$]]",
      "公式里的 $\\int P(x)dx$ 不用再加常数",
      "也可以用常数变易法，结果相同",
    ],
  },
  "ode-bernoulli": {
    formulas: ["y'+P(x)y=Q(x)y^n\\ (n\\ne0,1)", "z=y^{1-n}"],
    keys: [
      "[[w:令 $z=y^{1-n}$，化成一阶线性方程]]",
      "先除以 $y^n$，[[x:别漏查 $y=0$ 是否为解]]",
      "其他题也常把方程里反复出现的整体设成新变量",
    ],
  },
  "ode-modeling": {
    formulas: ["\\frac{dx}{dt}=kx\\Rightarrow x=Ce^{kt}"],
    keys: [
      "[[w:把“变化率”翻成导数]]，列出方程",
      "曲线问题：切线斜率就是 $y'$",
      "别忘了用初始条件定出常数",
    ],
  },
  "ode-integral-equation": {
    formulas: [
      "f(x)=\\int_0^xf(t)dt+x\\Rightarrow f'(x)=f(x)+1,\\ f(0)=0",
    ],
    keys: [
      "[[w:两边求导，化成微分方程]]",
      "[[k:令 $x$ 等于积分下限，得到初始条件]]",
      "[[x:被积函数含 $x$ 时，不能直接套变限积分求导]]",
    ],
  },
  "ode-reduce-order": {
    formulas: [
      "y''=f(x,y'):\\ \\text{令}\\ y'=p",
      "y''=f(y,y'):\\ \\text{令}\\ y'=p,\\ y''=p\\frac{dp}{dy}",
    ],
    keys: [
      "[[k:缺 $y$ 令 $y'=p$；缺 $x$ 令 $y''=p\\frac{dp}{dy}$]]",
      "$y^{(n)}=f(x)$：连续积分 $n$ 次",
      "每积分一次就多一个任意常数",
    ],
  },
  "ode-structure": {
    formulas: ["y=C_1y_1+C_2y_2", "y=Y+y^*"],
    keys: [
      "二阶齐次通解：[[k:两个线性无关解]]的线性组合",
      "非齐次通解 = 对应齐次的通解 + 一个特解",
      "同一非齐次方程的两解之差，是对应齐次方程的解",
    ],
  },
  "ode-variation": {
    formulas: [
      "y^*=C_1(x)y_1+C_2(x)y_2",
      "C_1'y_1+C_2'y_2=0,\\ C_1'y_1'+C_2'y_2'=f(x)",
    ],
    keys: [
      "[[w:把齐次通解里的常数换成函数]]",
      "解出 $C_1'$、$C_2'$，再分别积分",
      "[[x:方程要先化成 $y''$ 系数为 1 的形式]]",
    ],
  },
  "ode-const-homog": {
    formulas: [
      "r^2+pr+q=0",
      "y=C_1e^{r_1x}+C_2e^{r_2x}\\ (r_1\\ne r_2\\ \\text{为实根})",
      "y=e^{\\alpha x}(C_1\\cos\\beta x+C_2\\sin\\beta x)",
    ],
    keys: [
      "[[w:写出特征方程，按根的三种情况写通解]]",
      "重根：$y=(C_1+C_2x)e^{rx}$",
      "共轭复根 $\\alpha\\pm i\\beta$ 对应 $\\cos\\beta x$、$\\sin\\beta x$",
    ],
  },
  "ode-nonhomog-exp": {
    formulas: [
      "f(x)=P_m(x)e^{\\lambda x}",
      "y^*=x^kQ_m(x)e^{\\lambda x}",
    ],
    keys: [
      "[[k:$k$ 看 $\\lambda$ 是几重特征根]]：不是取 0，单根取 1，重根取 2",
      "$Q_m$ 和 $P_m$ 同次，系数待定",
      "代回原方程，比较系数",
    ],
  },
  "ode-nonhomog-trig": {
    formulas: [
      "f(x)=e^{\\lambda x}[P_l(x)\\cos\\omega x+P_n(x)\\sin\\omega x]",
      "y^*=x^ke^{\\lambda x}[R_m(x)\\cos\\omega x+S_m(x)\\sin\\omega x]",
    ],
    keys: [
      "[[k:$\\lambda+i\\omega$ 是特征根取 $k=1$，否则 $k=0$]]",
      "$m$ 取 $l$、$n$ 中较大的",
      "[[x:只有 $\\cos$ 一项，也要设 $\\cos$ 和 $\\sin$ 两项]]",
    ],
  },
  "ode-euler": {
    formulas: [
      "x^ny^{(n)}+p_1x^{n-1}y^{(n-1)}+\\cdots+p_ny=f(x)",
      "x=e^t:\\ xy'=Dy,\\ x^2y''=D(D-1)y",
    ],
    keys: [
      "[[w:令 $x=e^t$，化成常系数线性方程]]",
      "$D$ 表示对 $t$ 求导",
      "解完把 $t$ 换回 $\\ln x$",
    ],
  },
  "ode-system": {
    formulas: ["\\begin{cases}x'=ax+by\\\\y'=cx+dy\\end{cases}"],
    keys: [
      "[[w:消元：化成一个未知函数的高阶方程]]",
      "解出一个函数后，代回求另一个",
      "代回若还需积分，[[x:所得常数须满足原方程组]]",
    ],
  },
};
