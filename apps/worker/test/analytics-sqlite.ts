/** Adapt the SQL-standard POSITION syntax to SQLite's equivalent INSTR. */
export function sqliteAnalyticsSql(sql: string) {
  return sql.replaceAll(
    "position('.' IN IF(blob10!='',blob10,blob6))",
    "instr(IF(blob10!='',blob10,blob6), '.')",
  );
}
