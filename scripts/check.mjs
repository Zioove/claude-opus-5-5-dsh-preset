/**
 * Self-check for the assembled `preset/agent.cordis.yml` and the bundle around
 * it. It answers five questions that a broken preset fails loudly on:
 *
 *   1. Is the file parseable as YAML, and is the persona row shaped the way the
 *      installed dsh's `dsh-persona` expects (`prefix` + `suffix`, both strings)?
 *   2. Is the persona actually the whole Opus 5.5 persona — every segment
 *      present, in order, with its first and last lines intact?
 *   3. Are this preset's own three changes present, and is nothing else from
 *      upstream dropped?
 *   4. Does the persona reference only prompt variables dsh actually registers?
 *   5. Has upstream's `standard` preset drifted from the snapshot in `base/`?
 *
 * It does not boot dsh, so it cannot catch a mount rejection; what it does catch
 * is a build that silently lost a segment or a patch anchor that moved.
 *
 * The YAML question is answered two ways. `readComposition` below is a
 * dependency-free reader for the one shape this preset needs, so the check runs
 * anywhere; when js-yaml is reachable from a dsh install it is used in addition,
 * which is the same dialect (and the same `!!js` tag support) the loader itself
 * uses. The hand-rolled reader cannot detect every way YAML can be malformed, so
 * a parse failure it misses is a real gap — that is what the second reader is for.
 *
 * Question 5 is advisory rather than a gate, because re-syncing `base/` is a
 * judgement call and a fresh clone has no dsh install to compare against. Point
 * it at a capture of the live preset to enable it:
 *
 *   dsh --profile web --dump-config > /tmp/dump.txt
 *   DSH_DUMP=/tmp/dump.txt node scripts/check.mjs
 *
 * Run:  node scripts/check.mjs
 */
import { readFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import {
  SEGMENTS,
  promptVariables,
  readPersona,
  readPersonaProper,
  readSegment,
  unregisteredVariables,
  hasMalformedVariables,
} from '../lib/persona.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const promptDir = join(root, 'prompt')
const problems = []
const notes = []

function fail(message) {
  problems.push(message)
}
function ok(message) {
  notes.push(message)
}

/** Prompt variables dsh ships with; anything else fails the turn at render time. */
const REGISTERED_VARIABLES = new Set(['model', 'cwd'])

/**
 * Where a dsh install keeps js-yaml, as directories to try in order. Everything
 * is derived at runtime — nothing is hardcoded to one machine's layout, so this
 * check behaves the same on a fresh clone.
 *
 * The first entry is the checkout's own `node_modules`, which only exists if the
 * user ran a dependency install. The rest walk outward from the dsh install:
 * `dsh plugin` forwards to pnpm inside `$DSH_HOME/profiles/<name>`, and the
 * dependency closure lands in that profile's `node_modules` — which is where the
 * running loader resolves its own js-yaml from.
 */
function jsYamlCandidates() {
  const found = [join(root, 'node_modules/js-yaml')]
  const homes = []
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME)
  const { homedir } = process
  if (homedir) homes.push(join(homedir(), '.dsh'))

  for (const home of homes) {
    // Every profile under the dsh home may carry its own closure; try them all
    // rather than guessing which profile the user installed into.
    let profiles = []
    try {
      profiles = readdirSync(join(home, 'profiles'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue // no profiles directory, or unreadable
    }
    for (const profile of profiles) {      found.push(join(home, 'profiles', profile, 'node_modules/js-yaml'))
    }
    found.push(join(home, 'node_modules/js-yaml'))
  }
  return found
}

/**
 * The installed dsh's `standard` preset, read from a `--dump-config` capture.
 *
 * dsh ships its preset bundles inside its own package, which a checkout cannot
 * read directly, so the capture is the authoritative source. It is produced by:
 *
 *   dsh --profile <name> --dump-config > /tmp/dump.txt
 *   DSH_DUMP=/tmp/dump.txt node scripts/check.mjs
 *
 * Returns undefined when the capture is absent or unreadable — upstream drift is
 * then simply not checked, which is why the caller reports it as a note rather
 * than a failure.
 */
function liveStandardRows() {
  const capture = process.env.DSH_DUMP
  if (!capture) return undefined
  let raw
  try {
    raw = readFileSync(capture, 'utf8')
  } catch {
    return undefined
  }
  const yaml = loadJsYaml()
  if (!yaml) return undefined
  try {
    // `--dump-config` writes progress and bundle warnings to stdout alongside the
    // tree, so keep only the lines that belong to the tree: bundle headings,
    // rows, and indented content.
    const dump = raw
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.startsWith('#') || line.startsWith('- ') || /^[ ]+\S/.test(line))
      .join('\n')
    const rows = yaml.load(dump, { schema: jsSchema(yaml) })
    if (!Array.isArray(rows)) return undefined
    const preset = rows.find((row) => row?.id === 'preset-standard')
    if (!preset?.config?.plugins) return undefined
    return preset.config.plugins
  } catch {
    return undefined
  }
}

/**
 * The js-yaml instance a local dsh install uses, or undefined when none is
 * reachable. Everything is resolved at runtime, so a fresh clone behaves the same
 * way as a machine with dsh installed — the only difference is that the checks
 * which need a real parser report "not reachable" instead of running.
 */
function loadJsYaml() {
  const require = createRequire(pathToFileURL(join(root, 'scripts/check.mjs')).href)
  for (const candidate of jsYamlCandidates()) {
    try {
      return require(candidate)
    } catch {
      /* next candidate */
    }
  }
  return undefined
}

/** A schema that understands dsh's `!!js` tag, which the loader evaluates later. */
function jsSchema(yaml) {
  const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: () => true,
    construct: (data) => ({ __jsExpr: data }),
  })
  return yaml.DEFAULT_SCHEMA.extend([jsTag])
}

/**
 * Parse a composition with the js-yaml shipped inside a local dsh install, when
 * one is reachable. Returns undefined when it is not, which is not a failure:
 * the dependency-free reader still answers the shape question.
 */
function loadWithJsYaml(text, label) {
  const yaml = loadJsYaml()
  if (!yaml) {
    notes.push(`js-yaml not reachable from this checkout — ${label} checked with the built-in reader only`)
    return undefined
  }
  try {
    const rows = yaml.load(text, { schema: jsSchema(yaml) })
    if (!Array.isArray(rows)) {
      fail(`${label} is not a top-level list of loader rows (js-yaml)`)
      return undefined
    }
    ok(`${label} parses as YAML with the loader's own js-yaml dialect`)
    return rows
  } catch (error) {
    fail(`${label} does not parse as YAML: ${error?.message ?? error}`)
    return undefined
  }
}

/** Parse a composition with js-yaml, or undefined when it is not reachable. */
function jsRowsFromText(text) {
  const yaml = loadJsYaml()
  if (!yaml) return undefined
  try {
    const rows = yaml.load(text, { schema: jsSchema(yaml) })
    return Array.isArray(rows) ? rows : undefined
  } catch {
    return undefined
  }
}

/**
 * Minimal YAML reader for the one shape this preset needs: a top-level list of
 * loader rows. It is deliberately not a YAML parser — it reads the row list and
 * the `prefix:`/`suffix:` block scalars, and anything it cannot understand it
 * reports rather than guesses.
 */
function readComposition(text) {
  const lines = text.split('\n')
  const rows = []
  let current = null
  let block = null
  for (const line of lines) {
    if (block) {
      if (line.startsWith(block.indent)) {
        block.lines.push(line)
        continue
      }
      // A blank line belongs to the block only if more block content follows;
      // otherwise it is the separator before the next row.
      if (line.trim() === '') {
        block.lines.push(line)
        continue
      }
      block = null
    }
    const rowMatch = /^- id: (.+)$/.exec(line)
    if (rowMatch) {
      current = { id: rowMatch[1].trim(), lines: [line], config: {} }
      rows.push(current)
      continue
    }
    if (current) current.lines.push(line)
    // Plain (non-block) scalars on a row, e.g. `suffix: ...`.
    const plainMatch = /^ {4}(\w+): (.+)$/.exec(line)
    if (plainMatch && current && current.config[plainMatch[1]] === undefined) {
      current.config[plainMatch[1]] = plainMatch[2]
    }
    const scalarMatch = /^ {4}(\w+): \|-\s*$/.exec(line)
    if (scalarMatch && current) {
      block = { key: scalarMatch[1], indent: '      ', lines: [] }
      current.config[block.key] = block
    }
  }
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.config)) {
      if (typeof value === 'string') continue // plain scalar, already final
      // A YAML `|-` block keeps blank lines as content but strips the trailing
      // ones (strip chomping). The block reader above cannot know whether the
      // empty line it just collected is a paragraph break inside the persona or
      // the separator before the next row, so it keeps both — chomp here.
      row.config[key] = value.lines
        .map((line) => line.slice(value.indent.length))
        .join('\n')
        .replace(/\n+$/, '')
    }
  }
  return rows
}

/**
 * Rows nested inside a `cordis:group` row are indented, so `readComposition`
 * never sees them. This collects them with their full text, which is enough to
 * check a group's inner rows without parsing their config.
 */
function readNestedRows(text) {
  const lines = text.split('\n')
  const found = []
  let current = null
  let indent = null
  for (const line of lines) {
    const match = /^( +)- id: (.+)$/.exec(line)
    if (match) {
      const width = match[1].length
      if (indent === null || width === indent) {
        indent = width
        current = { id: match[2].trim(), text: line }
        found.push(current)
        continue
      }
    }
    if (current) current.text += `\n${line}`
  }
  return found
}

const composed = await readFile(join(root, 'preset', 'agent.cordis.yml'), 'utf8')
const base = await readFile(join(root, 'base', 'agent.cordis.yml'), 'utf8')

// ── 1. shape ────────────────────────────────────────────────────────────────
// Parse twice: the built-in reader always runs, and the loader's own js-yaml
// dialect runs when a dsh install is reachable. They must agree on the row list,
// because a disagreement means the hand-rolled reader misread the file.
const jsRows = loadWithJsYaml(composed, 'preset/agent.cordis.yml')
const rows = readComposition(composed)
if (rows.length === 0) fail('composition has no loader rows')

const persona = rows.find((row) => row.id === 'persona')
if (!persona) fail('no `persona` row in the composition')
else {
  if (persona.config.prefix === undefined) fail('persona row has no `prefix` block scalar')
  if (persona.config.suffix !== 'Your working directory is {{cwd}}.') {
    fail(`persona row suffix is not the working-directory tail: ${JSON.stringify(persona.config.suffix)}`)
  }
  if (persona.config.text !== undefined) fail('persona row uses the pre-0.1.5 `text` field')
  if (rows[0].id !== 'persona') fail(`persona row is not first (first is ${rows[0].id})`)
}

if (jsRows) {
  const jsPersona = jsRows.find((row) => row.id === 'persona')
  if (!jsPersona?.config) {
    fail('js-yaml sees no `persona` row with a config')
  } else {
    if (typeof jsPersona.config.prefix !== 'string') fail('js-yaml: persona.config.prefix is not a string')
    if (jsPersona.config.suffix !== 'Your working directory is {{cwd}}.') {
      fail(`js-yaml: persona.config.suffix is not the working-directory tail: ${JSON.stringify(jsPersona.config.suffix)}`)
    }
    if (jsPersona.config.prefix !== persona?.config?.prefix) {
      fail('js-yaml and the built-in reader disagree on the persona prefix — the block scalar was misread')
    } else {
      ok('js-yaml and the built-in reader agree on the persona prefix')
    }
  }
  const jsIds = jsRows.map((row) => row.id)
  const ownIds = rows.map((row) => row.id)
  if (jsIds.join(',') !== ownIds.join(',')) {
    fail(`row list disagrees between readers: js-yaml [${jsIds.join(', ')}] vs built-in [${ownIds.join(', ')}]`)
  } else {
    ok(`js-yaml and the built-in reader agree on the row list (${ownIds.length} rows)`)
  }
}

// ── 2. persona completeness ─────────────────────────────────────────────────
// The expected persona comes from lib/persona.mjs, which is the same source
// build.mjs reads. A check that rebuilt the expectation from its own copy of the
// segment list would pass while the build dropped a segment.
if (persona?.config.prefix) {
  const prefix = persona.config.prefix
  const joined = await readPersona(promptDir)
  if (prefix !== joined) {
    fail('persona prefix does not equal the concatenation of prompt/*.md — rerun scripts/build.mjs')
  } else {
    ok(`persona prefix is the verbatim concatenation of ${SEGMENTS.length} segments`)
  }

  // The two ends of the upstream prompt must survive verbatim: the opening
  // voice-note line and the function-call syntax line that closes it. Both are
  // checked against the persona proper, not the assembled prefix: the bridge
  // segment is appended after them and is this preset's own.
  const firstLine = prefix.split('\n')[0]
  if (!firstLine.startsWith('Claude should never use {antml:voice_note} blocks')) {
    fail(`persona does not open with the upstream voice-note line: ${JSON.stringify(firstLine)}`)
  }
  const syntaxLine = (await readPersonaProper(promptDir))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .pop()
  if (!syntaxLine.startsWith('If you intend to call multiple tools')) {
    fail(`upstream persona does not close with the function-call syntax line: ${JSON.stringify(syntaxLine)}`)
  }
  if (!prefix.includes(syntaxLine)) fail('persona is missing the function-call syntax line')
  for (const marker of ['<claude_behavior>', '</claude_behavior>', '<agentic_behavior>', '</agentic_behavior>', '<user_memory>', '</user_memory>']) {
    if (!prefix.includes(marker)) fail(`persona is missing ${marker}`)
  }
  // The bridge segment must be last: it reinterprets the persona for dsh.
  const bridge = await readSegment(promptDir, 'bridge')
  if (!prefix.endsWith(bridge)) fail('persona does not end with the harness bridge segment')
  else ok('persona ends with the harness bridge segment')
}

// ── 3. this preset's own changes ────────────────────────────────────────────
// Rows nested inside a `cordis:group` row are indented, so `readComposition`
// never sees them. Collect them once, up front: the spawned-subagent row and its
// fork sibling both live inside the `delegation` group and are checked here.
const nested = readNestedRows(composed)

const skillRow = rows.find((row) => row.id === 'skill-filesystem')
if (!skillRow) fail('no `skill-filesystem` row')
else if (!skillRow.lines.join('\n').includes('customSkillDirs')) {
  fail('`skill-filesystem` row has no preset-local customSkillDirs')
} else if (!skillRow.lines.join('\n').includes("new URL('skills/', baseUrl)")) {
  fail('`skill-filesystem` customSkillDirs does not resolve the bundled skills/ root')
} else ok('`skill-filesystem` mounts the preset-local skills root')

// The spawned-subagent row lives inside the `delegation` cordis:group, so the
// top-level row scanner above never sees it — it is found through `nested`.
const spawnRow = nested.find((row) => row.id === 'tool-subagent' && row.text.includes('provider: spawn'))
if (!spawnRow) fail('no `tool-subagent` row for provider `spawn`')
else if (!spawnRow.text.includes('persona:')) {
  fail('spawned-subagent row carries no slim `persona`')
} else ok('spawned-subagent row carries a slim persona')

// The fork row must NOT carry a persona: inheriting the parent's prefix is what
// keeps an inherited history eligible for KV-cache reuse.
const forkRow = nested.find((row) => row.id === 'tool-subagent-fork')
if (!forkRow) fail('no `tool-subagent-fork` row')
else if (forkRow.text.includes('persona:')) fail('tool-subagent-fork must keep the parent persona')
else ok('tool-subagent-fork keeps the parent persona')

// A spawned child must not be handed the parent persona by accident: the slim
// persona is the only thing standing between a child and the full persona cost.
const childPersona = /persona: "You are a subagent launched by a DeepSeek Harness session on the ([^"]+?) preset\./.exec(composed)
if (!childPersona) fail('spawned-subagent persona does not carry the expected text')
else if (childPersona[1] !== 'Claude Opus 5.5') {
  fail(`spawned-subagent persona names the wrong preset: ${childPersona[1]}`)
} else ok('spawned-subagent persona names the Claude Opus 5.5 preset')

// Nothing else may differ from upstream: the row id list, minus the inserted
// persona row, must match base exactly and in order.
const composedIds = rows.map((row) => row.id).filter((id) => id !== 'persona')
// Parsed with js-yaml when reachable, so the `!!js` tags take the same shape on
// both sides of the drift comparison below. The built-in reader is the fallback,
// and its row ids are identical either way.
const baseRows = jsRows
  ? jsRowsFromText(base)
  : readComposition(base)
const baseIds = baseRows.map((row) => row.id)
if (composedIds.length !== baseIds.length) {
  fail(`row count differs from upstream (composed ${composedIds.length}, base ${baseIds.length})`)
} else {
  const drift = composedIds.filter((id, index) => id !== baseIds[index])
  if (drift.length > 0) fail(`row ids drift from upstream at: ${drift.join(', ')}`)
  else ok(`row set matches upstream exactly (${baseIds.length} rows)`)
}

// ── 4. prompt variables ─────────────────────────────────────────────────────
// dsh renders `{{...}}` strictly against the variables the agent loop registers
// (`model`, `cwd`). An unregistered group does not degrade gracefully — it fails
// every turn, which reads as "the preset is broken" rather than "a typo".
const variables = promptVariables(composed)
if (variables.length === 0) {
  notes.push('persona references no prompt variables (nothing to interpolate)')
} else {
  const unknown = unregisteredVariables(composed)
  if (unknown.length > 0) {
    fail(`persona references unregistered prompt variables: ${unknown.join(', ')}`)
  } else {
    ok(`persona references only registered prompt variables (${[...new Set(variables)].join(', ')})`)
  }
  if (hasMalformedVariables(composed)) fail('composition has an unbalanced or malformed {{ group')
}

// ── 5. upstream drift ───────────────────────────────────────────────────────
// base/ is a snapshot of the shipped `standard` preset, and dsh changes that
// preset between releases. When the live preset is reachable it is compared row
// by row, so an upgrade surfaces here instead of as a mount failure.
//
// This is advisory, not a gate: a fresh clone has no dsh install, and re-syncing
// base/ is a deliberate act. It reports what drifted rather than failing.
//
// Two normalizations exist purely because the two sides are read differently:
//   - `disabled:` is dropped from both. `--dump-config` prints the tree after the
//     loader resolved it, so `!!js` expressions arrive evaluated (`disabled:
//     true`) while base/ keeps the source (`disabled: !!js process.platform …`).
//     Whether a row is enabled is a property of the host, not of upstream's
//     config, and the row-set check above already catches a row appearing or
//     disappearing.
//   - Block scalars are compared word-by-word. The dump reflows a `section: |`
//     block to its own line width, so a byte comparison would report every row
//     carrying one as drifted. The words are the content; the wrapping is not.
if (jsRows) {
  const live = liveStandardRows()
  if (live === undefined) {
    notes.push('live `standard` preset not reachable — upstream drift not checked')
  } else {
    const liveNoPersona = live.filter((row) => row.id !== 'persona')
    const missing = liveNoPersona.filter((row) => !baseIds.includes(row.id)).map((row) => row.id)
    const extra = baseIds.filter((id) => !liveNoPersona.some((row) => row.id === id))
    if (missing.length > 0) {
      notes.push(`upstream drift: dsh's \`standard\` now has row(s) this base/ lacks — ${missing.join(', ')}`)
    }
    if (extra.length > 0) {
      notes.push(`upstream drift: base/ has row(s) dsh's \`standard\` no longer has — ${extra.join(', ')}`)
    }
    if (missing.length === 0 && extra.length === 0) {
      ok(`base/ row set matches the live \`standard\` preset (${baseIds.length} rows)`)
    }

    // Collapse whitespace inside strings so a reflowed block scalar still equals
    // its source, then serialize with sorted keys so key order is not a diff.
    const comparable = (row) => {
      if (!row) return undefined
      const normalize = (value) => {
        if (typeof value === 'string') return value.split(/\s+/).filter(Boolean).join(' ')
        if (Array.isArray(value)) return value.map(normalize)
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
        }
        return value
      }
      const { disabled, ...rest } = row
      void disabled
      return JSON.stringify(normalize(rest))
    }
    const liveById = new Map(liveNoPersona.map((row) => [row.id, row]))
    const baseById = new Map(baseRows.map((row) => [row.id, row]))
    const changed = baseIds.filter((id) => {
      const a = comparable(liveById.get(id))
      const b = comparable(baseById.get(id))
      return a !== undefined && b !== undefined && a !== b
    })
    if (changed.length > 0) {
      notes.push(`upstream drift: config changed for row(s) ${changed.join(', ')} — re-sync base/`)
    } else if (missing.length === 0 && extra.length === 0) {
      ok('base/ rows match the live `standard` preset')
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────
for (const note of notes) console.log(`[check] ok       ${note}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`[check] FAIL     ${problem}`)
  console.error(`[check] ${problems.length} problem(s)`)
  process.exitCode = 1
} else {
  console.log('[check] all checks passed')
}
