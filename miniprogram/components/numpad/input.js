// The number pad's input rules, kept pure so node tests can
// run them. A value is the ASCII string sent to the server: "-3/4", "0.5", "2".
//   - a minus only at the start (the − key turns the sign on and off);
//   - at most one decimal point in each number (numerator, denominator);
//   - at most one fraction bar, after a numerator with a digit in it;
//   - a value ends in a digit before it can be sent (denominator not empty);
//   - the minus counts toward MAX like any other character;
//   - "-0" (a zero numerator with a minus) is sent as "0" (normalize).
const MAX = 16;
const DIGITS = "0123456789";

function split(value) {
  const v = String(value || "");
  const neg = v.startsWith("-");
  const body = neg ? v.slice(1) : v;
  const bar = body.indexOf("/");
  return {
    neg,
    num: bar < 0 ? body : body.slice(0, bar),
    den: bar < 0 ? null : body.slice(bar + 1),
  };
}
function join(p) {
  return `${p.neg ? "-" : ""}${p.num}${p.den === null ? "" : `/${p.den}`}`;
}
// One key on one value; a key that breaks a rule leaves the value as it was.
// Keys: "0"–"9", ".", "-", "/", "back".
function press(value, key) {
  const v = String(value || "");
  if (key === "back") return v.slice(0, -1);
  const p = split(v);
  if (key === "-") return p.neg || v.length < MAX ? join({ ...p, neg: !p.neg }) : v;
  if (v.length >= MAX) return v;
  const inDen = p.den !== null;
  const part = inDen ? p.den : p.num;
  const set = (next) => join(inDen ? { ...p, den: next } : { ...p, num: next });
  if (DIGITS.includes(key) && key.length === 1)
    // "0" then a digit: the digit, not "05".
    return set(part === "0" ? key : part + key);
  if (key === ".") {
    if (part.includes(".")) return v;
    return set(part ? `${part}.` : "0.");
  }
  if (key === "/") {
    if (inDen || !/\d$/.test(p.num)) return v;
    return join({ ...p, den: "" });
  }
  return v;
}
// Ready to send: digits, an optional decimal part, an optional denominator.
function valid(value) {
  return /^-?\d+(\.\d+)?(\/\d+(\.\d+)?)?$/.test(String(value || ""));
}
// What is sent: a zero numerator drops its minus ("-0" → "0", "-0.0/3" →
// "0.0/3"); typing keeps it, so "-0.5" can still be typed through "-0".
function normalize(value) {
  const p = split(value);
  return p.neg && !/[1-9]/.test(p.num) ? join({ ...p, neg: false }) : String(value || "");
}
// How a blank shows its value: a fraction stacks its numerator over its
// denominator, the minus in front.
function shown(value) {
  const p = split(value);
  return {
    empty: !String(value || ""),
    neg: p.neg,
    frac: p.den !== null,
    num: p.num,
    den: p.den || "",
    text: String(value || ""),
  };
}
// 确定: the first blank (from `active` on, then from the start) that is not
// ready; -1 when every blank is.
function nextOpen(values, active) {
  const n = values.length;
  for (let k = 0; k < n; k++) {
    const i = (Number(active || 0) + k) % n;
    if (!valid(values[i])) return i;
  }
  return -1;
}

module.exports = { MAX, press, valid, normalize, shown, nextOpen, split };
