import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type RequestOptions } from "node:http";
import { isIP } from "node:net";

export interface SourceLimits {
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  maxSamplingConcurrency: number;
}
const defaults: SourceLimits = {
  connectTimeoutMs: 3_000,
  readTimeoutMs: 5_000,
  maxResponseBytes: 262_144,
  maxRedirects: 3,
  maxSamplingConcurrency: 4,
};
type Address = { address: string; family: number };
export type Resolver = (host: string) => Promise<Address[]>;

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 2 && c === 0))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || address.includes("%") || address.includes("."))
    return false;
  // Conservative global-unicast allowlist excludes mapped/compatible IPv4,
  // local, multicast, documentation and transition mechanisms.
  const first = parseInt(address.split(":")[0] ?? "", 16);
  if (
    !Number.isFinite(first) ||
    first < 0x2000 ||
    first > 0x3fff ||
    first === 0x2002
  )
    return false;
  if (first === 0x2001) {
    const second = parseInt(address.split(":")[1] || "0", 16);
    if (second < 0x200 || second === 0xdb8) return false;
  }
  return true;
}

export class SourceClient {
  readonly limits: SourceLimits;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly fixtureOrigins: ReadonlySet<string>;

  constructor(
    limits: Partial<SourceLimits> = {},
    private readonly resolve: Resolver = (host) =>
      lookup(host, { all: true, verbatim: true }),
    fixtureOrigins: readonly string[] = []
  ) {
    this.limits = { ...defaults, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (
        !Number.isSafeInteger(value) ||
        value < (key === "maxRedirects" ? 0 : 1)
      )
        throw new Error(`invalid source limit ${key}`);
    }
    if (fixtureOrigins.length && process.env.NODE_ENV !== "test")
      throw new Error("source fixture bypass is test-only");
    this.fixtureOrigins = new Set(fixtureOrigins);
  }

  async retrieve(
    sourceUrl: string,
    allowedDomains: readonly string[]
  ): Promise<unknown> {
    if (sourceUrl.length > 2048) throw new Error("source URL is too large");
    if (this.active >= this.limits.maxSamplingConcurrency)
      await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      let url = new URL(sourceUrl);
      const seen = new Set<string>();
      for (let redirects = 0; ; redirects++) {
        if (seen.has(url.href)) throw new Error("source redirect loop");
        seen.add(url.href);
        const fixture = this.fixtureOrigins.has(url.origin);
        if (
          (url.protocol !== "https:" &&
            !(fixture && url.protocol === "http:")) ||
          url.username ||
          url.password ||
          url.hash ||
          (!fixture && url.port && url.port !== "443") ||
          !allowedDomains.includes(url.hostname)
        )
          throw new Error("source URL/domain is forbidden");
        const host = url.hostname.replace(/^\[|\]$/g, "");
        if (
          !fixture &&
          (host === "localhost" ||
            host.endsWith(".localhost") ||
            host.endsWith(".local"))
        )
          throw new Error("source hostname is forbidden");
        const addresses = isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await this.resolveBounded(host);
        if (
          !addresses.length ||
          addresses.some(
            (a) => !isIP(a.address) || (!fixture && !isPublicAddress(a.address))
          )
        )
          throw new Error("source resolved address is forbidden");
        const response = await this.readPinned(url, addresses[0]!);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.location || redirects >= this.limits.maxRedirects)
            throw new Error("too many source redirects");
          url = new URL(response.location, url);
          continue; // URL, domain and DNS/IP checks repeat at every hop.
        }
        if (response.status !== 200)
          throw new Error(`source HTTP ${response.status}`);
        return JSON.parse(response.body);
      }
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async resolveBounded(host: string): Promise<Address[]> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        this.resolve(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("source connect timeout (DNS)")),
            this.limits.connectTimeoutMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private readPinned(
    url: URL,
    address: Address
  ): Promise<{ status: number; location?: string; body: string }> {
    return new Promise((resolve, reject) => {
      let done = false;
      let readTimer: ReturnType<typeof setTimeout> | undefined;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const options: RequestOptions = {
        agent: false,
        headers: { accept: "application/json", "accept-encoding": "identity" },
        // The socket uses only this validated address; there is no second DNS
        // lookup between validation and connection (including redirect hops).
        lookup: (_host, opts, callback) => {
          if (typeof opts === "object" && opts.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      };
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        options,
        (response) => {
          const size = Number(response.headers["content-length"] ?? 0);
          if (size > this.limits.maxResponseBytes)
            return finish(new Error("source response too large"));
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > this.limits.maxResponseBytes)
              finish(new Error("source response too large"));
            else chunks.push(chunk);
          });
          response.on("error", finish);
          response.on("aborted", () =>
            finish(new Error("source response aborted"))
          );
          response.on("end", () => {
            if (done) return;
            done = true;
            clearTimeout(connectTimer);
            clearTimeout(readTimer);
            resolve({
              status: response.statusCode ?? 0,
              ...(response.headers.location
                ? { location: response.headers.location }
                : {}),
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        }
      );
      const finish = (error: Error) => {
        if (done) return;
        done = true;
        clearTimeout(connectTimer);
        clearTimeout(readTimer);
        request.destroy();
        reject(error);
      };
      const connectTimer = setTimeout(
        () => finish(new Error("source connect timeout")),
        this.limits.connectTimeoutMs
      );
      request.on("socket", (socket) => {
        socket.once(
          url.protocol === "https:" ? "secureConnect" : "connect",
          () => {
            clearTimeout(connectTimer);
            readTimer = setTimeout(
              () => finish(new Error("source read timeout")),
              this.limits.readTimeoutMs
            );
          }
        );
      });
      request.on("error", finish);
      request.end();
    });
  }
}
