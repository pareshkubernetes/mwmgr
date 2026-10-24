import { describe, expect, it } from 'vitest';
import type { Devfile } from '../../../src/domain/types.js';
import { buildLogRecord } from '../../../src/factories/log-factory.js';
import { buildDevWorkspaceObject, WORKSPACE_LABELS } from '../../../src/factories/workspace-factory.js';
import { parseDevfile } from '../../../src/factories/devfile-updater.js';
import { SAMPLE_DEVFILE_YAML } from '../../helpers/sample-devfile.js';

const args = (over: Partial<Parameters<typeof buildDevWorkspaceObject>[0]> = {}) => ({
  name: 'java-maven-ab12',
  namespace: 'pp1-devspaces-1',
  csiid: '1',
  stack: 'java-maven',
  stackVersion: '2.0.0',
  devfile: parseDevfile(SAMPLE_DEVFILE_YAML),
  editor: 'vscode' as const,
  editorId: 'che-code',
  devSpacesServiceFqdn: 'https://devspaces.test',
  ...over,
});

describe('buildDevWorkspaceObject', () => {
  it('builds a started DevWorkspace with the stack inlined and the editor contributed', () => {
    const dw = buildDevWorkspaceObject(args());
    expect(dw).toMatchObject({
      apiVersion: 'workspace.devfile.io/v1alpha2',
      kind: 'DevWorkspace',
      metadata: { name: 'java-maven-ab12', namespace: 'pp1-devspaces-1' },
      spec: { started: true, routingClass: 'che' },
    });
    expect(dw.spec?.template?.components).toHaveLength(4);
    expect(dw.spec?.template?.commands).toHaveLength(1);
    expect(dw.spec?.template?.events).toBeDefined();
    expect(dw.spec?.contributions).toEqual([
      {
        name: 'ide',
        uri: 'https://devspaces.test/dashboard/api/editors/devfile?che-editor=che-incubator/che-code/latest',
      },
    ]);
  });

  it('records stack metadata in annotations and labels', () => {
    const dw = buildDevWorkspaceObject(args({ editor: 'goland', editorId: 'che-goland' }));
    expect(dw.metadata?.annotations).toMatchObject({
      dw: 'java-maven-ab12',
      workspaceVersion: '2.0.0',
      workspaceDisplayName: 'Java Maven',
      workspaceDescription: 'Java 17 with Maven',
      editorDisplayName: 'GoLand',
    });
    expect(dw.metadata?.labels).toEqual({
      [WORKSPACE_LABELS.csiid]: '1',
      [WORKSPACE_LABELS.stack]: 'java-maven',
      [WORKSPACE_LABELS.managedBy]: 'workspace-mgr',
    });
  });

  it('adds the requested repository as a project, with a branch when given', () => {
    const dw = buildDevWorkspaceObject(
      args({ repositoryUrl: 'https://github.com/acme/My_Repo.git', repositoryBranch: 'develop' }),
    );
    expect(dw.spec?.template?.projects).toEqual([
      {
        name: 'my-repo',
        git: {
          remotes: { origin: 'https://github.com/acme/My_Repo.git' },
          checkoutFrom: { revision: 'develop' },
        },
      },
    ]);
  });

  it('keeps stack projects and omits checkoutFrom without a branch', () => {
    const devfile: Devfile = { components: [], projects: [{ name: 'starter' }] };
    const dw = buildDevWorkspaceObject(args({ devfile, repositoryUrl: 'https://github.com/acme/app' }));
    expect(dw.spec?.template?.projects).toEqual([
      { name: 'starter' },
      { name: 'app', git: { remotes: { origin: 'https://github.com/acme/app' } } },
    ]);
  });

  it('omits projects, commands and events when the stack has none', () => {
    const dw = buildDevWorkspaceObject(args({ devfile: { components: [] } }));
    expect(dw.spec?.template).not.toHaveProperty('projects');
    expect(dw.spec?.template).not.toHaveProperty('commands');
    expect(dw.spec?.template).not.toHaveProperty('events');
  });

  it('falls back to the stack name for the display name', () => {
    const dw = buildDevWorkspaceObject(args({ devfile: { components: [] } }));
    expect(dw.metadata?.annotations?.workspaceDisplayName).toBe('java-maven');
  });
});

describe('buildLogRecord', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  it('fills the legacy defaults', () => {
    expect(buildLogRecord({ soeid: 'pp1', eventtype: 'create', resourcetype: 'workspace' }, now)).toEqual({
      timestamp: now,
      csiid: '',
      soeid: 'pp1',
      eventtype: 'create',
      resourcename: '',
      resourcetype: 'workspace',
      status: { failed: false, error: '', message: '' },
      useraction: 'user',
      limitcpu: 0,
      limitmemory: 0,
      requestcpu: 0,
      requestmemory: 0,
      duration: '0 seconds',
      storage: 0,
      workspaceversion: '',
      editorname: '',
    });
  });
  it('keeps what is given', () => {
    const r = buildLogRecord(
      {
        soeid: 'pp1',
        eventtype: 'delete',
        resourcetype: 'workspace',
        limitcpu: 2,
        useraction: 'system',
        csiid: '9',
      },
      now,
    );
    expect(r).toMatchObject({ limitcpu: 2, useraction: 'system', csiid: '9' });
  });
});
