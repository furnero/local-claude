// Bundled by scripts/vendor.js into src/renderer/vendor/vendor.js (window.Vendor).
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import dos from 'highlight.js/lib/languages/dos';
import katex from 'katex';

hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('dos', dos);
hljs.registerAliases(['ps1', 'pwsh', 'ps'], { languageName: 'powershell' });
hljs.registerAliases(['cmd', 'bat', 'batch'], { languageName: 'dos' });

window.Vendor = { Marked, DOMPurify, hljs, katex };
