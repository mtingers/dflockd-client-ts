# Changelog

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
