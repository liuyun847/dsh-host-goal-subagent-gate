# dsh-host-goal-subagent-gate

DSH 宿主插件:**会话有在飞的子代理时压住 goal 的自动续轮,等它们停下来再放行。**
（"在飞"的定义与依据见第 3 节；v0.2.0 起它不再等于"在活代理表里"，v0.2.1 起还把
"inbox 还有排队消息"算进来。）

## 1. 修的是什么

`dsh-goal-round-driver` 的驱动器在 agent 一进入 `idle` 就立刻开下一轮
(`dsh-goal-round-driver/lib/index.js:213-230` 的 `agent/status` listener → `requestDrive` → `drive`)。
于是"把活全外包给后台子代理、自己立刻 idle"的会话会疯狂空转:

```
实测(2026-09-27):一次会话 25 轮额度在 10 分 28 秒内烧完,其中 19 轮没有任何实质推进,
最后目标被 driver 自动标成 blocked(code=round-limit)。
```

本插件把"这一轮结束"的口径改成:**只有名下没有在飞子代理时,才允许下一次续轮注入**(在飞 = 见第 3 节)。

## 2. 机制

```
 父代理委派 → subagent/start ──→ **只登记**(定位 owner 供日志核对),绝不改 activation

 让位标记 → session/event(turn/end:aborted,带 cause) ──┐
          → agent/inbox/discarded(goal 轮被丢弃) ───────┤ 记一次性标记:agentId → cause
           └→ 下一次 agent/status(idle) 消费它:跳过门控 + 丢 claim,让 driver 自己写 durable pause

 父代理 idle → agent/status ──┐
  (prepend:true,抢在 driver 前) ├─→ 该代理名下有**在飞**子代理 ∧ goal 是 active+armed?
                              │      ├─ 是 → 记 claim + ctx.goals.disarm(agent)   [压住]
                              │      └─ 否 → 什么都不做
 看门狗(每 30s)─────────────┘   (gateCheck 自带"只压 idle 的代理"前置条件)

 子代理结算 → subagent/end ────┐
 子代理摘除 → agent/disposed ──┤
 父代理状态变 → agent/status ──┼─→ 该 claim 名下还有**在飞**子代理吗?
 看门狗(每 30s)──────────────┘      ├─ 有 → hold(超 maxHoldMs ⇒ 强制放行 + warning + 闩锁)
                                     ├─ 读不到活代理表 → hold(M2:本 tick 不判定,保留 claim)
                                     └─ 无 → roundsStarted >= maxGoalRounds ?
                                              ├─ 是 → ctx.goals.block(code=round-limit)
                                              └─ 否 → ctx.goals.resume(ref)  [放行,自带重发]

 闩锁复核(M1,挂在上面四条触发点上)──→ 当前在飞集合 ≠ 闩锁记下的那一批?
                                          ├─ 是 → 当场作废闩锁(门控恢复)
                                          └─ 否 → 留着(防"兜底放行被当场撤销"的活锁)
```

**为什么门控只在 `idle`**(不在 `subagent/start`):压住 = disarm = 把进程内 activation 翻成
`disarmed`,而 driver 的停车闸门全都以 `activation === "armed"` 为**前提条件** ——
`turn/end` 的 aborted 分支(`:266-269`)走 `disarm(state)`,而 `disarm` 自己是
`if (currentGoal(state)?.activation === "armed")`(`:87-93`);`agent/status` idle 里那条
durable `pause`(`:219-227`)也要求 `armed`。**在父代理 running 期间 disarm 会把这些制动整条废掉**,
而且孩子结算后的 `resume` 还会把目标重新开起来(现象:"我按了停止,它自己又跑起来")。
driver 只在 `status === "idle"` 时开新轮(`readyToDrive`,`:79-81`),所以只在 idle 压住完全够用。

**但"只在 idle 压住"还不够 —— 凡是能让 driver 的 `attempt.cancelled` 成真的路径都必须让位**:被 abort
的那一轮若**已有 driver 预约**(attempt 处于 `claimed`/`admitted`),driver 的停车动作就发生在
**`agent/status` idle 那一次派发里**(`:219-227`),而门控 listener prepend 在它前面
(`cordis/lib/index.js:336` 的 `unshift`)⇒ 插件先 disarm,那条 `goal.activation === "armed"` 判据随即
为假 ⇒ durable pause 不写、孩子结算后还会被 `resume` 撤销(现象同样是"按了停止又跑起来")。
所以凡是能让 driver 把预约标成 cancelled 的路径,插件都先记一个**一次性**的"让位标记",并在该 agent
下一次 `agent/status(idle)` 上**跳过门控并丢弃 claim**(不 disarm、不建 claim、不 recompute),把这次
idle 完整让给 driver:有预约 ⇒ 它写 durable pause;没预约 ⇒ 它自己的 `disarm(state)`(`:266-269`)照常
执行。两条置位路径:

- `session/event` 的 `turn/end` + `reason.kind === "aborted"`。cause 是闭合联合
  `user` / `parent` / `disposed` / `hook`(`:731-745`)—— **只有 `user` 是"用户按停止"**,其余
  (父代理取消 / 会话销毁 / hook)一律按"叫停让位"措辞(`用户叫停[cause=user]` /
  `叫停让位[cause=parent]`),免得日志误导排查;
- `agent/inbox/discarded` 且被丢弃的是**已排队的 goal 轮**(`source.kind === "goal" && source.round > 0`):
  `cancel()` **无条件** `inbox.clear()`(`:815-821`,只有 `keepInbox` 才跳过),`clear()` 就是两次
  splice(`:93-96`)⇒ **idle 状态下被 cancel 时没有 turn、也就没有 `turn/end`**,这条是唯一信号
  (driver 在 `:249-252` 据此标 cancelled)。判据与 driver 的 `isGoalRoundSource`(`:32-34`)同源,
  故意**不含 `round === 0`**(那是目标初始消息,丢弃它不代表取消某一轮)。

标记用完即清(代理被摘除时也顺手清);中间可能夹着若干整轮(`kick()` 是 `while (await this.turn())`,
`turn()` 在 `inbox.hasPending` 时返回 true ⇒ 可连跑多个 turn 完全不经 idle),标记必须活过它们 ——
driver 的 `attempt.cancelled` 同样一直在,durable pause 仍会在下一次 idle 写出。

只用官方公开服务,消息流一个字节都不碰:

| 手段 | 为什么是它 |
| --- | --- |
| `ctx.goals.disarm(agent)` | **纯进程内**操作(`dsh-goal/lib/index.js:622-627`),不写会话、不改 phase/revision;`drive()` 开头查 `activation !== "armed"` 直接 return(`dsh-goal-round-driver:124`)⇒ 不续轮,且**不产生任何 blocked code** |
| `ctx.goals.resume(agent, ref)` | 写一条 durable `goal/change`(operation=resume,revision+1)并 emit `goal/changed` → 命中 driver 的 listener → `requestDrive`(`:231-236`)⇒ **放行自带重发路径**,本插件不需要注入任何消息 |
| `ctx.goals.block(agent, ref, {code:'round-limit'})` | 额度用尽时 resume 必抛(`:686-699` 的 fold 约束)⇒ 必须自己 block,否则 driver 被压住时**永远**不会执行它自己的 round-limit 检查(`:125-131`) |
| `agent/status` + `{prepend:true}` | `requestDrive` 同步走到 `agent.followup`,预约发生在 driver 自己的 listener 内、同一次派发中 ⇒ 只有 prepend 抢得到(`cordis/lib/index.js:335-345` 的 `unshift`) |
| 事件监听一律 `{global:true}` | subagent / agent 事件按**作用域**分发(subagent 的 carrier、agent 的 `scopeTarget(agent, agent)`);`global` 让 `hook.global \|\| !filter \|\| filter.call(...)` 短路放行(`cordis/lib/index.js:258-264`),不赌本插件 ctx 落在对方 filter 子树里 |

**明确不做**(三条已证实有害的写法,一律不实现):

- `agent/pre-step` reject 掉 goal 轮 → driver 会 durable block(code=`prompt-rejected`)(`:314-321`);
- 用 `{kind:"enter", messages:[…]}` 摘掉 goal 消息、或从 inbox 丢弃 → 下一次 idle 被
  `ctx.goals.pause()` 打成 durable pause(`:219-227`);
- 在 running 期间改 activation(见上)。

## 3. "在飞子代理"怎么判(v0.2.0 立,v0.2.1 补 pending)

```js
// lib/gate.js —— 判据本体(childInFlight / activeChildIds)
在飞(孩子) = ① child.status !== 'idle'            // running,或读不到(非字符串 / 不认识的取值)
            ∨ ② child.pending !== false           // inbox 还有排队消息,或读不到(H1)
            ∨ ③ child 名下还有活着的后代(任意深度)  // ⇒ 它自己还没结算
// 「不在飞」= 三条同时不成立 = status === 'idle' ∧ inbox 空 ∧ 名下无活后代
// activeChildIds(children, self) = 活代理表里 owner 指向 self、且"在飞"的那些孩子的 id
// needsGate / planGate / planReArm / childKey 全部只用这个列表 —— 判据与闩锁指纹同一口径。
```
> ①②都写成"**不是**某个确定值"而不是"等于某个值":判据方向是**只有能证明它没活干,才判不在飞**。
> 所以 `status` 读到不认识的值、`inbox` 形态不符,一律按"在飞"处理(保守)。

**为什么不能只看"在不在活代理表里"**(v0.1.0 的做法):dsh 的**结算(`subagent/end`)与
摘除(`agent/disposed`)是两件事**,而本插件问的是"这孩子**还有没有活要干**"。

⚠ **因果诚实说明(重要)**:诊断报告
`.dsh/.project/diagnosis/goal-command-coordinator-20260929.md` §1d 把协调者会话的"0 轮"归因于
"孩子已结算但仍驻留注册表",**这个因果没有被直接观测过**。按 dsh 自己的结算规则反推
(`dsh-subagent/lib/index.js:1201-1206` 的 `settlementState()`:只有
`inbox.hasPending || ownedChildren.size > 0` 才 `"wait"`,否则 `"ready"` ⇒ 立刻 `dispose`),
一个**长期驻留**的孩子必然"在跑 / 有待办 / 名下有孩子" —— 这三种在本插件的判据里**都仍然算在飞**。
⇒ 本插件在协调者会话里能放开的,主要是"孩子已经没事、正在被 dispose"的那段窗口;
**"0 轮"更可能的成因是报告 §3 自己给的那条** —— 会话常态就有在跑/待办的孩子,门本来就该关着。
真要缩短等待,直接杠杆是 `maxHoldMs`(报告方案 B),不是判据。**待真机复现确认。**

**`status` 与 `pending` 这两个字段为什么可信**(DSH `0.1.7-rc.2` 安装树逐行核过):

| # | 证据 | 位置 |
| --- | --- | --- |
| 1 | **契约**:`AgentStatus = 'idle' \| 'running'`;`readonly status: AgentStatus` —— "The current lifecycle state, mirrored on every `agent/status` transition" | `dsh-agent/lib/types/runtime-types.d.ts:83-90, 146-147` |
| 2 | **实现是现算 getter,不是缓存值**:`get status() { return this.phase.kind === 'idle' \|\| this.phase.kind === 'maintenance' ? 'idle' : 'running' }`;`setPhase` 先改 phase、再按"状态真的变了"emit `agent/status` ⇒ 读到的永远是此刻的值 | `dsh-agent-loop/lib/index.js:790-799` |
| 3 | **来源对得上**:`ctx.agents.list()` 给的就是这些 Agent 实例本身(`[...this.store.values()].map((entry) => entry.agent)`),不是投影 / 快照对象 | `dsh-agent/lib/index.js:612-614` |
| 4 | **dsh 自己的同源字段**:`runningDescendants()` 遍历 `ctx.agents.list()`、用 `child.status === "running"` 判"子代理在不在跑",供 `workspace/session-activity` 与 `workspace/session-stop` 使用。⚠ **只是"同源字段",不是"同一个口径"**:它另外还做了三件本插件没做的事 —— ①按 `session.header.origin === "subagent"` 过滤(`:2271-2272`,fork 不算)②用**耐久** header 的 `parentSession` 走血缘(`:2272-2276`,本插件用**运行时** owner)③只认 `status === "running"`(本插件更宽:还认 pending / 有后代 / 读不到)。本插件的判据**更保守**,方向与"绝不误放行"一致;不要照抄它的 fork 过滤(那会变成"正在跑的 fork 不压门",是另一个要单独讨论的行为改动) | `dsh-subagent/lib/index.js:2268-2290`(用点 `:2244-2259`) |
| 5 | **本机已验收插件的同款用法**:`dsh-host-sl` v0.7.1 判"名下子代理在跑" | `dsh-host-sl/lib/index.js:548` |
| 6 | **`pending` 的契约**:`readonly inbox: Inbox`;`Inbox.nextTurn` / `nextStep` 都是 `readonly UserMessage[]`("Prompts awaiting individual turns" / "Input awaiting the next step boundary") | `dsh-agent/lib/types/runtime-types.d.ts:41-45, 145` |
| 7 | **`pending` 的读法**:`ReactLoopInbox` 的三个 getter,`hasPending` = `nextTurn.length > 0 \|\| nextStep.length > 0`;`dsh-subagent` 的 `SubagentInbox.hasPending` 用**同一条读法**,而它是 `settlementState()` 判"这个孩子还不能结算"的依据之一 | `dsh-agent-loop/lib/index.js:79-91`;`dsh-subagent/lib/index.js:684-686` |

**为什么 `status` 单独不够(H1,v0.2.1 补)**:`get status()` 把 `phase.kind === 'maintenance'`
也算成 `'idle'`(`dsh-agent-loop:790-792`),而 maintenance 期间进来的活只置 `wakeRequested = true`、
**不改 status 也不 emit**(`:854-858`),要等 maintenance 结束才被唤醒(`:841`)。
⇒ "maintenance 中 + inbox 有排队消息"的孩子读出来是 `idle`,其实马上还要干活。
可达路径:`/compact`(`dsh-command-compact:55` → `dsh-compaction-basic:988 compactNow`)、
`initializeAgent`(`dsh-agent-loop:1887`)。**只看 status 会让门在那一刻误开**,所以判据加了 ②。

**第 ③ 条("名下还有活着的后代")为什么等于"它还没结算"**:`ownedChildren` 的加入 / 移除
(`acquireOwnership` `:1139-1144` / `releaseOwnership` `:1146-1148`)与注册表里的 owner 关系**同源**
—— 两者都由 `agents.create({parentAgent})` 建立(`dsh-agent/lib/index.js:477-491`:"factory-backed
creation uses `options.parentAgent` for child ownership")⇒ 注册表里还有一个 owner 指向它的活代理,
就说明它名下还有未结算的孩子,**它自己不可能已经结算**。深度取任意层(孙 / 曾孙……),否则
"孩子先结算、孙子还在跑"时会误开门(旧 W8)。

⚠ **读不到就保守按住**(`status` / `pending` 任一读不到):那等于退回 v0.1.0 的旧判据。真机上不会发生
(证据 1–3、6–7),这是"宁可多压一会儿、也绝不因为读不到而误放行"的兜底 —— 误放行 = 空转烧额度,
正是本插件要修的东西。**同一个原则也用在"活代理表整表读不到"上**(M2,见第 5 节末)。

⚠ **不要**用 `ctx.subagents.listChildren()` / `listDescendants()`:那是耐久目录,含早已结算的子代理、
没有 liveness 字段,拿它当"在跑"会让目标永远不放行。

**改动前后对照**(一句话版):

| | `activeChildIds` 的判据 | 依据 |
| --- | --- | --- |
| v0.1.0 | 孩子**在活代理表里** ∧ `isOwnedBy(child, self)` | 注册表存在性(`ctx.agents.list()` + `isOwnedBy`) |
| v0.2.0 | 再加一层:孩子**在飞** —— `status !== 'idle'` ∨ 名下有活着的后代 | `status`(证据 1–5)+ owner 链 |
| v0.2.1 | 再加 **H1** 的 ②:`inbox` 还有排队消息(或读不到)也算在飞 | `inbox`(证据 6–7) |

## 4. 配置(装载行的 `config`,全部可省)

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关;`false` ⇒ 不订阅任何事件、不做任何门控 |
| `observeOnly` | `false` | 只观察:判定照跑、日志照打,**绝不改状态**(上线前先这样跑一段) |
| `watchdogIntervalMs` | `30000` | 看门狗周期 |
| `maxHoldMs` | `1800000`(30 min) | 单个 claim 最长持有时间;超时仍未放行 ⇒ 记 warning 并**强制放行** |

非法值一律退回默认并打一条 warning —— **绝不抛回 loader**(apply 抛错会让整行插件加载失败)。
`goals` / `agents` 服务拿不到时**强制降级为 observeOnly**。

## 5. 安全兜底(硬要求:绝不出现"忘记 re-arm 导致目标永久停摆")

1. `subagent/end` / `agent/disposed` / `agent/status` 每次都重算;
2. 看门狗每 30s 重算全部 claim;
3. claim 超过 `maxHoldMs` 仍未放行 ⇒ 强制放行 + warning;
4. 强制放行那一刻的 **(goal 身份 + 子代理集合)** 上**闩锁**(`RELEASED`,指纹见 `lib/gate.js` 的
   `latchKey`):同一个 goal 的同一批孩子还活着就不再压回去 —— 否则兜底放行会被同一个门控判据当场
   撤销,变成 30 分钟一次的活锁;**换 goal(`/goal clear` 后新建)或集合一变(结算/新委派)闩锁立即作废**;
   指纹**故意不含 revision**(`resume` 自己会 +1,编进去会让闩锁当场作废 ⇒ 活锁)。
   ⚠ **"集合一变就作废"必须主动去观测(M1,v0.2.1 修)**:只在 `planGate` 里比一次当次快照是不够的 ——
   同一批孩子"先停再跑"会让快照**绕回原值**(`goal-1:c1` → `goal-1:` → `goal-1:c1`),闩锁就一直生效、
   门对该目标静默失效。所以另有 `refreshLatches()`:任何一次 `agent/status` 变化、`subagent/end`、
   `agent/disposed`、看门狗 tick,只要发现"当前在飞集合 ≠ 闩锁记下的那一批",**当场作废**。
   挂在 `agent/status` 上是必须的:兜底放行之后 claim 已交还,`subagent/end` / `agent/disposed` 两处
   会因 `CLAIMS.size === 0` 提前 return,看门狗也重算不到任何 claim —— 孩子"停"的那一刻是快照绕回
   原值**之前**唯一的观测点。顺带修掉 W7(代理已被摘除时闩锁条目当场清);
5. `disarm` 抛错时**保留** claim:真实现是 `assertLive` → `setActivation`(**先翻 activation、同步 emit
   `goal/activation-changed`**)→ 读 projection(`dsh-goal/lib/index.js:622-627`,可抛)⇒ emit 之后抛错
   意味着 activation 已经是 `disarmed` 而没人负责放行;丢 claim 会让目标永久停在 `active+disarmed`,
   保留则看门狗下一 tick 重判(已翻 ⇒ hold/resume 放行;没翻 ⇒ 判 `already-armed` 自己丢掉);
6. **活代理表读不到时不判定(M2,v0.2.1 修)**:`ctx.agents.list()` 抛错 ⇒ `records()` 返回 `null`
   (**不是 `[]`**),一路透传给 `planGate` / `planReArm` 的 `children-unreadable` 分支 ——
   `planGate` 返回 `none`(不动手)、`planReArm` 返回 `hold`(保留 claim)、**闩锁一个都不动**。
   旧实现把读失败当空表,而空表在下游的含义是 `no-active-child`(不压住)/ `children-settled`
   (**提前放行**)—— 方向与"保守"完全相反。现在等下一 tick(事件 / 看门狗)重判;
7. 插件卸载/热重载时(disposer)尽力放行一次;放不掉的在日志里点名,并**保留** claim
   —— claims 在模块作用域,配置热加载复用同一个模块实例,新实例接着管。

## 6. 归属安全(不覆盖别人的决定)

`goal/activation-changed`(`dsh-goal/lib/index.js:789-806`)用来判断 activation 变化是不是本插件造成的:

- 自置标志 `selfAction > 0`(包住每一次 disarm/resume/block 调用)期间的变化 ⇒ 忽略;
- 其余一律**丢弃 claim** —— 人工 `/goal resume`、或 driver 因 `max-tokens` / `agent/error` / `aborted`
  做的 disarm,本插件一律让位;
- 该事件在 projection 缺失时会提前 return(`:794-796`)⇒ 靠 claim 超时兜底(第 5 节第 3 条);
- 让位标记(`turn/end` aborted / `agent/inbox/discarded` 丢弃 goal 轮)另走一条更硬的路径:
  下一次 idle 直接跳过门控并丢 claim,连"压住"都不做(见第 2 节末)。

## 7. 日志(重启后照着核对)

**双写**:`ctx.logger`(命名 logger `goal-subagent-gate`)+ `console`(宿主 stdout,被看门狗收进
`<工具目录>\dsh-watchdog-dsh.log`)。只写 logger 是不够的 —— cordis 自带的 exporter 只往内存
buffer 塞(`cordis/lib/index.js:598`),dsh-app-boot 那个 exporter 只要 warn/error
(`dsh-app-boot/lib/index.js:4056-4066`,`levels:{default:2}`)⇒ **info 级在真机上只有 stdout 查得到**。
`debug` 只进 logger(不刷 stdout)。

装载时:`apply v0.2.1:…` / `自检:goals 服务=可用 agents 服务=可用 已有 claim=0 已有闩锁=0 订阅=[…]` /
`看门狗已挂:每 30000ms 复核全部闩锁 + 重算全部 claim;…` /
`装载扫描完成:活代理 N 个(idle K 个参与判定),压住 M 个`。

每次动手一行,都含 agentId / goalId / revision / **在飞子代理数**
(v0.1.0 的日志写的是"活跃子代理=",v0.2.0 起改叫"在飞子代理=" —— 判据变了,名字跟着改):

```
[goal-subagent-gate] disarm[agent/status:idle] agent=p1 goal=goal-1 rev=3 在飞子代理=1 累计 disarm=1(goal 停在 active+disarmed:…)
[goal-subagent-gate] 不压住[agent/status:idle] agent=p1 goal=goal-1:名下 2 个子代理都已结算(不在飞;判据=v0.2.1 的 status==='running' ∨ inbox 有排队消息 ∨ 名下有活后代)⇒ 门控放行,driver 可正常续轮
[goal-subagent-gate] re-arm[agent/disposed:c1] agent=p1 goal=goal-1 rev=3 在飞子代理=0 依据=children-settled 累计 re-arm=1(已写 durable resume ⇒ …)
[goal-subagent-gate] block[watchdog] agent=p1 goal=goal-1 rev=7 code=round-limit roundsStarted=25/25 在飞子代理=0 依据=round-limit 累计 block=1
[goal-subagent-gate] 闩锁作废[agent/status:idle] agent=p1:goal 或子代理集合已变(原=goal-1:c1 现=goal-2:c1)⇒ 门控恢复
[goal-subagent-gate] 闩锁作废[agent/status:idle:c1] agent=p1:goal 或子代理集合已变(原=goal-1:c1 现=goal-1:)⇒ 门控恢复   ← M1:同一批孩子"先停" ⇒ 闩锁当场作废(旧实现这里什么都不打,闩锁一直留着)
[goal-subagent-gate] disarm 失败[agent/status:idle] agent=p1 goal=goal-1:<原因> ⇒ 保留 claim,30000ms 后重判(…)
[goal-subagent-gate] 拍平活代理表失败(本 tick 不判定,保留 claim 等下一 tick):<原因>   ← M2:warn,读不到表时不动手
[goal-subagent-gate] 用户叫停[cause=user] agent=p1 trigger=agent/status:idle:跳过门控并丢 claim(不 disarm、不建 claim、不 resume) ⇒ 本次 idle 让给 driver 的停车闸门(有预约 ⇒ durable pause;无预约 ⇒ 它自己的 disarm)
[goal-subagent-gate] 叫停让位[cause=inbox-discarded] agent=p1 trigger=agent/status:idle:跳过门控并丢 claim(…)   ← idle 状态下被 cancel(inbox 丢弃已排队的 goal 轮)
[goal-subagent-gate] 丢 claim[goal/activation-changed] agent=p1 goal=goal-1 原因=activation-changed-by-other(disarmed)(不改状态)
```

其中 **`不压住[…]` 是 v0.2.0 新增的一行**,专门用来正面确认"孩子都没事了 ⇒ 门放开"生效:
它出现的条件恰好是"注册表里确实有孩子、但一个都不在飞、且目标正 `armed`"。
没有这一行就只能靠"没有 disarm 行"反推,而"没有日志"既可能是放行了、也可能是插件没跑。

核对方法:`Select-String -Path <工具目录>\dsh-watchdog-dsh.log -Pattern 'goal-subagent-gate'`。

## 8. 装载 / 生效 / 回退

装载(不要用 `dsh plugin add`,它会丢 bundles 更新;在 profile 目录下执行):

```bash
node <工作区>\dsh\dsh-plugin-manager\dshpm.mjs add file:./plugins/dsh-host-goal-subagent-gate --profile desktop
```

生效:`cordis.patch.yml` 的 insert 行(本包内)走**热加载**;`lib/*.js` 的代码改动必须重启 dsh。

回退一行开关(不卸包):

```yaml
- insert:
    - id: goal-subagent-gate
      name: 'dsh-host-goal-subagent-gate'
      config: { enabled: false }     # 或先 config: { observeOnly: true } 只观察
```

彻底回退:

```bash
node <工作区>\dsh\dsh-plugin-manager\dshpm.mjs remove dsh-host-goal-subagent-gate --profile desktop
# 再删 plugins\dsh-host-goal-subagent-gate 与 node_modules\dsh-host-goal-subagent-gate
```

## 9. 边界与已知取舍

- **不是能力边界**:本插件只调 activation,任何会话都能照常委派子代理、照常被门控;它不改工具权限。
- **只看得见"进程内活代理表里的孩子"**:判据全部来自 `ctx.agents.list()` + `isOwnedBy`,所以
  **出进程 / 远程子代理永远不被门控**(表里查不到 ⇒ `childInFlight` 返回 false;插件自己的用例
  `plugin.test.mjs` 里"查不到 owner 的 subagent/start"正断言这种情况不动状态)。推论:若一个本地孩子
  正在等一个**进程外**的后代(它不在本地表里),本插件看不见那层后代 —— 只要本地孩子自己 `idle`、
  inbox 空、名下没有**本地**活后代,就会被判"不在飞"。这是 v0.2.0 起判据变窄带来的**已知风险**,
  真机上未观测到。
- **v0.2.0 起"活跃"= 在飞(status / inbox / 名下有活后代),不再等于"在活代理表里"**:已结算、inbox 空、
  名下没有活后代的孩子**不再**压住门(见第 3 节);在跑 / 有待办 / 名下有孩子的照旧压住 —— 防空转的
  本意没丢。**注意第 3 节那条因果诚实说明:能因此放开的窗口很窄**。
- **孩子停跑但既不结算也不摘除时,放行最多晚一个看门狗周期(默认 30s)**:释放触发点仍是
  `subagent/end` / `agent/disposed` / `agent/status`(claim 持有者自己) + 看门狗,本次**没有**新增
  "孩子转 idle 就去重算别人的 claim"这条触发(v0.2.1 新增的 `refreshLatches` 只管闩锁,不管 claim)。
  真机上 continuable 孩子自然结算时会走 `dispose → agent/disposed`
  (`dsh-subagent/lib/index.js:1239,1246`),所以这条路径通常几十毫秒内就放行;30s 只是兜底上界。
- **门控期间该会话不会自动续轮**:子代理跑 10 分钟,目标就等 10 分钟 —— 这正是本插件的目的;
  人随时可以手动 `/goal resume` 或直接发消息。
- **插件被彻底卸载时**:disposer 会尽力放行;若那一刻仍有在飞子代理,目标会停在 `active+disarmed`
  (日志会点名 agent id),需要重新启用本插件或人工 resume。
- **claim 被丢弃时目标同样会停在 `active+disarmed`(没人自动放行)**,不只在"叫停/卸载"两处:
  `recompute()` 里 `live !== claim.agent`(`agent-not-live`:claim 持有者已不是注册表里那个实例)也走
  `dropClaim`,日志是 `丢 claim[… 原因=agent-not-live]`。此时同样需要重新启用本插件或人工
  `/goal resume`。
- **用户叫停后的目标状态**:叫停时若本插件正压着该目标,插件丢 claim 后目标停在 `active+disarmed`
  —— 即"停下等人工",不会自己续上;人工 `/goal resume` 可再开(这是"用户按停止"应有的语义)。
- **`/goal edit` 不清闩锁**:兜底放行后对**同一目标**执行 `/goal edit`(同 id、revision+1、仍 armed,
  `dsh-goal:657-669`)不会作废闩锁(指纹不含 revision,见第 5 节第 4 条)⇒ 该目标在那批孩子还活着时
  **不再被门控**;换 id(`/goal clear` 后新建)才会恢复门控。这是"不含 revision"的代价(好处是
  `resume` 自己 +1 时不会把兜底放行当场作废)。

### 复核报告里已记录的低优先项(W2–W10)

逐条记一句(影响 + 触发条件);**已修的标注版本**,其余**没有改代码**:

- **W2**:父代理 running 且名下仍有在飞子代理时,人工 `/goal resume` 会被**下一次 idle 的门控当场压
  回去**(那一轮等于白 resume);在 idle 时 resume 正常,能换来一轮。
- **W3**:`maxHoldMs` 的兜底时钟随 claim 重建而重置 ⇒ 只要**不断有新子代理被委派**(子代理集合一变
  就换指纹、旧闩锁作废、下次 idle 建新 claim),目标可被**无限期**压在 `active+disarmed`;与"绝不永久
  停摆"的措辞不符,但符合"有活在跑就别烧轮次"的意图。
- **W4**:`resume` / `block` **持续抛错**时 claim 不释放(故意保留重试),目标停在 `active+disarmed`,
  期间只有每 30s 一条 warn;需人工介入或等 projection / agent 恢复。
- **W6**:带着 claim 把插件**热切成** `observeOnly` 或 `enabled:false` 时,**新实例**的判定路径整个不跑
  (`planReArm` 在 `!enabled` 时直接 `none`;`observeOnly` 时只记日志、不丢 claim)⇒ 新实例自己
  放不掉这些 claim。**实测过的时序**(见本节末的探针):cordis 的 `fiber.update(newConfig)`
  (`cordis/lib/index.js:1427-1442`)走 `restart()` → `_setEpoch(INACTIVE)` → `_unload()`
  (`:1372-1392`,先跑**旧** fiber 的 disposer)→ 再 `_reload()`(`:1349-1371`)跑新 `apply`
  ⇒ 旧 disposer 闭包里捕获的是**旧配置**(`enabled:true`),它会**先**把 claim 放行一次。
  所以实际结果是"通常会被放行一次",但这是**隐式**行为:它依赖上面那条"旧 disposer 先于新 apply"的
  时序,不是本插件的显式保证。**要放行请以"重新启用本插件"或人工 `/goal resume` 为准。**
- **W7**:~~代理被摘除后,它的 `RELEASED` 闩锁条目要等下一次该 agent 的 `gateCheck` 才清~~
  **v0.2.1 已修**:`refreshLatches` 在 `agent/disposed` 与看门狗 tick 上都会清掉"代理已不在活代理表"
  的孤儿闩锁。
- ~~**W8**:只统计**直接**孩子 ⇒ 直接孩子先结算/摘除、**孙子代理**仍在跑时门会打开(级联释放未验证)。~~
  **v0.2.0 已修**:`childInFlight` 第 ③ 条沿 owner 链看**任意深度**的后代(见第 3 节),孙子 / 曾孙
  还在时孩子仍算在飞。回归用例:`gate.test.mjs` 的 `hasLiveDescendant` 与回归③。
- **W9**:claim 一直放不掉时,看门狗每 30s 打 2 行(判定 debug + 失败 warn),**持续失败路径会刷
  stdout**;稳态(无 claim)不刷。
- **W10**(v0.2.0 引入,v0.2.1 措辞已对齐实现):第 ③ 条判的是"名下还有**活着的**后代",不是
  "名下还有**在跑的**后代" —— 注册表里读不到"孩子是否已结算"这个状态(`ownedChildren` 是
  dsh-subagent 的内部集合,没有公开读法)。取"活着"是**偏保守**的一侧:它可能多压一会儿
  (孙代理 idle 但还没摘除),但不会误开门。按 dsh 自己的结算规则,这种状态本来就只存在于
  "孙代理即将被摘除"的窗口内。
- **W11**(v0.2.1 新增):`refreshLatches` 的观测是**机会性**的 —— 它只在"插件被调到"的那些时刻比快照。
  如果同一批孩子在**两次观测之间**停又跑(理论上需要孩子"停"时连一次 `agent/status` 派发都没发生),
  闩锁仍会漏。实际不可能:status 变化必然 emit(`dsh-agent-loop:793-799`),而本插件的 listener 是
  `global:true`,每次派发都会跑到。列在这里只为说明"这条修复依赖事件一定送达"。

**W6 的实测依据**(v0.2.1 复核时用一次性探针跑的,探针已删):用安装树里的
`@deepseek-ai/cordis` 4.0.4 起一个最小 Context,注册一个带 `ctx.effect(() => () => …)` 的插件,
然后 `fiber.update({enabled:false})`,输出是:
```
apply        : 本次 apply 收到的 config={"enabled":true,"observeOnly":false}
--- 现在把配置热切成 enabled:false ---
disposer 跑了: 它闭包里捕获的 config={"enabled":true,"observeOnly":false}      ← 旧配置,先跑
apply        : 本次 apply 收到的 config={"enabled":false,"observeOnly":false}    ← 新配置,后跑
```

## 10. 测试

```bash
node --test "test/*.test.mjs"     # 47 项(24 + 23)
```

| 文件 | 覆盖 |
| --- | --- |
| `test/gate.test.mjs` | `lib/gate.js` 纯函数 24 项:门控三态、observeOnly 不动状态、放行四态(hold/resume/block/drop)、超时兜底、**闩锁键含 goal 身份且不含 revision**、**闩锁对同 id 的 `/goal edit` 不失效(W1 残留)**、配置合法化、拍平与 owner 反查,以及"在飞"判据本身:`childInFlight`(running / idle / inbox 有排队 / 读不到 / 不认识)、`hasLiveDescendant`(任意深度 + 环安全)、`ownedChildIds` vs `activeChildIds`,加六条判据回归(**①③④** 是判据回归,见下)、**H1**(maintenance 里带 pending 仍压门)、**M2**(`children === null` ⇒ `planGate` 不动手且不动闩锁 / `planReArm` 走 hold) |
| `test/plugin.test.mjs` | 用**假宿主**驱动真实插件 23 项:装载自检、`agent/status` 确实 prepend、**同一次 idle 派发里 driver 看到 disarmed**、claim 全生命周期、额度用尽走 block、observeOnly、归属安全、看门狗兜底+闩锁、**S1 回归**(start 不改 activation / abort 与 max-tokens 的 driver 闸门完好)、**让位标记**(abort + 有预约 + 有在飞子代理 ⇒ durable pause 必须写出、插件不得 disarm/resume;已压住时叫停 ⇒ 丢 claim 不放行;**N1** idle 状态下 cancel 走 `agent/inbox/discarded` 也让位,且非 goal / `round=0` 的丢弃不置位;**N2** 标记跨多个整轮不经 idle 仍然有效)、**W1 回归**(换 goal 后闩锁作废)、**W5 回归**(disarm 抛错保留 claim)、**判据回归 4 条** + **H1 / M1 / M2 各 1 条**(端到端,见下)、卸载收尾 |

**"判据回归"具体是哪几条**(别把守卫也算进来):

- ①已结算仍驻留的孩子不再压门 —— **判据回归**(旧判据会 disarm);
- ②running 的孩子仍压门 —— **不是判据回归,是"本意不变"守卫**:它在旧判据与全部变异实验下**都通过**,
  作用是防止"为了让 ① 成立而把门整个拆掉";
- ③孩子自己 idle 但名下有未结算孙代理 ⇒ 仍压门 —— **判据回归**;
- ④孩子结算(转 idle + inbox 空)后 claim 重算 ⇒ resume —— **判据回归**;
- **H1**(v0.2.1):status=idle 但 inbox 有排队(maintenance)⇒ 仍压门 —— **判据回归**;
- **M1**(v0.2.1):闩锁期内同一批孩子"先停再跑" ⇒ 门控恢复 —— **判据回归**;
- **M2**(v0.2.1):活代理表读不到 ⇒ 不 disarm / 不提前放行 / 保留 claim —— **判据回归**。

假宿主的 `addAgent(id, ownerId, status = 'idle', pending = false)` **第三、四个参数就是门控判据**:
每个用例都必须显式声明它站在哪一边(`'running'` 压门 / `'idle'`+空 inbox 不压门 /
`'idle'`+`pending:true` = H1 的 maintenance 仍压门 / 传 `null` 读不到 ⇒ 保守压门)。
另有 `setPending(agent, bool)`(模拟 inbox 收放,**不改 status 也不 emit**,照 `dsh-agent-loop:854-858`)
与 `breakAgentsList(bool)`(让 `ctx.agents.list()` 抛错,复现 M2)。

看门狗用例用 `waitFor()` 轮询等待(最多 5s)而不是固定 `sleep(1300)`:interval=1000ms 只差 300ms,
机器一忙就会抢跑成假红;断言仍逐字比对最终调用序列。

假宿主的 `goals` 服务按**真契约**校验(`assertLive` / `expectCurrent` 逐字比对 id+revision /
`resume` 拒绝 active+armed 与额度用尽 / `block`、`pause` 只接受 active / `disarm` 先翻 activation
再读 projection),对 stale-ref、非法转移、缺 `assertLive` 这类缺陷不会失明;假宿主还遵守
**`agent.id === session.id`** 这条真不变量(注册表按共享 agent/session id 寻址,`session → agent`
反查才成立),`session/event` 也必须传注册表里那个 session 实例(同一实例校验)。
`test/` 不在 `package.json` 的 `files` 白名单里 ⇒ **不进运行副本**,从源码目录跑。

## 许可

MIT License —— 全文见 [LICENSE](LICENSE)。Copyright (c) 2026 liuyun847。
