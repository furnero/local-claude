// Markdown -> safe HTML: marked (GFM) + highlight.js for code + KaTeX for math, sanitized with
// DOMPurify. Code blocks get a header with the language, a copy button and (for HTML/SVG) a
// Preview button; thread.js handles those clicks.
import { icon } from './icons.js';

const { Marked, DOMPurify, hljs, katex } = window.Vendor;

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderMath(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore' });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

const mathExtension = {
  extensions: [
    {
      name: 'mathBlock',
      level: 'block',
      start: (src) => src.match(/\$\$|\\\[/)?.index,
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src) || /^\\\[([\s\S]+?)\\\][^\S\n]*(?:\n|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer: (t) => `<div class="math-block">${renderMath(t.text, true)}</div>`,
    },
    {
      name: 'mathInline',
      level: 'inline',
      start: (src) => src.match(/\$|\\\(/)?.index,
      tokenizer(src) {
        const m =
          /^\$\$([^\n$]+?)\$\$/.exec(src) ||
          /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?![\d\w])/.exec(src) ||
          /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
      },
      renderer: (t) => renderMath(t.text, false),
    },
  ],
};

const PREVIEWABLE = new Set(['html', 'svg', 'xml-svg']);

const marked = new Marked({ gfm: true, breaks: false });
marked.use(mathExtension);
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      let body;
      if (language && hljs.getLanguage(language)) {
        try {
          body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } catch {
          body = esc(text);
        }
      } else {
        body = esc(text);
      }
      const isSvg = language === 'svg' || (language === 'xml' && /^\s*<svg[\s>]/i.test(text));
      const canPreview = PREVIEWABLE.has(language) || isSvg;
      const label = language || 'text';
      return `<div class="code-block" data-lang="${esc(label)}${isSvg ? ' svg' : ''}">
<div class="code-head"><span class="code-lang">${esc(label)}</span><span class="code-actions">${
        canPreview ? `<button class="code-btn code-preview" title="Preview">${icon('eye', 14)}<span>Preview</span></button>` : ''
      }<button class="code-btn code-copy" title="Copy code">${icon('copy', 14)}<span>Copy</span></button></span></div>
<pre><code class="hljs">${body}</code></pre></div>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = /^(https?:|mailto:)/i.test(href || '') ? href : '#';
      return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${text}</a>`;
    },
    table(token) {
      // wrap tables so wide ones scroll instead of stretching the column
      const html = marked.Renderer.prototype.table.call(this, token);
      return `<div class="table-wrap">${html}</div>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const PURIFY = {
  ADD_TAGS: ['semantics', 'annotation', 'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'mspace', 'mtable', 'mtr', 'mtd', 'mstyle', 'munder', 'mover', 'munderover', 'mroot', 'menclose', 'mpadded', 'mphantom'],
  ADD_ATTR: ['target', 'aria-hidden', 'encoding', 'data-lang', 'title'],
  FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed'],
};
// our own code-block buttons are added after sanitizing, so DOMPurify can keep forbidding <button>
const PURIFY_TRUSTED = { ...PURIFY, FORBID_TAGS: PURIFY.FORBID_TAGS.filter((t) => t !== 'button') };

/** Markdown from the model -> sanitized HTML. */
export function renderMarkdown(text) {
  const html = marked.parse(text || '');
  return DOMPurify.sanitize(html, PURIFY_TRUSTED);
}

/** Plain user text -> HTML with line breaks kept. */
export function renderPlain(text) {
  return esc(text || '');
}

export { esc };
