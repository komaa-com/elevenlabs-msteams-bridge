import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for agent-supplied URLs (show_image). The tool params come from
 * the agent's LLM, i.e. indirectly from the caller — a crafted prompt must not
 * be able to make the bridge fetch cloud metadata (169.254.169.254), loopback,
 * or RFC1918 hosts. Mirrors the intent of the worker's SsrfGuard.cs
 * (re-resolve + reject private/loopback/link-local/metadata). Residual DNS
 * TOCTOU is narrowed by `redirect: "error"` and the timeout at the call site;
 * full IP pinning (the worker's P2-6) is not implementable with plain fetch —
 * revisit with an undici Agent if this bridge ever fetches less-trusted URLs.
 */

type LookupFn = (hostname: string, opts: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inCidr4(ip: number, base: string, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

/** True for any IPv4 address that must never be fetched server-side. */
export function isForbiddenIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return (
    inCidr4(n, "0.0.0.0", 8) || // "this" network
    inCidr4(n, "10.0.0.0", 8) || // RFC1918
    inCidr4(n, "100.64.0.0", 10) || // CGNAT
    inCidr4(n, "127.0.0.0", 8) || // loopback
    inCidr4(n, "169.254.0.0", 16) || // link-local incl. cloud metadata
    inCidr4(n, "172.16.0.0", 12) || // RFC1918
    inCidr4(n, "192.0.0.0", 24) || // IETF protocol assignments
    inCidr4(n, "192.168.0.0", 16) || // RFC1918
    inCidr4(n, "198.18.0.0", 15) || // benchmarking
    inCidr4(n, "224.0.0.0", 3) // multicast + reserved + broadcast
  );
}

/** True for any IPv6 address that must never be fetched server-side. */
export function isForbiddenIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // v4-mapped/translated (::ffff:a.b.c.d, 64:ff9b::/96) → judge the embedded v4
  if (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:")) {
    const dotted = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) {
      return isForbiddenIpv4(dotted[1]);
    }
    // hex-encoded tail (e.g. 64:ff9b::a00:1 = 10.0.0.1): last 32 bits are the v4
    const groups = lower.split("::").pop()!.split(":").filter(Boolean);
    if (groups.length <= 2) {
      const hi = groups.length === 2 ? parseInt(groups[0], 16) : 0;
      const lo = parseInt(groups[groups.length - 1] ?? "0", 16) || 0;
      return isForbiddenIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return true; // malformed mapped form — refuse rather than guess
  }
  if (lower === "::" || lower === "::1") {
    return true; // unspecified / loopback
  }
  const firstGroup = lower.split(":")[0] || "0";
  const first16 = parseInt(firstGroup === "" ? "0" : firstGroup, 16);
  if ((first16 & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique-local
  }
  if ((first16 & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  return false;
}

export function isForbiddenIp(ip: string): boolean {
  const family = isIP(ip);
  return family === 4 ? isForbiddenIpv4(ip) : family === 6 ? isForbiddenIpv6(ip) : true;
}

/**
 * Read a fetch Response body with a hard byte cap: rejects on Content-Length
 * upfront, then streams with a running total so an oversized (or lying) server
 * can't balloon memory before the size check.
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large (${declared} bytes, max ${maxBytes})`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`response too large (${buf.length} bytes, max ${maxBytes})`);
    }
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`response exceeded ${maxBytes} bytes; aborting read`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Validate an outbound URL: http(s) only, no credentials, and every address the
 * host resolves to must be public. Throws with a reason on rejection.
 */
export async function assertPublicHttpUrl(raw: string, lookupFn: LookupFn = lookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`forbidden protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  // WHATWG URL keeps brackets on IPv6 literals ("[::1]") — strip for isIP()
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isForbiddenIp(host)) {
      throw new Error(`address ${host} is private/reserved`);
    }
    return url;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookupFn(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`cannot resolve host ${host}`);
  }
  if (addrs.length === 0) {
    throw new Error(`host ${host} resolves to no addresses`);
  }
  for (const a of addrs) {
    if (isForbiddenIp(a.address)) {
      throw new Error(`host ${host} resolves to private/reserved address ${a.address}`);
    }
  }
  return url;
}
