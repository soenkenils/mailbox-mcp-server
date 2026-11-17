import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the module at `importMetaUrl` is the process entry point.
 *
 * argv[1] is resolved through symlinks (npm `bin` links point to it) and
 * converted with pathToFileURL, which also handles Windows drive letters,
 * spaces and non-ASCII characters. A missing or unresolvable argv[1] means
 * "not main" instead of throwing at import time.
 */
export function isMainModule(
  importMetaUrl: string,
  argv1: string | undefined,
): boolean {
  if (!argv1) {
    return false;
  }
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
