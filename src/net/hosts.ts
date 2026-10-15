// Outbound-destination policy (I3). Pure: no I/O. A URL is acceptable when its
// host is a loopback address or is listed in `network.allowedHosts`.

export class HostPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostPolicyError';
  }
}

/** `localhost`, any 127.x.x.x address, or `::1`. `host` is a URL hostname (IPv6 in brackets). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((p) => Number(p) <= 255);
}

/**
 * Parse an embeddings base URL and check it against the policy. Returns the
 * URL with no trailing slash. Throws HostPolicyError for a malformed URL, a
 * non-http(s) scheme, embedded credentials, a query or fragment, or a
 * non-loopback host that is not in `allowedHosts`.
 */
export function checkBaseUrl(value: string, allowedHosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostPolicyError('is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HostPolicyError('must be an http: or https: URL');
  if (url.username !== '' || url.password !== '') throw new HostPolicyError('must not contain credentials');
  if (url.search !== '' || url.hash !== '') throw new HostPolicyError('must not contain a query or fragment');
  if (!isLoopbackHost(url.hostname) && !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new HostPolicyError(`host "${url.hostname}" is not loopback and is not in network.allowedHosts`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
