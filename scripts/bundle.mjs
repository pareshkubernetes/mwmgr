#!/usr/bin/env node
// Collect the project's files into ONE text file that scripts/restore.mjs can turn back into the same files.
//
//   node scripts/bundle.mjs                   files added or modified since the last git commit (default)
//   node scripts/bundle.mjs --all             every project file (still skips node_modules, dist, .env, ...)
//   node scripts/bundle.mjs --out my.txt      choose the output file (default: workspace-mgr.bundle.txt)
//   node scripts/bundle.mjs --root <dir>      bundle another directory (default: the project root)
//   node scripts/bundle.mjs --note "text"     free-text note stored in the bundle header
//   node scripts/bundle.mjs --list            print what would be bundled and exit

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createBundle, isExcluded } from './lib/bundle-format.mjs';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function parseArgs(argv) {
  const args = { all: false, list: false, root: undefined, out: undefined, note: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--changed') args.all = false;
    else if (a === '--list') args.list = true;
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--note') args.note = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const toPosix = (p) => p.split(path.sep).join('/');

function walk(root, dir = root, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = toPosix(path.relative(root, full));
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) walk(root, full, found);
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

/** Files git sees as added, modified, renamed or untracked (not deleted, not ignored). */
function changedFiles(root) {
  // `--relative` / `ls-files` give paths relative to `root` even when the git repository starts above it.
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean);
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return undefined; // not a git repository (or git missing)
  }

  let tracked;
  try {
    // staged + unstaged changes against the last commit, deletions excluded
    tracked = git(['diff', '--name-only', '--relative', '--diff-filter=d', '-z', 'HEAD']);
  } catch {
    tracked = git(['ls-files', '--cached', '-z']); // repository without a first commit yet
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...tracked, ...untracked];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 11)
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n') + '\n',
    );
    return;
  }

  const root = path.resolve(args.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const out = path.resolve(args.out ?? path.join(root, 'workspace-mgr.bundle.txt'));

  let mode = args.all ? 'all' : 'changed';
  let candidates;
  if (mode === 'changed') {
    candidates = changedFiles(root);
    if (candidates === undefined) {
      process.stderr.write('Not a git repository: falling back to --all\n');
      mode = 'all';
    }
  }
  if (mode === 'all') candidates = walk(root);

  const files = [];
  for (const rel of [...new Set(candidates)].sort()) {
    if (isExcluded(rel)) continue;
    const full = path.join(root, rel);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    if (statSync(full).size > MAX_FILE_BYTES) {
      process.stderr.write(`Skipping ${rel}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB\n`);
      continue;
    }
    // Never bundle the output file into itself
    if (path.resolve(full) === out) continue;
    files.push({ path: rel, content: readFileSync(full) });
  }

  if (args.list) {
    for (const f of files) process.stdout.write(`${f.path}\n`);
    process.stdout.write(`\n${files.length} file(s), mode: ${mode}\n`);
    return;
  }
  if (files.length === 0) {
    process.stderr.write('Nothing to bundle (no changed files). Use --all to bundle everything.\n');
    process.exitCode = 1;
    return;
  }

  const note = args.note ?? `mode=${mode}`;
  writeFileSync(out, createBundle(files, { note }), 'utf8');
  const bytes = files.reduce((sum, f) => sum + f.content.length, 0);
  process.stdout.write(
    `Bundled ${files.length} file(s) (${(bytes / 1024).toFixed(1)} KiB, mode: ${mode})\n→ ${out}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`bundle: ${error.message}\n`);
  process.exitCode = 1;
}
