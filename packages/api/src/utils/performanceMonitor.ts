import { logger } from './logger';

export interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface PerformanceStats {
  operation: string;
  count: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  totalDuration: number;
  lastUpdated: number;
  p50: number;
  p95: number;
  p99: number;
}

interface DurationWindow {
  values: number[];
  next: number;
  count: number;
}

export class PerformanceMonitor {
  private metrics: Array<PerformanceMetric | undefined> = new Array(1000);
  private metricsNext = 0;
  private metricsCount = 0;
  private stats: Map<string, PerformanceStats> = new Map();
  private durations: Map<string, DurationWindow> = new Map();
  private readonly maxMetrics = 1000;
  private readonly maxDurations = 500;
  private readonly maxOperations = 512;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  /**
   * Start timing an operation
   */
  startTimer(operation: string): (metadata?: Record<string, unknown>) => void {
    const startTime = Date.now();
    
    return (metadata?: Record<string, any>) => {
      const duration = Date.now() - startTime;
      this.recordMetric(operation, duration, metadata);
    };
  }

  /**
   * Record a performance metric
   */
  recordMetric(operation: string, duration: number, metadata?: Record<string, unknown>): void {
    const metric: PerformanceMetric = {
      operation,
      duration,
      timestamp: Date.now(),
      metadata
    };

    this.metrics[this.metricsNext] = metric;
    this.metricsNext = (this.metricsNext + 1) % this.maxMetrics;
    this.metricsCount = Math.min(this.metricsCount + 1, this.maxMetrics);
    this.updateStats(operation, duration);

    // Log slow operations
    if (duration > 1000) {
      logger.warn(`Slow operation detected: ${operation} took ${duration}ms`, metadata);
    }
  }

  /**
   * Update statistics for an operation
   */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, idx)];
  }

  private updateStats(rawOperation: string, duration: number): void {
    const operation = this.stats.has(rawOperation) || this.stats.size < this.maxOperations
      ? rawOperation
      : 'other';
    let window = this.durations.get(operation);
    if (!window) {
      window = { values: new Array(this.maxDurations), next: 0, count: 0 };
      this.durations.set(operation, window);
    }
    window.values[window.next] = duration;
    window.next = (window.next + 1) % this.maxDurations;
    window.count = Math.min(window.count + 1, this.maxDurations);

    const existing = this.stats.get(operation);
    if (existing) {
      existing.count++;
      existing.totalDuration += duration;
      existing.avgDuration = existing.totalDuration / existing.count;
      existing.minDuration = Math.min(existing.minDuration, duration);
      existing.maxDuration = Math.max(existing.maxDuration, duration);
      existing.lastUpdated = Date.now();
    } else {
      this.stats.set(operation, {
        operation,
        count: 1,
        avgDuration: duration,
        minDuration: duration,
        maxDuration: duration,
        totalDuration: duration,
        lastUpdated: Date.now(),
        p50: duration,
        p95: duration,
        p99: duration,
      });
    }
  }

  /**
   * Get performance statistics
   */
  getStats(): PerformanceStats[] {
    return Array.from(this.stats.values(), (stats) => this.withPercentiles(stats))
      .sort((a, b) => b.count - a.count);
  }

  private withPercentiles(stats: PerformanceStats): PerformanceStats {
    const window = this.durations.get(stats.operation);
    if (!window) return stats;
    const sorted = window.values.slice(0, window.count).sort((a, b) => a - b);
    return {
      ...stats,
      p50: this.percentile(sorted, 0.5),
      p95: this.percentile(sorted, 0.95),
      p99: this.percentile(sorted, 0.99),
    };
  }

  /**
   * Get statistics for a specific operation
   */
  getOperationStats(operation: string): PerformanceStats | undefined {
    const stats = this.stats.get(operation);
    return stats ? this.withPercentiles(stats) : undefined;
  }

  /**
   * Get recent metrics
   */
  getRecentMetrics(limit = 50): PerformanceMetric[] {
    const count = Math.min(Math.max(0, limit), this.metricsCount);
    const result: PerformanceMetric[] = [];
    const start = (this.metricsNext - count + this.maxMetrics) % this.maxMetrics;
    for (let offset = 0; offset < count; offset += 1) {
      const metric = this.metrics[(start + offset) % this.maxMetrics];
      if (metric) result.push(metric);
    }
    return result;
  }

  /**
   * Get metrics for a specific operation
   */
  getOperationMetrics(operation: string, limit = 50): PerformanceMetric[] {
    return this.getRecentMetrics(this.metricsCount)
      .filter(m => m.operation === operation)
      .slice(-limit);
  }

  /**
   * Get average duration for an operation
   */
  getAverageDuration(operation: string): number {
    const stats = this.stats.get(operation);
    return stats ? stats.avgDuration : 0;
  }

  /**
   * Check if an operation is performing poorly
   */
  isOperationSlow(operation: string, threshold = 1000): boolean {
    const avgDuration = this.getAverageDuration(operation);
    return avgDuration > threshold;
  }

  /**
   * Get slow operations
   */
  getSlowOperations(threshold = 1000): PerformanceStats[] {
    return this.getStats().filter(stats => stats.avgDuration > threshold);
  }

  /**
   * Clear old metrics
   */
  private cleanup(): void {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const recent = this.getRecentMetrics(this.metricsCount).filter((metric) => metric.timestamp > oneHourAgo);
    this.metrics = new Array(this.maxMetrics);
    this.metricsNext = 0;
    this.metricsCount = 0;
    for (const metric of recent) {
      this.metrics[this.metricsNext] = metric;
      this.metricsNext = (this.metricsNext + 1) % this.maxMetrics;
      this.metricsCount += 1;
    }
    
    for (const [operation, stats] of this.stats.entries()) {
      if (stats.lastUpdated < oneHourAgo) {
        this.stats.delete(operation);
        this.durations.delete(operation);
      }
    }
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 30 * 60 * 1000); // Clean up every 30 minutes
    this.cleanupInterval.unref?.();
  }

  /**
   * Stop the monitor
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clear all metrics and stats
   */
  clear(): void {
    this.metrics = new Array(this.maxMetrics);
    this.metricsNext = 0;
    this.metricsCount = 0;
    this.stats.clear();
    this.durations.clear();
    logger.info('Performance monitor cleared');
  }

  /**
   * Get performance summary
   */
  getSummary(): {
    totalMetrics: number;
    totalOperations: number;
    slowOperations: number;
    averageResponseTime: number;
  } {
    const stats = this.getStats();
    const totalOperations = stats.length;
    const slowOperations = stats.filter((stat) => stat.avgDuration > 1000).length;
    const requestCount = stats.reduce((sum, stat) => sum + stat.count, 0);
    const totalDuration = stats.reduce((sum, stat) => sum + stat.totalDuration, 0);
    const averageResponseTime = requestCount > 0
      ? totalDuration / requestCount
      : 0;

    return {
      totalMetrics: this.metricsCount,
      totalOperations,
      slowOperations,
      averageResponseTime
    };
  }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor();
export default performanceMonitor;
