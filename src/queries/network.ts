import { getDb, initAGE } from "../db/connection";

export interface NetworkNode {
  entityId: string;
  name: string;
  type: string;
}

export interface NetworkEdge {
  from: string;
  to: string;
  relationType: string;
  properties: Record<string, unknown>;
}

export interface NetworkResult {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

export async function getNetwork(entityId: string, depth: number = 2): Promise<NetworkResult> {
  const db = getDb();
  await initAGE();

  const nodes: Map<string, NetworkNode> = new Map();
  const edges: NetworkEdge[] = [];

  // Alle Pfade bis zur gewünschten Tiefe traversieren
  const result = await db.unsafe(
    `SELECT * FROM cypher('firmen_graph', $$
      MATCH path = (start {entity_id: '${entityId}'})-[*1..${depth}]-(connected)
      UNWIND relationships(path) as rel
      RETURN DISTINCT
        properties(startNode(rel)).entity_id,
        properties(endNode(rel)).entity_id,
        type(rel),
        properties(rel)
    $$) as (from_id agtype, to_id agtype, rel_type agtype, props agtype)`
  );

  // Entity-IDs sammeln
  const entityIds = new Set<string>();
  for (const row of result) {
    const fromId = JSON.parse(row.from_id as string) as string;
    const toId = JSON.parse(row.to_id as string) as string;
    const relType = JSON.parse(row.rel_type as string) as string;
    const props = JSON.parse(row.props as string) as Record<string, unknown>;

    entityIds.add(fromId);
    entityIds.add(toId);

    edges.push({ from: fromId, to: toId, relationType: relType, properties: props });
  }

  // Entity-Details aus relationaler Tabelle laden
  if (entityIds.size > 0) {
    const ids = Array.from(entityIds);
    const entities = await db.unsafe(
      `SELECT id, canonical_name, entity_type FROM entities WHERE id = ANY($1)`,
      [ids]
    );
    for (const e of entities) {
      nodes.set(e.id as string, {
        entityId: e.id as string,
        name: e.canonical_name as string,
        type: e.entity_type as string,
      });
    }
  }

  return { nodes: Array.from(nodes.values()), edges };
}

export async function getPersonNetwork(entityId: string) {
  const db = getDb();
  await initAGE();

  const result = await db.unsafe(
    `SELECT * FROM cypher('firmen_graph', $$
      MATCH (p {entity_id: '${entityId}'})-[r]->(f)
      RETURN f.entity_id, type(r), properties(r)
    $$) as (firma_id agtype, rel_type agtype, props agtype)`
  );

  const firmaIds = result.map((r) => JSON.parse(r.firma_id as string) as string);

  if (firmaIds.length === 0) return { firms: [], relations: result };

  const firms = await db.unsafe(
    `SELECT id, canonical_name, data FROM entities WHERE id = ANY($1)`,
    [firmaIds]
  );

  return {
    firms: firms.map((f) => ({
      id: f.id,
      name: f.canonical_name,
      data: f.data,
    })),
    relations: result.map((r) => ({
      firmaId: JSON.parse(r.firma_id as string),
      relationType: JSON.parse(r.rel_type as string),
      properties: JSON.parse(r.props as string),
    })),
  };
}
