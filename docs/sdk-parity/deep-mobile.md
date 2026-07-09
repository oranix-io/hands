# 移动端深度监控对比：Sentry 机制 vs Hands SDK 现状

任务 #120 追加深挖（2026-07-09）。逐机制对比 Sentry Android / Apple SDK 的实现深度
与 Hands Android / iOS / OHOS SDK 的现状，给出差距分级：

- **关键** — 不做就无法回答"这个版本崩不崩/卡不卡"这类核心问题
- **重要** — 明显提升定位效率或数据可信度，应排入近期路线
- **可后置** — 有价值但依赖前置能力（sessions/tracing），先欠着
- **不追** — 与 Hands 定位（崩溃 + 反馈 + 分发）不匹配，或投入产出不成立

Sentry 侧结论均已对照 docs.sentry.io / develop.sentry.dev 核实（见文末来源）。
Hands 侧结论来自同日源码审计（[android.md](android.md) / [ios.md](ios.md) /
[ohos.md](ohos.md)）。

---

## 1. Android

### 1.1 ANR 检测

**Sentry 机制**：双轨。
- **v1（watchdog，Android < 11）**：SDK 内起看门狗线程，主线程阻塞超过
  `anrTimeoutIntervalMillis`（默认 5s）即上报 `mechanism:ANR`。官方自述"基于启发式、
  误报较多"，但能在 ANR 现场拿到截图/事务上下文。
- **v2（ApplicationExitInfo，Android 11+，现为默认）**：下次启动时读系统
  `ApplicationExitInfo`，异步上报 `mechanism:AppExitInfo`；只有
  `getTraceInputStream()` 非空（即系统真实生成了线程转储）才上报，天然只统计
  **致命 ANR**（导致进程被杀的），误报极低。最近一条会补挂 breadcrumbs/tags 等
  scope 数据；`setReportHistoricalAnrs` 可回捞历史 ANR
  （`mechanism:HistoricalAppExitInfo`）；`isAttachAnrThreadDump` 把系统线程转储
  作为附件上传。前后台 ANR 分开统计；8.35+ 对"纯系统帧堆栈"的 ANR 做静态指纹
  归并降噪。

**Hands 现状**：完全没有 ANR 检测。有 JVM 崩溃时的全线程转储能力（说明拿主线程
堆栈的基础设施已在），但没有 watchdog，也没读 `ApplicationExitInfo`。

**差距：关键**。ANR 是 Android 上仅次于崩溃的稳定性信号，且 Google Play 以 ANR 率
作为上架质量红线。ANRv2 路线对 Hands 极其友好：minSdk 24 但主力设备基本都是
Android 11+，"下次启动读 `ApplicationExitInfo` + 上传系统 trace 文件"与 Hands 现有
store-then-send 架构（写盘、下次启动上传）完全同构，不需要任何常驻监控线程。
建议直接抄 v2、跳过 v1 watchdog。

### 1.2 Native 崩溃（NDK / tombstone）

**Sentry 机制**：`sentry-android-ndk` 打包 `sentry-native`，底层可选
breakpad/crashpad 后端生成 **minidump**，信号处理链可配
（`ndkHandlerStrategy` 决定与宿主已有 handler 的先后）；scope（breadcrumbs、
tags、user）会同步到 native 层，崩溃报告里带上。符号化依赖 Gradle 插件自动上传
`.so` 调试符号。8.32+ 新增 **Tombstone Integration**：直接经
`ApplicationExitInfo` 读系统墓碑文件，作为 NDK 集成的替代或补充。

**Hands 现状**：自研 `handscrash`（信号 ILL/TRAP/ABRT/BUS/FPE/SEGV），
async-signal-safe 写 `.qnc`：信号、故障地址、**原始 PC 帧 + /proc/self/maps**，
非 minidump。服务端凭 maps + so 符号可以解，但只有崩溃线程的 PC 链，没有寄存器
全景/所有线程/内存片段。

**差距：重要（非关键）**。Hands 已能捕获并解出主干堆栈，缺的是深度而不是有无。
两条低成本增量：(a) 学 Sentry 8.32 的 tombstone 路线——Android 11+ 用
`ApplicationExitInfo.getTraceInputStream()`（REASON_CRASH_NATIVE）把系统墓碑
整文件带回，系统墓碑天然含全线程/寄存器/fd 表，比自己扩 `.qnc` 便宜得多；
(b) 崩溃时把 JVM 侧 scope（设备上下文已有）合并进 native 报告。上 crashpad/
minidump 属于大重构，可后置。

### 1.3 App Start（冷/热启动插桩）

**Sentry 机制**：冷启动 = 进程新建；热启动 = 其余（含后台返回、Activity 重建）。
起点取进程 fork 时间（API 24+）或 `SentryPerformanceProvider` 创建，终点为首帧；
产出 `app.start.cold` / `app.start.warm` span，挂在首个 `ui.load` 事务上；只统计
前台启动。配套 TTID（`ui.load.initial-display`，自动）与 TTFD
（`ui.load.full-display`，需 `reportFullyDisplayed()` 手动收口，25s 超时判
DEADLINE_EXCEEDED）。

**Hands 现状**：无任何性能插桩，也无事务/Span 模型。

**差距：可后置**。价值真实（启动耗时是移动端第一性能指标），但它依赖 trace/span
数据模型与后端聚合，Hands 当前连 sessions 都未闭环。若想先给个粗指标：在 SDK init
时记进程启动到首帧的单个标量，随 24h ping 或 session 上报，不建 span 体系——
够画启动耗时分布，成本 1/10。

### 1.4 慢帧 / 冻结帧 / Frame Delay

**Sentry 机制**：慢帧 = 渲染超过帧预算（60fps 即 16ms）；冻结帧 = 渲染 > 700ms；
Frames Delay = 用户感知的总延迟时长（例：60fps 下两帧各花 20ms → delay =
2×(20-16) = 8ms）。指标挂在 Activity 事务上（Android 7+），在 Mobile Vitals 面板
按屏幕聚合。

**Hands 现状**：无。

**差距：可后置**。同 1.3，依赖事务体系；且帧指标离"崩溃 + 反馈"主线最远。
在 sessions 与 ANR 落地前不动。

### 1.5 用户交互事务 + Activity/Fragment 自动插桩

**Sentry 机制**：Activity 生命周期自动开 `ui.load` 事务（onCreate 前开始、首帧后
结束）；Fragment 作为子 span；用户交互（点击/滚动/滑动）开 `ui.action.*` 事务，
命名 `Activity.view_id`，idle 3s / deadline 30s 自动收口；Compose 需
`Modifier.sentryTag()` 或编译器插件。另有 OkHttp / Room / File I/O 的字节码级
span 插桩。

**Hands 现状**：无。

**差距：不追（作为事务）/ 可后置（作为面包屑）**。完整 UI 事务体系是 Sentry
tracing 产品的一部分，Hands 不做 APM，不值得追。但其中一个子集非常值得借：
把 Activity 生命周期与点击事件记成**面包屑**（breadcrumbs 本身已是 Hands P1 项），
崩溃/ANR 报告里"用户最后点了什么、在哪个页面"是排障第一问。

### 1.6 出错截图 + 视图层级附件

**Sentry 机制**：`attachScreenshot`（opt-in，明确因 PII 风险）：错误/崩溃事件
best-effort 抓屏，2 秒去抖，`BeforeCaptureCallback` 可按事件级别过滤；运行时若
没有 replay 的 masking 模块则**整体跳过**以防泄敏。`attachViewHierarchy`
（opt-in）：view 树 JSON（alpha/visible/x/y/w/h/type/id），同样 2 秒去抖，
服务端有树状 + 线框交互查看器。

**Hands 现状**：无截图、无视图层级。但反馈工单链路已有 ≤200MB 附件通道。

**差距：重要**。对 Hands 是顺势能力：附件管道现成，服务端只需存展。优先做在
**反馈工单**上（用户主动提交，无 PII 顾虑，价值最高），其次才是 crash 事件的
自动抓屏（需要 masking 方案，谨慎）。view hierarchy JSON 成本极低，可与截图同批。

---

## 2. iOS / Apple

### 2.1 崩溃捕获内核（Mach 异常 + 信号 + KSCrash 血统）

**Sentry 机制**：内核是 **SentryCrash**——KSCrash 的源内 fork。同时挂
**Mach 异常端口**、BSD 信号处理器、C++ terminate handler、NSException
uncaughtExceptionHandler 四层；崩溃路径全程 async-signal-safe（不 malloc、
不发 ObjC 消息），报告写盘、**下次启动**反序列化后补 scope 再发送。Mach 层能接住
纯信号处理器接不住的场景（如栈溢出时信号处理器自身没栈可用——Mach 异常在独立
线程处理）。

**Hands 现状**：仅 NSException handler + BSD 信号处理器；只抓**崩溃线程**且
≤64 帧；带 binary images 供服务端 dSYM 符号化（解析器未建成）。无 Mach、无
C++ terminate、无全线程转储。

**差距：关键**。两点实质缺口：(a) 无 Mach 异常层意味着一类崩溃（栈溢出、部分
EXC_BAD_ACCESS 形态）整体漏采；(b) 只有崩溃线程堆栈，主线程死锁类问题看不到
全景。自研补齐 Mach + async-signal-safe 全线程回溯的工程量非常大（这正是 KSCrash
存在的理由）；务实路线是评估直接引入/裁剪 KSCrash（MIT），Hands 只做报告格式
与上传层。同时优先把服务端 dSYM 解析器建起来——现在客户端已上报 binary images
却无人消费。

### 2.2 Watchdog Termination（0x8badf00d 类）

**Sentry 机制**：纯启发式，8.0 前叫 "Out of Memory tracking"。原理是下次启动时
**排除法**：上次运行不是崩溃、没接调试器、非模拟器、系统/应用没升级、不是用户
手动杀、不是 App Hang——全部排除后判定为 watchdog 终止（含 OOM 与
0x8badf00d 超时被杀，SDK 无法区分二者，故改名）。因为系统杀进程不给任何通知，
**拿不到堆栈**；breadcrumbs 靠平时追加写盘的文件在下次启动时恢复。
`enableWatchdogTerminationTracking` 控制开关。

**Hands 现状**：无。iOS SDK 不做任何"上次为何退出"的推断。

**差距：重要**。OOM/看门狗被杀在重 App 上占非崩溃退出的大头，且用户感知等同
闪退。实现成本低（一个启动状态机 + 几个持久化标记位），不需要新采集面；难点只在
排除法的每个分支都要做对，否则误报（Sentry 也承认这是启发式）。建议在 sessions
落地时一并做——session 的 abnormal 终态与 watchdog 判定共享同一套"上次运行
状态"存储。

### 2.3 App Hangs（v1 / v2）

**Sentry 机制**：`io.sentry.AppHangTracker` 线程周期性向主线程投递工作项，超时
（`appHangTimeoutInterval` 默认 2s，判定窗口 7.24 起为 1.2×）未执行即为 hang。
**v2（9.0 起默认）**区分 **Fully Blocked**（一帧都渲染不出）与 **Non Fully
Blocked**（还能渲染少量帧），并报告**实际卡顿时长**；hang 期间被用户/看门狗杀掉
则下次启动报 **Fatal App Hang**。已知限制：主线程忙于多处代码时堆栈可能采偏。

**Hands 现状**：无。

**差距：关键**。与 Android ANR 同一优先级——卡死是移动端第二大稳定性信号，
且 Fatal App Hang 与 2.2 的 watchdog 判定互为兄弟（Sentry 明确把 hang 从
watchdog 排除法中拆出来单报）。最小实现：单看门狗线程 + 主线程 ping + 采样
全线程堆栈，先做 v1 语义（有/无 hang），时长与 blocked 细分后补。

### 2.4 MetricKit 集成

**Sentry 机制**：`enableMetricKit` 接入 MXMetricManager，消费
**MXHangDiagnostic / MXCPUExceptionDiagnostic / MXDiskWriteExceptionDiagnostic**
三类系统诊断（iOS 15+ 才即时投递，故设此下限），转成 Sentry 事件
（mechanism `mx_hang_diagnostic` 等）；`enableMetricKitRawPayload` 可附原始
JSON。堆栈完整度参差，官方建议不满意就 beforeSend 过滤。

**Hands 现状**：无。但已有 diagnostics-provider 文件附件钩子——宿主可塞任意
诊断文件。

**差距：重要，且是性价比最高的一项**。MetricKit 是苹果官方免费数据源：不用自己
起任何监控线程就能拿到系统视角的 hang / CPU 异常 / 磁盘写异常（含系统采的调用
树）。对 Hands 尤其合适：在 2.3 自研 hang 检测成熟前，MetricKit 可以先把 hang
可见性从 0 拉起来。实现是薄适配层（订阅 + payload 转发），甚至可先走现有
diagnostics-provider 通道原样上传 JSON、服务端解析。

### 2.5 App Start / TTID / TTFD / 帧指标 / 预热启动

**Sentry 机制**：把启动切成五个 span（Pre Runtime Init → Runtime Init →
UIKit Init → Application Init → Initial Frame Render），挂到首个 `ui.load` 事务
（>5s 则丢弃防污染）。iOS 15+ 系统**预热**（`ActivePrewarm`）会使"进程创建时间"
失真，SDK 检测到预热则裁掉前两个 span、改从用户点图标起算，并打
`cold.prewarmed` / `warm.prewarmed` 标。TTID 自动、TTFD 手动
（`reportFullyDisplayed()`，30s 超时）。慢帧/冻结帧同 Android 定义，经
CADisplayLink 统计。UIViewController 自动开 `ui.load` 事务。

**Hands 现状**：无。

**差距：可后置**。同 1.3/1.4：依赖事务模型。唯一值得现在记下的教训是
**prewarming 陷阱**——将来做启动耗时哪怕是标量版，也必须检查
`ActivePrewarm` 环境变量，否则冷启动数据整体虚高到不可用。

### 2.6 截图 + 视图层级（iOS）

**Sentry 机制**：与 Android 对称（`attachScreenshot` / `attachViewHierarchy`，
opt-in，去抖）。崩溃事件本身抓不了（进程正在死），主要覆盖错误/hang 类事件。

**Hands 现状**：无。

**差距：重要**。同 1.6，随反馈工单先行。

---

## 3. 双端共性

### 3.1 离线缓存（envelope 落盘重发）

**Sentry 机制**：所有遥测统一打包为 envelope，先写 `cacheDirPath` 再发；
`maxCacheItems`（默认 30）超限删最旧，且删除前会把其中的 session 迁移到下一个
envelope 以保 release health 统计完整；离线时下次启动补发。

**Hands 现状**：崩溃链路本就是 store-then-send（这点方向正确且与 Sentry 同构），
但**保留数 5**且仅覆盖崩溃；反馈/统计不走此通道；没有"删除时保护会话统计"之类
的完整性语义。

**差距：重要**。不是从 0 到 1，而是把崩溃专用的落盘队列泛化成 SDK 统一出口
（崩溃、ANR、session、未来的 hang 全走一个盘上队列），保留数提到 ~30，并在
session 数据加入后实现"驱逐不丢会话计数"。这是 3.2 的地基。

### 3.2 会话跟踪（30s 前后台阈值）

**Sentry 机制**：`enableAutoSessionTracking` 默认开。进前台开 session，退后台
超过 `sessionTrackingIntervalMillis`（默认 **30s**）判定 session 结束；30s 内
回前台算同一 session。终态四种：healthy / errored（有 handled error 但正常退出）/
crashed（未处理崩溃）/ abnormal（SDK 无法判断是否体面退出——OOM、被杀等落
此桶）。session 随 envelope 上报。

**Hands 现状**：SDK 无 session 概念（只有 24h 设备 ping）。服务端 sessions
端点**刚上线**，SDK 挂钩未做。

**差距：关键（当前第一优先级）**。没有 session 分母，crash-free rate 无法计算，
所有稳定性指标都是绝对数而非比率，跨版本不可比。服务端已就绪，SDK 侧就是
生命周期钩子 + 30s 计时器 + 崩溃标记回写（下次启动把上个 session 改判
crashed/abnormal）。注意 abnormal 桶要与 2.2 watchdog / 1.1 ANRv2 的"上次退出
原因"共享判定，否则口径打架。

### 3.3 Release Health 指标（服务端/UI）

**Sentry 机制**：crash-free sessions %（区间内未以崩溃结束的 session 占比）、
crash-free users %（未遇崩溃的独立用户占比）、adoption 阶段（Adopted ≥10%
session 量 / Low Adoption / Replaced，6 小时滚动窗口每小时更新）、活跃用户
（24h 内启动过）、session 时长分布。

**Hands 现状**：服务端 sessions 端点已通，聚合指标与 UI 未建。

**差距：关键（随 3.2 联动）**。Hands 的差异化是"发布平台自带质量门禁"：
crash-free rate × 现有**灰度放量**（hash bucketing）= "崩溃率超阈值自动停止
放量"，这是 Sentry 做不到的组合（Sentry 无分发能力）。指标口径直接抄 Sentry
定义即可，别自创。

### 3.4 OOM / 异常退出全景

**Sentry 机制**：iOS 走 2.2 的 watchdog 启发式（OOM 与超时被杀合并上报）；
Android 走 `ApplicationExitInfo`，exit reason 天然区分 ANR / CRASH /
CRASH_NATIVE / LOW_MEMORY 等。

**Hands 现状**：两端均无"上次为何退出"的任何推断。

**差距：重要**。Android 侧做 1.1 时顺手就有（同一个 API 的不同 reason 分支）；
iOS 侧即 2.2。

---

## 4. 移动端 Session Replay

**Sentry 机制**：Android / iOS 原生 + React Native + Flutter 均已 GA。实现是
**每秒一次的视图层级快照 + 同帧截图**（非录像；屏幕无变化不抓），Android 提供
PixelCopy（默认，开销低、遮罩可能错位）与 Canvas（实验，遮罩可靠、开销略高、
不支持细粒度遮罩配置）两种策略。隐私默认极激进：**所有文本、图片、输入默认
遮罩**，"敏感数据不出设备"。采样双旋钮 `sessionSampleRate` /
`onErrorSampleRate`（错误触发型回溯缓冲 1 分钟）。性能口径为"对多数应用终端
用户无感知"，但官方自己标注测试"并不彻底"、复杂应用可能受影响。

**Hands 现状**：无，三端皆无。

**差距：不追（本阶段）**。理由：(a) 工程量是本清单里最大的（逐帧抓取、端上
遮罩引擎、录像回放服务端）；(b) 强 PII 敏感，Hands 的 To B 分发场景（含华为
生态客户）对"抓用户屏幕"极其保守；(c) 其 80% 排障价值可用 1.6/2.6 的
"错误时单张截图 + view hierarchy"以 5% 成本获得。保留观察，等崩溃/会话/卡顿
三大件闭环后重估。

---

## 5. OHOS 快评

OHOS SDK 仅 ArkTS `errorManager`（JS 未捕获异常），上表所有机制均缺。但鸿蒙
系统侧有现成对应物，追赶路径与 Android ANRv2 同构（读系统数据而非自建监控）：
`hiAppEvent` 订阅系统 APP_CRASH / APP_FREEZE（≈ANR）/ RESOURCE_OVERLIMIT
（≈OOM）事件，`faultLogger` 拉取 native 崩溃与冻结日志。优先级：hiAppEvent
订阅（关键，等效于一次拿到崩溃+卡死+OOM 三件套）> session 钩子（关键，随 3.2
三端同做）> 其余可后置。

---

## Top-5 借鉴清单（按投入产出排序）

1. **会话跟踪 SDK 钩子（三端）** —— 前后台 + 30s 阈值 + 崩溃回写，照抄 Sentry
   四终态口径；服务端已就绪，这是解锁 crash-free rate 和"灰度自动熔断"的唯一
   阻塞项。（对应 3.2/3.3）
2. **Android ANRv2：`ApplicationExitInfo` 消费器** —— 下次启动读 exit reasons +
   `getTraceInputStream()` 附系统 trace；一个 API 同时拿到 ANR、native 崩溃
   墓碑（1.2 的 tombstone 路线）和 LOW_MEMORY，零常驻开销，与 Hands
   store-then-send 架构天然契合。（对应 1.1/1.2/3.4）
3. **iOS MetricKit 薄适配** —— `MXMetricManager` 订阅 hang / CPU / 磁盘写诊断，
   先经现有 diagnostics-provider 通道上传原始 JSON；以最小成本把 iOS 卡顿
   可见性从 0 拉起，为自研 App Hangs 争取时间。（对应 2.4/2.3）
4. **iOS 崩溃内核补强** —— 评估引入 KSCrash（或裁剪版）补 Mach 异常层 + 全线程
   async-signal-safe 转储；同期把服务端 dSYM 解析器建成（客户端 binary images
   已在白白上报）。（对应 2.1）
5. **错误/反馈截图 + view hierarchy 附件** —— 复用现有 200MB 附件管道，抄
   Sentry 的 opt-in + 2s 去抖 + before-capture 过滤模型；先反馈工单后崩溃事件。
   这是对 Hands"反馈强于 Sentry"这一护城河的直接加固。（对应 1.6/2.6）

---

## 来源（均于 2026-07-09 核实）

- Sentry Android ANR: <https://docs.sentry.io/platforms/android/configuration/app-not-respond/>
- Sentry Android 自动插桩（App Start/TTID/TTFD/交互/Activity/Fragment）: <https://docs.sentry.io/platforms/android/tracing/instrumentation/automatic-instrumentation/>
- Sentry Android NDK / Tombstone: <https://docs.sentry.io/platforms/android/configuration/using-ndk/>
- Sentry Android 截图 / 视图层级: <https://docs.sentry.io/platforms/android/enriching-events/screenshots/> · <https://docs.sentry.io/platforms/android/enriching-events/viewhierarchy/>
- 慢帧/冻结帧/Frames Delay 定义: <https://develop.sentry.dev/sdk/telemetry/traces/frames-delay/> · <https://docs.sentry.io/product/insights/mobile/mobile-vitals/>
- Sentry iOS App Hangs (v1/v2/Fatal): <https://docs.sentry.io/platforms/apple/guides/ios/configuration/app-hangs/>
- Sentry iOS Watchdog Terminations: <https://docs.sentry.io/platforms/apple/guides/ios/configuration/watchdog-terminations/>
- Sentry iOS MetricKit: <https://docs.sentry.io/platforms/apple/guides/ios/configuration/metric-kit/>
- Sentry iOS 自动插桩（启动 span/预热/TTID/TTFD/帧）: <https://docs.sentry.io/platforms/apple/guides/ios/tracing/instrumentation/automatic-instrumentation/>
- SentryCrash/KSCrash 与信号处理: <https://develop.sentry.dev/sdk/platform-specifics/native-sdks/signal-handlers/> · <https://github.com/getsentry/sentry-cocoa>
- 会话跟踪 / Release Health: <https://docs.sentry.io/platforms/android/configuration/releases/> · <https://docs.sentry.io/product/releases/health/>
- 离线缓存: <https://docs.sentry.io/platforms/android/configuration/options/>
- 移动端 Session Replay: <https://docs.sentry.io/product/explore/session-replay/mobile/> · <https://docs.sentry.io/platforms/android/session-replay/>
