import { join, normalize, resolve, sep } from 'node:path';

/** Resolves a URL path inside `root`, refusing anything that escapes it. */
export function staticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = resolve(join(root, normalize(decoded)));
  return file.startsWith(root + sep) ? file : null;
}
