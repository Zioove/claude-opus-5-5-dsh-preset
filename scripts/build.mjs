#!/usr/bin/env node
/**
 * Build script for the `dsh-preset-claude-opus-5-5` bundle.
 *
 * It assembles `preset/agent.cordis.yml` from two inputs:
 *
 *   1. `base/agent.cordis.yml` — the upstream dsh `standard` agent preset
 *      composition, copied from the installed `@deepseek-ai/dsh` package. It
 *      supplies every tool row and every realm group; this script never
 *      rewrites those.
 *   2. `prompt/*.md` — the persona, split into independently editable segments.
 *
 * The persona is stitched into a single `dsh-persona` row whose `prefix` is the
 * concatenation of the segments, and whose `suffix` is the working-directory
 * tail. Two anchored patches are applied to `base/`:
 *
 *   - PATCH "skill root": the `skill-filesystem` row gains a preset-local
 *     `customSkillDirs` entry, so `preset/skills/` travels with this preset.
 *   - PATCH "slim spawn": the `tool-subagent` row (provider `spawn`) gains a
 *     short `persona`, so a spawned child does not pay for the parent's full
 *     persona tokens.
 *
 * Both patches are anchored and loud: if an anchor is missing or matches more
 * than once, the build fails instead of silently dropping a change.
 *
 * Run:  node scripts/build.mjs        # assemble preset/agent.cordis.yml
 *       node scripts/check.mjs        # validate the assembled result
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SEGMENTS, readPersona, readSegment, unregisteredVariables, hasMalformedVariables } from '../lib/persona.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const promptDir = join(root, 'prompt')

/** The upstream `standard` composition this preset is derived from. */
const BASE = join(root, 'base', 'agent.cordis.yml')

const INDENT = '      ' // the indentation of `prefix:` block content

/**
 * Indent the persona by the preset's YAML block indent.
 * Blank lines stay blank so the rendered prompt has no trailing whitespace.
 */
function indent(text) {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : INDENT + line))
    .join('\n')
}

async function build() {
  // The segment list, the reading rule, and the concatenation rule all live in
  // lib/persona.mjs — the same ones the checks verify against.
  const prefix = await readPersona(promptDir)

  // dsh renders {{...}} strictly against registered variables; an unknown group
  // fails every turn rather than degrading, so refuse to build one.
  const unknown = unregisteredVariables(prefix)
  if (unknown.length > 0) {
    throw new Error(`persona references unregistered prompt variables: ${unknown.join(', ')}`)
  }
  if (hasMalformedVariables(prefix)) {
    throw new Error('persona has an unbalanced or malformed {{ group')
  }

  let base = await readFile(BASE, 'utf8')

  // ── PATCH 1: preset-local skill root ───────────────────────────────────────
  // The `skill-filesystem` row discovers skills for the agents on this preset.
  // Without a `customSkillDirs` entry the provenance skill in `preset/skills/`
  // would never be found. `baseUrl` resolves to the installed preset directory,
  // so the root works wherever the preset lands.
  const SKILL_ANCHOR = `- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
`
  const SKILL_PATCHED = `- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"
`
  const skillMatches = base.split(SKILL_ANCHOR).length - 1
  if (skillMatches !== 1) {
    throw new Error(`PATCH "skill root" anchor matched ${skillMatches} times, expected 1`)
  }
  base = base.replace(SKILL_ANCHOR, SKILL_PATCHED)

  // ── PATCH 2: slim spawned-subagent persona ─────────────────────────────────
  // A spawned child starts with no inherited history, so it does not need the
  // parent persona's full token cost. This replaces whatever `persona` the
  // upstream row already carries.
  const SPAWN_ANCHOR = `    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        modelSelectionSettings: true
        backgroundMode: continuable
`
  const SPAWN_PATCHED = `    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        modelSelectionSettings: true
        backgroundMode: continuable
        # A spawned child starts with no inherited history, so it does not need
        # the parent persona (and paying that per child buys nothing). Requires
        # the provider's \`persona\` capability; mount validation fails loudly
        # without it. Delete this line to give spawned children the full persona
        # again. \`subagent_fork\` deliberately keeps the parent persona: its
        # whole point is inheriting the parent history and staying eligible for
        # KV-cache reuse.
        persona: "You are a subagent launched by a DeepSeek Harness session on the Claude Opus 5.5 preset. You were given one task: complete it and report back. Read what the task needs, run what it needs, and stop there — do not start adjacent work, do not ask the user anything, and do not delegate further. Answer in the language of the task: lead with the outcome, then the evidence (paths, commands, outputs, hashes) and anything the caller still has to verify."
`
  const spawnMatches = base.split(SPAWN_ANCHOR).length - 1
  if (spawnMatches !== 1) {
    throw new Error(`PATCH "slim spawn" anchor matched ${spawnMatches} times, expected 1`)
  }
  base = base.replace(SPAWN_ANCHOR, SPAWN_PATCHED)

  // ── PATCH 3: the persona row itself ───────────────────────────────────────
  // The upstream `standard` composition carries no `persona` row — the
  // deployment supplies one, and this preset shadows it for the agents that use
  // this preset. The row is inserted at the top of the composition so the file
  // reads identity-first, matching the upstream preset it derives from.
  //
  // `suffix` is the working-directory tail at order 10200; `prefix` is the
  // persona itself at order 0. `{{model}}` and `{{cwd}}` resolve from the
  // agent's own route and workspace.
  //
  // dsh ≥ 0.1.5 uses `prefix`/`suffix`; ≤ 0.1.4 used a single `text` field.
  // The old spelling fails mount with "$.prefix missing required value".
  if (/^- id: persona$/m.test(base)) {
    throw new Error('base composition unexpectedly carries a persona row; upstream may have changed')
  }

  const header = `# The \`claude-opus-5-5\` agent preset: the full coding agent with the
# Claude Opus 5.5 persona, mounted once per process.
#
# This file is an AGENT-PLANE composition, derived from the upstream dsh
# \`standard\` preset (\`base/agent.cordis.yml\`) by scripts/build.mjs. Every tool
# row and every realm group comes from upstream; only the persona row's
# \`prefix\`, the \`skill-filesystem\` skill root, and the spawned-subagent
# \`persona\` are this preset's own. Rebuild after editing anything under
# \`prompt/\`:
#
#     node scripts/build.mjs
#
# Ordering is identity-first: the persona is at order 0, the tool rows' own
# guidance sits at 100–199, and the working-directory tail at 10200 — so when a
# tool description and the persona disagree, the harness tool guidance wins.
# See preset/skills/claude-opus-5-5-provenance/SKILL.md for what was adapted
# away and why.
`

  const personaRow = [
    `# ── persona ── Claude Opus 5.5 ─────────────────────────────────────────────`,
    ``,
    `- id: persona`,
    `  name: '@deepseek-ai/dsh-persona'`,
    `  config:`,
    `    suffix: Your working directory is {{cwd}}.`,
    `    prefix: |-`,
    indent(prefix),
  ].join('\n')

  const output = [header, personaRow, '', base].join('\n')

  const target = join(root, 'preset', 'agent.cordis.yml')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, output, 'utf8')

  const bytes = Buffer.byteLength(output, 'utf8')
  console.log(
    `[build] preset/agent.cordis.yml written (${bytes} bytes, ` +
      `${output.split('\n').length} lines, persona ${Buffer.byteLength(prefix, 'utf8')} bytes)`,
  )
  for (const segment of SEGMENTS) {
    const size = Buffer.byteLength(await readSegment(promptDir, segment.name), 'utf8')
    const tag = segment.reference ? '' : '  (this repository)'
    console.log(`[build]   prompt/${`${segment.name}.md`.padEnd(18)} ${String(size).padStart(7)} bytes${tag}`)
  }
}

build().catch((error) => {
  console.error(`[build] failed: ${error?.message ?? error}`)
  process.exitCode = 1
})
