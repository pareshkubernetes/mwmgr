import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { Devfile } from '../../../src/domain/types.js';
import {
  applyEditorProfile,
  parseDevfile,
  updateDevfileYaml,
} from '../../../src/factories/devfile-updater.js';
import { BadRequestError } from '../../../src/utils/errors.js';
import { SAMPLE_DEVFILE_YAML } from '../../helpers/sample-devfile.js';

const sample = (): Devfile => parseDevfile(SAMPLE_DEVFILE_YAML);
const byName = (d: Devfile, name: string) => d.components?.find((c) => c.name === name);

describe('parseDevfile', () => {
  it('parses a devfile', () => {
    expect(sample().metadata?.name).toBe('java-maven');
  });
  it.each([
    ['invalid yaml', 'a: [unclosed'],
    ['a list', '- 1\n- 2'],
    ['a scalar', 'hello'],
    ['no components', 'schemaVersion: 2.2.0'],
    ['empty', ''],
  ])('rejects %s', (_label, text) => {
    expect(() => parseDevfile(text)).toThrow(BadRequestError);
  });
});

describe('applyEditorProfile', () => {
  it('leaves the devfile alone for VS Code (but returns a copy)', () => {
    const original = sample();
    const result = applyEditorProfile(original, 'vscode');
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
    result.components?.pop();
    expect(original.components).toHaveLength(4);
  });

  it('never mutates its input', () => {
    const original = sample();
    const snapshot = structuredClone(original);
    applyEditorProfile(original, 'intellij');
    expect(original).toEqual(snapshot);
  });

  describe.each([
    ['intellij', 'che-idea-server', 2222, 'che-idea-server.eclipse.org'],
    ['goland', 'che-goland-server', 3400, 'che-goland-server.eclipse.org'],
  ] as const)('%s', (editor, server, port, partOf) => {
    const result = applyEditorProfile(sample(), editor);
    const tools = byName(result, 'tools');

    it('drops commands and events', () => {
      expect(result.commands).toBeUndefined();
      expect(result.events).toBeUndefined();
    });
    it('exposes the editor server endpoint on the tools container', () => {
      expect(tools?.container?.endpoints).toEqual([
        expect.objectContaining({
          name: server,
          targetPort: port,
          exposure: 'public',
          protocol: 'https',
          secure: true,
        }),
      ]);
      expect(tools?.container?.env).toBeUndefined();
      expect(tools?.attributes?.['app.kubernetes.io/part-of']).toBe(partOf);
    });
    it('moves the editor volume mount and removes venv', () => {
      expect(tools?.container?.volumeMounts).toEqual([{ name: server, path: `/${server}` }]);
      expect(byName(result, 'venv')).toBeUndefined();
      expect(byName(result, 'checode')).toBeUndefined();
      expect(byName(result, server)?.volume).toEqual({});
    });
    it('resizes the home volume', () => {
      expect(byName(result, 'home')?.volume?.size).toBe('10Gi');
    });
  });

  it('accepts a custom home volume size', () => {
    expect(byName(applyEditorProfile(sample(), 'goland', '20Gi'), 'home')?.volume?.size).toBe('20Gi');
  });

  it('tolerates a stack without a tools component', () => {
    const d: Devfile = { components: [{ name: 'other', container: { image: 'x' } }] };
    expect(applyEditorProfile(d, 'intellij').components).toEqual(d.components);
  });

  it('tolerates a tools container without volume mounts', () => {
    const d: Devfile = { components: [{ name: 'tools', container: { image: 'x' } }] };
    const tools = byName(applyEditorProfile(d, 'intellij'), 'tools');
    expect(tools?.container?.endpoints).toHaveLength(1);
  });
});

describe('updateDevfileYaml', () => {
  it('round-trips through YAML', () => {
    const out = load(updateDevfileYaml(SAMPLE_DEVFILE_YAML, 'goland')) as Devfile;
    expect(byName(out, 'che-goland-server')).toBeDefined();
  });
});
