We have Red Hat DevSpaces 3.16 running in one of OpenShift cluster.
https://docs.redhat.com/en/documentation/red_hat_openshift_dev_spaces/3.0/html/administration_guide/index


We have Orion app running made using Red Hat Developer Hub.
https://docs.redhat.com/en/documentation/red_hat_developer_hub/1.2/html/getting_started_with_red_hat_developer_hub/index


Now instead of using DevSpace Dashboard, we have created Dashbaord like functionality in our Orion applicaion 

as - presented all stacks to create new workspace.
   - Create, Delete, Stop, Start workspace from dashboard.


Now ask is that to create DevSpaces dashboard, like
  1. How many users are currently for DevSpaces?
  2. Which stack is most popular?
  3. Which stack last long life? ( if workspace is idle for more than 15days, our cron automatically deletes it)
  4. What is resource consumtion total by workspaces? (Only running workspaces has running pod)
  5. How much time average devspace user takes?
  6. How much storage allocated thru DevSpaces?
  7. How much storage released becasue of CRON auto deletion of workspaces idle more than 15 days?

  and much more required metrics.


Now we have Workspace-mgr microservice as i have attached its details in ZIP file here, this servie is responsible for CRUD operation related to DevSpaces from Orion application, so basically we are going to create table in Postgres DB and create new record every time workspace-mgr service do any action like, create, delete, stop, start, create prokect etc workspace.


Last but not least, if there is any Error coming during Creating new workspaces, or starting workspaces related to Openshift cluster having config issue, resource related or Storage Class not working anything, that also need to be stored in DB, and this will come from OpenShift cluster, and some cluster level resource metrics too.

Now for this task, we need to create some JIRAS

to start with:
[1] Design shema for DevSpace Metrics
[2] POC for connecting with Postgres DB and create some sample Create, Delete, update and read records from workspace mgr to Orion PostgresDB
[3] implement adding new row in table right were workspace related action taking place in whatever function, like 
create workspace
create project
delete workspace
start workspace
stop workspace
any Error from any action also need to be recorded.

[4] Metrics from OpenShift

[5] Cron job that removes 15 or older idle workspace automatically

   Record delete action right from here to Postgres DB as well.

[6] Review

