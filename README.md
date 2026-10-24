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

## Postgres: the existing database

Metrics go into the **existing** Orion database. workspace-mgr creates nothing (no tables, schemas or migrations);
it only inserts rows into the table named by `POSTGRES_DATABASE_TABLENAME`.

Same variables as the original service:

```bash
export POSTGRES_DATABASE=orion_dev_metadata
export POSTGRES_HOSTNAME=NAORI01DPS_INSTANCE1.pgaas.dyn.nsroot.net
export POSTGRES_PASSWORD=...
export POSTGRES_PORT='1524'
export POSTGRES_USER=app_orion_pgsql_dev
export POSTGRES_DATABASE_TABLENAME='metrics."devspaces-metrics-dev"'
export NODE_ENV=development
```

- **TLS** is always on and the server certificate is verified, as before. `NODE_ENV` picks the CA file:
  `development` → `./certs/dev.pem` (hostname check relaxed), `uat` → `/app/backend/cert/uat.pem`,
  `production` → `/app/backend/cert/prod.pem`. Override with `POSTGRES_CERT_DIR` or `POSTGRES_CA_FILE`.
  The app refuses to start, naming the missing file, if the CA cannot be read.
- **Columns:** the service reads the table's column list once and writes only the columns that exist (it knows
  `timestamp, csiid, soeid, eventtype, resourcename, resourcetype, status, limitcpu, limitmemory, requestcpu,
requestmemory, duration, storage, useraction, errordetail, workspaceversion, editorname`). A table without
  `workspaceversion` / `editorname` still works; a warning names what is not stored.
- **Timestamps** are written as UTC wall-clock text, as the original did.
- A database problem never blocks a workspace action: it is logged and the action continues.

## Environment variables

Every variable the team exports is understood as-is (`.env.example` lists them with comments):

| Variable                                         | Meaning                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                           | HTTP port (default 3050)                                                                                                   |
| `NODE_ENV`                                       | `development` / `uat` / `production`; also picks the Postgres CA file                                                      |
| `SECRET_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` | login and JWT signing; **required**, there is no fallback secret                                                           |
| `CLUSTER_API_URL`                                | Dev Spaces cluster API                                                                                                     |
| `devSpacesClusterToken001d`                      | its bearer token, found by name: the `001d` must end the cluster name (`namctigtd001d`)                                    |
| `DEPLOY_CLUSTER_API_URL`, `devOpsToken004d`      | optional separate cluster for build/deploy projects and its token; unset = same cluster (a token for another id is unused) |
| `DEVREG_URL`                                     | devfile registry                                                                                                           |
| `EDITOR_VSCODE`, `EDITOR_INTELLIJ`               | full editor ids, e.g. `che-incubator/che-code/latest`                                                                      |
| `NODE_TLS_REJECT_UNAUTHORIZED=0`                 | do not verify certificates (clusters and every HTTPS peer); a warning is logged at startup                                 |
| `POSTGRES_*`                                     | see "Postgres: the existing database"                                                                                      |

Without a token the service uses `KUBECONFIG_PATH` (or the first command-line argument), then the default kubeconfig /
pod service account. `CLUSTER_TOKEN` and `DEPLOY_CLUSTER_TOKEN` set a token explicitly. The Dev Spaces dashboard address
for the editor link is `DEV_SPACES_SERVICE_FQDN`, or `https://devspaces.apps.<cluster domain>` worked out from `CLUSTER_API_URL`.
At startup the service logs what it understood (which variable supplied each token, never the token itself).

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

| Layer       | Where               | What is real                                                                                       |
| ----------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit`        | One module; everything else faked                                                                  |
| Integration | `tests/integration` | Express routes + services + SQL (`pg-mem`, with a test-only table fixture) + HTTP devfile registry |
| End to end  | `tests/e2e`         | A listening server driven only over HTTP through whole user journeys                               |

The cluster is always in memory: nothing here talks to a real OpenShift. Run a smoke test against your dev
cluster before first release (see "Not verified").

## Hand-over to another computer (`recreate-app.sh`, `all-app-code.txt`)

The app moves between computers as **one text file**, `all-app-code.txt`, and one script, `recreate-app.sh`.
The text file is made for you (by Claude, with `tools/build-all-code.sh`); you only run the script:

```bash
bash recreate-app.sh -f             # inside the app folder: writes the files of ./all-app-code.txt, overwriting
bash recreate-app.sh -f --prune     # also delete files that were removed from the app
bash recreate-app.sh -n             # dry run: show what would happen
bash recreate-app.sh p.txt ./out    # another input file / another folder (existing files are kept without -f)
```

- **First hand-over:** the entire application. **Every later one:** only the new and changed files, plus a list of
  files that were removed (`/_REMOVED.txt`). It ends with what to run next (`npm install`, `npm run build`, ...) when
  something relevant changed.
- **New empty folder:** put `recreate-app.sh` and `all-app-code.txt` in it and run `bash recreate-app.sh -f`, then
  `npm ci && npm test && npm run build && npm start`.
- **Format:** `/path/to/file`, the file's content, a blank line, next file. Files that cannot be shown as exact plain
  text (CRLF line endings, no final newline, odd names) are stored as base64 after `@@BINARY-SECTION`; the plain files
  are LF, so an editor, e-mail or git changing line endings cannot damage anything.
- **Safe:** the text file ends with a SHA-256 for every file; they are all checked in a temp folder before your files are
  touched. Existing files that differ are kept unless you pass `-f`. Paths that could escape the folder are rejected.
  `recreate-app.sh` never replaces itself while running; a newer version is saved as `recreate-app.sh.new`.
- **Never in a hand-over:** `node_modules`, `dist`, `coverage`, `.git`, `legacy`, `tools`, `.env*` (secrets), private keys.
- **For the maintainer:** `bash tools/build-all-code.sh` builds the next hand-over (entire app the first time, then
  only changes; `--full`, `--list`, `--redo` and `--keep-state` exist). What the other computer has is remembered in
  `.handover-state` (not committed). Before saving, the file is recreated in a temp folder and compared byte for byte.

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
