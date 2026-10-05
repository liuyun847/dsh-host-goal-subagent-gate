/**
 * dsh-host-goal-subagent-gate / lib/gate.js
 *
 * 本插件的**全部判定逻辑**(纯函数:零依赖、不碰 ctx、无副作用)。
 * lib/index.js 只做两件事:把宿主服务里的活对象拍平成这里要的纯数据,再按判定结果调 ctx.goals.*。
 * 拆开的原因:判定可以脱离宿主单测(见 test/gate.test.mjs),出故障时能逐条对照"输入 → 结论"。
 *
 * 数据形状约定(故意用最小字段,便于构造用例):
 *   children = [{ id, ownerId?, status? }]  —— 活代理表拍平结果
 *              · ownerId 缺失表示"无主的根代理";
 *              · status 只在**读得到字符串**时出现(`Agent.status`,`'idle' | 'running'`),
 *                读不到就不写这个键 ⇒ 判定侧按"未知"保守处理(见 {@link childInFlight})。
 *   goal      = { id, revision, phase, activation, roundsStarted, maxGoalRounds } | undefined
 *   claim     = { agentId, goalId, revision, since }
 *
 * 两条判定:
 *   planGate  —— 该不该**压住**(disarm):名下有**在飞**子代理 + goal 仍 armed ⇒ 动手;
 *                闩锁短路额外要求 goal 身份也相同({@link latchKey},缺陷 W1)。
 *   planReArm —— 该不该**放行**(resume/block/drop/hold):claim 还在、名下没有在飞子代理 ⇒ 放行。
 *
 * ⚠ **v0.2.0 的判据变更(本文件的核心)**:"在飞" ≠ "在活代理表里"。
 *   v0.1.0 只看"注册表里有没有这个孩子"⇒ 已结算但仍驻留的 continuable 子代理会一直压住门,
 *   兜底只剩 maxHoldMs(默认 30 min);实测协调者会话里目标因此长期停在 `active+disarmed`
 *   (诊断报告 `.dsh/.project/diagnosis/goal-command-coordinator-20260929.md` §1d/§3)。
 *   现在只有 ①它自己 `status === 'running'`,或 ②名下还有活着的后代(⇒ 它自己还没结算)才算在飞;
 *   判据与依据见 {@link childInFlight} / {@link hasLiveDescendant}。
 */

/** 配置默认值。`maxHoldMs` 是"绝不永久停摆"的兜底时限(见 planReArm 的 forced 分支)。 */
export const DEFAULTS = {
  /** 总开关:false ⇒ 不订阅任何事件、不做任何门控。 */
  enabled: true,
  /** 只观察:判定照跑、日志照打,但绝不改 goal 状态。 */
  observeOnly: false,
  /** 看门狗周期(毫秒):定期重算所有 claim,兜住"事件没来"的情形。 */
  watchdogIntervalMs: 30_000,
  /** 单个 claim 的最长持有时间(毫秒):超时仍未放行 ⇒ 记 warning 并强制放行。 */
  maxHoldMs: 30 * 60_000,
}

/** 取一个合法正整数字段;非法(非整数 / 小于 min)一律退回默认值并记一条 warning 文案。 */
function positiveInt(value, fallback, min, name, warnings) {
  if (value === undefined) return fallback
  if (Number.isSafeInteger(value) && value >= min) return value
  warnings.push(`${name}=${JSON.stringify(value)} 非法(需 ≥ ${min} 的安全整数)⇒ 退回默认 ${fallback}`)
  return fallback
}

/** 取一个合法布尔字段;非 true/false 一律退回默认值并记一条 warning 文案。 */
function boolField(value, fallback, name, warnings) {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  warnings.push(`${name}=${JSON.stringify(value)} 非法(需布尔)⇒ 退回默认 ${fallback}`)
  return fallback
}

/**
 * 合法化插件配置。**绝不抛错**:apply 抛错会让整行插件加载失败(宿主起不来的历史教训),
 * 所以非法值只降级成默认值,并把原因放进 warnings 交调用方打日志。
 * @param {unknown} config - 装载行(patch 的 insert 条目)传来的 config。
 * @returns {{enabled:boolean, observeOnly:boolean, watchdogIntervalMs:number, maxHoldMs:number, warnings:string[]}}
 */
export function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const warnings = []
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    warnings.push(`config=${JSON.stringify(config)} 不是对象 ⇒ 整份配置按默认值处理`)
  }
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULTS)) warnings.push(`未知配置项 ${key}=${JSON.stringify(raw[key])} 已忽略`)
  }
  return {
    enabled: boolField(raw.enabled, DEFAULTS.enabled, 'enabled', warnings),
    observeOnly: boolField(raw.observeOnly, DEFAULTS.observeOnly, 'observeOnly', warnings),
    watchdogIntervalMs: positiveInt(raw.watchdogIntervalMs, DEFAULTS.watchdogIntervalMs, 1000, 'watchdogIntervalMs', warnings),
    maxHoldMs: positiveInt(raw.maxHoldMs, DEFAULTS.maxHoldMs, 1000, 'maxHoldMs', warnings),
    warnings,
  }
}

/**
 * 把宿主注册表拍平成纯数据。
 *
 * 为什么用 `isOwnedBy` 反查 owner:dsh-agent 的注册表只有 `isOwnedBy(id, owner)`
 * (`dsh-agent/lib/index.js:605-607`,实现是 `store.get(id)?.owner === owner`),**没有 ownerOf**;
 * `ctx.agents.list()`(`:612-614`)给的是全部活代理。两两比对即可得到 owner 关系
 * (活代理数量是常数级小,几十个以内,O(n²) 可接受)。
 *
 * 为什么顺带抄 `status` 与 `pending`(v0.2.0 / v0.2.1):判定"还有没有活要干"靠这两个 ——
 *   · `list()` 返回的是**真 Agent 实例**(`dsh-agent/lib/index.js:612-614` 的
 *     `[...this.store.values()].map((entry) => entry.agent)`),契约上有
 *     `readonly status: AgentStatus`(`'idle' | 'running'`,`runtime-types.d.ts:83-90,146-147`)
 *     与 `readonly inbox: Inbox`(`:145`);
 *   · `status` 是**现算的 getter**(`dsh-agent-loop/lib/index.js:790-792`),不是缓存值;
 *   · `status` **单独不够**(H1,见 {@link childInFlight}),所以还要抄 inbox 的排队长度。
 * 逐条证据见 {@link childInFlight} / {@link readPending}。
 *
 * ⚠ 判据是**进程内 liveness**(活代理表),不是 `ctx.subagents.listChildren()` —— 后者读的是
 *   耐久目录,含早已结算的子代理、且没有 liveness 字段,拿它当"在跑"会让目标永远不放行。
 *
 * @param {Array<{id:string}>} agents - `ctx.agents.list()` 的结果(或任何含 id 的对象)。
 * @param {(id:string, owner:unknown)=>boolean} isOwnedBy - `ctx.agents.isOwnedBy`。
 * @returns {Array<{id:string, ownerId?:string, status?:string, pending?:boolean}>} 拍平结果;
 *   谓词抛错按"非该 owner"处理(不炸);`status` 非字符串、`pending` 读不到时**不写对应键**
 *   (判定侧一律按"未知 ⇒ 保守按住"处理)。
 */
export function snapshotAgents(agents, isOwnedBy) {
  const list = Array.isArray(agents) ? agents.filter((a) => a !== null && typeof a === 'object' && typeof a.id === 'string') : []
  const out = []
  for (const child of list) {
    let ownerId
    for (const owner of list) {
      if (owner.id === child.id) continue
      let owned = false
      try {
        owned = isOwnedBy(child.id, owner) === true
      } catch {
        owned = false
      }
      if (owned) {
        ownerId = owner.id
        break
      }
    }
    const record = ownerId === undefined ? { id: child.id } : { id: child.id, ownerId }
    if (typeof child.status === 'string') record.status = child.status
    const pending = readPending(child)
    if (typeof pending === 'boolean') record.pending = pending
    out.push(record)
  }
  return out
}

/**
 * 读一个 agent 的 inbox 里**还有没有排队消息**(H1 的判据来源)。
 *
 * 契约出处:
 *   · `dsh-agent/lib/types/runtime-types.d.ts:145` —— `readonly inbox: Inbox`
 *     ("Agent-owned access to durable pending work");
 *   · 同文件 `:41-45` —— `interface Inbox { readonly nextTurn: readonly UserMessage[]  // Prompts awaiting individual turns
 *                                            readonly nextStep: readonly UserMessage[] } // Input awaiting the next step boundary`
 * 实现出处:`dsh-agent-loop/lib/index.js:79-91` 的 `ReactLoopInbox`,三个 getter 逐字是
 *   `nextTurn` / `nextStep` / `hasPending`(`hasPending` = `nextTurn.length > 0 || nextStep.length > 0`)。
 *   ⇒ 本函数与 dsh 自己的 `hasPending` **同源同义**。
 * 同源先例:`dsh-subagent/lib/index.js:684-686` 的 `SubagentInbox.hasPending` 用**同一条读法**
 *   (`this.agent.inbox.nextTurn.length > 0 || this.agent.inbox.nextStep.length > 0`),
 *   而它正是 `settlementState()`(`:1201-1206`)判"这个孩子还不能结算"的依据之一。
 *
 * 为什么需要它(单看 `status` 会漏):`status` 把 `phase.kind === 'maintenance'` 也算成 `'idle'`
 *   (`dsh-agent-loop:790-792`),而 maintenance 期间进来的活只置 `wakeRequested = true`、
 *   **不改 status 也不 emit**(`:854-858`),要等 maintenance 结束才被唤醒(`:841`)。
 *   ⇒ "maintenance 中 + inbox 有排队消息"的孩子读出来是 `idle`,其实马上还要干活。
 *
 * @param {object} agent - `ctx.agents.list()` 的元素。
 * @returns {boolean|undefined} 读得到就 true/false;形态不符(拿不到 inbox / 不是数组)返回 undefined
 *   —— 判定侧按"未知 ⇒ 保守按住"处理,绝不因为读不到而误判"没活干"。
 */
function readPending(agent) {
  const inbox = agent?.inbox
  if (inbox === null || typeof inbox !== 'object') return undefined
  const nextTurn = inbox.nextTurn
  const nextStep = inbox.nextStep
  if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) return undefined
  return nextTurn.length > 0 || nextStep.length > 0
}

/** 在拍平表里查一条记录(查不到 = 非本进程子代理 / 尚未进注册表)。 */
function findChild(children, childId) {
  if (!Array.isArray(children)) return undefined
  return children.find((c) => c !== null && typeof c === 'object' && c.id === childId)
}

/** 在拍平表里查一个 child 的 owner id(查不到 = 非本进程子代理 / 尚未进注册表)。 */
export function findOwnerId(children, childId) {
  return findChild(children, childId)?.ownerId
}

/**
 * `childId` 名下有没有**活着的后代**(任意深度)。
 *
 * 为什么"有活后代"就等于"它自己还没结算":dsh-subagent 的自然结算判据是
 * `settlementState()`(`dsh-subagent/lib/index.js:1201-1206`)——
 * `activation.inbox.hasPending || activation.ownedChildren.size > 0` ⇒ `"wait"`,
 * 即**名下还有驻留孩子时它自己不结算**(只有 `"ready"` 才会走到 `dispose`)。
 * 而 `ownedChildren` 的加入/移除(`acquireOwnership` `:1139-1144` / `releaseOwnership` `:1146-1148`)
 * 与注册表里的 owner 关系同源:两者都由 `agents.create({parentAgent})` 建立
 * (`dsh-agent/lib/index.js:477-491`,"factory-backed creation uses `options.parentAgent` for child ownership")。
 * ⇒ "注册表里还有一个 owner 指向它的活代理"是"它名下还有未结算的孩子"的**可靠代理**:
 *   这种状态下它**不可能**已经结算。
 *
 * 深度是任意的(孙 / 曾孙……):只认"直接孩子"会让"孩子先结算、孙子还在跑"时误开门(旧 W8)。
 * `visited` 防环(血缘损坏成环时不会无限走)。
 *
 * @param {Array} children - {@link snapshotAgents} 的产物。
 * @param {string} childId - 起点(不含自己,只看它名下)。
 * @returns {boolean} 名下是否存在活着的后代。
 */
export function hasLiveDescendant(children, childId) {
  if (!Array.isArray(children)) return false
  const seen = new Set([childId])
  const queue = [childId]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const candidate of children) {
      if (candidate === null || typeof candidate !== 'object') continue
      if (typeof candidate.id !== 'string') continue
      if (candidate.ownerId !== current) continue
      if (seen.has(candidate.id)) continue
      seen.add(candidate.id)
      queue.push(candidate.id)
    }
  }
  return seen.size > 1
}

/**
 * 一个子代理是否**仍在飞**(仍该压住门)。**门控判据核心(v0.2.0 立,v0.2.1 补 pending)。**
 *
 * 规则(判据方向:只有能**证明**它已经没活干,才判"不在飞"):
 *   · `status === 'running'` 或 `status` 不是字符串(读不到) ⇒ **在飞**;
 *   · `pending !== false`(`inbox` 还有排队消息,或读不到)      ⇒ **在飞**(H1);
 *   · 名下还有活着的后代                                       ⇒ **在飞**;
 *   · 三条都不成立(即 `status === 'idle'` ∧ `pending === false` ∧ 名下无活后代)⇒ **不在飞**。
 *
 * ⚠ 为什么不能只看 `status`(H1,复核打红的那条):`get status()` 把 `phase.kind === 'maintenance'`
 *   也算成 `'idle'`(`dsh-agent-loop:790-792`),而 maintenance 期间进来的活只置
 *   `wakeRequested = true`、**不改 status 也不 emit**(`:854-858`),要等 maintenance 结束才唤醒
 *   (`:841`)。可达路径:`/compact`(`dsh-command-compact:55` → `dsh-compaction-basic:988 compactNow`)、
 *   `initializeAgent`(`dsh-agent-loop:1887`)。⇒ 只看 status 会把"马上还要干活的孩子"判成不在飞。
 *   加上 `pending` 后不会退回 v0.1.0 的老毛病:dsh 自己的结算判据要求"已结算"的孩子 inbox 为空
 *   (`settlementState` `dsh-subagent:1201-1206`:`inbox.hasPending || ownedChildren.size > 0` ⇒ `"wait"`)。
 *
 * ⚠ 读不到时**保守按住**是故意的:那等于退回 v0.1.0 的旧判据,绝不会因为"读不到"而误放行
 *   (误放行 = 空转烧额度,正是本插件要修的东西)。
 *
 * `status` 字段的可靠性证据(DSH 0.1.7-rc.2 安装树逐行核过):
 *   1. **契约**:`dsh-agent/lib/types/runtime-types.d.ts:83-90` 定义
 *      `AgentStatus = 'idle' | 'running'`,`:146-147` 定义
 *      `readonly status: AgentStatus` —— "The current lifecycle state, mirrored on every
 *      `agent/status` transition"。
 *   2. **实现是现算 getter,不是缓存值**:`dsh-agent-loop/lib/index.js:790-792`
 *      `get status() { return this.phase.kind === 'idle' || this.phase.kind === 'maintenance'
 *      ? 'idle' : 'running' }`;`setPhase` 先改 phase 再按变化 emit `agent/status`(`:793-799`)
 *      ⇒ 读到的永远是此刻的值,不存在"结算了但字段还写着 running"。
 *      (同一段代码也是 H1 的成因:maintenance 被折叠进 `idle`。)
 *   3. **来源对得上**:`ctx.agents.list()` 返回的就是这些 Agent 实例本身
 *      (`dsh-agent/lib/index.js:612-614`),不是投影 / 快照对象。
 *   4. **dsh 自己的同源字段**:`dsh-subagent/lib/index.js:2268-2290` 的 `runningDescendants()`
 *      遍历 `ctx.agents.list()`、用 `child.status === "running"` 判"子代理在不在跑",供
 *      `workspace/session-activity`(`:2244-2252`)与 `workspace/session-stop`(`:2253-2259`)使用。
 *      ⚠ **只是"同源字段",不是"同一个口径"**:它另外还做了三件本插件没做的事 ——
 *      ① 按 `session.header.origin === "subagent"` 过滤(`:2271-2272`,fork 不算)、
 *      ② 用**耐久** header 的 `parentSession` 走血缘(`:2272-2276`,本插件用**运行时** owner)、
 *      ③ 只认 `status === "running"`(本插件更宽:还认 pending / 有后代 / 读不到)。
 *      本插件的判据**更保守**,方向与"绝不误放行"一致;不要照抄它的 fork 过滤(那会变成
 *      "正在跑的 fork 不压门",是另一个要单独讨论的行为改动)。
 *   5. **本机已验收插件的同款用法**:`dsh-host-sl` v0.7.1 `lib/index.js:548`
 *      (`if (entry?.agent?.status !== 'running') continue` 判"名下子代理在跑")。
 *
 * @param {Array} children - {@link snapshotAgents} 的产物。
 * @param {string} childId - 被判定的子代理 id。
 * @returns {boolean} true = 仍在飞(该压住门)。
 */
export function childInFlight(children, childId) {
  const record = findChild(children, childId)
  if (record === undefined) return false
  if (record.status !== 'idle') return true
  if (record.pending !== false) return true
  return hasLiveDescendant(children, childId)
}

/**
 * 某代理名下**在活代理表里**的子代理 id 列表(排掉自身,防自环)。
 * ⚠ **不判在不在跑** —— 这是"注册表里有谁",不是门控判据;门控判据见 {@link activeChildIds}。
 */
export function ownedChildIds(children, selfAgentId) {
  if (!Array.isArray(children)) return []
  return children
    .filter((c) => c !== null && typeof c === 'object' && c.id !== selfAgentId && c.ownerId === selfAgentId)
    .map((c) => c.id)
}

/**
 * 某代理名下**在飞**的子代理 id 列表 —— **这就是门控判据本身**。
 * v0.1.0 只做 {@link ownedChildIds}("在不在活代理表里");v0.2.0 起再叠一层
 * {@link childInFlight}("还在不在跑"),让"已结算但仍驻留注册表"的孩子不再压住门。
 */
export function activeChildIds(children, selfAgentId) {
  return ownedChildIds(children, selfAgentId).filter((id) => childInFlight(children, id))
}

/**
 * 在飞子代理集合的稳定指纹(排序后逗号连接)。agent id 是 UUID,不含逗号,拼接无歧义。
 * 单看它不足以当闩锁键(不认 goal 身份)⇒ 闩锁一律用 {@link latchKey}。
 */
export function childKey(children, selfAgentId) {
  return activeChildIds(children, selfAgentId).slice().sort().join(',')
}

/**
 * **强制放行闩锁的指纹** = goal 身份 + 在飞子代理集合。
 *
 * 用途:超时**强制放行**之后不能立刻又被压住 —— 否则"兜底放行"会被同一个门控判据当场撤销,
 * 变成 30 分钟一次的活锁。指纹不变 = "还是那个目标、还是那批孩子在跑" ⇒ 不再压。
 *
 * ⚠ 必须带 goal 身份(缺陷 W1):闩锁原本只认子代理集合,于是"超时强制放行 → 人类 `/goal clear`
 *   再建一个新目标、那批孩子还活着"这一串操作会让**新目标永远命中 `force-released-latch`
 *   短路** —— 门控静默退化成"没有本插件"。
 * ⚠ **故意不含 revision**:`resume` 自己就把 revision +1(durable `goal/change`),而闩锁正是在
 *   resume 成功那一刻写下的;若把 revision 编进指纹,下一次 idle 算出的指纹必然不同 ⇒ 闩锁当场
 *   作废、目标立刻被重新压住,兜底放行失效,退化成"每 maxHoldMs 放行一次"的活锁。
 *   goal id 在**同一个目标**的生命周期内稳定(`/goal clear` 后新建必然是新 uuid),足以识别
 *   "换了个目标"。goal id 形如 `goal-<uuid>`,不含冒号,拼接无歧义。
 * ⚠ 集合取的是**在飞**孩子(v0.2.0):孩子从 running 转 idle 会让指纹变化 ⇒ 闩锁当场作废;
 *   但那一刻门控本来也就放行了(`no-active-child`),不会误压,方向是安全的。
 * ⚠ **指纹相等 ≠ 还是同一批活**(M1,v0.2.1 修):同一批孩子"先停再跑"会让快照**绕回原值**
 *   (`goal-1:c1` → `goal-1:` → `goal-1:c1`),光比指纹就会让闩锁一直生效、门对该目标静默失效。
 *   所以闩锁的作废条件**不能只在 `planGate` 里比一次快照**:任何一次判定/复核只要看到"当前集合
 *   与闩锁记下的不同",就当场作废(index.js 的 `refreshLatches`,挂在孩子的 `agent/status` 上)。
 *   详见 README §5 第 4 条。
 *
 * @param {object|undefined} goal - 当前 goal 视图(只取 `id`)。
 * @param {Array} children - {@link snapshotAgents} 的产物。
 * @param {string} selfAgentId - 被判定代理自己的 id。
 * @returns {string} `<goalId>:<childKey>`;goal 缺失时 goalId 是空串(如 `:c1`)。
 */
export function latchKey(goal, children, selfAgentId) {
  const goalId = goal !== undefined && goal !== null && typeof goal.id === 'string' ? goal.id : ''
  return `${goalId}:${childKey(children, selfAgentId)}`
}

/**
 * 门控判据(布尔形态,便于人读与单测):该代理此刻**该不该被压住**。
 * ⚠ 只回答"有在飞子代理 ∧ goal 是 active+armed"。**活代理表读不到(`children === null`)时它返回
 *   `false`** —— 那是"不知道",不是"没有";真实决策一律走 {@link planGate}(它有 `children-unreadable`
 *   分支,读不到时不动手)。
 * @returns {boolean} true 仅当"名下有在飞子代理"且"goal 处于 active + armed"。
 */
export function needsGate(children, goal, selfAgentId) {
  if (activeChildIds(children, selfAgentId).length === 0) return false
  if (goal === undefined || goal === null) return false
  return goal.phase === 'active' && goal.activation === 'armed'
}

/**
 * 门控决策(完整形态)。
 * @param {object} input
 * @param {object} input.config - {@link resolveConfig} 的产物。
 * @param {object|undefined} input.goal - 当前 goal 视图(`ctx.goals.get(agent)`)。
 * @param {Array|null} input.children - {@link snapshotAgents} 的产物;**`null` = 活代理表读不到**(M2)。
 * @param {string} input.selfAgentId - 被判定代理自己的 id。
 * @param {string|undefined} input.releasedKey - 该代理的"强制放行闩锁"指纹({@link latchKey}:goal 身份 + 子代理集合)。
 * @returns {{action:'disarm'|'none', reason:string, apply:boolean, active:number,
 *   key:string, clearLatch:boolean}}
 *   `active` = **在飞**子代理数(v0.2.0 起;不是"注册表里有几个");`children === null` 时恒 0(无意义);
 *   `apply=false` 表示"判定如此,但按配置/状态**不要**真的动手"(observeOnly / disabled / 无需动手);
 *   `clearLatch=true` 表示闩锁指纹已过期,调用方应把闩锁删掉。
 */
export function planGate({ config, goal, children, selfAgentId, releasedKey }) {
  // ── M2(v0.2.1):活代理表**读不到** ⇒ 本 tick 不判定 ──────────────────────────
  // 拿不到表就分不清"名下没有在飞孩子"与"看不到孩子";此时压住是猜、放行也是猜。
  // 方向按"绝不误放行"定:不动手、**绝不动闩锁**(clearLatch 固定 false),调用方保留 claim,
  // 下一 tick(事件 / 看门狗)重判。旧实现把读失败当空表 ⇒ 判 `no-active-child` ⇒ 门直接开。
  if (children === null) {
    return { action: 'none', reason: 'children-unreadable', apply: false, active: 0, key: latchKey(goal, [], selfAgentId), clearLatch: false }
  }
  const active = activeChildIds(children, selfAgentId).length
  // 闩锁指纹**含 goal 身份**(缺陷 W1):换了目标就是换了指纹,旧目标的闩锁绝不会短路新目标的门控。
  const key = latchKey(goal, children, selfAgentId)
  const clearLatch = releasedKey !== undefined && releasedKey !== key
  const base = { active, key, clearLatch }
  if (!config.enabled) return { ...base, action: 'none', reason: 'disabled', apply: false }
  if (active === 0) return { ...base, action: 'none', reason: 'no-active-child', apply: false }
  // 超时强制放行过、且**还是同一个 goal + 同一批子代理**:不再压住(否则兜底放行当场失效,变成活锁)。
  if (releasedKey !== undefined && releasedKey === key) {
    return { ...base, action: 'none', reason: 'force-released-latch', apply: false }
  }
  if (goal === undefined || goal === null) return { ...base, action: 'none', reason: 'no-goal', apply: false }
  if (goal.phase !== 'active') return { ...base, action: 'none', reason: `phase-${goal.phase}`, apply: false }
  if (goal.activation !== 'armed') return { ...base, action: 'none', reason: 'already-disarmed', apply: false }
  return { ...base, action: 'disarm', reason: 'active-child-with-armed-goal', apply: !config.observeOnly }
}

/** 额度判据:与 driver 的 `goal.roundsStarted >= goal.maxGoalRounds`(`dsh-goal-round-driver/lib/index.js:125`)逐字同源。 */
export function isRoundLimit(goal) {
  return goal !== undefined && goal !== null && goal.roundsStarted >= goal.maxGoalRounds
}

/**
 * 放行决策(claim 重算的唯一出口)。
 *
 * 分支顺序即优先级:
 *   0. 活代理表**读不到**(`children === null`) → hold(**本 tick 不判定**,M2:调用方保留 claim)
 *   1. 没 claim / 关掉 / 读不到 goal        → none / drop(读不到时调用方**不丢** claim,等下一 tick)
 *   2. phase 不是 active / goal id 变了     → drop(别人已经处置过,本插件不再插手)
 *   3. 已经 armed                           → drop(别人已放行,claim 作废)
 *   4. 还有在飞子代理                       → hold;超过 maxHoldMs ⇒ 强制放行(兜底,记 warning)
 *   5. 额度用尽                             → block(必须自己补:driver 被压住时永远不会执行它自己的 round-limit 检查)
 *   6. 其余                                 → resume(自带重发路径:goal/change ⇒ driver 的 goal/changed listener ⇒ 下一轮)
 *
 * @returns {{action:'none'|'drop'|'hold'|'resume'|'block', reason:string, apply:boolean, active:number,
 *   key:string, forced:boolean}}
 *   `children === null` 时 `active` 恒 0(无意义,调用方不要拿它做展示)。
 */
export function planReArm({ config, claim, goal, children, selfAgentId, now }) {
  // ── M2(v0.2.1):活代理表读不到 ⇒ 本 tick 不判定 ──────────────────────────────
  // 旧实现把读失败当空表 ⇒ 判 `children-settled` ⇒ **提前 resume**(方向与"保守"完全相反)。
  // 现在改成 hold:不动状态、保留 claim,下一 tick 重判。
  if (children === null) {
    return { action: 'hold', reason: 'children-unreadable', apply: false, active: 0, key: latchKey(goal, [], selfAgentId), forced: false }
  }
  const active = activeChildIds(children, selfAgentId).length
  // 与 planGate 用**同一个**指纹函数:forced 放行时写闩锁,下一次 planGate 才能对上(见 latchKey)。
  const key = latchKey(goal, children, selfAgentId)
  if (!config.enabled) return { action: 'none', reason: 'disabled', apply: false, active, key, forced: false }
  if (claim === undefined || claim === null) return { action: 'none', reason: 'no-claim', apply: false, active, key, forced: false }
  if (goal === undefined || goal === null) return { action: 'drop', reason: 'no-goal', apply: false, active, key, forced: false }
  if (goal.phase !== 'active') return { action: 'drop', reason: `phase-${goal.phase}`, apply: false, active, key, forced: false }
  if (claim.goalId !== undefined && goal.id !== claim.goalId) {
    return { action: 'drop', reason: 'goal-changed', apply: false, active, key, forced: false }
  }
  if (goal.activation === 'armed') return { action: 'drop', reason: 'already-armed', apply: false, active, key, forced: false }

  const age = typeof now === 'number' && typeof claim.since === 'number' ? now - claim.since : 0
  const expired = age >= config.maxHoldMs
  const apply = !config.observeOnly

  if (active > 0 && !expired) {
    return { action: 'hold', reason: `children-running(${active})`, apply: false, active, key, forced: false }
  }
  const forced = active > 0 && expired
  if (isRoundLimit(goal)) {
    return { action: 'block', reason: forced ? 'round-limit-after-hold-timeout' : 'round-limit', apply, active, key, forced }
  }
  return { action: 'resume', reason: forced ? 'claim-expired' : 'children-settled', apply, active, key, forced }
}
