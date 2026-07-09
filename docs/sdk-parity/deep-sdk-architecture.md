# Sentry SDK 架构深度对比：数据管线与 Hands SDK 差距分析

> 依据 docs.sentry.io 与 develop.sentry.dev 官方文档核实（2026-07）。
> Hands 现状来自四端（Android / iOS / OHOS / Electron）源码审计：无 scope/hub、无 beforeSend、除崩溃文件（保留 5 份、下次启动上传）外无信封/离线队列、无 client reports、无采样、无限流处理、配置极简（baseUrl / appSlug / channel / clientKey）、feedback 与 metrics 发后即忘、24h 节流设备 ping。Electron 额外有 setUser / setTag / setExtra / addBreadcrumb（仅写入 Crashpad 崩溃注解）。
>
> 严重度标尺：**关键** = 影响数据可靠性/合规，应尽快补；**重要** = 明显提升质量或为后续能力铺路；**可后置** = 有价值但依赖前置能力或量级；**不追** = Sentry 场景特有，Hands 不需要。

---

## 1. Scope 模型（Hub → 三层 Scope）

**Sentry 怎么做**：v8+ 用三层 scope 取代旧 Hub：Global Scope（进程级单例，存 release/environment 等全局数据）、Isolation Scope（一次执行单元——服务端一个请求、移动端一次用户会话，靠 thread-local/async-local 自动隔离）、Current Scope（绑定当前 span 或 `withScope` 块，fork 时写时复制）。捕获事件时按 global → isolation → current 合并，越具体优先级越高。废弃 Hub 是因为异步隔离需手动 clone，三层模型让 fork 全自动，并与 OpenTelemetry Context 对齐。

**Hands 现状**：四端均无 scope/hub 概念。Electron 有 setUser/setTag/setExtra，但只落到 Crashpad 注解（只对崩溃生效），feedback/metrics 上报不带这些上下文；其余三端连全局上下文都没有。

**差距：可后置** — Hands 是低频、封闭场景，一个跨四端统一的"单层全局 context"（setUser/setTag 对所有上报生效）就够了；三层 scope 是为高并发服务端与异步 tracing 设计的，不必照搬。

## 2. 事件生命周期钩子（beforeSend / beforeBreadcrumb / Event Processors）

**Sentry 怎么做**：事件产生后依次经过 scope 数据合并 → event processors（scope 级 `scope.addEventProcessor` 只在该 scope 生效，全局 `Sentry.addEventProcessor` 全部生效，顺序不保证）→ `beforeSend` / `beforeSendTransaction`（保证最后执行，拿到最终事件）→ 传输层。任一环节返回 `null` 即丢弃事件；hint 参数携带 originalException 等原始对象。另有声明式过滤 `ignoreErrors`（字符串/正则匹配消息）与 `denyUrls`/`allowUrls`（按栈帧来源过滤）。beforeBreadcrumb 对每条面包屑同样可改可丢。

**Hands 现状**：四端均无任何发送前钩子。数据一旦采集直接出网，宿主 App 无法脱敏、无法降噪、无法按业务规则丢弃。

**差距：关键** — 这是隐私合规（脱敏）与降噪的最低门槛，实现成本极低（一个回调 + 判空），却是宿主 App 唯一的"最后拦截点"。

## 3. Integrations 插件架构

**Sentry 怎么做**：SDK 功能以 integration 为单元组装。默认集成自动启用（JS 端如 InboundFilters、Breadcrumbs、GlobalHandlers、HttpContext、Dedupe、LinkedErrors、FunctionToString、BrowserApiErrors），通过 `integrations` 数组增删改配置、传函数过滤默认集成、`defaultIntegrations: false` 全关，还支持 `lazyLoadIntegration` 按需从 CDN 加载以控制包体积。

**Hands 现状**：无插件机制，各端功能硬编码在 SDK 内部。

**差距：不追** — 插件架构服务于"通用 SDK 适配无数第三方库"的目标；Hands 场景封闭、功能面小，内部模块化即可，对外暴露插件 API 只会增加维护面。

## 4. Envelope 信封格式

**Sentry 怎么做**：所有上报统一为 envelope：换行分隔的格式，第一行是信封头（JSON，可含完整 DSN 实现自认证），其后交替出现 item 头（必含 `type`，建议含 `length`）与 payload。item 类型覆盖 event、transaction、session、attachment、client_report、profile、replay 等。一次 HTTP 请求可批量携带多类型数据 + 二进制附件，且信封本身就是磁盘落盘/多跳转发（SDK → Relay）的序列化单元。

**Hands 现状**：无统一封装。feedback、metrics、ping 各自独立 JSON 接口直发；崩溃文件是唯一落盘物，格式与在线上报完全不同。

**差距：重要** — 不必照抄 Sentry 信封，但"统一的上报封装 = 同一份序列化既能出网又能落盘重发"是做离线队列（见 §5）的前置设计；现在每种数据一个格式，队列和补发逻辑要写 N 遍。

## 5. 磁盘队列 / 离线缓存

**Sentry 怎么做**：移动端 SDK 把信封先写入磁盘缓存目录（Android `cacheDirPath`，`maxCacheItems` 默认 30 个信封），发送成功才删除；断网/进程被杀时数据保留，下次启动或网络恢复后补发。缓存满时删最旧信封，但会把其中的 session 迁移到下一个信封以保住 release health 数据；`shutdownTimeoutMillis`（默认 2000ms）控制退出前排空队列的等待时间。

**Hands 现状**：只有崩溃文件落盘（保留 5 份、下次启动上传）。feedback、metrics 全部发后即忘——请求失败即数据永久丢失，无重试、无落盘。

**差距：关键** — 移动端弱网是常态，fire-and-forget 意味着最需要反馈的场景（网络差、刚崩溃完）恰恰丢数据最多；这是 Hands 数据可信度的最大窟窿。

## 6. 限流处理（429 / X-Sentry-Rate-Limits）

**Sentry 怎么做**：SDK 检查每个响应的 `X-Sentry-Rate-Limits` 头，格式 `retry_after:categories:scope:reason_code`，可按数据类别（error/transaction/session/…）分别限流，空类别 = 全部；429 时回退到标准 `Retry-After`，两者都没有则默认退避 60 秒。被限流期间 SDK 停发对应类别并直接丢弃（同时记入 client report），限流状态按 DSN 在 transport 内维护，同类别取更长的限期。

**Hands 现状**：无任何限流响应处理。当前 fire-and-forget 且无重试，客户端不会形成重试风暴；但 24h ping 之外的 feedback/metrics 峰值对服务端毫无客户端侧保护。

**差距：重要** — 一旦补上磁盘队列 + 重试（§5），没有服务端限流协议就会把"补发"变成"打爆自己后端"的放大器；应与离线队列同期设计（一个 Retry-After + 按类别退避即可起步）。

## 7. Client Reports（SDK 自报丢弃）

**Sentry 怎么做**：SDK 把自己丢弃的数据以 `client_report` 信封项上报：`discarded_events` 数组，每项含 `reason`（ratelimit_backoff / queue_overflow / cache_overflow / sample_rate / before_send / event_processor / network_error / send_error / internal_sdk_error）、`category`、`quantity`。规范要求"谁丢弃谁记录上报"，通常搭车在其他信封里发送以省请求。这让服务端能回答"SDK 到底丢了多少数据、为什么"。

**Hands 现状**：无。丢了就是丢了，服务端与开发者都无从知晓丢弃量。

**差距：可后置** — 先有"会丢弃数据的机制"（采样、限流、队列上限）才有丢弃统计的意义；在 §5/§6/§9 落地后作为观测补充再做。

## 8. 背压管理（Backpressure）

**Sentry 怎么做**：服务端 SDK 内置背压监控：每 ~10 秒异步健康检查（队列是否将满、是否被限流），不健康时把 transaction 的有效采样率对半砍，`downsample_factor` 每 10 秒翻倍、最多 10 次（指数退避），恢复健康后回到用户设定的采样率；由 `enable_backpressure_handling` 开关控制。

**Hands 现状**：无，也没有高吞吐管线需要保护。

**差距：不追** — 这是为服务端高吞吐 tracing 设计的自保护；Hands 无 tracing、上报频率低（且 ping 已有 24h 节流），不存在该问题域。

## 9. 采样体系

**Sentry 怎么做**：三层客户端采样——`sampleRate`（错误事件，默认 1.0）、`tracesSampleRate` 或 `tracesSampler`（函数式，拿到 samplingContext 含事务名与 `parentSampled`，可按路由差异化采样，优先级 tracesSampler > 父决策继承 > tracesSampleRate，采样决策沿分布式链路传播）、profiles/replay 各有独立采样率。此外服务端还有 Dynamic Sampling：入站后按目标存储率对 span/transaction 二次智能采样（优先新版本、低量项目），UI 实时调整无需发版，但不作用于 error。

**Hands 现状**：无任何采样。所有端全量上报，唯一的量控是 24h 节流的设备 ping。

**差距：重要** — metrics 是 Hands 里唯一会随 DAU 线性膨胀的数据流，客户端采样率（哪怕只有一个全局 `sampleRate`，最好可由服务端下发）是量级增长后唯一不发版就能拉的成本阀门；服务端 Dynamic Sampling 不追。

## 10. 数据清洗与 PII

**Sentry 怎么做**：分层防御。客户端：`sendDefaultPii` 默认关闭——SDK 有意不采集 IP、cookie、请求体等 PII，开启需显式授权；beforeSend/beforeBreadcrumb 做定制脱敏。服务端：默认 scrubbing 自动打码 password/secret/信用卡等模式，Advanced Data Scrubbing 规则在持久化前二次脱敏，支持 sensitive fields / safe fields 配置，附件也有专门的 attachment scrubbing。

**Hands 现状**：无 PII 开关、无客户端脱敏钩子、无服务端清洗。设备 ping 与崩溃附件采什么就传什么、存什么。

**差距：关键** — 个保法/GDPR 语境下"默认不采 PII + 至少一层脱敏"是底线而非增强；崩溃日志和 breadcrumb 是最常见的 PII 泄露面，与 §2 的 beforeSend 一起做成本最低。

## 11. 会话与发布健康度（Sessions）

**Sentry 怎么做**：两种模式——application-mode（移动/桌面/浏览器，一次会话覆盖应用一次运行，逐条发送完整会话状态更新）与 request-mode（服务端每请求一会话，按分钟预聚合成计数再发）。生命周期 init → ok → exited/crashed/abnormal/unhandled，到达终态后不得再更新；自动会话跟踪在应用启动开始、退出结束，移动端后台超 30 秒可判定会话结束。由此得出 crash-free sessions/users 等发布健康度指标。

**Hands 现状**：无会话概念。24h 节流的设备 ping 只能当粗粒度 DAU 代理，无法回答"这个版本 crash-free 率多少"。

**差距：重要** — crash-free rate 是崩溃监控产品的头牌指标，而客户端实现很轻（启动发 init、退出/崩溃发终态，复用 §5 的队列保投递）；application-mode 一种就够，request-mode 不追。

## 12. 配置面与版本维度（release / environment / dist）

**Sentry 怎么做**：JS/Android 端 init 选项各约 60+，按核心 / 错误 / tracing / 会话 / 传输分组。三个版本维度贯穿全链路：`release` 建议 `project-name@version`（如 `my-app@2.3.12`），用于回归判定、suspect commit 与 source map/符号解析；`environment` 默认 `production` 区分部署环境；`dist` 进一步区分同一 release 的不同构建（如构建号），移动端用于精确匹配符号文件。

**Hands 现状**：4 个配置项（baseUrl / appSlug / channel / clientKey）。channel 勉强对应 environment 的一部分职责，无 release、无 dist，崩溃无法按版本聚合归因。

**差距：关键** — 没有 release/dist，崩溃去重、"哪个版本引入的回归"、符号表匹配都做不了；这是三个字段的成本，却决定后端一切聚合分析的粒度。配置总量不必追 60+，但 release/environment/dist + sampleRate + beforeSend 这一档必须有。

---

## 值得借鉴的前 5 个机制（按优先级）

1. **磁盘信封队列 + 启动/联网补发**（§5 + §4）— 统一上报封装先落盘、成功才删、崩溃与弱网不丢数，直接决定 Hands 数据可信度；崩溃文件已有的"下次启动上传"逻辑可推广为全数据类型通道。
2. **release / environment / dist 版本维度**（§12）— 三个字段解锁版本聚合、回归定位与符号匹配，是后端分析能力的地基，改动最小收益最大。
3. **beforeSend 钩子 + sendDefaultPii 默认关闭**（§2 + §10）— 一个回调加一个布尔开关，同时解决合规底线与宿主降噪，四端 API 形状统一即可。
4. **限流协议（429 / Retry-After / 按类别退避）**（§6）— 与队列重试同期设计，避免补发机制反噬后端；服务端只需会下发 Retry-After，客户端只需会尊重它。
5. **application-mode 自动会话跟踪**（§11）— 启动/退出/崩溃三个信号 + 后台 30s 超时判定，换来 crash-free rate 这一发布健康度头牌指标，复用 1 的队列即可保投递。

### 主要参考

- develop.sentry.dev：Hub & Scope Refactoring、Envelopes、Rate Limiting、Client Reports、Sessions、Backpressure（sdk/telemetry/traces/backpressure）
- docs.sentry.io：JavaScript Options / Filtering / Sampling / Integrations / Event Processors、Android Options、Data Scrubbing、Dynamic Sampling、Releases
