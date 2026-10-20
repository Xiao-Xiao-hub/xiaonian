// Office Math (OMML, the m: elements of a docx) → LaTeX, for the
// constructs calculus notes use. Unknown elements pass their content through;
// any error falls back to the formula's plain text, so a formula is never lost.

export const M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

type XmlNode = {
  nodeType: number;
  localName?: string | null;
  namespaceURI?: string | null;
  nodeValue?: string | null;
  textContent?: string | null;
  childNodes: ArrayLike<XmlNode>;
  getAttributeNS?: (ns: string, name: string) => string | null;
  getAttribute?: (name: string) => string | null;
};

const elements = (node: XmlNode) =>
  Array.from(node.childNodes).filter((child) => child.nodeType === 1);
const isM = (node: XmlNode, name: string) =>
  node.namespaceURI === M_NS && node.localName === name;
const child = (node: XmlNode | undefined, name: string) =>
  node ? elements(node).find((item) => isM(item, name)) : undefined;
// m:val of a property element, e.g. <m:chr m:val="∑"/>.
const val = (node: XmlNode | undefined) =>
  node?.getAttributeNS?.(M_NS, "val") ?? node?.getAttribute?.("m:val") ?? null;
const prop = (node: XmlNode, pr: string, name: string) =>
  val(child(child(node, pr), name));
const on = (value: string | null) =>
  value !== null && ["1", "on", "true", ""].includes(value);

const SYMBOLS: Record<string, string> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon",
  ϵ: "\\epsilon", ζ: "\\zeta", η: "\\eta", θ: "\\theta", ϑ: "\\vartheta",
  ι: "\\iota", κ: "\\kappa", λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi",
  π: "\\pi", ρ: "\\rho", σ: "\\sigma", τ: "\\tau", υ: "\\upsilon",
  φ: "\\varphi", ϕ: "\\phi", χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi",
  Π: "\\Pi", Σ: "\\Sigma", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
  "∞": "\\infty", "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow",
  "⇒": "\\Rightarrow", "⇔": "\\Leftrightarrow", "≤": "\\le", "≥": "\\ge",
  "≠": "\\ne", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim", "±": "\\pm",
  "∓": "\\mp", "×": "\\times", "÷": "\\div", "·": "\\cdot", "⋅": "\\cdot",
  "∈": "\\in", "∉": "\\notin", "⊂": "\\subset", "⊆": "\\subseteq",
  "∪": "\\cup", "∩": "\\cap", "∀": "\\forall", "∃": "\\exists",
  "∂": "\\partial", "∇": "\\nabla", "…": "\\ldots", "⋯": "\\cdots",
  "∠": "\\angle", "⊥": "\\perp", "∥": "\\parallel", "∅": "\\emptyset",
  "°": "^\\circ", "′": "'", "″": "''", "−": "-", "∗": "*",
  ℝ: "\\mathbb{R}", ℕ: "\\mathbb{N}", ℤ: "\\mathbb{Z}", ℚ: "\\mathbb{Q}",
  ℂ: "\\mathbb{C}",
};
const NARY: Record<string, string> = {
  "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint",
  "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "⋃": "\\bigcup",
  "⋂": "\\bigcap",
};
const ACCENTS: Record<string, string> = {
  "̂": "\\hat", "^": "\\hat", "̄": "\\bar", "̅": "\\bar",
  "¯": "\\bar", "⃗": "\\vec", "⃑": "\\vec", "̇": "\\dot",
  "̈": "\\ddot", "̃": "\\tilde", "~": "\\tilde", "̌": "\\check",
};
const FENCES: Record<string, string> = {
  "(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}",
  "|": "|", "‖": "\\|", "⟨": "\\langle", "⟩": "\\rangle", "〈": "\\langle",
  "〉": "\\rangle", "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil",
  "⌉": "\\rceil",
};
const MATRIX: Record<string, string> = {
  "(": "pmatrix", "[": "bmatrix", "|": "vmatrix", "{": "Bmatrix",
};
const FUNCTIONS =
  /(?<![A-Za-z\\])(arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|ln|lg|log|exp|lim|max|min|sup|inf|det|gcd)/g;
const LIMITS = /^\\(?:lim|max|min|sup|inf)\s*$/;

// Run text: function names get a backslash, symbols become commands, words
// in Chinese stay as \text{…}.
const text = (raw: string) => {
  if (/[㐀-鿿]/.test(raw)) return `\\text{${raw}}`;
  return Array.from(raw.replace(FUNCTIONS, "\\$1 "))
    .map((char) => {
      const symbol = SYMBOLS[char];
      // A command needs a space before the letters that follow it.
      if (!symbol) return char;
      return /[a-zA-Z]$/.test(symbol) ? `${symbol} ` : symbol;
    })
    .join("");
};

const fence = (char: string | null, fallback: string) => {
  if (char === null) return fallback;
  if (char === "") return ".";
  return FENCES[char] ?? char;
};

const all = (node: XmlNode | undefined): string =>
  node ? elements(node).map(convert).join("") : "";

const matrix = (node: XmlNode, env: string) =>
  `\\begin{${env}}${elements(node)
    .filter((row) => isM(row, "mr"))
    .map((row) =>
      elements(row)
        .filter((cell) => isM(cell, "e"))
        .map(all)
        .join(" & "),
    )
    .join(" \\\\ ")}\\end{${env}}`;
const rows = (node: XmlNode) =>
  elements(node)
    .filter((row) => isM(row, "e"))
    .map(all)
    .join(" \\\\ ");

function convert(node: XmlNode): string {
  if (node.namespaceURI === W_NS)
    return node.localName === "t" ? text(node.textContent ?? "") : all(node);
  if (node.namespaceURI !== M_NS) return "";
  switch (node.localName) {
    case "t":
      return text(node.textContent ?? "");
    case "f": {
      const num = all(child(node, "num")),
        den = all(child(node, "den"));
      const type = prop(node, "fPr", "type");
      if (type === "lin") return `${num}/${den}`;
      if (type === "noBar") return `{${num} \\atop ${den}}`;
      return `\\frac{${num}}{${den}}`;
    }
    case "sSup":
      return `{${all(child(node, "e"))}}^{${all(child(node, "sup"))}}`;
    case "sSub":
      return `{${all(child(node, "e"))}}_{${all(child(node, "sub"))}}`;
    case "sSubSup":
      return `{${all(child(node, "e"))}}_{${all(child(node, "sub"))}}^{${all(child(node, "sup"))}}`;
    case "sPre":
      return `{}_{${all(child(node, "sub"))}}^{${all(child(node, "sup"))}}{${all(child(node, "e"))}}`;
    case "rad": {
      const degree = all(child(node, "deg")).trim();
      const hidden = on(prop(node, "radPr", "degHide"));
      return !hidden && degree
        ? `\\sqrt[${degree}]{${all(child(node, "e"))}}`
        : `\\sqrt{${all(child(node, "e"))}}`;
    }
    case "nary": {
      const chr = prop(node, "naryPr", "chr") ?? "∫";
      const sub = on(prop(node, "naryPr", "subHide"))
        ? ""
        : all(child(node, "sub")).trim();
      const sup = on(prop(node, "naryPr", "supHide"))
        ? ""
        : all(child(node, "sup")).trim();
      return `${NARY[chr] ?? chr}${sub ? `_{${sub}}` : ""}${sup ? `^{${sup}}` : ""} ${all(child(node, "e"))}`;
    }
    case "d": {
      const pr = child(node, "dPr");
      const begin = val(child(pr, "begChr")),
        end = val(child(pr, "endChr"));
      const separator = val(child(pr, "sepChr")) ?? "|";
      const parts = elements(node).filter((item) => isM(item, "e"));
      // A lone matrix or equation array in delimiters is one environment.
      const inner = parts.length === 1 ? elements(parts[0]!) : [];
      const only = inner.length === 1 ? inner[0]! : undefined;
      if (only && isM(only, "m")) {
        const env = MATRIX[begin ?? "("];
        if (env) return matrix(only, env);
      }
      if (only && isM(only, "eqArr") && begin === "{" && (end === "" || end === null))
        return `\\begin{cases}${rows(only)}\\end{cases}`;
      return `\\left${fence(begin, "(")}${parts.map(all).join(FENCES[separator] ?? separator)}\\right${fence(end, ")")}`;
    }
    case "func": {
      const name = all(child(node, "fName")).trim();
      const named = /^[a-z]+$/.test(name) ? `\\operatorname{${name}}` : name;
      return `${named}{${all(child(node, "e"))}}`;
    }
    case "limLow": {
      const base = all(child(node, "e")).trim();
      const below = all(child(node, "lim"));
      return LIMITS.test(base)
        ? `${base.trim()}_{${below}}`
        : `\\underset{${below}}{${base}}`;
    }
    case "limUpp":
      return `\\overset{${all(child(node, "lim"))}}{${all(child(node, "e"))}}`;
    case "acc": {
      const chr = prop(node, "accPr", "chr") ?? "̂";
      return `${ACCENTS[chr] ?? "\\hat"}{${all(child(node, "e"))}}`;
    }
    case "bar":
      return prop(node, "barPr", "pos") === "top"
        ? `\\overline{${all(child(node, "e"))}}`
        : `\\underline{${all(child(node, "e"))}}`;
    case "m":
      return matrix(node, "matrix");
    case "eqArr":
      return `\\begin{aligned}${rows(node)}\\end{aligned}`;
    case "groupChr": {
      const chr = prop(node, "groupChrPr", "chr") ?? "⏟";
      const top = prop(node, "groupChrPr", "pos") === "top";
      const base = all(child(node, "e"));
      if (chr === "⏟") return `\\underbrace{${base}}`;
      if (chr === "⏞") return `\\overbrace{${base}}`;
      const mark = text(chr).trim();
      return top ? `\\overset{${mark}}{${base}}` : `\\underset{${mark}}{${base}}`;
    }
    case "box":
    case "borderBox":
    case "phant":
      return all(child(node, "e"));
    default:
      // Properties (…Pr) carry no text; containers (e, num, sub, r …) pass on.
      return node.localName?.endsWith("Pr") ? "" : all(node);
  }
}

const tidy = (latex: string) =>
  latex
    .replace(/\s+/g, " ")
    .replace(/ ([}_^)])/g, "$1")
    .trim();

// One m:oMath → LaTeX, or its plain text when anything goes wrong.
export const ommlToLatex = (math: XmlNode): string => {
  try {
    const latex = tidy(all(math));
    if (latex) return latex;
  } catch {
    /* Plain text below. */
  }
  return (math.textContent ?? "").trim();
};
