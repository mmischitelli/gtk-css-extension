// @ts-check
'use strict';

/**
 * Unit tests for lib/css-utils.js.
 *
 * Expected test-workspace layout:
 *   test/test-workspace/
 *   ├── main.gtk.css            imports vars.gtk.css, defines local_color
 *   ├── vars.gtk.css            defines base_color, accent_color
 *   ├── with-css-root.gtk.css   has @css-root directive pointing to ./deploy
 *   ├── circular-a.gtk.css      imports circular-b (cycle detection)
 *   ├── circular-b.gtk.css      imports circular-a (cycle detection)
 *   ├── deploy/
 *   │   └── remote.gtk.css      defines remote_color
 *   └── sibling-imports/        fixtures used by sibling_imports.test.js
 *       ├── style.gtk.css       root: imports styles/colors + styles/powerline_arrows
 *       └── styles/
 *           ├── colors.gtk.css           defines no0, no1, re0
 *           ├── powerline_arrows.gtk.css references @no1/@no0 with no own @import
 *           └── undefined-color.gtk.css  references @definitely_undefined_color
 *
 * This file lives at: <project_root>/test/suite/css_root.test.js
 */

const assert = require('assert');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const { resolveImportBase, extractImports } = require('../../server/lib/css-utils');

// ─── Paths ───────────────────────────────────────────────────────────────────

const WORKSPACE      = path.resolve(__dirname, '../test-workspace');
const MAIN_CSS       = path.join(WORKSPACE, 'main.gtk.css');
const VARS_CSS       = path.join(WORKSPACE, 'vars.gtk.css');
const WITH_ROOT_CSS  = path.join(WORKSPACE, 'with-css-root.gtk.css');
const CIRCULAR_A     = path.join(WORKSPACE, 'circular-a.gtk.css');
const CIRCULAR_B     = path.join(WORKSPACE, 'circular-b.gtk.css');
const REMOTE_CSS     = path.join(WORKSPACE, 'deploy', 'remote.gtk.css');
const DEPLOY_ABS     = '/final/destination/styles';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Reads a file from the test-workspace.
 * @param {string} filePath
 * @returns {string}
 */
function readWorkspaceFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// ─── resolveImportBase ───────────────────────────────────────────────────────

suite('resolveImportBase()', () => {

  test('returns dirname of document when no directive is present', () => {
    const css = readWorkspaceFile(VARS_CSS); // no directive
    assert.strictEqual(resolveImportBase(css, VARS_CSS), WORKSPACE);
  });

  test('returns dirname of main.gtk.css when no directive is present', () => {
    const css = '.button { color: red; }';
    assert.strictEqual(resolveImportBase(css, MAIN_CSS), WORKSPACE);
  });

  test('uses absolute path from directive', () => {
    const css = `/* @css-root: ${DEPLOY_ABS} */\n.button {}`;
    assert.strictEqual(resolveImportBase(css, MAIN_CSS), DEPLOY_ABS);
  });

  test('uses relative path from directive, resolved against document dir', () => {
    const css = readWorkspaceFile(WITH_ROOT_CSS); // contains /* @css-root: ./deploy */
    const expected = path.resolve(WORKSPACE, 'deploy');
    assert.strictEqual(resolveImportBase(css, WITH_ROOT_CSS), expected);
  });

  test('expands leading ~ to home directory', () => {
    const css = '/* @css-root: ~/.config/gtk-4.0 */';
    const expected = path.join(os.homedir(), '.config/gtk-4.0');
    assert.strictEqual(resolveImportBase(css, MAIN_CSS), expected);
  });

  test('handles extra whitespace inside the comment', () => {
    const css = `/*   @css-root:   ${DEPLOY_ABS}   */`;
    assert.strictEqual(resolveImportBase(css, MAIN_CSS), DEPLOY_ABS);
  });

  test('ignores a malformed directive (missing closing */)', () => {
    const css = `/* @css-root: ${DEPLOY_ABS}`;
    assert.strictEqual(resolveImportBase(css, MAIN_CSS), WORKSPACE);
  });

  test('directive in the middle of the file is still detected', () => {
    const css = `.foo { color: red; }\n/* @css-root: ${DEPLOY_ABS} */\n.bar {}`;
    assert.strictEqual(resolveImportBase(css, MAIN_CSS), DEPLOY_ABS);
  });

});

// ─── extractImports ──────────────────────────────────────────────────────────

suite('extractImports()', () => {

  test('returns empty array when there are no @import statements', () => {
    const css = readWorkspaceFile(VARS_CSS); // no @import
    assert.deepStrictEqual(extractImports(css, VARS_CSS), []);
  });

  test('resolves double-quoted @import relative to document dir', () => {
    const css = '@import "vars.gtk.css";';
    assert.deepStrictEqual(extractImports(css, MAIN_CSS), [VARS_CSS]);
  });

  test('resolves single-quoted @import relative to document dir', () => {
    const css = "@import 'vars.gtk.css';";
    assert.deepStrictEqual(extractImports(css, MAIN_CSS), [VARS_CSS]);
  });

  test('resolves url() @import relative to document dir', () => {
    const css = '@import url("vars.gtk.css");';
    assert.deepStrictEqual(extractImports(css, MAIN_CSS), [VARS_CSS]);
  });

  test('resolves @import from real main.gtk.css content', () => {
    const css = readWorkspaceFile(MAIN_CSS);
    assert.ok(extractImports(css, MAIN_CSS).includes(VARS_CSS),
      'Expected VARS_CSS to be in imports of main.gtk.css');
  });

  test('resolves @import relative to @css-root deploy dir', () => {
    const css = readWorkspaceFile(WITH_ROOT_CSS); // @css-root: ./deploy + @import "remote.gtk.css"
    assert.deepStrictEqual(extractImports(css, WITH_ROOT_CSS), [REMOTE_CSS]);
  });

  test('resolves @import relative to absolute @css-root', () => {
    const css = [
      `/* @css-root: ${DEPLOY_ABS} */`,
      '@import "base.css";',
      '@import url("components/button.css");'
    ].join('\n');
    assert.deepStrictEqual(extractImports(css, MAIN_CSS), [
      path.join(DEPLOY_ABS, 'base.css'),
      path.join(DEPLOY_ABS, 'components/button.css')
    ]);
  });

  test('resolves @import using ~ expansion from @css-root', () => {
    const css = [
      '/* @css-root: ~/.config/gtk-4.0 */',
      '@import "gtk.css";'
    ].join('\n');
    const expected = [path.join(os.homedir(), '.config/gtk-4.0/gtk.css')];
    assert.deepStrictEqual(extractImports(css, MAIN_CSS), expected);
  });

  test('circular imports do not appear twice in a single extractImports call', () => {
    // extractImports only reads the current file — cycle protection is in collectAllColors.
    // Here we verify that circular-a correctly lists circular-b as its sole import.
    const css = readWorkspaceFile(CIRCULAR_A);
    assert.deepStrictEqual(extractImports(css, CIRCULAR_A), [CIRCULAR_B]);
  });

  test('circular-b lists circular-a as its sole import', () => {
    const css = readWorkspaceFile(CIRCULAR_B);
    assert.deepStrictEqual(extractImports(css, CIRCULAR_B), [CIRCULAR_A]);
  });

});