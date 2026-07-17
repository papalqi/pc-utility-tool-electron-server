/**
 * Per-user config documents with optimistic concurrency (revision).
 */

import { v4 as uuidv4 } from 'uuid'
import type { PoolClient } from 'pg'
import { query, withTransaction } from '../db/pool'
import { logger } from '../utils/logger'

// query used by batchSync audit outside transaction

const log = logger.createScope('ConfigDocumentService')

export const DOC_TYPES = [
  'app_prefs',
  'service_endpoints',
  'integrations',
  'automation',
  'fleet_catalog',
  'secrets',
] as const

export type DocType = (typeof DOC_TYPES)[number]

export type ConfigDocument = {
  docType: string
  profile: string
  revision: number
  schemaVersion: number
  payload: Record<string, unknown>
  updatedByDeviceId: string | null
  updatedAt: string
}

function isDocType(v: string): v is DocType {
  return (DOC_TYPES as readonly string[]).includes(v)
}

export async function listDocumentMeta(userId: string, profile = 'default') {
  const res = await query<{
    doc_type: string
    revision: string
    schema_version: number
    updated_at: Date
  }>(
    `SELECT doc_type, revision, schema_version, updated_at
     FROM config_documents
     WHERE user_id = $1 AND profile = $2
     ORDER BY doc_type`,
    [userId, profile]
  )
  return res.rows.map((r) => ({
    docType: r.doc_type,
    revision: Number(r.revision),
    schemaVersion: r.schema_version,
    updatedAt: r.updated_at.toISOString(),
  }))
}

export async function getDocument(
  userId: string,
  docType: string,
  profile = 'default'
): Promise<ConfigDocument | null> {
  const res = await query<{
    doc_type: string
    profile: string
    revision: string
    schema_version: number
    payload: Record<string, unknown>
    updated_by_device_id: string | null
    updated_at: Date
  }>(
    `SELECT doc_type, profile, revision, schema_version, payload, updated_by_device_id, updated_at
     FROM config_documents
     WHERE user_id = $1 AND profile = $2 AND doc_type = $3
     LIMIT 1`,
    [userId, profile, docType]
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    docType: row.doc_type,
    profile: row.profile,
    revision: Number(row.revision),
    schemaVersion: row.schema_version,
    payload: row.payload || {},
    updatedByDeviceId: row.updated_by_device_id,
    updatedAt: row.updated_at.toISOString(),
  }
}

export class ConfigConflictError extends Error {
  constructor(
    readonly current: ConfigDocument
  ) {
    super('Config document revision conflict')
    this.name = 'ConfigConflictError'
  }
}

export class MissingBaseRevisionError extends Error {
  constructor(readonly current: ConfigDocument) {
    super('Missing baseRevision for existing document')
    this.name = 'MissingBaseRevisionError'
  }
}

export async function putDocument(input: {
  userId: string
  docType: string
  profile?: string
  payload: Record<string, unknown>
  schemaVersion?: number
  baseRevision?: number | null
  deviceId?: string
}): Promise<ConfigDocument> {
  if (!isDocType(input.docType)) {
    throw new Error(`Unsupported docType: ${input.docType}`)
  }

  const profile = input.profile || 'default'
  const schemaVersion = input.schemaVersion ?? 1

  return withTransaction(async (client) => {
    const existing = await client.query<{
      id: string
      revision: string
      schema_version: number
      payload: Record<string, unknown>
      updated_by_device_id: string | null
      updated_at: Date
      profile: string
      doc_type: string
    }>(
      `SELECT id, revision, schema_version, payload, updated_by_device_id, updated_at, profile, doc_type
       FROM config_documents
       WHERE user_id = $1 AND profile = $2 AND doc_type = $3
       FOR UPDATE`,
      [input.userId, profile, input.docType]
    )

    if (!existing.rows[0]) {
      const id = uuidv4()
      const revision = 1
      const ins = await client.query<{
        doc_type: string
        profile: string
        revision: string
        schema_version: number
        payload: Record<string, unknown>
        updated_by_device_id: string | null
        updated_at: Date
      }>(
        `INSERT INTO config_documents
           (id, user_id, profile, doc_type, revision, payload, schema_version, updated_by_device_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
         RETURNING doc_type, profile, revision, schema_version, payload, updated_by_device_id, updated_at`,
        [
          id,
          input.userId,
          profile,
          input.docType,
          revision,
          JSON.stringify(input.payload ?? {}),
          schemaVersion,
          input.deviceId || null,
        ]
      )
      await insertRevision(client, {
        documentId: id,
        revision,
        payload: input.payload ?? {},
        schemaVersion,
        deviceId: input.deviceId,
        clientBaseRevision: input.baseRevision ?? null,
      })
      await audit(client, input.userId, 'push', input.docType, input.deviceId, {
        revision,
        created: true,
      })
      const row = ins.rows[0]
      return mapRow(row)
    }

    const cur = existing.rows[0]
    const currentRevision = Number(cur.revision)
    const currentDoc: ConfigDocument = {
      docType: cur.doc_type,
      profile: cur.profile,
      revision: currentRevision,
      schemaVersion: cur.schema_version,
      payload: cur.payload || {},
      updatedByDeviceId: cur.updated_by_device_id,
      updatedAt: cur.updated_at.toISOString(),
    }

    if (input.baseRevision === undefined || input.baseRevision === null) {
      throw new MissingBaseRevisionError(currentDoc)
    }
    if (Number(input.baseRevision) !== currentRevision) {
      throw new ConfigConflictError(currentDoc)
    }

    const nextRevision = currentRevision + 1
    const upd = await client.query<{
      doc_type: string
      profile: string
      revision: string
      schema_version: number
      payload: Record<string, unknown>
      updated_by_device_id: string | null
      updated_at: Date
    }>(
      `UPDATE config_documents SET
         revision = $1,
         payload = $2::jsonb,
         schema_version = $3,
         updated_by_device_id = $4,
         updated_at = now()
       WHERE id = $5
       RETURNING doc_type, profile, revision, schema_version, payload, updated_by_device_id, updated_at`,
      [
        nextRevision,
        JSON.stringify(input.payload ?? {}),
        schemaVersion,
        input.deviceId || null,
        cur.id,
      ]
    )
    await insertRevision(client, {
      documentId: cur.id,
      revision: nextRevision,
      payload: input.payload ?? {},
      schemaVersion,
      deviceId: input.deviceId,
      clientBaseRevision: input.baseRevision,
    })
    await audit(client, input.userId, 'push', input.docType, input.deviceId, {
      revision: nextRevision,
      baseRevision: input.baseRevision,
    })
    log.info('Document updated', {
      userId: input.userId,
      docType: input.docType,
      revision: nextRevision,
    })
    return mapRow(upd.rows[0])
  })
}

export async function batchSync(input: {
  userId: string
  profile?: string
  deviceId?: string
  known?: Record<string, number>
  push?: Array<{
    docType: string
    baseRevision?: number | null
    schemaVersion?: number
    payload: Record<string, unknown>
  }>
}) {
  const profile = input.profile || 'default'
  const known = input.known || {}
  const pull: Record<string, ConfigDocument> = {}

  // pull docs that are newer than known
  for (const docType of DOC_TYPES) {
    const doc = await getDocument(input.userId, docType, profile)
    if (!doc) continue
    const clientRev = known[docType]
    if (clientRev === undefined || clientRev < doc.revision) {
      pull[docType] = doc
    }
  }

  const pushResults: Record<string, { ok: true; revision: number } | { ok: false; error: string; current?: ConfigDocument }> =
    {}
  const conflicts: Array<{ docType: string; current: ConfigDocument }> = []

  for (const item of input.push || []) {
    try {
      const saved = await putDocument({
        userId: input.userId,
        docType: item.docType,
        profile,
        payload: item.payload,
        schemaVersion: item.schemaVersion,
        baseRevision: item.baseRevision,
        deviceId: input.deviceId,
      })
      pushResults[item.docType] = { ok: true, revision: saved.revision }
      // if we also had pull for same doc, replace with just-written
      pull[item.docType] = saved
    } catch (err) {
      if (err instanceof ConfigConflictError) {
        pushResults[item.docType] = { ok: false, error: 'conflict', current: err.current }
        conflicts.push({ docType: item.docType, current: err.current })
        pull[item.docType] = err.current
      } else if (err instanceof MissingBaseRevisionError) {
        pushResults[item.docType] = {
          ok: false,
          error: 'missing_base_revision',
          current: err.current,
        }
        conflicts.push({ docType: item.docType, current: err.current })
        pull[item.docType] = err.current
      } else {
        pushResults[item.docType] = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
  }

  await query(
    `INSERT INTO config_audit_log (user_id, action, device_id, detail)
     VALUES ($1, 'sync', $2, $3::jsonb)`,
    [
      input.userId,
      input.deviceId || null,
      JSON.stringify({
        pullKeys: Object.keys(pull),
        pushKeys: Object.keys(pushResults),
        conflictCount: conflicts.length,
      }),
    ]
  )

  return { pull, pushResults, conflicts }
}

async function insertRevision(
  client: PoolClient,
  input: {
    documentId: string
    revision: number
    payload: Record<string, unknown>
    schemaVersion: number
    deviceId?: string
    clientBaseRevision: number | null
  }
) {
  await client.query(
    `INSERT INTO config_document_revisions
       (document_id, revision, payload, schema_version, device_id, client_base_revision)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      input.documentId,
      input.revision,
      JSON.stringify(input.payload),
      input.schemaVersion,
      input.deviceId || null,
      input.clientBaseRevision,
    ]
  )
}

async function audit(
  client: PoolClient,
  userId: string,
  action: string,
  docType: string | undefined,
  deviceId: string | undefined,
  detail: Record<string, unknown>
) {
  await client.query(
    `INSERT INTO config_audit_log (user_id, action, doc_type, device_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, action, docType || null, deviceId || null, JSON.stringify(detail)]
  )
}

function mapRow(row: {
  doc_type: string
  profile: string
  revision: string
  schema_version: number
  payload: Record<string, unknown>
  updated_by_device_id: string | null
  updated_at: Date
}): ConfigDocument {
  return {
    docType: row.doc_type,
    profile: row.profile,
    revision: Number(row.revision),
    schemaVersion: row.schema_version,
    payload: row.payload || {},
    updatedByDeviceId: row.updated_by_device_id,
    updatedAt: row.updated_at.toISOString(),
  }
}

