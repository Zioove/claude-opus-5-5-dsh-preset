# Claude Opus 5.5 · DeepSeek Harness Agent Preset

[中文](README.md) | **English**

Runs the **Claude Opus 5.5 system prompt** (seven segments under `prompt/`, ~95 KB) as the
persona layer of a **DeepSeek Harness (dsh)** agent preset. Install it, pick "Claude Opus 5.5"
in dsh, and you get an agent with the full coding toolchain whose identity, tone, and judgment
follow the Claude Opus 5.5 text verbatim.

> In one line: **dsh's tools, Claude's persona.**

---

## Features

- **Persona inlined verbatim**: the whole prompt goes into the `dsh-persona` row's `prefix`
  segment (order 0) — no truncation, no rewriting.
- **Seven segments, each trimmable**: `prompt/` holds one file per segment, `build.mjs`
  concatenates them, `check.mjs` verifies the result byte-for-byte. The verbatim text of the
  first six segments also lives in `preset/skills/.../reference/`, so a trimmed segment can
  always be taken back.
- **Full tool surface**: the preset is derived wholesale from dsh's shipped `standard` preset —
  file read/write and search, pwsh, background jobs, Skills, plan mode, goals, subagents,
  workflows, and the web tools all stay.
- **One environment-bridge segment**: `prompt/bridge.md` maps the product-side tools the
  upstream prompt mentions (`memory_read`, `conversation_search`, `search_mcp_registry`,
  `window.storage`, `end_conversation`, …) onto what actually exists here, so the model never
  calls a tool that is not there.
- **Subagents stop carrying the persona**: the `tool-subagent` row (provider `spawn`) carries
  a 461-character child persona, so a spawned child does not pay for 96 KB of parent persona.
  The fork row deliberately keeps the parent persona — inheriting history and staying eligible
  for KV-cache reuse is its whole point.
- **The source travels with the preset**: `preset/skills/claude-opus-5-5-provenance/`
  (mounted through `customSkillDirs` + `baseUrl`) puts the persona's provenance, the rebuild
  and trim instructions, and the **verbatim text** into an on-demand skill — zero resident
  token cost.
- **Reproducible**: `scripts/build.mjs` regenerates the composition from `base/` + `prompt/`,
  so a dsh upgrade is one command away from the new schema.

---

## Layout

```
.
├── package.json              # also a dsh bundle plugin (dsh.bundle.patch)
├── cordis.patch.yml          # bundle patch: insert one host-plugin row
├── lib/
│   ├── index.js              # host plugin: syncs preset/ into $DSH_HOME/.agent-presets/
│   └── persona.mjs           # single source for the persona: segment list, read/join rules, variable registry
├── preset/
│   ├── agent.cordis.yml      # installable composition (persona inlined, ~113 KB)
│   ├── preset.yml            # display name and description
│   └── skills/
│       └── claude-opus-5-5-provenance/
│           ├── SKILL.md      # preset-local skill: provenance, rebuild, dsh pitfalls
│           └── reference/Claude-Opus-5.5.md   # verbatim persona text (restore from here)
├── base/
│   └── agent.cordis.yml      # derived upstream baseline (unpatched dsh standard preset, 0.2.0-rc.2)
├── prompt/                   # the seven persona segments (#7 bridge is original to this repo)
│   ├── opening.md  identity.md  agentic.md  environment.md
│   ├── memory.md   toolsyntax.md  bridge.md
├── scripts/
│   ├── build.mjs             # base/ + prompt/ -> preset/agent.cordis.yml
│   ├── build-reference.mjs   # prompt/ -> reference/Claude-Opus-5.5.md
│   ├── check.mjs             # artifact self-check (persona schema, rows, patches, upstream drift)
│   ├── check-plugin.mjs      # bundle self-check: DSH_HOME, install, idempotence, no deletes
│   ├── ci-check.sh           # local CI: reproducibility + variable check + self-checks
│   ├── extract.mjs           # the one-off segmenter that produced prompt/ (provenance)
│   ├── sync-base.mjs         # re-derives base/ from a --dump-config capture (provenance)
│   ├── install.ps1           # Windows install (method B)
│   └── install.sh            # macOS / Linux install (method B)
├── docs/
│   └── notes.md              # how it works, the schema migration trap, maintenance
├── NOTICE.md                 # provenance and attribution of the prompt text
└── LICENSE                   # MIT (scripts and configuration only)
```

---

## Install

A preset's id is its directory name; dsh reads local presets from
`${DSH_HOME:-~/.dsh}/.agent-presets/<id>/`.

### Method A: through dsh (recommended — one command, self-updating)

This repository is also a **dsh bundle plugin** (`dsh.bundle.patch` in `package.json`,
one host-plugin row inserted by `cordis.patch.yml`). Once installed it syncs the repo's
`preset/` into the preset directory on every boot, so there is no manual copy:

```bash
dsh plugin --profile web add github:Zioove/claude-opus-5-5-dsh-preset
# then restart dsh web (bundle layers load on next boot)
```

- Install/update: `dsh plugin --profile web add|update dsh-preset-claude-opus-5-5`
- Uninstall: `dsh plugin --profile web remove dsh-preset-claude-opus-5-5`
  (the installed preset directory stays; delete `<DSH_HOME>/.agent-presets/claude-opus-5-5/`
  yourself if you want it gone)
- The plugin has **zero dependencies** (node builtins only), is **idempotent** (byte-compares
  each file, writes only on difference), **never breaks boot** (failures only log), and
  **never deletes**. It does overwrite local edits: the repository version wins.
- If pnpm mentions `allowBuilds`, that only happens to packages with `prepare`/`postinstall`
  scripts; this package has none, so normally no approval is needed.

### Method B: clone and run the install script

```powershell
git clone https://github.com/Zioove/claude-opus-5-5-dsh-preset.git
cd claude-opus-5-5-dsh-preset
pwsh -File scripts/install.ps1        # Windows
```

```bash
git clone https://github.com/Zioove/claude-opus-5-5-dsh-preset.git
cd claude-opus-5-5-dsh-preset
bash scripts/install.sh               # macOS / Linux
```

### Method C: copy by hand

Copy `preset/` into `%DSH_HOME%\.agent-presets\claude-opus-5-5\`
(or `~/.dsh/.agent-presets/claude-opus-5-5/`):

```
.agent-presets/claude-opus-5-5/agent.cordis.yml
.agent-presets/claude-opus-5-5/preset.yml
.agent-presets/claude-opus-5-5/skills/…
```

### Zero-copy (advanced)

The `dsh-agent-presets` row supports `roots` (earlier roots win), so the clone itself can be
mounted as a preset root — rearrange `preset/` into `presets/claude-opus-5-5/agent.cordis.yml`
and add to the `agent-presets` row in the profile's `cordis.patch.yml`:

```yaml
- id: agent-presets
  config:
    roots:
      - path: ~/src/claude-opus-5-5-dsh-preset/presets
        trust: user
```

`path` accepts `~`; relative paths resolve against the process cwd, so prefer absolute or `~`.
`git pull` then upgrades the preset, at the cost of hand-editing config.

---

## Verify and rebuild

```bash
node scripts/build.mjs           # base/ + prompt/ -> preset/agent.cordis.yml
node scripts/build-reference.mjs # prompt/ -> reference/Claude-Opus-5.5.md
node scripts/check.mjs           # self-check: persona schema, row set, both patches
node scripts/check-plugin.mjs    # bundle self-check: DSH_HOME, install, idempotence, no deletes
bash scripts/ci-check.sh         # all of the above + build reproducibility (local CI)
```

`preset/agent.cordis.yml` and `reference/Claude-Opus-5.5.md` are **generated**: after editing
the persona text or re-syncing `base/`, rerun the corresponding script and commit the result,
or CI fails on `git diff --exit-code`.

---

## Use

1. Restart or refresh the dsh Web GUI and pick **Claude Opus 5.5** in the preset picker.
2. To make it the default for new sessions, write in `settings.yaml`:

   ```yaml
   agent-presets:
     default: claude-opus-5-5
   ```

   (Read on each resolution, so no restart is needed. The GUI preset picker works too.)

---

## Deliberate changes versus `standard`

`build.mjs` states three explicit patches, each naming the upstream fact it overrides and why.
When an anchor is missing (or matches more than once) in a newer `standard`, the build
**fails loudly** rather than silently dropping a change:

| Change | Why |
|---|---|
| `skill-filesystem` gains `customSkillDirs` (`!!js` + `baseUrl` at the preset's own `skills/`) | provenance and verbatim text travel with the preset and load on demand — the same mechanism the shipped `cordis` preset uses |
| `tool-subagent` (spawn) gains a 461-character `persona` | the persona is a resident cost; a spawned child does not need the 96 KB version. Fork does not get one, because it must inherit history and reuse the parent's KV cache |
| a `persona` row is inserted whose `prefix` is the seven segments | upstream `standard`'s persona row is just `You are a coding agent powered by the {{model}} model.` |

The persona also references the current model through `{{model}}` — **the upstream pattern is
"one fact, one owner"**: the agent loop registers the model name as a prompt variable and the
persona only references it. dsh interpolates strictly, so an unregistered `{{...}}` fails every
turn; `ci-check.sh` therefore refuses a persona with an unregistered variable.

---

## How it works

dsh's system prompt is **assembled from segments**; the `dsh-persona` row contributes two of them:

| Segment | order | This preset |
|---|---|---|
| `deployment:persona-prefix` | 0 | the seven Claude Opus 5.5 segments + the environment bridge |
| `deployment:persona-suffix` | 10200 | `Your working directory is {{cwd}}.` |

The harness identity segment (-100) and the tool-usage guidance (100–199) still come from
`standard`, so this preset is "dsh's skeleton with Claude's persona" rather than a wholesale
replacement. To make the persona the **only** system prompt (dropping harness identity and tool
guidance too), add `complete: true` to the persona row in `preset/agent.cordis.yml`.

The three `isolate` realm rules in the composition (`planning` / `compaction` / `delegation`)
are dsh's hard requirement for preset-owned services; they are kept exactly as upstream.

---

## Cost note

The persona segment is resident at ~**95 KB ≈ 30k tokens** on every request. With a 1,000,000
context window that is fine, but it raises per-token cost noticeably. To slim it: edit the
relevant `prompt/` segment, then `node scripts/build.mjs`.

---

## Maintenance on upgrade (important)

dsh changes row config schemas. The trap this repo already hit:

- **dsh ≤ 0.1.4**: the `dsh-persona` field was `text: <string>`.
- **dsh 0.1.5-rc.3 onwards**: it became `prefix` (required) plus `suffix`. The old spelling
  fails mount with `invalid config: $.prefix missing required value` — and when the preset is
  also the default, the symptom is **new conversations failing with no session directory on
  disk at all**.

`base/` tracks the `standard` preset of **dsh 0.2.0-rc.2**. To find out whether it has gone
stale, let `check.mjs` compare it against the live preset:

```bash
dsh --profile web --dump-config > /tmp/dump.txt
DSH_DUMP=/tmp/dump.txt node scripts/check.mjs
```

It reports rows appearing or disappearing and configs changing; without a capture it only
notes "not checked" and does not fail, because re-syncing `base/` is a judgement call rather
than something to automate.

After upgrading dsh, re-sync the baseline and rebuild:

```bash
# 1) re-derive base/ from the live preset
dsh --profile web --dump-config > /tmp/dump.txt
node scripts/sync-base.mjs /tmp/dump.txt
# 2) rebuild + self-check
node scripts/build.mjs && node scripts/build-reference.mjs
node scripts/check.mjs
DSH_DUMP=/tmp/dump.txt node scripts/check.mjs        # confirm drift is back to zero
# 3) install/update and start one session in the GUI to confirm
dsh plugin --profile web update dsh-preset-claude-opus-5-5   # method A (bundle)
#   or bash scripts/install.sh / pwsh -File scripts/install.ps1 -Force
```

`sync-base.mjs` lifts the `preset-standard` plugins out of the dump, drops the persona row,
and re-indents them into a column-0 composition. The dump carries no comments, so the script
also preserves the previous `base/`'s comment blocks, blank lines inside them, and the
original wrapping of block scalars, re-attaching each to its row — verified byte-reproducible
against the same dump. Pass `--no-keep-comments` / `--no-keep-blocks` to drop those.

The shipped preset directory and preset ids also move between versions (from 0.1.5 the
directory moved to `node_modules/@deepseek-ai/dsh-agent-presets/presets/`, and preset `code`
was renamed `ptc`). See `docs/notes.md` for details.

---

## Known limitations

- The product-side capabilities the upstream prompt describes (memory filesystem, conversation
  search, MCP connector catalog, Artifacts storage, Imagine, `end_conversation`) do not exist
  in dsh; the bridge segment excludes them explicitly. For cross-session memory, use the local
  memory service (OpenViking).
- The upstream text describes Anthropic's product family. This preset uses it only as persona
  and behavior guidance; it changes no model routing and represents no official position of
  Anthropic or DeepSeek.
- Any change to the persona text changes the system-prompt prefix and rebuilds the KV cache.

---

## License and attribution

- This repository's **scripts, configuration, and documentation**: MIT, see `LICENSE`.
- **`prompt/*.md` and `reference/Claude-Opus-5.5.md`**: the system prompt text of Anthropic's
  Claude product (Claude Opus 5.5), copyright Anthropic PBC, included for technical research
  and personal use only, **not** covered by the MIT license. See `NOTICE.md`.
