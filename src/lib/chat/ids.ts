/** Random id with a readable prefix. Uses crypto.randomUUID when the browser has it. */
export function newId(prefix: string): string {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${uuid}`;
}
