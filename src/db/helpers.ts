import { getDb } from "./connection";

export function escapeString(s: string): string {
  return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

export async function insertEntity(
  entityType: "firma" | "person",
  canonicalName: string,
  data: Record<string, unknown>
): Promise<string> {
  const db = getDb();
  const escapedName = escapeString(canonicalName);
  const jsonStr = escapeString(JSON.stringify(data));

  const result = await db.unsafe(
    `INSERT INTO entities (entity_type, canonical_name, data)
     VALUES ('${entityType}', '${escapedName}', '${jsonStr}'::jsonb)
     RETURNING id`
  );
  return result[0].id as string;
}

export async function updateEntityData(
  entityId: string,
  newData: Record<string, unknown>
) {
  if (Object.keys(newData).length === 0) return;
  const db = getDb();
  const jsonStr = escapeString(JSON.stringify(newData));
  await db.unsafe(
    `UPDATE entities SET data = data || '${jsonStr}'::jsonb, updated_at = now()
     WHERE id = '${entityId}'`
  );
}

export async function insertIdentifier(
  entityId: string,
  idType: string,
  idValue: string,
  qualifier: string | null,
  source: string
) {
  const db = getDb();
  const qualSql = qualifier ? `'${escapeString(qualifier)}'` : "NULL";
  await db.unsafe(
    `INSERT INTO entity_identifiers (entity_id, id_type, id_value, qualifier, source)
     VALUES ('${entityId}', '${escapeString(idType)}', '${escapeString(idValue)}', ${qualSql}, '${escapeString(source)}')
     ON CONFLICT (id_type, id_value, qualifier) DO NOTHING`
  );
}

export async function insertEvent(
  entityId: string,
  eventType: string,
  eventDate: string | null,
  payload: Record<string, unknown>,
  rawText: string | null,
  source: string
) {
  const db = getDb();
  const dateSql = eventDate ? `'${eventDate}'` : "NULL";
  const rawSql = rawText ? `'${escapeString(rawText)}'` : "NULL";
  const payloadStr = escapeString(JSON.stringify(payload));
  await db.unsafe(
    `INSERT INTO events (entity_id, event_type, event_date, payload, raw_text, source)
     VALUES ('${entityId}', '${escapeString(eventType)}', ${dateSql}, '${payloadStr}'::jsonb, ${rawSql}, '${escapeString(source)}')`
  );
}
