// @ts-check
'use strict';

const fs = require('fs');

let createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, CompletionItemKind;

/** @type {typeof import('vscode-languageserver-textdocument').TextDocument} */
let TextDocument;
/** @type {typeof import('vscode-css-languageservice').getCSSLanguageService} */
let getCSSLanguageService;
/** @type {typeof import('vscode-uri').URI} */
let URI;
/** @type {typeof import('path')} */
let path;
/** @type {typeof import('vscode-languageserver/node').DiagnosticSeverity} */
let DiagnosticSeverity;

/** @typedef {import('vscode-languageserver').InitializeResult} InitializeResult */

try {
  ({
    createConnection,
    TextDocuments,
    ProposedFeatures,
    TextDocumentSyncKind,
    DiagnosticSeverity,
    CompletionItemKind,
  } = require('vscode-languageserver/node'));

  TextDocument = require('vscode-languageserver-textdocument').TextDocument;
  getCSSLanguageService = require('vscode-css-languageservice').getCSSLanguageService;
  URI = require('vscode-uri').URI;
  path = require('path');
} catch (e) {
  process.exit(1);
}

// ─── GTK Custom Data ────────────────────────────────────────────────────────

/** @type {import('vscode-css-languageservice').CSSDataV1} */
const gtkCustomData = {
  version: 1.1,
  atDirectives: [
    {
      name: '@define-color',
      description: 'GTK CSS: defines a color variable. Usage: @define-color name value;',
      references: [{ name: 'GTK CSS Overview', url: 'https://docs.gtk.org/gtk4/css-overview.html' }]
    }
  ],
  properties: [
    { name: '-gtk-icon-source', description: 'GTK icon source.' },
    { name: '-gtk-icon-size', description: 'GTK icon size.' },
    { name: '-gtk-icon-style', description: 'GTK icon style.' },
    { name: '-gtk-icon-transform', description: 'GTK icon transform.' },
    { name: '-gtk-icon-palette', description: 'GTK icon palette.' },
    { name: '-gtk-secondary-caret-color', description: 'GTK secondary caret color.' },
    { name: '-gtk-dpi', description: 'GTK DPI scaling.' }
  ],
  pseudoClasses: [
    { name: ':backdrop' },
    { name: ':dir(ltr)' },
    { name: ':dir(rtl)' }
  ],
  pseudoElements: [
    { name: '::selection' },
    { name: '::slider-runnable-track' },
    { name: '::slider-thumb' }
  ]
};

const cssService = getCSSLanguageService({
  customDataProviders: [
    {
      providePseudoClasses: () => gtkCustomData.pseudoClasses || [],
      providePseudoElements: () => gtkCustomData.pseudoElements || [],
      provideAtDirectives: () => gtkCustomData.atDirectives || [],
      provideProperties: () => gtkCustomData.properties || [],
    }
  ]
});

// ─── LSP Connection ─────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const DEBUG = process.env.GTK_CSS_LSP_DEBUG === 'true';
/** @param {string} msg */
function debugLog(msg) { if (DEBUG) connection.console.log(msg); }

// ─── Collecting colors from @define-color ────────────────────────────────────────

/**
 * Extracts all @define-color definitions from text.
 * @param {string} text
 * @returns {Map<string, string>} name → value
 */
function extractDefineColors(text) {
  const result = new Map();
  const regex = /@define-color\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s+([^;]+);/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    result.set(match[1], match[2].trim());
  }
  return result;
}

/**
 * Recursively resolves a GTK color (follows @anothername references).
 *
 * @param {string} name color name without @
 * @param {Map<string, string>} knownColors map of known colors
 * @param {Set<string>} visited cycle protection
 * @returns {string|null} the final color value (e.g. #hex) or null
 */
function resolveColor(name, knownColors, visited = new Set()) {
  if (visited.has(name)) return null;
  visited.add(name);

  let value = knownColors.get(name);
  if (!value) return null;

  // If the value is a reference to another @name color
  if (value.startsWith('@')) {
    return resolveColor(value.slice(1), knownColors, visited);
  }

  // alpha(), shade(), mix() etc. could be handled here.
  // For now, we return the value as is.
  return value;
}

/**
 * Generates an SVG Data URI for a small color square.
 * @param {string} color
 * @returns {string}
 */
function getColorPreviewUri(color) {
  // Remove spaces for safety in the SVG parameter
  const cleanColor = color.trim();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${cleanColor}" stroke="rgba(128,128,128,0.5)" stroke-width="1"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Extracts all @import statements from text and returns absolute paths.
 * @param {string} text
 * @param {string} documentFsPath  absolute path of the current file
 * @returns {string[]}
 */
function extractImports(text, documentFsPath) {
  const dir = path.dirname(documentFsPath);
  const result = [];
  // Supports: @import "file.css"; @import 'file.css'; @import url("file.css");
  const regex = /@import\s+(?:url\s*\(\s*)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const resolved = path.resolve(dir, match[1]);
    result.push(resolved);
  }
  return result;
}

/**
 * Recursively collects all @define-color colors from the current document
 * and all imported files (with cycle protection).
 *
 * @param {string} fsPath  - absolute path of the file to read
 * @param {Set<string>} visited
 * @returns {Map<string, string>}
 */
function collectAllColors(fsPath, visited = new Set()) {
  debugLog('Collecting colors from: ' + fsPath);
  if (visited.has(fsPath)) return new Map();
  visited.add(fsPath);

  let text;
  try {
    text = fs.readFileSync(fsPath, 'utf8');
  } catch (e) {
    connection.console.error('Failed to read: ' + fsPath + ' error: ' + (e instanceof Error ? e.message : String(e)));
    return new Map();
  }

  const colors = extractDefineColors(text);
  debugLog('Found colors in file: ' + Array.from(colors.keys()).join(', '));

  for (const importPath of extractImports(text, fsPath)) {
    debugLog('Following import: ' + importPath);
    const imported = collectAllColors(importPath, visited);
    for (const [name, value] of imported) {
      if (!colors.has(name)) colors.set(name, value);
    }
  }

  return colors;
}

/** @typedef {import('vscode-languageserver-textdocument').TextDocument} TextDocument */
/** @typedef {{ red: number, green: number, blue: number, alpha: number }} LspColor */

/**
 * Version that first uses the document open in memory (if available),
 * then falls back to fs for imported files.
 *
 * @param {TextDocument} document
 * @returns {Map<string, string>}
 */
function collectAllColorsFromDocument(document) {
  const fsPath = URI.parse(document.uri).fsPath;
  const visited = new Set();
  visited.add(fsPath);

  // Reads the current document from memory (always up to date)
  const colors = extractDefineColors(document.getText());

  // Follows @import from the file on disk
  for (const importPath of extractImports(document.getText(), fsPath)) {
    const imported = collectAllColors(importPath, visited);
    for (const [name, value] of imported) {
      if (!colors.has(name)) colors.set(name, value);
    }
  }

  return colors;
}

/**
 * Converts a CSS color string to LSP Color { red, green, blue, alpha } (0–1 range).
 * Supports #rgb, #rrggbb, #rrggbbaa, rgb(), rgba().
 * @param {string} css
 * @returns {{ red: number, green: number, blue: number, alpha: number } | null}
 */
function parseCssColorToLsp(css) {
  css = css.trim();

  // #rgb
  let m = css.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split('').map(c => parseInt(c + c, 16) / 255);
    return { red: r, green: g, blue: b, alpha: 1 };
  }
  // #rrggbb
  m = css.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255, alpha: 1 };
  }
  // #rrggbbaa
  m = css.match(/^#([0-9a-f]{8})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { red: ((n >> 24) & 255) / 255, green: ((n >> 16) & 255) / 255, blue: ((n >> 8) & 255) / 255, alpha: (n & 255) / 255 };
  }
  // rgb() / rgba()
  m = css.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (m) {
    return { red: +m[1] / 255, green: +m[2] / 255, blue: +m[3] / 255, alpha: m[4] !== undefined ? +m[4] : 1 };
  }

  return null; // colori named (es. "red") non supportati inline
}

// ─── Virtual Document for Validation ──────────────────────────────────────

/**
 * Creates a virtual text where every known @color_name reference is
 * replaced with a valid CSS placeholder of the SAME length.
 * This prevents the CSS parser from getting confused and producing
 * cascading errors (e.g. "at-rule or selector expected" inside @keyframes).
 *
 * Replacement strategy for @name (length L = name.length + 1):
 *   - If L <= 3: uses "red" truncated to L ("r", "re", "red")
 *   - If L > 3:  uses "red" + spaces up to L characters
 * Space padding is safe because CSS values ignore extra spaces.
 *
 * @param {string} text
 * @param {Map<string, string>} knownColors
 * @returns {string}
 */
function buildVirtualText(text, knownColors) {
  // Replaces only @name outside of @define-color, @import, and other known at-rules
  return text.replace(
    /@([a-zA-Z_][a-zA-Z0-9_-]*)/g,
    (match, name) => {
      // Do not touch standard CSS/GTK at-rules
      const CSS_AT_RULES = new Set([
        'import', 'media', 'keyframes', 'charset', 'font-face', 'supports',
        'namespace', 'page', 'layer', 'container', 'document', 'viewport',
        'counter-style', 'define-color', 'apply', 'custom-media',
        'color-profile', 'property', 'starting-style'
      ]);
      if (CSS_AT_RULES.has(name)) return match;

      if (knownColors.has(name)) {
        const L = match.length; // original length including @
        const placeholder = 'red';
        if (L <= placeholder.length) {
          return placeholder.slice(0, L);
        }
        return placeholder + ' '.repeat(L - placeholder.length);
      }
      return match; // unknown color: leave unchanged (will be a real error)
    }
  );
}

/**
 * Parses a GTK color value into an LSP Color, handling GTK functions.
 * @param {string} name
 * @param {Map<string, string>} knownColors
 * @param {Set<string>} [visited]
 * @returns {LspColor | null}
 */
function resolveColorToLsp(name, knownColors, visited = new Set()) {
  if (visited.has(name)) return null;
  visited.add(name);

  const value = knownColors.get(name);
  if (!value) return null;

  return parseCssColorValueToLsp(value, knownColors, visited);
}

/**
 * Recursively evaluates a GTK CSS color expression.
 * @param {string} value  raw value, e.g. "#ff0000", "@base", "alpha(@base, 0.5)", etc.
 * @param {Map<string, string>} knownColors
 * @param {Set<string>} visited
 * @returns {LspColor | null}
 */
function parseCssColorValueToLsp(value, knownColors, visited = new Set()) {
  value = value.trim();

  if (value.startsWith('@')) {
    return resolveColorToLsp(value.slice(1), knownColors, new Set(visited));
  }

  const call = parseFnCall(value);
  if (call) {
    const args = splitArgs(call.argsStr);

    if (call.fn === 'alpha' && args.length === 2) {
      const base = parseCssColorValueToLsp(args[0], knownColors, new Set(visited));
      if (!base) return null;
      return { ...base, alpha: clamp(parseFloat(args[1]), 0, 1) };
    }
    if (call.fn === 'shade' && args.length === 2) {
      const base = parseCssColorValueToLsp(args[0], knownColors, new Set(visited));
      if (!base) return null;
      const f = parseFloat(args[1]);
      return { red: clamp(base.red * f, 0, 1), green: clamp(base.green * f, 0, 1), blue: clamp(base.blue * f, 0, 1), alpha: base.alpha };
    }
    if (call.fn === 'mix' && args.length === 3) {
      const c1 = parseCssColorValueToLsp(args[0], knownColors, new Set(visited));
      const c2 = parseCssColorValueToLsp(args[1], knownColors, new Set(visited));
      if (!c1 || !c2) return null;
      const f = clamp(parseFloat(args[2]), 0, 1);
      return {
        red:   c1.red   * f + c2.red   * (1 - f),
        green: c1.green * f + c2.green * (1 - f),
        blue:  c1.blue  * f + c2.blue  * (1 - f),
        alpha: c1.alpha * f + c2.alpha * (1 - f),
      };
    }
    if (call.fn === 'lighter' && args.length === 1) {
      const base = parseCssColorValueToLsp(args[0], knownColors, new Set(visited));
      if (!base) return null;
      return { red: clamp(base.red * 1.3, 0, 1), green: clamp(base.green * 1.3, 0, 1), blue: clamp(base.blue * 1.3, 0, 1), alpha: base.alpha };
    }
    if (call.fn === 'darker' && args.length === 1) {
      const base = parseCssColorValueToLsp(args[0], knownColors, new Set(visited));
      if (!base) return null;
      return { red: clamp(base.red * 0.7, 0, 1), green: clamp(base.green * 0.7, 0, 1), blue: clamp(base.blue * 0.7, 0, 1), alpha: base.alpha };
    }
  }

  return parseCssColorToLsp(value);
}

/**
 * Splits "arg1, arg2, arg3" honoring nested brackets.
 * @param {string} str
 * @returns {string[]}
 */
function splitArgs(str) {
  const args = [];
  let depth = 0, current = '';
  for (const ch of str) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * Extracts the function's name and the list of arguments.
 * @param {string} value
 * @returns {{ fn: string, argsStr: string } | null}
 */
function parseFnCall(value) {
  const m = value.match(/^([\w-]+)\s*\((.+)\)$/s);
  return m ? { fn: m[1], argsStr: m[2] } : null;
}

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/**
 * @param {LspColor} c
 * @returns {string}
 */
function lspColorToHex(c) {
  const h = (/** @type {number} */ v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return c.alpha < 1
    ? `rgba(${Math.round(c.red*255)}, ${Math.round(c.green*255)}, ${Math.round(c.blue*255)}, ${c.alpha.toFixed(2)})`
    : `#${h(c.red)}${h(c.green)}${h(c.blue)}`;
}

/**
 * Residual error codes that might still be GTK false positives
 * (e.g. @define-color on older versions of the CSS language service).
 */
const GTK_SUPPRESSIBLE_CODES = new Set(['css-unknownatrule']);

/**
 * Filters any residual diagnostics for @define-color.
 *
 * @param {import('vscode-languageserver').Diagnostic[]} diagnostics
 * @returns {import('vscode-languageserver').Diagnostic[]}
 */
function filterResidueDiagnostics(diagnostics) {
  return diagnostics.filter(diag => {
    const code = typeof diag.code === 'string' ? diag.code : String(diag.code ?? '');
    return !GTK_SUPPRESSIBLE_CODES.has(code);
  });
}

// ─── LSP Initialization ────────────────────────────────────────────────────

connection.onInitialize(() => {
  /** @type {InitializeResult} */
  const result = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['@', ':', '-', '#']
      },
      hoverProvider: true,
      colorProvider: true
    }
  };
  return result;
});

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * @param {TextDocument} document
 */
function validateDocument(document) {
  const knownColors = collectAllColorsFromDocument(document);

  // Creates a virtual document with @color_name replaced by valid placeholders.
  // This prevents the CSS parser from producing cascading errors (e.g. inside
  // @keyframes when it encounters background-color: @red).
  const virtualText = buildVirtualText(document.getText(), knownColors);
  const virtualDoc = TextDocument.create(
    document.uri,
    document.languageId,
    document.version,
    virtualText
  );

  const stylesheet = cssService.parseStylesheet(virtualDoc);
  const rawDiagnostics = cssService.doValidation(virtualDoc, stylesheet, {
    validate: true,
    lint: {}
  });

  // Convert from CSS diagnostics to LSP diagnostics.
  // Positions are identical to the original because buildVirtualText
  // preserves the length of each replaced token.
  /** @type {import('vscode-languageserver').Diagnostic[]} */
  const lspDiagnostics = rawDiagnostics.map(d => ({
    severity: d.severity === 1 ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    range: d.range,
    message: d.message,
    code: d.code,
    source: 'gtk-css'
  }));

  const filtered = filterResidueDiagnostics(lspDiagnostics);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: filtered });
}

documents.onDidChangeContent(change => {
  validateDocument(change.document);
});

documents.onDidOpen(event => {
  validateDocument(event.document);
});

// ─── Completions ──────────────────────────────────────────────────────────────

connection.onCompletion(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  debugLog('Completion requested at: ' + params.position.line + ',' + params.position.character);

  const stylesheet = cssService.parseStylesheet(document);
  const cssCompletions = cssService.doComplete(document, params.position, stylesheet);

  const knownColors = collectAllColorsFromDocument(document);
  debugLog('Known colors for completion: ' + Array.from(knownColors.keys()).join(', '));

  const lineText = document.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position
  });
  debugLog('Line text for completion: "' + lineText + '"');

  const gtkItems = [];
  const triggerMatch = lineText.match(/@([a-zA-Z0-9_-]*)$/);
  if (triggerMatch || lineText.trimEnd().endsWith('@')) {
    const typed = triggerMatch ? triggerMatch[0] : '@'; // es. "@cy"
    const replaceStart = params.position.character - typed.length;

    for (const [name, value] of knownColors) {
      gtkItems.push({
        label: `@${name}`,
        kind: CompletionItemKind.Color,
        detail: `GTK color: ${value}`,
        documentation: `@define-color ${name} ${value};`,
        filterText: `@${name}`,
        textEdit: {
          range: {
            start: { line: params.position.line, character: replaceStart },
            end:   { line: params.position.line, character: params.position.character }
          },
          newText: `@${name}`
        }
      });
    }
  }

  debugLog('Returning ' + (cssCompletions?.items.length || 0) + ' CSS items and ' + gtkItems.length + ' GTK items');
  return {
    isIncomplete: cssCompletions?.isIncomplete ?? false,
    items: [...(cssCompletions?.items ?? []), ...gtkItems]
  };
});

// ─── Hover ────────────────────────────────────────────────────────────────────

connection.onHover(params => {
  debugLog('Hover requested at: ' + params.position.line + ',' + params.position.character);
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    debugLog('Document not found for hover');
    return null;
  }

  const lineText = document.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line, character: 10000 }
  });

  debugLog('Line text: ' + lineText);

  const atPattern = /@([a-zA-Z_][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = atPattern.exec(lineText)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    debugLog('Match found: ' + match[0] + ' at ' + start + '-' + end);

    if (params.position.character >= start && params.position.character <= end) {
      const colorName = match[1];
      debugLog('Checking color: ' + colorName);
      const knownColors = collectAllColorsFromDocument(document);
      debugLog('Known colors: ' + Array.from(knownColors.keys()).join(', '));

      if (knownColors.has(colorName)) {
        const rawValue = knownColors.get(colorName) ?? '';
        const lspColor = resolveColorToLsp(colorName, knownColors);

        let markdown = `**GTK Color Variable**: \`${colorName}\`\n\n`;

        if (lspColor) {
          const hex = lspColorToHex(lspColor);
          markdown += `![](${getColorPreviewUri(hex)}) \`${hex}\`\n\n`;
          if (rawValue && rawValue !== hex) {
            markdown += `Defined as: \`${rawValue}\``;
          }
        }

        return {
          contents: { kind: 'markdown', value: markdown },
          range: {
            start: { line: params.position.line, character: start },
            end:   { line: params.position.line, character: end }
          }
        };
      }
      break;
    }
  }

  debugLog('No GTK color found, falling back to CSS hover');
  const stylesheet = cssService.parseStylesheet(document);
  return cssService.doHover(document, params.position, stylesheet);
});

connection.onDocumentColor(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const knownColors = collectAllColorsFromDocument(document);
  const text = document.getText();
  const results = [];

  const pattern = /@([a-zA-Z_][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    if (!knownColors.has(name)) continue;

    const color = resolveColorToLsp(name, knownColors);
    if (!color) continue;

    const start = document.positionAt(match.index);
    const end   = document.positionAt(match.index + match[0].length);
    results.push({ color, range: { start, end } });
  }

  return results;
});

connection.onColorPresentation(params => {
  // Restituisce come scrivere il colore scelto (quando l'utente usa il color picker)
  const { red: r, green: g, blue: b, alpha: a } = params.color;
  const toHex = (/** @type {number} */ v) => Math.round(v * 255).toString(16).padStart(2, '0');
  const hex = a < 1
    ? `rgba(${Math.round(r*255)}, ${Math.round(g*255)}, ${Math.round(b*255)}, ${a.toFixed(2)})`
    : `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return [{ label: hex }];
});

// ─── Start ────────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
