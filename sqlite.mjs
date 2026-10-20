// No native dependency, npm install, or compilation. Each runtime uses its own SQLite.
const sqlite = await import(process.versions.bun ? "bun:sqlite" : "node:sqlite");
export const sqliteBackend = process.versions.bun ? "bun:sqlite" : "node:sqlite";

export function openReadOnlyDatabase(file) {
  if (process.versions.bun) return new sqlite.Database(file, { readonly: true, create: false });
  const Database = sqlite.DatabaseSync ?? sqlite.Database;
  return new Database(file, { readOnly: true });
}
