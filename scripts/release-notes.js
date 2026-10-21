#!/usr/bin/env node
/**
 * Print the changelog section for one version, for use as GitHub Release body.
 *
 *   node scripts/release-notes.js 1.3.0
 *
 * The changelog uses Keep a Changelog headings: `## [1.3.0] - 2026-10-21`.
 * Exits 1 when the version has no section, so a release cannot ship without notes.
 */

const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/release-notes.js <version>');
  process.exit(2);
}

const changelogPath = path.join(__dirname, '..', 'changelog.md');
const text = fs.readFileSync(changelogPath, 'utf-8').replace(/\r\n/g, '\n');
const escaped = version.replace(/\./g, '\\.');
const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?[^\\n]*$`, 'm');
const match = heading.exec(text);

if (!match) {
  console.error(`No changelog section found for ${version} in changelog.md`);
  process.exit(1);
}

const start = match.index + match[0].length;
const rest = text.slice(start);
const nextHeading = rest.search(/^##\s+/m);
const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading))
  .replace(/^\s*\[[^\]]+\]:\s+\S+\s*$/gm, '')
  .trim();

if (!body) {
  console.error(`Changelog section for ${version} is empty`);
  process.exit(1);
}

process.stdout.write(body + '\n');