import { Client } from 'pg';

// Function to connect to the database
let dbClient: Client | null = null;
export const connectToDB = async (): Promise<Client> => {
    if (dbClient) {
        return dbClient;
    }
    const DB_PORT = number | undefined = process?.env?.POSTGRES_PORT ? Number(process.env.POSTGRES_PORT) : undefined;
    dbClient = new Client({
        user: 'vk34543',
        password: 'Admin123',
        host: 'sd-nvct-d4xs',
        port: 5432,
        database: 'postgres',
    });
    try {
        await dbClient.connect();
        console.log('Connected to PostgreSQL database.');
        return dbClient;
    } catch (error) {
        console.error('Database connection error:', error);
        dbClient = null;
        throw error;
    }
};

// Arrow function to write a new record into the database
const writeRecord = async (
    timestamp: string,
    csiid: string,
    eventtype: string,
    resourcename: string,
    resourcetype: string,
    status: object
): Promise<void> => {
    const queryText = `
        INSERT INTO metrics."devspaces-metrics" 
        (timestamp, csiid, eventtype, resourcename, resourcetype, status) 
        VALUES ($1, $2, $3, $4, $5, $6)
    `;
    const values = [timestamp, csiid, eventtype, resourcename, resourcetype, JSON.stringify(status)];

    try {
        const result = await client.query(queryText, values);
        console.log('Record inserted successfully:', result.rowCount);
    } catch (error) {
        console.error('Error inserting record:', error);
    }
};

// Ensure database connection is established before running queries
(async () => {
    try {
        await connectToDB();
    } catch (error) {
        process.exit(1); // Exit the process if the database connection fails
    }
})();

// Example usage of writeRecord function
// Replace these values with your own
(async () => {
    try {
        await writeRecord(
            new Date().toISOString().replace('T', ' ').replace('Z', ' '),
            '177398',
            'delete',
            'citi-ansible',
            'workspace',
            { failed: false, error: '' }
        );
    } catch (error) {
        console.error('Error in writeRecord function:', error);
    } finally {
        await client.end(); // Close the database connection
    }
})();

