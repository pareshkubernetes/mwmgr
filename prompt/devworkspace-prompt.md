I need to create an advanced dashboard and reports for DevSpaces running on an OpenShift cluster. I've created two PostgreSQL tables, devspaces_dashboard_history and devspaces_dashboard_current, with the following columns:

created_date TIMESTAMP
user_name VARCHAR(255)
workspace_name VARCHAR(255)
workspace_status VARCHAR(50)
last_active_date TIMESTAMP
workspace_duration INTERVAL
user_role VARCHAR(50)
project_namespace VARCHAR(255)
resource_usage JSONB
workspace_id UUID PRIMARY KEY
workspace_configuration JSONB
errors_issues TEXT
cron_job_run_timestamp TIMESTAMP
Details:

Workspaces may appear multiple times with different cron_job_run_timestamp.
Another cron job removes idle workspaces after 15 days that is already working, i am not expecting any help on that matter.

Requirements:
    How many total workspaces created between Date A to Date B.
    Total workspaces created so far.
    Total DevSpaces users.
    Total workspaces in Running, Failed, and Stopped states.
    Number of workspaces by stack.

PostgreSQL Details:
    Host: sd-72a0-c6cf
    Port: 1524
    Database: sltn_dev.devspaces_db.devspaces
    Username: app_orion_pqsql_poc

Task:
    Write a Bash script for a cron job that:
        Runs daily at 5 PM CST.
        Logs in to the OpenShift cluster.
        Extracts workspace data using oc commands.
        Inserts or updates the PostgreSQL tables.

Please provide the Bash script with PostgreSQL connection details and ensure it handles inserting into both tables correctly.

I already have working query as follow:

oc get devworkspace --all-namespaces --token="$TOKEN" --server="https://api.$CLUSTER_NAME.ecs.dyn.nsroot.net:6443" -o json | jq -r '.items[] | "\(.metadata.name)/|(.metadata.namespace)/|(.metadata.creationTimeStamp)/|(.status.phase)/|(.metadata.devworkspaceId)/|(.status.conditions[0].message)/|(.status.conditions[0].lastTransitionTime)"'

Only user-name i have to extract from value of ".metadata.namespace" as every namespace first 7 characters OR 1st word separated by "-" is value of user-name.