// docker-compose.yml sanity checks.
//
// The healthcheck command contains quotes, parentheses and arrows, which
// flow-style YAML (`test: ['CMD-SHELL', '...']`) cannot hold reliably. These
// tests fail if anyone reintroduces that pattern, and they run without Docker
// installed. `docker compose config` is still the authoritative check -- see
// the README verification steps.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const compose = readFileSync(join(here, '..', 'docker-compose.yml'), 'utf8')
const lines = compose.split('\n')

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

/** Returns the indented block that follows `header`, e.g. "healthcheck:". */
function blockAfter(header, startIndex = 0) {
  const index = lines.findIndex((line, i) => i >= startIndex && line.trim() === header)
  if (index === -1) return { index: -1, body: [] }
  const indent = lines[index].search(/\S/)
  const body = []
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (line.search(/\S/) <= indent) break
    body.push(line)
  }
  return { index, body }
}

console.log('\ndocker compose configuration')

check('no flow-style healthcheck command survives', () => {
  const flow = lines.filter((line) => /^\s*test:\s*\[/.test(line))
  assert(flow.length === 0, `flow-style test: found -> ${flow.join(' | ')}`)
})

check('every healthcheck uses a block sequence starting with CMD-SHELL', () => {
  let cursor = 0
  let seen = 0
  for (;;) {
    const { index, body } = blockAfter('healthcheck:', cursor)
    if (index === -1) break
    cursor = index + 1
    seen += 1

    const testLine = body.find((line) => line.trim() === 'test:')
    assert(testLine, 'healthcheck must declare a `test:` key on its own line')
    const items = body.filter((line) => /^\s*-\s/.test(line))
    assert(items.length >= 2, 'test: must be a block sequence with at least two items')
    assert(items[0].trim() === '- CMD-SHELL', `first item should be CMD-SHELL, got ${items[0]}`)
    assert(items[1].trim() === '- >-', 'the command should use a folded block scalar (- >-)')
  }
  assert(seen === 2, `expected a healthcheck for db and app, found ${seen}`)
})

check('the app healthcheck targets the real endpoint served by server.mjs', () => {
  const server = readFileSync(join(here, '..', 'server.mjs'), 'utf8')
  const endpoint = server.match(/req\.url === '(\/[a-z]+)'/)?.[1]
  assert(endpoint, 'could not find the health route in server.mjs')
  assert(
    compose.includes(`http://127.0.0.1:3000${endpoint}`),
    `compose should probe ${endpoint}, the route the server actually serves`,
  )
})

check('database credentials are environment-driven, not hardcoded', () => {
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) {
    const line = lines.find((l) => l.trim().startsWith(`${key}:`))
    assert(line, `${key} should be declared`)
    assert(
      line.includes(`\${${key}:-`),
      `${key} must read from the environment with a local default, got: ${line.trim()}`,
    )
  }
  const url = lines.find((l) => l.trim().startsWith('DATABASE_URL:'))
  assert(url?.includes('${DATABASE_URL:-') || compose.includes('${DATABASE_URL:-'), 'DATABASE_URL must be overridable')
})

check('.env is git-ignored so real credentials never land in the repo', () => {
  const ignored = readFileSync(join(here, '..', '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
  assert(ignored.includes('.env'), '.gitignore must contain .env')
})

check('.env.example contains no real-looking secret', () => {
  const example = readFileSync(join(here, '..', '.env.example'), 'utf8')
  assert(example.includes('DATABASE_URL='), '.env.example should document DATABASE_URL')
  assert(
    !/PASSWORD=(?!change-me|shadowchat|$)\S+/.test(example),
    '.env.example must only carry obvious placeholders',
  )
})

if (failures > 0) {
  console.error(`\n${failures} compose assertion(s) failed`)
  process.exit(1)
}
console.log('\ndocker compose configuration: all assertions passed')
