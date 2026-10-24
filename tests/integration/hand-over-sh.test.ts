import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const hasBuilder = existsSync(join(repo, 'tools', 'build-all-code.sh'));
const SLOW = { timeout: 180_000 };

/** Prefer Git Bash on Windows (a bare `bash` may be WSL, which resolves paths differently). */
function findBash(): string | undefined {
  const candidates = [
    process.env.GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'bash',
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['-c', 'echo $BASH_VERSION && command -v awk sha256sum base64 cmp comm'], {
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout.trim().split('\n').length >= 6) return candidate;
  }
  return undefined;
}

const bash = findBash();
const sandboxes: string[] = [];
const tmp = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `wsm-${label}-`));
  sandboxes.push(dir);
  return dir;
};
afterAll(() => sandboxes.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sh(cwd: string, script: string, args: string[] = []) {
  const r = spawnSync(bash as string, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

const bytes = (c: string | Buffer) => (Buffer.isBuffer(c) ? c : Buffer.from(c));

function put(root: string, rel: string, content: string | Buffer) {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
const read = (root: string, rel: string) => readFileSync(join(root, ...rel.split('/')));
const has = (root: string, rel: string) => existsSync(join(root, ...rel.split('/')));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const RECREATE = readFileSync(join(repo, 'recreate-app.sh'));

/** Writes a hand-over text file in the documented format (what build-all-code.sh produces), with checksums. */
function handOver(opts: {
  plain?: Record<string, string>;
  removed?: string[];
  binary?: Record<string, Buffer>;
  checksums?: boolean;
}): string {
  const plain = opts.plain ?? {};
  const binary = opts.binary ?? {};
  let out = '# test hand-over\n\n';
  for (const [path, content] of Object.entries(plain)) out += `/${path}\n${content}\n`;
  if (opts.removed?.length) out += `/_REMOVED.txt\n${opts.removed.map((r) => `/${r}`).join('\n')}\n\n`;
  const names = Object.keys(binary);
  if (names.length) {
    out += '@@BINARY-SECTION\n';
    for (const n of names)
      out += `@@FILE /${n}\n${bytes(binary[n] as Buffer)
        .toString('base64')
        .replace(/(.{76})/g, '$1\n')}\n@@END\n`;
  }
  if (opts.checksums !== false) {
    out += '@@CHECKSUMS\n';
    for (const [p, c] of Object.entries(plain)) out += `${sha(Buffer.from(c))}  /${p}\n`;
    for (const [p, b] of Object.entries(binary)) out += `${sha(b)}  /${p}\n`;
  }
  return out;
}

let dir: string;
beforeEach(() => {
  dir = tmp('app');
  put(dir, 'recreate-app.sh', RECREATE);
});

const apply = (text: string, args: string[] = ['-f'], name = 'hand.txt') => {
  writeFileSync(join(dir, name), text);
  return sh(dir, 'recreate-app.sh', [...args, name]);
};

describe('the shipped recreate script', () => {
  it('uses LF line endings only (CRLF would break bash)', () => {
    expect(RECREATE.includes(13)).toBe(false);
    if (hasBuilder) expect(readFileSync(join(repo, 'tools', 'build-all-code.sh')).includes(13)).toBe(false);
    expect(readFileSync(join(repo, '.gitattributes'), 'utf8')).toContain('*.sh text eol=lf');
  });
});

describe.skipIf(!bash)('recreate-app.sh', SLOW, () => {
  const PLAIN = {
    'src/a.ts': "export const a = 'é — 日本語 🚀';\n",
    'src/deep/er/b.ts': 'line1\n\n\nline4 after two blank lines\n',
    'package.json': '{ "name": "demo" }\n',
    'docs/empty.md': '',
  };
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe, 0x80]);

  it('writes plain and base64 files exactly, creating folders, and verifies checksums', () => {
    const r = apply(
      handOver({
        plain: PLAIN,
        binary: { 'img/logo.png': PNG, 'with space/crlf file.yaml': Buffer.from('a: 1\r\nb: 2') },
      }),
    );
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain('6 written (6 new, 0 overwritten)');
    for (const [p, c] of Object.entries(PLAIN)) expect(read(dir, p).equals(bytes(c)), p).toBe(true);
    expect(read(dir, 'img/logo.png').equals(PNG)).toBe(true);
    expect(read(dir, 'with space/crlf file.yaml').toString()).toBe('a: 1\r\nb: 2');
  });

  it('keeps existing files that differ unless -f is given, and leaves identical ones alone', () => {
    apply(handOver({ plain: PLAIN }));
    put(dir, 'package.json', '{ "name": "edited by hand" }\n');

    const safe = apply(handOver({ plain: PLAIN }), []);
    expect(safe.code).toBe(0);
    expect(safe.out).toContain('skipped (exists and differs): package.json');
    expect(safe.out).toContain('3 already identical, 1 skipped');
    expect(read(dir, 'package.json').toString()).toContain('edited by hand');

    const forced = apply(handOver({ plain: PLAIN }));
    expect(forced.out).toContain('1 written (0 new, 1 overwritten)');
    expect(read(dir, 'package.json').toString()).toBe('{ "name": "demo" }\n');
  });

  it('--dry-run writes nothing; --list lists', () => {
    const text = handOver({ plain: PLAIN, removed: ['old.ts'] });
    const dry = apply(text, ['-n', '-f']);
    expect(dry.out).toContain('Dry run: 4 written');
    expect(has(dir, 'src/a.ts')).toBe(false);
    const list = apply(text, ['-l']);
    expect(list.out).toContain('src/deep/er/b.ts');
    expect(list.out).toContain('4 file(s), 1 to remove');
    expect(has(dir, 'src/a.ts')).toBe(false);
  });

  it('refuses a damaged file and writes nothing: tampered, truncated, or without checksums', () => {
    const good = handOver({ plain: PLAIN });
    const tampered = apply(good.replace('"demo"', '"DEMO"'));
    expect(tampered.code).toBe(1);
    expect(tampered.err).toMatch(/checksum mismatch for \/package\.json/);

    const truncated = apply(good.slice(0, good.indexOf('@@CHECKSUMS') - 20));
    expect(truncated.code).toBe(1);
    expect(truncated.err).toContain('no @@CHECKSUMS section');

    const handwritten = apply(handOver({ plain: PLAIN, checksums: false }));
    expect(handwritten.code).toBe(1);

    expect(has(dir, 'src/a.ts')).toBe(false);
    expect(has(dir, 'package.json')).toBe(false);
  });

  it('--no-verify applies a hand-edited file anyway', () => {
    const edited = apply(handOver({ plain: PLAIN }).replace('"demo"', '"DEMO"'), ['-f', '--no-verify']);
    expect(edited.code, edited.all).toBe(0);
    expect(edited.err).toContain('did not match their checksum');
    expect(read(dir, 'package.json').toString()).toBe('{ "name": "DEMO" }\n');
  });

  it('detects a file added to the text without a checksum', () => {
    const extra = handOver({ plain: { ...PLAIN } }).replace(
      '/package.json\n',
      '/sneaky.ts\nevil();\n\n/package.json\n',
    );
    const r = apply(extra);
    expect(r.code).toBe(1);
    expect(r.err).toContain('sneaky.ts');
    expect(has(dir, 'sneaky.ts')).toBe(false);
  });

  it('is immune to line-ending changes of the text file (editor, e-mail, git autocrlf)', () => {
    const text = handOver({ plain: PLAIN, binary: { 'img/logo.png': PNG } });
    for (const converted of [text.replace(/\n/g, '\r\n'), text.replace(/(?<!\r)\n/g, '\r\n')]) {
      const target = tmp('conv');
      writeFileSync(join(dir, 'conv.txt'), converted);
      const r = sh(dir, 'recreate-app.sh', ['-f', 'conv.txt', target]);
      expect(r.code, r.all).toBe(0);
      for (const [p, c] of Object.entries(PLAIN)) expect(read(target, p).equals(bytes(c)), p).toBe(true);
      expect(read(target, 'img/logo.png').equals(PNG)).toBe(true);
    }
  });

  it('rejects paths that could escape the folder', () => {
    const out = join(dir, 'out');
    for (const bad of ['../escape.bin', '//abs.bin', 'a/../../b.bin', 'a\\b.bin']) {
      const text = `@@BINARY-SECTION\n@@FILE ${bad.startsWith('/') ? '' : '/'}${bad}\naGk=\n@@END\n@@CHECKSUMS\n`;
      writeFileSync(join(dir, 'evil.txt'), text);
      const r = sh(dir, 'recreate-app.sh', ['-f', 'evil.txt', out]);
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toMatch(/unsafe path/);
    }
    // a path line that tries to climb out is never treated as a file at all
    const sneaky = apply('# x\n\n/a.ts\nok();\n\n/../escape.ts\nbad();\n\n/b/../../c.ts\nbad();\n', [
      '-f',
      '--no-verify',
    ]);
    expect(sneaky.code, sneaky.all).toBe(0);
    expect(has(dir, 'a.ts')).toBe(true);
    expect(existsSync(join(dir, '..', 'escape.ts'))).toBe(false);
    expect(existsSync(join(dir, '..', 'c.ts'))).toBe(false);
    expect(read(dir, 'a.ts').toString()).toContain('/../escape.ts'); // it is just text inside a.ts
  });

  it('lists removed files, and deletes only existing ones inside the folder with --prune', () => {
    put(dir, 'old/gone.ts', 'x');
    put(dir, 'keep.ts', 'y');
    const text = handOver({ plain: { 'new.ts': 'n();\n' }, removed: ['old/gone.ts', 'never-existed.ts'] });

    const noPrune = apply(text);
    expect(noPrune.out).toContain('delete    old/gone.ts');
    expect(noPrune.out).toContain('--prune');
    expect(has(dir, 'old/gone.ts')).toBe(true);

    const prune = apply(text, ['-f', '--prune']);
    expect(prune.out).toContain('deleted   old/gone.ts');
    expect(prune.out).not.toContain('never-existed');
    expect(has(dir, 'old/gone.ts')).toBe(false);
    expect(has(dir, 'keep.ts')).toBe(true);
  });

  it('never replaces the running script: a newer version is saved as recreate-app.sh.new', () => {
    const newer = `${RECREATE.toString()}\n# newer version\n`;
    const r = apply(handOver({ plain: { 'recreate-app.sh': newer, 'src/x.ts': 'x();\n' } }));
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain('recreate-app.sh.new');
    expect(read(dir, 'recreate-app.sh').equals(RECREATE)).toBe(true);
    expect(read(dir, 'recreate-app.sh.new').toString()).toBe(newer);
    expect(has(dir, 'src/x.ts')).toBe(true);
  });

  it('says what to run next, only when relevant', () => {
    const code = apply(
      handOver({
        plain: { 'package.json': '{}\n', 'src/index.ts': 'run();\n', 'tests/a.test.ts': 't();\n' },
      }),
    );
    expect(code.out).toMatch(
      /Next:[\s\S]*npm install[\s\S]*npm run build[\s\S]*npm test[\s\S]*restart the app/,
    );
    const docs = apply(handOver({ plain: { 'docs/NOTES.md': 'hello\n' } }), ['-f'], 'docs.txt');
    expect(docs.out).not.toContain('Next:');
  });

  it('reports usage problems clearly', () => {
    expect(sh(dir, 'recreate-app.sh', ['-f', 'missing.txt']).code).toBe(1);
    expect(sh(dir, 'recreate-app.sh', ['--bogus']).err).toContain('unknown option');
    const help = sh(dir, 'recreate-app.sh', ['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('recreate-app.sh -f');
  });

  it('defaults to ./all-app-code.txt', () => {
    writeFileSync(join(dir, 'all-app-code.txt'), handOver({ plain: PLAIN }));
    const r = sh(dir, 'recreate-app.sh', ['-f']);
    expect(r.code, r.all).toBe(0);
    expect(has(dir, 'src/a.ts')).toBe(true);
  });
});

describe.skipIf(!bash || !hasBuilder)('tools/build-all-code.sh → recreate-app.sh', SLOW, () => {
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe, 0x80, 10, 13,
  ]);
  const APP: Record<string, string | Buffer> = {
    'package.json': '{ "name": "demo" }\n',
    'README.md': '# demo\n',
    '.gitignore': 'node_modules\n',
    'src/a.ts': "export const a = 'é — 日本語 🚀';\n",
    'src/blank-inside.ts': 'a();\n\n\nb();\n',
    'src/crlf.yaml': 'a: 1\r\nb: 2\r\n',
    'src/no-newline.txt': 'abc',
    'src/ends-blank.txt': 'text\n\n',
    'src/empty.txt': '',
    'src/with space/file name.txt': 'spaces in the path\n',
    'src/lookalike.md': '# notes\n\n/docs/guide.md\n@@END\n@@CHECKSUMS\nx\n',
    'src/logo.bin': PNG,
    'tests/x.test.ts': "it('x', () => {});\n",
  };
  const ALL = [...Object.keys(APP), 'recreate-app.sh'].sort();

  let proj: string;
  beforeEach(() => {
    proj = tmp('proj');
    put(proj, 'recreate-app.sh', RECREATE);
    put(proj, 'tools/build-all-code.sh', readFileSync(join(repo, 'tools', 'build-all-code.sh')));
    for (const [p, c] of Object.entries(APP)) put(proj, p, c);
    put(proj, '.env', 'SECRET=hunter2\n');
    put(proj, 'node_modules/dep/index.js', 'module.exports = 1');
    put(proj, 'dist/out.js', 'built');
    put(proj, 'legacy/old.ts', 'old');
    put(proj, 'coverage/lcov.info', 'x');
  });

  const build = (args: string[] = []) => sh(proj, 'tools/build-all-code.sh', args);
  const listed = (file = 'all-app-code.txt') =>
    sh(proj, 'recreate-app.sh', ['-l', file])
      .out.split('\n')
      .filter((l) => l && !l.includes('file(s)'))
      .map((l) => l.replace(/^\//, ''))
      .sort();
  const sameAsProject = (copy: string, files = ALL) => {
    for (const p of files) {
      expect(has(copy, p), p).toBe(true);
      expect(read(copy, p).equals(read(proj, p)), p).toBe(true);
    }
  };

  it('the first hand-over is the ENTIRE app and recreates every file exactly', () => {
    const r = build();
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain(`Entire app: ${ALL.length} file(s)`);
    expect(listed()).toEqual(ALL);

    const copy = tmp('copy');
    writeFileSync(join(copy, 'all-app-code.txt'), readFileSync(join(proj, 'all-app-code.txt')));
    put(copy, 'recreate-app.sh', RECREATE);
    const rc = sh(copy, 'recreate-app.sh', ['-f']);
    expect(rc.code, rc.all).toBe(0);
    for (const [p, c] of Object.entries(APP)) expect(read(copy, p).equals(bytes(c)), p).toBe(true);
    for (const absent of ['.env', 'node_modules', 'dist', 'legacy', 'coverage', 'tools', '.handover-state']) {
      expect(has(copy, absent), absent).toBe(false);
    }
  });

  it('shows ordinary files as readable plain text and stores the exceptions as base64', () => {
    const r = build();
    const text = readFileSync(join(proj, 'all-app-code.txt'), 'utf8');
    expect(text).toContain("/src/a.ts\nexport const a = 'é — 日本語 🚀';\n");
    expect(text).toMatch(/\n@@BINARY-SECTION\n/);
    expect(text).toMatch(/\n@@CHECKSUMS\n/);
    expect(text).not.toContain('hunter2');
    for (const odd of [
      'src/crlf.yaml',
      'src/no-newline.txt',
      'src/ends-blank.txt',
      'src/with space/file name.txt',
      'src/lookalike.md',
      'src/logo.bin',
    ]) {
      expect(r.out, odd).toContain(`  ${odd}`);
      expect(text, odd).toContain(`@@FILE /${odd}\n`);
    }
    for (const plain of ['src/a.ts', 'src/blank-inside.ts', 'package.json', 'README.md', 'src/empty.txt']) {
      expect(text, plain).toContain(`\n/${plain}\n`);
      expect(text, plain).not.toContain(`@@FILE /${plain}\n`);
    }
  });

  it('records what was handed over, and says so when nothing changed', () => {
    build();
    expect(existsSync(join(proj, '.handover-state'))).toBe(true);
    const before = readFileSync(join(proj, 'all-app-code.txt'));
    const again = build();
    expect(again.code).toBe(0);
    expect(again.out).toContain('Nothing changed since the last hand-over');
    expect(readFileSync(join(proj, 'all-app-code.txt')).equals(before)).toBe(true);
  });

  it('later hand-overs hold ONLY new and changed files plus the removal list', () => {
    build();
    const copy = tmp('copy');
    sh(proj, 'recreate-app.sh', ['-f', 'all-app-code.txt', copy]);

    put(proj, 'src/a.ts', "export const a = 'changed';\n");
    put(proj, 'src/new.ts', 'export const n = 1;\n');
    put(proj, 'src/new-crlf.yaml', 'k: v\r\n');
    rmSync(join(proj, 'src', 'empty.txt'));
    rmSync(join(proj, 'tests', 'x.test.ts'));

    const r = build();
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain('Updated files only: 3 new or changed, 2 removed');
    expect(listed()).toEqual(['src/a.ts', 'src/new-crlf.yaml', 'src/new.ts']);
    expect(readFileSync(join(proj, 'all-app-code.txt'), 'utf8')).toContain(
      '/_REMOVED.txt\n/src/empty.txt\n/tests/x.test.ts\n',
    );

    const apply1 = sh(copy, 'recreate-app.sh', ['-f', join(proj, 'all-app-code.txt')]);
    expect(apply1.code, apply1.all).toBe(0);
    expect(apply1.out).toContain('3 written (2 new, 1 overwritten)');
    expect(apply1.out).toContain('delete    src/empty.txt');
    expect(has(copy, 'src/empty.txt')).toBe(true); // not deleted without --prune

    const apply2 = sh(copy, 'recreate-app.sh', ['-f', '--prune', join(proj, 'all-app-code.txt')]);
    expect(apply2.out).toContain('deleted   src/empty.txt');
    expect(has(copy, 'src/empty.txt')).toBe(false);
    expect(has(copy, 'tests/x.test.ts')).toBe(false);
    sameAsProject(copy, listedAll());
  });

  const listedAll = () =>
    sh(proj, 'tools/build-all-code.sh', ['--full', '--list', '--keep-state'])
      .out.split('\n')
      .filter((l) => l.startsWith('  '))
      .map((l) => l.trim());

  it('--full gives the entire app again, --list and --keep-state record nothing, --redo repeats the previous one', () => {
    build();
    put(proj, 'src/one.ts', 'one();\n');
    expect(build().out).toContain('Updated files only: 1 new or changed');
    put(proj, 'src/two.ts', 'two();\n');

    const state = readFileSync(join(proj, '.handover-state'));
    const peek = build(['--list']);
    expect(peek.out).toContain('1 file(s) to include');
    expect(readFileSync(join(proj, '.handover-state')).equals(state)).toBe(true);

    const kept = build(['--keep-state']);
    expect(kept.out).toContain('(not recorded as handed over)');
    expect(readFileSync(join(proj, '.handover-state')).equals(state)).toBe(true);
    expect(listed()).toEqual(['src/two.ts']);

    const redo = build(['--redo']);
    expect(redo.out).toContain('Updated files only: 2 new or changed'); // one.ts (never confirmed as received) + two.ts
    expect(listed()).toEqual(['src/one.ts', 'src/two.ts']);

    const full = build(['--full']);
    expect(full.out).toContain('Entire app:');
    expect(listed().length).toBe(ALL.length + 2);
  });

  it('refuses to pack a private key and never packs secrets', () => {
    put(proj, 'certs/dev.pem', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    expect(build().code).toBe(0);
    expect(listed()).toContain('certs/dev.pem');

    // built from pieces so that THIS file does not itself contain a private-key marker
    const key = ['-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIE\n-----END RSA ', 'PRIVATE KEY-----\n'].join('');
    put(proj, 'certs/server.pem', key);
    const r = build(['--full']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('private key');
    expect(readFileSync(join(proj, 'all-app-code.txt'), 'utf8')).not.toContain('MIIE');
  });

  it('a built hand-over survives a line-ending conversion of the text file', () => {
    build();
    const text = readFileSync(join(proj, 'all-app-code.txt'), 'utf8');
    for (const converted of [text.replace(/\n/g, '\r\n'), text.replace(/(?<!\r)\n/g, '\r\n')]) {
      const copy = tmp('conv');
      writeFileSync(join(proj, 'conv.txt'), converted);
      const r = sh(proj, 'recreate-app.sh', ['-f', 'conv.txt', copy]);
      expect(r.code, r.all).toBe(0);
      sameAsProject(copy);
    }
  });

  it('builds quietly: nothing on stderr for a normal build', () => {
    const r = build();
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});
