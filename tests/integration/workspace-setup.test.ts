import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWorkspaceSetupCommand } from '../../src/factories/workspace-setup.js';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'workspace-setup-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
function git(...args: string[]) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function run(repositoryUrl?: string, repositoryBranch?: string, stack = 'citi-optimus') {
  const log = join(directory, 'setup.log');
  const result = spawnSync(
    bash,
    ['-c', buildWorkspaceSetupCommand({ stack, repositoryUrl, repositoryBranch })],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        WORKSPACE_REPOSITORY_DIR: directory.replaceAll('\\', '/'),
        WORKSPACE_SETUP_LOG: log.replaceAll('\\', '/'),
        WORKSPACE_MTA_DIR: join(directory, 'missing-analyzer').replaceAll('\\', '/'),
        WORKSPACE_SETTINGS_PATH: join(directory, 'missing-settings').replaceAll('\\', '/'),
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(log, 'utf8');
}
function repository() {
  git('init', '-b', 'main');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
}

describe('workspace post-start setup', () => {
  it('continues without a repository, analyzer binary, or settings', () => {
    expect(run()).toContain('No repositoryUrl supplied');
  });
  it('continues when the clone directory has no Git repository', () => {
    expect(run('https://example.com/app.git', 'optimus')).toContain(
      'Cloned repository directory unavailable',
    );
  });
  it('checks out an existing requested branch', () => {
    repository();
    git('branch', 'optimus');
    run('https://example.com/app.git', 'optimus');
    expect(git('branch', '--show-current')).toBe('optimus');
  });
  it('creates a local branch when it is absent', () => {
    repository();
    run('https://example.com/app.git', 'optimus');
    expect(git('branch', '--show-current')).toBe('optimus');
  });
  it('keeps the default branch when no branch is provided', () => {
    repository();
    run('https://example.com/app.git');
    expect(git('branch', '--show-current')).toBe('main');
  });
  it('continues after Git fetch failure', () => {
    repository();
    git('remote', 'add', 'origin', join(directory, 'missing-remote'));
    expect(run('https://example.com/app.git', 'optimus')).toContain('Git fetch failed');
  });
  it('quotes request data rather than executing it as shell code', () => {
    run(undefined, undefined, "x'; exit 71 #");
    expect(existsSync(join(directory, 'setup.log'))).toBe(true);
  });
});
