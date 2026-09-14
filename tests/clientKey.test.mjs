// Rate-limit keying.
//
// The join limiter used to key on the raw handshake address. That is fine for
// IPv4, but a single IPv6 customer is routinely handed a /64 -- 18 quintillion
// addresses -- so per-address keys can be rotated forever. Keys are therefore
// normalized to the /64 subnet for IPv6, while staying per-address for IPv4 so
// unrelated users are never lumped together.

import { rateLimitKey, socketRateKey } from '../server/clientKey.mjs'

let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL  ${name}\n        ${error.message}\n`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

console.log('\nrate-limit keys: IPv4')

check('an IPv4 address keys on the exact address', () => {
  assert(rateLimitKey('203.0.113.9') === 'ipv4:203.0.113.9', rateLimitKey('203.0.113.9'))
})

check('two different IPv4 addresses get different keys', () => {
  assert(
    rateLimitKey('203.0.113.9') !== rateLimitKey('203.0.113.10'),
    'IPv4 users must not share a bucket',
  )
})

check('a port suffix is stripped', () => {
  assert(rateLimitKey('203.0.113.9:54321') === 'ipv4:203.0.113.9', rateLimitKey('203.0.113.9:54321'))
})

check('an IPv4-mapped IPv6 address is treated as IPv4', () => {
  assert(rateLimitKey('::ffff:203.0.113.9') === 'ipv4:203.0.113.9', rateLimitKey('::ffff:203.0.113.9'))
})

check('IPv4 loopback in mapped form matches plain loopback', () => {
  assert(rateLimitKey('::ffff:127.0.0.1') === rateLimitKey('127.0.0.1'), 'mapped form must normalize')
})

console.log('\nrate-limit keys: IPv6')

check('an IPv6 address keys on its /64 subnet', () => {
  const key = rateLimitKey('2001:db8:85a3:1234:5678:8a2e:0370:7334')
  assert(key === 'ipv6:2001:0db8:85a3:1234::/64', key)
})

check('rotating the host half of a /64 does not change the key', () => {
  const a = rateLimitKey('2001:db8:85a3:1234:1::1')
  const b = rateLimitKey('2001:db8:85a3:1234:ffff:ffff:ffff:ffff')
  assert(a === b, 'an attacker rotating addresses inside one /64 must stay in one bucket')
})

check('a different /64 gets a different key', () => {
  const a = rateLimitKey('2001:db8:85a3:1234::1')
  const b = rateLimitKey('2001:db8:85a3:9999::1')
  assert(a !== b, 'unrelated IPv6 users must not share one global bucket')
})

check('compressed and expanded forms of one address agree', () => {
  assert(
    rateLimitKey('2001:db8::1') === rateLimitKey('2001:0db8:0000:0000:0000:0000:0000:0001'),
    'the :: shorthand must expand',
  )
})

check('IPv6 loopback is a valid key, not an error', () => {
  assert(rateLimitKey('::1') === 'ipv6:0000:0000:0000:0000::/64', rateLimitKey('::1'))
})

check('a bracketed address with a port is handled', () => {
  assert(
    rateLimitKey('[2001:db8:85a3:1234::1]:443') === 'ipv6:2001:0db8:85a3:1234::/64',
    rateLimitKey('[2001:db8:85a3:1234::1]:443'),
  )
})

check('a zone index is ignored', () => {
  assert(
    rateLimitKey('fe80::1%eth0') === rateLimitKey('fe80::1'),
    'the interface zone is local metadata, not part of the address',
  )
})

console.log('\nrate-limit keys: malformed input')

check('an unparseable address still produces a stable key', () => {
  assert(rateLimitKey('not-an-address') === 'unknown:not-an-address', rateLimitKey('not-an-address'))
})

check('two different malformed values do not collide', () => {
  assert(
    rateLimitKey('garbage-a') !== rateLimitKey('garbage-b'),
    'a single "unknown" bucket would let one bad client throttle everyone',
  )
})

check('an out-of-range IPv4 octet is not accepted as IPv4', () => {
  assert(!rateLimitKey('999.1.1.1').startsWith('ipv4:'), rateLimitKey('999.1.1.1'))
})

check('an empty address is handled', () => {
  assert(rateLimitKey('') === 'unknown:none', rateLimitKey(''))
  assert(rateLimitKey(undefined) === 'unknown:none', String(rateLimitKey(undefined)))
})

console.log('\nrate-limit keys: proxy handling')

const proxied = {
  handshake: {
    address: '10.1.1.1',
    headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18' },
  },
}

check('X-Forwarded-For is ignored when TRUST_PROXY is off', () => {
  assert(
    socketRateKey(proxied, { trustProxy: false }) === 'ipv4:10.1.1.1',
    'a spoofable header must never drive a limiter',
  )
})

check('X-Forwarded-For is used when TRUST_PROXY is on', () => {
  assert(
    socketRateKey(proxied, { trustProxy: true }) === 'ipv4:203.0.113.9',
    'behind a trusted proxy the first entry is the real client',
  )
})

check('a forwarded IPv6 client is normalized the same way', () => {
  const socket = {
    handshake: {
      address: '10.1.1.1',
      headers: { 'x-forwarded-for': '2001:db8:85a3:1234::9' },
    },
  }
  assert(
    socketRateKey(socket, { trustProxy: true }) === 'ipv6:2001:0db8:85a3:1234::/64',
    'both limiters must key IPv6 identically, proxied or not',
  )
})

if (failures > 0) {
  console.error(`\n${failures} client key assertion(s) failed`)
  process.exit(1)
}
console.log('\nclient keys: all assertions passed')
process.exit(0)
