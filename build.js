const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const clientConfig = {
    entryPoints: ['./client/extension.js'],
    bundle: true,
    outfile: './dist/client/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    minify: !watch,
    sourcemap: watch,
};

/** @type {esbuild.BuildOptions} */
const serverConfig = {
    entryPoints: ['./server/server.js'],
    bundle: true,
    outfile: './dist/server/server.js',
    format: 'cjs',
    platform: 'node',
    minify: !watch,
    sourcemap: watch,
    mainFields: ['module', 'main'],
};

async function main() {
    if (watch) {
        const clientContext = await esbuild.context(clientConfig);
        const serverContext = await esbuild.context(serverConfig);
        await Promise.all([clientContext.watch(), serverContext.watch()]);
        console.log('Watching for changes...');
    } else {
        const results = await Promise.all([
            esbuild.build(clientConfig),
            esbuild.build(serverConfig),
        ]);
        results.forEach((res, i) => {
            console.log(`Build ${i === 0 ? 'client' : 'server'} warnings:`, res.warnings);
        });
        console.log('Build complete');
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
