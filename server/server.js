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
      description: 'GTK CSS: definisce una variabile colore. Uso: @define-color nome valore;',
      references: [{ name: 'GTK CSS Overview', url: 'https://docs.gtk.org/gtk4/css-overview.html' }]
    }
  ],
  properties: [
    { name: '-gtk-icon-source', description: 'Sorgente icona GTK.' },
    { name: '-gtk-icon-size', description: 'Dimensione icona GTK.' },
    { name: '-gtk-icon-style', description: 'Stile icona GTK.' },
    { name: '-gtk-icon-transform', description: 'Trasformazione icona GTK.' },
    { name: '-gtk-icon-palette', description: 'Palette icona GTK.' },
    { name: '-gtk-secondary-caret-color', description: 'Colore caret secondario GTK.' },
    { name: '-gtk-dpi', description: 'Scaling DPI GTK.' }
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

// ─── Connessione LSP ─────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ─── Raccolta colori da @define-color ────────────────────────────────────────

/**
 * Estrae tutte le definizioni @define-color da un testo.
 * @param {string} text
 * @returns {Map<string, string>} nome → valore
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
 * Risolve ricorsivamente un colore GTK (segue i riferimenti @altronome).
 *
 * @param {string} name nome del colore senza @
 * @param {Map<string, string>} knownColors mappa dei colori noti
 * @param {Set<string>} visited protezione cicli
 * @returns {string|null} il valore finale del colore (es. #hex) o null
 */
function resolveColor(name, knownColors, visited = new Set()) {
  if (visited.has(name)) return null;
  visited.add(name);

  let value = knownColors.get(name);
  if (!value) return null;

  // Se il valore è un riferimento a un altro colore @name
  if (value.startsWith('@')) {
    return resolveColor(value.slice(1), knownColors, visited);
  }

  // Qui si potrebbero gestire alpha(), shade(), mix() ecc.
  // Per ora restituiamo il valore così com'è.
  return value;
}

/**
 * Genera un Data URI SVG per un quadratino di colore.
 * @param {string} color
 * @returns {string}
 */
function getColorPreviewUri(color) {
  // Rimuovi spazi per sicurezza nel parametro SVG
  const cleanColor = color.trim();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${cleanColor}" stroke="rgba(128,128,128,0.5)" stroke-width="1"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Estrae tutti gli @import da un testo e restituisce i percorsi assoluti.
 * @param {string} text
 * @param {string} documentFsPath  percorso assoluto del file corrente
 * @returns {string[]}
 */
function extractImports(text, documentFsPath) {
  const dir = path.dirname(documentFsPath);
  const result = [];
  // Supporta: @import "file.css"; @import 'file.css'; @import url("file.css");
  const regex = /@import\s+(?:url\s*\(\s*)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const resolved = path.resolve(dir, match[1]);
    result.push(resolved);
  }
  return result;
}

/**
 * Raccoglie ricorsivamente tutti i colori @define-color dal documento
 * corrente e da tutti i file importati (con protezione dai cicli).
 *
 * @param {string} fsPath  - percorso assoluto del file da leggere
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
 * Versione che usa prima il documento aperto in memoria (se disponibile),
 * poi ricade su fs per i file importati.
 *
 * @param {TextDocument} document
 * @returns {Map<string, string>}
 */
function collectAllColorsFromDocument(document) {
  const fsPath = URI.parse(document.uri).fsPath;
  const visited = new Set();
  visited.add(fsPath);

  // Legge il documento corrente dalla memoria (sempre aggiornato)
  const colors = extractDefineColors(document.getText());

  // Segue gli @import dal file su disco
  for (const importPath of extractImports(document.getText(), fsPath)) {
    const imported = collectAllColors(importPath, visited);
    for (const [name, value] of imported) {
      if (!colors.has(name)) colors.set(name, value);
    }
  }

  return colors;
}

// ─── Documento virtuale per validazione ──────────────────────────────────────

/**
 * Crea un testo virtuale dove ogni riferimento @color_name noto viene
 * sostituito con un placeholder CSS valido della STESSA lunghezza.
 * Questo evita che il parser CSS si confonda e produca errori a cascata
 * (es. "at-rule or selector expected" dentro @keyframes).
 *
 * Strategia di sostituzione per @name (lunghezza L = name.length + 1):
 *   - Se L <= 3: usa "red" troncato a L ("r", "re", "red")
 *   - Se L > 3:  usa "red" + spazi fino a L caratteri
 * Il padding con spazi è sicuro perché i valori CSS ignorano gli spazi extra.
 *
 * @param {string} text
 * @param {Map<string, string>} knownColors
 * @returns {string}
 */
function buildVirtualText(text, knownColors) {
  // Sostituisce solo @name fuori da @define-color e @import e altri at-rule noti
  return text.replace(
    /@([a-zA-Z_][a-zA-Z0-9_-]*)/g,
    (match, name) => {
      // Non toccare at-rule CSS/GTK standard
      const CSS_AT_RULES = new Set([
        'import', 'media', 'keyframes', 'charset', 'font-face', 'supports',
        'namespace', 'page', 'layer', 'container', 'document', 'viewport',
        'counter-style', 'define-color', 'apply', 'custom-media',
        'color-profile', 'property', 'starting-style'
      ]);
      if (CSS_AT_RULES.has(name)) return match;

      if (knownColors.has(name)) {
        const L = match.length; // lunghezza originale incluso @
        const placeholder = 'red';
        if (L <= placeholder.length) {
          return placeholder.slice(0, L);
        }
        return placeholder + ' '.repeat(L - placeholder.length);
      }
      return match; // colore non noto: lascia invariato (sarà un vero errore)
    }
  );
}

/**
 * Codici di errore residui che possono ancora essere falsi positivi GTK
 * (es. @define-color su versioni meno recenti del CSS language service).
 */
const GTK_SUPPRESSIBLE_CODES = new Set(['css-unknownatrule']);

/**
 * Filtra gli eventuali diagnostics residui per @define-color.
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

// ─── Initializzazione LSP ────────────────────────────────────────────────────

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

// ─── Validazione ─────────────────────────────────────────────────────────────

/**
 * @param {TextDocument} document
 */
function validateDocument(document) {
  const knownColors = collectAllColorsFromDocument(document);

  // Crea un documento virtuale con @color_name sostituiti da placeholder validi.
  // Questo impedisce al parser CSS di produrre errori a cascata (es. dentro
  // @keyframes quando incontra background-color: @red).
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

  // Converti da diagnostics CSS a diagnostics LSP.
  // Le posizioni sono identiche all'originale perché buildVirtualText
  // preserva la lunghezza di ogni token sostituito.
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

  // Controlla se siamo sopra un @color_name GTK
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

// ─── Avvio ────────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
