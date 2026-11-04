export function inList(column: string, values: readonly string[]): string {
  const quoted = values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ');
  return `"${column}" IN (${quoted})`;
}
