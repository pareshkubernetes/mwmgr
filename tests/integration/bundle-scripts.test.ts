import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));
const bundleJs = join(scripts, 'bundle.mjs');
const restoreJs = join(scripts, 'restore.mjs');

const sandboxes: string[] = [];
const tmp = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `wsm-${label}-`));
  sandboxes.push(dir);
  return dir;
};
afterAll(() => sandboxes.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(script: string, args: string[], cwd?: string) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function write(root: string, rel: string, content: string | Buffer) {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const read = (root: string, rel: string) => readFileSync(join(root, ...rel.split('/')));

let src: string;
beforeEach(() => {
  src = tmp('src');
  write(src, 'package.json', '{ "name": "demo" }\n');
  write(src, 'src/index.ts', "console.log('hi');\r\n");
  write(src, 'src/deep/er/file.txt', 'no newline');
  write(src, 'assets/logo.bin', Buffer.from([0, 1, 2, 255, 254, 0, 128]));
  write(src, '.env', 'SECRET=hunter2\n');
  write(src, '.env.example', 'SECRET=\n');
  write(src, 'node_modules/dep/index.js', 'module.exports = 1');
  write(src, 'dist/out.js', 'built');
});

describe('bundle.mjs --all → restore.mjs', () => {
  it('recreates the project exactly, and leaves secrets and dependencies behind', () => {
    const bundle = join(tmp('out'), 'b.txt');
    const made = run(bundleJs, ['--root', src, '--all', '--out', bundle]);
    expect(made.code).toBe(0);
    expect(made.out).toContain('Bundled 5 file(s)');

    const text = readFileSync(bundle, 'utf8');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('node_modules');

    const dest = tmp('dest');
    const restored = run(restoreJs, [bundle, '--out', dest]);
    expect(restored.code).toBe(0);
    expect(restored.out).toContain('5 created');

    for (const rel of [
      'package.json',
      'src/index.ts',
      'src/deep/er/file.txt',
      'assets/logo.bin',
      '.env.example',
    ]) {
      expect(read(dest, rel).equals(read(src, rel)), rel).toBe(true);
    }
    expect(existsSync(join(dest, '.env'))).toBe(false);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(dest, 'dist'))).toBe(false);
  });

  it('never includes its own output file', () => {
    const bundle = join(src, 'workspace-mgr.bundle.txt');
    run(bundleJs, ['--root', src, '--all', '--out', bundle]);
    run(bundleJs, ['--root', src, '--all', '--out', bundle]); // second run sees the first output
    expect(run(restoreJs, [bundle, '--list']).out).not.toContain('bundle.txt');
  });

  it('--list on restore shows contents without writing', () => {
    const bundle = join(tmp('out'), 'b.txt');
    run(bundleJs, ['--root', src, '--all', '--out', bundle, '--note', 'for review']);
    const dest = tmp('dest');
    const listed = run(restoreJs, [bundle, '--list', '--out', dest]);
    expect(listed.out).toContain('src/index.ts');
    expect(listed.out).toContain('for review');
    expect(existsSync(join(dest, 'package.json'))).toBe(false);
  });
});

describe('restore.mjs safety', () => {
  const setup = () => {
    const bundle = join(tmp('out'), 'b.txt');
    run(bundleJs, ['--root', src, '--all', '--out', bundle]);
    const dest = tmp('dest');
    run(restoreJs, [bundle, '--out', dest]);
    return { bundle, dest };
  };

  it('is idempotent: a second restore changes nothing', () => {
    const { bundle, dest } = setup();
    const again = run(restoreJs, [bundle, '--out', dest]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('0 created');
    expect(again.out).toContain('5 unchanged');
  });

  it('does not overwrite a modified file unless --force is given', () => {
    const { bundle, dest } = setup();
    write(dest, 'package.json', '{ "name": "edited by hand" }\n');

    const safe = run(restoreJs, [bundle, '--out', dest]);
    expect(safe.code).toBe(2);
    expect(safe.out).toContain('use --force');
    expect(read(dest, 'package.json').toString()).toContain('edited by hand');

    const forced = run(restoreJs, [bundle, '--out', dest, '--force']);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('1 overwritten');
    expect(read(dest, 'package.json').equals(read(src, 'package.json'))).toBe(true);
  });

  it('--dry-run writes nothing', () => {
    const bundle = join(tmp('out'), 'b.txt');
    run(bundleJs, ['--root', src, '--all', '--out', bundle]);
    const dest = tmp('dest');
    const dry = run(restoreJs, [bundle, '--out', dest, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('would be created');
    expect(existsSync(join(dest, 'package.json'))).toBe(false);
  });

  it('refuses a corrupted bundle before writing anything', () => {
    const bundle = join(tmp('out'), 'b.txt');
    run(bundleJs, ['--root', src, '--all', '--out', bundle]);
    writeFileSync(bundle, readFileSync(bundle, 'utf8').replace('"name": "demo"', '"name": "DEMO!"'));
    const dest = tmp('dest');
    const r = run(restoreJs, [bundle, '--out', dest]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/mismatch/);
    expect(existsSync(join(dest, 'src'))).toBe(false);
  });

  it('rejects a bundle that tries to write outside the target', () => {
    const boundary = 'd'.repeat(24);
    const crafted = `WORKSPACE-MGR-BUNDLE v1\ngenerated: now\nboundary: ${boundary}\nfiles: 1\n\n@@@ FILE ${boundary} {"path":"../escape.txt","enc":"utf8","bytes":1,"sha256":"2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"} @@@\nx\n@@@ END ${boundary} @@@\n`;
    const bundle = join(tmp('out'), 'evil.txt');
    writeFileSync(bundle, crafted);
    const dest = tmp('dest');
    const r = run(restoreJs, [bundle, '--out', dest]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Unsafe path/);
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false);
  });

  it('prints usage without arguments and reports unknown flags', () => {
    expect(run(restoreJs, []).code).toBe(1);
    expect(run(restoreJs, ['--help']).code).toBe(0);
    expect(run(restoreJs, ['x', '--bogus']).err).toMatch(/Unknown argument/);
    expect(run(restoreJs, ['/definitely/missing.txt']).code).toBe(1);
    expect(run(bundleJs, ['--bogus']).err).toMatch(/Unknown argument/);
    expect(run(bundleJs, ['--help']).code).toBe(0);
  });
});

describe('bundle.mjs default mode: only files changed since the last commit', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], {
      cwd,
      encoding: 'utf8',
    });

  it('bundles modified, added and renamed files; skips unchanged, deleted and ignored ones', () => {
    // The git repository starts ABOVE the project folder, as in the real workspace.
    const repo = tmp('repo');
    const proj = join(repo, 'code', 'proj');
    mkdirSync(proj, { recursive: true });
    write(proj, '.gitignore', 'ignored.txt\n');
    write(proj, 'keep.txt', 'unchanged\n');
    write(proj, 'edit.txt', 'v1\n');
    write(proj, 'delete.txt', 'bye\n');
    write(proj, 'rename-me.txt', 'same content\n');
    write(repo, 'outside.txt', 'not part of the project\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    write(proj, 'edit.txt', 'v2\n');
    write(proj, 'new.txt', 'brand new\n');
    write(proj, 'ignored.txt', 'ignored\n');
    write(proj, '.env', 'SECRET=1\n');
    write(repo, 'outside.txt', 'changed outside the project\n');
    rmSync(join(proj, 'delete.txt'));
    git(proj, 'mv', 'rename-me.txt', 'renamed.txt');

    const bundle = join(tmp('out'), 'b.txt');
    const made = run(bundleJs, ['--root', proj, '--out', bundle]);
    expect(made.code).toBe(0);

    const listed = run(restoreJs, [bundle, '--list']).out;
    const paths = listed
      .split('\n')
      .filter((l) => l.includes(' bytes,'))
      .map((l) => l.split('  (')[0])
      .sort();
    expect(paths).toEqual(['edit.txt', 'new.txt', 'renamed.txt']);
  });

  it('falls back to --all outside a git repository', () => {
    const bundle = join(tmp('out'), 'b.txt');
    const r = run(bundleJs, ['--root', src, '--out', bundle]);
    expect(r.code).toBe(0);
    expect(r.err).toContain('falling back to --all');
    expect(r.out).toContain('mode: all');
  });

  it('exits 1 with a hint when nothing changed', () => {
    const repo = tmp('clean');
    write(repo, 'a.txt', 'x\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const r = run(bundleJs, ['--root', repo, '--out', join(tmp('out'), 'b.txt')]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Nothing to bundle');
  });
});
