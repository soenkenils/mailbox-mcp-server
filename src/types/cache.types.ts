export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface CacheOptions {
  ttl: number;
  maxSize?: number;
  cleanupInterval?: number;
}

export interface LocalCache {
  get<T>(key: string): T | null;
  set<T>(key: string, data: T, ttl?: number): void;
  delete(key: string): boolean;
  clear(): void;
  has(key: string): boolean;
  size(): number;
  cleanup(): void;
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
