// herdr-status: report Command Code's state to the Herdr desktop app.
//
// The desktop app (herdr-app + herdr-core/hc) treats any terminal whose program
// emits OSC 7501, the Program Status Protocol, as an agent:
//
//   ESC ] 7501 ; state=working:app=command-code:msg=<base64> ESC \
//
// Herdr then shows idle/working/blocked/done/error in its sidebar and notifications.
// A sub-agent is a child record (`id=subagents/<key>`) with its own title and
// message, which the protocol nests under the session's root record.
// This mod writes those reports to Command Code's own TTY on lifecycle events.
// It is a no-op outside a Herdr desktop terminal: herdr-core exports
// HC_TERMINAL_ID to every program it runs, so that variable is the gate.
//
// Install: copy to ~/.commandcode/mods/herdr-status.ts and restart Command Code,
// or try it with `command-code --mod ./mods/herdr-status.ts`. Disable with
// CMD_HERDR_OSC=0.

import {createHash} from 'node:crypto';
import type {ModApi} from '@commandcode/harness';

const ESC = '\x1b';
const ST = `${ESC}\\`;
const APP = 'command-code';
const MAX_MESSAGE = 120;
const MAX_TITLE = 192;
const MAX_RECORDS = 256;
const SUBAGENT_PREFIX = 'subagents/';

export type HerdrState = 'idle' | 'working' | 'blocked' | 'done' | 'error' | 'clear';
export type HerdrKind = 'permission' | 'question' | 'auth';

export interface ReportMeta {
	kind?: HerdrKind;
	message?: string;
	title?: string;
	id?: string;
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
export function sanitizeMessage(text: unknown, max = MAX_MESSAGE): string | undefined {
	if (typeof text !== 'string') return undefined;
	const line = text
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!line) return undefined;
	// Count code points so truncation never splits a surrogate pair.
	const chars = Array.from(line);
	return chars.length > max ? chars.slice(0, max).join('') : line;
}

// `title` is a short label (the protocol caps it at 192 decoded characters).
export function sanitizeTitle(text: unknown): string | undefined {
	return sanitizeMessage(text, MAX_TITLE);
}

export function encodeReport(state: HerdrState, meta: ReportMeta = {}): string {
	let body = `state=${state}:app=${APP}`;
	if (meta.id) body += `:id=${meta.id}`;
	if (meta.kind) body += `:kind=${meta.kind}`;
	const title = sanitizeTitle(meta.title);
	if (title) body += `:title=${Buffer.from(title, 'utf8').toString('base64')}`;
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

	// One last report per record id ('' is the root record), so unchanged states
	// are not re-sent while two sub-agents can report independently.
	const last = new Map<string, string>();

	return {
		enabled,
		report(state, meta = {}) {
			if (!enabled) return;
			const id = meta.id ?? '';
			const title = sanitizeTitle(meta.title);
			const message = sanitizeMessage(meta.message);
			const key = `${state}|${meta.kind ?? ''}|${title ?? ''}|${message ?? ''}`;
			if (!meta.force && last.get(id) === key) return;
			if (state === 'clear') {
				if (id) last.delete(id);
				else last.clear();
			} else {
				last.set(id, key);
				// Mirror the protocol's record cap so a very long session cannot
				// grow this bookkeeping without bound.
				if (last.size > MAX_RECORDS) {
					const oldest = last.keys().next().value;
					if (oldest !== undefined) last.delete(oldest);
				}
			}
			write(encodeReport(state, {kind: meta.kind, id: meta.id, title, message}));
		},
	};
}

// A stable, protocol-safe record id: each id segment is at most 32 characters
// from [A-Za-z0-9_.+-]. Tool-call ids are provider-specific, so hash them.
export function subagentRecordId(toolCallId: string): string {
	const digest = createHash('sha1').update(toolCallId).digest('hex');
	return `${SUBAGENT_PREFIX}${digest.slice(0, 12)}`;
}

function tokensText(tokens: unknown): string | undefined {
	if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
		return undefined;
	}
	const value = tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k` : String(tokens);
	return `${value} tokens`;
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
export const SUBAGENT_BACKGROUNDED = 'subagent_backgrounded';

interface SubagentEvent {
	toolCallId?: unknown;
	subagentType?: unknown;
	description?: unknown;
	background?: unknown;
	toolName?: unknown;
	tokensUsed?: unknown;
	status?: unknown;
}

interface SubagentRef {
	id: string;
	type: string;
	background: boolean;
}

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

	// Interaction events and subagent backgrounding carry fields outside some
	// AgentEventType unions, so observe them through the same loose signature.
	const onAny = cmd.on as (
		event: string,
		handler: (event: Record<string, unknown>) => void,
	) => {dispose(): void};

	const subagents = new Map<string, SubagentRef>();
	let blockedSubagent: string | undefined;

	// The harness reports an interaction for the run, not which run asked. Only
	// attribute it to a child when exactly one foreground sub-agent is active.
	const blockActiveSubagent = (kind: HerdrKind, message: string) => {
		const foreground = [...subagents.entries()].filter(
			([, ref]) => !ref.background,
		);
		if (foreground.length !== 1) return;
		const entry = foreground[0];
		if (!entry) return;
		const [toolCallId, ref] = entry;
		if (blockedSubagent === toolCallId) return;
		blockedSubagent = toolCallId;
		reporter.report('blocked', {
			id: ref.id,
			title: ref.type,
			kind,
			message,
			force: true,
		});
	};

	const releaseBlockedSubagent = () => {
		if (!blockedSubagent) return;
		const toolCallId = blockedSubagent;
		blockedSubagent = undefined;
		const ref = subagents.get(toolCallId);
		if (ref) {
			reporter.report('working', {id: ref.id, title: ref.type, force: true});
		}
	};

	const refFor = (
		toolCallId: string,
		subagentType: unknown,
		background = false,
	): SubagentRef => {
		const existing = subagents.get(toolCallId);
		if (existing) return existing;
		const ref = {
			id: subagentRecordId(toolCallId),
			type:
				typeof subagentType === 'string' && subagentType
					? subagentType
					: 'subagent',
			background,
		};
		subagents.set(toolCallId, ref);
		return ref;
	};

	const clearForegroundSubagents = () => {
		for (const [toolCallId, ref] of subagents) {
			if (ref.background) continue;
			if (blockedSubagent === toolCallId) blockedSubagent = undefined;
			reporter.report('clear', {id: ref.id, force: true});
			subagents.delete(toolCallId);
		}
	};

	cmd.hooks({
		onSessionStart: () => {
			subagents.clear();
			blockedSubagent = undefined;
			reporter.report('idle', {force: true});
		},
		onSessionEnd: () => {
			reporter.report('clear', {force: true});
			subagents.clear();
			blockedSubagent = undefined;
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
	cmd.on('run_end', () => {
		reporter.report('done');
		clearForegroundSubagents();
	});
	cmd.on('run_error', (event) => {
		reporter.report('error', {
			message: errorText((event as {error?: unknown}).error),
		});
		clearForegroundSubagents();
	});
	cmd.on('interrupted', () => {
		reporter.report('idle', {force: true});
		clearForegroundSubagents();
	});
	cmd.on('compaction_start', () =>
		reporter.report('working', {message: 'compacting'}),
	);
	cmd.on('compaction_done', () => reporter.report('working'));

	// A failed `agent` tool never emits subagent_stop, so drop its child record.
	cmd.on('tool_errored', (raw) => {
		const event = raw as {toolCallId?: unknown};
		const toolCallId =
			typeof event.toolCallId === 'string' ? event.toolCallId : '';
		const ref = subagents.get(toolCallId);
		if (!ref) return;
		if (blockedSubagent === toolCallId) blockedSubagent = undefined;
		reporter.report('clear', {id: ref.id, force: true});
		subagents.delete(toolCallId);
	});

	// Sub-agents are nested records under the session's root record:
	// subagents/<key> with the agent type as the title.
	cmd.on('subagent_start', (raw) => {
		const event = raw as SubagentEvent;
		const toolCallId =
			typeof event.toolCallId === 'string' ? event.toolCallId : '';
		if (!toolCallId) return;
		const ref = refFor(toolCallId, event.subagentType, Boolean(event.background));
		ref.background = Boolean(event.background);
		reporter.report('working', {
			id: ref.id,
			title: ref.type,
			message:
				typeof event.description === 'string' && event.description
					? event.description
					: ref.type,
			force: true,
		});
	});

	cmd.on('subagent_progress', (raw) => {
		const event = raw as SubagentEvent;
		const toolCallId =
			typeof event.toolCallId === 'string' ? event.toolCallId : '';
		if (!toolCallId) return;
		// Recreate the ref so progress still lands after a mod reload.
		const ref = refFor(toolCallId, event.subagentType);
		reporter.report('working', {
			id: ref.id,
			title: ref.type,
			message:
				typeof event.toolName === 'string' ? event.toolName : ref.type,
		});
	});

	cmd.on('subagent_stop', (raw) => {
		const event = raw as SubagentEvent;
		const toolCallId =
			typeof event.toolCallId === 'string' ? event.toolCallId : '';
		if (!toolCallId) return;
		const ref = refFor(toolCallId, event.subagentType);
		if (blockedSubagent === toolCallId) blockedSubagent = undefined;
		const failed = event.status === 'failed' || event.status === 'error';
		reporter.report(failed ? 'error' : 'done', {
			id: ref.id,
			title: ref.type,
			message: tokensText(event.tokensUsed) ?? (failed ? 'failed' : 'done'),
			force: true,
		});
		subagents.delete(toolCallId);
	});

	onAny(SUBAGENT_BACKGROUNDED, (event) => {
		const toolCallId = String(event.toolCallId ?? '');
		const ref = subagents.get(toolCallId);
		if (ref) ref.background = true;
	});

	// Interaction events carry the permission and question prompts.
	onAny(INTERACTION_REQUESTED, (event) => {
		const kind = event.kind === 'permission' ? 'permission' : 'question';
		const message =
			kind === 'permission' ? String(event.toolName ?? 'permission') : 'input';
		reporter.report('blocked', {kind, message, force: true});
		blockActiveSubagent(kind, message);
	});
	onAny(INTERACTION_RESOLVED, () => {
		releaseBlockedSubagent();
		reporter.report('working');
	});
}
