import assert from 'node:assert/strict'
import {
  formatRoomCode,
  isValidRoomCode,
  looksLikeIpAddress,
  normalizeRoomCode,
} from './roomCode.build.mjs'
// Generation moved to the server in Phase 2 -- the browser can no longer pick
// its own code -- but the entropy assertions below still apply unchanged.
import { generateRoomCode } from '../server/roomCode.mjs'

let pass = 0
let fail = 0

const check = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log('  PASS  ' + name)
  } catch (error) {
    fail += 1
    console.log('  FAIL  ' + name + '\n        ' + error.message)
  }
}

console.log('\n=== room code generator ===')

const N = 200000
const codes = Array.from({ length: N }, generateRoomCode)

check('all generated codes are 8 chars', () => {
  assert.ok(codes.every((c) => c.length === 8))
})

check('all generated codes pass validation', () => {
  assert.ok(codes.every(isValidRoomCode))
})

check('no code ever contains I, L, O or U', () => {
  const bad = codes.filter((c) => /[ILOU]/.test(c))
  assert.equal(bad.length, 0, 'found ' + bad.length)
})

check('no collisions in ' + N.toLocaleString() + ' codes', () => {
  assert.equal(new Set(codes).size, N)
})

check('character distribution is uniform (chi-square sanity)', () => {
  const counts = new Map()
  for (const c of codes) for (const ch of c) counts.set(ch, (counts.get(ch) || 0) + 1)
  assert.equal(counts.size, 32, 'expected all 32 symbols, got ' + counts.size)
  const expected = (N * 8) / 32
  const chi = [...counts.values()].reduce((s, o) => s + (o - expected) ** 2 / expected, 0)
  // 31 degrees of freedom, p=0.001 critical value is ~61.1
  assert.ok(chi < 61.1, 'chi-square = ' + chi.toFixed(2))
  console.log('        chi-square = ' + chi.toFixed(2) + ' (31 df, threshold 61.1)')
})

check('codes are not derived from anything stable across calls', () => {
  assert.notEqual(generateRoomCode(), generateRoomCode())
})

console.log('\n=== normalization and validation ===')

check('normalize strips dashes, spaces and lowercases', () => {
  assert.equal(normalizeRoomCode('k7qf-2m9x'), 'K7QF2M9X')
  assert.equal(normalizeRoomCode(' k7qf 2m9x '), 'K7QF2M9X')
  assert.equal(normalizeRoomCode('K7QF_2M9X'), 'K7QF2M9X')
})

check('normalize truncates overlong input', () => {
  assert.equal(normalizeRoomCode('K7QF2M9XEXTRAJUNK').length, 8)
})

check('validation rejects excluded letters and wrong lengths', () => {
  assert.equal(isValidRoomCode('IIIILLLL'), false)
  assert.equal(isValidRoomCode('K7QF2M9'), false)
  assert.equal(isValidRoomCode('K7QF2M9XX'), false)
  assert.equal(isValidRoomCode('k7qf2m9x'), false)
  assert.equal(isValidRoomCode(''), false)
})

check('IP-shaped input is rejected before normalization (the whole point)', () => {
  const addresses = [
    '192.168.1.1',
    '49.36.221.104',
    '10.0.0.1:8080',
    '8.8.8.8',
    '192.168.1',
    '2001:db8::1',
    '[::1]',
    '203.0.113.5/24',
  ]
  for (const ip of addresses) {
    assert.equal(looksLikeIpAddress(ip), true, 'should reject ' + ip)
  }
})

check('real room codes are NOT flagged as IPs (no false positives)', () => {
  const flagged = codes.filter(looksLikeIpAddress)
  assert.equal(flagged.length, 0, 'false positives: ' + flagged.slice(0, 3))
  for (const good of ['K7QF2M9X', 'K7QF-2M9X', '49362211', '12345678']) {
    assert.equal(looksLikeIpAddress(good), false, 'should allow ' + good)
  }
})

check('format inserts a single dash after 4 chars', () => {
  assert.equal(formatRoomCode('K7QF2M9X'), 'K7QF-2M9X')
  assert.equal(formatRoomCode('K7Q'), 'K7Q')
})

check('format is idempotent', () => {
  assert.equal(formatRoomCode(formatRoomCode('K7QF2M9X')), 'K7QF-2M9X')
})

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
