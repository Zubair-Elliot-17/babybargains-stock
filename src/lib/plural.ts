// "1 unit", "3 units", "1 branch", "2 branches".
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
