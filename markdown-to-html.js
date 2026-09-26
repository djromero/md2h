#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fileURLToPath } = require('node:url');

const args = process.argv.slice(2);

const embedImages = args.includes('--embed-images') || args.includes('-e');
const slides = args.includes('--slides');
const linked = args.includes('--linked');
const positionalArgs = args.filter((arg) => !['--embed-images', '-e', '--slides', '--linked'].includes(arg));

if (positionalArgs.length < 1 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  node markdown-to-html.js input.md [output.html] [--embed-images|-e] [--slides] [--linked]

Examples:
  node markdown-to-html.js docs/notes.md
  node markdown-to-html.js docs/notes.md dist/notes.html
  node markdown-to-html.js docs/notes.md --embed-images
  node markdown-to-html.js talk.md dist/talk.html --slides
  node markdown-to-html.js docs/index.md dist/index.html --linked`);
  process.exit(positionalArgs.length < 1 ? 1 : 0);
}

const inputPath = path.resolve(positionalArgs[0]);
const outputPath = path.resolve(
  positionalArgs[1] || path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.html`),
);

if (inputPath === outputPath) {
  console.error(`Refusing to overwrite the input file: ${inputPath}

Pass a different output path, for example:
  markdown-to-html.js ${inputPath} /tmp/${path.basename(inputPath, path.extname(inputPath))}-converted.html`);
  process.exit(1);
}

const imageCache = new Map();

if (linked) {
  renderLinkedDocuments(inputPath, outputPath, imageCache, embedImages, slides);
} else {
  renderDocument(inputPath, outputPath, imageCache, embedImages, slides);
}

function renderLinkedDocuments(entryInputPath, entryOutputPath, imageCache, embedImages, slides) {
  const sourceRoot = path.dirname(entryInputPath);
  const realSourceRoot = fs.realpathSync(sourceRoot);
  const outputRoot = path.dirname(entryOutputPath);
  const queue = [];
  const queuedInputs = new Set();
  const outputOwners = new Map();

  const outputPathFor = (linkedInputPath) => {
    if (linkedInputPath === entryInputPath) return entryOutputPath;
    const relativeInputPath = path.relative(sourceRoot, linkedInputPath);
    return path.join(outputRoot, replaceMarkdownExtension(relativeInputPath));
  };

  const enqueue = (linkedInputPath) => {
    if (queuedInputs.has(linkedInputPath)) return outputPathFor(linkedInputPath);

    const linkedOutputPath = outputPathFor(linkedInputPath);
    const outputKey = path.resolve(linkedOutputPath);
    const existingOwner = outputOwners.get(outputKey);
    if (existingOwner && existingOwner !== linkedInputPath) {
      throw new Error(`Cannot render both ${existingOwner} and ${linkedInputPath} to ${linkedOutputPath}`);
    }

    outputOwners.set(outputKey, linkedInputPath);
    queuedInputs.add(linkedInputPath);
    queue.push({ inputPath: linkedInputPath, outputPath: linkedOutputPath });
    return linkedOutputPath;
  };

  enqueue(entryInputPath);

  for (let index = 0; index < queue.length; index += 1) {
    const page = queue[index];
    const rewriteLink = (url) => {
      const target = localMarkdownTarget(url, page.inputPath, sourceRoot);
      if (!target) return url;

      if (!fs.existsSync(target.inputPath) || !fs.statSync(target.inputPath).isFile()) {
        console.warn(`Skipping linked Markdown file not found: ${target.inputPath}`);
        return url;
      }

      const realInputPath = fs.realpathSync(target.inputPath);
      if (!isPathInside(realSourceRoot, realInputPath)) {
        console.warn(`Skipping linked Markdown file outside ${sourceRoot}: ${target.inputPath}`);
        return url;
      }

      const linkedOutputPath = enqueue(target.inputPath);
      const relativeOutputPath = path.relative(path.dirname(page.outputPath), linkedOutputPath)
        .split(path.sep)
        .join('/');
      return `${encodeRelativeUrlPath(relativeOutputPath)}${target.suffix}`;
    };

    renderDocument(page.inputPath, page.outputPath, imageCache, embedImages, slides, rewriteLink);
  }
}

function renderDocument(inputPath, outputPath, imageCache, embedImages, slides, rewriteLink = (url) => url) {
  const markdown = fs.readFileSync(inputPath, 'utf8');

  if (looksLikeHtml(markdown) || path.extname(inputPath).toLowerCase() === '.html') {
    console.error(`Input looks like HTML, not Markdown: ${inputPath}

Use the original .md file as input and write to a separate .html output path.`);
    process.exit(1);
  }

  const imageBaseHref = pathToFileURL(path.dirname(inputPath) + path.sep).href;
  const rendered = renderMarkdown(markdown, path.basename(inputPath, path.extname(inputPath)), imageBaseHref, imageCache, path.dirname(inputPath), embedImages, slides, rewriteLink);
  const documentHtml = slides ? buildSlidesDocument(rendered) : buildDocument(rendered);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, documentHtml, 'utf8');

  console.log(`Wrote ${outputPath}`);
}

function renderMarkdown(source, fallbackTitle, imageBaseHref, imageCache, imageDir, embedImages, slides = false, rewriteLink = (url) => url) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  const headings = [];
  const slugCounts = new Map();
  const frontMatter = extractFrontMatter(lines);
  const startIndex = frontMatter ? frontMatter.nextIndex : 0;
  let paragraphLines = [];
  let openList = null;
  let hasMermaid = false;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const paragraphText = paragraphLines.join(' ').trim();
    const paragraphHtml = `<p>${renderInline(paragraphText, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink)}</p>`;
    if (slides) {
      html.push({
        slideText: true,
        lineCount: paragraphLines.length,
        titleText: stripInlineMarkdown(paragraphText),
        html: paragraphHtml,
      });
    } else {
      html.push(paragraphHtml);
    }
    paragraphLines = [];
  };

  const closeList = () => {
    if (!openList) return;
    html.push(`</${openList.type}>`);
    openList = null;
  };

  if (frontMatter && !slides) {
    html.push(renderFrontMatter(frontMatter.lines));
  }

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];

    if (slides) {
      const slideHeading = line.match(/^#(?:[\t ]+(.*?))?[\t ]*$/);
      if (slideHeading) {
        flushParagraph();
        closeList();

        const markdownTitle = (slideHeading[1] || '').replace(/[\t ]+#+[\t ]*$/, '').trim();
        const titleless = markdownTitle === '' || markdownTitle === '---';
        if (titleless) {
          html.push({ slideDelimiter: true, title: '', headingHtml: '' });
        } else {
          const text = stripInlineMarkdown(markdownTitle);
          const id = uniqueSlug(slugify(text), slugCounts);
          headings.push({ level: 1, text, id });
          html.push({
            slideDelimiter: true,
            title: text,
            headingHtml: `<h1 id="${id}">${renderInline(markdownTitle, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink)}</h1>`,
          });
        }
        continue;
      }
    }

    const fence = line.match(/^\s*```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      flushParagraph();
      closeList();

      const lang = fence[1] || '';
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }

      const code = escapeHtml(codeLines.join('\n'));
      if (lang.toLowerCase() === 'mermaid') {
        hasMermaid = true;
        html.push(`<div class="diagram-container">
  <button class="diagram-expand-button" type="button" aria-label="Expand diagram" title="Expand diagram">↗</button>
  <pre class="mermaid">${code}</pre>
</div>`);
      } else {
        const className = lang ? ` class="language-${escapeAttr(lang)}"` : '';
        html.push(`<pre><code${className}>${code}</code></pre>`);
      }
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      closeList();

      const level = heading[1].length;
      const text = stripInlineMarkdown(heading[2]);
      const id = uniqueSlug(slugify(text), slugCounts);
      headings.push({ level, text, id });
      html.push(`<h${level} id="${id}">${renderInline(heading[2], imageBaseHref, imageCache, imageDir, embedImages, rewriteLink)}</h${level}>`);
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      closeList();
      if (slides && /^\s{0,3}-{3,}\s*$/.test(line)) {
        html.push({ subslideDelimiter: true });
      } else {
        html.push('<hr>');
      }
      continue;
    }

    if (isTableStart(lines, i)) {
      flushParagraph();
      closeList();

      const { tableHtml, nextIndex } = renderTable(lines, i, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink);
      html.push(tableHtml);
      i = nextIndex;
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      flushParagraph();
      closeList();

      const quoteLines = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      i -= 1;

      const quoteHtml = quoteLines
        .join('\n')
        .split(/\n\s*\n/)
        .map((part) => `<p>${renderInline(part.replace(/\n/g, ' ').trim(), imageBaseHref, imageCache, imageDir, embedImages, rewriteLink)}</p>`)
        .join('\n');
      html.push(`<blockquote>${quoteHtml}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^(\s*)[-+*]\s+(.+)$/);
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();

      const listType = unordered ? 'ul' : 'ol';
      const indent = indentationLevel(unordered ? unordered[1] : ordered[1]);
      const itemText = unordered ? unordered[2] : ordered[3];
      const taskItem = unordered && itemText.match(/^\[( |x|X)?\](?:\s+(.*))?$/);
      if (!openList || openList.type !== listType || openList.indent !== indent) {
        closeList();
        const start = ordered && Number(ordered[2]) > 1 ? ` start="${Number(ordered[2])}"` : '';
        const indentClass = indent > 0 ? ` class="list-indent-${Math.min(indent, 3)}"` : '';
        html.push(`<${listType}${start}${indentClass}>`);
        openList = { type: listType, indent };
      }
      if (taskItem) {
        const checked = taskItem[1] && taskItem[1].toLowerCase() === 'x' ? ' checked' : '';
        const label = taskItem[2] || '';
        html.push(`<li class="task-list-item"><input type="checkbox" disabled${checked}>${renderInline(label, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink)}</li>`);
      } else {
        html.push(`<li>${renderInline(itemText, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink)}</li>`);
      }
      continue;
    }

    closeList();
    paragraphLines.push(line.trim());
  }

  flushParagraph();
  closeList();

  const firstH1 = headings.find((heading) => heading.level === 1);
  const slideResult = slides ? renderSlides(html) : null;
  return {
    body: slides ? slideResult.body : wrapCollapsibleSections(html).join('\n'),
    fallbackTitle,
    frontMatter: frontMatter ? parseFrontMatter(frontMatter.lines) : [],
    hasMermaid,
    headings,
    slides: slides ? slideResult.slides : [],
    title: slideResult && slideResult.title
      ? slideResult.title
      : firstH1 ? firstH1.text : titleize(fallbackTitle),
  };
}

function renderSlides(blocks) {
  const groups = [];
  let current = { title: '', blocks: [], hasDelimiter: false };
  let sawDelimiter = false;

  for (const block of blocks) {
    if (typeof block === 'object' && block.slideDelimiter) {
      if (sawDelimiter || current.blocks.length > 0) groups.push(current);
      current = { title: block.title, blocks: block.headingHtml ? [block.headingHtml] : [], hasDelimiter: true };
      sawDelimiter = true;
      continue;
    }
    current.blocks.push(block);
  }

  if (sawDelimiter || current.blocks.length > 0 || groups.length === 0) groups.push(current);

  const slideGroups = groups.map((group) => {
    const subslides = [[]];
    for (const block of group.blocks) {
      if (group.hasDelimiter && typeof block === 'object' && block.subslideDelimiter) {
        subslides.push([]);
      } else {
        subslides[subslides.length - 1].push(
          typeof block === 'object' && block.subslideDelimiter ? '<hr>' : block,
        );
      }
    }
    return { ...group, subslides };
  });

  const firstGroup = slideGroups[0];
  const firstSlideText = firstGroup && firstGroup.title === ''
    ? firstGroup.subslides[0]
      .filter((block) => block && block.slideText && block.titleText)
      .map((block) => block.titleText)
      .join(' ')
      .trim()
    : '';

  const slideData = slideGroups.map((group, index) => ({
    id: `md2h-slide-${index + 1}`,
    number: index + 1,
    title: group.title || `Slide ${index + 1}`,
    subslideCount: group.subslides.length,
  }));
  const body = slideGroups.flatMap((group, index) => {
    const slide = slideData[index];
    return group.subslides.map((blocks, subslideIndex) => {
      const textLineCount = blocks.reduce((count, block) => count + (block.slideText ? block.lineCount : 0), 0);
      const isCover = subslideIndex === 0
        && group.title === ''
        && blocks.length > 0
        && blocks.every((block) => block.slideText)
        && textLineCount <= 2;
      const renderedBlocks = blocks.map((block) => block.slideText ? block.html : block);
      const mediaIndex = renderedBlocks.length === 1
        ? 0
        : renderedBlocks.length === 2 && /^<h[12]\b/.test(renderedBlocks[0]) ? 1 : -1;
      const imageMatch = mediaIndex >= 0 && renderedBlocks[mediaIndex].match(/^<p>(<img\b[^>]*>)<\/p>$/);
      const isDiagramOnly = mediaIndex >= 0 && renderedBlocks[mediaIndex].startsWith('<div class="diagram-container">');
      const isMediaOnly = Boolean(imageMatch || isDiagramOnly);
      if (imageMatch) {
        renderedBlocks[mediaIndex] = `<div class="slide-image-container">
  <button class="image-expand-button" type="button" aria-label="Zoom image" aria-pressed="false" title="Zoom image (Z)">↗</button>
  ${imageMatch[1]}
</div>`;
      }
      const mainContent = wrapCollapsibleSections(renderedBlocks).join('\n');
      const hasPreviousSubslide = subslideIndex > 0;
      const hasNextSubslide = subslideIndex < group.subslides.length - 1;
      const subslideCue = group.subslides.length > 1
        ? `${hasPreviousSubslide ? `<div class="slide-subslide-cue slide-subslide-cue-child slide-subslide-cue-up" aria-hidden="true">
  <svg class="slide-subslide-chevron slide-subslide-chevron-up" viewBox="0 0 16 10"><path d="M2 8 8 2l6 6"/></svg>
</div>` : ''}
${hasNextSubslide ? `<div class="slide-subslide-cue ${subslideIndex === 0 ? 'slide-subslide-cue-main' : 'slide-subslide-cue-child'} slide-subslide-cue-down" aria-hidden="true">
  <svg class="slide-subslide-chevron slide-subslide-chevron-down" viewBox="0 0 16 10"><path d="m2 2 6 6 6-6"/></svg>
</div>` : ''}`
        : '';
      const active = index === 0 && subslideIndex === 0;
      const id = subslideIndex === 0 ? slide.id : `${slide.id}-${subslideIndex + 1}`;
      const label = group.subslides.length > 1
        ? `${slide.title}, subslide ${subslideIndex + 1} of ${group.subslides.length}`
        : slide.title;
      const classes = ['slide', active ? 'is-active' : '', isCover ? 'slide-cover' : '', isMediaOnly ? 'slide-media-only' : ''].filter(Boolean).join(' ');
      return `<section class="${classes}" id="${id}" data-slide-index="${index}" data-subslide-index="${subslideIndex}" aria-label="${escapeAttr(label)}" aria-hidden="${active ? 'false' : 'true'}">
  <div class="slide-content">
${mainContent}
  </div>
${subslideCue}
</section>`;
    });
  }).join('\n');

  return { body, slides: slideData, title: firstGroup.title || firstSlideText };
}

function wrapCollapsibleSections(blocks) {
  const wrapped = [];
  const openSections = [];

  const closeSectionsThrough = (level) => {
    while (openSections.length > 0 && openSections[openSections.length - 1] >= level) {
      wrapped.push('</div>');
      wrapped.push('</details>');
      openSections.pop();
    }
  };

  const closeAllSections = () => closeSectionsThrough(1);

  for (const block of blocks) {
    const heading = block.match(/^<h([1-6]) id="([^"]+)">(.+)<\/h\1>$/);
    if (!heading) {
      wrapped.push(block);
      continue;
    }

    const level = Number(heading[1]);
    if (level < 3) {
      closeAllSections();
      wrapped.push(block);
      continue;
    }

    closeSectionsThrough(level);
    wrapped.push(`<details class="section-collapse section-level-${level}">`);
    wrapped.push(`<summary><span class="section-chevron" aria-hidden="true"></span><h${level} id="${heading[2]}">${heading[3]}</h${level}></summary>`);
    wrapped.push('<div class="section-content">');
    openSections.push(level);
  }

  closeAllSections();
  return wrapped;
}

function extractFrontMatter(lines) {
  if (!lines[0] || lines[0].trim() !== '---') return null;

  for (let i = 1; i < lines.length; i += 1) {
    if (/^(---|\.\.\.)$/.test(lines[i].trim())) {
      return {
        lines: lines.slice(1, i),
        nextIndex: i + 1,
      };
    }
  }

  return null;
}

function renderFrontMatter(lines) {
  const entries = parseFrontMatter(lines);
  const rows = entries.map((entry) => {
    if (entry.raw) {
      return `<div class="frontmatter-row frontmatter-row-raw">
<dt>raw</dt>
<dd><pre class="frontmatter-nested">${escapeHtml(entry.raw)}</pre></dd>
</div>`;
    }

    return `<div class="frontmatter-row">
<dt>${escapeHtml(entry.key)}</dt>
<dd>${renderFrontMatterValue(entry)}</dd>
</div>`;
  });

  return `<details class="frontmatter">
<summary>Document metadata</summary>
<dl class="frontmatter-grid">
${rows.join('\n')}
</dl>
</details>`;
}

function parseFrontMatter(lines) {
  const entries = [];
  let current = null;

  for (const line of lines) {
    if (/^\s*$/.test(line)) continue;

    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (pair) {
      current = { key: pair[1], value: pair[2], extra: [] };
      entries.push(current);
      continue;
    }

    if (current && /^\s+/.test(line)) {
      current.extra.push(line);
      continue;
    }

    current = null;
    entries.push({ raw: line });
  }

  return entries;
}

function renderFrontMatterValue(entry) {
  const parts = [];
  const value = entry.value.trim();

  if (value) {
    parts.push(`<span class="frontmatter-value-text">${escapeHtml(value)}</span>`);
  } else if (entry.extra.length === 0) {
    parts.push('<span class="frontmatter-empty">empty</span>');
  }

  if (entry.extra.length > 0) {
    parts.push(`<pre class="frontmatter-nested">${escapeHtml(entry.extra.join('\n'))}</pre>`);
  }

  return parts.join('\n');
}

function renderTable(lines, startIndex, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink) {
  const headers = splitTableRow(lines[startIndex]);
  const alignments = splitTableRow(lines[startIndex + 1]).map((cell) => {
    const trimmed = cell.trim();
    if (/^:-+:$/.test(trimmed)) return 'center';
    if (/^-+:$/.test(trimmed)) return 'right';
    if (/^:-+$/.test(trimmed)) return 'left';
    return '';
  });

  const rows = [];
  let i = startIndex + 2;
  while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }

  const headerHtml = headers
    .map((header, index) => tableCell('th', header, alignments[index], imageBaseHref, imageCache, imageDir, embedImages, rewriteLink))
    .join('');
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell, index) => tableCell('td', cell, alignments[index], imageBaseHref, imageCache, imageDir, embedImages, rewriteLink)).join('')}</tr>`)
    .join('\n');

  return {
    nextIndex: i - 1,
    tableHtml: `<table>
<thead><tr>${headerHtml}</tr></thead>
<tbody>
${bodyHtml}
</tbody>
</table>`,
  };
}

function indentationLevel(whitespace) {
  const spaces = whitespace.replace(/\t/g, '    ').length;
  return Math.floor(spaces / 2);
}

function tableCell(tag, value, alignment, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink) {
  const style = alignment ? ` style="text-align: ${alignment}"` : '';
  return `<${tag}${style}>${renderInline(value, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink)}</${tag}>`;
}

function isTableStart(lines, index) {
  if (!lines[index] || !lines[index + 1]) return false;
  if (!/\|/.test(lines[index])) return false;
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[index + 1]);
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
}

function renderInline(value, imageBaseHref, imageCache, imageDir, embedImages, rewriteLink = (url) => url) {
  const codeTokens = [];
  let text = value.replace(/`([^`]+)`/g, (_, code) => {
    const token = `\uE000${codeTokens.length}\uE001`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  text = escapeHtml(text);

  text = text.replace(/!\[([^\]]*)\]\(([^)]+?)(?:\s+"([^"]+)")?\)/g, (_, alt, url, title) => {
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
    return `<img src="${safeImageUrl(url, imageBaseHref, imageCache, imageDir, embedImages)}" alt="${escapeAttr(alt)}"${titleAttr}>`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)]+?)(?:\s+"([^"]+)")?\)/g, (_, label, url, title) => {
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
    return `<a href="${safeUrl(rewriteLink(url))}"${titleAttr}>${label}</a>`;
  });

  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>')
    .replace(/_([^_\s][^_]*?)_/g, '<em>$1</em>');

  return text.replace(/\uE000(\d+)\uE001/g, (_, index) => codeTokens[Number(index)]);
}

function stripInlineMarkdown(value) {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim();
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  return slug || 'section';
}

function uniqueSlug(base, counts) {
  const current = counts.get(base) || 0;
  counts.set(base, current + 1);
  return current === 0 ? base : `${base}-${current + 1}`;
}

function localMarkdownTarget(value, currentInputPath, sourceRoot) {
  const trimmed = value.trim()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return null;

  const suffixIndex = trimmed.search(/[?#]/);
  const encodedPath = suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : trimmed.slice(suffixIndex);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }

  let inputPath;
  if (/\.md$/i.test(decodedPath)) {
    inputPath = path.resolve(path.dirname(currentInputPath), decodedPath);
  } else if (path.extname(decodedPath) === '') {
    const extensionlessInputPath = path.resolve(path.dirname(currentInputPath), `${decodedPath}.md`);
    if (!fs.existsSync(extensionlessInputPath)) return null;
    inputPath = extensionlessInputPath;
  } else {
    return null;
  }

  if (!isPathInside(sourceRoot, inputPath)) return null;

  return { inputPath, suffix };
}

function isPathInside(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ''
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function replaceMarkdownExtension(filePath) {
  return filePath.replace(/\.md$/i, '.html');
}

function encodeRelativeUrlPath(filePath) {
  return filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function safeUrl(value) {
  const trimmed = value.trim();
  if (/^(javascript|data):/i.test(trimmed)) return '#';
  return escapeAttr(trimmed);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.ico': return 'image/x-icon';
    case '.tiff':
    case '.tif': return 'image/tiff';
    default: return 'application/octet-stream';
  }
}

function imageToDataUrl(imagePath, imageCache) {
  if (imageCache.has(imagePath)) {
    return imageCache.get(imagePath);
  }

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const mimeType = getMimeType(imagePath);
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;
    imageCache.set(imagePath, dataUrl);
    return dataUrl;
  } catch (error) {
    console.error(`Warning: Could not embed image ${imagePath}: ${error.message}`);
    return null;
  }
}

function safeImageUrl(value, imageBaseHref, imageCache, imageDir, embedImages) {
  const trimmed = value.trim();
  if (/^(javascript|data):/i.test(trimmed)) return '#';
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(trimmed)) return escapeAttr(trimmed);

  if (!embedImages) {
    return escapeAttr(new URL(trimmed, imageBaseHref).href);
  }

  const resolvedPath = path.resolve(imageDir, trimmed);

  const dataUrl = imageToDataUrl(resolvedPath, imageCache);
  if (dataUrl) {
    return escapeAttr(dataUrl);
  }

  return escapeAttr(new URL(trimmed, imageBaseHref).href);
}

function titleize(value) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function looksLikeHtml(value) {
  return /^\s*(?:<!doctype\s+html\b|<html[\s>])/i.test(value);
}

function frontMatterValue(entries, key) {
  const entry = entries.find((candidate) => !candidate.raw && candidate.key.toLowerCase() === key);
  if (!entry) return '';
  const value = entry.value.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function webFontLinks() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400..800;1,400..800&amp;family=Roboto+Mono:ital,wght@0,400..700;1,400..700&amp;display=swap">`;
}

function buildSlidesDocument({ body, fallbackTitle, frontMatter, hasMermaid, slides, title }) {
  const configuredAppearance = frontMatterValue(frontMatter, 'appearance').toLowerCase();
  const appearance = ['light', 'dark'].includes(configuredAppearance) ? configuredAppearance : '';
  const configuredHighlightTheme = frontMatterValue(frontMatter, 'theme').toLowerCase();
  const safeHighlightTheme = /^[a-z0-9][a-z0-9._/-]*$/.test(configuredHighlightTheme) && !configuredHighlightTheme.includes('..')
    ? configuredHighlightTheme
    : '';
  const highlightTheme = safeHighlightTheme || (appearance === 'light' ? 'github' : 'github-dark');
  const pickerButtons = slides.map((slide) => `<div class="slide-picker-item" data-slide-target="${slide.number - 1}" data-slide-title="${escapeAttr(slide.title)}">
  <div class="slide-picker-preview" data-slide-preview="${slide.number - 1}" aria-hidden="true" inert></div>
  <div class="slide-picker-caption" aria-hidden="true">
    <span class="slide-picker-number">${slide.number}</span>
    <span class="slide-picker-label">${escapeHtml(slide.title)}</span>
    ${slide.subslideCount > 1 ? `<span class="slide-picker-subslides" title="${slide.subslideCount} vertical subslides">↕</span>` : ''}
  </div>
  <button class="slide-picker-select" type="button" data-slide-target="${slide.number - 1}" aria-label="Go to slide ${slide.number}: ${escapeAttr(slide.title)}${slide.subslideCount > 1 ? ` (${slide.subslideCount} vertical subslides)` : ''}"></button>
</div>`).join('\n');

  const mermaidScript = hasMermaid
    ? `<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  const isDark = document.documentElement.dataset.theme === 'dark';
  mermaid.initialize({
    startOnLoad: false,
    fontFamily: 'Inter, ui-sans-serif, sans-serif',
    theme: isDark ? 'dark' : 'default',
    themeVariables: isDark ? {
      primaryColor: '#263544',
      primaryTextColor: '#e5edf5',
      primaryBorderColor: '#aab7c5',
      lineColor: '#aab7c5',
      actorBkg: '#263544',
      actorBorder: '#aab7c5',
      actorTextColor: '#e5edf5',
      actorLineColor: '#718096',
      signalColor: '#aab7c5',
      signalTextColor: '#e5edf5',
      labelBoxBkgColor: '#263544',
      labelBoxBorderColor: '#aab7c5',
      labelTextColor: '#e5edf5',
      loopTextColor: '#e5edf5',
      noteBkgColor: '#334155',
      noteBorderColor: '#aab7c5',
      noteTextColor: '#e5edf5',
      activationBkgColor: '#334155',
      activationBorderColor: '#aab7c5',
      sequenceNumberColor: '#e5edf5',
    } : undefined,
  });
  await document.fonts.ready;
  await mermaid.run();
</script>`
    : '';

  return `<!doctype html>
<html lang="en"${appearance ? ` data-theme="${appearance}"` : ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title || fallbackTitle)}</title>
  ${appearance ? '' : `<script>
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  </script>`}
  ${webFontLinks()}
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/${escapeAttr(highlightTheme)}.min.css">
  <style>${documentStyles()}${slideStyles()}</style>
</head>
<body>
  <main class="deck markdown-body" aria-label="Slide deck">
${body}
  </main>
  <nav class="slide-controls" aria-label="Slide controls">
    <button id="slide-prev" type="button" aria-label="Previous slide" title="Previous slide (Left arrow or H)">←</button>
    <button id="slide-picker-toggle" type="button" aria-label="Open slide picker" title="Slide picker (Escape)"><span id="slide-current">1</span> / ${slides.length}</button>
    <button id="slide-next" type="button" aria-label="Next slide" title="Next slide (Space, Right arrow, or L)">→</button>
  </nav>
  <div id="slide-picker" class="slide-picker" role="dialog" aria-modal="true" aria-label="Slides" aria-hidden="true">
    <div class="slide-picker-panel">
      <div class="slide-picker-heading">
        <h2 id="slide-picker-title">Slides</h2>
        <input id="slide-picker-search" type="search" aria-label="Search slide titles" placeholder="Search slides" autocomplete="off" spellcheck="false" hidden>
        <button id="slide-picker-close" type="button" aria-label="Close slide picker">×</button>
      </div>
      <div class="slide-picker-grid">
${pickerButtons}
        <p id="slide-picker-empty" class="slide-picker-empty" role="status" hidden>No matching slides</p>
      </div>
    </div>
  </div>
  ${mermaidScript}
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
  <script>
    if (window.hljs) hljs.highlightAll();

    const slideElements = Array.from(document.querySelectorAll('.slide'));
    const slideGroups = [];
    slideElements.forEach((slide) => {
      const slideIndex = Number(slide.dataset.slideIndex);
      (slideGroups[slideIndex] ||= []).push(slide);
    });
    const previousButton = document.getElementById('slide-prev');
    const nextButton = document.getElementById('slide-next');
    const currentLabel = document.getElementById('slide-current');
    const deck = document.querySelector('.deck');
    const picker = document.getElementById('slide-picker');
    const pickerToggle = document.getElementById('slide-picker-toggle');
    const pickerClose = document.getElementById('slide-picker-close');
    const pickerTitle = document.getElementById('slide-picker-title');
    const pickerSearch = document.getElementById('slide-picker-search');
    const pickerEmpty = document.getElementById('slide-picker-empty');
    let currentSlide = 0;
    let currentSubslide = 0;
    let selectedPickerSlide = 0;
    let pickerSelectionBeforeSearch = 0;
    let subslideCueIdleTimer;

    function showSubslideCue() {
      deck.classList.remove('is-navigation-idle');
      clearTimeout(subslideCueIdleTimer);
      subslideCueIdleTimer = setTimeout(() => {
        deck.classList.add('is-navigation-idle');
      }, 1500);
    }

    function slideFromHash() {
      const match = window.location.hash.match(/^#md2h-slide-(\\d+)(?:-(\\d+))?$/);
      if (match) return { slide: Number(match[1]) - 1, subslide: Number(match[2] || 1) - 1 };
      const target = window.location.hash ? document.getElementById(decodeURIComponent(window.location.hash.slice(1))) : null;
      const containingSlide = target && target.closest('.slide');
      return containingSlide
        ? { slide: Number(containingSlide.dataset.slideIndex), subslide: Number(containingSlide.dataset.subslideIndex) }
        : { slide: 0, subslide: 0 };
    }

    function goToSlide(index, subslideIndex = 0, updateHash = true) {
      const nextIndex = Math.max(0, Math.min(slideGroups.length - 1, index));
      const nextSubslide = Math.max(0, Math.min(slideGroups[nextIndex].length - 1, subslideIndex));
      slideElements.forEach((slide) => {
        const active = Number(slide.dataset.slideIndex) === nextIndex
          && Number(slide.dataset.subslideIndex) === nextSubslide;
        slide.classList.toggle('is-active', active);
        slide.setAttribute('aria-hidden', String(!active));
      });
      if (nextIndex !== currentSlide || nextSubslide !== currentSubslide) {
        slideGroups[nextIndex][nextSubslide].querySelector('.slide-content').scrollTop = 0;
      }
      currentSlide = nextIndex;
      currentSubslide = nextSubslide;
      currentLabel.textContent = String(currentSlide + 1);
      previousButton.disabled = currentSlide === 0;
      nextButton.disabled = currentSlide === slideGroups.length - 1;
      document.querySelectorAll('.slide-picker-item').forEach((button) => {
        button.classList.toggle('is-current', Number(button.dataset.slideTarget) === currentSlide);
      });
      if (updateHash) {
        const subslideSuffix = currentSubslide === 0 ? '' : '-' + (currentSubslide + 1);
        history.replaceState(null, '', '#md2h-slide-' + (currentSlide + 1) + subslideSuffix);
      }
    }

    function goToHorizontalSlide(offset) {
      goToSlide(currentSlide + offset);
    }

    function goToVerticalSlide(offset) {
      goToSlide(currentSlide, currentSubslide + offset);
    }

    function visiblePickerItems() {
      return Array.from(picker.querySelectorAll('.slide-picker-item:not([hidden])'));
    }

    function setPickerSelection(slideIndex, focus = false) {
      const items = visiblePickerItems();
      let selectedItem = items.find((item) => Number(item.dataset.slideTarget) === slideIndex);
      if (!selectedItem) selectedItem = items[0];
      picker.querySelectorAll('.slide-picker-item').forEach((item) => {
        item.classList.toggle('is-selected', item === selectedItem);
      });
      if (!selectedItem) return;
      selectedPickerSlide = Number(selectedItem.dataset.slideTarget);
      if (focus) {
        selectedItem.querySelector('.slide-picker-select').focus({ preventScroll: true });
        selectedItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }

    function movePickerSelection(offset, vertical = false) {
      const items = visiblePickerItems();
      if (items.length === 0) return;
      const currentIndex = Math.max(0, items.findIndex((item) => Number(item.dataset.slideTarget) === selectedPickerSlide));
      let step = offset;
      if (vertical) {
        const firstTop = items[0].offsetTop;
        const nextRowIndex = items.findIndex((item) => item.offsetTop > firstTop + 1);
        const columnCount = nextRowIndex === -1 ? items.length : nextRowIndex;
        step *= columnCount;
      }
      const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + step));
      setPickerSelection(Number(items[nextIndex].dataset.slideTarget), true);
    }

    function normalizeSlideTitle(value) {
      return value.normalize('NFKD').toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]/gu, '');
    }

    function filterPickerItems() {
      const query = normalizeSlideTitle(pickerSearch.value);
      let visibleCount = 0;
      picker.querySelectorAll('.slide-picker-item').forEach((item) => {
        const matches = normalizeSlideTitle(item.dataset.slideTitle).includes(query);
        item.hidden = !matches;
        if (matches) visibleCount += 1;
      });
      pickerEmpty.hidden = visibleCount !== 0;
      setPickerSelection(selectedPickerSlide);
      sizeSlidePreviews();
    }

    function setPickerSearchOpen(open) {
      pickerTitle.hidden = open;
      pickerSearch.hidden = !open;
      if (open) {
        pickerSearch.focus({ preventScroll: true });
        pickerSearch.select();
      }
    }

    function startPickerSearch() {
      if (pickerSearch.hidden) pickerSelectionBeforeSearch = selectedPickerSlide;
      setPickerSearchOpen(true);
    }

    function resetPickerSearch() {
      pickerSearch.value = '';
      filterPickerItems();
      setPickerSearchOpen(false);
    }

    function setPickerOpen(open) {
      picker.classList.toggle('is-open', open);
      picker.setAttribute('aria-hidden', String(!open));
      if (open) {
        sizeSlidePreviews();
        setPickerSelection(currentSlide, true);
      } else {
        resetPickerSearch();
        pickerToggle.focus({ preventScroll: true });
      }
    }

    previousButton.addEventListener('click', () => goToHorizontalSlide(-1));
    nextButton.addEventListener('click', () => goToHorizontalSlide(1));
    pickerToggle.addEventListener('click', () => setPickerOpen(true));
    pickerClose.addEventListener('click', () => setPickerOpen(false));
    picker.addEventListener('click', (event) => {
      if (event.target === picker) setPickerOpen(false);
    });
    document.querySelectorAll('.slide-picker-select').forEach((button) => {
      button.addEventListener('click', () => {
        goToSlide(Number(button.dataset.slideTarget));
        setPickerOpen(false);
      });
    });
    pickerSearch.addEventListener('input', filterPickerItems);
    pickerSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const items = visiblePickerItems();
        if (items.length === 1) {
          goToSlide(Number(items[0].dataset.slideTarget));
          setPickerOpen(false);
        } else if (items.length > 1) {
          setPickerSelection(selectedPickerSlide, true);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        pickerSearch.value = '';
        filterPickerItems();
        setPickerSearchOpen(false);
        setPickerSelection(pickerSelectionBeforeSearch, true);
      }
    });
    picker.addEventListener('keydown', (event) => {
      if (event.target === pickerSearch) return;
      const searchShortcut = event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f');
      if (searchShortcut) {
        event.preventDefault();
        event.stopPropagation();
        startPickerSearch();
      } else if (event.target === pickerClose) {
        return;
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        goToSlide(selectedPickerSlide);
        setPickerOpen(false);
      } else if (event.key === ' ' || event.key === 'ArrowRight' || event.key === 'l') {
        event.preventDefault();
        event.stopPropagation();
        movePickerSelection(1);
      } else if (event.key === 'ArrowLeft' || event.key === 'h') {
        event.preventDefault();
        event.stopPropagation();
        movePickerSelection(-1);
      } else if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault();
        event.stopPropagation();
        movePickerSelection(1, true);
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault();
        event.stopPropagation();
        movePickerSelection(-1, true);
      }
    });

    document.querySelectorAll('.diagram-expand-button').forEach((button) => {
      const diagram = button.closest('.diagram-container');
      const setExpanded = (expanded) => {
        diagram.classList.toggle('diagram-expanded', expanded);
        button.textContent = expanded ? '↙' : '↗';
        button.setAttribute('aria-label', expanded ? 'Restore diagram size' : 'Expand diagram');
        button.title = expanded ? 'Restore diagram size (Z or Escape)' : 'Expand diagram (Z)';
        button.setAttribute('aria-pressed', String(expanded));
        document.body.classList.toggle('diagram-is-expanded', expanded);
      };
      button.title = 'Expand diagram (Z)';
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => setExpanded(!diagram.classList.contains('diagram-expanded')));
    });

    function setImageZoom(img, zoomed) {
      document.querySelectorAll('.image-zoomed').forEach((other) => {
        if (other !== img) {
          other.classList.remove('image-zoomed');
          const otherButton = other.closest('.slide-image-container')?.querySelector('.image-expand-button');
          if (otherButton) {
            otherButton.textContent = '↗';
            otherButton.setAttribute('aria-label', 'Zoom image');
            otherButton.setAttribute('aria-pressed', 'false');
            otherButton.title = 'Zoom image (Z)';
          }
        }
      });
      img.classList.toggle('image-zoomed', zoomed);
      document.body.classList.toggle('image-zoom-open', zoomed);
      const button = img.closest('.slide-image-container')?.querySelector('.image-expand-button');
      if (button) {
        button.textContent = zoomed ? '↙' : '↗';
        button.setAttribute('aria-label', zoomed ? 'Restore image size' : 'Zoom image');
        button.setAttribute('aria-pressed', String(zoomed));
        button.title = zoomed ? 'Restore image size (Z or Escape)' : 'Zoom image (Z)';
      }
    }

    document.querySelectorAll('.image-expand-button').forEach((button) => {
      const img = button.closest('.slide-image-container').querySelector('img');
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        setImageZoom(img, !img.classList.contains('image-zoomed'));
      });
    });

    document.querySelectorAll('.slide img').forEach((img) => {
      img.addEventListener('click', (event) => {
        event.stopPropagation();
        setImageZoom(img, !img.classList.contains('image-zoomed'));
      });
    });

    document.addEventListener('click', (event) => {
      if (event.target.closest('img')) return;
      document.querySelectorAll('.image-zoomed').forEach((img) => setImageZoom(img, false));
    });

    document.addEventListener('keydown', (event) => {
      const editable = event.target.closest('input, textarea, select, [contenteditable="true"]');
      if (event.key === 'Escape') {
        event.preventDefault();
        const expandedDiagram = document.querySelector('.diagram-expanded');
        if (expandedDiagram) {
          expandedDiagram.querySelector('.diagram-expand-button').click();
          return;
        }
        const zoomedImage = document.querySelector('.image-zoomed');
        if (zoomedImage) {
          setImageZoom(zoomedImage, false);
          return;
        }
        if (picker.classList.contains('is-open')) {
          setPickerOpen(false);
          return;
        }
        setPickerOpen(true);
        return;
      }
      if (editable || picker.classList.contains('is-open') || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'z') {
        event.preventDefault();
        const expandedDiagram = document.querySelector('.diagram-expanded');
        const zoomedImage = document.querySelector('.image-zoomed');
        if (expandedDiagram) {
          expandedDiagram.querySelector('.diagram-expand-button').click();
        } else if (zoomedImage) {
          setImageZoom(zoomedImage, false);
        } else {
          const activeSlide = slideGroups[currentSlide][currentSubslide];
          const mediaButton = activeSlide.querySelector('.image-expand-button, .diagram-expand-button');
          const image = activeSlide.querySelector('img');
          if (mediaButton) {
            mediaButton.click();
          } else if (image) {
            setImageZoom(image, true);
          }
        }
      } else if (event.key === ' ' || event.key === 'ArrowRight' || event.key === 'l') {
        event.preventDefault();
        goToHorizontalSlide(1);
      } else if (event.key === 'ArrowLeft' || event.key === 'h') {
        event.preventDefault();
        goToHorizontalSlide(-1);
      } else if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault();
        goToVerticalSlide(1);
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault();
        goToVerticalSlide(-1);
      }
    });

    function goToHashSlide() {
      const target = slideFromHash();
      goToSlide(target.slide, target.subslide, false);
    }

    function sizeSlidePreviews() {
      const slideWidth = window.innerWidth;
      const slideHeight = window.innerHeight;
      document.querySelectorAll('.slide-picker-preview').forEach((preview) => {
        const miniature = preview.querySelector('.slide');
        if (!miniature) return;
        preview.style.aspectRatio = slideWidth <= 680 ? '16 / 10' : slideWidth + ' / ' + slideHeight;
        miniature.style.width = slideWidth + 'px';
        miniature.style.height = slideHeight + 'px';
        miniature.style.transform = 'scale(' + (preview.clientWidth / slideWidth) + ')';
      });
    }

    function buildSlidePreviews() {
      document.querySelectorAll('.slide-picker-preview').forEach((preview) => {
        const slideIndex = Number(preview.dataset.slidePreview);
        const source = slideGroups[slideIndex]?.[0];
        if (!source) return;
        const miniature = source.cloneNode(true);
        miniature.classList.remove('is-active');
        miniature.removeAttribute('id');
        miniature.setAttribute('aria-hidden', 'true');
        miniature.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
        miniature.querySelectorAll('a').forEach((link) => {
          link.removeAttribute('href');
          link.removeAttribute('target');
        });
        preview.append(miniature);
      });
      sizeSlidePreviews();
    }

    window.addEventListener('hashchange', goToHashSlide);
    window.addEventListener('resize', sizeSlidePreviews);
    document.addEventListener('pointermove', showSubslideCue, { passive: true });
    document.addEventListener('pointerdown', showSubslideCue, { passive: true });
    document.addEventListener('keydown', showSubslideCue);
    buildSlidePreviews();
    goToHashSlide();
    showSubslideCue();
  </script>
</body>
</html>
`;
}

function buildDocument({ body, fallbackTitle, hasMermaid, headings, title }) {
  const tocLinks = headings
    .filter((heading) => heading.level >= 2 && heading.level <= 3)
    .map((heading) => {
      return `<a class="toc-level-${heading.level}" href="#${heading.id}">${escapeHtml(heading.text)}</a>`;
    })
    .join('\n');

  const toc = tocLinks
    ? `<aside class="toc" aria-label="Outline">
  <div class="toc-heading">
    <div class="toc-title">Outline</div>
    <button id="toc-hide" class="toc-toggle" type="button" aria-label="Hide outline" aria-expanded="true" title="Hide outline"><span aria-hidden="true">⌄</span></button>
  </div>
  <nav>${tocLinks}</nav>
</aside>`
    : '';

  const mermaidScript = hasMermaid
    ? `<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  const isDark = document.documentElement.dataset.theme === 'dark';
  mermaid.initialize({
    startOnLoad: false,
    fontFamily: 'Inter, ui-sans-serif, sans-serif',
    theme: isDark ? 'dark' : 'default',
    themeVariables: isDark ? {
      primaryColor: '#263544',
      primaryTextColor: '#e5edf5',
      primaryBorderColor: '#aab7c5',
      lineColor: '#aab7c5',
      actorBkg: '#263544',
      actorBorder: '#aab7c5',
      actorTextColor: '#e5edf5',
      actorLineColor: '#718096',
      signalColor: '#aab7c5',
      signalTextColor: '#e5edf5',
      labelBoxBkgColor: '#263544',
      labelBoxBorderColor: '#aab7c5',
      labelTextColor: '#e5edf5',
      loopTextColor: '#e5edf5',
      noteBkgColor: '#334155',
      noteBorderColor: '#aab7c5',
      noteTextColor: '#e5edf5',
      activationBkgColor: '#334155',
      activationBorderColor: '#aab7c5',
      sequenceNumberColor: '#e5edf5',
    } : undefined,
  });
  await document.fonts.ready;
  await mermaid.run();
</script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title || fallbackTitle)}</title>
  <script>
    (() => {
      const savedTheme = localStorage.getItem('md2h-theme');
      const theme = savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      document.documentElement.dataset.theme = theme;
    })();
  </script>
  ${webFontLinks()}
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css">
  <style>${documentStyles()}</style>
</head>
<body>
  <div class="page-shell${toc ? '' : ' no-toc'}">
    ${toc}
    <main class="markdown-body">
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch to dark theme" aria-pressed="false"><span aria-hidden="true">☾</span></button>
      ${toc ? '<button id="toc-show" class="toc-show" type="button" aria-label="Show outline" title="Show outline"><span aria-hidden="true">›</span></button>' : ''}
${body}
    </main>
  </div>
  ${mermaidScript}
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
  <script>
    hljs.highlightAll();

    const root = document.documentElement;
    const themeToggle = document.getElementById('theme-toggle');
    const tocHide = document.getElementById('toc-hide');
    const tocShow = document.getElementById('toc-show');
    const pageShell = document.querySelector('.page-shell');

    function updateThemeButton() {
      const isDark = root.dataset.theme === 'dark';
      themeToggle.innerHTML = isDark ? '<span aria-hidden="true">☀</span>' : '<span aria-hidden="true">☾</span>';
      themeToggle.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
      themeToggle.setAttribute('aria-pressed', String(isDark));
    }

    themeToggle.addEventListener('click', () => {
      const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = nextTheme;
      localStorage.setItem('md2h-theme', nextTheme);
      updateThemeButton();
    });

    if (tocHide && tocShow) {
      tocHide.addEventListener('click', () => {
        pageShell.classList.add('sidebar-hidden');
        tocHide.setAttribute('aria-expanded', 'false');
        tocShow.focus({ preventScroll: true });
      });

      tocShow.addEventListener('click', () => {
        pageShell.classList.remove('sidebar-hidden');
        tocHide.setAttribute('aria-expanded', 'true');
        tocHide.focus({ preventScroll: true });
      });
    }

    updateThemeButton();

    document.querySelectorAll('.diagram-expand-button').forEach((button) => {
      const diagram = button.closest('.diagram-container');
      const setExpanded = (expanded) => {
        diagram.classList.toggle('diagram-expanded', expanded);
        button.textContent = expanded ? '↙' : '↗';
        button.setAttribute('aria-label', expanded ? 'Restore diagram size' : 'Expand diagram');
        button.title = expanded ? 'Restore diagram size' : 'Expand diagram';
        button.setAttribute('aria-pressed', String(expanded));
        document.body.classList.toggle('diagram-is-expanded', expanded);
      };

      button.addEventListener('click', () => setExpanded(!diagram.classList.contains('diagram-expanded')));
      diagram.addEventListener('click', (event) => {
        if (event.target === diagram) setExpanded(false);
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      document.querySelectorAll('.diagram-expanded').forEach((diagram) => {
        diagram.querySelector('.diagram-expand-button').click();
      });
      document.querySelectorAll('.image-zoomed').forEach((img) => {
        img.classList.remove('image-zoomed');
        document.body.classList.remove('image-zoom-open');
      });
    });

    // Image zoom functionality
    document.querySelectorAll('.markdown-body img').forEach((img) => {
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (event) => {
        event.stopPropagation();
        if (img.classList.contains('image-zoomed')) {
          img.classList.remove('image-zoomed');
          document.body.classList.remove('image-zoom-open');
        } else {
          document.querySelectorAll('.image-zoomed').forEach((otherImg) => {
            otherImg.classList.remove('image-zoomed');
          });
          img.classList.add('image-zoomed');
          document.body.classList.add('image-zoom-open');
        }
      });
    });

    document.addEventListener('click', (event) => {
      if (!event.target.closest('img')) {
        document.querySelectorAll('.image-zoomed').forEach((img) => {
          img.classList.remove('image-zoomed');
        });
        document.body.classList.remove('image-zoom-open');
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      document.querySelectorAll('.diagram-expanded').forEach((diagram) => {
        diagram.querySelector('.diagram-expand-button').click();
      });
    });

    function openCollapsedSectionForHash() {
      if (!window.location.hash) return;
      const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
      if (!target) return;
      target.closest('main')?.querySelectorAll('details.section-collapse').forEach((section) => {
        if (section.contains(target)) section.setAttribute('open', '');
      });
    }

    window.addEventListener('hashchange', openCollapsedSectionForHash);
    openCollapsedSectionForHash();
  </script>
</body>
</html>
`;
}

function documentStyles() {
  return `
:root {
  color-scheme: light;
  --bg: #f7f8fb;
  --panel: #ffffff;
  --text: #17202a;
  --muted: #5c6672;
  --border: #d9dee7;
  --border-strong: #c3cad6;
  --accent: #0f766e;
  --accent-soft: #e8f4f2;
  --code-bg: #f1f4f8;
  --code-text: #9a3412;
  --shadow: 0 18px 48px rgb(22 34 51 / 10%);
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background:
    linear-gradient(180deg, #eef3f8 0, var(--bg) 280px),
    var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.65;
}

.page-shell {
  position: relative;
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(0, 920px);
  gap: 32px;
  max-width: 1250px;
  margin: 0 auto;
  padding: 40px 28px 64px;
  transition: grid-template-columns 0.2s ease;
}

.page-shell.sidebar-hidden {
  grid-template-columns: minmax(0, 1fr);
  max-width: 1250px;
}

.page-shell.sidebar-hidden .toc {
  display: none;
}

.theme-toggle,
.toc-toggle,
.toc-show,
.diagram-expand-button,
.image-expand-button {
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1.2;
}

.theme-toggle {
  position: absolute;
  top: 18px;
  right: 28px;
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 1.2rem;
}

.toc-show {
  display: none;
}

.page-shell.sidebar-hidden .toc-show {
  position: absolute;
  top: 18px;
  left: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
}

.toc-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.toc-title {
  margin-bottom: 0;
}

.toc-toggle {
  display: inline-flex;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  font-size: 1.2rem;
  line-height: 1;
}

.toc-show span {
  font-size: 1.6rem;
  line-height: 1;
}

.theme-toggle:hover,
.toc-toggle:hover,
.toc-show:hover,
.diagram-expand-button:hover,
.image-expand-button:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.theme-toggle:focus-visible,
.toc-toggle:focus-visible,
.toc-show:focus-visible,
.diagram-expand-button:focus-visible,
.image-expand-button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 35%, transparent);
  outline-offset: 2px;
}

.page-shell.no-toc {
  display: block;
  max-width: 980px;
}

.toc {
  align-self: start;
  position: sticky;
  top: 24px;
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  box-shadow: 0 8px 24px rgb(22 34 51 / 7%);
}

.toc-title {
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.toc a {
  display: block;
  padding: 6px 0;
  color: var(--text);
  font-size: 0.92rem;
  line-height: 1.35;
  text-decoration: none;
}

.toc a:hover {
  color: var(--accent);
}

.toc-level-3 {
  padding-left: 14px !important;
  color: var(--muted) !important;
  font-size: 0.86rem !important;
}

.markdown-body {
  position: relative;
  width: 100%;
  padding: 48px 58px 58px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: var(--shadow);
}

.markdown-body > :first-child {
  margin-top: 0;
}

.markdown-body > :last-child {
  margin-bottom: 0;
}

.frontmatter {
  margin: 0 0 28px;
  padding: 14px 16px;
  border: 1px solid #d3d8e0;
  border-radius: 8px;
  background: #f0f2f5;
}

.frontmatter summary {
  cursor: pointer;
  color: #334155;
  font-weight: 800;
}

.frontmatter-grid {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px 18px;
  margin: 12px 0 0;
}

.frontmatter-row {
  display: contents;
}

.frontmatter dt,
.frontmatter dd {
  margin: 0;
}

.frontmatter dt {
  color: #1f2937;
  font-weight: 800;
}

.frontmatter dd {
  min-width: 0;
  color: #374151;
  overflow-wrap: anywhere;
}

.frontmatter-empty {
  color: var(--muted);
  font-style: italic;
}

.frontmatter-nested {
  margin: 2px 0 0;
  padding: 8px 10px;
  border: 1px solid #d7dce4;
  border-radius: 6px;
  background: #e6e9ee;
  color: #334155;
  white-space: pre-wrap;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  line-height: 1.25;
  letter-spacing: 0;
}

h1 {
  margin: 0 0 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: clamp(2rem, 4vw, 3.05rem);
}

h2 {
  margin: 48px 0 16px;
  padding-top: 12px;
  color: var(--text);
  font-size: 1.65rem;
}

h3 {
  margin: 34px 0 10px;
  color: var(--text);
  font-size: 1.25rem;
}

h4,
h5,
h6 {
  margin: 26px 0 8px;
  color: var(--text);
}

.section-collapse {
  margin: 18px 0;
  border-top: 1px solid var(--border);
}

.section-collapse summary {
  display: flex;
  align-items: baseline;
  gap: 9px;
  list-style: none;
  cursor: pointer;
}

.section-collapse summary::-webkit-details-marker {
  display: none;
}

.section-collapse summary h3,
.section-collapse summary h4,
.section-collapse summary h5,
.section-collapse summary h6 {
  margin-bottom: 0;
}

.section-chevron {
  display: inline-block;
  width: 0;
  height: 0;
  flex: 0 0 auto;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-left: 7px solid var(--muted);
  transform: translateY(-1px);
  transition: transform 0.14s ease;
}

.section-collapse[open] > summary .section-chevron {
  transform: translateY(-1px) rotate(90deg);
}

.section-content {
  margin-left: 18px;
  padding-top: 10px;
}

.section-level-4,
.section-level-5,
.section-level-6 {
  margin-left: 12px;
}

p,
ul,
ol,
blockquote,
pre,
table {
  margin: 0 0 18px;
}

p {
  color: var(--text);
}

a {
  color: var(--accent);
  font-weight: 600;
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.18em;
}

ul,
ol {
  padding-left: 1.4rem;
}

.list-indent-1 {
  margin-left: 1.5rem;
}

.list-indent-2 {
  margin-left: 3rem;
}

.list-indent-3 {
  margin-left: 4.5rem;
}

li {
  margin: 0.36rem 0;
}

.task-list-item {
  list-style: none;
}

.task-list-item input[type="checkbox"] {
  width: 1rem;
  height: 1rem;
  margin: 0 0.5rem 0 -1.4rem;
  vertical-align: -0.12rem;
  accent-color: var(--accent);
}

blockquote {
  padding: 14px 18px;
  border-left: 4px solid var(--accent);
  border-radius: 0 8px 8px 0;
  background: var(--accent-soft);
  color: var(--text);
}

blockquote p {
  color: inherit;
}

hr {
  height: 1px;
  margin: 34px 0;
  border: 0;
  background: var(--border);
}

code {
  padding: 0.13rem 0.34rem;
  border: 1px solid #e4e8ef;
  border-radius: 5px;
  background: var(--code-bg);
  color: var(--code-text);
  font-family: "Roboto Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 0.92em;
}

pre {
  overflow: auto;
  padding: 18px;
  border: 1px solid #dbe2ea;
  border-radius: 8px;
  background: #101923;
  color: #ecf3f8;
  line-height: 1.5;
}

pre code {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
}

pre.mermaid {
  background: var(--panel);
  color: var(--text);
  text-align: center;
  white-space: pre;
}

.diagram-container {
  position: relative;
  margin-bottom: 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}

.diagram-container pre.mermaid {
  margin-bottom: 0;
  border: 0;
}

.diagram-container > .mermaid {
  margin: 0;
  overflow: auto;
}

.diagram-expand-button,
.image-expand-button {
  position: absolute;
  z-index: 1;
  top: 10px;
  right: 10px;
  width: 30px;
  height: 30px;
  padding: 0;
  font-size: 1.1rem;
}

.slide-image-container:has(.image-zoomed) .image-expand-button {
  position: fixed;
  z-index: 10001;
  top: 10px;
  right: 10px;
}

.diagram-expanded {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100vw;
  height: 100vh;
  margin: 0;
  overflow: auto;
  border: 0;
  border-radius: 0;
  background: var(--panel);
}

.diagram-expanded pre.mermaid {
  width: min(1200px, calc(100vw - 72px));
  max-height: calc(100vh - 72px);
}

.diagram-expanded > .mermaid {
  width: min(1200px, calc(100vw - 72px));
  max-height: calc(100vh - 72px);
  overflow: auto;
}

.diagram-is-expanded {
  overflow: hidden;
}

table {
  width: 100%;
  border-collapse: collapse;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 0.95rem;
}

th,
td {
  padding: 11px 13px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

th {
  background: var(--code-bg);
  color: var(--text);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

tr:last-child td {
  border-bottom: 0;
}

img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}

@media (max-width: 980px) {
  .page-shell {
    padding-top: 20px;
  }

  .theme-toggle {
    top: 10px;
    right: 10px;
  }

  .page-shell.sidebar-hidden .toc-show {
    top: 10px;
    left: 10px;
  }

  .page-shell {
    display: block;
    padding-right: 14px;
    padding-bottom: 36px;
    padding-left: 14px;
  }

  .toc {
    position: static;
    max-height: none;
    margin-bottom: 18px;
  }

  .toc nav {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0 16px;
  }

  .markdown-body {
    padding: 28px 20px 34px;
  }

  .frontmatter-grid {
    grid-template-columns: 1fr;
    gap: 4px;
  }

  .frontmatter dd {
    margin-bottom: 8px;
  }
}

@media print {
  body {
    background: #fff;
  }

  .page-shell {
    display: block;
    max-width: none;
    padding: 0;
  }

  .toc {
    display: none;
  }

  .markdown-body {
    padding: 0;
    border: 0;
    box-shadow: none;
  }
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #10151c;
    --panel: #18212b;
    --text: #e5edf5;
    --muted: #9aa8b7;
    --border: #344252;
    --border-strong: #526275;
    --accent: #5eead4;
    --accent-soft: #173c3b;
    --code-bg: #202c38;
    --code-text: #fdba74;
    --shadow: 0 18px 48px rgb(0 0 0 / 30%);
  }
}

html[data-theme="dark"] {
  color-scheme: dark;
  --bg: #10151c;
  --panel: #18212b;
  --text: #e5edf5;
  --muted: #9aa8b7;
  --border: #344252;
  --border-strong: #526275;
  --accent: #5eead4;
  --accent-soft: #173c3b;
  --code-bg: #202c38;
  --code-text: #fdba74;
  --shadow: 0 18px 48px rgb(0 0 0 / 30%);
}

html[data-theme="dark"] body {
  background: linear-gradient(180deg, #182330 0, var(--bg) 280px), var(--bg);
}

html[data-theme="dark"] .frontmatter {
  border-color: var(--border);
  background: var(--code-bg);
}

html[data-theme="dark"] .frontmatter summary,
html[data-theme="dark"] .frontmatter dt,
html[data-theme="dark"] .frontmatter dd,
html[data-theme="dark"] .frontmatter-nested {
  color: var(--text);
}

html[data-theme="dark"] .frontmatter-nested {
  border-color: var(--border);
  background: var(--panel);
}

html[data-theme="dark"] code {
  border-color: transparent;
  background: #202b36;
}

html[data-theme="dark"] .diagram-container .mermaid {
  background: var(--panel);
}

html[data-theme="dark"] .diagram-container .mermaid svg text,
html[data-theme="dark"] .diagram-container .mermaid svg tspan {
  fill: var(--text) !important;
}

html[data-theme="dark"] .diagram-container .mermaid svg .node rect,
html[data-theme="dark"] .diagram-container .mermaid svg .node polygon,
html[data-theme="dark"] .diagram-container .mermaid svg .node circle,
html[data-theme="dark"] .diagram-container .mermaid svg .node path {
  fill: #263544 !important;
  stroke: #aab7c5 !important;
}

html[data-theme="dark"] .diagram-container .mermaid svg .actor rect,
html[data-theme="dark"] .diagram-container .mermaid svg .labelBox,
html[data-theme="dark"] .diagram-container .mermaid svg .note,
html[data-theme="dark"] .diagram-container .mermaid svg .activation0,
html[data-theme="dark"] .diagram-container .mermaid svg .activation1,
html[data-theme="dark"] .diagram-container .mermaid svg .activation2 {
  fill: #263544 !important;
  stroke: #aab7c5 !important;
}

html[data-theme="dark"] .diagram-container .mermaid svg .edgePath .path,
html[data-theme="dark"] .diagram-container .mermaid svg .flowchart-link,
html[data-theme="dark"] .diagram-container .mermaid svg .messageLine0,
html[data-theme="dark"] .diagram-container .mermaid svg .messageLine1,
html[data-theme="dark"] .diagram-container .mermaid svg .actor-line,
html[data-theme="dark"] .diagram-container .mermaid svg .loopLine {
  stroke: #aab7c5 !important;
}

html[data-theme="dark"] .diagram-container .mermaid svg marker path {
  fill: #aab7c5 !important;
}

html[data-theme="dark"] .diagram-container .mermaid svg foreignObject div,
html[data-theme="dark"] .diagram-container .mermaid svg foreignObject span {
  color: #e5edf5 !important;
  background: transparent !important;
}

/* Image zoom styles */
.markdown-body img {
  cursor: zoom-in;
  transition: box-shadow 0.2s ease;
}

.markdown-body img.image-zoomed {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(1);
  max-width: 90vw;
  max-height: 90vh;
  width: auto;
  height: auto;
  z-index: 10000;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.9), 0 20px 60px rgba(0, 0, 0, 0.5);
  border-radius: 8px;
  object-fit: contain;
}

body.image-zoom-open {
  overflow: hidden;
}

body.image-zoom-open .markdown-body img:not(.image-zoomed) {
  pointer-events: none;
}
`;
}

function slideStyles() {
  return `

/* Slide mode overrides are appended only to --slides documents. */
html,
body {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

body {
  background: var(--bg);
  font-size: clamp(16px, 1.45vw, 24px);
  line-height: 1.5;
}

.deck.markdown-body {
  position: relative;
  width: 100vw;
  height: 100dvh;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: var(--panel);
  box-shadow: none;
}

.slide {
  position: absolute;
  inset: 0;
  visibility: hidden;
  overflow: hidden;
  background: var(--panel);
  opacity: 0;
  pointer-events: none;
}

.slide.is-active {
  z-index: 1;
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
}

.slide-content {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: clamp(28px, 5vw, 80px) clamp(32px, 7vw, 112px) clamp(78px, 8vh, 104px);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.slide-content > * {
  flex: 0 0 auto;
}

.slide-cover .slide-content {
  align-items: center;
  justify-content: center;
  padding-bottom: clamp(28px, 5vw, 80px);
  text-align: center;
}

.slide-cover .slide-content > p {
  max-width: 16ch;
  margin: 0.08em 0;
  color: var(--text);
  font-size: clamp(3.25rem, 8vw, 8rem);
  font-weight: 800;
  letter-spacing: -0.045em;
  line-height: 1.04;
  text-wrap: balance;
}

.slide-subslide-cue {
  position: absolute;
  z-index: 2;
  left: 50%;
  display: flex;
  align-items: center;
  color: var(--accent);
  opacity: 1;
  pointer-events: none;
  transform: translateX(-50%);
  transition: opacity 0.35s ease;
}

.slide-subslide-cue-up {
  top: max(clamp(4px, 1vh, 18px), env(safe-area-inset-top));
}

.slide-subslide-cue-down {
  bottom: max(clamp(18px, 4vh, 40px), env(safe-area-inset-bottom));
}

.slide-subslide-chevron {
  width: 26px;
  height: 16px;
  overflow: visible;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.slide-subslide-cue-main .slide-subslide-chevron {
  width: clamp(64px, 8vw, 112px);
  height: clamp(40px, 5vw, 70px);
  stroke-width: 1.25;
}

.slide-subslide-cue-main .slide-subslide-chevron-down {
  animation: subslide-cue-float 1.8s ease-in-out infinite;
}

.deck.is-navigation-idle .slide.is-active .slide-subslide-cue-child {
  opacity: 0;
}

@keyframes subslide-cue-float {
  0%,
  100% {
    opacity: 0.58;
    transform: translateY(-0.08em);
  }

  50% {
    opacity: 1;
    transform: translateY(0.08em);
  }
}

@media (prefers-reduced-motion: reduce) {
  .slide-subslide-cue-main .slide-subslide-chevron-down {
    animation: none;
  }
}

.slide h1 {
  margin: 0 0 clamp(22px, 4vh, 46px);
  padding: 0 0 clamp(14px, 2vh, 24px);
  font-size: clamp(2.2rem, 5.5vw, 5.5rem);
}

.slide h2 {
  margin: clamp(24px, 4vh, 42px) 0 16px;
  padding-top: 0;
  font-size: clamp(1.55rem, 3vw, 3rem);
}

.slide h3 {
  font-size: clamp(1.25rem, 2.15vw, 2.1rem);
}

.slide p,
.slide ul,
.slide ol,
.slide blockquote,
.slide pre,
.slide table,
.slide .diagram-container {
  margin-bottom: clamp(14px, 2.2vh, 28px);
}

.slide table {
  font-size: clamp(0.72rem, 1.25vw, 1rem);
}

.slide th,
.slide td {
  padding: clamp(7px, 1vh, 13px) clamp(8px, 1vw, 15px);
}

.slide pre {
  max-height: none;
  font-size: clamp(0.72rem, 1.1vw, 1rem);
}

.slide img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.slide-media-only .slide-content {
  overflow: hidden;
}

.slide-media-only .slide-content > .diagram-container:not(.diagram-expanded),
.slide-media-only .slide-content > .slide-image-container {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin-bottom: 0;
}

.slide-media-only .slide-content > .diagram-container:not(.diagram-expanded) > .mermaid {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.slide-media-only .diagram-container:not(.diagram-expanded) .mermaid svg {
  width: 100% !important;
  height: 100% !important;
  max-width: 100%;
  max-height: 100%;
}

.slide-media-only .slide-image-container > img:not(.image-zoomed) {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.slide .diagram-container.diagram-expanded {
  margin: 0;
}

.slide-controls {
  position: fixed;
  z-index: 20;
  right: max(18px, env(safe-area-inset-right));
  bottom: max(16px, env(safe-area-inset-bottom));
  display: flex;
  gap: 6px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  box-shadow: 0 8px 24px rgb(22 34 51 / 12%);
  backdrop-filter: blur(10px);
}

.slide-controls button,
.slide-picker button {
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  font: inherit;
}

.slide-controls button {
  min-width: 42px;
  height: 36px;
  padding: 0 11px;
  font-size: 0.72rem;
  font-weight: 750;
}

.slide-controls button:disabled {
  cursor: default;
  opacity: 0.35;
}

.slide-controls button:not(:disabled):hover,
.slide-picker button:hover,
.slide-picker button.is-current {
  border-color: var(--accent);
  color: var(--accent);
}

.slide-controls button:focus-visible,
.slide-picker button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 35%, transparent);
  outline-offset: 2px;
}

.slide-picker {
  position: fixed;
  z-index: 20000;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  padding: clamp(18px, 4vw, 56px);
  background: rgb(0 0 0 / 62%);
  backdrop-filter: blur(7px);
}

.slide-picker.is-open {
  display: flex;
}

.slide-picker-panel {
  width: min(100%, 980px);
  min-width: 0;
  max-height: min(82vh, 760px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 24px 80px rgb(0 0 0 / 38%);
}

.slide-picker-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border);
}

.slide-picker-heading h2 {
  margin: 0;
  padding: 0;
  font-size: 1.15rem;
}

.slide-picker-heading input {
  width: min(100%, 460px);
  height: 36px;
  padding: 0 11px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 0.82rem;
}

.slide-picker-heading input:focus {
  border-color: var(--accent);
  outline: 3px solid color-mix(in srgb, var(--accent) 35%, transparent);
  outline-offset: 1px;
}

.slide-picker-heading button {
  width: 36px;
  height: 36px;
  font-size: 1.35rem;
}

.slide-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 14px;
  max-height: calc(min(82vh, 760px) - 74px);
  padding: 18px;
  overflow-y: auto;
}

.slide-picker-item {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--panel);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}

.slide-picker-item[hidden] {
  display: none;
}

.slide-picker-item:hover,
.slide-picker-item.is-current,
.slide-picker-item.is-selected {
  border-color: var(--accent);
  box-shadow: 0 8px 24px rgb(22 34 51 / 14%);
}

.slide-picker-item:hover {
  transform: translateY(-1px);
}

.slide-picker-item:focus-within,
.slide-picker-item.is-selected {
  outline: 3px solid color-mix(in srgb, var(--accent) 35%, transparent);
  outline-offset: 2px;
}

.slide-picker-empty {
  grid-column: 1 / -1;
  margin: 0;
  padding: 40px 20px;
  color: var(--muted);
  text-align: center;
}

.slide-picker-preview {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  pointer-events: none;
}

.slide-picker-preview > .slide {
  position: absolute;
  inset: 0 auto auto 0;
  display: block;
  visibility: visible;
  overflow: hidden;
  opacity: 1;
  transform-origin: top left;
  pointer-events: none;
}

.slide-picker-preview .diagram-expand-button,
.slide-picker-preview .image-expand-button,
.slide-picker-preview .slide-subslide-cue {
  display: none;
}

.slide-picker-caption {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  color: var(--text);
  font-size: 0.78rem;
  font-weight: 700;
}

.slide-picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slide-picker-select {
  position: absolute;
  z-index: 1;
  inset: 0;
  width: 100%;
  padding: 0;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  color: transparent !important;
}

.slide-picker-select:focus {
  outline: none;
}

.slide-picker-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--code-bg);
  color: var(--muted);
  font-size: 0.72rem;
  font-weight: 800;
}

.slide-picker-subslides {
  margin-left: auto;
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 1.15rem;
  font-weight: 800;
}

@media (max-width: 680px) {
  .slide-content {
    padding: 24px 22px 76px;
  }

  .slide-picker-grid {
    grid-template-columns: 1fr;
  }
}

@media print {
  html,
  body {
    height: auto;
    overflow: visible;
  }

  .deck.markdown-body {
    width: auto;
    height: auto;
    overflow: visible;
  }

  .slide,
  .slide.is-active {
    position: relative;
    visibility: visible;
    width: 100%;
    height: 100vh;
    overflow: hidden;
    break-after: page;
    opacity: 1;
    pointer-events: auto;
  }

  .slide-content {
    overflow: hidden;
  }

  .slide-controls,
  .slide-picker,
  .diagram-expand-button,
  .image-expand-button {
    display: none !important;
  }
}
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
