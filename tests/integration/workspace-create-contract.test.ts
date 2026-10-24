import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeContainer } from '../helpers/testkit.js';
import { createApp } from '../../src/app.js';
import { signToken } from '../../src/http/auth.js';
import { createLogger } from '../../src/utils/logger.js';

const payload = {
  devworkspaceValue: 'citi-optimus',
  csiid: '177398',
  editorType: 'che-code',
  stackVersion: '8.1.1',
};
function setup() {
  const { container, fakes } = makeContainer();
  fakes.registry.catalog.push({ name: 'citi-optimus', versions: [{ version: '8.1.1' }] });
  const logs: Record<string, unknown>[] = [];
  container.logger = createLogger('debug', (line) => logs.push(JSON.parse(line)));
  const app = createApp(container);
  const token = signToken(container.config.auth, { soeid: 'pp58386', role: 'admin' });
  const create = (body: object) =>
    request(app).post('/api/v1/pp58386/workspaces').set('Authorization', `Bearer ${token}`).send(body);
  return { container, fakes, logs, create };
}

describe('workspace creation payload', () => {
  it('accepts the supplied Optimus request and adds the post-start branch setup', async () => {
    const { create, fakes } = setup();
    const response = await create({
      ...payload,
      repositoryUrl: 'https://github.com/CitiInternal1/devspaces-developer-quickstart.git',
      repositoryCheckoutBranch: 'optimus',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      stack: 'citi-optimus',
      version: '8.1.1',
      editor: 'Visual Studio Code',
    });
    const template = fakes.kube.workspaces()[0]?.spec?.template;
    expect(template?.projects).toEqual([
      {
        name: 'default-project',
        git: { remotes: { origin: 'https://github.com/CitiInternal1/devspaces-developer-quickstart.git' } },
      },
    ]);
    expect(JSON.stringify(template?.commands)).toContain("TARGET_BRANCH='optimus'");
    expect(template?.events).toMatchObject({ postStart: ['build', 'workspace-manager-setup'] });
  });
  it.each([
    {},
    { repositoryUrl: '', repositoryCheckoutBranch: '' },
    { repositoryUrl: null, repositoryCheckoutBranch: null },
    { repositoryCheckoutBranch: 'optimus' },
  ])('creates without optional repository settings: %j', async (optional) => {
    const { create, fakes } = setup();
    expect((await create({ ...payload, ...optional })).status).toBe(200);
    expect(fakes.kube.workspaces()[0]?.spec?.template?.projects).toBeUndefined();
  });
  it('creates with a repository URL and no requested branch', async () => {
    const { create } = setup();
    expect((await create({ ...payload, repositoryUrl: 'https://github.com/acme/app.git' })).status).toBe(200);
  });
  it.each(['devworkspaceValue', 'csiid', 'editorType', 'stackVersion'])(
    'rejects a missing %s with field details and the actual validation source',
    async (field) => {
      const { create, logs, fakes } = setup();
      const body = { ...payload } as Record<string, unknown>;
      delete body[field];
      const response = await create(body);
      expect(response.status).toBe(400);
      expect(response.body.details).toContainEqual(expect.objectContaining({ field }));
      const failure = logs.find((log) => log.event === 'request.failed');
      const summary = logs.find((log) => log.event === 'request');
      expect(failure).toMatchObject({ file: 'schemas.ts', function: 'parse', code: 'VALIDATION_ERROR' });
      expect(summary).toMatchObject({ file: 'schemas.ts', function: 'parse', code: 'VALIDATION_ERROR' });
      expect(failure?.line).toBe(summary?.line);
      expect(fakes.kube.workspaces()).toHaveLength(0);
    },
  );
});
