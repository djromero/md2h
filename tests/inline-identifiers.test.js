'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('technical identifiers preserve underscores across document and slide rendering', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'md2h-identifiers-'));
  try {
    const input = path.join(directory, 'input.md');
    fs.writeFileSync(input, [
      '# raw_employee_payment_breakdown.payload.output',
      '',
      'Use raw_employee_payment_breakdown.payload.output, external_refunds and ES::ConceptType.after_tax.',
      '',
      '_italic_ __bold__ *italic* **bold** _foo_bar_ __foo_bar__',
      '',
      '`already_code` `*literal_emphasis*`',
      '',
      '[foo_bar](https://example.com/some_path/other_path "link_title_here")',
      '',
      '[`explicit_code`](https://example.com/explicit_path)',
      '',
      '![alt_text_here](image_path_here.png "image_title_here")',
      '',
      'https://example.com/some_path/other_path',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| foo_bar | 1 |',
      '',
      '- foo_bar',
      '',
      '```text',
      'foo_bar *literal*',
      '```',
    ].join('\n'));

    for (const mode of [[], ['--slides']]) {
      const output = path.join(directory, 'output.html');
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'markdown-to-html.js'), input, output, ...mode], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const html = fs.readFileSync(output, 'utf8');
      for (const expected of [
        '<code>raw_employee_payment_breakdown.payload.output</code>',
        '<code>external_refunds</code>',
        '<code>ES::ConceptType.after_tax</code>',
        '<em>italic</em> <strong>bold</strong> <em>italic</em> <strong>bold</strong>',
        '<em><code>foo_bar</code></em> <strong><code>foo_bar</code></strong>',
        '<code>already_code</code> <code>*literal_emphasis*</code>',
        '<a href="https://example.com/some_path/other_path" title="link_title_here"><code>foo_bar</code></a>',
        '<a href="https://example.com/explicit_path"><code>explicit_code</code></a>',
        'alt="alt_text_here" title="image_title_here"',
        'image_path_here.png',
        '<p>https://example.com/some_path/other_path</p>',
        '<td><code>foo_bar</code></td>',
        '<li><code>foo_bar</code></li>',
        '<pre><code class="language-text">foo_bar *literal*</code></pre>',
      ]) assert.ok(html.includes(expected), `Missing ${expected} in ${mode.length ? 'slides' : 'document'}`);
      assert.ok(html.includes('<title>raw_employee_payment_breakdown.payload.output</title>'));
      assert.ok(!html.includes('\uE000'), 'All inline placeholders must be restored');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
