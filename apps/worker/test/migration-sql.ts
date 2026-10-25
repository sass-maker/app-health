export function splitMigrationSql(sql: string) {
  const source = sql.replace(/--[^\n]*/g, '');
  const statements = [];
  let start = 0;
  let trigger = false;
  let singleQuote = false;
  let doubleQuote = false;
  let backtick = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'" && !doubleQuote && !backtick && source[index - 1] !== '\\')
      singleQuote = !singleQuote;
    if (character === '"' && !singleQuote && !backtick && source[index - 1] !== '\\')
      doubleQuote = !doubleQuote;
    if (character === '`' && !singleQuote && !doubleQuote) backtick = !backtick;
    if (character !== ';' || singleQuote || doubleQuote || backtick) continue;

    const statement = source.slice(start, index).trim();
    if (!trigger && /\bCREATE\s+TRIGGER\b/i.test(statement)) trigger = true;
    if (trigger) {
      const unquoted = statement.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`/g, '');
      const blocks = unquoted.match(/\b(?:BEGIN|CASE|END)\b/gi) ?? [];
      const depth = blocks.reduce(
        (value, block) => value + (block.toUpperCase() === 'END' ? -1 : 1),
        0,
      );
      // CASE ... END can end a statement without ending the surrounding trigger.
      if (depth !== 0 || !/\bEND\s*$/i.test(unquoted)) continue;
    }
    if (statement) statements.push(statement);
    start = index + 1;
    trigger = false;
  }
  const tail = source.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
