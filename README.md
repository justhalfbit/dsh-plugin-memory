# dsh-plugin-memory

DeepSeek Harness 的跨会话记忆插件（机制对齐 Claude Code 官方 auto memory）：对话模型
在工作中主动记录关键信息（事实 / 决策 / 教训 / 偏好），以纯 Markdown 持久化到
`~/.dsh/memory/`，并在同一项目的新会话中自动注入；另有 opt-in 的后台静默蒸馏。

## 工作方式

- **存储**：`~/.dsh/memory/projects/<全路径编码--路径哈希>/memories.md`，按项目（会话 cwd）隔离。
  目录名是 sessions 风格的全路径可读编码（如 `Users-alice-projects-myapp--3f9a2c1d`）：
  8 位路径哈希保证有损编码永不碰撞，超长路径从头部截断保项目名尾部，不用前导 `-`（shell 安全）；
  v0.4 及更早的 `<项目名-哈希>` 旧目录首次访问时自动迁移改名。
  文件本身人可读、可手编、可 git 管理；无法解析的行在任何改写中原样保留。
  四个固定小节：`## Facts`、`## Decisions`、`## Lessons`、`## Preferences`；
  条目形如 `- [f-1a2b3] 内容 <!-- 2026-08-31 auto -->`（id 由内容哈希派生，天然去重）。
- **记忆写入（v0.3，对齐 Claude Code）**：主要机制是**对话模型边干边记**——注入的提示指示
  模型在学到持久且非显而易见的东西（用户纠错、带理由的决策、来之不易的教训、稳定事实）时
  主动调 `memory_save`，拿不准就不存；发现过时条目主动 `memory_forget`。所有写入都是可见的
  工具调用。Claude Code 官方 auto memory 即此模式（无后台蒸馏器）。
- **自动蒸馏（opt-in，默认关）**：开启 `autoDistill` 后，每轮 `turn/end` 追加一层完全静默的
  两阶段蒸馏：零成本预检（跳过子代理会话、无用户消息的轮次、新增文本不足、冷却期内、
  与上次窗口重复、进行中的蒸馏）通过后，后台用一次 `ctx.llm.stream()` 直调提取严格 JSON 条目
  ——不走工具管线、不产生卡片、不写入对话。适合无人值守的长任务；日常交互建议保持关闭
  （独立蒸馏器缺乏对话级判断力，容易把闲聊回收成"知识"）。
  模型选择：设置指定的蒸馏模型 → 当前会话最近一次请求的路由 → agent 自身配置（与 compaction 相同的回退链）。
- **注入**（`agent/pre-step` waterfall）：以 `<system-reminder>` 拼入步骤消息，
  按渲染体 SHA-1 去重——文件不变则整个会话只注入一次（KV cache 友好）；
  进程重启恢复会话时从日志反扫接续 digest，不会重复注入。
- **工具**（全局注册）：`memory_save`（手动存，manual 条目最后被淘汰）、
  `memory_search`（关键词检索）、`memory_list`（含文件路径与专题清单）、`memory_forget`（按 id 删除）、
  `memory_read`（按需读取专题文件全文）、`memory_write_topic`（创建/追加/重写专题文件）。
- **专题文件（渐进式披露，v0.2）**：`projects/<slug>/topics/*.md` 存放自由格式的深度笔记
  （调试手册、API 约定等）。它们**不自动注入**——注入的记忆摘要末尾只附一行一个的索引
  （文件名 + 大小 + 日期 + 首行摘要），模型在相关时调 `memory_read` 按需加载全文。
  上限：每项目 24 个专题、单文件 64K 字符；自动蒸馏不写专题文件，专题由模型/用户主动维护。
- **设置**：host 侧注册 `memory` 命名空间（`applies: live`，热生效）；
  浏览器半（`lib/client.js`）在「设置 → 插件 → 插件配置」渲染中文卡片。
  也可直接编辑 `~/.dsh/settings.yaml` 的 `memory:` 节。

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（关闭后不注入不蒸馏，工具仍可查询） |
| `autoDistill` | `false` | opt-in：额外开启每轮完成后的后台静默蒸馏（默认由对话模型边干边记） |
| `memoryDir` | `''` | 记忆根目录，空 = `<DSH home>/memory` |
| `injectBudgetChars` | `4000` | 注入预算（字符），超出按节均衡截断（保最新） |
| `distillMinChars` | `500` | 触发蒸馏的最小新增字符（不足则累积到下轮） |
| `cooldownTurns` | `1` | 同会话两次蒸馏的最小间隔轮数 |
| `distillProvider` / `distillModel` | `''` | 蒸馏模型；留空跟随当前对话 |
| `maxEntriesPerCategory` | `50` | 每类条目上限，超出先淘汰最旧的 auto 条目 |
| `topicIndexInInject` | `true` | 注入摘要末尾是否附专题文件索引（正文始终按需加载） |
| `proactivity` | `'conservative'` | 记忆积极度：`conservative`（只记纠错/决策/教训，拿不准不记）/ `balanced`（持久知识随学随记）/ `eager`（边干边记、宁多勿漏，近似 Claude 默认）。只改注入措辞，机制与护栏不变 |

## 安装

```sh
dsh plugin --profile <name> add link:/absolute/path/to/dsh-plugin-memory
# 确认 profile package.json 的 dsh.profile.bundles 含 "dsh-plugin-memory"（dsh plugin add 会自动追加）
# 重启 profile 生效
```

插件目录需 `pnpm install` 一次（唯一依赖 `@deepseek-ai/schemastery`，供设置 schema 使用）。

## 测试

```sh
node --test test/
```

## 边界与取舍

- 记忆文件是插件自有用户数据（与 settings/sessions 同级），host 侧用 `node:fs` 直写，不经 agent 文件沙箱。
- 同项目并发会话由进程内每项目写队列串行；跨进程用锁目录 + 原子改名兜底（最后写胜）。
- 蒸馏失败的窗口不重试（水位线在尝试开始时推进，控制成本），下一轮继续。
- 子代理（subagent）会话不注入、不蒸馏；工具对其仍可用。
- 提示词明确禁止存储密钥/凭据/个人数据。
