import { describe, expect, it } from 'vitest';
import {
  cleanWorkspaceName,
  csiidFromDeploymentNamespace,
  csiidFromWorkspaceNamespace,
  deploymentNamespace,
  extractClusterName,
  parseCsiid,
  parseResourceName,
  parseSoeid,
  parseTokenName,
  randomSuffix,
  workspaceNamespace,
} from '../../../src/utils/names.js';
import { BadRequestError } from '../../../src/utils/errors.js';

describe('parseSoeid', () => {
  it('lower-cases and trims', () => expect(parseSoeid(' PP58386 ')).toBe('pp58386'));
  it.each(['', 'ab', 'a b', 'a/b', '../etc', 'x'.repeat(21), 'user;rm', 'üser'])('rejects %j', (value) => {
    expect(() => parseSoeid(value)).toThrow(BadRequestError);
  });
});

describe('parseCsiid', () => {
  it('accepts digits', () => expect(parseCsiid('177398')).toBe('177398'));
  it.each(['', 'abc', '12a', '-1', '12345678901'])('rejects %j', (value) => {
    expect(() => parseCsiid(value)).toThrow(BadRequestError);
  });
});

describe('parseResourceName / parseTokenName', () => {
  it('accepts DNS-1123 labels', () => {
    expect(parseResourceName('Java-Maven-ab12')).toBe('java-maven-ab12');
    expect(parseTokenName('My-Token')).toBe('my-token');
  });
  it.each(['-bad', 'bad-', 'has space', 'UPPER_CASE', 'x'.repeat(64)])('rejects %j', (value) => {
    expect(() => parseResourceName(value)).toThrow(BadRequestError);
  });
  it('rejects bad token names', () => {
    expect(() => parseTokenName('a/b')).toThrow(BadRequestError);
    expect(() => parseTokenName('')).toThrow(BadRequestError);
  });
});

describe('namespace helpers', () => {
  it('builds and parses workspace namespaces', () => {
    expect(workspaceNamespace('pp58386', '177398')).toBe('pp58386-devspaces-177398');
    expect(csiidFromWorkspaceNamespace('pp58386-devspaces-177398')).toBe('177398');
    expect(csiidFromWorkspaceNamespace('pp58386-devspaces-deploy-177398')).toBeUndefined();
  });
  it('builds and parses deployment namespaces', () => {
    expect(deploymentNamespace('pp58386', '177398')).toBe('pp58386-devspaces-deploy-177398');
    expect(csiidFromDeploymentNamespace('pp58386-devspaces-deploy-177398')).toBe('177398');
    expect(csiidFromDeploymentNamespace('pp58386-devspaces-177398')).toBeUndefined();
  });
});

describe('extractClusterName', () => {
  it('reads the cluster from api and apps URLs', () => {
    expect(extractClusterName('https://api.namctiswd004d.ecs.dyn.nsroot.net:6443')).toBe('namctiswd004d');
    expect(extractClusterName('https://console-openshift-console.apps.prod1.ecs.dyn.example.net/')).toBe(
      'prod1',
    );
  });
  it('falls back for anything else', () => {
    expect(extractClusterName('http://localhost')).toBe('unknown-cluster');
    expect(extractClusterName(undefined)).toBe('unknown-cluster');
  });
});

describe('cleanWorkspaceName', () => {
  it('appends the suffix', () => expect(cleanWorkspaceName('java-maven', 'ab12')).toBe('java-maven-ab12'));
  it('sanitises to DNS-1123', () => {
    expect(cleanWorkspaceName('Java_Maven 17!!', 'ab12')).toBe('java-maven-17-ab12');
    expect(cleanWorkspaceName('---', 'ab12')).toBe('workspace-ab12');
  });
  it('never exceeds 63 characters', () => {
    expect(cleanWorkspaceName('x'.repeat(200), 'ab12').length).toBeLessThanOrEqual(63);
  });
  it('generates 4-hex-char suffixes by default', () => {
    expect(cleanWorkspaceName('py')).toMatch(/^py-[0-9a-f]{4}$/);
    expect(randomSuffix()).toMatch(/^[0-9a-f]{4}$/);
  });
});
