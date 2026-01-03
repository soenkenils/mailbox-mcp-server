import type { LocalCache } from "../types/cache.types.js";
import { ConnectionError } from "../types/errors.js";
import type { Logger } from "../services/Logger.js";

/**
 * Options for cache fallback operations
 */
export interface CacheFallbackOptions<T> {
  /**
   * Unique cache key for storing/retrieving data
   */
  cacheKey: string;

  /**
   * Cache instance to use
   */
  cache: LocalCache;

  /**
   * Function to fetch fresh data
   */
  fetch: () => Promise<T>;

  /**
   * Default value to return if all fallbacks fail (connection errors only)
   */
  defaultValue: T;

  /**
   * Logger instance for logging warnings and errors
   */
  logger: Logger;

  /**
   * Operation name for logging context
   */
  operation: string;

  /**
   * Service name for logging context
   */
  service: string;

  /**
   * Time-to-live for cached data in milliseconds
   */
  ttl?: number;

  /**
   * Additional context for logging (optional)
   */
  logContext?: Record<string, unknown>;
}

/**
 * Executes an operation with cache-first strategy and fallback handling.
 *
 * Flow:
 * 1. Check cache for fresh data → return if found
 * 2. Try to fetch fresh data → cache and return if successful
 * 3. On error:
 *    - If connection error:
 *      a. Try stale cache → return if found
 *      b. Return default value if no stale cache
 *    - If other error: throw
 *
 * @param options - Configuration for the cached operation
 * @returns The cached, fresh, stale, or default data
 */
export async function withCacheFallback<T>(
  options: CacheFallbackOptions<T>,
): Promise<T> {
  const {
    cacheKey,
    cache,
    fetch,
    defaultValue,
    logger,
    operation,
    service,
    ttl,
    logContext = {},
  } = options;

  // Check for fresh cached data
  const cached = cache.get<T>(cacheKey);
  if (cached) {
    return cached;
  }

  // Try to get fresh data
  try {
    const freshData = await fetch();

    // Cache the fresh data if TTL is provided
    if (ttl) {
      cache.set(cacheKey, freshData, ttl);
    }

    return freshData;
  } catch (error) {
    // Log the error
    await logger.error(
      `Error in ${operation}`,
      { operation, service },
      {
        error: error instanceof Error ? error.message : String(error),
        ...logContext,
      },
    );

    // Only use fallback for connection errors
    if (isConnectionError(error)) {
      // Try to return stale cached data
      const staleData = cache.getStale<T>(cacheKey);
      if (staleData) {
        await logger.warning(
          `Returning stale cached data due to connection failure`,
          { operation, service },
          { cacheKey, ...logContext },
        );
        return staleData;
      }

      // Return default value if no stale cache available
      await logger.warning(
        `No cached data available, returning default value due to connection failure`,
        { operation, service },
        { ...logContext },
      );
      return defaultValue;
    }

    // For non-connection errors, rethrow
    throw error;
  }
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
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("network") ||
    message.includes("socket")
  );
}
