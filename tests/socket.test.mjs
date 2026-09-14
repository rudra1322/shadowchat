import assert from 'node:assert/strict'
import { attachSocketServer } from '../server/socket.mjs'
import { getRoom, roomStats } from '../server/rooms.mjs'
import { fakeIoFactory, makeSocket } from './fake-io.mjs'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('  FAIL  ' + name + '\n        ' + error.message)
  }
}

const io = attachSocketServer({}, { ioFactory: fakeIoFactory })

function connect(id) {
  return io.connect(makeSocket(io, id))
}

function sync(socket, event, payload) {
  let result
  socket.fire(event, payload, (ack) => {
    result = ack
  })
  return result
}

function emitted(event) {
  return io.log.filter((entry) => entry.event === event)
}

console.log('\n=== join / validation ===')

const alice = connect('sock-alice')
const joinAlice = sync(alice, 'room:join', { code: 'K7QF2M9X', username: 'ghost_shell' })

check('valid join is accepted', () => {
  assert.equal(joinAlice.ok, true)
  assert.equal(joinAlice.code, 'K7QF2M9X')
  assert.equal(joinAlice.username, 'ghost_shell')
  assert.equal(joinAlice.members.length, 1)
})

check('socket actually joined the room channel', () => {
  assert.ok(alice.joined.has('K7QF2M9X'))
})

check('lowercase and dashed codes are normalized', () => {
  const s = connect('sock-norm')
  const ack = sync(s, 'room:join', { code: 'k7qf-2m9x', username: 'norm' })
  assert.equal(ack.ok, true)
  assert.equal(ack.code, 'K7QF2M9X')
  sync(s, 'room:leave', {})
})

check('code with excluded letters (I/L/O/U) is rejected', () => {
  const s = connect('sock-bad1')
  const ack = sync(s, 'room:join', { code: 'IIIILLLL', username: 'nope' })
  assert.equal(ack.ok, false)
  assert.equal(ack.error, 'INVALID_CODE')
})

check('short code is rejected', () => {
  const s = connect('sock-bad2')
  assert.equal(sync(s, 'room:join', { code: 'ABC', username: 'nope' }).error, 'INVALID_CODE')
})

check('1-char username is rejected', () => {
  const s = connect('sock-bad3')
  assert.equal(sync(s, 'room:join', { code: 'K7QF2M9X', username: 'x' }).error, 'INVALID_USERNAME')
})

check('username control characters are stripped', () => {
  const s = connect('sock-ctrl')
  const ack = sync(s, 'room:join', { code: 'ABCDEFGH', username: 'ev\u0000il\u001bname' })
  assert.equal(ack.ok, true)
  assert.equal(ack.username, 'evilname')
  sync(s, 'room:leave', {})
})

check('username is capped at 24 chars', () => {
  const s = connect('sock-long')
  const ack = sync(s, 'room:join', { code: 'ABCDEFGH', username: 'z'.repeat(90) })
  assert.equal(ack.username.length, 24)
  sync(s, 'room:leave', {})
})

check('double join on one connection is refused', () => {
  assert.equal(
    sync(alice, 'room:join', { code: 'ABCDEFGH', username: 'ghost' }).error,
    'ALREADY_IN_ROOM',
  )
})

console.log('\n=== presence ===')

const bob = connect('sock-bob')
const joinBob = sync(bob, 'room:join', { code: 'K7QF2M9X', username: 'n0ct.byte' })

check('second member sees both people', () => {
  assert.equal(joinBob.ok, true)
  assert.equal(joinBob.members.length, 2)
})

check('join broadcasts a system message', () => {
  const texts = emitted('room:message').map((e) => e.payload.text)
  assert.ok(texts.includes('n0ct.byte joined the room'))
})

check('join broadcasts an updated member list', () => {
  assert.equal(emitted('room:members').at(-1).payload.members.length, 2)
})

check('duplicate handle is de-duplicated, not allowed to impersonate', () => {
  const impostor = connect('sock-impostor')
  const ack = sync(impostor, 'room:join', { code: 'K7QF2M9X', username: 'ghost_shell' })
  assert.equal(ack.username, 'ghost_shell~2')
  sync(impostor, 'room:leave', {})
})

check('backlog is replayed to a late joiner', () => {
  assert.ok(joinBob.messages.length >= 1)
})

console.log('\n=== messaging ===')

check('message is broadcast with the server-side identity', () => {
  const ack = sync(alice, 'message:send', { text: 'hello room' })
  assert.equal(ack.ok, true)
  const last = emitted('room:message').at(-1).payload
  assert.equal(last.text, 'hello room')
  assert.equal(last.username, 'ghost_shell')
  assert.equal(last.authorId, 'sock-alice')
})

check('SPOOF: client-supplied username is ignored', () => {
  sync(bob, 'message:send', {
    text: 'i am admin',
    username: 'ADMINISTRATOR',
    authorId: 'sock-alice',
  })
  const last = emitted('room:message').at(-1).payload
  assert.equal(last.username, 'n0ct.byte')
  assert.equal(last.authorId, 'sock-bob')
})

check('empty / whitespace message is rejected', () => {
  assert.equal(sync(alice, 'message:send', { text: '   ' }).error, 'EMPTY_MESSAGE')
})

check('message is capped at 2000 chars', () => {
  sync(alice, 'message:send', { text: 'a'.repeat(5000) })
  assert.equal(emitted('room:message').at(-1).payload.text.length, 2000)
})

check('script tag is stored verbatim (React escapes at render, no mangling)', () => {
  const payload = '<script>alert(1)</script>'
  sync(alice, 'message:send', { text: payload })
  assert.equal(emitted('room:message').at(-1).payload.text, payload)
})

check('sending without joining is refused', () => {
  const stranger = connect('sock-stranger')
  assert.equal(sync(stranger, 'message:send', { text: 'hi' }).error, 'NOT_IN_ROOM')
})

check('flood control trips after 20 messages in 10s', () => {
  const flooder = connect('sock-flood')
  sync(flooder, 'room:join', { code: 'FQ0D2M9X', username: 'flooder' })
  const errors = []
  for (let i = 0; i < 25; i += 1) {
    const ack = sync(flooder, 'message:send', { text: 'spam ' + i })
    if (!ack.ok) errors.push(ack.error)
  }
  assert.equal(errors.length, 5)
  assert.ok(errors.every((e) => e === 'RATE_LIMITED'))
  sync(flooder, 'room:leave', {})
})

check('room backlog is trimmed at 250 messages', () => {
  const s = connect('sock-trim')
  sync(s, 'room:join', { code: 'TRZM4K7B', username: 'trimmer' })
  const room = getRoom('TRZM4K7B')
  for (let i = 0; i < 400; i += 1) {
    room.messages.push({
      id: 'x' + i,
      kind: 'chat',
      text: 't',
      username: 'trimmer',
      at: Date.now(),
    })
  }
  sync(s, 'message:send', { text: 'final' })
  assert.ok(room.messages.length <= 250, 'got ' + room.messages.length)
  sync(s, 'room:leave', {})
})

console.log('\n=== typing ===')

check('typing is relayed to others only, with server identity', () => {
  alice.fire('typing', { active: true })
  const last = io.log.filter((e) => e.event === 'room:typing').at(-1)
  assert.equal(last.target, 'others')
  assert.equal(last.payload.username, 'ghost_shell')
  assert.equal(last.payload.active, true)
})

console.log('\n=== leave / disconnect ===')

check('leave removes the member and announces it', () => {
  sync(bob, 'room:leave', {})
  const members = emitted('room:members').at(-1).payload.members
  assert.equal(members.length, 1)
  assert.equal(members[0].username, 'ghost_shell')
  assert.ok(!bob.joined.has('K7QF2M9X'))
})

check('leaving twice is safe', () => {
  assert.equal(sync(bob, 'room:leave', {}).ok, true)
})

check('disconnect removes the member', () => {
  const carol = connect('sock-carol')
  sync(carol, 'room:join', { code: 'K7QF2M9X', username: 'redline' })
  carol.fire('disconnect')
  const members = emitted('room:members').at(-1).payload.members
  assert.ok(!members.some((m) => m.username === 'redline'))
})

check('room is still alive while one member remains', () => {
  assert.ok(getRoom('K7QF2M9X'))
  assert.equal(getRoom('K7QF2M9X').members.size, 1)
})

check('empty room is scheduled for deletion (not deleted instantly)', () => {
  const s = connect('sock-solo')
  sync(s, 'room:join', { code: 'S0N2V5H8', username: 'solo' })
  sync(s, 'room:leave', {})
  const room = getRoom('S0N2V5H8')
  assert.ok(room, 'room should still exist during the grace period')
  assert.equal(room.members.size, 0)
  assert.ok(room.reaper, 'a reaper timer should be armed')
})

check('room capacity is enforced at 50', () => {
  const sockets = []
  for (let i = 0; i < 50; i += 1) {
    const s = connect('cap-' + i)
    assert.equal(sync(s, 'room:join', { code: 'CAPAAAAA', username: 'user' + i }).ok, true)
    sockets.push(s)
  }
  const overflow = connect('cap-overflow')
  assert.equal(
    sync(overflow, 'room:join', { code: 'CAPAAAAA', username: 'toolate' }).error,
    'ROOM_FULL',
  )
  sockets.forEach((s) => sync(s, 'room:leave', {}))
})

console.log('\nrooms currently tracked: ' + JSON.stringify(roomStats()))
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
