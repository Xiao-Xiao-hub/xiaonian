"use strict";
// Packaging rules the unit tests cannot see: Node resolves any relative
// require, but in the app a main-package page that requires a module, uses a
// component or a wxs file from a subpackage gets "module... is not defined"
// and shows a blank page (V4.2: the capture page required pages/import/view).
// One subpackage cannot reach into another either.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../miniprogram");
const app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
const subRoots = (app.subpackages || app.subPackages || []).map((p) => p.root.replace(/\/+$/, ""));
const rel = (file) => path.relative(root, file).split(path.sep).join("/");
const packageOf = (file) => subRoots.find((r) => rel(file) === r || rel(file).startsWith(`${r}/`)) || "";
const target = (from, spec) => (spec.startsWith("/") ? path.join(root, spec) : path.resolve(path.dirname(from), spec));
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const files = walk(root);
const crosses = (from, spec) => {
  const to = packageOf(target(from, spec));
  return Boolean(to) && to !== packageOf(from);
};

test("there are subpackages to check", () => {
  assert.ok(subRoots.includes("pages/import") && subRoots.includes("pages/brainstorm"));
});

test("no module is required from another package", () => {
  const bad = [];
  for (const file of files.filter((f) => f.endsWith(".js") || f.endsWith(".wxs"))) {
    for (const [, spec] of fs.readFileSync(file, "utf8").matchAll(/require\(\s*["']([^"']+)["']\s*\)/g))
      if ((spec.startsWith(".") || spec.startsWith("/")) && crosses(file, spec)) bad.push(`${rel(file)} -> ${spec}`);
  }
  assert.deepEqual(bad, []);
});

test("no component or template comes from another package", () => {
  const bad = [];
  const global = (app.usingComponents && Object.values(app.usingComponents)) || [];
  for (const spec of global) if (typeof spec === "string" && packageOf(target(path.join(root, "app.json"), spec))) bad.push(`app.json -> ${spec}`);
  for (const file of files.filter((f) => f.endsWith(".json") && f !== path.join(root, "app.json"))) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      continue;
    }
    for (const [name, spec] of Object.entries((json && json.usingComponents) || {}))
      if (typeof spec === "string" && !spec.startsWith("plugin://") && crosses(file, spec)) bad.push(`${rel(file)}: ${name} -> ${spec}`);
  }
  for (const file of files.filter((f) => f.endsWith(".wxml"))) {
    for (const [, spec] of fs.readFileSync(file, "utf8").matchAll(/<(?:wxs|import|include)\b[^>]*\bsrc="([^"{}]+)"/g))
      if (crosses(file, spec)) bad.push(`${rel(file)} -> ${spec}`);
  }
  assert.deepEqual(bad, []);
});
