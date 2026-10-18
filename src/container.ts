/**
 * Dependency Injection Container
 *
 * Provides centralized service instantiation, dependency resolution, and lifecycle management.
 * Supports both singleton and transient lifetimes, constructor injection, and circular dependency detection.
 */

export type ServiceLifetime = 'singleton' | 'transient';

export interface ServiceDescriptor<T = any> {
  name: string;
  factory: (container: Container) => T;
  lifetime: ServiceLifetime;
  instance?: T;
}

export class Container {
  private services = new Map<string, ServiceDescriptor>();
  private resolutionStack: string[] = [];

  /**
   * Register a service with the container
   */
  register<T>(
    name: string,
    factory: (container: Container) => T,
    lifetime: ServiceLifetime = 'singleton',
  ): void {
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" is already registered`);
    }

    this.services.set(name, {
      name,
      factory,
      lifetime,
    });
  }

  /**
   * Resolve a service by name with circular dependency detection
   */
  resolve<T>(name: string): T {
    const descriptor = this.services.get(name);

    if (!descriptor) {
      throw new Error(`Service "${name}" not found in container`);
    }

    // Circular dependency detection
    if (this.resolutionStack.includes(name)) {
      const cycle = [...this.resolutionStack, name].join(' -> ');
      throw new Error(`Circular dependency detected: ${cycle}`);
    }

    // Return existing singleton instance
    if (descriptor.lifetime === 'singleton' && descriptor.instance) {
      return descriptor.instance as T;
    }

    // Track resolution for circular dependency detection
    this.resolutionStack.push(name);

    try {
      const instance = descriptor.factory(this);

      // Cache singleton instance
      if (descriptor.lifetime === 'singleton') {
        descriptor.instance = instance;
      }

      return instance as T;
    } finally {
      this.resolutionStack.pop();
    }
  }

  /**
   * Check if a service is registered
   */
  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Clear a specific service instance (useful for testing)
   */
  clear(name: string): void {
    const descriptor = this.services.get(name);
    if (descriptor) {
      descriptor.instance = undefined;
    }
  }

  /**
   * Clear all service instances (useful for testing)
   */
  clearAll(): void {
    this.services.forEach((descriptor) => {
      descriptor.instance = undefined;
    });
  }

  /**
   * Get all registered service names
   */
  getRegisteredServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Create a scoped container for testing with mock services
   */
  createScope(): Container {
    const scopedContainer = new Container();

    // Copy service registrations to scoped container
    this.services.forEach((descriptor, name) => {
      scopedContainer.services.set(name, {
        ...descriptor,
        instance: undefined, // Don't copy singleton instances
      });
    });

    return scopedContainer;
  }
}

/**
 * Global container instance
 */
export const container = new Container();

/**
 * Service name constants for type safety
 */
export const SERVICE_NAMES = {
  // Core services
  USER_SERVICE: 'UserService',
  AUTH_SERVICE: 'AuthService',
  SONG_SERVICE: 'SongService',
  ALBUM_SERVICE: 'AlbumService',
  GENRE_SERVICE: 'GenreService',

  // Artist services
  ARTIST_SERVICE: 'ArtistService',
  ARTIST_PROFILE_SERVICE: 'ArtistProfileService',

  // Blockchain services
  SOROBAN_SERVICE: 'SorobanService',
  TRANSACTION_LOG_SERVICE: 'TransactionLogService',
  WALLET_SERVICE: 'WalletService',

  // Infrastructure services
  CACHE_SERVICE: 'CacheService',
  EMAIL_SERVICE: 'EmailService',
  PINATA_SERVICE: 'PinataService',
  JOB_QUEUE_SERVICE: 'JobQueueService',
  METRICS_SERVICE: 'MetricsService',
  BATCH_SERVICE: 'BatchService',
  AI_PROVIDER_SERVICE: 'AIProviderService',

  // Marketplace services
  ROYALTY_PAYOUT_SERVICE: 'RoyaltyPayoutService',
  SCAN_SERVICE: 'ScanService',
} as const;

/**
 * Type-safe service resolver
 */
export function resolveService<T>(name: string): T {
  return container.resolve<T>(name);
}

/**
 * Performance monitoring for service resolution
 */
export function measureResolution<T>(name: string, resolver: () => T): T {
  const start = performance.now();
  try {
    return resolver();
  } finally {
    const duration = performance.now() - start;
    if (duration > 5) {
      console.warn(
        `Service resolution for "${name}" took ${duration.toFixed(2)}ms (threshold: 5ms)`,
      );
    }
  }
}
