import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import fs from "fs";
import path from "path";
import { DataType, newDb } from "pg-mem";
import { randomUUID } from "crypto";

const { Pool } = pg;

let pool: any;
let db: ReturnType<typeof drizzle>;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const isRds = process.env.DATABASE_URL.includes("rds.amazonaws.com");
const requireSsl = process.env.DB_SSL === "true" || isRds;
const useMemDb = process.env.USE_MEM_DB === "true";

if (useMemDb) {
  console.log("⚠️  Using in-memory database fallback (RDS detected/requested)");
  
  const memDb = newDb();
  
  // Register missing functions
  memDb.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    implementation: () => randomUUID()
  });

  // Create the PG adapter
  const { Pool: MemPool } = memDb.adapters.createPg();
  pool = new MemPool();

  // Patch pool to support what Drizzle expects
  const originalQuery = pool.query.bind(pool);
  pool.query = async (text: any, params: any, callback: any) => {
    // Drizzle passes (config, values, callback) or (text, values, callback)
    if (typeof text === 'object' && text !== null) {
      // If it has rowMode, remove it as pg-mem doesn't support it
      // Also remove types/getTypeParser if present as pg-mem throws if they exist
      const { rowMode, types, getTypeParser, ...rest } = text;
      return originalQuery(rest, params, callback);
    }
    return originalQuery(text, params, callback);
  };

  const originalConnect = pool.connect.bind(pool);
  
  // Mock getTypeParser on the pool itself as pg-mem's query method might check it
  (pool as any).getTypeParser = () => (val: any) => val;

  pool.connect = async (...args: any[]) => {
    const client = await originalConnect(...args);
    // Mock getTypeParser if missing
    if (!client.getTypeParser) {
      client.getTypeParser = () => (val: any) => val;
    }
    return client;
  };

  db = drizzle(pool, { schema });
  
  // Run migrations
  try {
    const migrationPath = path.join(process.cwd(), "migrations", "0000_confused_the_liberteens.sql");
    if (fs.existsSync(migrationPath)) {
        const migrationSql = fs.readFileSync(migrationPath, "utf-8");
        
        // Split and execute
        const statements = migrationSql.split("--> statement-breakpoint");
        for (const stmt of statements) {
            if (stmt.trim()) {
                // Remove unsupported syntax if any (e.g. specialized indexes not supported by pg-mem)
                // pg-mem is quite robust but sometimes fails on specific postgres extensions
                try {
                    memDb.public.query(stmt);
                } catch (e) {
                    console.warn(`Warning: Failed to execute migration statement: ${stmt.substring(0, 50)}...`, e);
                }
            }
        }
        
        // Create session table for connect-pg-simple
        try {
            memDb.public.query(`
            CREATE TABLE "session" (
                "sid" varchar NOT NULL,
                "sess" json NOT NULL,
                "expire" timestamp(6) NOT NULL,
                CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
            );
            CREATE INDEX "IDX_session_expire" ON "session" ("expire");
            `);
        } catch (e) {
             console.warn("Warning: Failed to create session table", e);
        }

        console.log("✅ In-memory database initialized and migrated");
    } else {
        console.error("❌ Migration file not found at", migrationPath);
    }
  } catch (err) {
    console.error("Failed to initialize memory DB:", err);
  }

} else {
  pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: false,
    ssl: process.env.NODE_ENV === "production" || requireSsl
      ? { rejectUnauthorized: false } 
      : undefined,
  });
  
  pool.on('error', (err: any) => {
    console.error('Unexpected database pool error:', err.message);
  });
  
  pool.on('connect', () => {
    console.log('Database connection established');
  });
  
  db = drizzle(pool, { schema });
}

export { pool, db };
