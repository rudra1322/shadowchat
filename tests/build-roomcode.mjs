// Strips TypeScript annotations from the few pure lib modules the suite needs
// (no React, no JSX) so tests run on plain node with no build step.
// Regenerated on every `npm test`; the .build.mjs outputs are git-ignored.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function build(name) {
  const source = readFileSync(join(here, '..', 'lib', `${name}.ts`), 'utf8')
  const stripped = source
    // Type-only imports have nothing to emit.
    .replace(/^import type .*$/gm, '')
    // Generic call sites such as new Map<string, ChatMessage>()
    .replace(/new (Map|Set)<[^>]*>\(/g, 'new $1(')
    // Annotations used by these modules.
    .replace(/: Record<string, string>/g, '')
    .replace(/: ChatMessage\[\]/g, '')
    .replace(/: ChatMessage/g, '')
    .replace(/: string \| undefined/g, '')
    .replace(/: number/g, '')
    .replace(/: string/g, '')
    .replace(/: boolean/g, '')
  writeFileSync(join(here, `${name}.build.mjs`), stripped)
}

for (const name of ['roomCode', 'errors', 'messages']) build(name)
