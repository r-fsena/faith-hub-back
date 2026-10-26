const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
test('SQL literals bind the same number of parameters as placeholders', () => {
  const directory = path.join(__dirname, '../src/functions');
  const mismatches = [];
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(directory, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const inspect = node => {
      if (ts.isCallExpression(node) && node.arguments.length >= 2 && node.expression.getText(source).endsWith('query')) {
        const [sql, parameters] = node.arguments;
        if ((ts.isStringLiteral(sql) || ts.isNoSubstitutionTemplateLiteral(sql)) && ts.isArrayLiteralExpression(parameters) && !parameters.elements.some(ts.isSpreadElement)) {
          if ((sql.text.match(/\?/g) || []).length !== parameters.elements.length) mismatches.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  assert.deepEqual(mismatches, []);
});
