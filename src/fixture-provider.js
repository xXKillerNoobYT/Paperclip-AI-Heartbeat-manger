import { readFile } from 'node:fs/promises';

export async function readFixtureUsage(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.usageSnapshots)) return parsed.usageSnapshots;
  return [parsed];
}
