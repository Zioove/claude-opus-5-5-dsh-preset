/**
 * Build `preset/skills/claude-opus-5-5-provenance/reference/Claude-Opus-5.5.md`
 * from `prompt/`.
 *
 * The reference copy is the persona proper — the upstream segments, without this
 * repository's bridge segment. It exists so the persona can be trimmed and still
 * be compared against, or restored from, the verbatim text; it is not loaded at
 * runtime (only `skills/<name>/SKILL.md` is discovered by the skill registry), so
 * keeping it byte-identical to `prompt/` costs nothing but disk.
 *
 * Which segments are "the persona proper" is a fact about the persona, not about
 * this script, so it comes from `lib/persona.mjs` alongside the list the build and
 * the checks use.
 *
 * Run:  node scripts/build-reference.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REFERENCE_SEGMENT_NAMES, readSegment } from '../lib/persona.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const promptDir = join(root, 'prompt')

const parts = []
for (const name of REFERENCE_SEGMENT_NAMES) {
  parts.push(await readSegment(promptDir, name))
}

// The reference copy is a standalone document, so it ends with exactly one
// newline rather than the bare segment text the composition embeds.
const body = parts.join('\n\n') + '\n'

const target = join(root, 'preset', 'skills', 'claude-opus-5-5-provenance', 'reference', 'Claude-Opus-5.5.md')
await mkdir(dirname(target), { recursive: true })
await writeFile(target, body, 'utf8')

const bytes = Buffer.byteLength(body, 'utf8')
const lines = body.split('\n').length
console.log(
  `[reference] preset/skills/claude-opus-5-5-provenance/reference/Claude-Opus-5.5.md written ` +
    `(${bytes} bytes, ${lines} lines, ${REFERENCE_SEGMENT_NAMES.length} segments)`,
)
