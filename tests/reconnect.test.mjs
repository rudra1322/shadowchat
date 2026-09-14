// Reconnect hardening.
//
// A dropped websocket used to produce three problems at once: a "left" and
// "joined" pair of system messages for what the user experienced as a blip,
// and a join acknowledgement that replaced the client's local timeline. Both
// sides are covered here: the server-side grace period, and the client-side
// merge helpers.

process.env.RECONNECT_GRACE_MS = '400'

const { attachSocketServer } = await import('../server/socket.mjs')
const { fakeIoFactory, makeSocket } = await import('./fake-io.mjs')
const { ROOM } = await import('../server/config.mjs')
const { appendMessage, compareMessages, mergeMessages } = await import('./messages.build.mjs')
const { ERROR_COPY, errorMessage } = await import('./errors.build.mjs')

let failures = 0

async function check(name, fn) {
  try {
    await fn()
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

let seq = 0
function join(code, username, address) {
  seq += 1
  const socket = makeSocket(io, `rc-${seq}`, { address: address ?? `10.7.0.${seq}` })
  io.connect(socket)
  let ack = null
  socket.fire('room:join', { code, username }, (r) => {
    ack = r
  })
  return { socket, ack }
}

const systemMessages = (code) =>
  io.log.filter(
    (entry) =>
      entry.event === 'room:message' && entry.room === code && entry.payload?.kind === 'system',
  )

console.log('\nreconnect: server behaviour')

await check('a reconnecting client can rejoin the same room', async () => {
  const code = 'RECN0001'
  const first = join(code, 'ghost', '10.7.5.1')
  assert(first.ack?.ok === true, 'the first join should work')
  first.socket.fire('disconnect')

  const second = join(code, 'ghost', '10.7.5.1')
  assert(second.ack?.ok === true, `rejoin failed: ${JSON.stringify(second.ack)}`)
  assert(second.ack.code === code, 'the client must land back in the same room')
})

await check('a quick reconnect does not announce a departure', async () => {
  const code = 'RECN0002'
  const first = join(code, 'blip', '10.7.5.2')
  first.socket.fire('disconnect')
  join(code, 'blip', '10.7.5.2')

  await new Promise((resolve) => setTimeout(resolve, 600))
  const noise = systemMessages(code).filter((entry) => /disconnected/i.test(entry.payload.text))
  assert(noise.length === 0, `a blip must not look like a departure, saw ${noise.length}`)
})

await check('a quick reconnect does not repeat the join notice', async () => {
  const code = 'RECN0003'
  const first = join(code, 'quiet', '10.7.5.3')
  first.socket.fire('disconnect')
  join(code, 'quiet', '10.7.5.3')

  const joins = systemMessages(code).filter((entry) => /joined/i.test(entry.payload.text))
  assert(joins.length === 1, `expected one join notice for one user, saw ${joins.length}`)
})

await check('a real departure is still announced after the grace period', async () => {
  const code = 'RECN0004'
  const first = join(code, 'gone', '10.7.5.4')
  first.socket.fire('disconnect')

  await new Promise((resolve) => setTimeout(resolve, 600))
  const noise = systemMessages(code).filter((entry) => /disconnected/i.test(entry.payload.text))
  assert(noise.length === 1, `a genuine leave must be visible, saw ${noise.length}`)
})

await check('the join backlog policy matches the documented 250 messages', () => {
  const code = 'RECN0005'
  const { socket } = join(code, 'writer', '10.7.5.5')
  for (let i = 0; i < 20; i += 1) socket.fire('message:send', { text: `line ${i}` }, () => {})

  const { ack } = join(code, 'reader', '10.7.5.6')
  assert(ack.messages.length <= ROOM.MAX_MESSAGES_PER_ROOM, 'the backlog is capped')
  assert(
    ROOM.MAX_MESSAGES_PER_ROOM === 250,
    `one backlog number everywhere: memory, hydration and join are all ${ROOM.MAX_MESSAGES_PER_ROOM}`,
  )
  assert(
    ack.messages.some((message) => message.text === 'line 19'),
    'the newest messages must be in the backlog',
  )
})

await check('the join acknowledgement reports persistence status', () => {
  const { ack } = join('RECN0006', 'status', '10.7.5.7')
  assert(
    ['postgres', 'degraded', 'off'].includes(ack.persistence),
    `expected an honest persistence mode, got ${ack.persistence}`,
  )
})

console.log('\nreconnect: client-side merge')

const message = (id, at, text) => ({ id, at, kind: 'chat', username: 'ghost', text })

await check('merging deduplicates by message id', () => {
  const local = [message('a', 1, 'one'), message('b', 2, 'two')]
  const incoming = [message('b', 2, 'two'), message('c', 3, 'three')]
  const merged = mergeMessages(local, incoming)
  assert(merged.length === 3, `expected 3 unique messages, got ${merged.length}`)
  assert(new Set(merged.map((m) => m.id)).size === 3, 'ids must be unique after a merge')
})

await check('merging never loses a locally known message', () => {
  const local = [message('old', 1, 'still here'), message('b', 2, 'two')]
  // The server backlog has rolled past 'old'.
  const merged = mergeMessages(local, [message('b', 2, 'two'), message('c', 3, 'three')])
  assert(
    merged.some((m) => m.id === 'old'),
    'a plain setMessages(ack.messages) would have dropped this',
  )
})

await check('merging orders messages deterministically', () => {
  const merged = mergeMessages([message('c', 3, 'three')], [message('a', 1, 'one'), message('b', 2, 'two')])
  assert(
    merged.map((m) => m.id).join(',') === 'a,b,c',
    `expected chronological order, got ${merged.map((m) => m.id).join(',')}`,
  )
})

await check('messages with the same timestamp keep a stable order', () => {
  const first = mergeMessages([], [message('b', 5, 'b'), message('a', 5, 'a')])
  const second = mergeMessages([], [message('a', 5, 'a'), message('b', 5, 'b')])
  assert(
    first.map((m) => m.id).join(',') === second.map((m) => m.id).join(','),
    'a tie-break on id keeps the timeline from reshuffling on every merge',
  )
})

await check('the server copy wins for a duplicated id', () => {
  const merged = mergeMessages([message('a', 1, 'optimistic')], [message('a', 1, 'authoritative')])
  assert(merged.length === 1, 'no duplicate row')
  assert(merged[0].text === 'authoritative', 'the server is the source of truth')
})

await check('a live message is appended once', () => {
  const current = [message('a', 1, 'one')]
  const once = appendMessage(current, message('b', 2, 'two'))
  const twice = appendMessage(once, message('b', 2, 'two'))
  assert(twice.length === 2, `a re-delivered message must not duplicate, got ${twice.length}`)
})

await check('comparison is a total order', () => {
  assert(compareMessages(message('a', 1), message('b', 2)) < 0, 'older first')
  assert(compareMessages(message('b', 2), message('a', 1)) > 0, 'newer last')
  assert(compareMessages(message('a', 1), message('a', 1)) === 0, 'identical is equal')
})

console.log('\nreconnect: user-facing copy')

await check('JOIN_RATE_LIMITED has a clear message', () => {
  const copy = ERROR_COPY.JOIN_RATE_LIMITED
  assert(typeof copy === 'string' && copy.length > 0, 'the error must be explained')
  assert(/join/i.test(copy) && /try again/i.test(copy), `unhelpful copy: ${copy}`)
})

await check('the message rate limit has a clear message', () => {
  const copy = ERROR_COPY.MESSAGE_RATE_LIMITED
  assert(typeof copy === 'string' && copy.length > 0, 'the error must be explained')
  assert(/wait|slow/i.test(copy), `unhelpful copy: ${copy}`)
})

await check('no error copy leaks limiter internals', () => {
  for (const [code, copy] of Object.entries(ERROR_COPY)) {
    assert(
      !/window_ms|token|bucket|MESSAGE_IP_RATE/i.test(copy),
      `${code} exposes implementation detail: ${copy}`,
    )
  }
})

await check('an unknown error code falls back instead of showing the raw code', () => {
  const copy = errorMessage('SOME_NEW_SERVER_CODE', 'Something went wrong.')
  assert(copy === 'Something went wrong.', `got ${copy}`)
})

if (failures > 0) {
  console.error(`\n${failures} reconnect assertion(s) failed`)
  process.exit(1)
}
console.log('\nreconnect: all assertions passed')
process.exit(0)
