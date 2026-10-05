/**
 * dsh-host-goal-subagent-gate v0.2.1
 *
 * 宿主插件:会话**有在飞的子代理**时压住 goal 的自动续轮,等它们停下来再放行。
 *
 * ── 修的是什么 ────────────────────────────────────────────────────────────────
 * `dsh-goal-round-driver` 的驱动器在 agent 一进入 idle 就立刻开下一轮
 * (`dsh-goal-round-driver/lib/index.js:213-230` 的 `agent/status` listener → `requestDrive` → `drive`)。
 * 于是"把活全外包给后台子代理、自己立刻 idle"的会话会疯狂空转:实测一次会话 25 轮额度
 * 在 10 分 28 秒内烧完,其中 19 轮没有任何实质推进,最后目标被自动标成 blocked(code=round-limit)。
 * 本插件把"这一轮结束"的口径改成:**只有名下没有在飞子代理时,才允许下一次续轮注入**。
 *
 * ── v0.2.0 的判据修正(动机)──────────────────────────────────────────────────
 * v0.1.0 的"活跃子代理"判据其实是**"在活代理表里"**:`ctx.agents.list()` 里 owner 指向自己
 * 就算一个。改成"在飞"之后,判据问的是"这孩子**还有没有活要干**",而不是"它在不在表里"。
 *
 * ⚠ **因果诚实说明(重要,别把它当已证实的结论)**:诊断报告
 *   `.dsh/.project/diagnosis/goal-command-coordinator-20260929.md` §1d 把"0 轮"归因于
 *   "孩子已结算但仍驻留注册表",**这个因果没有被直接观测过**。按 dsh 自己的结算规则反推
 *   (`dsh-subagent:1201-1206` 的 `settlementState`:只有 `inbox.hasPending || ownedChildren.size > 0`
 *   才 `"wait"`,否则 `"ready"` ⇒ 立刻 dispose),一个**长期驻留**的孩子必然"在跑 / 有待办 /
 *   名下有孩子"—— 这三种在本插件的判据里**都仍然算在飞**。也就是说:本插件在协调者会话里能放开的,
 *   主要是"孩子已经没事、正在被 dispose"的那段窗口。**"0 轮"更可能的成因是报告 §3 自己给的那条**
 *   —— 会话常态就有在跑/待办的孩子,门本来就该关着。真要缩短等待,`maxHoldMs`(报告方案 B)才是
 *   直接杠杆。详见 README §3 末。
 *
 * 判据(`lib/gate.js` 的 `childInFlight`,证据链在它的文档注释里):
 *   **在飞 = ①`Agent.status === 'running'`(或读不到),或 ②inbox 还有排队消息(或读不到),或
 *            ③名下还有活着的后代(任意深度)。**
 *   ① 的依据:`status` 是 `dsh-agent` 的公开契约字段(`'idle' | 'running'`),实现是现算 getter;
 *      dsh 自己的 `runningDescendants()`(`dsh-subagent/lib/index.js:2268-2290`)用同一个字段;
 *   ② 的依据(**v0.2.1 / H1 补的**):`get status()` 把 `phase.kind === 'maintenance'` 也折叠成
 *      `'idle'`(`dsh-agent-loop:790-792`),而 maintenance 期间进来的活只置 `wakeRequested = true`、
 *      不改 status 也不 emit(`:854-858`),等 maintenance 结束才唤醒(`:841`)⇒ 只看 status 会把
 *      "马上还要干活的孩子"判成不在飞。读法照抄 dsh 自己的 `hasPending`
 *      (`dsh-agent-loop:88-91` / `dsh-subagent:684-686`);
 *   ③ 的依据:"有活后代 ⇒ 自己还没结算"由 dsh 自己的 `settlementState()` 保证;
 *   读不到一律**保守按在飞**处理 —— 绝不因"读不到"而误放行(误放行 = 空转烧额度,正是本插件要修的)。
 *
 * ── 机制(全部只用官方公开服务,不碰消息)────────────────────────────────────
 * ```
 *  父代理委派 → subagent/start ──→ **只登记**(定位 owner 供日志核对),绝不改 activation
 *
 *  让位标记 → session/event(turn/end:aborted,带 cause) ──┐
 *           → agent/inbox/discarded(goal 轮被丢弃) ───────┤ 记一次性标记:agentId → cause
 *            └→ 下一次 agent/status(idle) 消费它:跳过门控 + 丢 claim,让 driver 自己写 durable pause
 *
 *  父代理 idle → agent/status ──┐
 *   (prepend:true,抢在 driver 前面)├─→ 该代理名下有**在飞**子代理 ∧ goal 是 active+armed?
 *                               │      ├─ 是 → 记 claim + ctx.goals.disarm(agent)   [压住]
 *                               │      └─ 否 → 什么都不做
 *  看门狗(每 30s)──────────────┘   (gateCheck 自带"只压 idle 的代理"前置条件)
 *
 *  子代理结算 → subagent/end ────┐
 *  子代理摘除 → agent/disposed ──┤
 *  父代理状态变 → agent/status ──┼─→ 该 claim 名下还有**在飞**子代理吗?
 *  看门狗(每 30s)──────────────┘      ├─ 有 → hold(超过 maxHoldMs ⇒ 强制放行 + warning)
 *                                      └─ 无 → roundsStarted >= maxGoalRounds ?
 *                                               ├─ 是 → ctx.goals.block(code=round-limit)
 *                                               └─ 否 → ctx.goals.resume(ref)  [放行,自带重发]
 *
 *  闩锁复核(M1,v0.2.1):上面四条触发点**都**顺手比一次"当前在飞集合 vs 闩锁记下的那一批",
 *  不一样就当场作废闩锁 —— 否则"同一批孩子先停再跑"会让快照绕回原值,门对该目标静默失效。
 *  兜底放行之后 claim 已交还,所以这一比**不能挂在 claim 重算上**(那两处会因 CLAIMS.size===0 提前
 *  return),必须挂在 `agent/status` 上 —— 那是快照绕回原值之前唯一的观测点。
 * ```
 *
 * ── 为什么**只在 idle** 压住(绝不在 subagent/start 压)──────────────────────
 * 压住 = disarm = 把进程内 activation 翻成 disarmed。driver 的停车闸门全都以
 * `activation === "armed"` 为**前提条件**:
 *   · `turn/end` 的 aborted 分支(`dsh-goal-round-driver/lib/index.js:266-269`):本轮没有
 *     claimed/admitted 的预约时调 `disarm(state)`,而它自己是
 *     `if (currentGoal(state)?.activation === "armed") ctx.goals.disarm(...)`(`:87-93`);
 *   · 紧接着的 `agent/status` idle 分支(`:219-227`):靠 `goal.activation === "armed"` 才会写
 *     durable `pause` —— 这是"用户按了停止 ⇒ 目标停车"的唯一落点。
 * 插件若在父代理 **running 期间**先 disarm(旧的 subagent/start 路径正是如此),上面两条判据
 * 全部为假 ⇒ **用户 abort 不再产生 durable pause**;等孩子结算后本插件 `resume()`,目标又自己
 * 跑起来(现象:"我按了停止,它自己又跑起来")。max-tokens / agent/error 的 disarm 同样被吞
 * (`:262-264` 走的是同一个 `disarm(state)`)。
 * driver 只在 `status === "idle"` 时才开新轮(`readyToDrive` 要求 `status === "idle"`,`:79-81`),
 * 所以只在 idle 压住**完全够用**:running 期间 activation 一个字节都不碰 ⇒ 停车闸门完好。
 *
 * ── 让位标记:凡是能让 driver 的 attempt.cancelled 成真的路径都必须让位────────
 * 光"只在 idle 压住"还不够:被 abort 的那一轮若**已有 driver 预约**(attempt 处于 claimed/admitted),
 * driver 的停车动作发生在 **`agent/status` idle 那一次派发里**(`:219-227`),而本插件的门控 listener
 * prepend 在它前面(`cordis/lib/index.js:336` 的 unshift)⇒ 插件先 disarm,driver 那条
 * `goal.activation === "armed"` 判据随即为假 ⇒ durable pause 不写,孩子结算后本插件再 resume,
 * 目标自己续上 —— 等于插件推翻了"用户按停止 ⇒ 目标 durable pause"这条 driver 既定语义。
 * 所以凡是能让 driver 把预约标成 cancelled 的路径,插件都先记一个**一次性**的"让位标记",并在该
 * agent 下一次 `agent/status(idle)` 上**跳过门控并丢弃 claim**(不 disarm、不建 claim、不 recompute),
 * 把这次 idle 完整让给 driver:有预约 ⇒ 它写 durable pause;没预约 ⇒ 它自己的 `disarm(state)`
 * (`:266-269`)照常执行。这样的路径有两条:
 *   · `session/event` 的 `turn/end` + `reason.kind === "aborted"`(`:266-269`)。cause 是闭合联合
 *     `user` / `parent` / `disposed` / `hook`(`:731-745`)—— **只有 `user` 是"用户按停止"**,其余
 *     (父代理取消 / 会话销毁 / hook)一律按"叫停让位"措辞,免得日志误导排查;
 *   · `agent/inbox/discarded` 且被丢弃的消息 `source.kind === "goal" && source.round > 0`
 *     (`:205` 由 `ReactLoopInbox.mutate()` 逐条 emit;driver 在 `:249-252` 据此标 cancelled):
 *     `cancel()` **无条件** `inbox.clear()`(`:815-821`,只有 `keepInbox` 才跳过),而 `clear()` 就是
 *     两次 splice(`:93-96`)⇒ **idle 状态下被 cancel 时没有 turn、也就没有 `turn/end`**,这条是
 *     唯一的信号来源。判据与 driver 的 `isGoalRoundSource`(`:32-34`)同源,故意**不含 round === 0**
 *     (那是目标初始消息,丢弃它不代表取消某一轮)。
 * 标记用完即清(代理被摘除时也顺手清);中间可能夹着若干整轮(`kick()` 是 `while (await this.turn())`,
 * `turn()` 在 `inbox.hasPending` 时返回 true ⇒ 可连跑多个 turn 完全不经 idle),标记必须活过它们。
 *
 * 为什么是 disarm 而不是拦截消息(dsh-goal-round-driver 源码逐行核过):
 *   · `drive()` 开头就查 `goal.phase !== "active" || goal.activation !== "armed"` → 直接 return(`:124`),
 *     **disarm 后驱动路径整个不执行,也不会产生任何 blocked code**;
 *   · `disarm` 是**纯进程内**操作(`dsh-goal/lib/index.js:622-627`),不写会话、不改 phase/revision;
 *   · `resume` 会写一条 durable `goal/change`(operation=resume,revision+1)并 emit `goal/changed`
 *     → 命中 driver 的 `goal/changed` listener → `requestDrive` → 自动发下一轮(`:231-236`)
 *     ⇒ **放行自带重发路径,不需要本插件自己注入任何消息**;
 *   · `resume` 的 fold 约束(`:686-699`):phase ∈ {active,paused,blocked}、下一 phase=active、
 *     `roundsStarted` 不变且 `< maxGoalRounds` —— 所以额度用尽时 resume 必抛,必须改走 block。
 *
 * 明确**不做**的事(三条已证实有害的写法,一律不实现):
 *   · `agent/pre-step` reject 掉 goal 轮 → driver 会 durable block(code=prompt-rejected)(`:314-321`);
 *   · 用 `{kind:"enter", messages:[...]}` 摘掉 goal 消息、或从 inbox 丢弃 → 下一次 idle 被
 *     `ctx.goals.pause()` 打成 durable pause(`:219-227`)。
 *   本插件只动"进程内 activation"这一个开关,消息流一个字节都不碰。
 *
 * 为什么必须 `prepend: true`(`agent/status` 那条):`requestDrive` 是同步执行到 `agent.followup(message)`
 * 的(`:166-199` + `:153-154`),预约发生在 driver 自己的 listener 内、同一次事件派发中
 * ⇒ 后注册的 listener 抢不到,只有 prepend 能插到它前面。cordis 侧依据:`ctx.on(name, cb, {prepend})`
 * 走 `register()` 的 `unshift`(`@deepseek-ai/cordis/lib/index.js:335-345`)。
 *
 * 为什么事件监听一律 `global: true`:subagent 与 agent 事件都是**按作用域分发**的
 * (`dsh-subagent/lib/index.js:235-251` 的 carrier / `dsh-agent` 的 `scopeTarget(agent, agent)`)。
 * `global: true` 让 `hook.global || !filter || filter.call(...)` 直接短路放行
 * (`cordis/lib/index.js:258-264`),不依赖本插件 ctx 是否落在对方 filter 的子树里 —— 这是"能不能
 * 收到事件"这一条上唯一不靠推理的写法。同理,`agent/status` 用 `{prepend:true, global:true}`。
 *
 * ── 归属安全(不覆盖别人的 disarm)──────────────────────────────────────────
 * `goal/activation-changed`(`dsh-goal/lib/index.js:789-806`,payload `{sessionId, goal?:{id,revision,activation}}`)
 * 用来判断 activation 变化是不是本插件造成的:`selfAction > 0`(自置标志,包住每一次
 * disarm/resume/block 调用)期间的变化一律忽略;其余一律**丢弃 claim**(否则会覆盖 driver 因
 * max-tokens / agent/error / aborted 做的 disarm)。该事件在 projection 缺失时会提前 return
 * (`:794-796`)⇒ 必须有 claim 过期兜底,见下面的看门狗与 `maxHoldMs`。
 *
 * ── 安全兜底(硬要求:绝不出现"忘记 re-arm 导致目标永久停摆")────────────────
 *   1. `subagent/end` / `agent/disposed` / `agent/status` 每次都重算;
 *   2. 看门狗每 `watchdogIntervalMs`(默认 30s)重算全部 claim;
 *   3. claim 持有超过 `maxHoldMs`(默认 30min)仍未放行 ⇒ 记 warning 并**强制**放行;
 *      放行那一刻的 (goal 身份 + 子代理集合) 上**闩锁**(RELEASED):同一个 goal 的同一批孩子
 *      还活着就不再压回去 —— 否则兜底放行会被同一个门控判据当场撤销,变成 30 分钟一次的活锁;
 *      **换 goal(`/goal clear` 后新建)或集合一变,闩锁即作废**(否则新目标会命中旧闩锁短路,
 *      门控静默失效);
 *   4. 插件卸载/热重载时(disposer)尽力放行一次;放不掉的在日志里点名,并**保留** claim
 *      —— claims 放在模块作用域,配置热加载复用同一个模块实例,所以新实例接着管;
 *   5. `disarm` 抛错时**保留** claim(W5):真实现的顺序是 `assertLive` → `setActivation`
 *      (**先翻 activation、再同步 emit `goal/activation-changed`**)→ 读 projection
 *      (`dsh-goal/lib/index.js:622-627`)⇒ emit 之后抛错意味着 activation 已经是 disarmed
 *      而**没人负责放行**;丢 claim 会让目标永久停在 active+disarmed,保留则看门狗下一 tick 重判。
 *
 * ── 配置(patch 装载行的 config,全部可省)──────────────────────────────────
 *   enabled:true              总开关,false ⇒ 不订阅、不门控(只打一行日志)
 *   observeOnly:false         只观察:判定照跑、日志照打,绝不改状态(上线前先这样跑一段)
 *   watchdogIntervalMs:30000  看门狗周期
 *   maxHoldMs:1800000         单个 claim 最长持有时间,超时强制放行
 * 服务不可用(`goals` / `agents` 拿不到)时**强制降级为 observeOnly**,绝不改状态、也绝不抛回 loader。
 */

import {
  DEFAULTS,
  activeChildIds,
  childInFlight,
  childKey,
  findOwnerId,
  hasLiveDescendant,
  latchKey,
  ownedChildIds,
  planGate,
  planReArm,
  resolveConfig,
  snapshotAgents,
} from './gate.js'

/** 插件名(宿主日志与 loader 行里的标识)。 */
export const name = 'goal-subagent-gate'

/** 版本号,只用于日志溯源(与 package.json 手工对齐)。 */
export const VERSION = '0.2.1'

/**
 * 依赖服务。声明 inject ⇒ 两个服务都在时 apply 才跑;任缺一个,本行不会被激活。
 * (`agents` = dsh-agent 的注册表;`goals` = dsh-goal 的目标域服务。)
 */
export const inject = ['agents', 'goals']

/**
 * 模块作用域 claim 表:agentId → claim。
 *
 * ⚠ 故意**不放在 apply 局部变量**里:配置热加载会重跑 apply,放局部变量会让 claim 随旧实例
 *   一起消失 ⇒ 目标停在 active+disarmed 且没人放行 = 永久停摆。模块作用域在进程内跨 apply 存活
 *   (cordis 的 loader 复用已 import 的模块实例)。
 */
const CLAIMS = new Map()

/**
 * 强制放行闩锁:agentId → 放行那一刻的 (goal 身份 + 在飞子代理集合) 指纹(`latchKey`)。
 *
 * 为什么需要它:超时兜底会在一批子代理**还在跑**的时候强制 resume;若下一次 `agent/status`
 * 又按"有在飞子代理 + goal armed"把它压回去,兜底放行等于当场失效 ⇒ 变成 30 分钟一次的活锁。
 * 闩锁的语义:**同一个 goal 的同一批孩子**还活着 ⇒ 不再压(优先"目标能动");goal 换人
 * (`/goal clear` 后新建,缺陷 W1)或孩子集合一变(结算 / 新委派)⇒ 闩锁作废,门控恢复正常。
 * ⚠ 指纹**故意不含 revision**(resume 自己会 +1,编进去会让闩锁当场作废 ⇒ 活锁):见 gate.js 的 latchKey。
 * ⚠ **"集合一变就作废"必须主动去观测**(M1,v0.2.1 修):只在 `planGate` 里比一次当次快照是不够的 ——
 *   同一批孩子"先停再跑"会让快照**绕回原值**(`goal-1:c1` → `goal-1:` → `goal-1:c1`),
 *   闩锁就一直生效、门对该目标静默失效。所以另有 `refreshLatches()`,挂在孩子的 `agent/status`
 *   等触发点上(详见它的文档注释)。
 */
const RELEASED = new Map()

/**
 * "让位标记":agentId → 置位原因。模块作用域,跨热加载存活。
 *   · `session/event` 的 `turn/end` aborted ⇒ 记 cause(`user` / `parent` / `disposed` / `hook` / `unknown`);
 *   · `agent/inbox/discarded` 丢弃已排队的 goal 轮 ⇒ 记 `inbox-discarded`。
 *
 * 为什么需要它:见文件头「凡是能让 driver 的 attempt.cancelled 成真的路径都必须让位」。一句话 ——
 * 门控 listener prepend 在 driver 的 idle 停车判据之前,不主动让位就会把 durable pause 吞掉,孩子
 * 结算后还会被本插件 resume 撤销。
 * ⚠ 置位到"消费它的那次 idle"之间**可能夹着若干整轮**:`dsh-agent-loop` 的 `kick()` 是
 *   `while (await this.turn())`,而 `turn()` 在 `inbox.hasPending` 时返回 true ⇒ 可以连跑多个 turn
 *   完全不经 idle(`agent/status` 只在 status **变化**时 emit)。标记必须活过这些整轮 —— 那正是要的:
 *   driver 的 `attempt.cancelled` 同样一直在,durable pause 仍会在下一次 idle 写出。
 * 生命周期:置位(更晚的置位覆盖更早的,好让 `turn/end` 的 cause 胜过清 inbox 时的 `inbox-discarded`)
 *   → 该 agent 下一次 `agent/status`(idle) 消费并删除 → 代理被摘除时顺手删除。
 */
const ABORTED = new Map()

/**
 * 自置标志:> 0 表示当前调用栈是"本插件自己"在改 activation。
 * `ctx.goals.disarm/resume/block` 都会**同步** emit `goal/activation-changed`
 * (`dsh-goal/lib/index.js:789-806` 由 `commit`/`disarm` 同步触发),所以计数器足以区分归属。
 */
let selfAction = 0

/** 只用于日志的累计计数,便于重启后核对"到底动过几次状态"。 */
const STATS = { disarmed: 0, resumed: 0, blocked: 0, dropped: 0 }

/** 渲染任意抛出值为一行文本。 */
function renderThrown(value) {
  if (value instanceof Error) return value.message
  return String(value)
}

/**
 * 造日志出口:**双写**(理由与 dsh-host-godot-tool-layering 同源,已逐行核过):
 *   · `ctx.logger.*` ⇒ 进 cordis 的 logger 通路(内存 buffer / exporter,取决于本机配置);
 *   · `console.*`   ⇒ 宿主 stdout,被看门狗收进 `<工具目录>\dsh-watchdog-dsh.log`
 *     —— 本机**实际唯一能事后翻到**的地方。
 * 只写 logger 是不够的:cordis 自带的 exporter 只往内存 buffer 塞(`cordis/lib/index.js:598`),
 * dsh-app-boot 注册的那个 exporter 只要 warn/error(`dsh-app-boot/lib/index.js:4056-4066`,
 * `levels:{default:2}`)⇒ info 级在真机上无处可查。两路都写、各自 try/catch,任何一路失败都不影响另一路。
 * `debug` 只进 logger(不刷 stdout):它按每次判定都可能触发,不该污染宿主日志。
 */
function makeLogger(ctx) {
  let logger = null
  try {
    if (typeof ctx.logger === 'function') {
      const candidate = ctx.logger('goal-subagent-gate')
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.info === 'function') logger = candidate
    }
  } catch {
    logger = null
  }
  const emit = (level, message) => {
    try {
      if (logger !== null && typeof logger[level] === 'function') logger[level](message)
    } catch {
      /* logger 服务异常时忽略,仍有 console 那一路 */
    }
    if (level === 'debug') return
    try {
      const line = `[goal-subagent-gate] ${message}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    } catch {
      /* stdout 不可用时静默,仍有 logger 那一路 */
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
    debug: (message) => emit('debug', message),
  }
}

/**
 * 插件入口。**绝不把异常抛回 loader**:apply 抛错会让整行加载失败(同 profile 的既有教训),
 * 这里一律降级成"什么都不做 + 一行日志"。
 */
export function apply(ctx, config) {
  try {
    applyInner(ctx, config)
  } catch (error) {
    try {
      console.error(`[goal-subagent-gate] apply 抛错,插件已降级(不做任何门控):${error?.stack ?? error}`)
    } catch {
      /* 连日志都失败就彻底静默 */
    }
  }
}

function applyInner(ctx, config) {
  const cfg = resolveConfig(config)
  const log = makeLogger(ctx)
  for (const warning of cfg.warnings) log.warn(`配置:${warning}`)

  // ── 装载自检:把"能不能拿到服务、订阅了哪些事件"一次打全,便于重启后核对 ──
  const canGoals = probe(() => typeof ctx.goals?.get === 'function'
    && typeof ctx.goals?.disarm === 'function'
    && typeof ctx.goals?.resume === 'function'
    && typeof ctx.goals?.block === 'function')
  const canAgents = probe(() => typeof ctx.agents?.get === 'function'
    && typeof ctx.agents?.list === 'function'
    && typeof ctx.agents?.isOwnedBy === 'function')
  log.info(`apply v${VERSION}:enabled=${cfg.enabled} observeOnly=${cfg.observeOnly}`
    + ` watchdogIntervalMs=${cfg.watchdogIntervalMs} maxHoldMs=${cfg.maxHoldMs}`)
  log.info(`自检:goals 服务=${canGoals ? '可用' : '不可用'} agents 服务=${canAgents ? '可用' : '不可用'}`
    + ` 已有 claim=${CLAIMS.size} 已有闩锁=${RELEASED.size}`
    + ' 订阅=[subagent/start(只登记), subagent/end(+闩锁复核), agent/status(prepend+global, 唯一门控入口,'
    + ' +闩锁复核), agent/disposed(+闩锁复核), goal/activation-changed,'
    + ' session/event(turn/end:aborted ⇒ 让位标记),'
    + ' agent/inbox/discarded(goal 轮被丢弃 ⇒ 让位标记), 看门狗定时器(闩锁复核 + claim 重算)]')

  if (!cfg.enabled) {
    log.info('enabled=false ⇒ 不订阅任何事件、不做任何门控(改回 true 需要重载本行)')
    return
  }

  // 服务不可用 ⇒ 强制只观察。判据是"方法在不在",不是"服务对象在不在"。
  const effective = { ...cfg }
  if (!canGoals || !canAgents) {
    effective.observeOnly = true
    log.warn('goals / agents 服务不可用 ⇒ 本次运行强制 observeOnly:只记日志,绝不改状态')
  }

  /**
   * 拍平活代理表。
   *
   * 每条记录带 `status`(真 Agent 实例上的现算 getter)与 `pending`(inbox 还有没有排队消息)
   * ⇒ 判定侧才能分"还有活要干"与"已经没事了"。
   *
   * ⚠ **读失败返回 `null`,不是 `[]`**(M2,v0.2.1 修):`[]` 的意思是"读到了,名下没有活代理",
   *   `null` 的意思是"**没读到**"。旧实现把两者混成 `[]`,而下游的空表语义是
   *   `planGate → no-active-child`(不压住)、`planReArm → children-settled`(**提前放行**)
   *   —— 方向与"保守"完全相反(旧注释还写着"配合 hold 语义不会误放行",与代码相反,已改)。
   *   现在 `null` 一路透传到 `planGate` / `planReArm` 的 `children-unreadable` 分支:本 tick 不判定、
   *   不动闩锁、保留 claim,下一 tick 重判。
   *
   * @returns {Array|null} 拍平结果;读失败返回 `null`。
   */
  function records() {
    try {
      return snapshotAgents(ctx.agents.list(), (id, owner) => ctx.agents.isOwnedBy(id, owner))
    } catch (error) {
      log.warn(`拍平活代理表失败(本 tick 不判定,保留 claim 等下一 tick):${renderThrown(error)}`)
      return null
    }
  }

  /** 读当前 goal。区分"没有 goal"(ok + undefined)与"读失败"(!ok,调用方要保留 claim 重试)。 */
  function readGoal(agent) {
    try {
      return { ok: true, goal: ctx.goals.get(agent) }
    } catch (error) {
      return { ok: false, error: renderThrown(error) }
    }
  }

  /** 丢 claim(不改任何状态)。 */
  function dropClaim(claim, reason, trigger) {
    if (CLAIMS.get(claim.agentId) !== claim) return
    CLAIMS.delete(claim.agentId)
    STATS.dropped += 1
    log.info(`丢 claim[${trigger}] agent=${claim.agentId} goal=${claim.goalId} 原因=${reason}(不改状态)`)
  }

  /**
   * 消费"让位标记"。返回 true = 这一次 idle 完整让给 driver 的停车闸门,本插件完全不插手。
   *
   * 丢 claim 是必须的:留着它,子代理结算 / 看门狗会按"孩子结算 ⇒ resume"把这次叫停撤销掉。
   * 丢完目标停在 active+disarmed(没人自动放行)= "停下等人工",人工 `/goal resume` 可再开。
   * ⚠ 措辞按 cause 区分(N3):只有 `user` 是"用户按停止";`parent` / `disposed` / `hook` /
   *   `inbox-discarded` 都是别的来源,一律写"叫停让位",否则日志会误导排查。
   */
  function consumeAbortHandoff(agent, trigger) {
    if (!ABORTED.has(agent.id)) return false
    const cause = ABORTED.get(agent.id)
    ABORTED.delete(agent.id)
    const claim = CLAIMS.get(agent.id)
    if (claim !== undefined) dropClaim(claim, 'abort-handoff', trigger)
    const label = cause === 'user' ? '用户叫停' : '叫停让位'
    log.info(`${label}[cause=${cause}] agent=${agent.id} trigger=${trigger}:跳过门控并丢 claim`
      + '(不 disarm、不建 claim、不 resume) ⇒ 本次 idle 让给 driver 的停车闸门'
      + '(有预约 ⇒ durable pause;无预约 ⇒ 它自己的 disarm)')
    return true
  }

  /**
   * 压住:记 claim + disarm。返回是否真的压住。
   *
   * ⚠ **硬前置条件:只压 idle 的代理**(S1)。disarm 会把进程内 activation 翻成 disarmed,而
   *   driver 的停车闸门(`turn/end` aborted ⇒ durable pause;max-tokens / agent/error ⇒ disarm)
   *   全部以 `activation === "armed"` 为前提 ⇒ 在 running 期间压住等于把这些制动整条废掉,
   *   且孩子结算后的 resume 会把目标重新开起来。这里做**单点强制**,调用方再判一次也无妨:
   *   status 拿不到、或不是 idle,一律不动。见文件头「为什么只在 idle 压住」。
   */
  function gateCheck(agent, trigger) {
    if (agent === undefined || agent === null || agent.status !== 'idle') {
      log.debug(`[${trigger}] agent=${agent?.id} status=${agent?.status} ≠ idle ⇒ 不在 running 期间改 activation`)
      return
    }
    const result = readGoal(agent)
    if (!result.ok) return
    const children = records()
    const releasedKey = RELEASED.get(agent.id)
    const plan = planGate({
      config: effective,
      goal: result.goal,
      children,
      selfAgentId: agent.id,
      releasedKey,
    })
    if (plan.clearLatch) {
      RELEASED.delete(agent.id)
      log.info(`闩锁作废[${trigger}] agent=${agent.id}:goal 或子代理集合已变(原=${releasedKey} 现=${plan.key})⇒ 门控恢复`)
    }
    if (plan.action !== 'disarm') {
      if (plan.reason === 'force-released-latch') {
        log.debug(`[${trigger}] agent=${agent.id} 处于强制放行闩锁内(同一 goal + 同一批子代理 ${plan.active} 个),不再压住`)
      }
      if (plan.reason === 'children-unreadable') {
        // M2:活代理表读不到 ⇒ 本 tick 不判定。**不写 info**(读失败本身已有一条 warn),
        // 这里只留 debug,免得服务异常期间每个 idle 都刷一行。
        log.debug(`[${trigger}] agent=${agent.id} 活代理表读不到 ⇒ 本 tick 不判定(不 disarm、不动闩锁)`)
      }
      // v0.2.0:把"因为孩子都已结算而放行"**正面**记一行 —— 否则真机上只能靠"没有 disarm 行"反推,
      // 而"没有日志"既可能是放行了、也可能是插件没跑。只在"注册表里确实有孩子、但一个都不在飞、
      // 且目标正 armed"时打:这正是 v0.1.0 会压住、v0.2.0 不再压住的那个情形。
      if (plan.reason === 'no-active-child' && result.goal?.phase === 'active' && result.goal.activation === 'armed') {
        const owned = ownedChildIds(children, agent.id).length
        if (owned > 0) {
          log.info(`不压住[${trigger}] agent=${agent.id} goal=${result.goal.id}:名下 ${owned} 个子代理都已结算`
            + `(不在飞;判据=v0.2.1 的 status==='running' ∨ inbox 有排队消息 ∨ 名下有活后代)⇒ 门控放行,driver 可正常续轮`)
        }
      }
      return
    }
    if (!plan.apply) {
      log.info(`[${trigger}] observeOnly:本应 disarm agent=${agent.id} goal=${result.goal.id}`
        + ` rev=${result.goal.revision} 在飞子代理=${plan.active}(未改状态)`)
      return
    }
    const claim = {
      agentId: agent.id,
      agent,
      goalId: result.goal.id,
      revision: result.goal.revision,
      since: Date.now(),
    }
    CLAIMS.set(agent.id, claim)
    selfAction += 1
    try {
      ctx.goals.disarm(agent)
    } catch (error) {
      selfAction -= 1
      // ⚠ 绝不在这里丢 claim(缺陷 W5):真实现的顺序是 assertLive → setActivation(**先翻
      // activation、同步 emit goal/activation-changed**)→ this.state(读 projection,可抛),
      // 见 dsh-goal/lib/index.js:622-627 ⇒ emit 之后抛错时 activation **已经**是 disarmed,
      // 丢 claim 就变成"目标已 disarm 但无人放行"= 永久停摆。保留 claim 交给看门狗下一 tick 重判:
      // activation 真翻了 ⇒ 走 hold / resume 放行;没翻 ⇒ planReArm 判 already-armed 自己丢掉。
      log.warn(`disarm 失败[${trigger}] agent=${agent.id} goal=${claim.goalId}`
        + `:${renderThrown(error)} ⇒ 保留 claim,${effective.watchdogIntervalMs}ms 后重判`
        + '(activation 可能已被翻成 disarmed,丢 claim 会让目标停在 active+disarmed 且无人放行)')
      return
    }
    selfAction -= 1
    STATS.disarmed += 1
    log.info(`disarm[${trigger}] agent=${agent.id} goal=${claim.goalId} rev=${claim.revision}`
      + ` 在飞子代理=${plan.active} 累计 disarm=${STATS.disarmed}`
      + '(goal 停在 active+disarmed:进程内不续轮,不写会话、不产生 blocked code)')
  }

  /** 放行:resume(自带重发路径)。失败保留 claim,下一 tick 重试。 */
  function reArm(claim, goal, plan, trigger) {
    const ref = { id: goal.id, revision: goal.revision }
    selfAction += 1
    try {
      ctx.goals.resume(claim.agent, ref)
    } catch (error) {
      selfAction -= 1
      log.warn(`re-arm 失败[${trigger}] agent=${claim.agentId} goal=${goal.id} rev=${goal.revision}`
        + `:${renderThrown(error)} ⇒ 保留 claim,${effective.watchdogIntervalMs}ms 后重试`)
      return
    }
    selfAction -= 1
    STATS.resumed += 1
    CLAIMS.delete(claim.agentId)
    if (plan.forced) RELEASED.set(claim.agentId, plan.key)
    log.info(`re-arm[${trigger}] agent=${claim.agentId} goal=${goal.id} rev=${goal.revision}`
      + ` 在飞子代理=${plan.active} 依据=${plan.reason} 累计 re-arm=${STATS.resumed}`
      + '(已写 durable resume ⇒ 宿主 driver 会自行发下一轮)')
    if (plan.forced) {
      log.warn(`兜底 re-arm:claim 持有 ${Math.round((Date.now() - claim.since) / 1000)}s`
        + ` 已达 maxHoldMs=${effective.maxHoldMs}ms,仍有 ${plan.active} 个在飞子代理 —— 强制放行,`
        + '并对这批子代理上闩锁(集合一变即恢复门控):优先保证目标不会永久停摆')
    }
  }

  /** 额度用尽:必须本插件自己 block(driver 被压住时永远不会执行它自己的 round-limit 检查)。 */
  function doBlock(claim, goal, plan, trigger) {
    const ref = { id: goal.id, revision: goal.revision }
    const reason = {
      code: 'round-limit',
      message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
    }
    selfAction += 1
    try {
      ctx.goals.block(claim.agent, ref, reason)
    } catch (error) {
      selfAction -= 1
      log.warn(`block 失败[${trigger}] agent=${claim.agentId} goal=${goal.id} rev=${goal.revision}`
        + `:${renderThrown(error)} ⇒ 保留 claim,${effective.watchdogIntervalMs}ms 后重试`)
      return
    }
    selfAction -= 1
    STATS.blocked += 1
    CLAIMS.delete(claim.agentId)
    log.warn(`block[${trigger}] agent=${claim.agentId} goal=${goal.id} rev=${goal.revision}`
      + ` code=round-limit roundsStarted=${goal.roundsStarted}/${goal.maxGoalRounds}`
      + ` 在飞子代理=${plan.active} 依据=${plan.reason} 累计 block=${STATS.blocked}`)
  }

  /** claim 重算:放行 / block / 丢 / 继续压着的唯一出口。 */
  function recompute(claim, trigger) {
    // "用户叫停"标记还没被那次 idle 消费(极窄窗口:abort 与 idle 之间孩子结算 / 看门狗到点)⇒
    // 只丢 claim,绝不放行 —— 否则等于把用户的停止撤销。标记本身留给那次 idle 去消费(它还要跳过门控)。
    if (ABORTED.has(claim.agentId)) {
      dropClaim(claim, 'abort-handoff', trigger)
      return
    }
    const live = safeGetAgent(claim.agentId)
    if (live !== claim.agent) {
      dropClaim(claim, 'agent-not-live', trigger)
      return
    }
    const result = readGoal(live)
    if (!result.ok) {
      // 读失败(agent 已不是注册表里的活实例 / projection 失败)⇒ 不动状态、保留 claim 等下一 tick。
      log.debug(`[${trigger}] 读 goal 失败,保留 claim 等下一 tick:agent=${claim.agentId} ${result.error}`)
      return
    }
    const children = records()
    const plan = planReArm({
      config: effective,
      claim,
      goal: result.goal,
      children,
      selfAgentId: claim.agentId,
      now: Date.now(),
    })
    switch (plan.action) {
      case 'drop':
        dropClaim(claim, plan.reason, trigger)
        return
      case 'resume':
        if (!plan.apply) {
          log.info(`[${trigger}] observeOnly:本应 re-arm agent=${claim.agentId}`
            + ` goal=${result.goal?.id} 在飞子代理=${plan.active} 依据=${plan.reason}(未改状态)`)
          return
        }
        reArm(claim, result.goal, plan, trigger)
        return
      case 'block':
        if (!plan.apply) {
          log.info(`[${trigger}] observeOnly:本应 block(code=round-limit) agent=${claim.agentId}`
            + ` goal=${result.goal?.id} roundsStarted=${result.goal?.roundsStarted}/${result.goal?.maxGoalRounds}(未改状态)`)
          return
        }
        doBlock(claim, result.goal, plan, trigger)
        return
      default:
        // 'hold'(还有在飞子代理 / 活代理表读不到)⇒ 不动状态、保留 claim。
        if (plan.reason === 'children-unreadable') {
          log.debug(`[${trigger}] 活代理表读不到 ⇒ 保留 claim 不放行:agent=${claim.agentId}`)
        }
        return
    }
  }

  /** 重算全部 claim(子代理结算 / 摘除这类"不知道是谁的孩子"的触发点用)。 */
  function recomputeAll(trigger) {
    for (const claim of [...CLAIMS.values()]) {
      try {
        recompute(claim, trigger)
      } catch (error) {
        log.warn(`重算 claim 抛错[${trigger}] agent=${claim.agentId}:${renderThrown(error)}`)
      }
    }
  }

  /**
   * 闩锁复核(M1,v0.2.1):**只要观察到"当前在飞集合"不再是闩锁记下的那一批,闩锁当场作废。**
   *
   * 修的是这个洞:`planGate` 里的 `releasedKey === key` 只比**当次快照**,而"同一批孩子先停再跑"
   * 会让快照**绕回原值**(`goal-1:c1` → `goal-1:` → `goal-1:c1`)⇒ 闩锁静默生效,门对该目标
   * 再也不压 —— 正是本插件要防的空转。协调者"同一轮里先收结果再派活"很容易走到这条。
   *
   * 为什么挂在**孩子的 `agent/status`** 上:兜底放行之后 claim 已经交还,`subagent/end` /
   * `agent/disposed` 那两个重算入口都会因 `CLAIMS.size === 0` 提前 return,看门狗也重算不到任何
   * claim ⇒ 唯一能在"快照绕回原值**之前**"看到空集合的机会,就是孩子"停"的那一刻
   * (它必然 emit `agent/status`:`dsh-agent-loop:793-799` 的 setPhase 只在 status 真的变化时 emit)。
   *
   * ⚠ 活代理表读不到时**一个闩锁都不动**(分不清"集合变了"与"看不见",保守方向)。
   * ⚠ 顺带清掉"代理已不在注册表"的孤儿闩锁(旧 W7 的清理时机问题)。
   * 成本:没有闩锁时是一次 `RELEASED.size === 0` 判断;有闩锁时每个闩锁一次 `records()` + 一次读 goal
   * (闩锁只在超时兜底之后才存在,数量是 0/1 级)。
   */
  function refreshLatches(trigger) {
    if (RELEASED.size === 0) return
    const children = records()
    if (children === null) return
    for (const [agentId, releasedKey] of [...RELEASED.entries()]) {
      const live = safeGetAgent(agentId)
      if (live === undefined) {
        RELEASED.delete(agentId)
        log.debug(`闩锁作废[${trigger}] agent=${agentId}:代理已不在活代理表(原=${releasedKey})`)
        continue
      }
      const result = readGoal(live)
      if (!result.ok) continue // 读不到 goal ⇒ 不动闩锁,等下一 tick
      const key = latchKey(result.goal, children, agentId)
      if (key === releasedKey) continue
      RELEASED.delete(agentId)
      log.info(`闩锁作废[${trigger}] agent=${agentId}:goal 或子代理集合已变(原=${releasedKey} 现=${key})⇒ 门控恢复`)
    }
  }

  /** 读活代理对象(注册表按 id 查;身份必须**全等**,否则说明已是另一个实例)。 */
  function safeGetAgent(agentId) {
    try {
      return ctx.agents.get(agentId)
    } catch (error) {
      log.debug(`ctx.agents.get(${agentId}) 失败:${renderThrown(error)}`)
      return undefined
    }
  }

  // ── 事件订阅 ────────────────────────────────────────────────────────────
  // ⚠ 每个 handler 自带 try/catch:emit 的 map 循环里抛错会中断同一次派发的其余 listener。
  const on = (event, handler, options) => {
    try {
      ctx.on(event, (...args) => {
        try {
          handler(...args)
        } catch (error) {
          log.warn(`${event} listener 抛错(已吞):${renderThrown(error)}`)
        }
      }, options)
    } catch (error) {
      log.warn(`订阅 ${event} 失败:${renderThrown(error)}`)
    }
  }

  /**
   * 子代理建立:**只登记,绝不改 activation**(S1 修复)。
   *
   * 旧实现在这里直接 gateCheck ⇒ 父代理还在 running 时就把它 disarm 了,于是 driver 的
   * `turn/end` aborted 分支与 `agent/status` idle 的 durable pause 判据(`activation === "armed"`)
   * 全部为假:用户按停止不再产生 durable pause,孩子结算后本插件再 resume,目标自己又跑起来。
   * driver 只在 `status === "idle"` 时才开新轮(`readyToDrive`),所以门控放在 idle 就够
   * —— 见下面 `agent/status` 那条(`prepend:true` 抢在 driver 前面)。这里只做登记/记账,供日志核对。
   */
  on('subagent/start', (info) => {
    const childId = info?.id
    if (typeof childId !== 'string') return
    const ownerId = findOwnerId(records() ?? [], childId)
    if (ownerId === undefined) {
      // 非本进程子代理(out-of-process)、或还没进注册表 ⇒ owner 不可知,交给 agent/status 兜底。
      log.debug(`subagent/start 未定位到 owner:child=${childId} provider=${info?.provider}`
        + ` local=${info?.local} ⇒ 交由 agent/status 兜底`)
      return
    }
    log.debug(`subagent/start 登记:child=${childId} owner=${ownerId} provider=${info?.provider}`
      + ' ⇒ 本处理器不改 activation;门控只在 owner 下一次 agent/status(idle) 判定')
  }, { global: true })

  /**
   * 子代理结算:不知道是谁的孩子(info 里只有 child id,且孩子可能已摘除)⇒ 全部重算。
   * ⚠ 闩锁复核**必须排在 `CLAIMS.size === 0` 的提前 return 之前**(M1):兜底放行之后 claim 已经
   *   交还,而孩子结算/摘除正是"那批孩子已经不在飞"的可观测时刻,漏掉它闩锁就再也作废不了。
   */
  on('subagent/end', (info) => {
    refreshLatches(`subagent/end:${info?.id ?? '?'}:${info?.stopReason ?? '?'}`)
    if (CLAIMS.size === 0) return
    recomputeAll(`subagent/end:${info?.id ?? '?'}:${info?.stopReason ?? '?'}`)
  }, { global: true })

  /**
   * 代理状态变化 —— **本插件唯一的门控入口**(S1)。三件事,顺序有讲究:
   *   1. idle 时先做一次门控:driver 的下一轮只可能在 idle 派发里被预约,而本监听 prepend 到
   *      它前面,所以这一次 disarm 就是"压住"的全部所需;
   *   2. 再重算 claim;
   *   3. 最后复核闩锁(M1):**任何代理**的状态变化都可能意味着"那批在飞子代理"已经不是闩锁
   *      记下的那一批 —— 尤其是孩子"停"的那一刻,那是快照绕回原值之前唯一的观测点。
   * ⚠ `prepend: true` 是硬要求:driver 的 listener 在**同一次派发内同步**走到 `agent.followup`,
   *   只有插到它前面,disarm 才来得及生效。
   * ⚠ 只有 `status === "idle"` 才门控:running 期间绝不动 activation(gateCheck 里还有一道单点强制)。
   */
  on('agent/status', ({ agent, status }) => {
    if (agent === undefined) return
    // 用户叫停 ⇒ 让位:既不门控(否则吞掉 driver 的 durable pause),也不 recompute(否则会把
    // claim resume 回去)。见文件头「用户叫停必须让位」。
    const handedOff = status === 'idle' && consumeAbortHandoff(agent, 'agent/status:idle')
    if (status === 'idle' && !handedOff) gateCheck(agent, 'agent/status:idle')
    if (!handedOff) {
      const claim = CLAIMS.get(agent.id)
      if (claim !== undefined) recompute(claim, `agent/status:${status}`)
    }
    refreshLatches(`agent/status:${status}:${agent.id}`)
  }, { prepend: true, global: true })

  /** 代理摘除:孩子被摘除 ⇒ 复核闩锁 + 重算;被摘除的是 claim 持有者本身 ⇒ 丢 claim。 */
  on('agent/disposed', ({ agent }) => {
    if (agent === undefined) return
    ABORTED.delete(agent.id) // 代理没了,未消费的标记作废(防 id 复用时的陈旧标记)
    refreshLatches(`agent/disposed:${agent.id}`)
    if (CLAIMS.size === 0) return
    recomputeAll(`agent/disposed:${agent.id}`)
  }, { global: true })

  /**
   * activation 变化。`selfAction > 0` 是本插件自己的动作,忽略;其余一律丢 claim
   * —— 否则会覆盖 driver 因 max-tokens / agent/error / aborted 做的 disarm,也会跟"别人已经
   * 放行"打架。payload 里没有 goal(projection 缺失,见 dsh-goal `:794-796`)时同样丢弃。
   */
  on('goal/activation-changed', (payload) => {
    if (selfAction > 0) return
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string') return
    for (const claim of [...CLAIMS.values()]) {
      if (claim.agent?.session?.id !== sessionId) continue
      dropClaim(claim, `activation-changed-by-other(${payload?.goal?.activation ?? 'no-goal'})`, 'goal/activation-changed')
    }
  }, { global: true })

  /**
   * 让位标记来源之一:`turn/end` 的 `reason.kind === "aborted"` ⇒ 给该 agent 置一次性标记(见文件头)。
   * session → agent 的解析与 driver 同款:`ctx.agents.get(session.id)` + **同一实例**校验
   * (`dsh-goal-round-driver/lib/index.js:253-256`)。非 turn/end 的 session 事件一律直接返回。
   * cause 在 `event.data.reason.reason.kind`(闭合联合 `user` / `parent` / `disposed` / `hook`,
   * `dsh-agent-loop:731-745`),原样记进标记供日志措辞用(N3)。
   */
  on('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'aborted') return
    const agent = safeGetAgent(session?.id)
    if (agent === undefined || agent.session !== session) return
    const cause = event.data.reason.reason?.kind ?? 'unknown'
    ABORTED.set(agent.id, cause)
    log.debug(`让位标记[cause=${cause}] ${session.id} turn/end aborted ⇒ 下一次 agent/status(idle) 跳过门控并丢 claim`)
  }, { global: true })

  /**
   * 让位标记来源之二(N1):`agent/inbox/discarded` + 被丢弃的是**已排队的 goal 轮**。
   * 见文件头「凡是能让 driver 的 attempt.cancelled 成真的路径都必须让位」:idle 状态下被 cancel
   * 没有 `turn/end`,这条是唯一信号。判据与 driver 的 `isGoalRoundSource` 同源(kind=goal 且 round>0)。
   */
  on('agent/inbox/discarded', ({ agent, message }) => {
    if (agent === undefined) return
    const source = message?.source
    if (source?.kind !== 'goal' || !(typeof source.round === 'number' && source.round > 0)) return
    ABORTED.set(agent.id, 'inbox-discarded')
    log.debug(`让位标记[cause=inbox-discarded] agent=${agent.id}:已排队的 goal 轮`
      + `(round=${source.round})被丢弃 ⇒ 下一次 agent/status(idle) 跳过门控并丢 claim`)
  }, { global: true })

  // ── 看门狗:兜住"事件没来 / 时序没覆盖"的情形,保证目标不会永久停在 disarmed ──
  try {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          refreshLatches('watchdog') // 顺带清孤儿闩锁(W7):代理都没了就不该留着条目
          recomputeAll('watchdog')
        } catch (error) {
          log.warn(`看门狗抛错(已吞):${renderThrown(error)}`)
        }
      }, effective.watchdogIntervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'goal-subagent-gate watchdog')
    log.info(`看门狗已挂:每 ${effective.watchdogIntervalMs}ms 复核全部闩锁 + 重算全部 claim;`
      + `claim 超过 ${effective.maxHoldMs}ms 未放行即强制放行`)
  } catch (error) {
    log.warn(`看门狗未挂上(${renderThrown(error)}):claim 只剩事件驱动重算,超时兜底失效`)
  }

  // ── 卸载 / 热重载:尽力放行一次,绝不把目标留在"没人管"的 disarmed 上 ──
  try {
    ctx.effect(() => () => {
      for (const claim of [...CLAIMS.values()]) {
        try {
          recompute(claim, 'dispose')
        } catch (error) {
          log.warn(`dispose 放行失败 agent=${claim.agentId}:${renderThrown(error)}`)
        }
      }
      const left = [...CLAIMS.values()]
      if (left.length === 0) {
        log.info(`dispose:无遗留 claim(累计 disarm=${STATS.disarmed} re-arm=${STATS.resumed}`
          + ` block=${STATS.blocked} 丢 claim=${STATS.dropped})`)
        return
      }
      log.warn(`dispose:仍有 ${left.length} 个 claim 未能放行`
        + `(agent=${left.map((c) => c.agentId).join(',')})⇒ 这些目标会停在 active+disarmed:`
        + '重新启用本插件即自动放行,或人工 /goal resume')
    })
  } catch (error) {
    log.warn(`ctx.effect 不可用(${renderThrown(error)}),卸载时不会做收尾放行`)
  }

  // ── 装载即扫一遍:热重载/后装的情形下,不必等下一个事件才压住 ──
  // (profile 启动时所有 activation 都是 disarmed,这一扫是 no-op;真正有用的是"插件后装/热重载
  //  时已经有子代理在跑"。gateCheck 自带"只压 idle"前置条件 ⇒ running 的代理留给它下一次 idle。)
  try {
    let scanned = 0
    let idle = 0
    for (const agent of ctx.agents.list()) {
      scanned += 1
      if (agent?.status === 'idle') idle += 1
      gateCheck(agent, 'apply:initial-scan')
    }
    log.info(`装载扫描完成:活代理 ${scanned} 个(idle ${idle} 个参与判定),压住 ${CLAIMS.size} 个`)
  } catch (error) {
    log.warn(`装载扫描失败(${renderThrown(error)}),改由事件驱动门控`)
  }

  // 装载自检最后一行:把"当前有没有压着东西"写清楚(重启后对着日志核对)。
  if (CLAIMS.size > 0) {
    log.info(`装载时已有 ${CLAIMS.size} 个遗留 claim(模块作用域跨热加载存活):`
      + [...CLAIMS.values()].map((c) => `${c.agentId}(goal=${c.goalId})`).join(', '))
  }
}

/** 探测一个服务能力,永不抛错。 */
function probe(check) {
  try {
    return check() === true
  } catch {
    return false
  }
}

/** 只读导出:给测试与人工排查用(不参与运行时逻辑)。 */
export const __internals = {
  CLAIMS, RELEASED, ABORTED, STATS, DEFAULTS,
  activeChildIds, childInFlight, childKey, hasLiveDescendant, latchKey, ownedChildIds, planGate, planReArm,
}
