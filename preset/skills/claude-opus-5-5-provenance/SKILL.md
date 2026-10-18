---
name: claude-opus-5-5-provenance
description: 这个预设的人格从哪来、怎么组装、怎么重建与裁剪，以及被适配段刻意排除掉的 Anthropic 产品侧能力清单；并附带 Claude Opus 5.5 系统提示词的逐字原文（reference/），用于对照、引用，或在裁剪人格后按需取回章节。当用户问起这个预设的人格来源、要改/瘦身人格、要核对原文，或遇到挂载失败需要按 dsh schema 重建时加载。
whenToUse: 用户问这个预设的人格来源或为什么某段不在提示里；要裁剪 / 替换 / 更新人格；要引用 Claude Opus 5.5 原文；或预设挂载失败需要重建时。
---

# Claude Opus 5.5 预设：来源与维护

## 人格是怎么装进去的

`preset/agent.cordis.yml` 里一个 `dsh-persona` row 贡献两个提示词段：

| 段 | order | 内容 |
|---|---|---|
| `deployment:persona-prefix` | 0 | Claude Opus 5.5 系统提示词七段拼接 + 运行环境适配段 |
| `deployment:persona-suffix` | 10200 | `Your working directory is {{cwd}}.` |

人格不是一整块写死的字符串，而是 `prompt/` 下七个可独立编辑的段落，由
`scripts/build.mjs` 按顺序拼接（段与段之间空一行）：

| 段 | 文件 | 字节 | 内容 |
|---|---|---|---|
| 1 | `prompt/opening.md` | 111 | 上游开头那行 `voice_note` 指令 |
| 2 | `prompt/identity.md` | 31,017 | `<claude_behavior>`：身份、产品信息、拒绝、语气、wellbeing |
| 3 | `prompt/agentic.md` | 36,000 | `<agentic_behavior>`：任务怎么干、输出怎么交 |
| 4 | `prompt/environment.md` | 4,640 | 远端执行环境、磁盘、浏览器、模型身份 |
| 5 | `prompt/memory.md` | 22,409 | `<user_memory>`：记忆文件系统契约 |
| 6 | `prompt/toolsyntax.md` | 161 | 收尾的 function-call 语法行 |
| 7 | `prompt/bridge.md` | 1,338 | 本 harness 的工具可用性适配段（本仓库原创） |

拼接后的人格 prefix 为 **96,831 字节**（约 3 万 token），整份 composition 约 113 KB。

顺序是 **identity-first**：harness 身份段（-100）在最前，人格在 0，各工具 row
自己的指导在 100–199，工作目录尾段在 10200。也就是说：**dsh 的工具指导排人格之后**，工具冲突时
以 harness 的工具说明为准。

逐字原文在 `reference/Claude-Opus-5.5.md`（与 `prompt/` 下前六段同一份，按段切片）。
人格被裁剪后，需要哪一段就从这里取。

## 适配段排除了什么

`prompt/bridge.md` 追加在人格之后，明确声明原文提到的**产品侧工具在本环境不存在**，
不要调用也不要承诺：`memory_read`/`memory_write`/`memory_str_replace`/`memory_append`/
`memory_list`/`memory_delete`、`conversation_search`/`recent_chats`/`read_conversation`、
`search_mcp_registry`/`suggest_connectors`/`navigate`、`search_plugins`/`suggest_plugin_install`/
`search_skills`/`suggest_skills`、`window.storage`、`imagine`、`end_conversation`、
`ask_user_input_v0`、`Artifact*`、`mcp__remote-devices__*`、`mcp__Claude_Docs__*`、
`mcp__claude-code-remote__*`、`mcp__visualize__*`、`mcp__widgets__*`、
`ListConnectors`/`ListMcpResourcesTool`/`ReadMcpResourceTool`/`Monitor`/`NotebookEdit`。

跨会话记忆改用本机记忆服务（OpenViking，见 `openviking-memory` skill），不要自建 memory 文件体系。

## 重建与裁剪

```bash
node scripts/build.mjs           # prompt/ + base/ → preset/agent.cordis.yml，逐字节可复现
node scripts/build-reference.mjs # prompt/ → reference/Claude-Opus-5.5.md
node scripts/check.mjs           # row 集合、persona schema、补丁在位、变量注册、上游漂移
node scripts/check-plugin.mjs    # bundle 插件自检：DSH_HOME 解析、安装、幂等、不删文件
bash scripts/ci-check.sh         # 以上 + git diff --exit-code 的构建漂移检查
```

**裁剪人格**：编辑 `prompt/` 下对应段落只留需要的章节 → `node scripts/build.mjs` →
按安装方式生效（bundle：`dsh plugin --profile web update dsh-preset-claude-opus-5-5`；
脚本：`bash scripts/install.sh` / `pwsh -File scripts/install.ps1 -Force`）。
裁掉的章节随时能从 `reference/` 取回。

**要增删段落**（不只是改内容）时，改 `lib/persona.mjs` 里的 `SEGMENTS`，不要只改某个脚本：
段列表、读取规则、拼接规则和「哪些段算上游原文」都以那里为单一来源，
`build.mjs` / `build-reference.mjs` / `check.mjs` / `ci-check.sh` 都从它读。

`scripts/extract.mjs` 是当初从导出的对话 dump 里切出这七段的一次性工具，保留作溯源用；
重新提取时运行 `node scripts/extract.mjs <CLAUDE-OPUS-5.5.md>`。

## dsh 升级后的坑

`dsh-persona` 的 config schema 变过一次：**≤ 0.1.4** 是 `text: <string>`，**0.1.5 起**是
`prefix`（必填）+ `suffix`。旧写法会以 `invalid config: $.prefix missing required value`
**挂载失败**——如果它同时是默认预设，症状就是**新建对话直接失败、磁盘上不生成 session 目录**。

`base/` 对齐的是 **dsh 0.2.0-rc.2** 的 `standard` 预设。想知道它有没有过期，给 `check.mjs`
一份线上预设的捕获：

```bash
dsh --profile web --dump-config > /tmp/dump.txt
DSH_DUMP=/tmp/dump.txt node scripts/check.mjs
```

它会报 row 增删与 config 变化；没有捕获时只提示「未检查」，不算失败。

重新同步：

```bash
node scripts/sync-base.mjs /tmp/dump.txt
node scripts/build.mjs && node scripts/build-reference.mjs && node scripts/check.mjs
DSH_DUMP=/tmp/dump.txt node scripts/check.mjs        # 确认漂移已清零
```

`sync-base.mjs` 会保留旧 `base/` 的注释块、块内空行和 block scalar 的原始折行并贴回对应
row（对同一份 dump 逐字节可复现）；dump 本身不带注释。

另外 `build.mjs` 里的两个 `PATCHES` 锚点如果在新版 `standard` 里找不到（或找到多处），
构建会**报错退出**——这是故意的，避免静默丢掉「preset 自带 skill root」和
「spawn 子代理瘦身」两处改动。

`base/agent.cordis.yml` 必须是**未打补丁的上游原文**：它已经带着 `customSkillDirs` 或
子代理 `persona` 的话，`build.mjs` 会把同一处改动打两遍。

## 归属

`prompt/` 与 `reference/Claude-Opus-5.5.md` 是 Anthropic Claude 产品的系统提示词文本，
版权归 Anthropic，按技术研究与个人使用收录，**不在**本仓库 MIT 授权范围内（见 `NOTICE.md`）。
它不改变模型路由，也不代表 Anthropic 或 DeepSeek 的任何官方立场。
`prompt/bridge.md`、`scripts/`、`preset/agent.cordis.yml`、`lib/` 是本仓库原创，MIT 授权。
