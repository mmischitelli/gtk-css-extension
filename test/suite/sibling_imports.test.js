const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const LOG_FILE = path.join(__dirname, '../../test_debug.log');

function log(msg) {
	fs.appendFileSync(LOG_FILE, msg + '\n');
}

/**
 * Regression fixtures for sibling-imported color definitions.
 *
 * At GTK runtime the whole @import tree loaded from a root stylesheet is a
 * single scope, so @define-color in styles/colors.gtk.css is visible from
 * styles/powerline_arrows.gtk.css even though only the root imports it.
 *
 * Fix (extension-owned color check): the server replaces EVERY @color
 * reference with a placeholder before handing the text to the generic CSS
 * parser, so sibling-imported references no longer trigger parser errors or
 * cascades. References the server cannot resolve from the file's own
 * import tree receive warnings — not proof that the color is undefined
 * at GTK runtime, where a root can supply additional definitions.
 * The guard fixture proves that real undefined colors keep being reported.
 */
suite('Sibling import color scope', () => {
	const workspacePath = path.resolve(__dirname, '../test-workspace');
	const rootUri  = vscode.Uri.file(path.join(workspacePath, 'sibling-imports', 'style.gtk.css'));
	const leafUri  = vscode.Uri.file(path.join(workspacePath, 'sibling-imports', 'styles', 'powerline_arrows.gtk.css'));
	const guardUri = vscode.Uri.file(path.join(workspacePath, 'sibling-imports', 'styles', 'undefined-color.gtk.css'));

	/**
	 * @param {vscode.Diagnostic[]} diagnostics
	 * @returns {string}
	 */
	function fmt(diagnostics) {
		return diagnostics.map(d => `${d.message} [${d.code}]`).join(', ');
	}

	/**
	 * Opens every fixture so the server validates each one on didOpen, then
	 * waits with the same 3s allowance used by the diagnostics test in
	 * extension.test.js.
	 */
	async function openFixturesAndSettle() {
		const ext = vscode.extensions.getExtension('mpmischitelli.gtk-css');
		assert.ok(ext, 'Extension not found');
		await ext.activate();
		await vscode.workspace.openTextDocument(rootUri);
		await vscode.workspace.openTextDocument(leafUri);
		await vscode.workspace.openTextDocument(guardUri);
		await new Promise(resolve => setTimeout(resolve, 3000));
	}

	/**
	 * @param {vscode.Diagnostic[]} diagnostics
	 * @returns {vscode.Diagnostic[]}
	 */
	function onlyErrors(diagnostics) {
		return diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
	}

	test('Guard fixture with a genuinely undefined color is reported', async () => {
		log('Sibling import test: guard fixture');
		await openFixturesAndSettle();
		const diagnostics = vscode.languages.getDiagnostics(guardUri);
		log('Guard diagnostics: ' + fmt(diagnostics));
		assert.strictEqual(diagnostics.length, 1, fmt(diagnostics));
		const diagnostic = diagnostics[0];
		assert.strictEqual(diagnostic.code, 'gtk-undefinedcolor');
		assert.strictEqual(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
		const document = await vscode.workspace.openTextDocument(guardUri);
		assert.strictEqual(document.getText(diagnostic.range), '@definitely_undefined_color');
	});

	test('Root stylesheet resolves colors imported from styles/colors.gtk.css', async () => {
		log('Sibling import test: root stylesheet');
		await openFixturesAndSettle();
		const errors = onlyErrors(vscode.languages.getDiagnostics(rootUri));
		log('Root errors: ' + fmt(errors));
		assert.strictEqual(errors.length, 0, `Errors found on root stylesheet: ${fmt(errors)}`);
	});

	test('Leaf stylesheet can reference colors imported by the root stylesheet', async () => {
		log('Sibling import test: leaf stylesheet');
		await openFixturesAndSettle();
		const diagnostics = vscode.languages.getDiagnostics(leafUri);
		const errors = onlyErrors(diagnostics);
		const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);
		log('Leaf diagnostics: ' + fmt(diagnostics));
		assert.strictEqual(errors.length, 0,
			`Sibling import colors produced parser errors on the leaf. Errors: ${fmt(errors)}`);
		// Each unresolved token receives one warning at its original range.
		assert.strictEqual(warnings.length, 2, fmt(warnings));
		const document = await vscode.workspace.openTextDocument(leafUri);
		assert.deepStrictEqual(warnings.map(d => document.getText(d.range)).sort(), [
			'@no0', '@no1'
		]);
		assert.ok(warnings.every(d => d.code === 'gtk-undefinedcolor'),
			`Expected code gtk-undefinedcolor on every leaf warning, got: ${warnings.map(d => d.code).join(', ')}`);
	});
});
