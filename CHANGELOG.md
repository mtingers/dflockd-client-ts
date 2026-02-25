# Changelog

## 1.9.0

### Features

- Add `connectTimeoutMs` option to `DistributedLock`, `DistributedSemaphore`, and `stats()` for TCP connect timeout control
- Add `socketTimeoutMs` option to `DistributedLock` and `DistributedSemaphore` for socket idle timeout detection
- Extracted shared `DistributedPrimitive` base class for `DistributedLock` and `DistributedSemaphore`

### Bug fixes

- Fix `release()` race condition: capture socket and token before awaiting in-flight renew, preventing a concurrent `close()` from nulling them
- Fix renew failure leaving the connection open and the instance in a dirty state; `onLockLost` now automatically closes the connection so the instance can be re-acquired without `{ force: true }`
- Fix socket leak in `connect()` when the auth handshake throws (socket is now destroyed before re-throwing)
- Fix socket leak in TLS listener path: remove temporary `error` and connect listeners after settling
- Fix renew loop race: save the token before the async renew call, preventing `close()` from clearing it mid-flight
- Fix NUL byte injection: validate keys and tokens against `\0` characters in all protocol functions and constructors
- Fix `parseLease` accepting garbage strings (e.g. `"abc"`, `"NaN"`); now requires `Number.isFinite` and falls back to default
- Fix `renewRatio` accepting `NaN` and `Infinity`; now validated with `Number.isFinite`
- Fix `release()` silently succeeding after `close()` — now throws `LockError`
- Fix `wait()` error message after `close()` (was "not connected", now "connection closed; call enqueue() again")
- Fix `enqueue()` not suspending socket idle timeout during the blocking server call
- Fix connect listener leaks: remove the opposing listener (`error`/`connect`) after one fires
- Fix `close()` to be synchronous (was unnecessarily `async`)
- Add `readline` max line length guard (1 MB) to prevent unbounded memory growth
- All protocol functions (`acquire`, `renew`, `release`, `enqueue`, `waitForLock`, `semAcquire`, `semRenew`, `semRelease`, `semEnqueue`, `semWaitForLock`) now validate inputs and throw `LockError` on invalid keys, tokens, timeouts, or limits
- Constructor now validates `acquireTimeoutS`, `leaseTtlS`, and `renewRatio` with `Number.isFinite` checks to reject `NaN` and `Infinity`
- Sharding strategy return value is validated for bounds, integrality, and `NaN`

## 1.8.3

### Improvements

- Renewal timers now call `.unref()` so they don't keep the Node.js event loop alive if a user forgets to call `release()`/`close()`

## 1.8.2

### Bug fixes

- `renew`/`semRenew` response check tightened to reject responses like `"okay"` that incorrectly matched `startsWith("ok")`
- `startRenew` loop now uses the lease value returned by the server on each renewal, recalculates the interval, and subtracts round-trip elapsed time
- `startRenew` saves the token before the async renew call, preventing a race where `close()` clears the token mid-flight
- `stats()` now wraps `JSON.parse` and throws `LockError` on malformed JSON responses
- Fix inconsistent default lease fallback: `enqueue`/`waitForLock` used `33` instead of `30`
- All `sock.write()` calls now await the write callback via `writeAll()`, properly handling TCP backpressure
- `readline` cleans up its internal buffer on socket error/close
- `close()` is now synchronous (was unnecessarily `async`)
- Enable `setNoDelay` on sockets for lower latency
- Defensive copy of `servers` array in constructors

## 1.8.0

### Features

- Add `onLockLost` callback option to `DistributedLock` and `DistributedSemaphore`, called when background lease renewal fails

### Bug fixes

- `AcquireTimeoutError` now extends `LockError` (was `Error`), so `catch (err instanceof LockError)` catches timeouts too
- `readline` now persists leftover bytes between calls, fixing data loss when the server sends multiple lines in a single TCP segment
- `connect` removes the temporary `error` listener after a successful connection, preventing listener leaks
- Add a no-op `error` listener on sockets after connect to prevent unhandled `error` event crashes
- `renew` and `semRenew` throw `LockError` on malformed server responses instead of silently returning `-1`
- `acquire()` and `enqueue()` now throw `LockError` if called while already connected (programmer error); pass `{ force: true }` to silently close the previous connection instead
- `auth` option no longer sends an auth command for empty strings
- `shardingStrategy` return value is now validated; out-of-bounds or non-integer values throw `LockError`

## 1.6.0

- Add `auth` option to `DistributedLock`, `DistributedSemaphore`, and `stats()` for token-based authentication (`--auth-token`)
- Add `AuthError` class (extends `LockError`) thrown on authentication failure

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
