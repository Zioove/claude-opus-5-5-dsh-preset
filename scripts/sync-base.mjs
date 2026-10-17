/**
 * Re-derive `base/agent.cordis.yml` from the live dsh `standard` preset.
 *
 * The upstream dsh `standard` agent composition is shipped inside the
 * `@deepseek-ai/dsh` package, which a checkout cannot read directly. The
 * authoritative source is therefore a `--dump-config` capture:
 *
 *   dsh --profile web --dump-config > /tmp/dump.txt
 *   node scripts/sync-base.mjs /tmp/dump.txt
 *
 * The capture contains the host composition AND every preset's `plugins:` list,
 * indented. This script lifts the `preset-standard` plugins back to a column-0
 * composition and drops the persona row — this preset's build inserts its own, so
 * leaving upstream's would be a duplicate for the patch anchors to trip over.
 *
 * The dump carries no comments, but `base/` does: upstream's row comments explain
 * the plane/realm rules that make the composition work. When an existing
 * `base/agent.cordis.yml` is present its comments are preserved and re-attached
 * to the rows they document, so re-running this after a dsh upgrade keeps the
 * prose while taking the new rows. Pass `--no-keep-comments` to drop them.
 *
 * The result is checked in, so this script is provenance, not a build step.
 * Re-run it only when dsh ships a new `standard` preset and you want to re-derive
 * `base/` from it.
 *
 * Run:  node scripts/sync-base.mjs <dump-config capture> [--no-keep-comments]
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const keepComments = !args.includes('--no-keep-comments')
const keepBlocks = !args.includes('--no-keep-blocks')
const source = resolve(args.find((arg) => !arg.startsWith('--')) ?? '')
if (!source) {
  console.error('usage: node scripts/sync-base.mjs <dump-config capture> [--no-keep-comments]')
  process.exit(1)
}

const raw = await readFile(source, 'utf8')
// `--dump-config` writes progress and bundle warnings to stdout alongside the
// tree, so keep only the lines that belong to the tree.
const rows = raw
  .replace(/\r\n/g, '\n')
  .split('\n')
  .filter((line) => line.startsWith('#') || line.startsWith('- ') || /^[ ]+\S/.test(line))

const presetAt = rows.findIndex((line) => line === '- id: preset-standard')
if (presetAt === -1) throw new Error('no `preset-standard` row in the capture — is this a --dump-config file?')

// The preset's plugins are the indented block under its `plugins:` key.
const pluginsAt = rows.findIndex((line, index) => index > presetAt && line.trim() === 'plugins:')
if (pluginsAt === -1) throw new Error('`preset-standard` has no `plugins:` list')
const PLUGIN_INDENT = '      '
const plugins = []
for (let i = pluginsAt + 1; i < rows.length; i++) {
  const line = rows[i]
  if (line.startsWith(PLUGIN_INDENT)) plugins.push(line)
  else if (line.trim() !== '' && !line.startsWith(' ')) break // next top-level row
}
if (plugins.length === 0) throw new Error('`preset-standard` carries no plugins')

// Drop upstream's persona row entirely, not just its first line: the build
// inserts this preset's own persona, and a leftover fragment would leave a
// dangling `name:`/`config:` pair that YAML cannot parse.
const withoutPersona = []
let inPersona = false
for (const line of plugins) {
  if (line === `${PLUGIN_INDENT}- id: persona`) {
    inPersona = true
    continue
  }
  if (inPersona && line.startsWith(`${PLUGIN_INDENT}  `)) continue // still inside it
  inPersona = false
  withoutPersona.push(line)
}

// De-indent from the preset's nesting back to a column-0 composition. The dump
// carries no comments and no blank lines between rows, so both are restored
// below: `withRowSpacing` puts the separators back, and the preserved regions
// re-attach upstream's prose.
const body = withRowSpacing(
  withoutPersona
    .map((line) => (line.startsWith(PLUGIN_INDENT) ? line.slice(PLUGIN_INDENT.length) : line))
    .join('\n')
    .trimEnd(),
)

/**
 * The comments and blank lines that sit between two rows in the previous
 * `base/`, keyed by the row id that follows them. The dump has no comments at
 * all, so this is what a re-sync uses to keep upstream's prose — and keeping the
 * blank lines is what makes a no-op re-sync byte-identical.
 *
 * A region is the run of comments and blank lines immediately preceding a row,
 * with no row body in it: anything that is not a comment or a blank line belongs
 * to the row above and is dropped. The file's own header is excluded, because it
 * documents this repository's use of the file rather than upstream's rows.
 */
async function existingRegions() {
  const target = join(root, 'base', 'agent.cordis.yml')
  try {
    await access(target)
  } catch {
    return new Map()
  }
  const lines = (await readFile(target, 'utf8')).split('\n')
  const firstRow = lines.findIndex((line) => /^\s*- id: /.test(line))
  if (firstRow === -1) return new Map()
  const found = new Map()
  let region = []
  for (const line of lines.slice(firstRow + 1)) {
    // Rows are matched at any indent: a `cordis:group` nests them, and its
    // comments are indented along with them.
    const match = /^\s*- id: (.+)$/.exec(line)
    if (match) {
      found.set(match[1].trim(), region.join('\n'))
      region = []
      continue
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      region.push(line)
      continue
    }
    // Part of the row above: the region ends here, and the next region starts
    // fresh once a row appears.
    region = []
  }
  return found
}

/**
 * Blank lines between consecutive rows, at any indent.
 *
 * `--dump-config` separates rows by nothing at all, so the tree filter that
 * extracts it drops the blank line every row boundary has — including the ones
 * between rows nested inside a `cordis:group`. Restoring one at each boundary
 * reproduces upstream's layout, except where a comment block sits between the two
 * rows, because that block already carries its own separator.
 */
function withRowSpacing(body) {
  const lines = body.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const next = lines[i + 1]
    // A row's last content line followed directly by another row: insert the
    // separator the dump dropped. A comment heading keeps its own spacing.
    const boundary = next !== undefined && /^\s*- id: /.test(next) && line.trim() !== ''
    // A row's last content line followed directly by another row: insert the
    // separator the dump dropped. A comment heading keeps its own spacing, and a
    // key line (`config:`, `isolate:`) opens a nested list rather than closing a
    // row, so it gets no separator either.
    if (
      boundary &&
      !next.trimStart().startsWith('#') &&
      !line.trimStart().startsWith('#') &&
      !/:\s*$/.test(line)
    ) {
      out.push(line, '')
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Re-attach the preserved regions to the rows they document.
 *
 * `regions` is built while walking the previous file, so a region for row N is
 * the text between row N-1 and row N. Emitting it before the row's own first line
 * reproduces the original layout, with one adjustment: the region's leading blank
 * line is dropped, because `withRowSpacing` has already put a separator there.
 */
function withRegions(body, regions) {
  if (regions.size === 0) return body
  const out = []
  for (const line of body.split('\n')) {
    const match = /^\s*- id: (.+)$/.exec(line)
    if (match) {
      const region = regions.get(match[1].trim())
      if (region) out.push(region.replace(/^\n+/, ''))
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Block scalars from the previous `base/`, keyed by the row and key that carry
 * them, so a re-sync does not silently reflow them.
 *
 * `--dump-config` prints the tree after the loader resolved it, and a
 * `section: |` block arrives re-wrapped to the dump's own line width with its
 * header changed to `>`. The words are identical but the bytes are not, which is
 * enough to make a no-op re-sync look like a change — and enough to rebuild the
 * KV cache for anyone using this preset. Upstream's original wrapping is kept.
 */
async function existingBlocks() {
  const target = join(root, 'base', 'agent.cordis.yml')
  try {
    await access(target)
  } catch {
    return new Map()
  }
  const lines = (await readFile(target, 'utf8')).split('\n')
  const firstRow = lines.findIndex((line) => /^\s*- id: /.test(line))
  if (firstRow === -1) return new Map()
  const found = new Map()
  let currentRow = null
  for (let i = firstRow; i < lines.length; i++) {
    const line = lines[i]
    const rowMatch = /^\s*- id: (.+)$/.exec(line)
    if (rowMatch) {
      currentRow = rowMatch[1].trim()
      continue
    }
    // A block scalar at any indent: `key: |` or `key: |-`, then its content.
    const blockMatch = /^(\s*)(\w+): \|[-+]?\s*$/.exec(line)
    if (blockMatch && currentRow) {
      const indent = blockMatch[1]
      const content = []
      for (let j = i + 1; j < lines.length; j++) {
        // Block content is indented deeper than the key; a shallower line ends it.
        if (lines[j].trim() !== '' && !lines[j].startsWith(`${indent} `)) break
        content.push(lines[j])
      }
      // Store the header without its indent and the content as-is: the caller
      // re-indents with the dump's own key indentation, which is the same width.
      found.set(`${currentRow}/${blockMatch[2]}`, { key: blockMatch[2], content: content.join('\n') })
    }
  }
  return found
}

/**
 * Restore the preserved block scalars in a regenerated body.
 *
 * The dump's block is identified by its row and key, then replaced wholesale
 * with the previous file's header and content, so the original wrapping and
 * chomping indicator survive.
 */
function withBlocks(body, blocks) {
  if (blocks.size === 0) return body
  const lines = body.split('\n')
  const out = []
  let currentRow = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const rowMatch = /^\s*- id: (.+)$/.exec(line)
    if (rowMatch) {
      currentRow = rowMatch[1].trim()
      out.push(line)
      continue
    }
    const blockMatch = /^(\s*)(\w+): [>|][-+]?\s*$/.exec(line)
    const preserved = blockMatch && currentRow ? blocks.get(`${currentRow}/${blockMatch[2]}`) : undefined
    if (preserved) {
      // Re-emit the key with the dump's own indentation and the `|` chomping
      // indicator upstream used, then the preserved content verbatim.
      out.push(`${blockMatch[1]}${preserved.key}: |`)
      if (preserved.content !== '') out.push(preserved.content)
      // Skip the dump's reflowed content, which runs until a shallower line.
      const indent = blockMatch[1]
      i++
      while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith(`${indent} `))) i++
      i--
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

const header = `# The upstream dsh \`standard\` agent preset composition.
#
# This file is DeepSeek Harness configuration, copied verbatim from the \`standard\`
# preset shipped inside \`@deepseek-ai/dsh\` (verified against dsh 0.2.0-rc.2 via
# \`dsh --profile web --dump-config\`; see docs/notes.md §7). It is reference
# material for this repository: \`scripts/build.mjs\` reads it and patches three
# things into it (the persona row's \`prefix\`, the \`skill-filesystem\` skill root,
# and the spawned-subagent \`persona\`) to produce \`preset/agent.cordis.yml\`.
#
# It is NOT loaded by dsh at runtime — only \`preset/agent.cordis.yml\` is, and only
# once this bundle has copied it into \${DSH_HOME:-~/.dsh}/.agent-presets/.
#
# Keep it in sync when dsh ships a new \`standard\` preset:
# \`scripts/check.mjs\` compares it against the live preset and reports drift when
# given a \`--dump-config\` capture (see the DSH_DUMP section of that script). The
# build also fails loudly when one of its patch anchors is no longer present
# exactly once.
#
# It must carry upstream's rows verbatim — including its comment blocks — because
# \`scripts/build.mjs\` anchors its patches on exact row text, and the drift check
# compares the significant lines of each row.
#
# Not covered by this repository's MIT license (see NOTICE.md): it is DeepSeek
# Harness configuration, not an original work of this repository.
`

// Regions first (they carry upstream's prose and their own blank lines), then
// blocks (the dump re-wraps them, so the previous wrapping is restored last).
const withProse = keepComments ? withRegions(body, await existingRegions()) : body
const commented = keepBlocks ? withBlocks(withProse, await existingBlocks()) : withProse

const target = join(root, 'base', 'agent.cordis.yml')
await mkdir(dirname(target), { recursive: true })
await writeFile(target, `${header}\n${commented}\n`, 'utf8')

const rowCount = body.split('\n').filter((line) => /^- id: /.test(line)).length
const commentCount = commented.split('\n').filter((line) => /^#/.test(line)).length
const blockCount = commented.split('\n').filter((line) => /^\s*\w+: [|>][-+]?\s*$/.test(line)).length
console.log(
  `[sync-base] base/agent.cordis.yml written (${commented.split('\n').length} lines, ${rowCount} rows from the live \`standard\` preset, ${commentCount} comment lines, ${blockCount} block scalars)`,
)
