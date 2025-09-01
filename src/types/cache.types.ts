export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
  priority: CachePriority;
  size?: number; // Estimated size in bytes
}

export enum CachePriority {
  LOW = 1,
  NORMAL = 2,
  HIGH = 3,
  CRITICAL = 4,
}

export interface CacheOptions {
  ttl: number;
  maxSize?: number;
  cleanupInterval?: number;
}

export interface LocalCache {
  get<T>(key: string): T | null;
  getStale<T>(key: string): T | null;
  set<T>(key: string, data: T, ttl?: number, priority?: CachePriority): void;
  delete(key: string): boolean;
  clear(): void;
  has(key: string): boolean;
  size(): number;
  cleanup(): void;
  getStats(): CacheStats;
}

export interface CacheStats {
  size: number;
  hitRate: number;
  missRate: number;
  evictionRate: number;
  averageAge: number;
  memoryUsage: number;
  entries: Array<{
    key: string;
    age: number;
    accessCount: number;
    priority: CachePriority;
    isExpired: boolean;
  }>;
}

export interface CacheConfig {
  email: {
    searchTtl: number;
    messageTtl: number;
    threadTtl: number;
  };
  calendar: {
    eventsTtl: number;
    freeBusyTtl: number;
  };
  maxSize: number;
  cleanupInterval: number;
}
