const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const LOG_FILE = path.join(__dirname, '../../test_debug.log');
fs.writeFileSync(LOG_FILE, 'Test Run Start: ' + new Date().toISOString() + '\n');

function log(msg) {
	fs.appendFileSync(LOG_FILE, msg + '\n');
}

suite('GTK CSS Extension Integration Tests', () => {
	const workspacePath = path.resolve(__dirname, '../test-workspace');
	const mainFileUri = vscode.Uri.file(path.join(workspacePath, 'main.gtk.css'));

	test('Extension should be present and active', async () => {
		log('Test 1: Extension present and active');
		const ext = vscode.extensions.getExtension('mpmischitelli.gtk-css');
		assert.ok(ext, 'Extension not found');
		log('Activating extension...');
		await ext.activate();
		log('Extension isActive: ' + ext.isActive);
		assert.strictEqual(ext.isActive, true, 'Extension failed to activate');
	});

	test('Language association for .gtk.css files', async () => {
		log('Test 2: Language association');
		const doc = await vscode.workspace.openTextDocument(mainFileUri);
		log('Document languageId: ' + doc.languageId);
		assert.strictEqual(doc.languageId, 'gtk-css', 'File .gtk.css not recognized as gtk-css');
	});

	test('IntelliSense completions for @define-color', async () => {
		log('Test 3: IntelliSense completions');
		const doc = await vscode.workspace.openTextDocument(mainFileUri);
		
		// Wait a bit for server to process
		await new Promise(resolve => setTimeout(resolve, 1000));

		const position = new vscode.Position(6, 12);
		log('Executing completion provider at: ' + position.line + ',' + position.character);
		const list = await vscode.commands.executeCommand(
			'vscode.executeCompletionItemProvider',
			mainFileUri,
			position
		);

		log('Completions found: ' + (list ? list.items.length : 'NULL'));
		if (list) {
			const labels = list.items.map(i => {
				const label = typeof i.label === 'string' ? i.label : i.label.label;
				return label;
			});
			log('Labels: ' + labels.join(', '));
			assert.ok(labels.includes('@local_color'), 'Local_color missing. Found: ' + labels.join(', '));
			assert.ok(labels.includes('@base_color'), 'Base_color missing. Found: ' + labels.join(', '));
		} else {
			assert.fail('No completion list returned');
		}
	});

	test('Hover information for GTK colors', async () => {
		log('Test 4: Hover information');
		const doc = await vscode.workspace.openTextDocument(mainFileUri);
		
		// Wait a bit for server
		await new Promise(resolve => setTimeout(resolve, 1000));

		const position = new vscode.Position(5, 25);
		
		log('Executing hover provider at: ' + position.line + ',' + position.character);
		const hovers = await vscode.commands.executeCommand(
			'vscode.executeHoverProvider',
			mainFileUri,
			position
		);

		log('Hovers found: ' + (hovers ? hovers.length : 'NULL'));
		assert.ok(hovers && hovers.length > 0, 'No hover found at ' + position.line + ',' + position.character);
	});

	test('Diagnostic filtering (GTK-specific properties)', async () => {
		log('Test 5: Diagnostic filtering');
		const doc = await vscode.workspace.openTextDocument(mainFileUri);
		log('Waiting for diagnostics...');
		await new Promise(resolve => setTimeout(resolve, 3000));
		
		const diagnostics = vscode.languages.getDiagnostics(mainFileUri);
		log('Diagnostics found: ' + diagnostics.length);
		const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
		assert.strictEqual(errors.length, 0, `Errors found: ${errors.map(e => e.message).join(', ')}`);
	});
});
