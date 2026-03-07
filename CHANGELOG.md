# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.10.1] - 2026-03-07

### Added

- Documentation for signal pub/sub: `SignalConnection` API reference, examples, and guide sections for TLS and auth
- Organized examples page into clear sections (Locks, Semaphores, Signals, Configuration, Error handling)
- Added `publish()` low-level function to low-level docs and full example
- Added signal pub/sub to home page feature list

## [v1.10.0] - 2026-03-07

### Added

- Signal (pub/sub) support with NATS-style pattern matching and queue groups
- `SignalConnection` class for dedicated signal connections with `listen`, `unlisten`, `emit`, `onSignal`/`offSignal`, and async iteration
- `publish()` low-level function for one-shot signal publishing on a raw socket
- `Signal` and `SignalConnectionOptions` type exports

### Fixed

- `SignalConnection.onSocketError` did not mark the connection as closed, allowing queued commands to be attempted on a broken socket between the `error` and `close` events
- `SignalConnection.onData` buffer overflow (>2 MB) cleared the buffer but left the connection open, causing silent protocol stream corruption on subsequent data; now closes the connection
- `acquire()` and `enqueue()` did not call `close()` when `openConnection()` failed (e.g. ECONNREFUSED), leaving the instance in an inconsistent state with `closed = false` and no socket

## [v1.9.1] - 2026-02-24

### Fixed

- `release()` can hang forever awaiting an in-flight renew when the network is unresponsive; now bounded to 5 seconds
- `enqueue()` did not restore socket idle timeout on the `"queued"` path, leaving the socket unprotected until `wait()` was called
- Renew loop could clobber `this.lease` after a concurrent `close()` reset it to 0
- `readline` hangs when the socket's readable side has already ended before listeners are attached; now checks `readableEnded`/`destroyed` up front

### Changed

- Unified lock and semaphore protocol functions into 5 shared helpers (`protoAcquire`, `protoRenew`, `protoRelease`, `protoEnqueue`, `protoWait`), eliminating duplicated validation and response-parsing logic

## [v1.9.0] - 2026-02-24

### Added

- `connectTimeoutMs` option to `DistributedLock`, `DistributedSemaphore`, and `stats()` for TCP connect timeout control
- `socketTimeoutMs` option to `DistributedLock` and `DistributedSemaphore` for socket idle timeout detection
- `readline` max line length guard (1 MB) to prevent unbounded memory growth
- All protocol functions (`acquire`, `renew`, `release`, `enqueue`, `waitForLock`, `semAcquire`, `semRenew`, `semRelease`, `semEnqueue`, `semWaitForLock`) now validate inputs and throw `LockError` on invalid keys, tokens, timeouts, or limits
- Constructor now validates `acquireTimeoutS`, `leaseTtlS`, and `renewRatio` with `Number.isFinite` checks to reject `NaN` and `Infinity`

### Fixed

- `release()` race condition: capture socket and token before awaiting in-flight renew, preventing a concurrent `close()` from nulling them
- Renew failure leaving the connection open and the instance in a dirty state; `onLockLost` now automatically closes the connection so the instance can be re-acquired without `{ force: true }`
- Socket leak in `connect()` when the auth handshake throws (socket is now destroyed before re-throwing)
- Socket leak in TLS listener path: remove temporary `error` and connect listeners after settling
- Renew loop race: save the token before the async renew call, preventing `close()` from clearing it mid-flight
- NUL byte injection: validate keys and tokens against `\0` characters in all protocol functions and constructors
- `parseLease` accepting garbage strings (e.g. `"abc"`, `"NaN"`); now requires `Number.isFinite` and falls back to default
- `renewRatio` accepting `NaN` and `Infinity`; now validated with `Number.isFinite`
- `release()` silently succeeding after `close()` — now throws `LockError`
- `wait()` error message after `close()` (was "not connected", now "connection closed; call enqueue() again")
- `enqueue()` not suspending socket idle timeout during the blocking server call
- Connect listener leaks: remove the opposing listener (`error`/`connect`) after one fires
- `close()` to be synchronous (was unnecessarily `async`)
- Sharding strategy return value validated for bounds, integrality, and `NaN`

### Changed

- Extracted shared `DistributedPrimitive` base class for `DistributedLock` and `DistributedSemaphore`

## [v1.8.3] - 2026-02-24

### Changed

- Renewal timers now call `.unref()` so they don't keep the Node.js event loop alive if a user forgets to call `release()`/`close()`

## [v1.8.2] - 2026-02-24

### Fixed

- `renew`/`semRenew` response check tightened to reject responses like `"okay"` that incorrectly matched `startsWith("ok")`
- `startRenew` loop now uses the lease value returned by the server on each renewal, recalculates the interval, and subtracts round-trip elapsed time
- `startRenew` saves the token before the async renew call, preventing a race where `close()` clears the token mid-flight
- `stats()` now wraps `JSON.parse` and throws `LockError` on malformed JSON responses
- Inconsistent default lease fallback: `enqueue`/`waitForLock` used `33` instead of `30`
- All `sock.write()` calls now await the write callback via `writeAll()`, properly handling TCP backpressure
- `readline` cleans up its internal buffer on socket error/close
- `close()` is now synchronous (was unnecessarily `async`)

### Changed

- Enable `setNoDelay` on sockets for lower latency
- Defensive copy of `servers` array in constructors

## [v1.8.0] - 2026-02-24

### Added

- `onLockLost` callback option to `DistributedLock` and `DistributedSemaphore`, called when background lease renewal fails

### Fixed

- `AcquireTimeoutError` now extends `LockError` (was `Error`), so `catch (err instanceof LockError)` catches timeouts too
- `readline` now persists leftover bytes between calls, fixing data loss when the server sends multiple lines in a single TCP segment
- `connect` removes the temporary `error` listener after a successful connection, preventing listener leaks
- Add a no-op `error` listener on sockets after connect to prevent unhandled `error` event crashes
- `renew` and `semRenew` throw `LockError` on malformed server responses instead of silently returning `-1`
- `acquire()` and `enqueue()` now throw `LockError` if called while already connected (programmer error); pass `{ force: true }` to silently close the previous connection instead
- `auth` option no longer sends an auth command for empty strings
- `shardingStrategy` return value is now validated; out-of-bounds or non-integer values throw `LockError`

## [v1.6.0] - 2026-02-18

### Added

- `auth` option to `DistributedLock`, `DistributedSemaphore`, and `stats()` for token-based authentication (`--auth-token`)
- `AuthError` class (extends `LockError`) thrown on authentication failure

## [v1.5.0] - 2026-02-18

### Added

- `tls` option to `DistributedLock`, `DistributedSemaphore`, and `stats()` for TLS-encrypted connections

## [v1.4.0] - 2026-02-18

### Added

- `stats()` function to query server runtime statistics (connections, locks, semaphores, idle entries)
- Export `Stats`, `StatsLock`, `StatsSemaphore`, `StatsIdleLock`, `StatsIdleSemaphore` interfaces

## [v1.2.0] - 2026-02-16

### Added

- `DistributedSemaphore` class with `acquire`, `release`, `withLock`, `enqueue`, and `wait`
- Low-level semaphore protocol functions: `semAcquire`, `semRenew`, `semRelease`, `semEnqueue`, `semWaitForLock`
- Export `DistributedSemaphoreOptions` interface
- Semaphore supports up to N concurrent holders per key (configurable via `limit`)
- Semaphore shares the same sharding, auto-renewal, and two-phase enqueue/wait patterns as `DistributedLock`

## [v1.1.0] - 2026-02-15

### Added

- Multi-server sharding with consistent CRC32-based hashing (matches Python's `zlib.crc32`)
- `servers` option to distribute locks across multiple dflockd instances
- `shardingStrategy` option for custom key-to-server routing
- Export `ShardingStrategy` type and `stableHashShard` function
- Test suite (20 tests covering sharding, locking, and enqueue/wait)

### Deprecated

- `host` and `port` options in favor of `servers`

## [v1.0.0] - 2026-02-15

### Added

- `DistributedLock` class with `acquire`, `release`, `withLock`, `enqueue`, and `wait`
- Automatic lease renewal
- Low-level protocol functions: `acquire`, `renew`, `release`, `enqueue`, `waitForLock`
- `AcquireTimeoutError` and `LockError` error types
