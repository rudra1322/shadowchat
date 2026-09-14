// Per-IP join rate limiting.
//
// Guessing an 8-char room code is only practical at high request rates, so the
// join event is the one worth throttling. The limiter is process-local: with
// several replicas each process would allow its own quota.

// Small window so the reset case does not need a long sleep.
process.env.JOIN_ATTEMPTS_PER_WINDOW = '3'
process.env.JOIN_RATE_WINDOW_MS = '120'

const { attachSocketServer } = await import('../server/socket.mjs')
const { fakeIoFactory, makeSocket } = await import('./fake-io.mjs')

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

const io = attachSocketServer({}, { ioFactory: fakeIoFactory })

let socketSeq = 0
/** One connection from `address`, attempting to join `code`. */
function attemptJoin(address, code, username = 'prober') {
  socketSeq += 1
  const socket = makeSocket(io, `probe-${socketSeq}`, { address })
  io.connect(socket)
  let ack = null
  socket.fire('room:join', { code, username }, (response) => {
    ack = response
  })
  socket.fire('disconnect')
  return { ack, socket }
}

console.log('\njoin rate limiting')

check('a normal join is allowed', () => {
  const { ack } = attemptJoin('10.0.0.1', 'J01NAAA2')
  assert(ack?.ok === true, `expected a successful join, got ${JSON.stringify(ack)}`)
})

check('repeated attempts from one IP hit the limit', () => {
  const address = '10.0.0.2'
  const results = []
  // Limit is 3 per window; the 4th must be rejected.
  for (let i = 0; i < 4; i += 1) {
    results.push(attemptJoin(address, 'J01NAAA3').ack)
  }

  assert(results.slice(0, 3).every((r) => r?.ok === true), 'the first 3 joins should succeed')
  assert(results[3]?.ok === false, 'the 4th join should be refused')
  assert(
    results[3]?.error === 'JOIN_RATE_LIMITED',
    `expected JOIN_RATE_LIMITED, got ${results[3]?.error}`,
  )
})

check('invalid code attempts also count toward the limit', () => {
  const address = '10.0.0.3'
  const first = attemptJoin(address, 'not-a-code').ack
  attemptJoin(address, 'not-a-code')
  attemptJoin(address, 'not-a-code')
  const fourth = attemptJoin(address, 'J01NAAA4').ack

  assert(first?.error === 'INVALID_CODE', 'a bad code is still a validation error')
  assert(
    fourth?.error === 'JOIN_RATE_LIMITED',
    'brute-force attempts are mostly invalid, so they must be counted',
  )
})

check('a rate-limited client also receives a room:error event', () => {
  const address = '10.0.0.4'
  for (let i = 0; i < 3; i += 1) attemptJoin(address, 'J01NAAA5')
  attemptJoin(address, 'J01NAAA5')

  const emitted = io.log.filter(
    (entry) => entry.event === 'room:error' && entry.payload?.error === 'JOIN_RATE_LIMITED',
  )
  assert(emitted.length >= 1, 'the client should get a clean error event, not a dropped socket')
})

check('one IP hitting the limit does not block another IP', () => {
  const blocked = '10.0.0.5'
  for (let i = 0; i < 4; i += 1) attemptJoin(blocked, 'J01NAAA6')

  const other = attemptJoin('10.0.0.6', 'J01NAAA6').ack
  assert(other?.ok === true, 'the limiter must be keyed per IP')
})

check('spoofed X-Forwarded-For does not bypass the limiter', () => {
  const address = '10.0.0.7'
  for (let i = 0; i < 3; i += 1) attemptJoin(address, 'J01NAAA7')

  socketSeq += 1
  const socket = makeSocket(io, `probe-${socketSeq}`, {
    address,
    headers: { 'x-forwarded-for': '203.0.113.9' },
  })
  io.connect(socket)
  let ack = null
  socket.fire('room:join', { code: 'J01NAAA7', username: 'prober' }, (r) => {
    ack = r
  })
  socket.fire('disconnect')

  assert(
    ack?.error === 'JOIN_RATE_LIMITED',
    'TRUST_PROXY is off, so the header must be ignored',
  )
})

console.log('\njoin rate limiting: window reset')

const resetAddress = '10.0.0.8'
for (let i = 0; i < 4; i += 1) attemptJoin(resetAddress, 'J01NAAA8')
await new Promise((resolve) => setTimeout(resolve, 160))

check('the limit resets after the configured window', () => {
  const { ack } = attemptJoin(resetAddress, 'J01NAAA8')
  assert(ack?.ok === true, `expected the window to reset, got ${JSON.stringify(ack)}`)
})

if (failures > 0) {
  console.error(`\n${failures} join rate limit assertion(s) failed`)
  process.exit(1)
}
console.log('\njoin rate limiting: all assertions passed')
process.exit(0)
