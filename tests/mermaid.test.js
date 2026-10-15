'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const vm = require('node:vm');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/signature-sequence.mmd'), 'utf8');

for (const mode of [[], ['--slides']]) {
  test(`Mermaid fallback preserves valid syntax in ${mode.length ? 'slides' : 'documents'}`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'md2h-mermaid-'));
    try {
      const input = path.join(directory, 'input.md');
      const output = path.join(directory, 'output.html');
      fs.writeFileSync(input, '# Diagram\n\n```mermaid\n' + fixture + '```\n');
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'markdown-to-html.js'), input, output, ...mode], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const html = fs.readFileSync(output, 'utf8');
      const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import mermaid[^\n]*\n/, '');

      const valid = 'sequenceDiagram\nA->>B: Hello;B->>A: Hi';
      const entities = 'sequenceDiagram\nNote left of A: #59; #infin; &amp; &#59; &#x3b;';
      const other = 'flowchart TD\nA[Hello; world] --> B';
      const broken = 'sequenceDiagram\nNote right of A: Hello; world\ninvalid';
      const comment = 'sequenceDiagram\n%% A->>B: comment; keep\nA->>B: hello; world';
      const diagrams = [fixture, valid, entities, other, broken, comment].map((textContent) => ({ textContent }));
      const parsed = [];
      let rendered = false;
      const context = vm.createContext({
        document: {
          documentElement: { dataset: { theme: 'dark' } },
          fonts: { ready: Promise.resolve() },
          querySelectorAll: () => diagrams,
        },
        mermaid: {
          initialize: () => {},
          parse: async (source) => {
            parsed.push(source);
            if (source === fixture || source === comment || source.includes('\ninvalid')) throw new Error('Parse error');
          },
          run: async () => { rendered = true; },
        },
      });
      await vm.runInContext(`(async () => {${script}\n})()`, context);
      assert.ok(rendered, 'Rendering runs after validation');
      assert.equal(diagrams[0].textContent, fixture
        .replace('US worker;', 'US worker#59;')
        .replace('Create response;', 'Create response#59;')
        .replace('status=signed;', 'status=signed#59;'));
      assert.equal(diagrams[1].textContent, valid, 'Valid statement separators survive');
      assert.equal(diagrams[2].textContent, entities, 'Existing entities survive');
      assert.equal(diagrams[3].textContent, other, 'Other diagram types survive');
      assert.equal(diagrams[4].textContent, broken, 'Failed repairs retain original source');
      assert.equal(diagrams[5].textContent, comment.replace('hello;', 'hello#59;'), 'Comments survive');
      assert.equal(parsed.length, 7);
      assert.ok(!parsed.includes(entities));
      assert.ok(!parsed.includes(other));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
