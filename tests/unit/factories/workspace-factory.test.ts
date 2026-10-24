import { describe, expect, it } from 'vitest';
import type { Devfile } from '../../../src/types.js';
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
  editorId: 'che-incubator/che-code/latest',
  devSpacesServiceFqdn: 'https://devspaces.test',
  ...over,
});

describe('buildDevWorkspaceObject', () => {
  it('uses the configured internal plugin registry without a dashboard API URL', () => {
    const dw = buildDevWorkspaceObject(
      args({ editorRegistryUrl: 'http://internal-editor-registry:8080/v3/' }),
    );
    expect(dw.spec?.contributions?.[0]?.uri).toBe(
      'http://internal-editor-registry:8080/v3/plugins/che-incubator/che-code/latest/devfile.yaml',
    );
    expect(dw.spec?.contributions?.[0]?.uri).not.toContain('/dashboard/api/');
  });
  it('preserves lifecycle events and avoids setup command ID collisions', () => {
    const dw = buildDevWorkspaceObject(
      args({
        devfile: {
          components: [{ name: 'tools', container: { image: 'example/tools' } }],
          commands: [
            { id: 'workspace-manager-setup', exec: { component: 'tools', commandLine: 'echo existing' } },
          ],
          events: { preStart: ['prepare'], postStart: ['existing'] },
        },
      }),
    );
    expect(dw.spec?.template?.events).toEqual({
      preStart: ['prepare'],
      postStart: ['existing', 'workspace-manager-setup-post-start'],
    });
    expect(dw.spec?.template?.commands).toHaveLength(2);
  });
  it('replaces an existing default-project when an explicit repository is supplied', () => {
    const dw = buildDevWorkspaceObject(
      args({
        devfile: {
          projects: [{ name: 'default-project', git: { remotes: { origin: 'https://old.example/app' } } }],
        },
        repositoryUrl: 'https://github.com/acme/app.git',
      }),
    );
    expect(dw.spec?.template?.projects).toEqual([
      { name: 'default-project', git: { remotes: { origin: 'https://github.com/acme/app.git' } } },
    ]);
  });
  it('builds a started DevWorkspace with the stack inlined and the editor contributed', () => {
    const dw = buildDevWorkspaceObject(args());
    expect(dw).toMatchObject({
      apiVersion: 'workspace.devfile.io/v1alpha2',
      kind: 'DevWorkspace',
      metadata: { name: 'java-maven-ab12', namespace: 'pp1-devspaces-1' },
      spec: { started: true, routingClass: 'che' },
    });
    expect(dw.spec?.template?.components).toHaveLength(4);
    expect(dw.spec?.template?.commands).toHaveLength(2);
    expect(dw.spec?.template?.events).toBeDefined();
    expect(dw.spec?.contributions).toEqual([
      {
        name: 'ide',
        uri: 'https://devspaces.test/plugin-registry/v3/plugins/che-incubator/che-code/latest/devfile.yaml',
      },
    ]);
  });

  it('uses the editor id exactly as configured, e.g. the team’s che-idea-server value', () => {
    const dw = buildDevWorkspaceObject(
      args({ editor: 'intellij', editorId: 'che-incubator/che-idea-server/latest' }),
    );
    expect(dw.spec?.contributions?.[0]?.uri).toBe(
      'https://devspaces.test/plugin-registry/v3/plugins/che-incubator/che-idea-server/latest/devfile.yaml',
    );
    expect(dw.spec?.contributions?.[0]?.uri).not.toMatch(/che-incubator.*che-incubator/);
  });

  it('records stack metadata in annotations and labels', () => {
    const dw = buildDevWorkspaceObject(
      args({ editor: 'goland', editorId: 'che-incubator/che-goland/latest' }),
    );
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
        name: 'default-project',
        git: {
          remotes: { origin: 'https://github.com/acme/My_Repo.git' },
        },
      },
    ]);
  });

  it('keeps stack projects and omits checkoutFrom without a branch', () => {
    const devfile: Devfile = { components: [], projects: [{ name: 'starter' }] };
    const dw = buildDevWorkspaceObject(args({ devfile, repositoryUrl: 'https://github.com/acme/app' }));
    expect(dw.spec?.template?.projects).toEqual([
      { name: 'starter' },
      { name: 'default-project', git: { remotes: { origin: 'https://github.com/acme/app' } } },
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
