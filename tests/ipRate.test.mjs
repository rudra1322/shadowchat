// Per-IP message flood protection.
//
// The per-connection limiter alone multiplies with every socket a client
// opens: 5 sockets at 20 msg/10s is 100 msg/10s from one machine. A second
// limiter keyed by network (server/clientKey.mjs) bounds the whole client.

// Small numbers so the test does not have to send hundreds of messages.
process.env.MESSAGE_ATTEMPTS_PER_WINDOW = '5'
process.env.MESSAGE_RATE_WINDOW_MS = '10000'
process.env.MESSAGE_IP_RATE = '8'
process.env.MESSAGE_IP_WINDOW_MS = '10000'
process.env.ACTIVITY_TOUCH_INTERVAL_MS = '1'

const { attachSocketServer } = await import('../server/socket.mjs')
const { fakeIoFactory, makeSocket } = await import('./fake-io.mjs')
const { configurePersistence } = await import('../server/persistence.mjs')

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

// Records every SQL statement so the test can prove that a rejected message
// never reaches the database.
const sql = []
configurePersistence({
  enabled: true,
  query: async (text, params) => {
    sql.push({ text, params })
    return { rows: [] }
  },
})

const io = attachSocketServer({}, { ioFactory: fakeIoFactory })

let seq = 0
function connect(address, code, username) {
  seq += 1
  const socket = makeSocket(io, `s-${seq}`, { address })
  io.connect(socket)
  socket.fire('room:join', { code, username }, () => {})
  return socket
}

function send(socket, text) {
  let ack = null
  socket.fire('message:send', { text }, (r) => {
    ack = r
  })
  return ack
}

const inserts = (body) =>
  sql.filter((entry) => entry.text.includes('INSERT INTO messages') && entry.params?.[5] === body)

console.log('\nper-IP message rate limiting')

check('a normal conversation is not blocked', () => {
  const socket = connect('198.51.100.1', 'RAT3AAA2', 'alice')
  for (let i = 0; i < 4; i += 1) {
    const ack = send(socket, `hello ${i}`)
    assert(ack?.ok === true, `message ${i} should be accepted, got ${JSON.stringify(ack)}`)
  }
})

check('the per-connection limiter still applies', () => {
  const socket = connect('198.51.100.2', 'RAT3AAA3', 'bob')
  const acks = []
  // Per-connection limit is 5, below the per-IP limit of 8.
  for (let i = 0; i < 6; i += 1) acks.push(send(socket, `burst ${i}`))
  assert(acks[5]?.error === 'RATE_LIMITED', `expected RATE_LIMITED, got ${acks[5]?.error}`)
})

check('multiple sockets from one IP share the IP limit', () => {
  const address = '198.51.100.3'
  const acks = []
  // Four sockets, 3 messages each: under the per-connection limit every time,
  // but 12 messages from one client against an IP limit of 8.
  for (let s = 0; s < 4; s += 1) {
    const socket = connect(address, 'RAT3AAA4', `mult${s}`)
    for (let i = 0; i < 3; i += 1) acks.push(send(socket, `m${s}-${i}`))
  }
  const rejected = acks.filter((ack) => ack?.error === 'MESSAGE_RATE_LIMITED')
  assert(rejected.length > 0, 'opening extra sockets must not multiply the allowance')
  assert(
    acks.filter((ack) => ack?.ok).length === 8,
    `expected exactly the IP allowance to pass, got ${acks.filter((a) => a?.ok).length}`,
  )
})

check('the rejection uses a stable machine-readable code', () => {
  const address = '198.51.100.4'
  let last = null
  for (let s = 0; s < 4; s += 1) {
    const socket = connect(address, 'RAT3AAA5', `code${s}`)
    for (let i = 0; i < 3; i += 1) last = send(socket, `c${s}-${i}`)
  }
  assert(last?.error === 'MESSAGE_RATE_LIMITED', `got ${JSON.stringify(last)}`)
  assert(
    !JSON.stringify(last).toLowerCase().includes('window'),
    'the client must not learn the limiter internals',
  )
})

check('a rejected message is never broadcast', () => {
  const address = '198.51.100.5'
  const marker = 'flood-marker-payload'
  for (let s = 0; s < 4; s += 1) {
    const socket = connect(address, 'RAT3AAA6', `cast${s}`)
    for (let i = 0; i < 3; i += 1) send(socket, `${marker}-${s}-${i}`)
  }
  const broadcast = io.log.filter(
    (entry) => entry.event === 'room:message' && String(entry.payload?.text).startsWith(marker),
  )
  assert(broadcast.length === 8, `only accepted messages may be broadcast, saw ${broadcast.length}`)
})

check('a rejected message is never persisted', () => {
  const address = '198.51.100.6'
  const acks = []
  const bodies = []
  for (let s = 0; s < 4; s += 1) {
    const socket = connect(address, 'RAT3AAA7', `db${s}`)
    for (let i = 0; i < 3; i += 1) {
      const body = `persist-${s}-${i}`
      bodies.push(body)
      acks.push({ body, ack: send(socket, body) })
    }
  }
  const refused = acks.filter((entry) => entry.ack?.error === 'MESSAGE_RATE_LIMITED')
  assert(refused.length > 0, 'the test needs at least one rejection to be meaningful')
  for (const entry of refused) {
    assert(inserts(entry.body).length === 0, `rejected message ${entry.body} reached the database`)
  }
})

check('a rejected message does not refresh room activity', () => {
  const address = '198.51.100.7'
  const code = 'RAT3AAA8'
  const socket = connect(address, code, 'quiet')
  // Exhaust the IP budget from other sockets first.
  for (let s = 0; s < 4; s += 1) {
    const extra = connect(address, code, `noise${s}`)
    for (let i = 0; i < 3; i += 1) send(extra, `n${s}-${i}`)
  }

  const activityBefore = sql.filter(
    (entry) => entry.text.includes('INSERT INTO rooms') && entry.params?.[0] === code,
  ).length
  const ack = send(socket, 'this should be refused')
  const activityAfter = sql.filter(
    (entry) => entry.text.includes('INSERT INTO rooms') && entry.params?.[0] === code,
  ).length

  assert(ack?.error === 'MESSAGE_RATE_LIMITED', `expected a rejection, got ${JSON.stringify(ack)}`)
  assert(
    activityAfter === activityBefore,
    'a throttled message must not keep an abandoned room alive',
  )
})

check('another IP is unaffected by a flooding client', () => {
  const socket = connect('198.51.100.99', 'RAT3AAA9', 'bystander')
  const ack = send(socket, 'still working')
  assert(ack?.ok === true, `an unrelated client must not be throttled, got ${JSON.stringify(ack)}`)
})

if (failures > 0) {
  console.error(`\n${failures} IP rate limit assertion(s) failed`)
  process.exit(1)
}
console.log('\nper-IP message rate limiting: all assertions passed')
process.exit(0)
