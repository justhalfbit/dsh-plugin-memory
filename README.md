# dsh-plugin-memory

中文 | [English](README.en.md)

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的跨会话记忆插件：
对话模型在工作中**边干边记**，把值得长期记住的信息（事实 / 决策 / 教训 / 偏好）持久化为
纯 Markdown 文件，并在同一项目的新会话中自动注入。机制对齐 Claude Code 官方 auto memory，
并在索引同步与结构护栏上更进一步。

## 特性

- 🧠 **两层记忆**：主记忆文件（自动注入，预算内截断）+ 专题文件（渐进式披露：只注入一行索引，正文按需加载）
- ✍️ **模型边干边记**：所有写入都是可见的工具调用，三档积极度可调（保守 / 平衡 / 积极）
- 🤫 **可选后台蒸馏**（默认关）：每轮对话完成后静默提取记忆，零工具卡片、零对话痕迹，适合无人值守长任务
- 📁 **按项目隔离**：以会话工作目录为粒度，目录名为可读的全路径编码 + 防碰撞哈希
- 📝 **纯 Markdown 存储**：人可读、可手编、可 git 管理；无法解析的行在任何改写中原样保留
- ⚙️ **设置面板**：浏览器卡片 + `settings.yaml` 双入口，全部配置热生效
- 🔒 **护栏完备**：内容哈希去重、每类条目上限、修剪顺序（手动条目最后淘汰）、注入预算、KV cache 友好的 digest 防重

## 安装

前置：已安装 [DSH](https://github.com/deepseek-ai/deepseek-harness) 且 `pnpm` 在 PATH 上。

```sh
# 从 GitHub 安装（本插件零构建步骤，无需 allowBuilds 配置）
dsh plugin --profile web add github:justhalfbit/dsh-plugin-memory

# 重启 dsh web 生效
```

`web` 是 `dsh web`（浏览器界面）对应的 profile 名；用其他 profile（如 `tui`）时把 `web` 换成对应名字即可。
`dsh plugin add` 会自动把包写入 profile 依赖并追加到 `dsh.profile.bundles`，无需手工编辑。

卸载：`dsh plugin --profile web remove dsh-plugin-memory`，重启生效；记忆数据保留在 `~/.dsh/memory`，可手动删除。

本地开发安装：克隆本仓库后 `pnpm install`，再 `dsh plugin --profile web add link:/绝对路径/dsh-plugin-memory`。

> 兼容性：针对 DSH `0.1.1-rc.x` 开发；rc 阶段上游 API 可能变动。

### 界面支持

| 运行形态 | 记忆核心（注入 / 蒸馏 / 工具 / 存储） | 设置卡片 |
|---|---|---|
| `dsh web`（浏览器 GUI） | ✅ | ✅ |
| `tui` / `headless` | ✅ 全部可用 | ❌ 改用 `settings.yaml`（同样热生效） |

host 半与界面无关；client 半（设置卡片）声明 `platform: "web"`，仅在浏览器界面加载。

## 工作方式

### 存储

```
~/.dsh/memory/projects/<全路径编码--路径哈希>/
├── memories.md      # 主记忆文件：四个小节（Facts/Decisions/Lessons/Preferences）
└── topics/*.md      # 专题文件：自由格式深度笔记（调试手册、API 约定……）
```

条目形如 `- [f-1a2b3c4d] 内容 <!-- 2026-09-01 auto -->`——id 由内容哈希派生（天然去重），
尾注记录日期与来源（`auto` 蒸馏 / `manual` 手动，修剪时 auto 先淘汰）。
专题上限：每项目 24 个文件、单文件 64K 字符、单次写入 16K 字符。

### 记忆写入（主机制，对齐 Claude Code）

注入的提示指示对话模型在学到持久且非显而易见的东西时主动调用 `memory_save`：用户纠错、
带理由的决策、来之不易的教训、稳定的项目事实。拿不准就不存；发现过时条目主动 `memory_forget`；
任务收尾产出成体系知识时用 `memory_write_topic` 整理成专题。积极度由 `proactivity` 设置控制，
只改提示措辞，机制与护栏不变。

### 注入

`agent/pre-step` waterfall 把记忆以 `<system-reminder>` 拼入步骤消息：主文件条目全量
（默认 4000 字符预算，按节均衡截断保最新），专题文件每个一行索引（名称 + 大小 + 日期 + 首行摘要），
正文由模型在相关时调 `memory_read` 按需加载。按渲染体 SHA-1 防重——文件不变则整个会话只注入一次
（KV cache 友好）；digest 仅在注入消息真正落盘后推进，步骤失败自动自愈重注入；
进程重启恢复会话时从日志反扫接续。

### 自动蒸馏（opt-in，默认关）

开启 `autoDistill` 后，每轮 `turn/end` 追加一层完全静默的两阶段蒸馏：零成本预检
（跳过子代理会话、无用户消息的轮次、新增文本不足、冷却期内、重复窗口、进行中的蒸馏）
通过后，后台用一次 `ctx.llm.stream()` 直调提取严格 JSON 条目——不走工具管线、不产生卡片。
模型选择回退链与 compaction 一致：设置指定 → 会话最近请求路由 → agent 配置。

## 模型工具

| 工具 | 作用 |
|---|---|
| `memory_save` | 存一条（category + content），内容哈希去重，返回 id |
| `memory_search` | 关键词检索（大小写不敏感分词匹配 + 短语加权） |
| `memory_list` | 列出全部条目与专题清单，含文件路径 |
| `memory_forget` | 按 id 删除错误/过时条目 |
| `memory_read` | 按需读取专题文件全文 |
| `memory_write_topic` | 创建/追加/重写专题文件（append / replace） |

## 设置项

设置入口：「设置 → 插件 → 插件配置 → 跨会话记忆」卡片，或 `~/.dsh/settings.yaml` 的 `memory:` 节。全部热生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（关闭后不注入不蒸馏，工具仍可查询） |
| `proactivity` | `'conservative'` | 记忆积极度：`conservative` / `balanced` / `eager` |
| `autoDistill` | `false` | opt-in：额外开启每轮完成后的后台静默蒸馏 |
| `memoryDir` | `''` | 记忆根目录，空 = `<DSH home>/memory` |
| `injectBudgetChars` | `4000` | 注入预算（字符），超出按节均衡截断（保最新） |
| `distillMinChars` | `500` | 触发蒸馏的最小新增字符（不足则累积到下轮） |
| `cooldownTurns` | `1` | 同会话两次蒸馏的最小间隔轮数 |
| `distillProvider` / `distillModel` | `''` | 蒸馏模型；留空跟随当前对话 |
| `maxEntriesPerCategory` | `50` | 每类条目上限，超出先淘汰最旧的 auto 条目 |
| `topicIndexInInject` | `true` | 注入摘要末尾是否附专题索引（正文始终按需加载） |

## 设计

**为什么挂 host 平面而不是 agent preset？**DSH 的设置命名空间每进程只能注册一次
（preset 插件每会话实例化一份，第二个会话必然撞车），且记忆天然跨会话、需要进程级单例的
写队列。host 平面的根上下文监听器能收到所有会话的事件，工具全局注册，按 `session.header.cwd`
归属项目——单例服务多会话，能力无损。

**与 Claude Code auto memory 的对照：**

| 环节 | Claude Code | 本插件 |
|---|---|---|
| 写入者 | 主对话 agent 自己（可见工具调用） | ✅ 相同（`proactivity` 三档可调） |
| 加载 | MEMORY.md 前 200 行 | 主文件预算内全量（默认 4000 字符） |
| 专题文件 | 不自动加载，按需 Read | ✅ 相同（`memory_read`） |
| 索引 | agent 手工维护于 MEMORY.md，会失同步 | **注入时扫目录动态生成，永不失同步** |
| 结构 | 自由格式，无界增长 | **四类条目 + 内容哈希去重 + 上限修剪** |
| 后台蒸馏 | 无 | 额外提供，opt-in |

**可靠性设计**：每文件写队列串行化 + 跨进程锁目录（陈旧锁 5s 可偷取，偷前二次确认）+
临时文件原子改名（失败自动清理）；目录解析单飞（single-flight）防迁移竞态；
注入 digest 日志确认制；蒸馏水位线在尝试开始时推进（失败窗口不重试，成本可控）。

**安全**：专题名白名单校验（构造上杜绝路径穿越）；注入内容大小写不敏感转义闭合标签；
蒸馏提示词明令禁止存储密钥/凭据/个人数据；子代理会话不注入不蒸馏。

## 已知限制

- 跨进程并发写同一项目为"最后写胜"的弱保证（进程内严格串行）；
- 蒸馏失败的窗口不重试（有意的成本控制）；
- 记忆文件是插件自有用户数据，host 侧直写，不经 agent 文件沙箱。

## 开发

```sh
pnpm install
node --test test/   # 23 项单测
```

## License

[MIT](LICENSE)
