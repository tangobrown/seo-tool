import "server-only";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import ws from "ws";
import * as schema from "./schema";

function isNeon(url: string) {
  return /\.neon\.tech|\.neon\.build/.test(url);
}

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (isNeon(url)) {
    // WebSocket pool so interactive transactions work (needed for batch approval).
    neonConfig.webSocketConstructor = ws;
    return drizzleNeon({ client: new NeonPool({ connectionString: url }), schema });
  }
  // Local / CI Postgres.
  return drizzlePg({ client: new pg.Pool({ connectionString: url, max: 5 }), schema }) as unknown as ReturnType<
    typeof drizzleNeon<typeof schema>
  >;
}

const globalForDb = globalThis as unknown as { __db?: ReturnType<typeof create> };

export const db = globalForDb.__db ?? (globalForDb.__db = create());
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };
