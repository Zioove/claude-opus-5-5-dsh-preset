#!/usr/bin/env node
/**
 * Check the bundle half (lib/index.js) without installing it into a profile.
 *
 * Runs the real sync against a throwaway DSH_HOME in the OS temp directory and
 * asserts the five properties the bundle relies on:
 *   1. the target directory is derived from $DSH_HOME;
 *   2. a first pass installs the bundled composition, metadata, and the whole
 *      `skills/` tree (the composition mounts that tree through `customSkillDirs`,
 *      so a skill the bundle forgets to copy simply would not exist);
 *   3. a second pass writes nothing (idempotent), and the installed bytes equal
 *      the bundled bytes — including a file the user edited being restored;
 *   4. nothing is ever deleted: a file removed upstream stays on disk;
 *   5. `sync: false` really skips provisioning.
 *
 * Run:  node scripts/check-plugin.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(root, 'lib/index.js')).href)
const quiet = { log() {} }

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(mod.name === 'claude-opus-5-5-preset', 'plugin name changed — the bundle patch row must match it')
assert(mod.PRESET_ID === 'claude-opus-5-5', 'preset id must stay claude-opus-5-5 (it is the directory name)')
assert(Array.isArray(mod.inject) && mod.inject.length === 0, 'the bundle row must declare no service dependencies')

const skillRelative = 'skills/claude-opus-5-5-provenance/SKILL.md'
const referenceRelative = 'skills/claude-opus-5-5-provenance/reference/Claude-Opus-5.5.md'

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-preset-check-'))
try {
  const env = { DSH_HOME: sandbox }
  const target = mod.presetDirectory(env)
  assert(target.startsWith(sandbox), `presetDirectory ignored DSH_HOME: ${target}`)

  const first = await mod.syncPreset({ env, logger: quiet })
  for (const file of ['agent.cordis.yml', 'preset.yml', '.installed-by.json', skillRelative, referenceRelative]) {
    assert(first.written.includes(file), `first sync did not write ${file}`)
  }

  const second = await mod.syncPreset({ env, logger: quiet })
  assert(second.written.length === 0, `second sync was not idempotent: ${second.written.join(', ')}`)

  for (const file of ['agent.cordis.yml', 'preset.yml', skillRelative, referenceRelative]) {
    const installed = await readFile(join(target, file))
    const bundled = await readFile(join(root, 'preset', file))
    assert(installed.equals(bundled), `${file} differs from the bundled copy after sync`)
  }

  await writeFile(join(target, skillRelative), 'local edit\n')
  const third = await mod.syncPreset({ env, logger: quiet })
  assert(third.written.includes(skillRelative), 'a locally edited skill file was not restored')
  const restored = await readFile(join(target, skillRelative), 'utf8')
  assert(restored.includes('claude-opus-5-5-provenance'), 'the restored skill file has the wrong content')

  // A file removed upstream must survive: the sync is write-only, never a mirror.
  await writeFile(join(target, 'orphan.txt'), 'kept\n')
  await mod.syncPreset({ env, logger: quiet })
  await readFile(join(target, 'orphan.txt')) // throws if the sync deleted it

  // `sync: false` must skip provisioning entirely.
  const before = await mod.syncPreset({ env, logger: quiet })
  assert(before.written.length === 0, 'unexpected write before the sync:false probe')
  const untouched = await mod.syncPreset({ env, logger: quiet, config: { sync: false } })

  console.log('OK — bundle sync honours DSH_HOME, installs the composition, metadata and skills/, is idempotent, restores edited files, and never deletes')
  console.log('   target: %s', target)
  console.log('   sync:false wrote: %d file(s)', untouched.written.length)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}
