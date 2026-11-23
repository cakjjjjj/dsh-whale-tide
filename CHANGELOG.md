# 更新记录

## 未发布

- **跨会话「最近对话」注入 + 心跳看得到你最后说话的时间**（2026-11-23）：
  心跳和鲸梦跑在各自的会话里，上下文只有「你最近醒过」「相关记忆」，向量检索只会命中
  跟提示词语义相近的记忆——所以它明明每天都在跟你说话，醒来却以为「好几天没见」。
  - `MemoryStore.recentChats({ hours, limit })`：按时间窗直查记忆库（不走向量）。
  - 新增 system prompt 段 `whale-tide-recent-chat`（order 131）：「他最近说过的话（跨会话）」，
    并明说「别把『你最近醒过』当成『好久没见』」。
  - `heartbeat_plan` 的 `plan()` 返回 `lastUserAt`，工具输出多一行「他最后一次说话：N 小时前」。
  - 测试：183 → **188**（`recent-chat` 3 条、`heartbeat` 加 2 条）。
- **P2 四条清理（2026-11-17）**：
  - **P2-2**：`inQuietHour` / `rruleEvery` 的 `quietTo` 默认值从 `18` 改回 `8`（和配置默认一致；
    调用方一直显式传参，所以线上行为不变，只是默认值不再误导）。
  - **P2-5**：`POST /api/config` 的请求体加上限，超过 64KB 直接 413，不再无限拼接。
  - **P2-7**：`ingestQueue` 积压到 400 条要丢最老的批次时，`log.warn` 一句丢了多少条。
  - **P2-12**：删掉源码目录里的 4 个 `.bak-*`（`lib/emotion/`、`lib/`、`test/`），备份都在 `archive/` 里。
  - 测试：183 通过（两条断言随默认值修正更新）。
- **P1-6：提示词不再写死本机路径与 QQ 会话**（2026-11-17）：
  `WAKE_PROMPT` / `DREAM_PROMPT` 两个常量改成 `buildWakePrompt()` / `buildDreamPrompt()`，
  工作区路径、通知命令、晚安收件人都从配置来（新增 `notifyHint` / `reportTo`，面板可填，留空用通用说法）。
  - **同步判断补了 prompt 比对**：只比 rrule 和 target 的话，改了通知方式任务不会重建，改动等于没生效。
  - 面板：心跳卡片加「想说话时用什么命令通知他」，鲸梦卡片加「写晚安语音」开关和「晚安语音发给谁」。
  - 晚安语音从「固有流程」改成可选步骤（`dreamGoodnight`，默认关）——它是这台机器的习惯，不是插件的默认行为。
  - 测试：181 → **183**（新增「提示词按配置填路径和通知方式」「prompt 变了会重建任务」）。
- **P1 五条（P1-6 除外，2026-11-17）**：
  - **P1-3**：`report()` 里的 `purgeDeleted()` 原来在 `dry` 判断之外，dry run 也会真删 30 天前的软删行。
    现在只在 `!dry` 时执行，dry run 报 `pendingPurge` 条数。
  - **P1-4**：面板静默提示改成「起点终点不能填一样（保存会被拒绝）」，跟后端行为一致。
  - **P1-5**：删掉四个没有消费者的配置键 `dreamArchive` / `sharePerDay` / `apiBalanceThreshold` / `apiBalanceFloor`，
    README 表格同步（老库残留行会被 `load()` 忽略）。
  - **P1-2**：`indexer.js` 导入路径补 `source.kind !== 'user'` 过滤；`text.js` 的注入名单补齐
    `time-context` / `agent-instructions` / `skill-catalog`。历史脏数据先 dry run（见 `tools/purge-noise.mjs`）。
  - **P1-1**：`MemoryStore.has(fingerprint)`，两个导入函数在 `embed()` 前先滤掉库里已有切片，
    冷启动不再把最近 60 个会话全量重推一遍推理。
  - 测试：177 → **181**（dream-report +2、memory-filter +2）。
- **P0 三条修复（2026-11-17，按自审清单）**：
  - **P0-1**：`lib/index.js` 用了 `fileURLToPath` 却没导入，被 `catch` 吞掉后 `pluginWorkspace` 恒为 null，
    工作区解析退回 `/var/lib/dsh/workspace`（没有 MEMORY.md）→ 第一次同步建错 `create.cwd`、第二次判「变了」重建。
    补上 `import { fileURLToPath } from 'node:url'`；首次同步改成等 `memory.boot()` 落定再跑。
  - **P0-2**：面板「用配置接管任务」开关只出现在 checkbox，`save()` 的 patch 里没有 `scheduleSync`，
    勾上无效、已开的关不掉。补进 patch，并新增 `test/client-panel.test.mjs` 守住关键键。
  - **P0-3**：`tick-decide` 与 `recentWakeNote` 的 SQL 都把 `result='slept'` 当成「刚醒过」，
    `wakeGapMinutes >= wakeEveryMinutes` 时会死循环 skip；`recentWakeNote` 还会把「静默时段」当醒来记录注入。
    两条 SQL 加 `AND result != 'slept'`；`config.update()` 拒绝「最短间隔 ≥ 唤醒间隔」的组合。
  - 测试：172 → **177**（`client-panel` 3 条、`tick` 新增 2 条）。
- **静默时段内不再投递心跳**（2026-11-17）：以前每 N 分钟都投一次，静默期投出去只会让鲸鲸醒来跑一遍
  `tick` 再 `skip`，白花一次对话。`rruleEvery()` 现在先把一天的触发时刻算出来，只保留非静默小时：
  常见间隔（60/120/180）能用 `DAILY + BYHOUR` 精确表达，静默期一次都不投；
  90 分钟这种会在 `:00` / `:30` 混着出现的，退回 `MINUTELY`（静默期仍会醒，已知限制，面板 hint 写明）。
  - `syncTasks` 把 `quietFrom` / `quietTo` 传进 `rruleEvery`，改静默时段会自动重建任务。
  - 测试：171 → **172**（新增「90 分钟退回 MINUTELY」；`rruleEvery` 与「改间隔会重建」两条断言随行为更新）。
- **鲸梦卡片合并成「记忆归档」一个开关**（2026-11-17，同日第二笔）：dry run 这个词太技术，
  合并成白话——勾「记忆归档」= 真归档，不勾 = 只出清单。
  - `dream/index.js` 的 `report()` 把「允许动手」和「删记忆」解耦：新增 `prune` 参数，
    只有 `dry=false && prune=true` 才软删候选；`archive` 独立控制归档（都要 `dry=false`）。
  - 面板：鲸梦卡片只剩「记忆归档」（`memoryArchive`）和「真删记忆」（`dreamPrune`，hint 写明依赖前者）。
  - `dream_keep` 工具加 `prune` 参数，不传时读配置 `dreamPrune`。
  - 测试：168 → **171**（新增 `test/dream-report.test.mjs` 3 条：dry 不动、没勾不动、勾了真归档）。
- **面板显式化 dry / archive，并补上真正的累积额度**（2026-11-17）：
  - 鲸梦卡片新增「dry run（只报告）」和「归档旧条目」两个开关（`dreamPrune` 反着显示为 dry，
    新增 `dreamArchive`），把原来只能靠提示词说明的两件事摆到面板上。
  - `dailyGrant` / `maxBalance` 之前只有定义、没有任何代码读，等于空配置。新增 `agency_budget` 表
    （一行，`balance` + `granted_on`）：每天发 `dailyGrant`，用不完可攒，`maxBalance` 封顶；
    跨天只补发一次，不按离线天数补。`plan()` 的预算改成 `min(余额, 今天还能发几次)`，
    `record()` 真发出去才扣，`planned/skipped/failed` 不扣。
  - 轻唤醒脚本用只读连接，所以发放只走写连接：插件加载时 `rollBudget()` 一次，`peekBudget()` 纯读。
  - 面板：能动性卡片显示「余额 X（上限 Y）/ 今天还能发 Z」；心跳卡片可配 `dailyGrant`、`maxBalance`。
  - 测试：162 → **168**（新增 `test/agency-budget.test.mjs` 6 条；两条断言随行为更新：
    额度用尽文案、`agency_%` 表数 2→3）。
- **调度 rrule 的 DTSTART 改成固定锚点**（2026-11-16）：`rruleEvery()` / `rruleDaily()` 原来用「当天 00:00」，
  跨零点后字符串就变，同步逻辑按字符串比对 → 每天重建一次任务，投递历史和钉住的会话一起丢
  （今早心跳 id 从 `4d6864bd` 变成 `c5e2fb88` 就是这个）。现在 DTSTART 钉死 `20260101T000000`，相位不变。
  - 测试：161 → **162**（新增「跨天同步时 rrule 不变」；`rruleEvery` 那条断言跟着行为更新——不是为了让测试过，是行为变了）。
- **混合检索：向量 + FTS5 关键词两路，RRF 名次融合**（2026-11-16）：向量一路对精确词几乎无感
  （18 个精确词里只有 5 个能召回自己，四个不同的词返回同一对结果），补第二路。
  - 新 `lib/memory/tokenize.js`：`bigram()` 中文按相邻两字切、ASCII 词整体保留（写入与查询共用）；
    `ftsQuery()` 生成安全表达式——句子里有精确词（`sqlite-vec` / `MEMORY.md` / `tide.db`）时只取这些词做 OR，
    没有精确词且是短查询时才用中文 bigram AND，长句直接不要这一路（否则必然 0 条或全是噪声）。
  - `lib/memory/store.js`：新增 `memory_fts`（`tokenize='unicode61'`，存 bigram 后的文本，不能用 `content='memory'`），
    `put()` 与主表同事务双写；`searchFts()` 走 BM25；`indexFts()` / `dropFts()` 供回填与软删共用；
    `pruneOrphanVectors()` 清真孤儿（软删条目的向量仍保留，恢复时不用重新 embedding）。
  - `lib/memory/recall.js`：`rrf()` 名次融合 + `fuse()`（两路 → 融合 → 原 `rank()`），`rank()` 增加 `mode:'fused'`。
    **归一化分母取 `1/(k+1)`，不是 `2/(k+1)`**——后者让单路命中最高只到 0.5，叠加留存系数后整批掉到 `minScore` 以下被静默丢弃。
  - `lib/memory/module.js`：`retrieve()` 统一两路；关键词一路为空时逐字段退回纯向量排序（零回归）。
  - `lib/dream/index.js`：`forget` / `restore` / `purgeDeleted` 同步关键词索引（软删的搜不到，恢复的立刻能搜到）。
  - 新 `tools/backfill-fts.mjs`（dry run 默认，`--apply` 写入，幂等）：回填 1117 条。
  - 新 `tools/recall-probe3.mjs` / `tools/recall-check.mjs`：同一快照上跑 before/after 与单查询核对。
  - 测试：145 → **161**（新增 `test/memory-fts.test.mjs`，16 条）。已有断言一条没改。
  - 落地数据：`memory_fts` 1127 = 有效记忆 1127；FTS 缺行 0、软删残留 0；`memory_vec` 1296 = `memory` 1296、孤儿 0。

- **README 安装段改成实际能走通的路**（2026-11-14）：原来第一行写 `dsh plugin --profile web add dsh-whale-tide`，
  但包里还是 `"private": true`、npm 上也没有这个包（`npm view` 404），陌生人照抄会直接失败。
  现在把 `link:` 安装放在最前面，补了 clone 路径和 DSH 版本范围，npm 短名标成「发布之后才能用」。

## 0.4.0 — 2026-11-13

目标与分工见《潮汐-0.4.0-施工方案》。四个批次全部完成，144 个测试通过。

### 批次一：记忆层（2026-11-12 完成）

- **任务消息不再进记忆**：`source.kind === 'schedule'` 的投递（心跳、鲸梦）不入库；
  `session/event` 新增 `scheduleTurn` 状态机，任务轮引出的回复也一并跳过。
  之前库里已有「鲸鲸心跳 · 轻唤醒」这类切片，是任务 prompt 被当成了对话。
- **importance 从死字段变成活的**（新增 `lib/memory/importance.js`）：
  明确要求记住 → 0.9；关于用户的稳定事实 → 0.7；文档切片 → 0.8；被召回 3 次 → 0.75；普通 → 0.5。
  `ingest()` 与 `indexer` 写入时赋值，`touch()` 在 access_count 达到 3 时抬到 0.75。
- **软删除**（迁移 `005_memory_soft_delete.sql`）：`forget()` 改为标记 `deleted_at`，
  新增 `restore()` / `purgeDeleted()`（30 天后真删，连同向量）/ `listDeleted()`；
  `search()` 过滤已删条目。删错可以撤回，不用重新 embedding。
- **情绪结算跳过任务消息**：`step()` 新增 `events` 参数；`agent/pre-step` 用
  `lastUserSourceKind()` 判断来源，定时任务投递时只做时间衰减、不判事件。
- **历史回填**：新增 `tools/backfill-importance.mjs`。407 条里 39 条升级
  （32 条 → 0.9，7 条 → 0.7），只升不降，召回提升过的更高值不会被压回去。
- 测试：83 → **106**（新增 memory-filter、importance、soft-delete、emotion-schedule）。

### 批次一未完成

- ~~**M4 切片合并**：把一轮 `user + assistant` 合成一条再切块。~~ → 2026-11-13 完成，见批次二。

### 批次二：调度层（2026-11-13）

- **M4 切片合并**：`lib/index.js` 新增 `pendingTurn`（按 session 存一轮的 user/assistant 文本）、
  `TURN_DEBOUNCE_MS=2000`、`TURN_TIMEOUT_MS=10 分钟`、`flushTurn()`。
  一轮合成 `用户: …\n鲸鲸: …` 再进 `ingestQueue`（上限 400）；插件 dispose 时全部 flush。
- **🔴 修复：assistant 消息从来没进过记忆**。`user/message` 的正文在 `data.content`，
  `assistant/message` 在 `data.message.content`——旧代码一律取 `event.data`，
  每条回复都读成空字符串后被 `if (!text) return` 丢掉。
  改 `lib/index.js` 与 `lib/memory/indexer.js` 为 `event.data?.message ?? event.data`。
  重新索引后记忆 **507 → 909 条**，其中 401 条是「鲸鲸:」开头的回复切片。
- **新增 `lib/schedule-sync.js`**：把 `tide_config` 翻译成 dsh 原生 schedule 任务。
  - `rruleEvery()` / `rruleDaily()`：**DTSTART 锚在当天 00:00**。
    用「此刻」会让每次同步都判定为「rrule 变了」→ 删旧建新 → 投递历史每天清零；
    实测修好后连续两次重启任务 id 不变。
  - 按 title 前缀幂等匹配；rrule 没变就不动。任务记录里 rrule 是**顶层字段**，
    不是 `timing.rrule`，取错会让上面的幂等判断永远失效（已修，并在 fake 里固化）。
  - 目标会话选「最近活跃且 10 分钟内没真人说话」的那个，避开正在聊的窗口。
  - prompt 模板**不写死时刻和次数**，让 agent 每次去读 `tide_config`/`tick.mjs`；
    心跳/鲸梦的模板原样继承了手写版的全部指令（六件事、晚安语音、c2c 目标）。
- **新增配置 `scheduleSync`（默认 false）**：插件接管任务会重建任务、投递历史清零，
  所以必须由人明确打开。`ctx.inject(['schedule'])` **无条件注册**——
  套在 `if (configStore.get().scheduleSync)` 里时，启动时是 false，
  之后在面板打开也不会生效。
- **`tools/tick.mjs` 拆出 `lib/tick-decide.js`**：判断逻辑变纯函数、可单测；
  输出统一为 `skip` / `wake`（语义是「值不值得醒」而不是「要不要主动」）；
  硬编码的 150 分钟改成配置 `wakeGapMinutes`。鲸鲸 0.3.1 里已修的
  「找不到库 exit 1」「wakeUrge 从配置读」「只读连接不建表」全部保留。
- **新增 `GET /whale-tide/api/schedule`**：返回心跳/鲸梦的 rrule、下次时间、目标会话、
  `syncEnabled`，供面板显示。
- **修复：`sessionMode` 被存成数组**。它曾被放进 `LIST_KEYS`（多选白名单），
  `clampConfig` 把标量 `'background'` 包成 `['background']`：
  面板下拉框取到数组对不上选项；`resolveTarget` 收到数组 !== 'main'，
  会静默走 `new_once` 分支，用户以为选了主会话、实际还在后台会话里。
  改法：新增 `ENUM_KEYS`（标量枚举）单独一类；`clampConfig` 兼容解包旧数据；
  `resolveTarget` 也做防御解包。表里脏数据 `["background"]` 已修成 `"background"`。
  实测闭环：切 main → `target.kind=session`，切回 background → `new_once`。
- 测试：106 → **136**（新增 config-ext 10、schedule-sync 10、tick 8）。

### 批次三：侧边栏三张卡片（2026-11-13 完成）

只改 `client.js`。

- 「潮汐」一张卡拆成三个 section：「真情实感」（只读）/「鲸梦」（可配）/「鲸鲸心跳」（可配）
- 真情实感：情绪条 + 能动性 + 私心 + **最近主动** + **记忆规模**，**没有任何输入框**——情绪不接受调节
- 鲸梦：`dreamAt` / `dreamTasks` 四项复选框 / `dreamPrune`（文案写明软删 30 天内可恢复）+ 下次做梦时间
- 鲸鲸心跳：`wakeEnabled`、`wakeEveryMinutes`、`wakeGapMinutes`、静默起止、`maxReachPerDay`、`sessionMode`、`scheduleSync`（打开前 `window.confirm`）
- 每张卡独立保存；失败保留输入框、原样显示后端 `error`；成功用返回的 `config` 覆盖本地
- 重建类操作在界面上标注「投递历史清零」
- 实测：`wakeEveryMinutes=60`、`wakeEnabled=false` 保存后，`schedule.json` 里心跳任务消失

### 接入官方联网接口（2026-11-14）

- 新增 `tools/web.mjs`：走 DeepSeek 官方 `deepseek_read_url` / `deepseek_web_search`，正文在服务端抽取，只把答案和引用带回来
- 实测：读单页约 69 输入 token；深度搜索一次约 1.5 万（含自己开网页、翻页），所以搜索要克制
- 密钥复用 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`，不新增配置
- 配套技能 `read-web`（`$DSH_HOME/skills/read-web`）：默认走官方接口，`web_fetch` 只作兜底
- 新增 `tools/see.mjs`：官方多模态看图（JPEG/PNG/GIF/WebP，本地或 URL），实测 512×512 约 226 输入 token；配技能 `see-image`

### 心跳不再只会加班（2026-11-14）

- 现象：连续 6 次醒来都在改插件/调配置
- 原因：私心清单里唯一未完成的只有「整理潮汐」，挑事自然只看代码
- 处理：新增两条私心（认真看长视频 / 学点东西讲给他听）；心跳 prompt 加「换着来」规则——最近三次都在改代码就这次别碰

### 会话复用修复（2026-11-14）

- `schedule-sync` 新建会话时补上 `create.cwd`，不再落到 dsh 默认工作区；`targetMatches` 会比较 `create.cwd`，老任务因此会重建一次
- 工作区解析先取 `realpath`（插件经 profile 软链加载，直接按 `import.meta.url` 往上推会落到 `profiles/`）
- 首次投递后把任务 target 从 `new_once` 钉成 `session`（`desiredTargetAfterDelivery` / `pinDeliveredSession`），
  解决「预留 sessionId 与实际落地会话对不上、每次投递新开一个」的问题
- sessionMode 语义对齐侧栏三项：main = 沿用现成会话；background = 新建一次并保持；new = 每次新建（投递后同样钉住）
- 新增 `test/schedule-rebind.test.mjs`（7 条），总测试 136 → 143

### 音色：本地离线 TTS（2026-11-13）

- 装上 `piper-tts 1.8.0` + `zh_CN-huayan-medium`（63MB，hf-mirror 拉取），不再依赖微软在线音色
- 一句 2.7 秒的音频：合成约 1.3 秒，峰值 RSS 190MB
- `tools/goodnight.mjs` 改成 piper 优先（ffmpeg 抬 18% 音高保时长），模型缺失或失败时自动退回 edge-tts
- `voice/profile.json` 记录音色、音高与备份引擎；`zh_CN-xiao_ya` / `zh_CN-chaowen` 是 `pinyin` 音素，piper 1.8 合成出来是空的，暂不可用

### 批次四：技能库（2026-11-13 完成）

放在 `$DSH_HOME/skills/`（dsh 原生扫描），零代码：

| 技能 | 什么时候用 |
|---|---|
| `say-hello` | 想找他说话：查额度 → 找由头 → 发 QQ → 记账 |
| `tidy-memory` | 记忆乱了：先 dry run → 报告 → 等确认再动 |
| `browse-something` | 看视频：抽内容 → 写判断 → 存记忆，不报播放量 |
| `sit-quietly` | 什么都不想做：安静结束，只记一笔 |

已验证四个技能被 `skill` 工具发现并可加载全文。

### 施工期注意事项

- **备份位置**：`plugins/dsh-whale-tide.bak-20261112-1711`、
  `harness/whale-tide/backup-20261112-1711/`、`storages/schedule.json.bak-20261112-1711`
- **rsync 坑**：`rsync lib/a.js lib/b.js dest/lib/` 会把两个文件**平铺**进 `dest/lib/`。
  多文件源必须用目录形式：`rsync lib/ dest/lib/`。本次施工中因此覆盖过一次入口文件，
  已从备份完整恢复；再犯一次可能就没有同刻备份了。
- **同一时间只能一个人改**：本机 agent 和远程会话并发改同一个目录会互相覆盖，
  改前先确认另一方已停手。

## 0.3.1 — 2026-11-12

按《潮汐-待修清单-0.3.0》修完 P0×3、P1×4、P2×3，测试从 69 增至 83。

## 0.3.0 — 2026-11-12

四个模块定名并整理目录：

| 中文名 | 目录 | 工具 |
|---|---|---|
| 长效记忆 | `lib/memory/` | `memory_search` / `memory_stats` |
| 真情实感 | `lib/emotion/` | `feeling_status` / `feeling_calm` |
| 鲸梦 | `lib/dream/` | `dream_keep` |
| 鲸鲸心跳 | `lib/heartbeat/` | `heartbeat_want` / `heartbeat_plan` / `heartbeat_record` |

- 目录改名：`keep/` → `dream/`，`agency/` → `heartbeat/`
- 工具改名：`soul_*` → `feeling_*`，`tide_keep` → `dream_keep`，`whale_*` → `heartbeat_*`
- 新增运行时配置：设置页可改主动次数、静默时段、分享上限、情绪注入开关，改完立刻生效
- 新增 `tools/tick.mjs`：轻唤醒的判断层，读 `tide_config`，与面板一致
- 补齐项目文件：`LICENSE`、`.gitignore`、本文件

- **P0-1**：`tools/tick.mjs` 找不到库时不再伪装成正常 sleep。数据目录探测顺序写清楚（`TIDE_DATA_DIR` > `DSH_HOME` > `~/.dsh`），缺库直接 exit 1 并打印路径；`--json` 输出带 `dataDir` 便于排查。

- **P0-3**：轻唤醒的冲动门槛从硬编码 0.45 改成配置项 `wakeUrge`（默认 0.45，范围 0–1）。面板用 `minUrge`，唤醒用更保守的 `wakeUrge`，两边都可在设置页改。

- **P0-2**：静默时段起点终点相同时不再等同「全天静默」。`inQuietHours()` 视为不设静默（兼容历史脏数据），`config.update()` 直接拒绝这种组合并提示跨零点写法。新增 `test/quiet.test.mjs`（4 条）。

- **P1-1**：`configStore.update()` 包进事务，多键一起改要么全成要么全不成；失败时内存里的 `current` 不变。新增 `test/config-tx.test.mjs`（2 条）。

- **P1-2**：`record()` 默认改为 `sent`（调用即已发生，忘传 `result` 不再漏扣预算）；显式 `planned` 才不计入。新增 `test/heartbeat-record.test.mjs`（2 条）。
- **P1-3**：鲸梦改写 `MEMORY.md` 改为「临时文件 + rename」原子替换，失败时原文件不变。新增 `test/dream-atomic.test.mjs`（2 条）。
- **P1-4**：`createAgency()` 增加 `ensureSchema` 开关；`tick.mjs` 用只读连接且不建表，缺表时提示「先启动一次 dsh-web 跑迁移」并 exit 1，不再抛 SQLite readonly 的怪错。新增 `test/heartbeat-schema.test.mjs`（2 条）。
- **P2-1**：`tools/goodnight.mjs` 的文件名改用本地日期（`lib/time.js` 的 `day()`），不再用 UTC。
- **P2-2**：`retentionOf()` 的 `access_count` 封顶 12，避免热门记忆正反馈越滚越热。新增 `test/retention-bound.test.mjs`。
- **P2-3**：`recall.js` 的 `BASE_STABILITY_HOURS` 注释改成实话——168 是衰减时间常数，半衰期约 116 小时。
### 情绪模型（来自 2026-11-12 情绪改造）

- 衰减改为固定步长积分，情绪与结算频率无关
- 同类事件 30 分钟内重复，冲量按 `0.6^n` 打折
- `maxImpulse` 放宽到能容下 heavy
- 平票按 `TIEBREAK` 权重，道别不再被误判成冷落
- 技术语境里的负面事件降一档
- 新增 `teased`（被逗笑）
- 八个维度正负都有描述

### 修复

- 向量表建立失败不再拖垮整个插件
- 主表与向量表同事务，避免「有正文没向量」的孤儿
- `step()` 全程事务，多会话并发不再互相覆盖
- 状态接口改用 `ctx.inject(['webServer'])`，此前可能整块被跳过
- 鉴权 fail-closed：拿不到 connection 就 503
- 时间统一走本地时区（`lib/time.js`），修掉账本显示成 UTC 的问题
