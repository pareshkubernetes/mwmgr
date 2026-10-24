#!/usr/bin/env node
// Recreate the files stored in a bundle produced by scripts/bundle.mjs.
//
//   node scripts/restore.mjs workspace-mgr.bundle.txt             restore into the current directory
//   node scripts/restore.mjs bundle.txt --out C:\some\folder      restore into another directory
//   node scripts/restore.mjs bundle.txt --dry-run                 show what would happen, write nothing
//   node scripts/restore.mjs bundle.txt --force                   overwrite existing files that differ
//   node scripts/restore.mjs bundle.txt --list                    list the files in the bundle
//
// Safety: every file is checked (size + SHA-256) before anything is written; paths that could escape the
// target directory are rejected; existing files that differ are NOT overwritten unless you pass --force.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseBundle } from './lib/bundle-format.mjs';

function parseArgs(argv) {
  const args = { input: undefined, out: process.cwd(), force: false, dryRun: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i] ?? '');
    else if (a === '--in') args.input = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--list') args.list = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
    else if (!args.input) args.input = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    process.stdout.write(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 14)
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n') + '\n',
    );
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const { meta, files } = parseBundle(readFileSync(path.resolve(args.input), 'utf8'));

  if (meta.lineEndingsRepaired) {
    process.stderr.write(
      'Note: the bundle had its line endings converted to CRLF (editor/git autocrlf?). ' +
        'They were converted back, and every file still matches its checksum.\n',
    );
  }

  if (args.list) {
    for (const f of files) process.stdout.write(`${f.path}  (${f.content.length} bytes, ${f.enc})\n`);
    process.stdout.write(
      `\n${files.length} file(s), generated ${meta.generated}${meta.note ? `, ${meta.note}` : ''}\n`,
    );
    return;
  }

  const root = path.resolve(args.out);
  const counts = { created: 0, overwritten: 0, unchanged: 0, skipped: 0 };

  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'));
    // Defence in depth on top of the path check in parseBundle
    if (target !== root && !target.startsWith(root + path.sep))
      throw new Error(`Path escapes target: ${file.path}`);

    let action;
    if (!existsSync(target)) action = 'created';
    else if (!statSync(target).isFile()) action = 'skipped';
    else if (readFileSync(target).equals(file.content)) action = 'unchanged';
    else action = args.force ? 'overwritten' : 'skipped';

    if (action === 'created' || action === 'overwritten') {
      if (!args.dryRun) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
    }
    counts[action]++;
    const note = action === 'skipped' ? '  (exists and differs; use --force to overwrite)' : '';
    process.stdout.write(`${(args.dryRun ? 'would be ' : '') + action}`.padEnd(20) + `${file.path}${note}\n`);
  }

  process.stdout.write(
    `\n${args.dryRun ? 'Dry run: ' : ''}${counts.created} created, ${counts.overwritten} overwritten, ` +
      `${counts.unchanged} unchanged, ${counts.skipped} skipped → ${root}\n`,
  );
  if (counts.skipped > 0) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  process.stderr.write(`restore: ${error.message}\n`);
  process.exitCode = 1;
}
