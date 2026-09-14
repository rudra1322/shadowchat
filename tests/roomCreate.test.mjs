// Server-authoritative room codes.
//
// The client used to generate its own code and simply navigate to it. That let
// a malicious client pick a low-entropy code ("AAAAAAAA") or reuse one, which
// throws away the 40 bits that keep a room unguessable. Creation now happens
// on the server through `room:create`.

const { attachSocketServer } = await import('../server/socket.mjs')
const { fakeIoFactory, makeSocket } = await import('./fake-io.mjs')
const { generateRoomCode, generateUniqueRoomCode, isValidRoomCode, ALPHABET, ROOM_CODE_LENGTH } =
  await import('../server/roomCode.mjs')
const { getRoom } = await import('../server/rooms.mjs')

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

let seq = 0
function createRoomOverSocket(payload) {
  seq += 1
  const socket = makeSocket(io, `creator-${seq}`, { address: `10.9.0.${seq}` })
  io.connect(socket)
  let ack = null
  socket.fire('room:create', payload, (response) => {
    ack = response
  })
  return { ack, socket }
}

console.log('\nroom creation')

check('room:create returns a server-generated code', () => {
  const { ack } = createRoomOverSocket({})
  assert(ack?.ok === true, `expected success, got ${JSON.stringify(ack)}`)
  assert(isValidRoomCode(ack.code), `expected a valid code, got ${ack.code}`)
})

check('the created room actually exists on the server', () => {
  const { ack } = createRoomOverSocket({})
  assert(getRoom(ack.code) !== null && getRoom(ack.code) !== undefined, 'creation must register the room')
})

check('a client cannot choose its own room code', () => {
  const { ack } = createRoomOverSocket({ code: 'AAAAAAAA' })
  assert(ack?.ok === true, 'creation should still succeed')
  assert(ack.code !== 'AAAAAAAA', 'a client-supplied code must be ignored')
})

check('a client cannot smuggle in an IP-shaped code', () => {
  const { ack } = createRoomOverSocket({ code: '19216811' })
  assert(ack.code !== '19216811', 'room identifiers are never derived from a network address')
})

check('two creations produce different codes', () => {
  const first = createRoomOverSocket({}).ack.code
  const second = createRoomOverSocket({}).ack.code
  assert(first !== second, 'codes must be random per room')
})

check('a created room can be joined with the returned code', () => {
  const { ack } = createRoomOverSocket({})
  seq += 1
  const member = makeSocket(io, `member-${seq}`, { address: `10.9.1.${seq}` })
  io.connect(member)
  let joinAck = null
  member.fire('room:join', { code: ack.code, username: 'ghost' }, (r) => {
    joinAck = r
  })
  assert(joinAck?.ok === true, `expected the new room to be joinable, got ${JSON.stringify(joinAck)}`)
})

console.log('\nroom code generation')

check('generated codes match the existing alphabet and length', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateRoomCode()
    assert(code.length === ROOM_CODE_LENGTH, `unexpected length: ${code}`)
    assert(isValidRoomCode(code), `invalid code produced: ${code}`)
    for (const char of code) {
      assert(ALPHABET.includes(char), `character outside the alphabet: ${char}`)
    }
  }
})

check('look-alike characters stay excluded', () => {
  for (const char of ['I', 'L', 'O', 'U']) {
    assert(!ALPHABET.includes(char), `${char} would be confused when read aloud`)
  }
})

check('a collision is retried instead of reusing a live room', () => {
  let calls = 0
  const taken = new Set()
  const code = generateUniqueRoomCode((candidate) => {
    calls += 1
    // Pretend the first two candidates are already in use.
    if (calls <= 2) {
      taken.add(candidate)
      return true
    }
    return false
  })
  assert(code !== null, 'a collision must not fail creation')
  assert(!taken.has(code), 'the returned code must not be one already in use')
  assert(calls === 3, `expected two retries then success, saw ${calls} checks`)
})

check('collision retries are bounded', () => {
  const code = generateUniqueRoomCode(() => true, { attempts: 4 })
  assert(code === null, 'an always-colliding generator must give up, not spin forever')
})

check('room:create is refused when the join limiter is exhausted', () => {
  const address = '10.9.9.9'
  const results = []
  // Default limit is 10 per minute; the 11th create must be refused.
  for (let i = 0; i < 11; i += 1) {
    seq += 1
    const socket = makeSocket(io, `flood-${seq}`, { address })
    io.connect(socket)
    socket.fire('room:create', {}, (r) => results.push(r))
  }
  assert(results[10]?.ok === false, 'room creation must be metered like joins')
  assert(
    results[10]?.error === 'JOIN_RATE_LIMITED',
    `expected JOIN_RATE_LIMITED, got ${results[10]?.error}`,
  )
})

if (failures > 0) {
  console.error(`\n${failures} room creation assertion(s) failed`)
  process.exit(1)
}
console.log('\nroom creation: all assertions passed')
process.exit(0)
