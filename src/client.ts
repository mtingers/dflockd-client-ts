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
// Validation helpers
// ---------------------------------------------------------------------------

function validateKey(key: string): void {
  if (key === "") {
    throw new LockError("key must not be empty");
  }
  if (/[\0\n\r]/.test(key)) {
    throw new LockError(
      "key must not contain NUL, newline, or carriage return characters",
    );
  }
}

function validateAuth(auth: string): void {
  if (/[\0\n\r]/.test(auth)) {
    throw new LockError(
      "auth token must not contain NUL, newline, or carriage return characters",
    );
  }
}

function validateToken(token: string): void {
  if (token === "") {
    throw new LockError("token must not be empty");
  }
  if (/[\0\n\r]/.test(token)) {
    throw new LockError(
      "token must not contain NUL, newline, or carriage return characters",
    );
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
 * Parse a lease value from a server response part.
 * Returns `fallback` when the value is missing, empty, or non-numeric.
 */
function parseLease(value: string | undefined, fallback: number = 30): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Read one newline-terminated line from the socket.
 * Resolves with the line (without trailing \r\n).
 * Rejects if the connection closes before a full line arrives.
 *
 * NOTE: Concurrent calls to readline() on the same socket are unsafe —
 * callers must serialize reads (the request-response protocol naturally
 * enforces this).
 */
const _readlineBuf = new WeakMap<net.Socket, string>();
const MAX_LINE_LENGTH = 1024 * 1024; // 1 MB

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
      } else if (buf.length > MAX_LINE_LENGTH) {
        cleanup();
        _readlineBuf.delete(sock);
        reject(new LockError("server response exceeded maximum line length"));
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

    const onEnd = () => {
      cleanup();
      _readlineBuf.delete(sock);
      reject(new LockError("server closed connection"));
    };

    const cleanup = () => {
      sock.removeListener("data", onData);
      sock.removeListener("error", onError);
      sock.removeListener("close", onClose);
      sock.removeListener("end", onEnd);
    };

    // If the readable side already ended (e.g. the server closed before we
    // started reading), the 'end'/'close' events won't fire again.
    if (sock.readableEnded || sock.destroyed) {
      _readlineBuf.delete(sock);
      reject(new LockError("server closed connection"));
      return;
    }

    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("close", onClose);
    sock.on("end", onEnd);
  });
}

async function connect(
  host: string,
  port: number,
  tlsOptions?: tls.ConnectionOptions,
  auth?: string,
  connectTimeoutMs?: number,
): Promise<net.Socket> {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    // tls.connect() registers the callback on "secureConnect", not "connect".
    const connectEvent = tlsOptions ? "secureConnect" : "connect";

    const onConnect = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      s.removeListener("error", onError);
      resolve(s);
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      s.removeListener(connectEvent, onConnect);
      s.destroy();
      reject(err);
    };

    let s: net.Socket;
    if (tlsOptions) {
      s = tls.connect({ ...tlsOptions, host, port }, onConnect);
    } else {
      s = net.createConnection({ host, port }, onConnect);
    }
    s.on("error", onError);

    if (connectTimeoutMs != null && connectTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        s.removeListener("error", onError);
        s.removeListener(connectEvent, onConnect);
        s.destroy();
        reject(
          new LockError(
            `connect timed out after ${connectTimeoutMs}ms to ${host}:${port}`,
          ),
        );
      }, connectTimeoutMs);
    }
  });

  // Disable Nagle's algorithm for lower latency on small lock commands.
  sock.setNoDelay(true);

  // Prevent unhandled 'error' events from crashing the process.
  // Errors are detected through readline's close handler.
  sock.on("error", () => {});

  if (auth != null && auth !== "") {
    validateAuth(auth);
    let resp: string;
    try {
      await writeAll(sock, encodeLines("auth", "_", auth));
      resp = await readline(sock);
    } catch (err) {
      sock.destroy();
      throw err;
    }
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
  if (numServers <= 0) {
    throw new LockError("numServers must be greater than 0");
  }
  return crc32(Buffer.from(key, "utf-8")) % numServers;
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
// Protocol helpers (shared by lock and semaphore functions)
// ---------------------------------------------------------------------------

async function protoAcquire(
  sock: net.Socket,
  cmd: string,
  label: string,
  key: string,
  acquireTimeoutS: number,
  leaseTtlS?: number,
  limit?: number,
): Promise<{ token: string; lease: number }> {
  validateKey(key);
  if (!Number.isInteger(acquireTimeoutS) || acquireTimeoutS < 0) {
    throw new LockError("acquireTimeoutS must be an integer >= 0");
  }
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
    throw new LockError("limit must be an integer >= 1");
  }
  if (leaseTtlS != null && (!Number.isInteger(leaseTtlS) || leaseTtlS < 1)) {
    throw new LockError("leaseTtlS must be an integer >= 1");
  }

  const parts: (string | number)[] = [acquireTimeoutS];
  if (limit != null) parts.push(limit);
  if (leaseTtlS != null) parts.push(leaseTtlS);

  await writeAll(sock, encodeLines(cmd, key, parts.join(" ")));

  const resp = await readline(sock);
  if (resp === "timeout") {
    throw new AcquireTimeoutError(key);
  }
  if (!resp.startsWith("ok ")) {
    throw new LockError(`${label} failed: '${resp}'`);
  }

  const respParts = resp.split(" ");
  const token = respParts[1];
  if (!token) {
    throw new LockError(`${label}: server returned no token: '${resp}'`);
  }
  return { token, lease: parseLease(respParts[2]) };
}

async function protoRenew(
  sock: net.Socket,
  cmd: string,
  label: string,
  key: string,
  token: string,
  leaseTtlS?: number,
): Promise<number> {
  validateKey(key);
  validateToken(token);
  if (leaseTtlS != null && (!Number.isInteger(leaseTtlS) || leaseTtlS < 1)) {
    throw new LockError("leaseTtlS must be an integer >= 1");
  }

  const arg = leaseTtlS == null ? token : `${token} ${leaseTtlS}`;
  await writeAll(sock, encodeLines(cmd, key, arg));

  const resp = await readline(sock);
  if (resp !== "ok" && !resp.startsWith("ok ")) {
    throw new LockError(`${label} failed: '${resp}'`);
  }

  // Bare "ok" — server confirmed renewal but didn't echo the lease.
  if (resp === "ok") return leaseTtlS ?? 30;
  return parseLease(resp.split(" ")[1]);
}

async function protoEnqueue(
  sock: net.Socket,
  cmd: string,
  label: string,
  key: string,
  leaseTtlS?: number,
  limit?: number,
): Promise<{ status: "acquired" | "queued"; token: string | null; lease: number | null }> {
  validateKey(key);
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
    throw new LockError("limit must be an integer >= 1");
  }
  if (leaseTtlS != null && (!Number.isInteger(leaseTtlS) || leaseTtlS < 1)) {
    throw new LockError("leaseTtlS must be an integer >= 1");
  }

  const parts: (string | number)[] = [];
  if (limit != null) parts.push(limit);
  if (leaseTtlS != null) parts.push(leaseTtlS);

  await writeAll(sock, encodeLines(cmd, key, parts.join(" ")));

  const resp = await readline(sock);
  if (resp.startsWith("acquired ")) {
    const respParts = resp.split(" ");
    const token = respParts[1];
    if (!token) {
      throw new LockError(`${label}: server returned no token: '${resp}'`);
    }
    return { status: "acquired", token, lease: parseLease(respParts[2]) };
  }
  if (resp === "queued") {
    return { status: "queued", token: null, lease: null };
  }
  throw new LockError(`${label} failed: '${resp}'`);
}

async function protoWait(
  sock: net.Socket,
  cmd: string,
  label: string,
  key: string,
  waitTimeoutS: number,
): Promise<{ token: string; lease: number }> {
  validateKey(key);
  if (!Number.isInteger(waitTimeoutS) || waitTimeoutS < 0) {
    throw new LockError("waitTimeoutS must be an integer >= 0");
  }

  await writeAll(sock, encodeLines(cmd, key, String(waitTimeoutS)));

  const resp = await readline(sock);
  if (resp === "timeout") {
    throw new AcquireTimeoutError(key);
  }
  if (!resp.startsWith("ok ")) {
    throw new LockError(`${label} failed: '${resp}'`);
  }

  const respParts = resp.split(" ");
  const token = respParts[1];
  if (!token) {
    throw new LockError(`${label}: server returned no token: '${resp}'`);
  }
  return { token, lease: parseLease(respParts[2]) };
}

async function protoRelease(
  sock: net.Socket,
  cmd: string,
  label: string,
  key: string,
  token: string,
): Promise<void> {
  validateKey(key);
  validateToken(token);
  await writeAll(sock, encodeLines(cmd, key, token));

  const resp = await readline(sock);
  if (resp !== "ok") {
    throw new LockError(`${label} failed: '${resp}'`);
  }
}

// ---------------------------------------------------------------------------
// Lock protocol functions
// ---------------------------------------------------------------------------

export async function acquire(
  sock: net.Socket, key: string, acquireTimeoutS: number, leaseTtlS?: number,
): Promise<{ token: string; lease: number }> {
  return protoAcquire(sock, "l", "acquire", key, acquireTimeoutS, leaseTtlS);
}

export async function renew(
  sock: net.Socket, key: string, token: string, leaseTtlS?: number,
): Promise<number> {
  return protoRenew(sock, "n", "renew", key, token, leaseTtlS);
}

export async function enqueue(
  sock: net.Socket, key: string, leaseTtlS?: number,
): Promise<{ status: "acquired" | "queued"; token: string | null; lease: number | null }> {
  return protoEnqueue(sock, "e", "enqueue", key, leaseTtlS);
}

export async function waitForLock(
  sock: net.Socket, key: string, waitTimeoutS: number,
): Promise<{ token: string; lease: number }> {
  return protoWait(sock, "w", "wait", key, waitTimeoutS);
}

export async function release(
  sock: net.Socket, key: string, token: string,
): Promise<void> {
  return protoRelease(sock, "r", "release", key, token);
}

// ---------------------------------------------------------------------------
// Semaphore protocol functions
// ---------------------------------------------------------------------------

export async function semAcquire(
  sock: net.Socket, key: string, acquireTimeoutS: number, limit: number, leaseTtlS?: number,
): Promise<{ token: string; lease: number }> {
  return protoAcquire(sock, "sl", "sem_acquire", key, acquireTimeoutS, leaseTtlS, limit);
}

export async function semRenew(
  sock: net.Socket, key: string, token: string, leaseTtlS?: number,
): Promise<number> {
  return protoRenew(sock, "sn", "sem_renew", key, token, leaseTtlS);
}

export async function semEnqueue(
  sock: net.Socket, key: string, limit: number, leaseTtlS?: number,
): Promise<{ status: "acquired" | "queued"; token: string | null; lease: number | null }> {
  return protoEnqueue(sock, "se", "sem_enqueue", key, leaseTtlS, limit);
}

export async function semWaitForLock(
  sock: net.Socket, key: string, waitTimeoutS: number,
): Promise<{ token: string; lease: number }> {
  return protoWait(sock, "sw", "sem_wait", key, waitTimeoutS);
}

export async function semRelease(
  sock: net.Socket, key: string, token: string,
): Promise<void> {
  return protoRelease(sock, "sr", "sem_release", key, token);
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
  options?: {
    host?: string;
    port?: number;
    tls?: tls.ConnectionOptions;
    auth?: string;
    connectTimeoutMs?: number;
  },
): Promise<Stats> {
  const host = options?.host ?? DEFAULT_HOST;
  const port = options?.port ?? DEFAULT_PORT;
  const sock = await connect(host, port, options?.tls, options?.auth, options?.connectTimeoutMs);
  try {
    return await statsProto(sock);
  } finally {
    sock.destroy();
  }
}

// ---------------------------------------------------------------------------
// Option interfaces
// ---------------------------------------------------------------------------

interface BaseOptions {
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
  /** TCP connect timeout in milliseconds. Undefined means no timeout. */
  connectTimeoutMs?: number;
  /**
   * Socket idle timeout in milliseconds. If no data is received within this
   * period, the socket emits a 'timeout' event and is destroyed, causing any
   * pending `readline` to reject. Undefined means no timeout.
   */
  socketTimeoutMs?: number;
}

export interface DistributedLockOptions extends BaseOptions {}

export interface DistributedSemaphoreOptions extends BaseOptions {
  limit: number;
}

// ---------------------------------------------------------------------------
// Shared base class
// ---------------------------------------------------------------------------

abstract class DistributedPrimitive {
  readonly key: string;
  readonly acquireTimeoutS: number;
  readonly leaseTtlS: number | undefined;
  readonly servers: Array<[string, number]>;
  readonly shardingStrategy: ShardingStrategy;
  readonly renewRatio: number;
  readonly tls: tls.ConnectionOptions | undefined;
  readonly auth: string | undefined;
  readonly onLockLost: ((key: string, token: string) => void) | undefined;
  readonly connectTimeoutMs: number | undefined;
  readonly socketTimeoutMs: number | undefined;

  token: string | null = null;
  lease: number = 0;

  private sock: net.Socket | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewInFlight: Promise<void> | null = null;
  private closed = false;

  constructor(opts: BaseOptions) {
    validateKey(opts.key);
    this.key = opts.key;
    this.acquireTimeoutS = opts.acquireTimeoutS ?? 10;
    this.leaseTtlS = opts.leaseTtlS;
    this.tls = opts.tls;
    this.auth = opts.auth;
    this.onLockLost = opts.onLockLost;
    this.connectTimeoutMs = opts.connectTimeoutMs;
    this.socketTimeoutMs = opts.socketTimeoutMs;

    if (!Number.isInteger(this.acquireTimeoutS) || this.acquireTimeoutS < 0) {
      throw new LockError("acquireTimeoutS must be an integer >= 0");
    }
    if (this.leaseTtlS != null && (!Number.isInteger(this.leaseTtlS) || this.leaseTtlS < 1)) {
      throw new LockError("leaseTtlS must be an integer >= 1");
    }

    if (opts.servers) {
      if (opts.servers.length === 0) {
        throw new LockError("servers list must not be empty");
      }
      this.servers = [...opts.servers];
    } else {
      this.servers = [[opts.host ?? DEFAULT_HOST, opts.port ?? DEFAULT_PORT]];
    }

    this.shardingStrategy = opts.shardingStrategy ?? stableHashShard;

    const renewRatio = opts.renewRatio ?? 0.5;
    if (!Number.isFinite(renewRatio) || renewRatio <= 0 || renewRatio >= 1) {
      throw new LockError("renewRatio must be a finite number between 0 and 1 (exclusive)");
    }
    this.renewRatio = renewRatio;
  }

  // -- abstract protocol hooks (implemented by subclasses) --

  protected abstract doAcquire(
    sock: net.Socket,
  ): Promise<{ token: string; lease: number }>;

  protected abstract doEnqueue(
    sock: net.Socket,
  ): Promise<{
    status: "acquired" | "queued";
    token: string | null;
    lease: number | null;
  }>;

  protected abstract doWait(
    sock: net.Socket,
    timeoutS: number,
  ): Promise<{ token: string; lease: number }>;

  protected abstract doRelease(
    sock: net.Socket,
    token: string,
  ): Promise<void>;

  protected abstract doRenew(
    sock: net.Socket,
    token: string,
  ): Promise<number>;

  // -- public API --

  private async openConnection(): Promise<net.Socket> {
    const [host, port] = this.pickServer();
    const sock = await connect(host, port, this.tls, this.auth, this.connectTimeoutMs);
    if (this.socketTimeoutMs != null && this.socketTimeoutMs > 0) {
      // Register the listener once; use setTimeout(ms)/setTimeout(0) to
      // toggle without accumulating duplicate listeners.
      sock.on("timeout", () => {
        sock.destroy(new LockError("socket idle timeout"));
      });
      sock.setTimeout(this.socketTimeoutMs);
    }
    return sock;
  }

  /**
   * Suspend or restore the socket idle timeout.  Only has effect when
   * `socketTimeoutMs` was set at construction time and a listener was
   * registered in `openConnection`.
   */
  private suspendSocketTimeout(sock: net.Socket): void {
    sock.setTimeout(0);
  }

  private restoreSocketTimeout(sock: net.Socket): void {
    if (this.socketTimeoutMs != null && this.socketTimeoutMs > 0) {
      sock.setTimeout(this.socketTimeoutMs);
    }
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
   * Acquire the lock / semaphore slot.
   * Returns `true` on success, `false` on timeout.
   * @param opts.force - If `true`, silently close any existing connection
   *   before acquiring. Defaults to `false`, which throws if already connected.
   */
  async acquire(opts?: { force?: boolean }): Promise<boolean> {
    if (this.sock && !this.closed) {
      if (!opts?.force) {
        throw new LockError(
          "already connected; call release() or close() first, or pass { force: true }",
        );
      }
      this.close();
    }
    this.closed = false;
    try {
      this.sock = await this.openConnection();
      // Suspend socket idle timeout during the blocking acquire — the server
      // won't send data until the lock is granted or the acquire times out.
      this.suspendSocketTimeout(this.sock);
      const result = await this.doAcquire(this.sock);
      this.restoreSocketTimeout(this.sock);
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
   * Release the lock / semaphore slot and close the connection.
   *
   * Throws `LockError` if the instance is already closed (e.g. after a
   * previous `release()` or `close()` call).
   *
   * The server-side release itself is best-effort: if the underlying
   * connection is already dead the protocol-level release error is silently
   * ignored so that the method doesn't throw on transient network failures.
   */
  async release(): Promise<void> {
    if (this.closed) {
      throw new LockError("not connected; nothing to release");
    }
    // Capture the token and socket before awaiting anything — a concurrent
    // renew failure can set this.token/this.sock to null (via onLockLost →
    // close()), which would cause us to skip the server-side release and
    // leave the lock held until lease expiry.
    const tokenToRelease = this.token;
    const sockToRelease = this.sock;
    try {
      this.stopRenew();
      // Wait for any in-flight renew to finish before sending the release
      // command — concurrent reads/writes on the same socket are unsafe.
      // Bound the wait to 5s so release() doesn't hang forever when the
      // network is unresponsive and no socketTimeoutMs is configured.
      if (this.renewInFlight) {
        await Promise.race([
          this.renewInFlight,
          new Promise<void>((r) => setTimeout(r, 5000).unref()),
        ]);
        // The loop resumes before us (it registered its .then first) and may
        // have scheduled a new timer.  Clear it so it cannot fire during
        // doRelease below.
        this.stopRenew();
      }
      if (sockToRelease != null && tokenToRelease != null) {
        try {
          await this.doRelease(sockToRelease, tokenToRelease);
        } catch {
          // Best-effort: connection may already be dead.
        }
      }
    } finally {
      this.close();
    }
  }

  /**
   * Two-phase step 1: connect and join the FIFO queue.
   * Returns `"acquired"` (fast-path) or `"queued"`.
   * If acquired immediately, the renew loop starts automatically.
   * @param opts.force - If `true`, silently close any existing connection
   *   before enqueuing. Defaults to `false`, which throws if already connected.
   */
  async enqueue(opts?: { force?: boolean }): Promise<"acquired" | "queued"> {
    if (this.sock && !this.closed) {
      if (!opts?.force) {
        throw new LockError(
          "already connected; call release() or close() first, or pass { force: true }",
        );
      }
      this.close();
    }
    this.closed = false;
    try {
      this.sock = await this.openConnection();
      this.suspendSocketTimeout(this.sock);
      const result = await this.doEnqueue(this.sock);
      if (result.status === "acquired") {
        this.token = result.token;
        this.lease = result.lease ?? 0;
        this.restoreSocketTimeout(this.sock);
        this.startRenew();
      }
      return result.status;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /**
   * Two-phase step 2: block until the lock / slot is granted.
   * Returns `true` if granted, `false` on timeout.
   * If already acquired during `enqueue()`, returns `true` immediately.
   */
  async wait(timeoutS?: number): Promise<boolean> {
    if (this.token !== null) {
      // Already acquired during enqueue (fast path)
      return true;
    }
    if (this.closed) {
      throw new LockError("connection closed; call enqueue() again");
    }
    if (!this.sock) {
      throw new LockError("not connected; call enqueue() first");
    }
    const timeout = timeoutS ?? this.acquireTimeoutS;
    try {
      // Suspend socket idle timeout during the blocking wait — the server
      // won't send data until the lock/slot is granted or the wait times out.
      this.suspendSocketTimeout(this.sock);
      const result = await this.doWait(this.sock, timeout);
      this.restoreSocketTimeout(this.sock);
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
   * Run `fn` while holding the lock / slot, then release automatically.
   *
   * If `fn()` throws, its error is always preserved — a concurrent
   * release failure will not mask it.
   */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const ok = await this.acquire();
    if (!ok) {
      throw new AcquireTimeoutError(this.key);
    }
    let threw = false;
    try {
      return await fn();
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      try {
        await this.release();
      } catch (releaseErr) {
        // If fn() already threw, swallow the release error so it
        // doesn't mask the original error.
        if (!threw) throw releaseErr;
      }
    }
  }

  /** Close the underlying socket (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopRenew();
    this.renewInFlight = null;
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
    this.token = null;
    this.lease = 0;
  }

  // -- internals --

  private startRenew(): void {
    this.stopRenew();
    const loop = async () => {
      const savedToken = this.token;
      const sock = this.sock;
      if (!sock || !savedToken) return;
      const start = Date.now();
      const p = (async () => {
        try {
          const newLease = await this.doRenew(sock, savedToken);
          // Guard: if close() ran while the renew was in-flight, don't
          // clobber the reset state (lease=0, token=null).
          if (this.token === savedToken && !this.closed) {
            this.lease = newLease;
          }
        } catch {
          // Only signal lock-lost if we still own this token (close() may have cleared it)
          if (this.token === savedToken) {
            this.token = null;
            if (this.onLockLost) {
              try {
                // Cast to unknown: the declared return type is void, but an
                // async callback will return a Promise at runtime.
                const result: unknown = this.onLockLost(this.key, savedToken);
                // Guard against async callbacks returning a rejected Promise.
                if (result instanceof Promise) {
                  result.catch(() => {});
                }
              } catch {
                // Never let a user callback crash the process.
              }
            }
            // Tear down the connection so the instance is in a clean state
            // for re-acquisition.  Without this the socket leaks and a
            // subsequent acquire() without { force: true } would throw
            // "already connected".
            this.close();
          }
          return;
        }
      })();
      this.renewInFlight = p;
      await p;
      this.renewInFlight = null;
      // Guard: if close() was called while the renew was in-flight, don't
      // schedule another iteration (avoids clobbering a new acquire's timer).
      if (this.closed || this.token !== savedToken) return;
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
// DistributedLock
// ---------------------------------------------------------------------------

export class DistributedLock extends DistributedPrimitive {
  constructor(opts: DistributedLockOptions) {
    super(opts);
  }

  protected doAcquire(sock: net.Socket) {
    return acquire(sock, this.key, this.acquireTimeoutS, this.leaseTtlS);
  }

  protected doEnqueue(sock: net.Socket) {
    return enqueue(sock, this.key, this.leaseTtlS);
  }

  protected doWait(sock: net.Socket, timeoutS: number) {
    return waitForLock(sock, this.key, timeoutS);
  }

  protected doRelease(sock: net.Socket, token: string) {
    return release(sock, this.key, token);
  }

  protected doRenew(sock: net.Socket, token: string) {
    return renew(sock, this.key, token, this.leaseTtlS);
  }
}

// ---------------------------------------------------------------------------
// DistributedSemaphore
// ---------------------------------------------------------------------------

export class DistributedSemaphore extends DistributedPrimitive {
  readonly limit: number;

  constructor(opts: DistributedSemaphoreOptions) {
    super(opts);
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new LockError("limit must be an integer >= 1");
    }
    this.limit = opts.limit;
  }

  protected doAcquire(sock: net.Socket) {
    return semAcquire(
      sock,
      this.key,
      this.acquireTimeoutS,
      this.limit,
      this.leaseTtlS,
    );
  }

  protected doEnqueue(sock: net.Socket) {
    return semEnqueue(sock, this.key, this.limit, this.leaseTtlS);
  }

  protected doWait(sock: net.Socket, timeoutS: number) {
    return semWaitForLock(sock, this.key, timeoutS);
  }

  protected doRelease(sock: net.Socket, token: string) {
    return semRelease(sock, this.key, token);
  }

  protected doRenew(sock: net.Socket, token: string) {
    return semRenew(sock, this.key, token, this.leaseTtlS);
  }
}

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

export interface Signal {
  channel: string;
  payload: string;
}

// ---------------------------------------------------------------------------
// Signal protocol functions
// ---------------------------------------------------------------------------

function validatePayload(payload: string): void {
  if (payload === "") {
    throw new LockError("payload must not be empty");
  }
  if (/[\0\n\r]/.test(payload)) {
    throw new LockError(
      "payload must not contain NUL, newline, or carriage return characters",
    );
  }
}

/**
 * Publish a signal on a channel using a regular socket (request-response).
 * Returns the number of listeners that received the signal.
 *
 * Use this when you only need to publish and don't need to receive signals.
 * For subscribing to signals, use `SignalConnection`.
 */
export async function publish(
  sock: net.Socket,
  channel: string,
  payload: string,
): Promise<number> {
  validateKey(channel);
  validatePayload(payload);
  await writeAll(sock, encodeLines("signal", channel, payload));
  const resp = await readline(sock);
  if (!resp.startsWith("ok ")) {
    throw new LockError(`signal failed: '${resp}'`);
  }
  const n = parseInt(resp.split(" ")[1], 10);
  if (!Number.isFinite(n)) {
    throw new LockError(`signal: bad delivery count: '${resp}'`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// SignalConnection
// ---------------------------------------------------------------------------

export interface SignalConnectionOptions {
  /** Server host (default `"127.0.0.1"`). */
  host?: string;
  /** Server port (default `6388`). */
  port?: number;
  /** TLS options; pass `{}` for default system CA. */
  tls?: tls.ConnectionOptions;
  /** Auth token for servers started with `--auth-token`. */
  auth?: string;
  /** TCP connect timeout in milliseconds. */
  connectTimeoutMs?: number;
}

/**
 * A connection dedicated to the signal (pub/sub) protocol.
 *
 * Wraps a socket with a background line reader that separates asynchronous
 * `sig` push messages from command responses, allowing `listen`, `unlisten`,
 * and `emit` to be called while signals are being delivered.
 *
 * ```ts
 * const conn = await SignalConnection.connect();
 * conn.onSignal((sig) => console.log(sig.channel, sig.payload));
 * await conn.listen("events.>");
 * ```
 */
export class SignalConnection {
  private sock: net.Socket;
  private buf = "";
  private responseResolve: ((line: string) => void) | null = null;
  private responseReject: ((err: Error) => void) | null = null;
  private cmdQueue: Array<() => void> = [];
  private cmdBusy = false;
  private signalListeners: Array<(signal: Signal) => void> = [];
  private _closed = false;

  /**
   * Wrap an existing socket as a SignalConnection.
   *
   * The socket should already be connected (and authenticated, if needed).
   * Prefer `SignalConnection.connect()` for convenience.
   */
  constructor(sock: net.Socket) {
    this.sock = sock;

    // Drain any leftover buffer from the global readline WeakMap.
    const leftover = _readlineBuf.get(sock);
    if (leftover) {
      this.buf = leftover;
      _readlineBuf.delete(sock);
    }

    sock.on("data", (chunk: Buffer) => this.onData(chunk));
    sock.on("error", (err: Error) => this.onSocketError(err));
    sock.on("close", () => this.onSocketEnd());
    sock.on("end", () => this.onSocketEnd());

    // Process any lines already buffered.
    this.drainLines();
  }

  /** Connect to a dflockd server and return a SignalConnection. */
  static async connect(
    opts?: SignalConnectionOptions,
  ): Promise<SignalConnection> {
    const host = opts?.host ?? DEFAULT_HOST;
    const port = opts?.port ?? DEFAULT_PORT;
    const sock = await connect(
      host,
      port,
      opts?.tls,
      opts?.auth,
      opts?.connectTimeoutMs,
    );
    return new SignalConnection(sock);
  }

  /**
   * Subscribe to signals matching `pattern`.
   *
   * Patterns support NATS-style wildcards:
   * - `*` matches exactly one dot-separated token
   * - `>` matches one or more trailing tokens
   *
   * If `group` is provided, the subscription joins a queue group where
   * signals are load-balanced (round-robin) among group members.
   */
  async listen(pattern: string, group?: string): Promise<void> {
    validateKey(pattern);
    if (group != null && /[\0\n\r]/.test(group)) {
      throw new LockError(
        "group must not contain NUL, newline, or carriage return characters",
      );
    }
    const resp = await this.sendCmd("listen", pattern, group ?? "");
    if (resp !== "ok") {
      throw new LockError(`listen failed: '${resp}'`);
    }
  }

  /**
   * Unsubscribe from signals matching `pattern`.
   * The `pattern` and `group` must match a previous `listen()` call.
   */
  async unlisten(pattern: string, group?: string): Promise<void> {
    validateKey(pattern);
    if (group != null && /[\0\n\r]/.test(group)) {
      throw new LockError(
        "group must not contain NUL, newline, or carriage return characters",
      );
    }
    const resp = await this.sendCmd("unlisten", pattern, group ?? "");
    if (resp !== "ok") {
      throw new LockError(`unlisten failed: '${resp}'`);
    }
  }

  /**
   * Publish a signal on a literal channel (no wildcards).
   * Returns the number of listeners that received the signal.
   */
  async emit(channel: string, payload: string): Promise<number> {
    validateKey(channel);
    validatePayload(payload);
    const resp = await this.sendCmd("signal", channel, payload);
    if (!resp.startsWith("ok ")) {
      throw new LockError(`signal failed: '${resp}'`);
    }
    const n = parseInt(resp.split(" ")[1], 10);
    if (!Number.isFinite(n)) {
      throw new LockError(`signal: bad delivery count: '${resp}'`);
    }
    return n;
  }

  /** Register a listener for incoming signals. */
  onSignal(listener: (signal: Signal) => void): void {
    this.signalListeners.push(listener);
  }

  /** Remove a previously registered signal listener. */
  offSignal(listener: (signal: Signal) => void): void {
    const idx = this.signalListeners.indexOf(listener);
    if (idx >= 0) this.signalListeners.splice(idx, 1);
  }

  /**
   * Async iterator that yields signals as they arrive.
   * Terminates when the connection closes.
   *
   * ```ts
   * for await (const sig of conn) {
   *   console.log(sig.channel, sig.payload);
   * }
   * ```
   */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Signal> {
    const buffer: Signal[] = [];
    let waiter: (() => void) | null = null;

    const listener = (sig: Signal) => {
      buffer.push(sig);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    };

    const onEnd = () => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
    };

    this.onSignal(listener);
    this.sock.once("close", onEnd);

    try {
      while (true) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
          continue;
        }
        if (this._closed) break;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
      // Drain any remaining buffered signals.
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }
    } finally {
      this.offSignal(listener);
      this.sock.removeListener("close", onEnd);
    }
  }

  /** Close the connection (idempotent). */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.sock.destroy();
    this.rejectPending(new LockError("connection closed"));
  }

  /** Whether the connection is closed. */
  get isClosed(): boolean {
    return this._closed;
  }

  // ---- internals ----

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf-8");
    if (this.buf.length > MAX_LINE_LENGTH * 2) {
      this.buf = "";
      this._closed = true;
      this.sock.destroy();
      this.rejectPending(
        new LockError("server response exceeded maximum buffer size"),
      );
      return;
    }
    this.drainLines();
  }

  private drainLines(): void {
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith("sig ")) {
      const rest = line.slice(4);
      const spaceIdx = rest.indexOf(" ");
      if (spaceIdx < 0) return; // malformed push, skip
      const sig: Signal = {
        channel: rest.slice(0, spaceIdx),
        payload: rest.slice(spaceIdx + 1),
      };
      for (const listener of [...this.signalListeners]) {
        try {
          listener(sig);
        } catch {
          // Never let a user callback crash the read loop.
        }
      }
      return;
    }
    // Command response.
    if (this.responseResolve) {
      const resolve = this.responseResolve;
      this.responseResolve = null;
      this.responseReject = null;
      resolve(line);
    }
  }

  private onSocketError(err: Error): void {
    this._closed = true;
    this.rejectPending(err);
  }

  private onSocketEnd(): void {
    this._closed = true;
    this.rejectPending(new LockError("server closed connection"));
  }

  private rejectPending(err: Error): void {
    if (this.responseReject) {
      const reject = this.responseReject;
      this.responseResolve = null;
      this.responseReject = null;
      reject(err);
    }
  }

  private sendCmd(cmd: string, key: string, arg: string): Promise<string> {
    return new Promise<string>((outerResolve, outerReject) => {
      const execute = () => {
        if (this._closed) {
          this.cmdBusy = false;
          this.dequeueNext();
          outerReject(new LockError("connection closed"));
          return;
        }
        let settled = false;
        this.responseResolve = (line: string) => {
          if (settled) return;
          settled = true;
          this.cmdBusy = false;
          this.dequeueNext();
          outerResolve(line);
        };
        this.responseReject = (err: Error) => {
          if (settled) return;
          settled = true;
          this.cmdBusy = false;
          this.dequeueNext();
          outerReject(err);
        };
        this.sock.write(encodeLines(cmd, key, arg), (err) => {
          if (err && !settled) {
            settled = true;
            this.responseResolve = null;
            this.responseReject = null;
            this.cmdBusy = false;
            this.dequeueNext();
            outerReject(err);
          }
        });
      };

      if (this.cmdBusy) {
        this.cmdQueue.push(execute);
      } else {
        this.cmdBusy = true;
        execute();
      }
    });
  }

  private dequeueNext(): void {
    const next = this.cmdQueue.shift();
    if (next) {
      this.cmdBusy = true;
      next();
    }
  }
}
