import assert from 'node:assert/strict';
import herdrStatus, {
	INTERACTION_REQUESTED,
	INTERACTION_RESOLVED,
	SUBAGENT_BACKGROUNDED,
	createReporter,
	encodeReport,
	sanitizeMessage,
	sanitizeTitle,
	subagentRecordId,
} from '../mods/herdr-status.ts';

const ESC = '\x1b';
const ST = `${ESC}\\`;

function report(state, kind, message, id, title) {
	const parts = [`state=${state}`, 'app=command-code'];
	if (id) parts.push(`id=${id}`);
	if (kind) parts.push(`kind=${kind}`);
	if (title) parts.push(`title=${Buffer.from(title, 'utf8').toString('base64')}`);
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

// 4. A nested record carries its id, title, and message.
assert.equal(
	encodeReport('working', {
		id: 'subagents/abc123',
		title: 'explore',
		message: 'reading files',
	}),
	report('working', undefined, 'reading files', 'subagents/abc123', 'explore'),
);

// 5. Messages are sanitized to one bounded line; titles use the protocol's cap.
assert.equal(sanitizeMessage('line one\nline two\t!'), 'line one line two !');
assert.equal(sanitizeMessage('x'.repeat(200)).length, 120);
assert.equal(sanitizeMessage('   '), undefined);
assert.equal(sanitizeTitle('x'.repeat(200)).length, 192);

// 6. Truncation counts code points, so a surrogate pair is never split.
{
	const truncated = sanitizeMessage('x'.repeat(119) + '\u{1F600}' + 'y');
	assert.equal(Array.from(truncated).length, 120);
	assert.equal(truncated, 'x'.repeat(119) + '\u{1F600}');
}

// 7. Subagent ids are stable, short, and protocol-safe.
{
	assert.match(subagentRecordId('call_1'), /^subagents\/[0-9a-f]{12}$/);
	assert.equal(subagentRecordId('call_1'), subagentRecordId('call_1'));
	assert.notEqual(subagentRecordId('call_1'), subagentRecordId('call_2'));
	assert.ok(subagentRecordId('x'.repeat(500)).length <= 128);
}

// 8. The reporter is disabled outside a herdr-core terminal.
const noop = {write() {}};
for (const [label, options] of [
	['no HC_TERMINAL_ID', {env: {}, isTTY: true, ...noop}],
	['not a TTY', {env: {HC_TERMINAL_ID: 't1'}, isTTY: false, ...noop}],
	['opt-out', {env: {HC_TERMINAL_ID: 't1', CMD_HERDR_OSC: '0'}, isTTY: true, ...noop}],
]) {
	assert.equal(createReporter(options).enabled, false, label);
}

// 9. Dedupe identical reports per record; force always writes.
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

// 10. Child records dedupe independently of the root, and a clear forgets one.
{
	const writes = [];
	const reporter = createReporter({
		env: {HC_TERMINAL_ID: 't1'},
		isTTY: true,
		write: (chunk) => writes.push(chunk),
	});
	reporter.report('working', {id: 'subagents/a', title: 'explore'});
	reporter.report('working', {id: 'subagents/a', title: 'explore'});
	reporter.report('working', {id: 'subagents/b', title: 'explore'});
	reporter.report('working');
	reporter.report('working');
	reporter.report('clear', {id: 'subagents/a'});
	reporter.report('working', {id: 'subagents/a', title: 'explore'});
	assert.equal(writes.length, 5);
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

// 11. The factory wires every lifecycle seam to the reported states.
{
	const {writes, hooks, events} = mount();

	assert.equal(events.has(INTERACTION_REQUESTED), true);
	assert.equal(events.has(INTERACTION_RESOLVED), true);
	assert.equal(events.has(SUBAGENT_BACKGROUNDED), true);

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

// 12. A non-Error run_error value still reports its message.
{
	const {writes, events} = mount();
	events.get('run_error')({error: 'plain text'});
	assert.deepEqual(writes, [report('error', undefined, 'plain text')]);
}

// 13. A disabled reporter registers the command but no reporting seams.
{
	const {command, hooks, events} = mount({env: {}, isTTY: true});
	assert.match(command.handler().message, /not reporting/);
	assert.equal(events.size, 0);
	assert.equal(hooks.onSessionStart, undefined);
}

// 14. A subagent becomes a nested working record, then done with its tokens.
{
	const {writes, events} = mount();
	const id = subagentRecordId('call_1');

	events.get('subagent_start')({
		toolCallId: 'call_1',
		subagentType: 'explore',
		description: 'find handlers',
	});
	events.get('subagent_progress')({
		toolCallId: 'call_1',
		subagentType: 'explore',
		toolName: 'grep',
	});
	events.get('subagent_stop')({
		toolCallId: 'call_1',
		subagentType: 'explore',
		tokensUsed: 1500,
	});

	assert.deepEqual(writes, [
		report('working', undefined, 'find handlers', id, 'explore'),
		report('working', undefined, 'grep', id, 'explore'),
		report('done', undefined, '1.5k tokens', id, 'explore'),
	]);
}

// 15. A background subagent survives an interrupt and reports failure.
{
	const {writes, events} = mount();
	const id = subagentRecordId('call_2');

	events.get('subagent_start')({
		toolCallId: 'call_2',
		subagentType: 'review',
		background: true,
	});
	events.get('interrupted')();
	events.get('subagent_stop')({
		toolCallId: 'call_2',
		subagentType: 'review',
		tokensUsed: 20,
		status: 'failed',
	});

	assert.deepEqual(writes, [
		report('working', undefined, 'review', id, 'review'),
		report('idle'),
		report('error', undefined, '20 tokens', id, 'review'),
	]);
}

// 16. A moved-to-background subagent is not cleared by the run boundary.
{
	const {writes, events} = mount();
	const id = subagentRecordId('call_3');

	events.get('subagent_start')({toolCallId: 'call_3', subagentType: 'general'});
	events.get(SUBAGENT_BACKGROUNDED)({toolCallId: 'call_3'});
	events.get('interrupted')();

	assert.deepEqual(writes, [
		report('working', undefined, 'general', id, 'general'),
		report('idle'),
	]);
}

// 17. A foreground subagent is cleared on interrupt, tool error, and run end.
for (const [label, finish] of [
	['interrupt', (events) => events.get('interrupted')()],
	[
		'agent tool error',
		(events) =>
			events.get('tool_errored')({toolCallId: 'call_4', toolName: 'agent'}),
	],
	['run end', (events) => events.get('run_end')()],
]) {
	const {writes, events} = mount();
	const id = subagentRecordId('call_4');
	events.get('subagent_start')({toolCallId: 'call_4', subagentType: 'explore'});
	finish(events);

	const expected = [report('working', undefined, 'explore', id, 'explore')];
	if (label === 'interrupt') expected.push(report('idle'));
	if (label === 'run end') expected.push(report('done'));
	expected.push(report('clear', undefined, undefined, id));
	assert.deepEqual(writes, expected, label);
}

// 18. Session end clears the tree; later boundaries do not re-clear children.
{
	const {writes, events, hooks} = mount();
	const id = subagentRecordId('call_5');

	events.get('subagent_start')({toolCallId: 'call_5', subagentType: 'explore'});
	hooks.onSessionEnd();
	events.get('interrupted')();

	assert.deepEqual(writes, [
		report('working', undefined, 'explore', id, 'explore'),
		report('clear'),
		report('idle'),
	]);
}

console.log('ok');
