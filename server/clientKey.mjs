// Rate-limit keys derived from a connection's network address.
//
// Why not use the raw address: an attacker with a routed IPv6 prefix owns
// 2^64 addresses, so a per-address bucket is free to rotate around. IPv6 is
// therefore keyed by its /64 network, which is the smallest block normally
// assigned to one customer. IPv4 keeps full-address keying because addresses
// there are scarce and often shared by many legitimate users behind NAT.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

function isIpv4(value) {
  return IPV4.test(value) && value.split('.').every((part) => Number(part) <= 255)
}

/** Expands `::` and pads groups so equivalent IPv6 spellings key identically. */
function expandIpv6(value) {
  if (!value.includes(':')) return null

  const [head, tail = ''] = value.split('::')
  if (value.split('::').length > 2) return null

  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const missing = 8 - headGroups.length - tailGroups.length

  const groups = value.includes('::')
    ? [...headGroups, ...Array(Math.max(missing, 0)).fill('0'), ...tailGroups]
    : headGroups

  if (groups.length !== 8) return null

  const normalized = []
  for (const group of groups) {
    const part = group === '' ? '0' : group
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    normalized.push(part.toLowerCase().padStart(4, '0'))
  }
  return normalized
}

/**
 * Turns a raw address into a stable bucket key.
 *
 * - IPv4            -> "ipv4:203.0.113.7"
 * - IPv4-mapped v6  -> the same IPv4 key, so ::ffff:203.0.113.7 cannot dodge it
 * - IPv6            -> "ipv6:<first four groups>::/64"
 * - anything else   -> "unknown:<trimmed value>", never a single shared bucket
 */
export function rateLimitKey(rawAddress) {
  const value = String(rawAddress ?? '').trim()
  if (!value) return 'unknown:none'

  // Strip brackets and any :port suffix on a bracketed IPv6 literal.
  const unbracketed = value.startsWith('[')
    ? value.slice(1, value.indexOf(']') === -1 ? undefined : value.indexOf(']'))
    : value

  // IPv4 with a port, e.g. "203.0.113.7:51234".
  const ipv4WithPort = unbracketed.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/)
  const candidate = ipv4WithPort ? ipv4WithPort[1] : unbracketed

  if (isIpv4(candidate)) return `ipv4:${candidate}`

  // IPv4-mapped and IPv4-compatible IPv6, e.g. "::ffff:203.0.113.7".
  const mapped = candidate.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped && isIpv4(mapped[1])) return `ipv4:${mapped[1]}`

  const groups = expandIpv6(candidate.split('%')[0])
  if (groups) return `ipv6:${groups.slice(0, 4).join(':')}::/64`

  // Malformed or unavailable: keep it distinct so one bad value cannot lump
  // every unknown client into a single bucket.
  return `unknown:${candidate.slice(0, 64)}`
}

/**
 * X-Forwarded-For is client-controlled, so it is only read when a trusted
 * reverse proxy is declared via TRUST_PROXY. Otherwise a limiter keyed on it
 * would be bypassed by sending a random header per request.
 */
export function socketRateKey(socket, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = socket?.handshake?.headers?.['x-forwarded-for']
    const first = String(forwarded ?? '').split(',')[0].trim()
    if (first) return rateLimitKey(first)
  }
  return rateLimitKey(socket?.handshake?.address)
}
