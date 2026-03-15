const path = require('path');
const Mocha = require('mocha');
const { glob } = require('glob');

function run() {
	// Create the mocha test
	const mocha = new Mocha({
		ui: 'tdd',
		color: true,
		timeout: 10000
	});

	const testsRoot = path.resolve(__dirname, '..');

	return new Promise((c, e) => {
		try {
			console.log('Finding test files in:', testsRoot);
			const files = glob.sync('**/**.test.js', { cwd: testsRoot });
			console.log('Found test files:', files);

			// Add files to the test suite
			files.forEach(f => {
				const fullPath = path.resolve(testsRoot, f);
				console.log('Adding test file:', fullPath);
				mocha.addFile(fullPath);
			});

			console.log('Starting Mocha run...');
			// Run the mocha test
			mocha.run(failures => {
				console.log('Mocha run finished with failures:', failures);
				if (failures > 0) {
					e(new Error(`${failures} tests failed.`));
				} else {
					c();
				}
			});
		} catch (err) {
			console.error('Catch error in test runner:', err);
			e(err);
		}
	});
}

module.exports = {
	run
};
