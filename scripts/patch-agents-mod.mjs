#!/usr/bin/env node
// Patch a copy of Herdr's agents mod so Command Code's OSC 7501 child records
// (id=subagents/...) render as rows under the terminal that reported them.
//
// Usage: node scripts/patch-agents-mod.mjs <path/to/mods/agents-records/main.js>
//
// The patch targets the agents mod shipped with Herdr app 0.1.16. If the file
// no longer matches, it fails loudly instead of writing a half-patched view.

import {readFileSync, writeFileSync} from 'node:fs';

const file = process.argv[2];
if (!file) {
	console.error('usage: node scripts/patch-agents-mod.mjs <path/to/main.js>');
	process.exit(2);
}

let source = readFileSync(file, 'utf8');
if (source.includes('function recordKids(')) {
	console.log(`already patched: ${file}`);
	process.exit(0);
}

// Herdr writes these files with the platform's line endings.
const eol = source.includes('\r\n') ? '\r\n' : '\n';
const withEol = (text) => text.replace(/\r?\n/g, eol);

const statusBlock = [
	'const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };',
	'// A sub-agent without a pane isn\'t in agents(): its raw word, error counting as',
	'// blocked. It\'s never done: it reports to its parent, and the parent\'s done is the news.',
	'// Command Code sub-agents are 7501 child records instead, and their done is their own.',
	'const kidStatus = (k, listed) => {',
	'  const s = listed.get(k.address) ?? k.status;',
	'  if (k.record) return s === "error" ? "blocked" : s;',
	'  return s === "error" ? "blocked" : s === "done" ? "idle" : s;',
	'};',
	'',
	'// A terminal that reports several 7501 records (Command Code\'s sub-agents) gets',
	'// those records as extra rows under it. Ids look like subagents/<key>.',
	'function recordKids(all, addr) {',
	'  const host = all.find((k) => k.address === addr);',
	'  const records = host?.records;',
	'  if (!records || typeof records !== "object") return [];',
	'  return Object.entries(records)',
	'    .filter(([id, r]) => id.startsWith("subagents/") && r && typeof r === "object")',
	'    .map(([id, r]) => ({',
	'      address: `${addr}#${id}`,',
	'      host: addr,',
	'      parent: addr,',
	'      state: "live",',
	'      record: true,',
	'      name: r.title || id.slice("subagents/".length),',
	'      msg: r.msg || "",',
	'      status: r.state || "working",',
	'      app: r.app || "command-code",',
	'      program: host.program || { name: "Command Code", key: "command-code", agent: true },',
	'    }));',
	'}',
].join('\n');

const treeKids = [
	'    const kids = [',
	'      ...all.filter((k) => k.parent === addr && k.state === "live"),',
	'      ...recordKids(all, addr),',
	'    ];',
].join('\n');

const subRow = [
	'  subRow(t, s, shown, compact) {',
	'    const k = s.t;',
	'    const st = kidStatus(k, this.listed);',
	'    const pic = icon(k.program, 14, t.foreground);',
	'    const on = !k.record && k.address === shown;',
	'    const click = k.record',
	'      ? () => openOverlay({ mod: "agents-records", kind: "popup", width: 360, height: 170, props: { record: { title: k.name, status: st, msg: k.msg, host: k.host } } })',
	'      : () => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address));',
	'    return h_flex()',
	'      .id(`sub-${String(k.address).replace(/[^A-Za-z0-9_.+-]/g, "-")}`)',
	'      .pl(39)',
	'      .pr(8)',
	'      .rounded(8)',
	'      .h(26)',
	'      .flex_none()',
	'      .gap(0)',
	'      .items_center()',
	'      .text_size(12.5)',
	'      .when(on, (el) => el.bg(t.raised))',
	'      .hover((s) => s.bg(t.hover))',
	'      .on_click(click)',
	'      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()',
	'        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))',
	'        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))',
	'      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))',
	'      .child(h_flex().flex_1().min_w(0).gap(6).items_center()',
	'        .child(div().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))',
	'        .when(Boolean(k.msg), el => el.child(div().flex_none().max_w(120).truncate().text_size(11).text_color(t.dim).child(k.msg))))',
	'      .child(this.status(t, { status: st }, compact));',
	'  }',
].join('\n');

const recordPopup = [
	'  recordPopup(t) {',
	'    const record = props().record;',
	'    const close = () => closeOverlay(props().overlay);',
	'    return v_flex()',
	'      .size_full()',
	'      .bg(t.popover)',
	'      .p(14)',
	'      .gap(9)',
	'      .text_size(12.5)',
	'      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(record.title || "Sub-agent"))',
	'      .child(div().text_color(t.muted).child(record.msg ? record.status + " · " + record.msg : record.status))',
	'      .child(div().text_size(11.5).text_color(t.dim).child("This sub-agent runs inside Command Code. Focus its terminal to follow the output."))',
	'      .child(div().flex_1())',
	'      .child(h_flex().justify_end().gap(8)',
	'        .child(div().id("record-focus").px(10).h(24).rounded(6).bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => {',
	'          if (record.host) run("pane.focus", { terminal: record.host });',
	'          close();',
	'        }).child("Focus Command Code"))',
	'        .child(div().id("record-close").px(10).h(24).rounded(6).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(close).child("Close")));',
	'  }',
].join('\n');

const attentionMethods = [
	'  alertRecords(all) {',
	'    const next = new Map();',
	'    for (const host of all) {',
	'      const records = host.records;',
	'      if (!records || typeof records !== "object") continue;',
	'      for (const [id, record] of Object.entries(records)) {',
	'        if (!id.startsWith("subagents/") || !record || typeof record !== "object") continue;',
	'        const key = `${host.address}#${id}`;',
	'        const state = record.state || "working";',
	'        next.set(key, state);',
	'        if (!this.recordsReady) continue;',
	'        const previous = this.recordStates.get(key);',
	'        if ((state === "done" || state === "error") && previous !== "done" && previous !== "error") {',
	'          this.alertRecord(host, id, record, state);',
	'        }',
	'      }',
	'    }',
	'    this.recordStates = next;',
	'    this.recordsReady = true;',
	'  }',
	'',
	'  alertRecord(host, id, record, state) {',
	'    const focus = focused();',
	'    if (focus?.terminal === host.address) return;',
	'    const title = record.title || id.slice("subagents/".length);',
	'    const failed = state === "error";',
	'    const detail = record.msg ? ` · ${record.msg}` : "";',
	'    notify({',
	'      title: `${title} ${failed ? "failed" : "finished"}`,',
	'      body: `${host.name || host.program?.name || host.address}${detail}`,',
	'      level: failed ? "error" : "success",',
	'      icon: host.program?.icon || undefined,',
	'      action: { name: "pane.focus", args: { terminal: host.address } },',
	'    });',
	'    playSound(failed ? "blocked" : "done");',
	'  }',
].join('\n');

source = source.replaceAll('mod: "agents"', 'mod: "agents-records"');

const tried = [
	[
		'status/tree helper',
		/const RANK = \{[\s\S]*?const kidStatus = \(k, listed\) => \{[\s\S]*?\r?\n\};/,
		withEol(statusBlock),
	],
	[
		'tree kids',
		/    const kids = all\.filter\(\(k\) => k\.parent === addr && k\.state === "live"\);/,
		withEol(treeKids),
	],
	[
		'sub-agent row',
		/  subRow\(t, s, shown, compact\) \{[\s\S]*?\r?\n  \}\r?\n/,
		`${withEol(subRow)}${eol}`,
	],
	[
		'record popup',
		/  render\(cx\) \{/,
		`${withEol(recordPopup)}${eol}${eol}  render(cx) {`,
	],
	[
		'popup render hook',
		/    if \(props\(\)\?\.sortMenu\) return this\.sortMenu\(t\);/,
		`    if (props()?.sortMenu) return this.sortMenu(t);${eol}    if (props()?.record) return this.recordPopup(t);`,
	],
	[
		'attention imports',
		/openOverlay, closeOverlay, props/,
		'openOverlay, closeOverlay, notify, playSound, props',
	],
	[
		'attention state',
		/    this\.migratingPins = new Set\(\);/,
		`    this.migratingPins = new Set();${eol}    this.recordStates = new Map();${eol}    this.recordsReady = false;`,
	],
	[
		'attention methods',
		/  render\(cx\) \{/,
		`${withEol(attentionMethods)}${eol}${eol}  render(cx) {`,
	],
	[
		'attention render hook',
		/    const all = terminals\(\);/,
		`    const all = terminals();${eol}    this.alertRecords(all);`,
	],
];

for (const [label, pattern, replacement] of tried) {
	const next = source.replace(pattern, replacement);
	if (next === source) {
		console.error(`could not patch ${label} in ${file}; the agents mod layout changed`);
		process.exit(1);
	}
	source = next;
}

writeFileSync(file, source);
console.log(`patched: ${file}`);
