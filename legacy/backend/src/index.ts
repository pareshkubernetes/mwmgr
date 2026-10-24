// // @ts-ignore
// import dotenv from 'dotenv';
// dotenv.config();
// @ts-ignore
import express, { Request, Response } from 'express';
// @ts-ignore
import jwt from 'jsonwebtoken';
import { Wrapper, Workspace, Project, WorkspaceRunCountExceeded, WorkspaceCountExceeded } from './Wrapper';
import { WorkspaceConfigNotFound } from './DevregManager';
import { verifyToken } from './authMiddleware';

// @ts-ignore
const port = process.env.PORT || '';
// @ts-ignore
const clusterApiUrl = process.env.CLUSTER_API_URL || '';
// @ts-ignore
const devregUrl = process.env.DEVREG_URL || '';
// @ts-ignore
const editorVscode = process.env.EDITOR_VSCODE || '';
// @ts-ignore
const editorIntellij = process.env.EDITOR_INTELLIJ || '';
// @ts-ignore
const secretKey = process.env.SECRET_KEY || 'emergency-secret-key';
// @ts-ignore
const adminUser = process.env.ADMIN_USERNAME || '';
// @ts-ignore
const adminPassword = process.env.ADMIN_PASSWORD || '';

console.log('Loaded configs:');
console.log('clusterApiUrl:', clusterApiUrl);
console.log('devregUrl:', devregUrl);
// console.log('adminUser:', adminUser);
// console.log('adminPassword:', adminPassword);


const app = express();

app.use(express.json());
const wrapper = new Wrapper(
        clusterApiUrl,
        devregUrl,
        editorVscode,
        editorIntellij
    );

// Endpoint for openshift health check
app.get('/healthz', (req: Request, res: Response) => {
    res.send('OK');
});

// Login endpoint
app.post('/login', (req: Request, res: Response) => {
    const { username, password } = req.body;
    if (username == adminUser && password == adminPassword) {
        const token = jwt.sign({ userId: 1, username: adminUser }, secretKey!, {
            expiresIn: '60d',
        });
        return res.send({ token });
    } else {
        return res.status(400).send('Username or password is incorrect');
    }
});

// /catalog
app.get('/catalog', verifyToken, async (req: Request, res: Response) => {
    await wrapper.getCatalog()
        .then((catalog: any[]) => {
            return res.status(200).send(catalog);
        })
        .catch((error) => {
            return res.status(500).send({ error: `Failed to get catalog: ${error}` });
        });
});

// /:soeid/pats get - list all user personal access tokens
// /:soeid/pats/patid get - get user personal access token details
// /:soeid/pats/patid post - create a personal access token for user
// /:soeid/pats/patid delete - delete a personal access token for user

// /:soeid/projects get - list all user projects
app.get('/:soeid/projects', verifyToken, async (req: Request, res: Response) => {
    try {
        const soeid = req.params.soeid;
        const projects: Project[] = await wrapper.getUserProjects(soeid);
        return res.status(200).send(projects);
    } catch (error) {
        return res.status(500).send({ error: `Failed to list user projects: ${error}` });
    }
});

// /:soeid/workspaces get - list all user workspaces
app.get('/:soeid/workspaces', verifyToken, async (req: Request, res: Response) => {
    const soeid = req.params.soeid;
    await wrapper.listUserWorkspaces(soeid)
        .then((workspaces: Workspace[]) => {
            return res.status(200).send(workspaces);
        })
        .catch((error) => {
            return res.status(500).send({ error: `Failed to list workspaces: ${error}` });
        });
});

// /:soeid/workspaces/:id get - workspace details
app.get('/:soeid/workspaces/:id', verifyToken, async (req: Request, res: Response) => {
    const soeid = req.params.soeid;
    const workspaceId = req.params.id;
    await wrapper.getUserWorkspace(soeid, workspaceId)
        .then((workspace: Workspace) => {
            return res.status(200).send(workspace);
        })
        .catch((error) => {
            return res.status(500).send({ error: `Failed to get workspace: ${error}` });
        })
});

// /:soeid/workspaces post - create workspace
app.post('/:soeid/workspaces', verifyToken, async (req: Request, res: Response) => {
    if (!req.body) {
        return res.status(400).send({ error: 'Request body is missing!' });
    }
    if (!wrapper.verifyWorkspaceCreateBody(req.body)) {
        return res.status(400).send({ error: 'Request body does must contain devworkspaceValue and csiid!' });
    }
    const devworkspaceValue = req.body.devworkspaceValue;
    const csiid = req.body.csiid;
    const soeid = req.params.soeid;
    await wrapper.checkWorkspaceCount(soeid)
        .catch((error) => {
            if (error instanceof WorkspaceRunCountExceeded || error instanceof WorkspaceCountExceeded) {
                throw error;
            }
            throw new Error(`Failed to check running workspace count during workspace creation: ${error}`);
        })
        .then(() => {
            return wrapper.createUserWorkspace(soeid, csiid, devworkspaceValue);
        })
        .then((workspace: Workspace) => {
            return res.status(200).send(workspace);
        })
        .catch((error) => {
            if (error instanceof WorkspaceRunCountExceeded || error instanceof WorkspaceCountExceeded) {
                return res.status(409).send({ message: error.message });
            }
            if (error instanceof WorkspaceConfigNotFound) {
                return res.status(404).send({ error: `Workspace config not found with name: ${devworkspaceValue}`});
            }
            return res.status(500).send({ error: `Failed to create workspace: ${error}` });
        });
});

// /:soeid/workspaces/:id delete - delete workspace
app.delete('/:soeid/workspaces/:id', verifyToken, async (req: Request, res: Response) => {
    const soeid = req.params.soeid;
    const workspaceid = req.params.id;
    await wrapper.deleteUserWorkspace(soeid, workspaceid)
        .then(() => {
            return res.status(200).send( { message: `Workspace with id ${workspaceid} is terminating.`} );
        })
        .catch((error) => {
            return res.status(500).send({ error: `Failed to delete workspace: ${error}` });
        })
});

// /:soeid/workspaces/:id/start post - start workspace
app.post('/:soeid/workspaces/:id/start', verifyToken, async (req: Request, res: Response) => {
    const soeid = req.params.soeid;
    const workspaceid = req.params.id;
    await wrapper.checkWorkspaceCount(soeid)
        .catch((error) => {
            if (error instanceof WorkspaceRunCountExceeded || error instanceof WorkspaceCountExceeded) {
                throw error;
            }
            throw new Error(`Failed to check running workspace count during workspace start: ${error}`);
        })
        .then(() => {
            return wrapper.startUserWorkspace(soeid, workspaceid);
        })
        .then((workspace: Workspace) => {
            return res.status(200).send( { message: `Workspace with id ${workspaceid} is strating.`} );
        })
        .catch((error) => {
            if (error instanceof WorkspaceRunCountExceeded || error instanceof WorkspaceCountExceeded) {
                return res.status(409).send({ message: error.message });
            }
            return res.status(500).send({ error: `Failed to start workspace: ${error}` });
        })
});

// /:soeid/workspaces/:id/stop post - stop workspace
app.post('/:soeid/workspaces/:id/stop', verifyToken, async (req: Request, res: Response) => {
    const soeid = req.params.soeid;
    const workspaceid = req.params.id;
    await wrapper.stopUserWorkspace(soeid, workspaceid)
        .then((workspace: Workspace) => {
            return res.status(200).send( { message: `Workspace with id ${workspaceid} is stopping.`} );
        })
        .catch((error) => {
            return res.status(500).send({ error: `Failed to stop workspace: ${error}` });
        })
});

// These should not be endpoints, logic should be abstracted away from clients
// /:soeid/projects get - list all user projects
// /:soeid/projects post - create new user project

// Start listening
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
})

