#!/usr/bin/env node
// Point a cloned Herdr layout's agents block at the patched agents-records mod.
//
// Usage: node scripts/patch-herdr-layout.mjs <path/to/layouts/main-records.json>

import {readFileSync, writeFileSync} from 'node:fs';

const file = process.argv[2];
if (!file) {
	console.error('usage: node scripts/patch-herdr-layout.mjs <path/to/layout.json>');
	process.exit(2);
}

const layout = JSON.parse(readFileSync(file, 'utf8'));
let changed = false;

const walk = (node) => {
	if (Array.isArray(node)) {
		for (const child of node) walk(child);
		return;
	}
	if (!node || typeof node !== 'object') return;
	if (
		node.id === 'agents' &&
		node.content &&
		typeof node.content === 'object' &&
		node.content.mod === 'agents'
	) {
		node.content.mod = 'agents-records';
		changed = true;
	}
	for (const value of Object.values(node)) walk(value);
};

walk(layout);

if (!changed) {
	console.log(`already patched: ${file}`);
	process.exit(0);
}

writeFileSync(file, `${JSON.stringify(layout, null, 2)}\n`);
console.log(`patched: ${file}`);
