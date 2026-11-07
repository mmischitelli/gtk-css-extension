const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const {
	createProtocolConnection, StreamMessageReader, StreamMessageWriter
} = require('vscode-languageserver/node');

suite('GTK color validation over LSP', () => {
	let server;
	let connection;
	let sequence = 0;
	const pending = new Map();

	suiteSetup(async () => {
		server = spawn(process.execPath, [path.resolve(__dirname, '../../server/server.js'), '--stdio'], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			stdio: ['pipe', 'pipe', 'inherit']
		});
		connection = createProtocolConnection(
			new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin));
		connection.onNotification('textDocument/publishDiagnostics', ({ uri, diagnostics }) => {
			const resolve = pending.get(uri);
			if (resolve) resolve(diagnostics);
		});
		connection.listen();
		await connection.sendRequest('initialize', {
			processId: null, rootUri: null, capabilities: {}
		});
		await connection.sendNotification('initialized', {});
	});

	suiteTeardown(async () => {
		if (connection) connection.dispose();
		if (server && server.exitCode === null && server.signalCode === null) {
			await new Promise(resolve => {
				server.once('exit', resolve);
				server.kill();
			});
		}
	});

	async function validate(text) {
		const uri = `untitled:gtk-color-validation-${++sequence}.gtk.css`;
		let timer;
		try {
			return await new Promise((resolve, reject) => {
				pending.set(uri, resolve);
				timer = setTimeout(() => reject(new Error(`No diagnostics received for ${uri}`)), 5000);
				connection.sendNotification('textDocument/didOpen', {
					textDocument: { uri, languageId: 'gtk-css', version: 1, text }
				}).catch(reject);
			});
		} finally {
			clearTimeout(timer);
			pending.delete(uri);
			await connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
		}
	}

	for (const [name, text] of [
		['comment delimiters inside strings', '.x { content: "/*"; color: red; } /* end */'],
		['quoted references and comments', '.x { content: "@label"; } /* @ignored */'],
		['escaped quotes', String.raw`.x { content: "hello\" @label"; }`],
		['LF string continuations', '.x { content: "hello\\\n@label"; }'],
		['CRLF string continuations', '.x { content: "hello\\\r\n@label"; }'],
		['unquoted URL paths', '.x { background-image: url(https://example.org/@assets/image.png); }'],
		['quoted URLs', '.x { background-image: url("https://example.org/@assets/image.png"); }'],
		['escaped URL parentheses', String.raw`.x { background-image: URL(image\)@asset.png); }`],
		['uppercase at-rules', '@MEDIA screen { .x { color: red; } }'],
		['unterminated comments', '.x { color: red; } /* @ignored']
	]) {
		test(`Preserves ${name}`, async () => {
			assert.deepStrictEqual(await validate(text), []);
		});
	}

	test('Reports only real references with original UTF-16 ranges and case-sensitive names', async () => {
		const text = '@define-color Base #123456;\r\n' +
			'.x { content: "😀 /* @ignored */"; color: @Base; background-color: @base; }';
		const diagnostics = await validate(text);
		assert.strictEqual(diagnostics.length, 1);
		const diagnostic = diagnostics[0];
		assert.strictEqual(diagnostic.code, 'gtk-undefinedcolor');
		assert.strictEqual(diagnostic.severity, 2);
		const line = text.split('\r\n')[1];
		const start = line.indexOf('@base');
		assert.deepStrictEqual(diagnostic.range, {
			start: { line: 1, character: start }, end: { line: 1, character: start + 5 }
		});
	});

	test('Resumes scanning after strings, comments and URL tokens', async () => {
		const text = '.x { content: "/*"; background-image: url(@asset.png); ' +
			'/* @ignored */ color: @missing; }';
		const diagnostics = await validate(text);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].code, 'gtk-undefinedcolor');
		const start = text.indexOf('@missing');
		assert.deepStrictEqual(diagnostics[0].range, {
			start: { line: 0, character: start }, end: { line: 0, character: start + 8 }
		});
	});

	test('Preserves parser diagnostics alongside quoted comment delimiters', async () => {
		const diagnostics = await validate('.x { content: "/*"; color red; } /* end */');
		assert.ok(diagnostics.some(d => d.severity === 1 && d.code === 'css-colonexpected'));
	});
});
