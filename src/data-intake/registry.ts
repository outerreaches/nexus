import type { DataSource } from "./types.js";

const SOURCES = new Map<string, DataSource>();

export function registerDataSource(source: DataSource): void {
  if (!source?.id) throw new Error("Data source must include an id");
  if (SOURCES.has(source.id)) throw new Error(`Data source already registered: ${source.id}`);
  SOURCES.set(source.id, source);
}

export function registerDataSources(sources: DataSource[]): void {
  for (const source of sources) {
    registerDataSource(source);
  }
}

export function listDataSources(): DataSource[] {
  return [...SOURCES.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getDataSource(id: string): DataSource | undefined {
  return SOURCES.get(id);
}

export function findDataSourcesByTag(tag: string): DataSource[] {
  const normalized = tag.trim().toLowerCase();
  return listDataSources().filter((source) => source.tags.map((t) => t.toLowerCase()).includes(normalized));
}
