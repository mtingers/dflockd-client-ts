import * as net from "net";
import * as tls from "tls";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6388;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export class AcquireTimeoutError extends LockError {
  constructor(key: string) {
    super(`timeout acquiring '${key}'`);
    this.name = "AcquireTimeoutError";
  }
}

export class AuthError extends LockError {
  constructor() {
    super("authentication failed");
    this.name = "AuthError";
  }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function encodeLines(...lines: string[]): Buffer {
  return Buffer.from(lines.map((l) => l + "\n").join(""), "utf-8");
}

function writeAll(sock: net.Socket, data: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sock.write(data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Read one newline-terminated line from the socket.
 * Resolves with the line (without trailing \r\n).
 * Rejects if the connection closes before a full line arrives.
 */
const _readlineBuf = new WeakMap<net.Socket, string>();

function readline(sock: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = _readlineBuf.get(sock) ?? "";

    // Check if a complete line is already buffered from a previous read.
    const existing = buf.indexOf("\n");
    if (existing !== -1) {
      const line = buf.slice(0, existing).replace(/\r$/, "");
      _readlineBuf.set(sock, buf.slice(existing + 1));
      resolve(line);
      return;
    }

    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        cleanup();
        const line = buf.slice(0, idx).replace(/\r$/, "");
        _readlineBuf.set(sock, buf.slice(idx + 1));
        resolve(line);
      }
    };

    const onError = (err: Error) => {
      cleanup();
      _readlineBuf.delete(sock);
      reject(err);
    };

    const onClose = () => {
      cleanup();
      _readlineBuf.delete(sock);
      reject(new LockError("server closed connection"));
    };

    const cleanup = () => {
      sock.removeListener("data", onData);
      sock.removeListener("error", onError);
      sock.removeListener("close", onClose);
    };

    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("close", onClose);
  });
}

async function connect(
  host: string,
  port: number,
  tlsOptions?: tls.ConnectionOptions,
  auth?: string,
): Promise<net.Socket> {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    if (tlsOptions) {
      const s = tls.connect({ host, port, ...tlsOptions }, () => {
        s.removeListener("error", reject);
        resolve(s);
      });
      s.on("error", reject);
    } else {
      const s = net.createConnection({ host, port }, () => {
        s.removeListener("error", reject);
        resolve(s);
      });
      s.on("error", reject);
    }
  });

  // Disable Nagle's algorithm for lower latency on small lock commands.
  sock.setNoDelay(true);

  // Prevent unhandled 'error' events from crashing the process.
  // Errors are detected through readline's close handler.
  sock.on("error", () => {});

  if (auth != null && auth !== "") {
    await writeAll(sock, encodeLines("auth", "_", auth));
    const resp = await readline(sock);
    if (resp === "ok") {
      return sock;
    }
    sock.destroy();
    if (resp === "error_auth") {
      throw new AuthError();
    }
    throw new LockError(`auth failed: '${resp}'`);
  }

  return sock;
}

// ---------------------------------------------------------------------------
// CRC32 (same algorithm as Python's zlib.crc32)
// ---------------------------------------------------------------------------

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Sharding
// ---------------------------------------------------------------------------

export type ShardingStrategy = (key: string, numServers: number) => number;

export function stableHashShard(key: string, numServers: number): number {
  return (crc32(Buffer.from(key, "utf-8")) >>> 0) % numServers;
}

// ---------------------------------------------------------------------------
// Stats types
// ---------------------------------------------------------------------------

export interface StatsLock {
  key: string;
  owner_conn_id: number;
  lease_expires_in_s: number;
  waiters: number;
}

export interface StatsSemaphore {
  key: string;
  limit: number;
  holders: number;
  waiters: number;
}

export interface StatsIdleLock {
  key: string;
  idle_s: number;
}

export interface StatsIdleSemaphore {
  key: string;
  idle_s: number;
}

export interface Stats {
  connections: number;
  locks: StatsLock[];
  semaphores: StatsSemaphore[];
  idle_locks: StatsIdleLock[];
  idle_semaphores: StatsIdleSemaphore[];
}

// ---------------------------------------------------------------------------
// Protocol functions
// ---------------------------------------------------------------------------

export async function acquire(
  sock: net.Socket,
  key: string,
  acquireTimeoutS: number,
  leaseTtlS?: number,
): Promise<{ token: string; lease: number }> {
  const arg =
    leaseTtlS == null
      ? String(acquireTimeoutS)
      : `${acquireTimeoutS} ${leaseTtlS}`;

  await writeAll(sock, encodeLines("l", key, arg));

  const resp = await readline(sock);
  if (resp === "timeout") {
    throw new AcquireTimeoutError(key);
  }
  if (!resp.startsWith("ok ")) {
    throw new LockError(`acquire failed: '${resp}'`);
  }

  const parts = resp.split(" ");
  const token = parts[1];
  const lease = parts.length >= 3 ? parseInt(parts[2], 10) : 30;
  return { token, lease };
}

export async function renew(
  sock: net.Socket,
  key: string,
  token: string,
  leaseTtlS?: number,
): Promise<number> {
  const arg = leaseTtlS == null ? token : `${token} ${leaseTtlS}`;
  await writeAll(sock, encodeLines("n", key, arg));

  const resp = await readline(sock);
  if (resp !== "ok" && !resp.startsWith("ok ")) {
    throw new LockError(`renew failed: '${resp}'`);
  }

  const parts = resp.split(" ");
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
    return parseInt(parts[1], 10);
  }
  throw new LockError(`renew: malformed response: '${resp}'`);
}

export async function enqueue(
  sock: net.Socket,
  key: string,
  leaseTtlS?: number,
): Promise<{ status: "acquired" | "queued"; token: string | null; lease: number | null }> {
  const arg = leaseTtlS == null ? "" : String(leaseTtlS);
  await writeAll(sock, encodeLines("e", key, arg));

  const resp = await readline(sock);
  if (resp.startsWith("acquired ")) {
    const parts = resp.split(" ");
    const token = parts[1];
    const lease = parts.length >= 3 ? parseInt(parts[2], 10) : 30;
    return { status: "acquired", token, lease };
  }
  if (resp === "queued") {
    return { status: "queued", token: null, lease: null };
  }
  throw new LockError(`enqueue failed: '${resp}'`);
}

export async function waitForLock(
  sock: net.Socket,
  key: string,
  waitTimeoutS: number,
): Promise<{ token: string; lease: number }> {
  await writeAll(sock, encodeLines("w", key, String(waitTimeoutS)));

  const resp = await readline(sock);
  if (resp === "timeout") {
    throw new AcquireTimeoutError(key);
  }
  if (!resp.startsWith("ok ")) {
    throw new LockError(`wait failed: '${resp}'`);
  }

  const parts = resp.split(" ");
  const token = parts[1];
  const lease = parts.length >= 3 ? parseInt(parts[2], 10) : 30;
  return { token, lease };
}

export async function release(
  sock: net.Socket,
  key: string,
  token: string,
): Promise<void> {
  await writeAll(sock, encodeLines("r", key, token));

  const resp = await readline(sock);
  if (resp !== "ok") {
    throw new LockError(`release failed: '${resp}'`);
  }
}

// ---------------------------------------------------------------------------
// Semaphore protocol functions
// ---------------------------------------------------------------------------

export async function semAcquire(
  sock: net.Socket,
  key: string,
  acquireTimeoutS: number,
  limit: number,
  leaseTtlS?: number,
): Promise<{ token: string; lease: number }> {
  const arg =
    leaseTtlS == null
      ? `${acquireTimeoutS} ${limit}`
      : `${acquireTimeoutS} ${limit} ${leaseTtlS}`;

  await writeAll(sock, encodeLines("sl", key, arg));

  const resp = await readline(sock);
  if (resp === "timeout") {
    throw new AcquireTimeoutError(key);
  }
  if (!resp.startsWith("ok ")) {
    throw new LockError(`sem_acquire failed: '${resp}'`);
  }

  const parts = resp.split(" ");
  const token = parts[1];
  const lease = parts.length >= 3 ? parseInt(parts[2], 10) : 30;
  return { token, lease };
}

export async function semRenew(
  sock: net.Socket,
  key: string,
  token: string,
  leaseTtlS?: number,
): Promise<number> {
  const arg = leaseTtlS == null ? token : `${token} ${leaseTtlS}`;
  await writeAll(sock, encodeLines("sn", key, arg));

  const resp = await readline(sock);
  if (resp !== "ok" && !resp.startsWith("ok ")) {
    throw new LockError(`sem_renew failed: '${resp}'`);
  }

  const parts = resp.split(" ");
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
    return parseInt(parts[1], 10);
  }
  throw new LockError(`sem_renew: malformed response: '${resp}'`);
}

export async function semEnqueue(
  sock: net.Socket,
  key: string,
  limit: number,
  leaseTtlS?: number,
): Promise<{ status: "acquired" | "queued"; token: string | null; lease: number | null }> {
  const arg = leaseTtlS == null ? String(limit) : `${limit} ${leaseTtlS}`;
  await writeAll(sock, encodeLines("se", key, arg));

  const resp = await readline(sock);
  if (resp.startsWith("acquired ")) {
    const parts = resp.split(" ");
    const token = parts[1];
    const lease = parts.length >= 3 ? parseInt(parts[2], 10) : 30;
    return { status: "acquired", token, lease };
  }
  if (resp === "queued") {
    return { status: "queued", token: null, lease: null };
  }
  throw new LockError(`sem_enqueue failed: '${resp}'`);
}

export async function semWaitForLock(
  sock: net.Socket,
  key: string,
  waitTimeoutS: number,
): Promise<{ token: string; lease: number }> {
  await writeAll(sock, encodeLines("sw", key, String(waitTimeoutS)));

  const resp = await readline(sock);
  if (resp === "timeout") {
    throw new AcquireTimeoutError(key);
  }
  if (!resp.startsWith("ok ")) {
    throw new LockError(`sem_wait failed: '${resp}'`);
  }

  const parts = resp.split(" ");
  const token = parts[1];
  const lease = parts.length >= 3 ? parseInt(parts[2], 10) : 30;
  return { token, lease };
}

export async function semRelease(
  sock: net.Socket,
  key: string,
  token: string,
): Promise<void> {
  await writeAll(sock, encodeLines("sr", key, token));

  const resp = await readline(sock);
  if (resp !== "ok") {
    throw new LockError(`sem_release failed: '${resp}'`);
  }
}

// ---------------------------------------------------------------------------
// Stats protocol function
// ---------------------------------------------------------------------------

async function statsProto(sock: net.Socket): Promise<Stats> {
  await writeAll(sock, encodeLines("stats", "_", ""));

  const resp = await readline(sock);
  if (!resp.startsWith("ok ")) {
    throw new LockError(`stats failed: '${resp}'`);
  }

  const json = resp.slice(3);
  try {
    return JSON.parse(json) as Stats;
  } catch {
    throw new LockError(`stats: malformed JSON response: '${json}'`);
  }
}

/**
 * Query server runtime statistics.
 *
 * Opens a short-lived connection, sends the `stats` command, and returns
 * the parsed response.
 *
 * ```ts
 * const s = await stats();
 * console.log(s.connections, s.locks.length);
 * ```
 */
export async function stats(
  options?: { host?: string; port?: number; tls?: tls.ConnectionOptions; auth?: string },
): Promise<Stats> {
  const host = options?.host ?? DEFAULT_HOST;
  const port = options?.port ?? DEFAULT_PORT;
  const sock = await connect(host, port, options?.tls, options?.auth);
  try {
    return await statsProto(sock);
  } finally {
    sock.destroy();
  }
}

// ---------------------------------------------------------------------------
// DistributedLock
// ---------------------------------------------------------------------------

export interface DistributedLockOptions {
  key: string;
  acquireTimeoutS?: number;
  leaseTtlS?: number;
  /** @deprecated Use `servers` instead. */
  host?: string;
  /** @deprecated Use `servers` instead. */
  port?: number;
  servers?: Array<[host: string, port: number]>;
  shardingStrategy?: ShardingStrategy;
  renewRatio?: number;
  tls?: tls.ConnectionOptions;
  auth?: string;
  onLockLost?: (key: string, token: string) => void;
}

export class DistributedLock {
  readonly key: string;
  readonly acquireTimeoutS: number;
  readonly leaseTtlS: number | undefined;
  readonly servers: Array<[string, number]>;
  readonly shardingStrategy: ShardingStrategy;
  readonly renewRatio: number;
  readonly tls: tls.ConnectionOptions | undefined;
  readonly auth: string | undefined;
  readonly onLockLost: ((key: string, token: string) => void) | undefined;

  token: string | null = null;
  lease: number = 0;

  private sock: net.Socket | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: DistributedLockOptions) {
    this.key = opts.key;
    this.acquireTimeoutS = opts.acquireTimeoutS ?? 10;
    this.leaseTtlS = opts.leaseTtlS;
    this.tls = opts.tls;
    this.auth = opts.auth;
    this.onLockLost = opts.onLockLost;

    if (opts.servers) {
      if (opts.servers.length === 0) {
        throw new LockError("servers list must not be empty");
      }
      this.servers = [...opts.servers];
    } else {
      this.servers = [[opts.host ?? DEFAULT_HOST, opts.port ?? DEFAULT_PORT]];
    }

    this.shardingStrategy = opts.shardingStrategy ?? stableHashShard;
    this.renewRatio = opts.renewRatio ?? 0.5;
  }

  private pickServer(): [string, number] {
    const idx = this.shardingStrategy(this.key, this.servers.length);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.servers.length) {
      throw new LockError(
        `shardingStrategy returned invalid index ${idx} for ${this.servers.length} server(s)`,
      );
    }
    return this.servers[idx];
  }

  /**
   * Acquire the lock. Returns `true` on success, `false` on timeout.
   * @param opts.force - If `true`, silently close any existing connection before acquiring. Defaults to `false`, which throws if already connected.
   */
  async acquire(opts?: { force?: boolean }): Promise<boolean> {
    if (this.sock && !this.closed) {
      if (!opts?.force) {
        throw new LockError("already connected; call release() or close() first, or pass { force: true }");
      }
      this.close();
    }
    this.closed = false;
    const [host, port] = this.pickServer();
    this.sock = await connect(host, port, this.tls, this.auth);
    try {
      const result = await acquire(
        this.sock,
        this.key,
        this.acquireTimeoutS,
        this.leaseTtlS,
      );
      this.token = result.token;
      this.lease = result.lease;
    } catch (err) {
      this.close();
      if (err instanceof AcquireTimeoutError) return false;
      throw err;
    }
    this.startRenew();
    return true;
  }

  /** Release the lock and close the connection. */
  async release(): Promise<void> {
    try {
      this.stopRenew();
      if (this.sock && this.token) {
        await release(this.sock, this.key, this.token);
      }
    } finally {
      this.close();
    }
  }

  /**
   * Two-phase step 1: connect and join the FIFO queue.
   * Returns `"acquired"` (fast-path, lock is already held) or `"queued"`.
   * If acquired immediately, the renew loop starts automatically.
   * @param opts.force - If `true`, silently close any existing connection before enqueuing. Defaults to `false`, which throws if already connected.
   */
  async enqueue(opts?: { force?: boolean }): Promise<"acquired" | "queued"> {
    if (this.sock && !this.closed) {
      if (!opts?.force) {
        throw new LockError("already connected; call release() or close() first, or pass { force: true }");
      }
      this.close();
    }
    this.closed = false;
    const [host, port] = this.pickServer();
    this.sock = await connect(host, port, this.tls, this.auth);
    try {
      const result = await enqueue(this.sock, this.key, this.leaseTtlS);
      if (result.status === "acquired") {
        this.token = result.token;
        this.lease = result.lease ?? 0;
        this.startRenew();
      }
      return result.status;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /**
   * Two-phase step 2: block until the lock is granted.
   * Returns `true` if granted, `false` on timeout.
   * If already acquired during `enqueue()`, returns `true` immediately.
   */
  async wait(timeoutS?: number): Promise<boolean> {
    if (this.token !== null) {
      // Already acquired during enqueue (fast path)
      return true;
    }
    if (!this.sock) {
      throw new LockError("not connected; call enqueue() first");
    }
    const timeout = timeoutS ?? this.acquireTimeoutS;
    try {
      const result = await waitForLock(this.sock, this.key, timeout);
      this.token = result.token;
      this.lease = result.lease;
    } catch (err) {
      this.close();
      if (err instanceof AcquireTimeoutError) return false;
      throw err;
    }
    this.startRenew();
    return true;
  }

  /**
   * Run `fn` while holding the lock, then release automatically.
   *
   * ```ts
   * const lock = new DistributedLock({ key: "my-resource" });
   * await lock.withLock(async () => {
   *   // critical section
   * });
   * ```
   */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const ok = await this.acquire();
    if (!ok) {
      throw new AcquireTimeoutError(this.key);
    }
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  /** Close the underlying socket (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopRenew();
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
    this.token = null;
  }

  // -- internals --

  private startRenew(): void {
    const loop = async () => {
      const savedToken = this.token;
      if (!this.sock || !savedToken) return;
      const start = Date.now();
      try {
        this.lease = await renew(this.sock, this.key, savedToken, this.leaseTtlS);
      } catch {
        // Only signal lock-lost if we still own this token (close() may have cleared it)
        if (this.token === savedToken) {
          this.token = null;
          if (this.onLockLost) {
            this.onLockLost(this.key, savedToken);
          }
        }
        return;
      }
      const elapsed = Date.now() - start;
      const interval = Math.max(1, this.lease * this.renewRatio) * 1000;
      this.renewTimer = setTimeout(loop, Math.max(0, interval - elapsed));
      this.renewTimer.unref();
    };
    const interval = Math.max(1, this.lease * this.renewRatio) * 1000;
    this.renewTimer = setTimeout(loop, interval);
    this.renewTimer.unref();
  }

  private stopRenew(): void {
    if (this.renewTimer != null) {
      clearTimeout(this.renewTimer);
      this.renewTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// DistributedSemaphore
// ---------------------------------------------------------------------------

export interface DistributedSemaphoreOptions {
  key: string;
  limit: number;
  acquireTimeoutS?: number;
  leaseTtlS?: number;
  /** @deprecated Use `servers` instead. */
  host?: string;
  /** @deprecated Use `servers` instead. */
  port?: number;
  servers?: Array<[host: string, port: number]>;
  shardingStrategy?: ShardingStrategy;
  renewRatio?: number;
  tls?: tls.ConnectionOptions;
  auth?: string;
  onLockLost?: (key: string, token: string) => void;
}

export class DistributedSemaphore {
  readonly key: string;
  readonly limit: number;
  readonly acquireTimeoutS: number;
  readonly leaseTtlS: number | undefined;
  readonly servers: Array<[string, number]>;
  readonly shardingStrategy: ShardingStrategy;
  readonly renewRatio: number;
  readonly tls: tls.ConnectionOptions | undefined;
  readonly auth: string | undefined;
  readonly onLockLost: ((key: string, token: string) => void) | undefined;

  token: string | null = null;
  lease: number = 0;

  private sock: net.Socket | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: DistributedSemaphoreOptions) {
    this.key = opts.key;
    this.limit = opts.limit;
    this.acquireTimeoutS = opts.acquireTimeoutS ?? 10;
    this.leaseTtlS = opts.leaseTtlS;
    this.tls = opts.tls;
    this.auth = opts.auth;
    this.onLockLost = opts.onLockLost;

    if (opts.servers) {
      if (opts.servers.length === 0) {
        throw new LockError("servers list must not be empty");
      }
      this.servers = [...opts.servers];
    } else {
      this.servers = [[opts.host ?? DEFAULT_HOST, opts.port ?? DEFAULT_PORT]];
    }

    this.shardingStrategy = opts.shardingStrategy ?? stableHashShard;
    this.renewRatio = opts.renewRatio ?? 0.5;
  }

  private pickServer(): [string, number] {
    const idx = this.shardingStrategy(this.key, this.servers.length);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.servers.length) {
      throw new LockError(
        `shardingStrategy returned invalid index ${idx} for ${this.servers.length} server(s)`,
      );
    }
    return this.servers[idx];
  }

  /**
   * Acquire a semaphore slot. Returns `true` on success, `false` on timeout.
   * @param opts.force - If `true`, silently close any existing connection before acquiring. Defaults to `false`, which throws if already connected.
   */
  async acquire(opts?: { force?: boolean }): Promise<boolean> {
    if (this.sock && !this.closed) {
      if (!opts?.force) {
        throw new LockError("already connected; call release() or close() first, or pass { force: true }");
      }
      this.close();
    }
    this.closed = false;
    const [host, port] = this.pickServer();
    this.sock = await connect(host, port, this.tls, this.auth);
    try {
      const result = await semAcquire(
        this.sock,
        this.key,
        this.acquireTimeoutS,
        this.limit,
        this.leaseTtlS,
      );
      this.token = result.token;
      this.lease = result.lease;
    } catch (err) {
      this.close();
      if (err instanceof AcquireTimeoutError) return false;
      throw err;
    }
    this.startRenew();
    return true;
  }

  /** Release the semaphore slot and close the connection. */
  async release(): Promise<void> {
    try {
      this.stopRenew();
      if (this.sock && this.token) {
        await semRelease(this.sock, this.key, this.token);
      }
    } finally {
      this.close();
    }
  }

  /**
   * Two-phase step 1: connect and join the FIFO queue.
   * Returns `"acquired"` (fast-path, slot granted immediately) or `"queued"`.
   * If acquired immediately, the renew loop starts automatically.
   * @param opts.force - If `true`, silently close any existing connection before enqueuing. Defaults to `false`, which throws if already connected.
   */
  async enqueue(opts?: { force?: boolean }): Promise<"acquired" | "queued"> {
    if (this.sock && !this.closed) {
      if (!opts?.force) {
        throw new LockError("already connected; call release() or close() first, or pass { force: true }");
      }
      this.close();
    }
    this.closed = false;
    const [host, port] = this.pickServer();
    this.sock = await connect(host, port, this.tls, this.auth);
    try {
      const result = await semEnqueue(this.sock, this.key, this.limit, this.leaseTtlS);
      if (result.status === "acquired") {
        this.token = result.token;
        this.lease = result.lease ?? 0;
        this.startRenew();
      }
      return result.status;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /**
   * Two-phase step 2: block until a semaphore slot is granted.
   * Returns `true` if granted, `false` on timeout.
   * If already acquired during `enqueue()`, returns `true` immediately.
   */
  async wait(timeoutS?: number): Promise<boolean> {
    if (this.token !== null) {
      return true;
    }
    if (!this.sock) {
      throw new LockError("not connected; call enqueue() first");
    }
    const timeout = timeoutS ?? this.acquireTimeoutS;
    try {
      const result = await semWaitForLock(this.sock, this.key, timeout);
      this.token = result.token;
      this.lease = result.lease;
    } catch (err) {
      this.close();
      if (err instanceof AcquireTimeoutError) return false;
      throw err;
    }
    this.startRenew();
    return true;
  }

  /**
   * Run `fn` while holding a semaphore slot, then release automatically.
   *
   * ```ts
   * const sem = new DistributedSemaphore({ key: "my-resource", limit: 5 });
   * await sem.withLock(async () => {
   *   // critical section (up to 5 concurrent holders)
   * });
   * ```
   */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const ok = await this.acquire();
    if (!ok) {
      throw new AcquireTimeoutError(this.key);
    }
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  /** Close the underlying socket (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopRenew();
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
    this.token = null;
  }

  // -- internals --

  private startRenew(): void {
    const loop = async () => {
      const savedToken = this.token;
      if (!this.sock || !savedToken) return;
      const start = Date.now();
      try {
        this.lease = await semRenew(this.sock, this.key, savedToken, this.leaseTtlS);
      } catch {
        if (this.token === savedToken) {
          this.token = null;
          if (this.onLockLost) {
            this.onLockLost(this.key, savedToken);
          }
        }
        return;
      }
      const elapsed = Date.now() - start;
      const interval = Math.max(1, this.lease * this.renewRatio) * 1000;
      this.renewTimer = setTimeout(loop, Math.max(0, interval - elapsed));
      this.renewTimer.unref();
    };
    const interval = Math.max(1, this.lease * this.renewRatio) * 1000;
    this.renewTimer = setTimeout(loop, interval);
    this.renewTimer.unref();
  }

  private stopRenew(): void {
    if (this.renewTimer != null) {
      clearTimeout(this.renewTimer);
      this.renewTimer = null;
    }
  }
}
