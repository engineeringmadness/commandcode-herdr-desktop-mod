import assert from 'node:assert/strict';
import herdrStatus, {
	INTERACTION_REQUESTED,
	INTERACTION_RESOLVED,
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

// 3. Clear report.
assert.equal(encodeReport('clear'), report('clear'));

// 4. Messages are sanitized to one bounded line.
assert.equal(sanitizeMessage('line one\nline two\t!'), 'line one line two !');
assert.equal(sanitizeMessage('x'.repeat(200)).length, 120);
assert.equal(sanitizeMessage('   '), undefined);

// 5. Truncation counts code points, so a surrogate pair is never split.
{
	const truncated = sanitizeMessage('x'.repeat(119) + '\u{1F600}' + 'y');
	assert.equal(Array.from(truncated).length, 120);
	assert.equal(truncated, 'x'.repeat(119) + '\u{1F600}');
}

// 6. The reporter is disabled outside a herdr-core terminal.
const noop = {write() {}};
for (const [label, options] of [
	['no HC_TERMINAL_ID', {env: {}, isTTY: true, ...noop}],
	['not a TTY', {env: {HC_TERMINAL_ID: 't1'}, isTTY: false, ...noop}],
	['opt-out', {env: {HC_TERMINAL_ID: 't1', CMD_HERDR_OSC: '0'}, isTTY: true, ...noop}],
]) {
	assert.equal(createReporter(options).enabled, false, label);
}

// 7. Dedupe identical reports; force always writes.
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

// Mount the mod onto a fake host so each registered seam can be exercised.
function mount(options = {}) {
	const writes = [];
	const hooks = {};
	const events = new Map();
	let command;
	herdrStatus(
		{
			addCommand(registered) {
				command = registered;
			},
			hooks(registered) {
				Object.assign(hooks, registered);
			},
			on(event, handler) {
				events.set(event, handler);
				return {dispose() {}};
			},
		},
		{
			env: {HC_TERMINAL_ID: 't1'},
			isTTY: true,
			write: (chunk) => writes.push(chunk),
			...options,
		},
	);
	return {writes, hooks, events, command};
}

// 8. The factory wires every lifecycle seam to the reported states.
{
	const {writes, hooks, events} = mount();

	assert.equal(events.has(INTERACTION_REQUESTED), true);
	assert.equal(events.has(INTERACTION_RESOLVED), true);

	hooks.onSessionStart();
	events.get('run_start')();
	hooks.onPermissionRequest({toolName: 'shell_command', description: 'Run a command'});
	hooks.beforeToolCall({toolName: 'shell_command'});
	hooks.afterToolCall();
	hooks.beforeToolCall({toolName: 'ask_user_question'});
	hooks.afterToolCall();
	events.get(INTERACTION_REQUESTED)({kind: 'permission', toolName: 'shell_command'});
	events.get(INTERACTION_RESOLVED)();
	events.get('compaction_start')();
	events.get('compaction_done')();
	events.get('interrupted')();
	events.get('run_error')({error: new Error('boom')});
	events.get('run_end')();
	hooks.onSessionEnd();

	assert.deepEqual(writes, [
		report('idle'),
		report('working'),
		report('blocked', 'permission', 'Run a command'),
		report('working'),
		report('blocked', 'question', 'ask_user_question'),
		report('working'),
		report('blocked', 'permission', 'shell_command'),
		report('working'),
		report('working', undefined, 'compacting'),
		report('working'),
		report('idle'),
		report('error', undefined, 'boom'),
		report('done'),
		report('clear'),
	]);
}

// 9. A non-Error run_error value still reports its message.
{
	const {writes, events} = mount();
	events.get('run_error')({error: 'plain text'});
	assert.deepEqual(writes, [report('error', undefined, 'plain text')]);
}

// 10. A disabled reporter registers the command but no reporting seams.
{
	const {command, hooks, events} = mount({env: {}, isTTY: true});
	assert.match(command.handler().message, /not reporting/);
	assert.equal(events.size, 0);
	assert.equal(hooks.onSessionStart, undefined);
}

console.log('ok');
