# Workspace Mgr

Middleware between the **Orion** dashboard and **Red Hat OpenShift Dev Spaces**. On demand of a user it
creates, lists, starts, stops and deletes DevWorkspaces, creates the user's project (namespace) when it does not
exist, manages per-user Git credentials, and records every action to Postgres for the Dev Spaces dashboard.

Node 20+, TypeScript (strict, ESM), Express 4, `@kubernetes/client-node`, `pg`, `zod`.
Project rules: [docs/PROJECT_RULES.md](docs/PROJECT_RULES.md) · Checklist: [docs/CHECKLIST.md](docs/CHECKLIST.md)

## Quick start

```bash
npm install
cp .env.example .env        # edit; SECRET_KEY, ADMIN_*, DEVREG_URL are required
npm run dev                 # tsx watch (loads env from your shell; use `node --env-file=.env` if you prefer)
npm run build && npm start  # production
```

| Script                                                | What it does                               |
| ----------------------------------------------------- | ------------------------------------------ |
| `npm run typecheck` / `lint` / `format`               | tsc, eslint (0 warnings allowed), prettier |
| `npm test`                                            | unit + integration + e2e                   |
| `npm run test:unit` / `test:integration` / `test:e2e` | one layer                                  |
| `npm run test:coverage`                               | all layers with a coverage gate            |
| `npm run bundle` / `bundle:all` / `restore -- <file>` | see "Bundle and restore"                   |

Create the metrics table once: `psql -f migrations/001_devspaces_metrics.sql`.

## API (version 1)

All routes live under **`/api/v1`**. Send `Authorization: Bearer <jwt>` except for `login`.
Errors are always `{ "error": string, "message": string, "code": string }`.

| Method | Path                                    | Purpose                                                        |
| ------ | --------------------------------------- | -------------------------------------------------------------- |
| POST   | `/api/v1/login`                         | `{username,password}` → `{token}`                              |
| GET    | `/api/v1/catalog`                       | Stacks from the devfile registry                               |
| GET    | `/api/v1/:soeid/projects`               | The user's projects (namespaces)                               |
| GET    | `/api/v1/:soeid/workspaces`             | List workspaces                                                |
| POST   | `/api/v1/:soeid/workspaces`             | Create a workspace (creates the project if needed)             |
| GET    | `/api/v1/:soeid/workspaces/:id`         | Workspace details                                              |
| DELETE | `/api/v1/:soeid/workspaces/:id`         | Delete                                                         |
| POST   | `/api/v1/:soeid/workspaces/:id/start`   | Start                                                          |
| POST   | `/api/v1/:soeid/workspaces/:id/stop`    | Stop                                                           |
| GET    | `/api/v1/:soeid/pats`                   | List GitHub PAT secrets                                        |
| GET    | `/api/v1/:soeid/pats/:tokenName?csiid=` | View (token is masked)                                         |
| POST   | `/api/v1/:soeid/pats/:tokenName`        | `{csiid,token}` create (409 if it exists)                      |
| PUT    | `/api/v1/:soeid/pats/:tokenName`        | `{csiid,token}` replace                                        |
| DELETE | `/api/v1/:soeid/pats/:tokenName?csiid=` | Delete (idempotent)                                            |
| GET    | `/api/v1/:soeid/gitconfig?csiid=`       | View `~/.gitconfig`                                            |
| PUT    | `/api/v1/:soeid/gitconfig`              | `{csiid,content}` create or replace                            |
| DELETE | `/api/v1/:soeid/gitconfig?csiid=`       | Delete (idempotent)                                            |
| GET    | `/api/v1/:soeid/deployment-projects`    | List build/deploy projects                                     |
| POST   | `/api/v1/:soeid/deployment-projects`    | `{csiid}` → 201 created, or 200 if it already exists           |
| DELETE | `/api/v1/:soeid/deployment-projects`    | Delete all of the user's deployment projects                   |
| GET    | `/healthz`, `/readyz`                   | Liveness (no dependencies) / readiness (Kubernetes + Postgres) |

Create-workspace body:

```json
{
  "devworkspaceValue": "java-maven",
  "csiid": "177398",
  "editor": "vscode",
  "stackVersion": "2.0.0",
  "repositoryUrl": "https://github.com/acme/app.git",
  "repositoryBranch": "main"
}
```

`editor` is `vscode` (default), `intellij` or `goland`; the last three fields are optional.

**Versioning.** `/api/v1` is the contract. A breaking change will ship as `/api/v2` next to it. The old unversioned
paths (`/login`, `/:soeid/...`) still work as **deprecated aliases** (`Deprecation: true`,
`Link: </api/v1/...>; rel="successor-version"`) so Orion keeps working while it migrates. Turn them off with
`LEGACY_UNVERSIONED_ROUTES=false`.

## Architecture

```
http (routes, auth, validation)  →  services (rules)  →  ports ← infra (Kubernetes, Postgres, registry, email)
                                         ↓
                                   factories (pure) , utils , constants
```

`src/container.ts` is the only place adapters are wired to services; tests wire in fakes
(`tests/helpers/InMemoryKube.ts` behaves like a cluster, `pg-mem` like Postgres).

## Tests

| Layer       | Where               | What is real                                                                              |
| ----------- | ------------------- | ----------------------------------------------------------------------------------------- |
| Unit        | `tests/unit`        | One module; everything else faked                                                         |
| Integration | `tests/integration` | Express routes + services + SQL (`pg-mem`, the shipped migration) + HTTP devfile registry |
| End to end  | `tests/e2e`         | A listening server driven only over HTTP through whole user journeys                      |

The cluster is always in memory: nothing here talks to a real OpenShift. Run a smoke test against your dev
cluster before first release (see "Not verified").

## Bundle and restore

Pack changed files into one text file, and rebuild them from it elsewhere:

```bash
node scripts/bundle.mjs                 # files added/modified since the last commit → workspace-mgr.bundle.txt
node scripts/bundle.mjs --all           # every project file
node scripts/restore.mjs workspace-mgr.bundle.txt --out ../copy            # recreate
node scripts/restore.mjs workspace-mgr.bundle.txt --out ../copy --dry-run  # preview
node scripts/restore.mjs workspace-mgr.bundle.txt --list                   # inspect
```

Every file is verified (size + SHA-256) before anything is written; existing files that differ are only
overwritten with `--force`; `node_modules`, `dist`, `.env*` (except `.env.example`) are never bundled;
a bundle whose line endings were converted to CRLF is repaired only when the checksums prove it exact.

## Assumptions (my defaults; please confirm)

You did not show the create-workspace payload, `index.ts`, `updateDevfile.ts` or the first three screenshots, so
these were decided without them:

- **Payload** is the shape above. `devworkspaceValue`+`csiid` come from the legacy code; the rest are additions.
- **Editor profiles:** JetBrains server ports `2222` (IntelliJ) and `3400` (GoLand), home volume `10Gi`. Read from
  a partly visible screenshot; verify in `src/factories/devfile-updater.ts`.
- **Workspaces are inlined** in the DevWorkspace (`spec.template` + `contributions`) rather than creating a separate
  DevWorkspaceTemplate as the oldest code did. Delete still cleans up legacy templates.
- **Limits:** 3 running / 5 total workspaces per user (`MAX_RUNNING_WORKSPACES`, `MAX_TOTAL_WORKSPACES`).
- **Missing config files** (`user-namespace.yaml`, `user-role-default.yaml`) are rebuilt in code
  (`src/constants/kubernetes-configs.ts`, `NamespaceService`). The user role there is my guess.
- **Auth:** only the admin login exists, as before; its token may act for any `:soeid` (what Orion needs today).
  Tokens with `role: user` are limited to their own `:soeid`.
- **Status codes** follow REST: login failure is `401` (was `400`), PAT create is `201`.
- **Git username** is `<soeid><GITHUB_USER_SUFFIX>` (legacy used `<soeid>_citi`).

## Intentionally not ported

`legacy/` keeps the original files. Not carried over because they were dead, broken or out of scope:
`Mix-Code.ts` (PVC wait experiment), `find-resources.ts` (index-based resource sum, replaced by
`summarizeComponents`), `remove-workspace-code.ts` (stand-alone script), `t.ts` (empty),
`devfileConverter.ts` (not used once workspaces are inlined). Out of scope for now: the 15-day idle cleanup cron,
OpenShift cluster metrics, the dashboard aggregation tables/queries (`prompt/*.md`).

## Not verified

- No run against a real OpenShift cluster, real Postgres, or the real devfile registry/mail/GraphQL services.
- `docker build` was not run. The Helm chart (`helm/`) has no Deployment template and its folder is named
  `template`, not `templates`; it was left unchanged.
