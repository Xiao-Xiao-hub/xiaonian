const { test } = require("node:test");
const assert = require("node:assert/strict");
const { staticRequires } = require("../scripts/static-requires.cjs");

test("static dependencies ignore commented and quoted examples but retain real calls", () => {
  const source = [
    '// require("./comment")',
    '/* require("./block") */',
    'const example = \'require("./string")\';',
    'const regex = /require(".\/regex")/;',
    'const text = `require("./template-example")`;',
    'const url = "https://example.invalid/path";',
    'const a = require("./actual");',
    "const b = require /* note */ ('../other');",
    'const c = require(`./static-template`);',
    'const value = `${require("./inside-expression")}`;',
    'object.require("./method");',
    'require(variable);',
  ].join("\n");
  assert.deepEqual(staticRequires(source), [
    "./actual", "../other", "./static-template", "./inside-expression",
  ]);
});
