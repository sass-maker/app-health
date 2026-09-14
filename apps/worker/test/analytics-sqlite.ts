/** Adapt the SQL-standard POSITION syntax to SQLite's equivalent INSTR. */
export function sqliteAnalyticsSql(sql: string) {
  return sql.replace(/position\('\.' IN (IF\([^()]+\))\)/g, "instr($1, '.')");
}
