// herdr-status: report Command Code's state to the Herdr desktop app.
//
// The desktop app (herdr-app + herdr-core/hc) treats any terminal whose program
// emits OSC 7501, the Program Status Protocol, as an agent:
//
//   ESC ] 7501 ; state=working:app=command-code:msg=<base64> ESC \
//
// Herdr then shows idle/working/blocked/done/error in its sidebar and notifications.
// This mod writes those reports to Command Code's own TTY on lifecycle events.
// It is a no-op outside a Herdr desktop terminal: herdr-core exports
// HC_TERMINAL_ID to every program it runs, so that variable is the gate.
//
// Install: copy to ~/.commandcode/mods/herdr-status.ts and restart Command Code,
// or try it with `command-code --mod ./mods/herdr-status.ts`. Disable with
// CMD_HERDR_OSC=0.

import type {ModApi} from '@commandcode/harness';

const ESC = '\x1b';
const ST = `${ESC}\\`;
const APP = 'command-code';
const MAX_MESSAGE = 120;

export type HerdrState = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'clear';
export type HerdrKind = 'permission' | 'question' | 'auth';

export interface ReportMeta {
	kind?: HerdrKind;
	message?: string;
	force?: boolean;
}

export interface ReporterOptions {
	env?: Record<string, string | undefined>;
	isTTY?: boolean;
	write?: (chunk: string) => void;
}

export interface HerdrReporter {
	readonly enabled: boolean;
	report(state: HerdrState, meta?: ReportMeta): void;
}

// OSC 7501 carries one line of human text, base64-encoded. Keep it single-line,
// free of control characters, and bounded; Herdr rejects oversized payloads.
export function sanitizeMessage(text: unknown): string | undefined {
	if (typeof text !== 'string') return undefined;
	const line = text
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!line) return undefined;
	// Count code points so truncation never splits a surrogate pair.
	const chars = Array.from(line);
	return chars.length > MAX_MESSAGE ? chars.slice(0, MAX_MESSAGE).join('') : line;
}

export function encodeReport(state: HerdrState, meta: ReportMeta = {}): string {
	let body = `state=${state}:app=${APP}`;
	if (meta.kind) body += `:kind=${meta.kind}`;
	const message = sanitizeMessage(meta.message);
	if (message) body += `:msg=${Buffer.from(message, 'utf8').toString('base64')}`;
	return `${ESC}]7501;${body}${ST}`;
}

export function createReporter(options: ReporterOptions = {}): HerdrReporter {
	const env = options.env ?? process.env;
	const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
	const write =
		options.write ?? ((chunk: string) => void process.stdout.write(chunk));
	// herdr-core accepts reports without the protocol's support query, and reading
	// stdin for the reply would contend with the TUI's input handling, so this
	// reporter deliberately does not probe.
	const enabled =
		Boolean(env.HC_TERMINAL_ID) && isTTY && env.CMD_HERDR_OSC !== '0';

	let last = '';

	return {
		enabled,
		report(state, meta = {}) {
			if (!enabled) return;
			const message = sanitizeMessage(meta.message);
			const key = `${state}|${meta.kind ?? ''}|${message ?? ''}`;
			if (!meta.force && key === last) return;
			last = key;
			write(encodeReport(state, {kind: meta.kind, message}));
		},
	};
}

const INTERACTIVE_TOOLS = new Set([
	'ask_user_question',
	'AskUserQuestion',
	'question',
	'Question',
]);

// Part of the harness event stream but not of the public AgentEventType union.
export const INTERACTION_REQUESTED = 'interaction_requested';
export const INTERACTION_RESOLVED = 'interaction_resolved';

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	return 'error';
}

export default function herdrStatus(
	cmd: ModApi,
	options: ReporterOptions = {},
): void {
	const reporter = createReporter(options);

	cmd.addCommand({
		name: 'herdr-status',
		description: 'Show whether this session reports to the Herdr desktop app',
		handler: () => ({
			message: reporter.enabled
				? `herdr: reporting via OSC 7501 (app=${APP})`
				: 'herdr: not reporting (not inside a Herdr desktop terminal, or CMD_HERDR_OSC=0)',
		}),
	});

	if (!reporter.enabled) return;

	cmd.hooks({
		onSessionStart: () => {
			reporter.report('idle', {force: true});
		},
		onSessionEnd: () => {
			reporter.report('clear', {force: true});
		},
		onPermissionRequest: ({toolName, description}) => {
			reporter.report('blocked', {
				kind: 'permission',
				message: description || toolName,
				force: true,
			});
			return undefined;
		},
		beforeToolCall: ({toolName}) => {
			if (INTERACTIVE_TOOLS.has(toolName)) {
				reporter.report('blocked', {
					kind: 'question',
					message: toolName,
					force: true,
				});
			} else {
				reporter.report('working');
			}
			return undefined;
		},
		afterToolCall: () => {
			reporter.report('working');
			return undefined;
		},
	});

	cmd.on('run_start', () => reporter.report('working'));
	cmd.on('run_end', () => reporter.report('done'));
	cmd.on('run_error', (event) =>
		reporter.report('error', {
			message: errorText((event as {error?: unknown}).error),
		}),
	);
	cmd.on('interrupted', () => reporter.report('idle', {force: true}));
	cmd.on('compaction_start', () =>
		reporter.report('working', {message: 'compacting'}),
	);
	cmd.on('compaction_done', () => reporter.report('working'));

	// Interaction events carry the permission and question prompts.
	const onAny = cmd.on as (
		event: string,
		handler: (event: Record<string, unknown>) => void,
	) => {dispose(): void};
	onAny(INTERACTION_REQUESTED, (event) => {
		const permission = event.kind === 'permission';
		reporter.report('blocked', {
			kind: permission ? 'permission' : 'question',
			message: permission ? String(event.toolName ?? 'permission') : 'input',
			force: true,
		});
	});
	onAny(INTERACTION_RESOLVED, () => reporter.report('working'));
}
