import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Discover all .ovpn files in a directory, sorted alphabetically by filename.
 * @param {string} dir
 * @returns {Promise<Array<{ name: string, filePath: string }>>}
 */
export async function discoverProfiles(dir) {
  const resolvedDir = path.resolve(dir);
  let entries;
  try {
    entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Unable to read directory "${resolvedDir}": ${err.message}`);
  }

  const profiles = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith('.ovpn'))
    .map((entry) => ({
      name: entry.name,
      filePath: path.join(resolvedDir, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return profiles;
}
