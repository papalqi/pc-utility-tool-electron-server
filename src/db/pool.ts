import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { logger } from '../utils/logger'

const log = logger.createScope('DbPool')

let pool: Pool | null = null

export function isControlPlaneDbEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim())
}

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL?.trim()
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set')
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
    })
    pool.on('error', (err) => {
      log.error('Unexpected PG pool error', err)
    })
    log.info('PostgreSQL pool created')
  }
  return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params)
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    client.release()
  }
}

export async function checkDbHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!isControlPlaneDbEnabled()) {
    return { ok: false, error: 'DATABASE_URL not configured' }
  }
  const started = Date.now()
  try {
    await query('SELECT 1 AS ok')
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
