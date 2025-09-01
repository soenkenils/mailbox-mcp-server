import type {
  CacheConfig,
  CacheEntry,
  CachePriority,
  CacheStats,
  LocalCache,
} from "../types/cache.types.js";

export class MemoryCache implements LocalCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private cleanupTimer?: NodeJS.Timeout;
  private config: CacheConfig;
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(config: CacheConfig) {
    this.config = config;
    this.startCleanupTimer();
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();

    // Adaptive TTL: extend TTL for frequently accessed items
    if (entry.accessCount > 3 && entry.priority >= 2) {
      entry.ttl = Math.min(entry.ttl * 1.2, entry.ttl + 300000); // Max 5 min extension
    }

    this.stats.hits++;
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

  set<T>(
    key: string,
    data: T,
    ttl?: number,
    priority: CachePriority = 2,
  ): void {
    const now = Date.now();
    const entry: CacheEntry<T> = {
      data,
      timestamp: now,
      ttl: ttl || 300000, // 5 minutes default
      accessCount: 0,
      lastAccessed: now,
      priority: priority,
      size: this.estimateSize(data),
    };

    this.cache.set(key, entry);
    this.enforceMaxSizeWithPriority();
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

  // Get comprehensive cache statistics
  getStats(): CacheStats {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      age: now - entry.timestamp,
      accessCount: entry.accessCount,
      priority: entry.priority,
      isExpired: this.isExpired(entry, now),
    }));

    const totalOperations = this.stats.hits + this.stats.misses;
    const totalAge = entries.reduce((sum, entry) => sum + entry.age, 0);
    const totalMemory = Array.from(this.cache.values()).reduce(
      (sum, entry) => sum + (entry.size || 0),
      0,
    );

    return {
      size: this.cache.size,
      hitRate: totalOperations > 0 ? this.stats.hits / totalOperations : 0,
      missRate: totalOperations > 0 ? this.stats.misses / totalOperations : 0,
      evictionRate:
        this.cache.size > 0 ? this.stats.evictions / this.cache.size : 0,
      averageAge: entries.length > 0 ? totalAge / entries.length : 0,
      memoryUsage: totalMemory,
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

  private enforceMaxSizeWithPriority(): void {
    if (this.cache.size <= this.config.maxSize) {
      return;
    }

    const entries = Array.from(this.cache.entries());

    // Priority-based eviction algorithm
    // Score = priority * access_frequency + age_factor
    entries.sort(([keyA, entryA], [keyB, entryB]) => {
      const now = Date.now();
      const scoreA = this.calculateEvictionScore(entryA, now);
      const scoreB = this.calculateEvictionScore(entryB, now);
      return scoreA - scoreB; // Lower score = evict first
    });

    const toDelete = entries.slice(0, entries.length - this.config.maxSize);
    for (const [key] of toDelete) {
      this.cache.delete(key);
      this.stats.evictions++;
    }
  }

  private calculateEvictionScore(
    entry: CacheEntry<unknown>,
    now: number,
  ): number {
    const age = now - entry.timestamp;
    const timeSinceAccess = now - entry.lastAccessed;

    // Higher priority = higher score (less likely to be evicted)
    const priorityScore = entry.priority * 10;

    // More access = higher score (less likely to be evicted)
    const accessScore = Math.log(entry.accessCount + 1) * 5;

    // Recent access = higher score (less likely to be evicted)
    const freshnessScore = 1000000 / (timeSinceAccess + 1000);

    // Age penalty (older = lower score)
    const agePenalty = age / 100000;

    return priorityScore + accessScore + freshnessScore - agePenalty;
  }

  private estimateSize<T>(data: T): number {
    try {
      return JSON.stringify(data).length * 2; // Rough estimate (2 bytes per char)
    } catch {
      return 1000; // Default size if can't serialize
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      // Use stale retention cleanup for better offline capabilities
      this.cleanupWithStaleRetention();
    }, this.config.cleanupInterval);
  }
}
