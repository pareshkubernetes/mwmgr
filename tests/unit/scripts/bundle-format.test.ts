import { describe, expect, it } from 'vitest';
import {
  BUNDLE_MAGIC,
  createBundle,
  isExcluded,
  isSafeRelativePath,
  isTextBuffer,
  parseBundle,
  sha256,
} from '../../../scripts/lib/bundle-format.mjs';

const file = (path: string, content: string | Buffer) => ({
  path,
  content: Buffer.isBuffer(content) ? content : Buffer.from(content),
});

const roundTrip = (files: { path: string; content: Buffer }[]) => parseBundle(createBundle(files));

describe('round trip', () => {
  it('restores text files byte for byte', () => {
    const files = [
      file('src/a.ts', 'export const a = 1;\n'),
      file('no-final-newline.txt', 'abc'),
      file('crlf.txt', 'line1\r\nline2\r\n'),
      file('empty.txt', ''),
      file('unicode.md', 'héllo — 日本語 🚀\n'),
      file('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('with bom\n')])),
      file('blank-lines.txt', '\n\n\ntext\n\n\n'),
      file('deep/dir/with space/file.json', '{"a":1}'),
    ];
    const { files: out } = roundTrip(files);
    expect(out.map((f) => f.path)).toEqual(files.map((f) => f.path));
    out.forEach((f, i) => expect(f.content.equals(files[i]!.content)).toBe(true));
  });

  it('stores binary files as base64 and restores them exactly', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe, 0x80]);
    const big = Buffer.alloc(10_000, 0xab);
    const bundle = createBundle([file('logo.png', png), file('blob.bin', big)]);
    expect(bundle).toContain('"enc":"base64"');
    const { files } = parseBundle(bundle);
    expect(files[0]?.content.equals(png)).toBe(true);
    expect(files[1]?.content.equals(big)).toBe(true);
  });

  it('is not confused by file content that looks like bundle markers', () => {
    const evil = [
      '@@@ END deadbeefdeadbeefdeadbeef @@@',
      '@@@ FILE deadbeefdeadbeefdeadbeef {"path":"../../etc/passwd"} @@@',
      BUNDLE_MAGIC,
      'boundary: 00000000000000000000000000',
    ].join('\n');
    const { files } = roundTrip([file('evil.txt', evil), file('after.txt', 'still here')]);
    expect(files).toHaveLength(2);
    expect(files[0]?.content.toString()).toBe(evil);
    expect(files[1]?.path).toBe('after.txt');
  });

  it('records generation time and note', () => {
    const text = createBundle([file('a', 'x')], {
      generatedAt: new Date('2026-01-02T03:04:05Z'),
      note: 'line1\nline2',
    });
    const { meta } = parseBundle(text);
    expect(meta).toMatchObject({ generated: '2026-01-02T03:04:05.000Z', files: 1, note: 'line1 line2' });
  });

  it('handles a bundle with no files', () => {
    expect(roundTrip([]).files).toEqual([]);
  });

  it('repairs a bundle whose LF line endings were all converted to CRLF, exactly', () => {
    const files = [
      file('lf.txt', 'one\ntwo\n'),
      file('crlf.txt', 'one\r\ntwo\r\n'),
      file('none.txt', 'no newline'),
      file('bin.dat', Buffer.from([0, 13, 10, 255])),
    ];
    const converted = createBundle(files).replace(/\n/g, '\r\n'); // naive converter: every LF → CRLF
    const parsed = parseBundle(converted);
    expect(parsed.meta.lineEndingsRepaired).toBe(true);
    parsed.files.forEach((f, i) => expect(f.content.equals(files[i]!.content), f.path).toBe(true));
  });

  it('does not report a repair for an untouched bundle', () => {
    expect(roundTrip([file('a', 'x\n')]).meta.lineEndingsRepaired).toBeUndefined();
  });

  it('refuses rather than guess when the damage cannot be verified', () => {
    // A "smart" converter leaves existing CRLF alone and only fixes bare LF: the CRLF file no longer matches.
    const text = createBundle([file('crlf.txt', 'a\r\nb\r\n')]).replace(/\r?\n/g, '\r\n');
    expect(() => parseBundle(text)).toThrow(/mismatch/);
  });
});

describe('integrity checks', () => {
  const good = createBundle([file('a.txt', 'hello world\n'), file('b.txt', 'second\n')]);

  it('rejects text that is not a bundle', () => {
    expect(() => parseBundle('hello')).toThrow(/Not a workspace-mgr bundle/);
    expect(() => parseBundle('')).toThrow(/Not a workspace-mgr bundle/);
  });

  it('detects tampered content (same length) via checksum', () => {
    expect(() => parseBundle(good.replace('hello world', 'hellO world'))).toThrow(
      /Checksum mismatch for a\.txt/,
    );
  });

  it('detects tampered length', () => {
    expect(() => parseBundle(good.replace('hello world', 'hello'))).toThrow(/Size mismatch for a\.txt/);
  });

  it('detects a truncated bundle', () => {
    expect(() => parseBundle(good.slice(0, good.lastIndexOf('@@@ FILE')))).toThrow(
      /declares 2 files but contains 1/,
    );
    expect(() => parseBundle(good.slice(0, good.length - 40))).toThrow(/Missing end marker for b\.txt/);
  });

  it('detects a missing file count or boundary', () => {
    expect(() => parseBundle(good.replace(/^files: .*$/m, 'files: nope'))).toThrow(/file count/);
    expect(() => parseBundle(good.replace(/^boundary: .*$/m, 'boundary: x'))).toThrow(/boundary/);
  });

  it('rejects unsafe paths even in a hand-crafted bundle', () => {
    for (const bad of ['../outside.txt', '/abs.txt', 'C:/win.txt', 'a/../../b', 'a\\b']) {
      const body = 'x';
      const boundary = 'a'.repeat(24);
      const meta = JSON.stringify({ path: bad, enc: 'utf8', bytes: 1, sha256: sha256(Buffer.from(body)) });
      const text = `${BUNDLE_MAGIC}\ngenerated: now\nboundary: ${boundary}\nfiles: 1\n\n@@@ FILE ${boundary} ${meta} @@@\n${body}\n@@@ END ${boundary} @@@\n`;
      expect(() => parseBundle(text), bad).toThrow(/Unsafe path/);
    }
  });

  it('rejects duplicate paths and unknown encodings', () => {
    const boundary = 'b'.repeat(24);
    const entry = (path: string, enc = 'utf8') =>
      `@@@ FILE ${boundary} ${JSON.stringify({ path, enc, bytes: 1, sha256: sha256(Buffer.from('x')) })} @@@\nx\n@@@ END ${boundary} @@@\n`;
    const head = (n: number) => `${BUNDLE_MAGIC}\ngenerated: now\nboundary: ${boundary}\nfiles: ${n}\n\n`;
    expect(() => parseBundle(head(2) + entry('a') + entry('a'))).toThrow(/Duplicate path/);
    expect(() => parseBundle(head(1) + entry('a', 'rot13'))).toThrow(/Unknown encoding/);
  });

  it('rejects unreadable file headers', () => {
    const boundary = 'c'.repeat(24);
    const text = `${BUNDLE_MAGIC}\ngenerated: now\nboundary: ${boundary}\nfiles: 1\n\n@@@ FILE ${boundary} {not json @@@\nx\n@@@ END ${boundary} @@@\n`;
    expect(() => parseBundle(text)).toThrow(/Unreadable file header/);
    const noEnd = `${BUNDLE_MAGIC}\ngenerated: now\nboundary: ${boundary}\nfiles: 1\n\n@@@ FILE ${boundary} {"path":"a"}`;
    expect(() => parseBundle(noEnd)).toThrow(/Malformed file header/);
  });
});

describe('createBundle guards', () => {
  it('refuses unsafe and duplicate paths', () => {
    expect(() => createBundle([file('../x', 'a')])).toThrow(/unsafe/i);
    expect(() => createBundle([file('a', 'x'), file('a', 'y')])).toThrow(/Duplicate/);
  });
});

describe('helpers', () => {
  it('isSafeRelativePath', () => {
    for (const ok of ['a', 'a/b.txt', 'a/b/c/d.e', '.env.example', 'dir with space/x']) {
      expect(isSafeRelativePath(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      '.',
      '..',
      '../a',
      'a/..',
      'a/../b',
      './a',
      'a//b',
      '/a',
      '\\a',
      'C:\\a',
      'C:a',
      'a\\b',
      'a\0b',
      42,
      null,
    ]) {
      expect(isSafeRelativePath(bad), String(bad)).toBe(false);
    }
  });

  it('isTextBuffer', () => {
    expect(isTextBuffer(Buffer.from('plain'))).toBe(true);
    expect(isTextBuffer(Buffer.from('日本語'))).toBe(true);
    expect(isTextBuffer(Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
    expect(isTextBuffer(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(false);
  });

  it('isExcluded keeps secrets, dependencies and build output out of bundles', () => {
    for (const out of [
      'node_modules/x/index.js',
      'a/node_modules/x',
      'dist/index.js',
      'coverage/lcov.info',
      '.git/config',
      '.env',
      '.env.local',
      '.env.production',
      'workspace-mgr.bundle.txt',
      'other.bundle.txt',
      'npm-debug.log',
      '.DS_Store',
      '.vscode/settings.json',
    ]) {
      expect(isExcluded(out), out).toBe(true);
    }
    for (const kept of [
      'src/index.ts',
      '.env.example',
      'package.json',
      'docs/CHECKLIST.md',
      'legacy/backend/src/t.ts',
      'distillery.ts',
    ]) {
      expect(isExcluded(kept), kept).toBe(false);
    }
  });
});
