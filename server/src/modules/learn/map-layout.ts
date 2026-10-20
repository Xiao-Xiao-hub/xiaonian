import { strict as assert } from "node:assert";
import type { LearnMap, MapChapter } from "./calc-map.js";

export type MapLine = "main" | "side";
export type SideKind = "up" | "exam" | "extra";
export type MapNode = { id: string; name?: string; members: string[] };
export type MapSide = { parent: string; members: string[] };

const side: Record<string, SideKind> = {
  "limit-epsilon-n": "up",
  "limit-epsilon-delta": "up",
  "limit-uniform": "extra",
  "derivative-related-rates": "extra",
  "application-cauchy": "exam",
  "application-taylor-remainder": "exam",
  "application-root-count": "up",
  "application-curvature-center": "exam",
  "application-newton": "extra",
  "indefinite-trig-rational": "up",
  "definite-riemann-sum": "exam",
  "definite-mvt-proof": "up",
  "definite-improper-test": "exam",
  "definite-physics": "up",
  "ode-bernoulli": "exam",
  "ode-euler": "exam",
  "ode-variation": "extra",
  "ode-system": "extra",
};
const key = new Set([
  "limit-equivalent",
  "limit-1-to-inf",
  "limit-discontinuity",
  "derivative-piecewise",
  "derivative-higher",
  "derivative-implicit",
  "derivative-log",
  "derivative-parametric",
  "application-mvt-proof",
  "application-lhopital",
  "application-lhopital-other",
  "application-taylor-expand",
  "application-taylor-limit",
  "application-optimization",
  "application-sketch",
  "application-inequality",
  "indefinite-trig-sub",
  "indefinite-parts",
  "indefinite-rational",
  "definite-ftc-limit",
  "definite-substitution",
  "definite-parts",
  "definite-improper-inf",
  "definite-improper-unbounded",
  "definite-area-polar",
  "definite-volume",
  "ode-homogeneous",
  "ode-linear",
  "ode-modeling",
  "ode-integral-equation",
  "ode-reduce-order",
  "ode-nonhomog-exp",
  "ode-nonhomog-trig",
]);
const hard = new Set([
  "limit-squeeze",
  "limit-monotone",
  "application-mvt-proof",
  "application-inequality",
  "definite-reflection",
  "ode-integral-equation",
]);
const nodes: Record<string, MapNode[]> = {
  limit: [
    {
      id: "limit-n1",
      name: "极限入门",
      members: ["limit-function", "limit-one-sided", "limit-infinitesimal"],
    },
    { id: "limit-n2", members: ["limit-rules"] },
    {
      id: "limit-n3",
      name: "准则与重要极限",
      members: [
        "limit-squeeze",
        "limit-monotone",
        "limit-important-sin",
        "limit-important-e",
      ],
    },
    {
      id: "limit-n4",
      name: "比较与替换",
      members: ["limit-order", "limit-equivalent", "limit-1-to-inf"],
    },
    {
      id: "limit-n5",
      name: "连续与间断",
      members: ["limit-continuity", "limit-discontinuity"],
    },
    { id: "limit-n6", members: ["limit-zero-theorem"] },
  ],
  derivative: [
    {
      id: "derivative-n1",
      name: "导数起步",
      members: ["derivative-definition", "derivative-piecewise"],
    },
    {
      id: "derivative-n2",
      name: "求导法则",
      members: ["derivative-rules", "derivative-chain", "derivative-tangent"],
    },
    {
      id: "derivative-n3",
      name: "高阶导数",
      members: ["derivative-second", "derivative-higher"],
    },
    {
      id: "derivative-n4",
      name: "特殊求导",
      members: [
        "derivative-implicit",
        "derivative-log",
        "derivative-parametric",
      ],
    },
    { id: "derivative-n5", members: ["derivative-differential"] },
  ],
  application: [
    {
      id: "application-n1",
      name: "中值定理",
      members: ["application-mvt", "application-mvt-proof"],
    },
    {
      id: "application-n2",
      name: "极限工具",
      members: ["application-lhopital", "application-lhopital-other"],
    },
    {
      id: "application-n3",
      name: "泰勒展开",
      members: ["application-taylor-expand", "application-taylor-limit"],
    },
    {
      id: "application-n4",
      name: "单调与不等式",
      members: ["application-monotonic", "application-inequality"],
    },
    {
      id: "application-n5",
      name: "函数性质",
      members: ["application-convexity", "application-extremum"],
    },
    {
      id: "application-n6",
      name: "最值与图形",
      members: [
        "application-optimization",
        "application-asymptote",
        "application-sketch",
      ],
    },
    { id: "application-n7", members: ["application-curvature"] },
  ],
  indefinite: [
    { id: "indefinite-n1", members: ["indefinite-basic"] },
    {
      id: "indefinite-n2",
      name: "换元积分",
      members: [
        "indefinite-substitution-1",
        "indefinite-root-sub",
        "indefinite-trig-sub",
      ],
    },
    { id: "indefinite-n3", members: ["indefinite-parts"] },
    { id: "indefinite-n4", members: ["indefinite-rational"] },
  ],
  definite: [
    {
      id: "definite-n1",
      name: "定义与性质",
      members: ["definite-concept", "definite-properties"],
    },
    {
      id: "definite-n2",
      name: "基本计算",
      members: [
        "definite-ftc-derivative",
        "definite-newton-leibniz",
        "definite-ftc-limit",
      ],
    },
    {
      id: "definite-n3",
      name: "换元与分部",
      members: [
        "definite-substitution",
        "definite-symmetry",
        "definite-parts",
        "definite-reflection",
      ],
    },
    {
      id: "definite-n4",
      name: "反常积分",
      members: ["definite-improper-inf", "definite-improper-unbounded"],
    },
    {
      id: "definite-n5",
      name: "几何应用",
      members: [
        "definite-area",
        "definite-area-polar",
        "definite-volume",
        "definite-arc-length",
      ],
    },
  ],
  ode: [
    { id: "ode-n1", members: ["ode-concept"] },
    {
      id: "ode-n2",
      name: "一阶方程",
      members: ["ode-separable", "ode-homogeneous", "ode-linear"],
    },
    {
      id: "ode-n3",
      name: "应用与降阶",
      members: ["ode-modeling", "ode-integral-equation", "ode-reduce-order"],
    },
    {
      id: "ode-n4",
      name: "解的结构",
      members: ["ode-structure", "ode-const-homog"],
    },
    {
      id: "ode-n5",
      name: "非齐次方程",
      members: ["ode-nonhomog-exp", "ode-nonhomog-trig"],
    },
  ],
};
const parents: Record<string, Record<string, string>> = {
  limit: {
    "limit-epsilon-n": "limit-function",
    "limit-epsilon-delta": "limit-function",
    "limit-uniform": "limit-continuity",
  },
  derivative: { "derivative-related-rates": "derivative-implicit" },
  application: {
    "application-cauchy": "application-mvt-proof",
    "application-taylor-remainder": "application-taylor-expand",
    "application-root-count": "application-extremum",
    "application-curvature-center": "application-curvature",
    "application-newton": "application-extremum",
  },
  indefinite: { "indefinite-trig-rational": "indefinite-rational" },
  definite: {
    "definite-riemann-sum": "definite-newton-leibniz",
    "definite-mvt-proof": "definite-properties",
    "definite-improper-test": "definite-improper-unbounded",
    "definite-physics": "definite-area",
  },
  ode: {
    "ode-bernoulli": "ode-linear",
    "ode-euler": "ode-nonhomog-exp",
    "ode-variation": "ode-structure",
    "ode-system": "ode-const-homog",
  },
};

const display: Record<string, [string, string]> = {
  "limit-function": ["复合与反函数", "复合与反函数关系"],
  "limit-epsilon-n": ["数列定义", "数列极限严格定义"],
  "limit-epsilon-delta": ["函数定义", "函数极限严格定义"],
  "limit-one-sided": ["左右极限", "左右极限与存在性"],
  "limit-infinitesimal": ["无穷小与无穷大", "无穷小与无穷大"],
  "limit-rules": ["极限运算", "四则运算与有理化"],
  "limit-squeeze": ["夹逼准则", "夹逼准则的适用"],
  "limit-monotone": ["单调有界", "单调数列极限"],
  "limit-important-sin": ["重要极限一", "三角重要极限"],
  "limit-important-e": ["重要极限二", "指数重要极限"],
  "limit-order": ["无穷小阶", "无穷小阶比较"],
  "limit-equivalent": ["等价替换", "等价无穷小替换"],
  "limit-1-to-inf": ["幂指极限", "幂指型极限"],
  "limit-continuity": ["分段连续", "分段函数连续性"],
  "limit-discontinuity": ["间断分类", "间断点分类"],
  "limit-zero-theorem": ["零点定理", "连续函数零点"],
  "limit-uniform": ["一致连续", "一致连续概念"],
  "derivative-definition": ["导数定义", "导数定义求值"],
  "derivative-tangent": ["切线法线", "切线与法线方程"],
  "derivative-piecewise": ["分段可导", "分段函数可导性"],
  "derivative-rules": ["求导法则", "求导公式与四则"],
  "derivative-chain": ["复合求导", "复合函数求导"],
  "derivative-second": ["二阶导数", "二阶导数计算"],
  "derivative-higher": ["高阶导数", "高阶导数与乘积"],
  "derivative-implicit": ["隐函数求导", "隐函数求导计算"],
  "derivative-log": ["对数求导", "对数求导法"],
  "derivative-parametric": ["参数求导", "参数方程求导"],
  "derivative-related-rates": ["相关变化", "相关变化率建模"],
  "derivative-differential": ["微分计算", "微分概念与计算"],
  "application-mvt": ["中值定理", "罗尔与拉格朗日"],
  "application-mvt-proof": ["辅助函数", "构造辅助函数证明"],
  "application-cauchy": ["柯西定理", "柯西中值定理"],
  "application-lhopital": ["洛必达", "洛必达法则条件"],
  "application-lhopital-other": ["未定式", "其他未定式变形"],
  "application-taylor-expand": ["麦克劳林", "麦克劳林展开"],
  "application-taylor-limit": ["泰勒极限", "泰勒公式求极限"],
  "application-taylor-remainder": ["余项估计", "泰勒余项与误差"],
  "application-monotonic": ["单调性", "导数判定单调性"],
  "application-inequality": ["导数不等式", "导数证明不等式"],
  "application-convexity": ["凹凸拐点", "凹凸性与拐点"],
  "application-extremum": ["极值最值", "极值与最值判定"],
  "application-optimization": ["最值应用", "最值应用建模"],
  "application-root-count": ["根的个数", "零点个数判定"],
  "application-asymptote": ["渐近线", "函数渐近线"],
  "application-sketch": ["图形描绘", "函数图形描绘"],
  "application-curvature": ["曲率半径", "曲率与曲率半径"],
  "application-curvature-center": ["曲率圆", "曲率圆概念"],
  "application-newton": ["近似解", "牛顿迭代思想"],
  "indefinite-basic": ["基本积分", "原函数与基本公式"],
  "indefinite-substitution-1": ["凑微分", "第一类换元"],
  "indefinite-root-sub": ["根式代换", "根式代换"],
  "indefinite-trig-sub": ["三角代换", "三角代换"],
  "indefinite-parts": ["分部积分", "分部积分法"],
  "indefinite-rational": ["有理积分", "有理函数积分"],
  "indefinite-trig-rational": ["万能代换", "三角有理式代换"],
  "definite-concept": ["定积分定义", "定积分定义与几何"],
  "definite-properties": ["定积分性质", "定积分性质与估值"],
  "definite-riemann-sum": ["和式极限", "黎曼和式极限"],
  "definite-mvt-proof": ["积分中值", "积分中值定理证明"],
  "definite-ftc-derivative": ["变限求导", "变限积分求导"],
  "definite-ftc-limit": ["变限极限", "含变限积分极限"],
  "definite-newton-leibniz": ["牛顿公式", "牛顿莱布尼茨公式"],
  "definite-substitution": ["定积分换元", "定积分换元法"],
  "definite-symmetry": ["对称化简", "奇偶对称化简"],
  "definite-parts": ["定积分分部", "定积分分部积分"],
  "definite-reflection": ["区间再现", "区间再现恒等式"],
  "definite-improper-inf": ["无穷反常", "无穷限反常积分"],
  "definite-improper-unbounded": ["无界反常", "无界反常积分"],
  "definite-improper-test": ["反常审敛", "反常积分审敛"],
  "definite-area": ["平面面积", "平面图形面积"],
  "definite-area-polar": ["极坐标面积", "极坐标面积"],
  "definite-volume": ["旋转体积", "旋转体体积"],
  "definite-arc-length": ["曲线弧长", "曲线弧长"],
  "definite-physics": ["物理应用", "定积分物理建模"],
  "ode-concept": ["方程概念", "微分方程基本概念"],
  "ode-separable": ["可分离", "可分离变量方程"],
  "ode-homogeneous": ["齐次方程", "齐次方程求解"],
  "ode-linear": ["一阶线性", "一阶线性方程"],
  "ode-bernoulli": ["伯努利", "伯努利方程"],
  "ode-modeling": ["方程建模", "微分方程应用建模"],
  "ode-integral-equation": ["积分方程", "积分方程化方程"],
  "ode-reduce-order": ["可降阶", "可降阶方程"],
  "ode-structure": ["解的结构", "线性方程解结构"],
  "ode-variation": ["二阶变易", "二阶常数变易"],
  "ode-const-homog": ["二阶齐次", "二阶常系数齐次"],
  "ode-nonhomog-exp": ["指数非齐次", "指数型非齐次"],
  "ode-nonhomog-trig": ["三角非齐次", "三角型非齐次"],
  "ode-euler": ["欧拉方程", "欧拉方程"],
  "ode-system": ["线性方程组", "常系数线性方程组"],
};
export function decorateMap(chapters: MapChapter[]): MapChapter[] {
  return chapters.map((chapter) => {
    const points = chapter.points.map((point) => {
      const branch = side[point.id];
      const shown = display[point.id];
      if (!shown) throw new Error(`missing display ${point.id}`);
      const level: 1 | 2 | 3 =
        point.id === "limit-uniform"
          ? 3
          : point.tier === "基础"
            ? 1
            : point.tier === "重点"
              ? 2
              : point.tier === "难点"
                ? 3
                : 2;
      return {
        ...point,
        line: branch ? ("side" as const) : ("main" as const),
        side: branch ?? null,
        key: key.has(point.id) || (point.tier === "重点" && !branch),
        hard: hard.has(point.id) || point.tier === "难点",
        level,
        short: shown[0],
        exam: shown[1],
      };
    });
    const groups = new Map<string, string[]>();
    for (const point of points.filter((p) => p.line === "side")) {
      const parent = parents[chapter.id]?.[point.id];
      if (!parent) throw new Error(`missing side parent ${point.id}`);
      groups.set(parent, [...(groups.get(parent) ?? []), point.id]);
    }
    return {
      ...chapter,
      points,
      nodes: nodes[chapter.id] ?? [],
      sides: Array.from(groups, ([parent, members]) => ({ parent, members })),
    };
  });
}

export function validateMap(map: LearnMap) {
  const all = map.chapters.flatMap((chapter) =>
    chapter.points.map((point) => ({ chapter, point })),
  );
  assert.equal(all.length, 89);
  assert.equal(new Set(all.map(({ point }) => point.id)).size, 89);
  const ids = new Set(all.map(({ point }) => point.id));
  for (const { chapter, point } of all) {
    assert.ok(point.line === "main" || point.line === "side");
    assert.equal(point.line === "side", point.side !== null, point.id);
    assert.ok(point.level >= 1 && point.level <= 3, point.id);
    assert.ok(
      point.short.length > 0 && Array.from(point.short).length <= 7,
      point.id,
    );
    assert.ok(
      point.exam.length > 0 &&
        Array.from(point.exam).length <= 14 &&
        !/[=+*/^{}\\]/.test(point.exam),
      point.id,
    );
    for (const prereq of point.prereqs)
      assert.ok(ids.has(prereq), `${point.id}:${prereq}`);
    assert.ok(
      chapter.nodes.some((node) => node.members.includes(point.id)) ||
        point.line === "side",
      point.id,
    );
  }
  for (const chapter of map.chapters) {
    const main = new Set(
      chapter.points
        .filter((point) => point.line === "main")
        .map((point) => point.id),
    );
    const listed = chapter.nodes.flatMap((node) => node.members);
    const position = new Map(listed.map((id, index) => [id, index]));
    assert.equal(new Set(listed).size, listed.length, chapter.id);
    assert.deepEqual(new Set(listed), main, chapter.id);
    const branchIds = chapter.sides.flatMap((branch) => branch.members);
    assert.equal(new Set(branchIds).size, branchIds.length, chapter.id);
    assert.deepEqual(
      new Set(branchIds),
      new Set(chapter.points.filter((p) => p.line === "side").map((p) => p.id)),
      chapter.id,
    );
    assert.equal(
      new Set(chapter.nodes.map((n) => n.id)).size,
      chapter.nodes.length,
      chapter.id,
    );
    for (const node of chapter.nodes)
      assert.ok(
        node.name
          ? node.members.length >= 2 && node.members.length <= 4
          : node.members.length === 1,
        node.id,
      );
    for (const point of chapter.points.filter((point) => point.line === "main"))
      for (const prereq of point.prereqs.filter((id) => main.has(id)))
        assert.ok(
          position.get(prereq)! < position.get(point.id)!,
          `${point.id}:${prereq}`,
        );
    for (const branch of chapter.sides) {
      assert.ok(main.has(branch.parent), `${chapter.id}:${branch.parent}`);
      assert.ok(branch.members.length <= 3, branch.parent);
      for (const id of branch.members)
        assert.equal(
          chapter.points.find((point) => point.id === id)?.line,
          "side",
          id,
        );
    }
  }
}
