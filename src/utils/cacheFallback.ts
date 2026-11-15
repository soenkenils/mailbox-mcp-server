import type { LoggerLike } from "../services/Logger.js";
import type { LocalCache } from "../types/cache.types.js";
import { ConnectionError } from "../types/errors.js";

/**
 * Value to return when a connection error leaves nothing cached. Omit it to
 * rethrow the error instead, for operations where a placeholder would be
 * misread (e.g. null as "not found").
 */
export interface CacheFallback<T> {
  defaultValue: T;
}

/**
 * Creates a cache-first fetcher bound to a specific cache, logger, and service name.
 *
 * The returned function:
 * 1. Returns fresh cached data if available
 * 2. Fetches fresh data and caches it on success (when a TTL is given)
 * 3. On connection errors: returns stale cache if there is any, otherwise
 *    the fallback's defaultValue, otherwise rethrows
 * 4. On other errors: rethrows
 */
export function createCacheFetcher(
  cache: LocalCache,
  logger: LoggerLike,
  service: string,
) {
  return async <T>(
    cacheKey: string,
    fetch: () => Promise<T>,
    operation: string,
    ttl?: number,
    fallback?: CacheFallback<T>,
  ): Promise<T> => {
    const cached = cache.get<T>(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const freshData = await fetch();
      if (ttl) {
        cache.set(cacheKey, freshData, ttl);
      }
      return freshData;
    } catch (error) {
      logger.error(
        `Error in ${operation}`,
        { operation, service },
        { error: error instanceof Error ? error.message : String(error) },
      );

      if (isConnectionError(error)) {
        const staleData = cache.getStale<T>(cacheKey);
        if (staleData) {
          logger.warning(
            "Returning stale cached data due to connection failure",
            { operation, service },
          );
          return staleData;
        }

        if (fallback) {
          logger.warning(
            "No cached data available, returning default value due to connection failure",
            { operation, service },
          );
          return fallback.defaultValue;
        }
      }

      throw error;
    }
  };
}

/**
 * Options for {@link withCacheFallback}.
 */
export interface CacheFallbackOptions<T> {
  cacheKey: string;
  cache: LocalCache;
  fetch: () => Promise<T>;
  /** See {@link CacheFallback}; omit it to rethrow connection errors. */
  defaultValue?: T;
  logger: LoggerLike;
  operation: string;
  service: string;
  ttl?: number;
  /** No longer logged; accepted so existing callers still compile. */
  logContext?: Record<string, unknown>;
}

/**
 * One-shot form of {@link createCacheFetcher}.
 *
 * @deprecated Use createCacheFetcher. Kept for CalendarService until it
 * moves over (it is being changed in an open PR).
 */
export function withCacheFallback<T>(
  options: CacheFallbackOptions<T>,
): Promise<T> {
  const { cache, logger, service, cacheKey, fetch, operation, ttl } = options;
  return createCacheFetcher(cache, logger, service)(
    cacheKey,
    fetch,
    operation,
    ttl,
    "defaultValue" in options
      ? { defaultValue: options.defaultValue as T }
      : undefined,
  );
}

/**
 * Determines if an error is a connection-related error
 */
function isConnectionError(error: unknown): boolean {
  if (error instanceof ConnectionError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("connection") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("network") ||
    message.includes("socket")
  );
}
