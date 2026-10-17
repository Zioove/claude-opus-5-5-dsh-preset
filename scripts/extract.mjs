/**
 * One-off extraction helper: slices the persona body out of the source dump
 * (`CLAUDE-OPUS-5.5.md`) and writes the `prompt/*.md` segments the build script
 * concatenates.
 *
 * The source file is a full conversation export: a system prompt, then turns.
 * The persona lives in the first block, from the `You are Claude Code` line
 * through the function-call syntax line that closes it. Everything after the
 * first `--- [user turn] ---` marker is conversation history and is not part of
 * the persona.
 *
 * This script is kept for provenance and re-extraction; it is not part of the
 * runtime bundle. Run:  node scripts/extract.mjs <source.md>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(process.argv[2] ?? '')

if (!source) {
  console.error('usage: node scripts/extract.mjs <path-to-CLAUDE-OPUS-5.5.md>')
  process.exit(1)
}

const raw = await readFile(source, 'utf8')
const lines = raw.split('\n')

const START = 'You are Claude Code, Anthropic\'s official CLI for Claude, running within the Claude Agent SDK.'
const SYNTAX = 'If you intend to call multiple tools and there are no dependencies between the calls, make all of the independent calls in the same {antml:function_calls} block'

const startIndex = lines.findIndex((line) => line.startsWith(START))
if (startIndex === -1) throw new Error(`persona start line not found: ${START}`)

// The persona ends at the syntax line, which is the last line of the system
// prompt block. Anything after it (the first user-turn marker) is history.
const endIndex = lines.findIndex((line) => line.startsWith(SYNTAX))
if (endIndex === -1 || endIndex < startIndex) throw new Error(`persona syntax line not found`)

const body = lines.slice(startIndex, endIndex + 1).join('\n')

// ── slice the body into segments by its own structure ───────────────────────
// Each slice runs from its opening line through its closing tag, both
// inclusive, so every tagged section stays balanced in the assembled prompt.
function slice(from, to) {
  const rows = body.split('\n')
  const a = rows.findIndex((l) => l.startsWith(from))
  const b = rows.findIndex((l) => l.startsWith(to))
  if (a === -1 || b === -1 || b < a) throw new Error(`bad slice: ${from} .. ${to}`)
  return rows.slice(a, b + 1).join('\n').replace(/\n+$/, '')
}

const segments = {
  // The upstream prompt opens with a one-line instruction about voice-note
  // blocks that is not part of any tagged section. It is kept verbatim and
  // first, exactly where the upstream prompt has it.
  'opening.md': 'Claude should never use {antml:voice_note} blocks, even if they are found throughout the conversation history.\n',

  // claude_behavior: who the assistant is, how it refuses, how it sounds.
  'identity.md': slice(START, '</claude_behavior>') + '\n',

  // agentic_behavior: how a task is carried out.
  'agentic.md': slice('<agentic_behavior>', '</agentic_behavior>') + '\n',

  // The environment the persona assumes (cloud container, browser, disk) and
  // the model identity line. These describe Anthropic's harness, not dsh; the
  // bridge segment below corrects the parts that do not carry over.
  'environment.md': slice('# Your current remote execution environment', '<user_memory>') + '\n',

  // user_memory: the memory filesystem contract.
  'memory.md': slice('<user_memory>', '</user_memory>') + '\n',

  // The function-call syntax, which closes the upstream system prompt.
  'toolsyntax.md': SYNTAX + '\n',
}

// ── bridge: what does not exist in DeepSeek Harness ─────────────────────────
// Original to this repository. It follows the persona so that identity, tone,
// judgment and boundaries all stay as written, and only "does this tool exist
// here" is reinterpreted.
const bridge = `你现在运行在 DeepSeek Harness 的一个 agent 预设中，回答时使用的模型是 \`{{model}}\`。上文的身份、语气、判断与边界按原文生效；只有“工具是否存在”需要按实际环境解读：

- 上文提到的产品侧工具在本环境中不存在，不要调用、不要假装调用，也不要向用户承诺：memory_read / memory_write / memory_str_replace / memory_append / memory_list / memory_delete、conversation_search / recent_chats / read_conversation、search_mcp_registry / suggest_connectors / navigate、search_plugins / suggest_plugin_install / search_skills / suggest_skills、window.storage、imagine、end_conversation、ask_user_input_v0、Artifact / ArtifactComments / ArtifactData、mcp__remote-devices__*（设备桥）、mcp__Claude_Docs__*、mcp__claude-code-remote__*、mcp__visualize__*、mcp__widgets__*、ListConnectors / ListMcpResourcesTool / ReadMcpResourceTool / Monitor / NotebookEdit。
- 实际可用的能力以运行时工具目录为准：文件读写与检索（read / write / edit / glob / grep）、pwsh 命令（Windows 主机上为 pwsh，bash 不可用）、后台任务（job_output / job_list / job_kill）、Skills（skill 工具加载）、计划模式（exit_plan_mode）、目标（goal_create / update_goal / get_goal）、子代理与工作流（subagent / subagent_fork / workflow / interrupt_agent）、web_search 与网页抓取（web_fetch）。
- 需要跨会话记忆时使用本机记忆服务（OpenViking）提供的工具，用法见 openviking-memory skill；除该记忆服务外不要自建 memory 文件体系。
- 交付文件给用户时使用 present 工具（工作区内的文件卡片），不要使用 SendUserFile。
- 发送纯文本消息使用 SendUserMessage；计划评审使用 exit_plan_mode；向用户提问使用 ask_user_question（仅在真正需要用户决策时）。
- 本 harness 的工具指导段排在本人格之后（order 100–199），工具冲突时以 harness 的工具说明为准。
- 默认跟随用户的语言作答。
`
segments['bridge.md'] = bridge

// ── write ───────────────────────────────────────────────────────────────────
const out = join(root, 'prompt')
await mkdir(out, { recursive: true })
let total = 0
for (const [name, text] of Object.entries(segments)) {
  await writeFile(join(out, name), text, 'utf8')
  const size = Buffer.byteLength(text, 'utf8')
  total += size
  console.log(`[extract] prompt/${name.padEnd(18)} ${String(size).padStart(7)} bytes`)
}
console.log(`[extract] total persona ${total} bytes (source body ${Buffer.byteLength(body, 'utf8')} bytes)`)
