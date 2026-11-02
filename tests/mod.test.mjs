import assert from 'node:assert/strict';
import herdrStatus, {
	createReporter,
	encodeReport,
	sanitizeMessage,
} from '../mods/herdr-status.ts';

const ESC = '\x1b';
const ST = `${ESC}\\`;

function report(state, kind, message) {
	const parts = [`state=${state}`, 'app=command-code'];
	if (kind) parts.push(`kind=${kind}`);
	if (message) parts.push(`msg=${Buffer.from(message, 'utf8').toString('base64')}`);
	return `${ESC}]7501;${parts.join(':')}${ST}`;
}

// 1. Bare report.
assert.equal(encodeReport('working'), report('working'));

// 2. Blocked report with kind and base64 message.
assert.equal(
	encodeReport('blocked', {kind: 'permission', message: 'Needs approval'}),
	report('blocked', 'permission', 'Needs approval'),
);

// 3. Messages are sanitized to one bounded line.
assert.equal(sanitizeMessage('line one\nline two\t!'), 'line one line two !');
assert.equal(sanitizeMessage('x'.repeat(200)).length, 120);
assert.equal(sanitizeMessage('   '), undefined);

// 4. The reporter is disabled outside a herdr-core terminal.
const noop = {write() {}};
for (const [label, options] of [
	['no HC_TERMINAL_ID', {env: {}, isTTY: true, ...noop}],
	['not a TTY', {env: {HC_TERMINAL_ID: 't1'}, isTTY: false, ...noop}],
	['opt-out', {env: {HC_TERMINAL_ID: 't1', CMD_HERDR_OSC: '0'}, isTTY: true, ...noop}],
]) {
	assert.equal(createReporter(options).enabled, false, label);
}

// 5. Dedupe identical reports; force always writes.
{
	const writes = [];
	const reporter = createReporter({
		env: {HC_TERMINAL_ID: 't1'},
		isTTY: true,
		write: (chunk) => writes.push(chunk),
	});
	reporter.report('working');
	reporter.report('working');
	reporter.report('working', {force: true});
	assert.equal(writes.length, 2);
	assert.equal(writes[0], report('working'));
}

// 6. The factory wires the lifecycle to the reported states.
{
	const writes = [];
	const hooks = {};
	const events = new Map();
	const cmd = {
		addCommand() {},
		hooks(registered) {
			Object.assign(hooks, registered);
		},
		on(event, handler) {
			events.set(event, handler);
			return {dispose() {}};
		},
	};

	herdrStatus(cmd, {
		env: {HC_TERMINAL_ID: 't1'},
		isTTY: true,
		write: (chunk) => writes.push(chunk),
	});

	hooks.onSessionStart();
	events.get('run_start')();
	events.get('interaction_requested')({kind: 'permission', toolName: 'shell_command'});
	events.get('interaction_resolved')();
	events.get('run_end')();

	assert.deepEqual(writes, [
		report('idle'),
		report('working'),
		report('blocked', 'permission', 'shell_command'),
		report('working'),
		report('done'),
	]);
}

console.log('ok');
