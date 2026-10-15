import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import { ExtractError } from "./types";

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const defaultResolver: Resolver = (h) => dnsLookup(h, { all: true, verbatim: true });

/** Only globally routable unicast addresses are allowed (blocks loopback, RFC1918, link-local/metadata, CGNAT, ULA, multicast…). */
export function isPublicAddress(address: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  return addr.range() === "unicast";
}

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolver?: Resolver;
  /** Tests only: exact non-public addresses to allow (never set in production code paths). */
  allowPrivateForTests?: string[];
  allowedPorts?: number[];
};

export type SafeFetchResult = { finalUrl: string; status: number; contentType: string; body: Buffer };

/** Validates one hop (the first URL and every redirect target) and returns the address to pin. */
export async function validateHop(raw: string, opts: Pick<SafeFetchOptions, "resolver" | "allowPrivateForTests" | "allowedPorts"> = {}): Promise<{ url: URL; address: string; family: number }> {
  const resolver = opts.resolver ?? defaultResolver;
  const allowedPorts = opts.allowedPorts ?? [80, 443];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExtractError("blocked_url", "invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ExtractError("blocked_url", "scheme not allowed");
  if (url.username || url.password) throw new ExtractError("blocked_url", "credentials in url");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts.includes(port)) throw new ExtractError("blocked_url", "port not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new ExtractError("blocked_url", "host not allowed");
  const candidates = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host).catch(() => []);
  if (!candidates.length) throw new ExtractError("fetch_failed", "dns failed");
  // every resolved address must be public: a mixed answer is treated as a rebinding attempt
  const allowed = new Set(opts.allowPrivateForTests ?? []);
  if (candidates.some((c) => !isPublicAddress(c.address) && !allowed.has(c.address))) throw new ExtractError("blocked_url", "non-public address");
  return { url, address: candidates[0]!.address, family: candidates[0]!.family };
}

/**
 * SSRF-hardened GET: validates scheme/port, resolves DNS itself, rejects any
 * non-public address, pins the TCP connection to the validated IP (defeats DNS
 * rebinding between check and connect), re-validates every redirect hop and
 * caps size and time.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, address, family } = await validateHop(current, opts);
    const pinned = { address, family };

    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname: string, _o: unknown, cb: (err: Error | null, address: string, family: number) => void) => cb(null, pinned.address, pinned.family),
        timeout: 10_000,
      },
      headersTimeout: opts.timeoutMs ?? 15_000,
      bodyTimeout: opts.timeoutMs ?? 15_000,
    });
    try {
      const res = await request(url, {
        method: "GET",
        dispatcher,
        maxRedirections: 0,
        headers: { "user-agent": "TalabaAI-Fetcher/1.0 (+study source import)", accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.5" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      } as never);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        await res.body.dump();
        current = new URL(String(res.headers.location), url).toString();
        continue;
      }
      if (res.statusCode >= 400) {
        await res.body.dump();
        throw new ExtractError("fetch_failed", `status ${res.statusCode}`);
      }
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > maxBytes) {
        await res.body.dump();
        throw new ExtractError("too_large");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          res.body.destroy();
          throw new ExtractError("too_large");
        }
        chunks.push(chunk as Buffer);
      }
      return { finalUrl: url.toString(), status: res.statusCode, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) };
    } catch (e) {
      if (e instanceof ExtractError) throw e;
      throw new ExtractError("fetch_failed", e instanceof Error ? e.message : String(e));
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }
  throw new ExtractError("blocked_url", "too many redirects");
}
