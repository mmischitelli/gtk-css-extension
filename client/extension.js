// @ts-check
'use strict';

const path = require('path');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

/** @type {LanguageClient} */
let client;

/**
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server', 'server.js'));

  /** @type {import('vscode-languageclient/node').ServerOptions} */
  const serverOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] }
    }
  };

  /** @type {import('vscode-languageclient/node').LanguageClientOptions} */
  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'gtk-css' }],
    synchronize: {
      // Notifica il server se cambiano file .gtk.css nel workspace
      fileEvents: require('vscode').workspace.createFileSystemWatcher('**/*.gtk.css')
    }
  };

  client = new LanguageClient(
    'gtkCssLanguageServer',
    'GTK CSS Language Server',
    serverOptions,
    clientOptions
  );

  console.log('Starting Language Client...');
  client.start().then(() => {
    console.log('Language Client started successfully.');
  }).catch(err => {
    console.error('Language Client failed to start:', err);
  });
}

function deactivate() {
  if (!client) return undefined;
  return client.stop();
}

module.exports = { activate, deactivate };
