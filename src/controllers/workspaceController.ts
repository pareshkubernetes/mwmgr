import type { RequestHandler } from 'express';
import { optionalCsiid, param } from '../http/helpers.js';
import type { Container } from '../container.js';
import { getSoeid } from '../http/auth.js';
import { asyncHandler } from '../http/errors.js';
import { createWorkspaceSchema, parse } from '../http/schemas.js';
import { parseCsiid } from '../utils/names.js';

export function workspaceController(container: Container) {
  return {
    list: asyncHandler(async function workspaceList(req, res) {
      const csiid = optionalCsiid(req);
      const workspaces = await container.workspaces.list(getSoeid(res));
      res.json(csiid ? workspaces.filter((workspace) => workspace.csiid === csiid) : workspaces);
    }),
    get: asyncHandler(async function workspaceGet(req, res) {
      res.json(await container.workspaces.get(getSoeid(res), param(req, 'id')));
    }),
    create: asyncHandler(async function workspaceCreate(req, res) {
      const body = parse(createWorkspaceSchema, req.body);
      const workspace = await container.workspaces.create({
        soeid: getSoeid(res),
        csiid: parseCsiid(body.csiid),
        devworkspaceValue: body.devworkspaceValue,
        editor: body.editor,
        stackVersion: body.stackVersion,
        repositoryUrl: body.repositoryUrl,
        repositoryBranch: body.repositoryBranch,
      });
      res.status(200).json(workspace);
    }),
    remove: asyncHandler(async function workspaceRemove(req, res) {
      const id = param(req, 'id');
      await container.workspaces.delete(getSoeid(res), id);
      res.json({ message: `Workspace with id ${id} is terminating.` });
    }),
    start: asyncHandler(async function workspaceStart(req, res) {
      const id = param(req, 'id');
      await container.workspaces.start(getSoeid(res), id);
      res.json({ message: `Workspace with id ${id} is starting.` });
    }),
    stop: asyncHandler(async function workspaceStop(req, res) {
      const id = param(req, 'id');
      await container.workspaces.stop(getSoeid(res), id);
      res.json({ message: `Workspace with id ${id} is stopping.` });
    }),
  } satisfies Record<string, RequestHandler>;
}
