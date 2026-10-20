import type { Problem } from "./problems.js";

// Deterministic extra variants for ★ points. Indexes 0 and 1 remain the
// original initial/review pair; these entries are appended as indexes 2+.
export const KEY_VARIANTS: Record<string, Problem[]> = {
  "limit-equivalent": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\tan 3x-\\sin 3x}{x^3}$。",
      answer: "27/2",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}\\frac{\\tan 4x-\\sin 4x}{x^3}$。",
      answer: "32",
    },
  ],
  "limit-1-to-inf": [
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}(\\cos x)^{3/x^2}$。",
      answer: "e^(-3/2)",
      note: "写精确值",
    },
    {
      kind: "number",
      text: "求 $\\lim_{x\\to 0}(\\cos 3x)^{2/x^2}$。",
      answer: "e^(-9)",
      note: "写精确值",
    },
  ],
  "limit-discontinuity": [
    {
      kind: "choice",
      text: "设 $f(x)$ 在 $x\\ne2,-1$ 时等于 $\\dfrac{x^2-4}{x-2}+\\dfrac1{x+1}$，并另定义 $f(2)=5$。判断下列两处的间断点类型。",
      questions: [
        {
          prompt: "$x=2$ 处属于哪一类？",
          options: [
            { id: "A", text: "跳跃间断点" },
            { id: "B", text: "可去间断点" },
            { id: "C", text: "无穷间断点" },
            { id: "D", text: "振荡间断点" },
          ],
          answer: "B",
        },
        {
          prompt: "$x=-1$ 处属于哪一类？",
          options: [
            { id: "A", text: "可去间断点" },
            { id: "B", text: "跳跃间断点" },
            { id: "C", text: "无穷间断点" },
            { id: "D", text: "振荡间断点" },
          ],
          answer: "C",
        },
      ],
      hint: "先约去可约因子，再分别检查函数值和无界项。",
      explanation: "$x=2$ 附近第一项可约为 $x+2$，极限存在但不等于 $f(2)$，是可去间断点；$x=-1$ 附近 $1/(x+1)$ 无界，是无穷间断点。",
    },
    {
      kind: "choice",
      text: "设 $g(x)=\\dfrac{x-3}{|x-3|}+\\sin\\dfrac1{x+1}$，定义域不含 $3$ 与 $-1$。判断下列两处的间断点类型。",
      questions: [
        {
          prompt: "$x=3$ 处属于哪一类？",
          options: [
            { id: "A", text: "可去间断点" },
            { id: "B", text: "无穷间断点" },
            { id: "C", text: "振荡间断点" },
            { id: "D", text: "跳跃间断点" },
          ],
          answer: "D",
        },
        {
          prompt: "$x=-1$ 处属于哪一类？",
          options: [
            { id: "A", text: "振荡间断点" },
            { id: "B", text: "跳跃间断点" },
            { id: "C", text: "可去间断点" },
            { id: "D", text: "无穷间断点" },
          ],
          answer: "A",
        },
      ],
      hint: "符号函数看左右极限；正弦项看自变量是否无限振荡。",
      explanation: "$x=3$ 处正弦项连续，而符号项左右极限相差 $2$，所以是跳跃间断点；$x=-1$ 处 $\\sin(1/(x+1))$ 没有极限，是振荡间断点。",
    },
  ],
  "derivative-piecewise": [
    {
      kind: "multi",
      text: "设 $f(x)=ax+b$（$x<1$），$f(x)=x^2+2x$（$x\\ge1$）。要使 $f$ 在 $x=1$ 处可导，求常数 $a,b$。",
      parts: [
        { label: "参数 a", kind: "number", answer: "4" },
        { label: "参数 b", kind: "number", answer: "-1" },
      ],
    },
    {
      kind: "multi",
      text: "设 $f(x)=ax+b$（$x<2$），$f(x)=2x^2-x$（$x\\ge2$）。要使 $f$ 在 $x=2$ 处可导，求常数 $a,b$。",
      parts: [
        { label: "参数 a", kind: "number", answer: "7" },
        { label: "参数 b", kind: "number", answer: "-8" },
      ],
    },
  ],
  "derivative-higher": [
    {
      kind: "expr",
      text: "设 $y=x^2e^{-x}$，求 $y^{(6)}$。",
      answer: "e^(-x)*(x^2-12*x+30)",
    },
    {
      kind: "expr",
      text: "设 $y=x^2e^{-x}$，求 $y^{(4)}$。",
      answer: "e^(-x)*(x^2-8*x+12)",
    },
  ],
  "derivative-implicit": [
    {
      kind: "multi",
      text: "方程 $x^2+y^2=5$ 在点 $(1,2)$ 附近确定可导函数 $y=y(x)$。求该点的一阶导数与二阶导数。",
      parts: [
        { label: "一阶导数", kind: "number", answer: "-1/2" },
        { label: "二阶导数", kind: "number", answer: "-5/8" },
      ],
    },
    {
      kind: "multi",
      text: "方程 $x^2+xy+y^2=7$ 在点 $(2,1)$ 附近确定可导函数 $y=y(x)$。求该点的一阶导数与二阶导数。",
      parts: [
        { label: "一阶导数", kind: "number", answer: "-5/4" },
        { label: "二阶导数", kind: "number", answer: "-21/32" },
      ],
    },
  ],
  "derivative-log": [
    {
      kind: "expr",
      text: "求 $y=x^{\\cos x}$（$x>0$）的导数 $y'$。",
      answer: "x^(cos(x))*(-sin(x)*ln(x)+cos(x)/x)",
      domain: "positive",
    },
    {
      kind: "expr",
      text: "求 $y=(1+x)^{\\sin x}$（$x>-1$）的导数 $y'$。",
      answer: "(1+x)^(sin(x))*(cos(x)*ln(1+x)+sin(x)/(1+x))",
    },
  ],
  "derivative-parametric": [
    {
      kind: "multi",
      text: "曲线由 $x=t^2$、$y=t^3$（$t>0$）给出。求 $t=1$ 时关于 $x$ 的一阶导数与二阶导数。",
      parts: [
        { label: "一阶导数", kind: "number", answer: "3/2" },
        { label: "二阶导数", kind: "number", answer: "3/4" },
      ],
    },
    {
      kind: "multi",
      text: "曲线由 $x=t^2+t$、$y=t^3-t$（$t>-1/2$）给出。求 $t=1$ 时关于 $x$ 的一阶导数与二阶导数。",
      parts: [
        { label: "一阶导数", kind: "number", answer: "2/3" },
        { label: "二阶导数", kind: "number", answer: "14/27" },
      ],
    },
  ],
  "application-mvt-proof": [
    {
      kind: "choice",
      text: "$f$ 在 $[1,2]$ 上连续、在 $(1,2)$ 内可导，且 $f(1)=16,f(2)=1$。欲证明存在 $\\xi\\in(1,2)$ 使 $\\xi f\\prime(\\xi)+4f(\\xi)=0$，选择两步正确论证。",
      questions: [
        {
          prompt: "哪一个辅助函数适合直接使用罗尔定理？",
          options: [
            { id: "A", text: "$F(x)=xf(x)$" },
            { id: "B", text: "$F(x)=f(x)/x^4$" },
            { id: "C", text: "$F(x)=x^4f(x)$" },
          ],
          answer: "C",
        },
        {
          prompt: "对于上一问正确的辅助函数，哪一步论证正确？",
          options: [
            { id: "A", text: "$F(1)=F(2)$，由罗尔定理得某点 $F'(\\xi)=\\xi^3[4f(\\xi)+\\xi f'(\\xi)]=0$。" },
            { id: "B", text: "端点值相等说明 $F$ 恒为常数。" },
            { id: "C", text: "只要开区间可导，就必有导数为零的点。" },
          ],
          answer: "A",
        },
      ],
    },
    {
      kind: "choice",
      text: "$f$ 在 $[1,4]$ 上连续、在 $(1,4)$ 内可导，且 $f(1)=16,f(4)=1$。欲证明存在 $\\xi\\in(1,4)$ 使 $\\xi f\\prime(\\xi)+2f(\\xi)=0$，选择两步正确论证。",
      questions: [
        {
          prompt: "哪一个辅助函数适合直接使用罗尔定理？",
          options: [
            { id: "A", text: "$F(x)=x^3f(x)$" },
            { id: "B", text: "$F(x)=x^2f(x)$" },
            { id: "C", text: "$F(x)=f(x)/x^2$" },
          ],
          answer: "B",
        },
        {
          prompt: "对于上一问正确的辅助函数，哪一步论证正确？",
          options: [
            { id: "A", text: "$F(1)=F(4)$，由罗尔定理得某点 $F'(\\xi)=\\xi[2f(\\xi)+\\xi f'(\\xi)]=0$。" },
            { id: "B", text: "可直接对端点不同的 $f$ 使用罗尔定理。" },
            { id: "C", text: "端点值相等说明区间内处处有 $F'=0$。" },
          ],
          answer: "A",
        },
      ],
    },
  ],
  "application-lhopital": [
    { kind: "number", text: "求 $\\lim_{x\\to0}\\dfrac{\\tan3x-3x}{x-\\sin x}$。", answer: "54" },
    { kind: "number", text: "求 $\\lim_{x\\to0}\\dfrac{\\tan x-x}{2x-\\sin2x}$。", answer: "1/4" },
  ],
  "application-lhopital-other": [
    { kind: "number", text: "求 $\\lim_{x\\to0}\\left(\\dfrac1x-\\dfrac3{e^{3x}-1}\\right)$。", answer: "3/2" },
    { kind: "number", text: "求 $\\lim_{x\\to0}\\left(\\dfrac1x-\\dfrac4{e^{4x}-1}\\right)$。", answer: "2" },
  ],
  "application-taylor-expand": [
    {
      kind: "multi",
      text: "在 $x\\to0$ 时，$e^x\\cos x=1+ax+bx^2+cx^3+o(x^3)$。求系数 $a,b,c$。",
      parts: [
        { label: "a", kind: "number", answer: "1" },
        { label: "b", kind: "number", answer: "0" },
        { label: "c", kind: "number", answer: "-1/3" },
      ],
    },
    {
      kind: "multi",
      text: "在 $x\\to0$ 时，$\\dfrac{\\sin2x}{1-x}=ax+bx^2+cx^3+o(x^3)$。求系数 $a,b,c$。",
      parts: [
        { label: "a", kind: "number", answer: "2" },
        { label: "b", kind: "number", answer: "2" },
        { label: "c", kind: "number", answer: "2/3" },
      ],
    },
  ],
  "application-taylor-limit": [
    { kind: "number", text: "求 $\\lim_{x\\to0}\\dfrac{\\cos2x-e^{-2x^2}}{x^4}$。", answer: "-4/3", note: "写精确值" },
    { kind: "number", text: "求 $\\lim_{x\\to0}\\dfrac{\\cos3x-e^{-9x^2/2}}{x^4}$。", answer: "-27/4", note: "写精确值" },
  ],
  "application-inequality": [
    {
      kind: "choice",
      text: "证明对所有 $x>0$ 都有 $\\arctan x<x$。请选择辅助函数和有效的单调性论证。",
      questions: [
        {
          prompt: "把所证不等式化为 $F(x)>0$，且 $F(0)=0$，可选哪个函数？",
          options: [
            { id: "A", text: "$F(x)=\\arctan x-x$" },
            { id: "B", text: "$F(x)=x-\\arctan x$" },
            { id: "C", text: "$F(x)=x+\\arctan x$" },
          ],
          answer: "B",
        },
        {
          prompt: "对上一问正确的 $F$，哪段推理有效？",
          options: [
            { id: "A", text: "$F'(x)<0$，所以 $F(x)>F(0)$。" },
            { id: "B", text: "只由 $F(0)=0$ 即可得到结论。" },
            { id: "C", text: "$F'(x)=x^2/(1+x^2)>0$，所以 $F(x)>F(0)=0$。" },
          ],
          answer: "C",
        },
      ],
    },
    {
      kind: "choice",
      text: "证明对所有 $x>0$ 都有 $1-e^{-x}<x$。请选择辅助函数和有效的单调性论证。",
      questions: [
        {
          prompt: "把所证不等式化为 $F(x)>0$，且 $F(0)=0$，可选哪个函数？",
          options: [
            { id: "A", text: "$F(x)=x-1+e^{-x}$" },
            { id: "B", text: "$F(x)=1-e^{-x}-x$" },
            { id: "C", text: "$F(x)=x+1-e^{-x}$" },
          ],
          answer: "A",
        },
        {
          prompt: "对上一问正确的 $F$，哪段推理有效？",
          options: [
            { id: "A", text: "$F'(x)=e^{-x}-1>0$。" },
            { id: "B", text: "函数值在零点为零，因此处处为正。" },
            { id: "C", text: "$F'(x)=1-e^{-x}>0$，所以 $F(x)>F(0)=0$。" },
          ],
          answer: "C",
        },
      ],
    },
  ],
  "application-optimization": [
    {
      kind: "multi",
      text: "用总长 $32$ 米的围栏围一个矩形，其中一边靠墙且不需要围栏。设垂直墙的边长为 $x$ 米。求面积最大时的 $x$ 与最大面积。",
      parts: [
        { label: "边长 x（米）", kind: "number", answer: "8" },
        { label: "最大面积（平方米）", kind: "number", answer: "128" },
      ],
    },
    {
      kind: "multi",
      text: "用总长 $60$ 米的围栏围一个矩形，其中一边靠墙且不需要围栏。设垂直墙的边长为 $x$ 米。求面积最大时的 $x$ 与最大面积。",
      parts: [
        { label: "边长 x（米）", kind: "number", answer: "15" },
        { label: "最大面积（平方米）", kind: "number", answer: "450" },
      ],
    },
  ],
  "application-sketch": [
    {
      kind: "choice",
      text: "考察函数 $f(x)=x^3-12x$ 的图形，分别选择正确结论。",
      questions: [
        {
          prompt: "哪个是函数的最大严格递减开区间？",
          options: [
            { id: "A", text: "$(-\\infty,-2)$" },
            { id: "B", text: "$(2,+\\infty)$" },
            { id: "C", text: "$(-2,2)$" },
          ],
          answer: "C",
        },
        {
          prompt: "哪个点是图形的拐点？",
          options: [
            { id: "A", text: "$(-2,16)$" },
            { id: "B", text: "$(0,0)$" },
            { id: "C", text: "$(2,-16)$" },
          ],
          answer: "B",
        },
      ],
    },
    {
      kind: "choice",
      text: "考察函数 $f(x)=(x+1)^3-3(x+1)+2$ 的图形，分别选择正确结论。",
      questions: [
        {
          prompt: "哪个是函数的最大严格递减开区间？",
          options: [
            { id: "A", text: "$(-\\infty,-2)$" },
            { id: "B", text: "$(-2,0)$" },
            { id: "C", text: "$(0,+\\infty)$" },
          ],
          answer: "B",
        },
        {
          prompt: "哪个点是图形的拐点？",
          options: [
            { id: "A", text: "$(-2,4)$" },
            { id: "B", text: "$(0,0)$" },
            { id: "C", text: "$(-1,2)$" },
          ],
          answer: "C",
        },
      ],
    },
  ],
  "indefinite-trig-sub": [
    {
      kind: "antiderivative",
      text: "求 $\\int\\dfrac{dx}{x^2\\sqrt{1+9x^2}}$。",
      answer: "-sqrt(1+9*x^2)/x + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int\\dfrac{dx}{x^2\\sqrt{1+16x^2}}$。",
      answer: "-sqrt(1+16*x^2)/x + C",
    },
  ],
  "indefinite-parts": [
    {
      kind: "antiderivative",
      text: "求 $\\int 2x\\arctan x\\,dx$。",
      answer: "(x^2+1)*arctan(x)-x + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int 18x\\arctan 3x\\,dx$。",
      answer: "(9*x^2+1)*arctan(3*x)-3*x + C",
    },
  ],
  "indefinite-rational": [
    {
      kind: "antiderivative",
      text: "求 $\\int\\dfrac{3x^2+3x+2}{(x+1)^2(x-1)}\\,dx$。",
      answer: "2*ln|x-1|+ln|x+1|+1/(x+1) + C",
    },
    {
      kind: "antiderivative",
      text: "求 $\\int\\dfrac{3x^2+3x-2}{(x+1)^2(x-1)}\\,dx$。",
      answer: "ln|x-1|+2*ln|x+1|-1/(x+1) + C",
    },
  ],
  "definite-ftc-limit": [
    { kind: "number", text: "求 $\\lim_{x\\to0}\\dfrac{\\int_0^x\\ln(1+3t^2)\\,dt}{x-\\sin x}$。", answer: "6" },
    { kind: "number", text: "求 $\\lim_{x\\to0}\\dfrac{\\int_0^x\\ln(1+4t^2)\\,dt}{x-\\sin x}$。", answer: "8" },
  ],
  "definite-substitution": [
    { kind: "number", text: "计算 $\\int_0^{\\ln2}2\\sqrt{e^x-1}\\,dx$。", answer: "4-pi", note: "写精确值" },
    { kind: "number", text: "计算 $\\int_0^{\\ln2}3\\sqrt{e^x-1}\\,dx$。", answer: "6-3*pi/2", note: "写精确值" },
  ],
  "definite-parts": [
    { kind: "number", text: "计算 $\\int_1^{e^3}(\\ln x)^2\\,dx$。", answer: "5*e^3-2", note: "写精确值" },
    { kind: "number", text: "计算 $\\int_1^{e^4}(\\ln x)^2\\,dx$。", answer: "10*e^4-2", note: "写精确值" },
  ],
  "definite-improper-inf": [
    { kind: "number", text: "计算 $\\int_{-\\infty}^{+\\infty}\\dfrac{dx}{x^2-6x+13}$。", answer: "pi/2", note: "写精确值" },
    { kind: "number", text: "计算 $\\int_{-\\infty}^{+\\infty}\\dfrac{3\\,dx}{x^2+8x+17}$。", answer: "3*pi", note: "写精确值" },
  ],
  "definite-improper-unbounded": [
    { kind: "number", text: "计算 $\\int_0^8\\dfrac{dx}{\\sqrt{|4-x|}}$。", answer: "8" },
    { kind: "number", text: "计算 $\\int_0^{13}\\dfrac{dx}{\\sqrt{|4-x|}}$。", answer: "10" },
  ],
  "definite-area-polar": [
    { kind: "number", text: "求心形线 $r=3(1+\\cos\\theta)$ 所围图形的面积。", answer: "27*pi/2", note: "写精确值" },
    { kind: "number", text: "求心形线 $r=4(1+\\cos\\theta)$ 所围图形的面积。", answer: "24*pi", note: "写精确值" },
  ],
  "definite-volume": [
    {
      kind: "multi",
      text: "由 $y=x$、$y=0$、$x=3$ 围成的平面区域，分别绕 $x$ 轴与 $y$ 轴旋转一周。求所得体积 $V_x,V_y$。",
      parts: [
        { label: "绕 x 轴的体积 Vₓ", kind: "number", answer: "9*pi" },
        { label: "绕 y 轴的体积 Vᵧ", kind: "number", answer: "18*pi" },
      ],
    },
    {
      kind: "multi",
      text: "由 $y=x^2$、$y=0$、$x=2$ 围成的平面区域，分别绕 $x$ 轴与 $y$ 轴旋转一周。求所得体积 $V_x,V_y$。",
      parts: [
        { label: "绕 x 轴的体积 Vₓ", kind: "number", answer: "32*pi/5" },
        { label: "绕 y 轴的体积 Vᵧ", kind: "number", answer: "8*pi" },
      ],
    },
  ],
  "ode-homogeneous": [
    {
      kind: "expr",
      text: "求 $y'=\\dfrac yx+\\dfrac{3x}y$ 满足 $y(1)=1$ 的特解。",
      answer: "x*sqrt(6*ln(x)+1)",
      note: "写 y 的显式表达式（取满足初值的正支，最大区间 x>e^(-1/6)）",
      onAnswerDomain: true,
    },
    {
      kind: "expr",
      text: "求 $y'=\\dfrac yx+\\dfrac xy$ 满足 $y(1)=3$ 的特解。",
      answer: "x*sqrt(2*ln(x)+9)",
      note: "写 y 的显式表达式（取满足初值的正支，最大区间 x>e^(-9/2)）",
      onAnswerDomain: true,
    },
  ],
  "ode-linear": [
    {
      kind: "expr",
      text: "求 $y'+\\dfrac yx=\\dfrac{\\sin x}x$ 满足 $y(\\pi/2)=2$ 的特解。",
      answer: "(pi-cos(x))/x",
    },
    {
      kind: "expr",
      text: "求 $y'+\\dfrac yx=\\dfrac{\\sin x}x$ 满足 $y(\\pi)=2$ 的特解。",
      answer: "(2*pi-1-cos(x))/x",
    },
  ],
  "ode-modeling": [
    {
      kind: "expr",
      text: "曲线 $y=y(x)$（$x>0$）过点 $(1,4)$，曲线上任一点处的切线在 $y$ 轴上的截距等于切点横坐标的三倍，求曲线方程。",
      answer: "x*(4-3*ln(x))",
      onAnswerDomain: true,
    },
    {
      kind: "expr",
      text: "曲线 $y=y(x)$（$x>0$）过点 $(1,1)$，曲线上任一点处的切线在 $y$ 轴上的截距等于切点横坐标的四倍，求曲线方程。",
      answer: "x*(1-4*ln(x))",
      onAnswerDomain: true,
    },
  ],
  "ode-integral-equation": [
    { kind: "expr", text: "设 $f(x)$ 连续，且 $f(x)=e^x+\\int_1^x f(t)\\,dt$，求 $f(x)$。", answer: "x*e^x" },
    { kind: "expr", text: "设 $f(x)$ 连续，且 $f(x)=e^x+\\int_2^x f(t)\\,dt$，求 $f(x)$。", answer: "(x-1)*e^x" },
  ],
  "ode-reduce-order": [
    {
      kind: "expr",
      text: "求 $y^3y''+2=0$ 满足 $y(1)=1$、$y'(1)=0$ 的特解。",
      answer: "sqrt(1-2*(x-1)^2)",
      note: "取满足初值的正支，最大区间 1-1/sqrt(2)<x<1+1/sqrt(2)",
    },
    {
      kind: "expr",
      text: "求 $y^3y''+9=0$ 满足 $y(1)=3$、$y'(1)=0$ 的特解。",
      answer: "sqrt(9-(x-1)^2)",
      note: "取满足初值的正支，最大区间 -2<x<4",
    },
  ],
  "ode-nonhomog-exp": [
    {
      kind: "expr",
      text: "求初值问题 $y''-y=e^{2x}$，$y(0)=0,y'(0)=0$ 的解。",
      answer: "e^(2*x)/3-e^x/2+e^(-x)/6",
    },
    {
      kind: "expr",
      text: "求初值问题 $y''-2y'+y=e^x$，$y(0)=0,y'(0)=0$ 的解。",
      answer: "x^2*e^x/2",
    },
  ],
  "ode-nonhomog-trig": [
    {
      kind: "expr",
      text: "求初值问题 $y''+y=\\cos x$，$y(0)=0,y'(0)=0$ 的解。",
      answer: "x*sin(x)/2",
    },
    {
      kind: "expr",
      text: "求初值问题 $y''+9y=\\sin3x$，$y(0)=0,y'(0)=0$ 的解。",
      answer: "(sin(3*x)-3*x*cos(3*x))/18",
    },
  ],
};
