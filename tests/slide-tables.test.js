'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// No browser dependency is required for normal rendering. Set MD2H_BROWSER on Linux/CI.
const browser = process.env.MD2H_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('single tables fit the padded slide at different viewport sizes', { skip: !fs.existsSync(browser) }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'md2h-slide-tables-'));
  try {
    const input = path.join(directory, 'input.md');
    const output = path.join(directory, 'output.html');
    const small = '| Name | Value |\n| --- | --- |\n| Alpha | **42** |';
    const oneColumn = '| Name |\n| --- |\n| Alpha |\n| Beta |';
    const threeColumns = '| Name | Value | Status |\n| --- | --- | --- |\n| Alpha | **42** | Ready |\n| Beta | 7 | Waiting |';
    const dense = '| Field | Value | Notes |\n| --- | --- | --- |\n' + Array.from({ length: 20 }, (_, i) =>
      `| Field ${i} | \`some_long_identifier_${i}\` | Longer text that must wrap inside the table |`).join('\n');
    fs.writeFileSync(input, `# Small\n\n${small}\n\n# Dense\n\n${dense}\n\n# One column\n\n${oneColumn}\n\n# Three columns\n\n${threeColumns}\n\n# Mixed\n\nExtra paragraph.\n\n${small}\n\n# Multiple\n\n${small}\n\n${small}\n`);
    const converter = process.env.MD2H_CONVERTER || path.join(__dirname, '..', 'markdown-to-html.js');
    const render = spawnSync(process.execPath, [converter, input, output, '--slides'], { encoding: 'utf8' });
    assert.equal(render.status, 0, render.stderr);
    // Keep browser verification deterministic and offline.
    const html = fs.readFileSync(output, 'utf8')
      .replace(/<link\b[^>]*>/g, '')
      .replace(/<script\b[^>]*src=[^>]*><\/script>/g, '');
    fs.writeFileSync(output, html.replace('</body>', `<script>
      document.getElementById('slide-picker').classList.add('is-open');
      fitTextSlides();
      const results = slideElements.map(slide => {
        const content = slide.querySelector('.slide-content');
        const table = content.querySelector('table');
        const rect = table.getBoundingClientRect();
        const fontSize = parseFloat(getComputedStyle(table).fontSize);
        const cellFontSize = parseFloat(getComputedStyle(table.querySelector('td')).fontSize);
        const headerFontSize = parseFloat(getComputedStyle(table.querySelector('th')).fontSize);
        const rowHeight = table.querySelector('tbody tr').getBoundingClientRect().height;
        table.style.fontSize = (fontSize + 1) + 'px';
        const enlarged = table.getBoundingClientRect();
        table.style.fontSize = fontSize + 'px';
        return { fitted: slide.classList.contains('slide-single-table'), fontSize, cellFontSize, headerFontSize, rowHeight,
          left: rect.left, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom,
          width: rect.width, contentWidth: content.clientWidth,
          overflow: content.scrollHeight > content.clientHeight || content.scrollWidth > content.clientWidth,
          growsPastBottom: enlarged.bottom > innerHeight - parseFloat(getComputedStyle(content).paddingBottom) - 1,
          cellOverflow: Array.from(table.querySelectorAll('th, td')).some(cell => cell.scrollWidth > cell.clientWidth + 1),
          previewFontSize: parseFloat(getComputedStyle(document.querySelector('.slide-picker-preview .slide table')).fontSize) };
      });
      const result = document.createElement('pre');
      result.id = 'table-test-results';
      result.textContent = JSON.stringify(results);
      document.body.append(result);
    </script></body>`));
    const sizes = [];
    for (const viewport of ['1440,900', '800,600']) {
      const run = spawnSync(browser, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--user-data-dir=' + path.join(directory, 'profile-' + viewport), '--window-size=' + viewport,
        '--dump-dom', 'file://' + output], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(run.status, 0, run.stderr);
      const match = run.stdout.match(/<pre id="table-test-results">([^<]+)<\/pre>/);
      assert.ok(match, 'Browser did not report layout results');
      const results = JSON.parse(match[1]);
      assert.deepEqual(results.map(result => result.fitted), [true, true, true, true, false, false]);
      for (const result of results.slice(0, 4)) {
        assert.ok(result.left >= 32 && result.right >= 32 && result.bottom >= 78, JSON.stringify(result));
        assert.equal(result.overflow, false, JSON.stringify(result));
        assert.equal(result.cellOverflow, false, JSON.stringify(result));
        assert.equal(result.growsPastBottom, true, 'Font should maximize available space');
      }
      for (const result of [results[0], results[2], results[3]]) {
        assert.ok(result.cellFontSize > 24, 'Tables with 1–3 columns should enlarge their actual text');
        assert.ok(result.headerFontSize > 20, 'Table headers should also enlarge');
        assert.ok(result.rowHeight > 60, 'Larger text should produce taller rows');
      }
      assert.ok(results[1].fontSize < results[0].fontSize, 'Dense tables should shrink');
      assert.ok(Math.abs(results[0].fontSize - results[0].previewFontSize) < 0.5, 'Picker preview should use the same fit');
      sizes.push(results[0].fontSize);
    }
    assert.ok(sizes[0] > sizes[1], 'Larger viewports should allow larger table text');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
