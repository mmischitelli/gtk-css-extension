// @ts-check
'use strict';

const fs = require('fs');
const SERVER_LOG = '/home/mmischitelli/data/repos/gtk-css-extension/server_debug.log';
try {
  fs.writeFileSync(SERVER_LOG, 'Server Start: ' + new Date().toISOString() + '\n');
} catch (e) {}
function log(msg) { try { fs.appendFileSync(SERVER_LOG, msg + '\n'); } catch (e) {} }

log('Server module entry point reached');

let createConnection, TextDocuments, ProposedFeatures, InitializeResult, TextDocumentSyncKind, DiagnosticSeverity, CompletionItemKind;
let TextDocument, getCSSLanguageService, URI, path;

try {
  log('Loading vscode-languageserver/node...');
  ({
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeResult,
    TextDocumentSyncKind,
    DiagnosticSeverity,
    CompletionItemKind,
  } = require('vscode-languageserver/node'));
  
  log('Loading other modules...');
  TextDocument = require('vscode-languageserver-textdocument').TextDocument;
  getCSSLanguageService = require('vscode-css-languageservice').getCSSLanguageService;
  URI = require('vscode-uri').URI;
  path = require('path');
  log('Modules loaded successfully');
} catch (e) {
  log('FATAL ERROR DURING MODULE LOADING: ' + e.stack);
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
      getId: () => 'gtk-css',
      isApplicable: () => true,
      providePseudoClasses: () => gtkCustomData.pseudoClasses || [],
      providePseudoElements: () => gtkCustomData.pseudoElements || [],
      provideAtDirectives: () => gtkCustomData.atDirectives || [],
      provideProperties: () => gtkCustomData.properties || [],
      provideValues: () => []
    }
  ]
});

// ─── LSP Connection ─────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

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
  log('Collecting colors from: ' + fsPath);
  if (visited.has(fsPath)) return new Map();
  visited.add(fsPath);

  let text;
  try {
    text = fs.readFileSync(fsPath, 'utf8');
  } catch (e) {
    log('Failed to read: ' + fsPath + ' error: ' + e.message);
    return new Map();
  }

  const colors = extractDefineColors(text);
  log('Found colors in file: ' + Array.from(colors.keys()).join(', '));

  for (const importPath of extractImports(text, fsPath)) {
    log('Following import: ' + importPath);
    const imported = collectAllColors(importPath, visited);
    for (const [name, value] of imported) {
      if (!colors.has(name)) colors.set(name, value);
    }
  }

  return colors;
}

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
      hoverProvider: true
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

  log('Completion requested at: ' + params.position.line + ',' + params.position.character);

  const stylesheet = cssService.parseStylesheet(document);
  const cssCompletions = cssService.doComplete(document, params.position, stylesheet);

  const knownColors = collectAllColorsFromDocument(document);
  log('Known colors for completion: ' + Array.from(knownColors.keys()).join(', '));

  const lineText = document.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position
  });
  log('Line text for completion: "' + lineText + '"');

  const gtkItems = [];
  const triggerMatch = lineText.match(/@([a-zA-Z0-9_-]*)$/);
  if (triggerMatch || lineText.trimEnd().endsWith('@')) {
    log('GTK Trigger detected');
    for (const [name, value] of knownColors) {
      gtkItems.push({
        label: `@${name}`,
        kind: CompletionItemKind.Color,
        detail: `GTK color: ${value}`,
        documentation: `@define-color ${name} ${value};`,
        insertText: `@${name}`,
        filterText: `@${name}`
      });
    }
  }

  log('Returning ' + (cssCompletions?.items.length || 0) + ' CSS items and ' + gtkItems.length + ' GTK items');
  return {
    isIncomplete: cssCompletions?.isIncomplete ?? false,
    items: [...(cssCompletions?.items ?? []), ...gtkItems]
  };
});

// ─── Hover ────────────────────────────────────────────────────────────────────

connection.onHover(params => {
  log('Hover requested at: ' + params.position.line + ',' + params.position.character);
  const document = documents.get(params.textDocument.uri);
  if (!document) {
      log('Document not found for hover');
      return null;
  }

  // Checks if we are over a GTK @color_name
  const lineText = document.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line, character: 10000 }
  });

  log('Line text: ' + lineText);

  const atPattern = /@([a-zA-Z_][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = atPattern.exec(lineText)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    log('Match found: ' + match[0] + ' at ' + start + '-' + end);
    if (params.position.character >= start && params.position.character <= end) {
      const colorName = match[1];
      log('Checking color: ' + colorName);
      const knownColors = collectAllColorsFromDocument(document);
      log('Known colors: ' + Array.from(knownColors.keys()).join(', '));
      if (knownColors.has(colorName)) {
        const rawValue = knownColors.get(colorName);
        const resolvedValue = resolveColor(colorName, knownColors);

        let markdown = `**GTK Color Variable**: \`${colorName}\`\n\n`;

        if (resolvedValue) {
          const previewUri = getColorPreviewUri(resolvedValue);
          markdown += `![](${previewUri}) \`${resolvedValue}\`\n\n`;
        }

        if (resolvedValue !== rawValue) {
          markdown += `Defined as: \`${rawValue}\``;
        }

        return {
          contents: {
            kind: 'markdown',
            value: markdown
          },
          range: {
            start: { line: params.position.line, character: start },
            end: { line: params.position.line, character: end }
          }
        };
      }
      break;
    }
  }

  // Fallback: hover CSS standard
  log('No GTK color found, falling back to CSS hover');
  const stylesheet = cssService.parseStylesheet(document);
  return cssService.doHover(document, params.position, stylesheet);
});

// ─── Start ────────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
