import type {
  CacheConfig,
  CacheEntry,
  LocalCache,
} from "../types/cache.types.js";

export class MemoryCache implements LocalCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private cleanupTimer?: NodeJS.Timeout;
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
    this.startCleanupTimer();
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  // Get data even if expired (stale cache)
  getStale<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T, ttl?: number): void {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttl || 300000, // 5 minutes default
    };

    this.cache.set(key, entry);
    this.enforceMaxSize();
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  size(): number {
    return this.cache.size;
  }

  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry, now)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  // Cleanup with stale data retention for fallback scenarios
  cleanupWithStaleRetention(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    const staleThreshold = 24 * 60 * 60 * 1000; // Keep stale data for 24 hours

    for (const [key, entry] of this.cache.entries()) {
      // Only delete if data is older than TTL + stale threshold
      if (now - entry.timestamp > entry.ttl + staleThreshold) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  // Get cache statistics
  getStats(): {
    size: number;
    entries: Array<{ key: string; age: number; isExpired: boolean }>;
  } {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      age: now - entry.timestamp,
      isExpired: this.isExpired(entry, now),
    }));

    return {
      size: this.cache.size,
      entries,
    };
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.clear();
  }

  private isExpired(entry: CacheEntry<unknown>, now = Date.now()): boolean {
    return now - entry.timestamp > entry.ttl;
  }

  private enforceMaxSize(): void {
    if (this.cache.size <= this.config.maxSize) {
      return;
    }

    const entries = Array.from(this.cache.entries());
    entries.sort(([, a], [, b]) => a.timestamp - b.timestamp);

    const toDelete = entries.slice(0, entries.length - this.config.maxSize);
    for (const [key] of toDelete) {
      this.cache.delete(key);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      // Use stale retention cleanup for better offline capabilities
      this.cleanupWithStaleRetention();
    }, this.config.cleanupInterval);
  }
}
