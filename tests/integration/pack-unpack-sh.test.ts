import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../', import.meta.url));

/** Prefer Git Bash on Windows (a bare `bash` may be WSL, which resolves paths differently). */
function findBash(): string | undefined {
  const candidates = [
    process.env.GIT_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'bash',
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['-c', 'echo $BASH_VERSION && command -v awk sha256sum base64'], {
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout.trim().split('\n').length >= 4) return candidate;
  }
  return undefined;
}

const bash = findBash();
const sandboxes: string[] = [];
afterAll(() => sandboxes.forEach((d) => rmSync(d, { recursive: true, force: true })));

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe, 0x80, 10, 13,
]);

/** Files of the fixture project and the exact bytes they must come back with. */
const FIXTURE: Record<string, string | Buffer> = {
  'package.json': '{ "name": "demo" }\n',
  'README.md': '# demo\n',
  'src/a.ts': "export const a = 'é — 日本語 🚀';\n",
  'src/crlf.ts': 'line1\r\nline2\r\n',
  'src/no-newline.txt': 'abc',
  'src/empty.txt': '',
  'src/blank-lines.txt': '\n\n\ntext\n\n\n',
  'src/with space/file name.txt': 'spaces in paths\n',
  'src/markers.txt': [
    '@@@END@deadbeef',
    '@@@FILE@deadbeef text nl x y',
    '#### token: fake',
    '#### files: 99',
    '',
  ].join('\n'),
  'src/logo.bin': PNG,
  'tests/x.test.ts': "it('x', () => {});\n",
};

function run(cwd: string, script: string, args: string[] = []) {
  const r = spawnSync(bash as string, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function put(root: string, rel: string, content: string | Buffer) {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

let proj: string;
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'wsm-sh-'));
  sandboxes.push(proj);
  put(proj, 'pack.sh', readFileSync(join(repo, 'pack.sh')));
  put(proj, 'unpack.sh', readFileSync(join(repo, 'unpack.sh')));
  for (const [rel, content] of Object.entries(FIXTURE)) put(proj, rel, content);
  put(proj, '.env', 'SECRET=hunter2\n');
  put(proj, 'node_modules/dep/index.js', 'module.exports = 1');
  put(proj, 'dist/out.js', 'built');
  put(proj, 'legacy/old.ts', 'old');
});

const packed = () => {
  const r = run(proj, 'pack.sh');
  expect(r.code, r.err).toBe(0);
  return readFileSync(join(proj, 'all-code-file.txt'));
};

const identical = (dest: string) => {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const full = join(dest, ...rel.split('/'));
    expect(existsSync(full), rel).toBe(true);
    expect(readFileSync(full).equals(Buffer.isBuffer(content) ? content : Buffer.from(content)), rel).toBe(
      true,
    );
  }
};

describe('the shipped scripts', () => {
  it('use LF line endings only (CRLF would break bash)', () => {
    for (const name of ['pack.sh', 'unpack.sh']) {
      expect(readFileSync(join(repo, name)).includes(13), name).toBe(false);
    }
    expect(readFileSync(join(repo, '.gitattributes'), 'utf8')).toContain('*.sh text eol=lf');
  });
});

describe.skipIf(!bash)('pack.sh → all-code-file.txt → unpack.sh', () => {
  it('rebuilds every file exactly: LF, CRLF, no final newline, empty, unicode, spaces, binary', () => {
    packed();
    const r = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`${Object.keys(FIXTURE).length + 2} created`); // + pack.sh and unpack.sh
    identical(join(proj, 'out'));
  });

  it('packs only what is needed to run the app: no secrets, dependencies, build output or legacy code', () => {
    const text = packed().toString('latin1');
    expect(text).not.toContain('hunter2');
    // (the scripts' own source mentions "node_modules", so look at the FILE entries, not the whole text)
    expect(text).not.toMatch(/^@@@FILE@\S+ \S+ \S+ \S+ (node_modules|dist|legacy|\.env)\b/m);
    expect(text).toMatch(/^@@@FILE@\S+ text nl \S+ src\/a\.ts$/m);
    run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    for (const absent of ['.env', 'node_modules', 'dist', 'legacy']) {
      expect(existsSync(join(proj, 'out', absent)), absent).toBe(false);
    }
  });

  it('is idempotent, supports --list and --dry-run, and tolerates a file that is not LF terminated', () => {
    packed();
    run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    const again = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    expect(again.out).toContain('0 created');
    expect(again.out).toContain('13 unchanged');

    const list = run(proj, 'unpack.sh', ['all-code-file.txt', '--list']);
    expect(list.out).toContain('src/with space/file name.txt');
    expect(list.out).toContain('src/logo.bin');

    const dry = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'dry', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('would be created');
    expect(existsSync(join(proj, 'dry'))).toBe(false);
  });

  it('never overwrites a modified file unless --force is given', () => {
    packed();
    run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    put(join(proj, 'out'), 'README.md', 'edited by hand\n');

    const safe = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    expect(safe.code).toBe(2);
    expect(safe.out).toContain('use --force');
    expect(readFileSync(join(proj, 'out', 'README.md'), 'utf8')).toBe('edited by hand\n');

    const forced = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('1 overwritten');
    identical(join(proj, 'out'));
  });

  it('refuses a tampered bundle before writing anything', () => {
    const text = packed().toString('utf8').replace('# demo', '# DEMO');
    writeFileSync(join(proj, 'all-code-file.txt'), text);
    const r = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/checksum mismatch for README\.md/);
    expect(r.err).not.toContain('converted to CRLF');
    expect(existsSync(join(proj, 'out'))).toBe(false);
  });

  it('refuses a truncated bundle', () => {
    const text = packed().toString('utf8');
    writeFileSync(join(proj, 'all-code-file.txt'), text.slice(0, text.length - 60));
    const r = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    expect(r.code).toBe(1);
    expect(existsSync(join(proj, 'out'))).toBe(false);
  });

  it('repairs a bundle whose line endings were all converted to CRLF, but only when provably exact', () => {
    const converted = packed().toString('utf8').replace(/\n/g, '\r\n');
    writeFileSync(join(proj, 'all-code-file.txt'), converted);
    const r = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('converted back');
    identical(join(proj, 'out'));
  });

  it('refuses rather than guess when a converter left the existing CRLF lines alone', () => {
    // "smart" converter: only bare LF becomes CRLF; the CRLF file's lines no longer match their checksum
    const smart = packed().toString('utf8').replace(/\r?\n/g, '\r\n');
    writeFileSync(join(proj, 'all-code-file.txt'), smart);
    const r = run(proj, 'unpack.sh', ['all-code-file.txt', '-o', 'out']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/checksum mismatch/);
    expect(existsSync(join(proj, 'out'))).toBe(false);
  });

  it('rejects paths that could escape the target directory', () => {
    for (const bad of ['../escape.txt', '/abs.txt', 'a/../../b', 'C:/win.txt', "it's.txt", 'a//b']) {
      const token = 'ab'.repeat(12);
      const crafted = `#### WORKSPACE-MGR ALL-CODE-FILE v1\n#### token: ${token}\n#### files: 1\n\n@@@FILE@${token} text nl x ${bad}\nhi\n@@@END@${token}\n`;
      writeFileSync(join(proj, 'evil.txt'), crafted);
      const r = run(proj, 'unpack.sh', ['evil.txt', '-o', 'out']);
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toMatch(/unsafe path/);
    }
    expect(existsSync(join(proj, '..', 'escape.txt'))).toBe(false);
    expect(existsSync(join(proj, 'out'))).toBe(false);
  });

  it('rejects text that is not a bundle, and a missing file', () => {
    writeFileSync(join(proj, 'junk.txt'), 'hello\n');
    expect(run(proj, 'unpack.sh', ['junk.txt', '-o', 'out']).code).toBe(1);
    expect(run(proj, 'unpack.sh', ['missing.txt']).code).toBe(1);
    expect(run(proj, 'unpack.sh', []).code).toBe(1);
    expect(run(proj, 'unpack.sh', ['--help']).code).toBe(0);
    expect(run(proj, 'unpack.sh', ['x', '--bogus']).err).toMatch(/unknown argument/);
  });

  it('pack.sh refuses to pack a private key, but packs public CA certificates', () => {
    put(proj, 'certs/dev.pem', '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    expect(run(proj, 'pack.sh').code).toBe(0);
    expect(run(proj, 'pack.sh', ['--list']).out).toContain('certs/dev.pem');

    // Built from pieces so that THIS file is not itself refused by pack.sh's private-key guard.
    const fakeKey = ['-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIE\n-----END RSA ', 'PRIVATE KEY-----\n'].join(
      '',
    );
    put(proj, 'certs/server.pem', fakeKey);
    const r = run(proj, 'pack.sh');
    expect(r.code).toBe(1);
    expect(r.err).toContain('private key');
  });

  it('pack.sh --list shows exactly the files that would be packed', () => {
    const files = run(proj, 'pack.sh', ['--list']).out.split('\n').filter(Boolean).sort();
    expect(files).toEqual([...Object.keys(FIXTURE), 'pack.sh', 'unpack.sh'].sort());
  });
});
