export interface WorkspaceSetup {
  stack: string;
  repositoryUrl?: string;
  repositoryBranch?: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Runs inside the workspace container after the Dev Spaces project clone. */
export function workspaceSetupScript(): string {
  return [
    'set +e',
    'set +u',
    'REPO_DIR="${WORKSPACE_REPOSITORY_DIR:-/projects/default-project}"',
    'MTA_DIR="${WORKSPACE_MTA_DIR:-/home/user/mta-analyzer-rpc-linux-amd64}"',
    'SETTINGS_PATH="${WORKSPACE_SETTINGS_PATH:-/checode/remote/data/Machine/settings.json}"',
    'LOG_FILE="${WORKSPACE_SETUP_LOG:-/tmp/workspace-setup-debug.log}"',
    'exec >> "$LOG_FILE" 2>&1',
    'log_setup() { printf "[%s] [workspace-setup] [%s] %s\\n" "$(date +"%Y-%m-%d %H:%M:%S")" "$1" "$2"; }',
    'log_setup setup "Starting workspace post-start setup."',
    'if [ "$WORKSPACE_STACK" = "citi-optimus" ]; then',
    '  ANALYZER="$MTA_DIR/mta-analyzer-rpc"',
    '  if [ -f "$ANALYZER" ]; then',
    '    chmod +x "$ANALYZER" || log_setup configureAnalyzer "Could not set executable permission; continuing."',
    '  else log_setup configureAnalyzer "MTA analyzer binary not found; continuing."; fi',
    '  if [ -f "$SETTINGS_PATH" ] && command -v jq >/dev/null 2>&1; then',
    '    UPDATED=$(jq --arg analyzer_path "$ANALYZER" \'. + {"mta-core.analyzerPath": $analyzer_path}\' "$SETTINGS_PATH")',
    '    if [ "$?" -eq 0 ]; then',
    '      printf "%s\\n" "$UPDATED" > "$SETTINGS_PATH" || log_setup configureAnalyzer "Could not write settings; continuing."',
    '    else log_setup configureAnalyzer "Could not parse analyzer settings; continuing."; fi',
    '  else log_setup configureAnalyzer "Settings file or jq unavailable; skipping settings update."; fi',
    'fi',
    'if [ "$REPOSITORY_URL_PROVIDED" != "true" ]; then',
    '  log_setup checkoutRepository "No repositoryUrl supplied; skipping Git setup."',
    '  exit 0',
    'fi',
    'if ! cd "$REPO_DIR" || ! git rev-parse --git-dir >/dev/null 2>&1; then',
    '  log_setup checkoutRepository "Cloned repository directory unavailable; skipping Git setup."',
    '  exit 0',
    'fi',
    'git fetch --all --prune || log_setup checkoutRepository "Git fetch failed; continuing with available local refs."',
    'git branch -a || true',
    'if [ -z "$TARGET_BRANCH" ]; then',
    '  git checkout main || git checkout master || log_setup checkoutRepository "Default branches unavailable; retaining the current branch."',
    'elif git checkout "$TARGET_BRANCH"; then',
    '  log_setup checkoutRepository "Requested branch checked out."',
    'elif git show-ref --verify --quiet "refs/remotes/origin/$TARGET_BRANCH"; then',
    '  git checkout -b "$TARGET_BRANCH" --track "origin/$TARGET_BRANCH" || git checkout --detach "origin/$TARGET_BRANCH" || log_setup checkoutRepository "Could not check out the remote branch; retaining the current branch."',
    'else',
    '  git checkout -b "$TARGET_BRANCH" || log_setup checkoutRepository "Could not create the requested local branch; retaining the current branch."',
    'fi',
    'git branch -a || true',
    'git status --short || true',
    'log_setup setup "Workspace setup completed."',
    'exit 0',
  ].join('\n');
}

export function buildWorkspaceSetupCommand(input: WorkspaceSetup): string {
  return `env WORKSPACE_STACK=${shellQuote(input.stack)} REPOSITORY_URL_PROVIDED=${shellQuote(input.repositoryUrl ? 'true' : 'false')} TARGET_BRANCH=${shellQuote(input.repositoryBranch ?? '')} bash -c ${shellQuote(workspaceSetupScript())}`;
}
