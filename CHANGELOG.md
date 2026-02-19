# Changelog

## 1.5.0

- Add `tls` option to `DistributedLock`, `DistributedSemaphore`, and `stats()` for TLS-encrypted connections

## 1.4.0

- Add `stats()` function to query server runtime statistics (connections, locks, semaphores, idle entries)
- Export `Stats`, `StatsLock`, `StatsSemaphore`, `StatsIdleLock`, `StatsIdleSemaphore` interfaces

## 1.2.0

- Add `DistributedSemaphore` class with `acquire`, `release`, `withLock`, `enqueue`, and `wait`
- Add low-level semaphore protocol functions: `semAcquire`, `semRenew`, `semRelease`, `semEnqueue`, `semWaitForLock`
- Export `DistributedSemaphoreOptions` interface
- Semaphore supports up to N concurrent holders per key (configurable via `limit`)
- Semaphore shares the same sharding, auto-renewal, and two-phase enqueue/wait patterns as `DistributedLock`

## 1.1.0

- Add multi-server sharding with consistent CRC32-based hashing (matches Python's `zlib.crc32`)
- Add `servers` option to distribute locks across multiple dflockd instances
- Add `shardingStrategy` option for custom key-to-server routing
- Export `ShardingStrategy` type and `stableHashShard` function
- Deprecate `host` and `port` options in favor of `servers`
- Add test suite (20 tests covering sharding, locking, and enqueue/wait)

## 1.0.0

- Initial release
- `DistributedLock` class with `acquire`, `release`, `withLock`, `enqueue`, and `wait`
- Automatic lease renewal
- Low-level protocol functions: `acquire`, `renew`, `release`, `enqueue`, `waitForLock`
- `AcquireTimeoutError` and `LockError` error types
