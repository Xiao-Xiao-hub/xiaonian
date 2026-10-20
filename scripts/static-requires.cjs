"use strict";
// Use the already locked compiler so comments, regexes and quoted examples
// cannot masquerade as runtime dependencies in the static source checker.
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const fromServer = createRequire(path.resolve(__dirname, "../server/package.json"));
const ts = fromServer("typescript");

function staticRequires(source, name = "input.js") {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const dependencies = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === "require" && node.arguments.length === 1) {
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
        dependencies.push(arg.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return dependencies;
}

if (require.main === module) {
  const files = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(files.map((file) => ({
    path: file,
    requires: staticRequires(fs.readFileSync(file, "utf8"), file),
  }))));
}

module.exports = { staticRequires };
