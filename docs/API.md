# Workspace Manager API and code map

Every endpoint starts with `/api/v1`. Unversioned URLs return 404. There is no legacy
router, compatibility switch, or archived implementation to maintain.

## Finding the code

```text
src/index.ts                   start server, load settings, graceful shutdown
src/app.ts                     Express setup, request logging, error handling
src/routers/index.ts           mount all feature routers and authentication
src/routers/*Router.ts         HTTP methods and paths
src/controllers/*Controller.ts parse requests and produce responses
src/services/                  provisioning and workspace business rules
src/http/helpers.ts             shared parameters and administrator authorization
src/config/                    environment validation and daily log storage
src/infra/                     Kubernetes, registry, email and database adapters
src/types.ts                   shared resource and API types
src/utils/                     shared logging, errors, names and resources
tests/unit/                    isolated behavior
tests/integration/             API, service and adapter wiring
tests/e2e/                     complete HTTP journeys
```

Source files are TypeScript; the build emits ESM `.js` files in `dist/`.
`npm start` runs `dist/index.js`, which calls the application factory in `dist/app.js`.
To debug a route, follow its router to the matching controller and service.

## Endpoints

Paths below include the version prefix. Use `Authorization: Bearer <jwt>` for all
routes except login and probes. The existing login issues an administrator token;
regular user tokens can access only their own `:soeid` resources.

| Method                 | Path                                  | Purpose                                               |
| ---------------------- | ------------------------------------- | ----------------------------------------------------- |
| GET                    | `/api/v1/healthz`                     | Liveness; does not contact dependencies               |
| GET                    | `/api/v1/readyz`                      | Kubernetes, deployment cluster and database readiness |
| POST                   | `/api/v1/login`                       | Existing username/password login                      |
| GET                    | `/api/v1/catalog`                     | Stack catalog                                         |
| GET, POST              | `/api/v1/:soeid/projects`             | List or provision workspace projects                  |
| GET, POST              | `/api/v1/:soeid/workspaces`           | List or create workspaces                             |
| GET, DELETE            | `/api/v1/:soeid/workspaces/:id`       | Read or terminate a workspace                         |
| POST                   | `/api/v1/:soeid/workspaces/:id/start` | Start a workspace                                     |
| POST                   | `/api/v1/:soeid/workspaces/:id/stop`  | Stop a workspace                                      |
| GET                    | `/api/v1/:soeid/pats`                 | List PATs                                             |
| GET, POST, PUT, DELETE | `/api/v1/:soeid/pats/:tokenName`      | View, create, update or delete a PAT                  |
| GET, POST, PUT, DELETE | `/api/v1/:soeid/gitconfig`            | View, upsert or delete Git configuration              |
| GET, POST, DELETE      | `/api/v1/:soeid/deployment-projects`  | List, provision or delete deployment projects         |
| PUT                    | `/api/v1/support/resources`           | Administrator resource reconciliation                 |
| GET, PATCH             | `/api/v1/configuration`               | Administrator runtime settings                        |
| GET                    | `/api/v1/logs`                        | Administrator log search and formatted output         |

Project/workspace/deployment-project lists accept an optional `?csiid=177398`
filter. Identifiers use the application's existing names: **SOEID** and **CSIID**.
Stacks come from the configured registry and are shared across projects.

`POST /api/v1/:soeid/projects` and `POST /api/v1/:soeid/deployment-projects` accept
`{ "csiid": "177398" }`. They reuse the existing provisioning services, including
roles, bindings, quotas, limit ranges, workspace network policies and proxy configuration.
Creation returns 201; an existing project returns 200. Deployment projects use the
configured deployment cluster. Deleting deployment projects retains the existing
behavior: delete all matching deployment projects for that user.

PAT writes accept `{ "csiid": "177398", "token": "..." }`. PAT reads and deletes use
`?csiid=177398`. Git configuration writes accept `{ "csiid": "177398", "content": "..." }`;
reads and deletes use the same query parameter. POST and PUT Git configuration both upsert.

## Creating a workspace

`POST /api/v1/:soeid/workspaces` accepts the existing dashboard payload:

```json
{
  "devworkspaceValue": "citi-optimus",
  "csiid": "177398",
  "editorType": "che-code",
  "stackVersion": "8.1.1",
  "repositoryUrl": "https://github.com/acme/project.git",
  "repositoryCheckoutBranch": "optimus"
}
```

The first four fields are required. `editorType` accepts `che-code`, `che-idea`, or
`che-goland`. The previously documented `editor` and `repositoryBranch` names also
remain accepted; conflicting aliases are rejected. Invalid nonempty values produce
400 with a `details` array naming the offending fields.

Repository URL and checkout branch are optional. Omitted, empty or null values do
not prevent workspace creation. Without a URL, no request-supplied project is added
and Git setup is skipped. Stack-provided projects remain intact. With a URL, the
request-supplied project is named `default-project`, cloned by Dev Spaces under
`/projects/default-project`. Branch selection happens in a post-start command so
an unavailable branch does not fail that command. It tries the requested branch,
then its remote tracking branch, then creates a local branch if no remote exists.
With no branch supplied, it tries `main`, then `master`, retaining the current
checkout if neither is available. Git failures are logged and the setup script
returns success. Actual project cloning still depends on Dev Spaces and repository
access; the API response confirms resource creation, not completed cloning.

The post-start setup runs in the stack's `tools` container, or its first container
when `tools` is absent. Existing commands and lifecycle events are preserved. For
`citi-optimus`, it also makes `/home/user/mta-analyzer-rpc-linux-amd64/mta-analyzer-rpc`
executable and updates `mta-core.analyzerPath` in
`/checode/remote/data/Machine/settings.json` using `jq`. Missing files, missing `jq`,
or configuration errors are logged without stopping setup. Other stacks skip MTA
configuration. Request values are safely passed as environment variables to the
workspace command; the API server needs no repository environment variables.

Inspect `/tmp/workspace-setup-debug.log` inside the workspace for Git and MTA setup
details. These operations execute in the workspace pod, so their runtime output is
separate from the API server's logs.

Failed API requests have a `request.failed` log containing the error's source and
message. Their `request` summary uses that same source, rather than the response
listener in `app.ts`. Successful request summaries identify the access-log function.

## Repairing or updating Kubernetes resources

Restore existing defaults on a user's workspace project:

```http
PUT /api/v1/support/resources
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{ "soeid": "pp58386", "csiid": "177398", "target": "workspace" }
```

Use `"target": "deployment"` for the deployment cluster/project. The project must
exist and its owner annotation must match the requested SOEID. Omitting `resources`
reapplies the existing provisioning defaults, including network/proxy resources for
workspace projects. This repairs missing resources without recreating a project.

To create or replace selected resources, supply their manifests:

```json
{
  "soeid": "pp58386",
  "csiid": "177398",
  "target": "workspace",
  "resources": [
    {
      "kind": "ResourceQuota",
      "metadata": { "name": "custom-compute-quota" },
      "spec": { "hard": { "requests.cpu": "4", "requests.memory": "8Gi" } }
    }
  ]
}
```

Allowed kinds: `Role`, `RoleBinding`, `ResourceQuota`, `LimitRange`, `ClusterRole`,
`ClusterRoleBinding`. `metadata` accepts only `name`: the server sets namespace and
API version. Cluster roles/bindings are cluster-scoped and apply to the selected
workspace or deployment cluster. Kubernetes has no cluster-scoped LimitRange or
ResourceQuota; those apply to the selected user's namespace on that cluster.
Kubernetes validates manifest rules, subjects, role references and specs.

Operations run sequentially. If one fails, earlier successful updates remain;
correct the error and retry. Existing Kubernetes permissions still apply. The
service account needs explicit cluster-RBAC write privileges for cluster-scoped
operations; this change does not automatically expand deployment privileges.

## Runtime settings

`GET /api/v1/configuration` returns settings with passwords and tokens redacted.
`PATCH /api/v1/configuration` accepts any nonempty subset of:

```json
{
  "DEVREG_URL": "https://registry.example.com",
  "NOTIFICATION_MAIL_URL": "https://mail.example.com",
  "NOTIFICATION_EMAIL_USERNAME": "workspace-mailer",
  "NOTIFICATION_EMAIL_PASSWORD": "replacement-password",
  "MAX_RUNNING_WORKSPACES": 3,
  "MAX_TOTAL_WORKSPACES": 5,
  "CLUSTER_API_URL": "https://api.cluster.example.com:6443",
  "CLUSTER_TOKEN": "replacement-token",
  "DEPLOY_CLUSTER_API_URL": "https://api.deploy.example.com:6443",
  "DEPLOY_CLUSTER_TOKEN": "replacement-deployment-token"
}
```

Changes take effect for subsequent requests in this process. Production adapters
are rebuilt so updated URLs and credentials are used; the database pool remains
open. In-flight operations can finish using their original services. Updates are
validated before replacement. Running limits cannot exceed total limits; changing
a cluster URL requires its token in the same request.

**Persistence is process-lifetime:** this API does not rewrite deployment environment
variables, Kubernetes Secrets or `.env` files. Set the same values in deployment
configuration to retain them after restart and across replicas. Responses explicitly
report `"persistence": "process-lifetime"`. No arbitrary environment-variable writes
are supported. Stored secret values are never returned by this API.

## Troubleshooting with daily logs

Production writes one redacted JSON entry per line to `logs/app-YYYY-MM-DD.log`.
Each entry includes `timestamp` (`YYYY-MM-DD HH:MM:SS` in the process's local timezone),
`file`, and `function`. The ISO `time` field remains available for precise filtering.
Readable console and log-search output uses
`[timestamp] [filename:line] [functionName]`. Continuation lines carry the
same prefix. Source details come from the log call, or the original error stack when
an Error object is provided. Application callbacks have descriptive function names;
top-level execution without a named function is identified as `module`.
Client failures (400/401/403/404/409) are logged as warnings with status, error code,
message, request ID, and source location. Server failures are logged as errors.
JWT errors distinguish expired, not-yet-valid, invalid-signature, and malformed tokens.
Use the Workspace Manager token from `/api/v1/login` for these APIs; cluster tokens
authenticate the server's Kubernetes requests and are separate credentials.
Dates are UTC and files switch automatically at midnight. Console formatting is
independent. `LOG_DIRECTORY` selects the directory. Mount a writable volume there
when using a read-only filesystem, and persistent storage if logs must survive pod
replacement. Log files are not committed. Retention is managed by the deployment.

```http
GET /api/v1/logs?days=2&level=error&search=namespace&limit=100&format=text
Authorization: Bearer <admin-jwt>
```

Supported query parameters:

| Parameter   | Meaning                                           |
| ----------- | ------------------------------------------------- |
| `days`      | Rolling last 1–31 days; default 1                 |
| `limit`     | Maximum 1–1000 results; default 200               |
| `level`     | `debug`, `info`, `warn`, or `error`               |
| `search`    | Case-insensitive text match, up to 200 characters |
| `requestId` | Exact request correlation ID                      |
| `soeid`     | Exact user match                                  |
| `format`    | `json` (default) or readable `text`               |

Results are newest first and include the queried range and a `truncated` indicator.
Search scans at most 100,000 lines per request. Missing files and malformed lines are
ignored. Search uses literal text filtering. The API searches this
instance's files; aggregate logs externally when running multiple replicas.

## Offline transfer

Copy `recreate-app.sh` and `all-app-code.txt` into the destination application folder:

```bash
bash recreate-app.sh -n -f --prune
bash recreate-app.sh -f --prune
```

The first command previews the update. The second verifies checksums, writes the
snapshot and deletes files explicitly listed as removed. The snapshot contains the
complete application source, tests, lockfile, configuration templates and documentation.
It can also be restored into an empty folder.

Node.js, installed dependencies and secrets are not included. Install dependencies
from your configured internal npm repository with `npm ci`, then run `npm run build`.
Supply environment variables or mounted secrets separately.

To prepare another full transfer on the development machine, run
`bash tools/build-all-code.sh --full`. Its verification restores every bundled file
to a temporary directory and compares it byte for byte with the source.

## Verification

Run `npm run typecheck`, `npm run lint`, `npm test -- --coverage`, and `npm run build`.
Tests retain the existing service and user journeys, replace deprecated-path checks
with 404 assertions, and cover provisioning, support updates on both clusters,
administrator restrictions, runtime settings, and daily log retrieval.
