/**
 * The persona's own structure, in one place.
 *
 * The persona is not one string but seven independently editable segments under
 * `prompt/`. Four scripts need to know that list and how to read it —
 * `build.mjs` concatenates it, `build-reference.mjs` concatenates the six
 * upstream segments, `check.mjs` verifies the concatenation, and `ci-check.sh`
 * scans the whole thing for unregistered prompt variables. Each of them used to
 * carry its own copy of the list, which is how a segment gets added to the
 * persona and forgotten in the check.
 *
 * This module is the single source. It owns three things and nothing else:
 *
 *   - the segment list, in order, with each segment's role named;
 *   - reading a segment the way every consumer needs it (LF, no trailing blanks);
 *   - the concatenation rule (exactly one blank line between segments).
 *
 * It performs no I/O of its own beyond reading the files it is asked for, so it
 * is safe to import from any of the scripts and from a test.
 * @module persona
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The persona segments, in the order the system prompt has them.
 *
 * The first six are the upstream prompt, sliced by its own structure. The
 * seventh is this repository's own addition: it reinterprets which of the
 * upstream prompt's tools actually exist in DeepSeek Harness, and must therefore
 * come last so it can correct everything above it.
 *
 * `reference` marks the segments that are upstream text, which is what
 * `build-reference.mjs` ships verbatim and what `NOTICE.md` excludes from the
 * MIT license. Keep it in sync when adding or removing a segment.
 */
export const SEGMENTS = [
  { name: 'opening', reference: true, role: 'the upstream voice-note line, verbatim and first' },
  { name: 'identity', reference: true, role: 'claude_behavior: identity, product information, refusal, tone' },
  { name: 'agentic', reference: true, role: 'agentic_behavior: how the work is carried out' },
  { name: 'environment', reference: true, role: 'the execution environment the persona assumes' },
  { name: 'memory', reference: true, role: 'user_memory: the memory filesystem contract' },
  { name: 'toolsyntax', reference: true, role: 'the function-call syntax that closes the upstream prompt' },
  { name: 'bridge', reference: false, role: 'harness bridge: which upstream tools do not exist here' },
]

/** Segment names in order, for callers that only need the list. */
export const SEGMENT_NAMES = SEGMENTS.map((segment) => segment.name)

/** The segments that are upstream text, and therefore ship in `reference/`. */
export const REFERENCE_SEGMENT_NAMES = SEGMENTS.filter((segment) => segment.reference).map((s) => s.name)

/** The segments that are this repository's own additions. */
export const ORIGINAL_SEGMENT_NAMES = SEGMENTS.filter((segment) => !segment.reference).map((s) => s.name)

/**
 * The separator between segments.
 *
 * Exactly one blank line. The persona's own paragraph breaks are content and are
 * preserved inside a segment; this is only the seam between two segments, so a
 * segment that already ends with a blank line does not gain a second one.
 */
export const SEPARATOR = '\n\n'

/**
 * Read one segment, normalized the way every consumer needs it.
 *
 * Normalization is deliberately minimal and total: line endings become LF, and
 * trailing blank lines are removed. Nothing else is touched — not leading
 * whitespace, not internal blank lines, not trailing whitespace on a line —
 * because the check compares the assembled persona byte-for-byte against the
 * segments, and any further normalization would make that comparison vacuous.
 *
 * @param promptDir - the `prompt/` directory to read from.
 * @param name - the segment name, without the `.md` extension.
 * @returns the segment's text, normalized.
 */
export async function readSegment(promptDir, name) {
  const text = await readFile(join(promptDir, `${name}.md`), 'utf8')
  if (text.trim() === '') throw new Error(`persona segment is empty: prompt/${name}.md`)
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

/**
 * Read several segments in order and concatenate them.
 *
 * @param promptDir - the `prompt/` directory to read from.
 * @param names - the segment names, in the order they should appear.
 * @returns the concatenated text, with `SEPARATOR` between segments.
 */
export async function joinSegments(promptDir, names) {
  const parts = []
  for (const name of names) parts.push(await readSegment(promptDir, name))
  return parts.join(SEPARATOR)
}

/**
 * The full persona: every segment, in order.
 * @param promptDir - the `prompt/` directory to read from.
 */
export async function readPersona(promptDir) {
  return joinSegments(promptDir, SEGMENT_NAMES)
}

/**
 * The persona proper: the upstream segments only, without this repository's
 * bridge segment. This is what ships in `reference/` and what the upstream
 * provenance checks run against.
 * @param promptDir - the `prompt/` directory to read from.
 */
export async function readPersonaProper(promptDir) {
  return joinSegments(promptDir, REFERENCE_SEGMENT_NAMES)
}

/** Prompt variables dsh ships with. Anything else fails the turn at render time. */
export const REGISTERED_VARIABLES = new Set(['model', 'cwd'])

/**
 * Every `{{...}}` group in a text, in the order they appear.
 *
 * Matches only complete groups, so an unbalanced `{{` is reported separately by
 * `hasUnregisteredVariables` rather than being silently ignored here.
 * @param text - the text to scan.
 */
export function promptVariables(text) {
  return [...text.matchAll(/\{\{[^{}]*\}\}/g)].map((match) => match[0])
}

/**
 * The `{{...}}` groups in a text that dsh would fail to resolve.
 *
 * dsh renders prompt variables strictly against what the agent loop registers.
 * An unregistered group does not degrade gracefully — it fails every turn, which
 * reads as "the preset is broken" rather than "a typo in the persona".
 * @param text - the text to scan.
 */
export function unregisteredVariables(text) {
  return [...new Set(promptVariables(text))].filter((group) => !REGISTERED_VARIABLES.has(group.slice(2, -2)))
}

/**
 * Whether a text has an unbalanced or malformed `{{` group — an opening brace
 * with no closing one, or the reverse.
 * @param text - the text to scan.
 */
export function hasMalformedVariables(text) {
  return text.replace(/\{\{(?:model|cwd)\}\}/g, '').includes('{{')
}
