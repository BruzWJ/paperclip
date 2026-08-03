const SIMPLE_CONFIG_PATH_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Preserve dotted paths for ordinary keys while encoding keys that contain
 * path syntax as JSON-string bracket segments. Existing simple identities
 * such as `env.API_KEY` remain stable and distinct JSON keys cannot collide.
 */
export function appendAdapterConfigPathKey(
  path: string,
  key: string,
): string {
  if (SIMPLE_CONFIG_PATH_KEY.test(key)) {
    return path ? `${path}.${key}` : key;
  }
  return `${path}[${JSON.stringify(key)}]`;
}

export function appendAdapterConfigPathIndex(
  path: string,
  index: number,
): string {
  return `${path}[${index}]`;
}

/**
 * Decode the first key from the canonical path grammar emitted above. A
 * top-level unsafe key is encoded as a JSON string bracket segment, while an
 * array index has no string root key.
 */
export function adapterConfigPathRootKey(
  path: string,
): string | null {
  if (!path) return null;
  if (!path.startsWith("[")) {
    const dot = path.indexOf(".");
    const bracket = path.indexOf("[");
    const end = [dot, bracket]
      .filter((index) => index >= 0)
      .reduce(
        (minimum, index) => Math.min(minimum, index),
        path.length,
      );
    return path.slice(0, end) || null;
  }
  if (path[1] !== '"') return null;

  let escaped = false;
  for (let index = 2; index < path.length; index += 1) {
    const character = path[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    if (path[index + 1] !== "]") return null;
    try {
      const decoded = JSON.parse(path.slice(1, index + 1));
      return typeof decoded === "string" ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function adapterConfigPathHasRootKey(
  path: string,
  rootKey: string,
): boolean {
  return adapterConfigPathRootKey(path) === rootKey;
}
