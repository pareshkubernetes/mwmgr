import { Client } from 'pg';

let dbClient: Client | null = null;

const databaseTableName = process?.env.POSTGRES_DATABASE_TABLENAME || 'metrics."devspaces-metrics"';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

let dbClient: Client | null = null;

export const connectToDB = async (): Promise<Client> => {
    if (dbClient) {
        return dbClient;
    }

    const env = process.env.NODE_ENV || 'development'; // 'development', 'uat', 'production'

    const certMap: { [key: string]: string } = {
        development: 'dev.pem',
        uat: 'uat.pem',
        production: 'prod.pem'
    };

    const sslCertFile = certMap[env] || 'dev.pem';

    const certDir =
        env === 'development'
            ? path.resolve(__dirname, '../certs')  // for local run
            : '/app/backend/cert';                 // for production container

    const sslRootCertPath = path.join(certDir, sslCertFile);

    const DB_PORT: number = process.env.POSTGRES_PORT ? Number(process.env.POSTGRES_PORT) : 5432;
    const sslOptions =
    env === 'development'
        ? {
            rejectUnauthorized: true,
            checkServerIdentity: () => undefined, // bypass hostname check in local dev
            ca: fs.readFileSync(sslRootCertPath).toString()
        }
        : {
            rejectUnauthorized: true,
            ca: fs.readFileSync(sslRootCertPath).toString()
        };

    dbClient = new Client({
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        host: process.env.POSTGRES_HOSTNAME,
        port: DB_PORT,
        database: process.env.POSTGRES_DATABASE,
        ssl: sslOptions
    });

    try {
        await dbClient.connect();
        console.log(`✅ Connected to Postgres DB using ${sslCertFile}`);
    } catch (error) {
        dbClient = null;
        console.error('❌ Failed to connect to Postgres DB:', error);
        throw error;
    }

    return dbClient;
};


// ======================
// Below Code for NodeJS
// ======================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';

// __dirname workaround in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = process.env.NODE_ENV || 'development'; // 'development', 'uat', 'production'

const certMap = {
    development: 'dev.pem',
    uat: 'uat.pem',
    production: 'prod.pem'
};

const sslCertFile = certMap[env] || 'dev.pem';

const certDir =
    env === 'development'
        ? path.resolve(__dirname, '../certs')  // for local run
        : '/app/backend/cert';                 // for production container

const sslRootCertPath = path.join(certDir, sslCertFile);

const DB_PORT = process.env.POSTGRES_PORT ? Number(process.env.POSTGRES_PORT) : 5432;

const sslOptions = env === 'development'
    ? {
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined, // bypass hostname check in local dev
        ca: fs.readFileSync(sslRootCertPath).toString()
    }
    : {
        rejectUnauthorized: true,
        ca: fs.readFileSync(sslRootCertPath).toString()
    };

const dbClient = new Client({
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    host: process.env.POSTGRES_HOSTNAME,
    port: DB_PORT,
    database: process.env.POSTGRES_DATABASE,
    ssl: sslOptions
});

// Optional: connect and test
dbClient.connect()
    .then(() => console.log('Database connected successfully'))
    .catch(err => console.error('Database connection error:', err));


    