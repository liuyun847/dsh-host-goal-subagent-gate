/**
 * dsh-host-goal-subagent-gate / test/gate.test.mjs
 *
 * lib/gate.js 纯函数的行为固定(脱离宿主跑:`node --test "test/*.test.mjs"`)。
 * 覆盖:门控三态(无子代理 / 有在飞子代理 / goal 状态不对)、observeOnly 不动状态、
 * 放行四态(hold / resume / block / drop)、超时兜底、闩锁键(goal 身份 + 在飞子代理集合)、
 * 闩锁对同 id 的 `/goal edit` **不**失效(已知取舍,见 W1 残留用例)、
 * 配置合法化、拍平与 owner 反查,
 * 以及"在飞"判据本身(`childInFlight` / `hasLiveDescendant` / `ownedChildIds`)与四条回归:
 * ①已结算仍驻留的孩子不压门、②正在跑的孩子压门、③名下有未结算孙代理的孩子压门、④孩子结算后能放行;
 * v0.2.1 另加两条:**H1**(status=idle 但 inbox 有排队消息 ⇒ 仍压门)、
 * **M2**(活代理表读不到 ⇒ 本 tick 不判定)。
 *
 * ⚠ 本目录**不进运行副本**(package.json 的 files 白名单不含 test),测试从源码目录跑。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULTS,
  activeChildIds,
  childInFlight,
  childKey,
  findOwnerId,
  hasLiveDescendant,
  isRoundLimit,
  latchKey,
  needsGate,
  ownedChildIds,
  planGate,
  planReArm,
  resolveConfig,
  snapshotAgents,
} from '../lib/gate.js'

/** 一份"已武装"的 goal 视图(只保留判定用到的字段)。 */
const armedGoal = (over = {}) => ({
  id: 'goal-1',
  revision: 3,
  phase: 'active',
  activation: 'armed',
  roundsStarted: 1,
  maxGoalRounds: 25,
  ...over,
})

/** 拍平表:父代理 p1 名下有一个**正在跑**的子代理 c1。 */
const oneChild = [{ id: 'p1', status: 'idle' }, { id: 'c1', ownerId: 'p1', status: 'running' }]

/** 拍平表:父代理 p1 名下有 c1 / c2 两个**正在跑**的子代理。 */
const twoChildren = [
  { id: 'p1', status: 'idle' },
  { id: 'c1', ownerId: 'p1', status: 'running' },
  { id: 'c2', ownerId: 'p1', status: 'running' },
]

/**
 * p1 名下只有一个**已结算但仍驻留注册表**的孩子:status 已是 idle、inbox 空、名下也没有后代。
 * ⚠ `pending: false` 必须显式给:缺这个键 = "读不到 inbox" ⇒ 判定侧保守按在飞(见 childInFlight)。
 */
const settledChild = [
  { id: 'p1', status: 'idle' },
  { id: 'c1', ownerId: 'p1', status: 'idle', pending: false },
]

/** p1 的孩子 c1 自己已 idle,但它名下还有一个在跑的孙子 g1 ⇒ c1 仍算在飞(它还没结算)。 */
const childWithGrandchild = [
  { id: 'p1', status: 'idle' },
  { id: 'c1', ownerId: 'p1', status: 'idle', pending: false },
  { id: 'g1', ownerId: 'c1', status: 'running' },
]

/**
 * H1 场景:孩子正处在 **maintenance** 阶段 —— `get status()` 把 `phase.kind === 'maintenance'`
 * 也折叠成 `'idle'`(`dsh-agent-loop:790-792`),而 maintenance 期间进来的活只置
 * `wakeRequested = true`、不改 status 也不 emit(`:854-858`),等 maintenance 结束才唤醒(`:841`)。
 * ⇒ "status=idle + inbox 还有排队消息" = **马上还要干活**,必须算在飞。
 */
const maintenanceChild = [
  { id: 'p1', status: 'idle' },
  { id: 'c1', ownerId: 'p1', status: 'idle', pending: true },
]

const cfg = (over = {}) => resolveConfig(over)

test('resolveConfig:默认值 / 非法值降级 / 未知键告警', () => {
  assert.deepEqual(
    { ...cfg(), warnings: [] },
    { ...DEFAULTS, warnings: [] },
  )
  const bad = cfg({ enabled: 'no', observeOnly: 1, watchdogIntervalMs: 10, maxHoldMs: 0, nope: true })
  assert.equal(bad.enabled, true)
  assert.equal(bad.observeOnly, false)
  assert.equal(bad.watchdogIntervalMs, DEFAULTS.watchdogIntervalMs)
  assert.equal(bad.maxHoldMs, DEFAULTS.maxHoldMs)
  assert.equal(bad.warnings.length, 5)
  assert.deepEqual(cfg({ enabled: false, observeOnly: true }), {
    enabled: false, observeOnly: true, watchdogIntervalMs: DEFAULTS.watchdogIntervalMs, maxHoldMs: DEFAULTS.maxHoldMs, warnings: [],
  })
})

test('snapshotAgents / findOwnerId:反查 owner;谓词抛错按"非该 owner"处理;status / pending 原样带上', () => {
  const p1 = { id: 'p1', status: 'idle' }
  const c1 = { id: 'c1', status: 'running' }
  const c2 = { id: 'c2', inbox: { nextTurn: [{ id: 'm1' }], nextStep: [] } } // 读得到 pending,读不到 status
  const c3 = { id: 'c3' } // 两个都读不到(真机上不会发生:list() 给的是真 Agent 实例)
  const table = { c1: p1, c2: c1, c3: c1 }
  const records = snapshotAgents([p1, c1, c2, c3], (id, owner) => {
    if (id === 'boom') throw new Error('x')
    return table[id] === owner
  })
  assert.deepEqual(records, [
    { id: 'p1', status: 'idle' },
    { id: 'c1', ownerId: 'p1', status: 'running' },
    { id: 'c2', ownerId: 'c1', pending: true }, // inbox 读得到 ⇒ 写这个键
    { id: 'c3', ownerId: 'c1' }, // 两个都读不到 ⇒ 都不写 ⇒ 判定侧按"未知"保守处理
  ])
  assert.equal(findOwnerId(records, 'c2'), 'c1')
  assert.equal(findOwnerId(records, 'p1'), undefined)
  assert.equal(findOwnerId(records, 'ghost'), undefined)
  assert.equal(childInFlight(records, 'c2'), true, 'H1:pending=true ⇒ 在飞')
  assert.equal(childInFlight(records, 'c3'), true, 'status / pending 都读不到 ⇒ 保守按在飞')
})

test('childInFlight:running / inbox 有排队 / 名下有活后代 ⇒ 在飞;idle+空 inbox+无后代 ⇒ 不在飞', () => {
  assert.equal(childInFlight(oneChild, 'c1'), true, 'status=running ⇒ 在飞')
  assert.equal(childInFlight(settledChild, 'c1'), false, 'idle + inbox 空 + 无后代 ⇒ 不在飞')
  assert.equal(childInFlight(maintenanceChild, 'c1'), true, 'H1:idle 但 inbox 有排队(maintenance)⇒ 在飞')
  assert.equal(childInFlight(childWithGrandchild, 'c1'), true, '自己 idle 但名下有活后代 ⇒ 在飞(它还没结算)')
  assert.equal(childInFlight(childWithGrandchild, 'g1'), true)
  // 读不到 / 取值不认识 ⇒ 保守按在飞:等价于 v0.1.0 的旧判据,绝不因"读不到"而误放行
  assert.equal(childInFlight([{ id: 'p1' }, { id: 'c1', ownerId: 'p1' }], 'c1'), true, 'status 与 pending 都缺')
  assert.equal(childInFlight([{ id: 'p1' }, { id: 'c1', ownerId: 'p1', status: 'weird', pending: false }], 'c1'), true, 'status 取值不认识')
  assert.equal(childInFlight([{ id: 'p1' }, { id: 'c1', ownerId: 'p1', status: 'idle' }], 'c1'), true, 'pending 读不到')
  // 表里没有这个 id(非本进程子代理 / 已摘除)⇒ 不在飞
  assert.equal(childInFlight(oneChild, 'ghost'), false)
  assert.equal(childInFlight(null, 'c1'), false)
})

test('hasLiveDescendant:任意深度的活后代;只看后代不看自己;环安全', () => {
  const deep = [
    { id: 'p1' }, { id: 'c1', ownerId: 'p1' }, { id: 'g1', ownerId: 'c1' }, { id: 'gg1', ownerId: 'g1' },
  ]
  assert.equal(hasLiveDescendant(deep, 'p1'), true)
  assert.equal(hasLiveDescendant(deep, 'c1'), true)
  assert.equal(hasLiveDescendant(deep, 'g1'), true)
  assert.equal(hasLiveDescendant(deep, 'gg1'), false, '叶子没有后代')
  assert.equal(hasLiveDescendant(deep, 'ghost'), false)
  // 自环 / 互环:visited 兜住,不会无限走
  assert.equal(hasLiveDescendant([{ id: 'a', ownerId: 'a' }], 'a'), false)
  assert.equal(hasLiveDescendant([{ id: 'a', ownerId: 'b' }, { id: 'b', ownerId: 'a' }], 'a'), true)
  assert.equal(hasLiveDescendant(null, 'a'), false)
})

test('ownedChildIds / activeChildIds:"注册表里有谁" ≠ "谁在飞"', () => {
  const mixed = [
    { id: 'p1', status: 'idle' },
    { id: 'c1', ownerId: 'p1', status: 'running' },
    { id: 'c2', ownerId: 'p1', status: 'idle', pending: false },
    { id: 'g1', ownerId: 'c2', status: 'running' },
    { id: 'x1', ownerId: 'other', status: 'running' },
  ]
  assert.deepEqual(ownedChildIds(mixed, 'p1'), ['c1', 'c2'], '注册表里的直接孩子:两个')
  assert.deepEqual(activeChildIds(mixed, 'p1'), ['c1', 'c2'], 'c2 自己 idle 但名下有在跑的 g1 ⇒ 仍在飞')
  assert.deepEqual(ownedChildIds(mixed, 'c2'), ['g1'])
  assert.deepEqual(ownedChildIds(mixed, 'ghost'), [])
  assert.deepEqual(ownedChildIds(null, 'p1'), [])
})

test('activeChildIds:只算"自己名下且在飞"的,排掉自身、别人的孩子与已结算驻留的', () => {
  assert.deepEqual(activeChildIds(oneChild, 'p1'), ['c1'])
  assert.deepEqual(activeChildIds(oneChild, 'c1'), [])
  assert.deepEqual(activeChildIds([{ id: 'p1', ownerId: 'p1' }], 'p1'), [])
  assert.deepEqual(activeChildIds(null, 'p1'), [])
  assert.deepEqual(activeChildIds(settledChild, 'p1'), [], '已结算仍驻留的孩子不算在飞')
  assert.deepEqual(activeChildIds(maintenanceChild, 'p1'), ['c1'], 'H1:maintenance 里有待办 ⇒ 算在飞')
  assert.deepEqual(activeChildIds(childWithGrandchild, 'p1'), ['c1'])
})

test('needsGate:无子代理 → false;有在飞子代理 + active&armed → true', () => {
  assert.equal(needsGate([{ id: 'p1' }], armedGoal(), 'p1'), false)
  assert.equal(needsGate(oneChild, armedGoal(), 'p1'), true)
  assert.equal(needsGate(settledChild, armedGoal(), 'p1'), false, '结算后驻留的孩子不再压门')
  assert.equal(needsGate(maintenanceChild, armedGoal(), 'p1'), true, 'H1')
  assert.equal(needsGate(oneChild, armedGoal({ activation: 'disarmed' }), 'p1'), false)
  assert.equal(needsGate(oneChild, armedGoal({ phase: 'paused' }), 'p1'), false)
  assert.equal(needsGate(oneChild, undefined, 'p1'), false)
  // ⚠ 读不到活代理表时它也返回 false —— 那是"不知道",不是"没有";真实决策走 planGate。
  assert.equal(needsGate(null, armedGoal(), 'p1'), false)
})

test('childKey / latchKey:闩锁指纹 = goal 身份 + **在飞**子代理集合,且**故意不含 revision**', () => {
  assert.equal(childKey(twoChildren, 'p1'), 'c1,c2')
  assert.equal(latchKey(armedGoal(), twoChildren, 'p1'), 'goal-1:c1,c2')
  // revision 变了、goal id 没变 ⇒ 指纹不变。resume 自己会把 revision +1,编进键里会让
  // 兜底放行写下的闩锁在下一个 idle 当场作废 ⇒ 退化成"每 maxHoldMs 放行一次"的活锁。
  assert.equal(latchKey(armedGoal({ revision: 99 }), twoChildren, 'p1'), 'goal-1:c1,c2')
  // 换 goal ⇒ 指纹变(缺陷 W1 的判据)
  assert.notEqual(latchKey(armedGoal({ id: 'goal-2' }), twoChildren, 'p1'), latchKey(armedGoal(), twoChildren, 'p1'))
  // goal 缺失 / 没有在飞子代理
  assert.equal(latchKey(undefined, twoChildren, 'p1'), ':c1,c2')
  assert.equal(latchKey(armedGoal(), [{ id: 'p1' }], 'p1'), 'goal-1:')
  assert.equal(latchKey(armedGoal(), settledChild, 'p1'), 'goal-1:', '已结算驻留的孩子不进指纹')
  assert.equal(latchKey(armedGoal(), maintenanceChild, 'p1'), 'goal-1:c1', 'H1:有待办的孩子进指纹')
})

test('planGate:无子代理 / goal 不 armed / 关掉 → 不 disarm;有在飞子代理 + armed → disarm', () => {
  const g = (args) => planGate({ config: cfg(), ...args })
  assert.deepEqual(g({ goal: armedGoal(), children: [{ id: 'p1' }], selfAgentId: 'p1' }), {
    action: 'none', reason: 'no-active-child', apply: false, active: 0, key: 'goal-1:', clearLatch: false,
  })
  assert.deepEqual(g({ goal: armedGoal(), children: oneChild, selfAgentId: 'p1' }), {
    action: 'disarm', reason: 'active-child-with-armed-goal', apply: true, active: 1, key: 'goal-1:c1', clearLatch: false,
  })
  assert.equal(g({ goal: armedGoal({ activation: 'disarmed' }), children: oneChild, selfAgentId: 'p1' }).reason, 'already-disarmed')
  assert.equal(g({ goal: armedGoal({ phase: 'blocked' }), children: oneChild, selfAgentId: 'p1' }).reason, 'phase-blocked')
  assert.equal(g({ goal: undefined, children: oneChild, selfAgentId: 'p1' }).reason, 'no-goal')
  assert.equal(planGate({ config: cfg({ enabled: false }), goal: armedGoal(), children: oneChild, selfAgentId: 'p1' }).action, 'none')
})

test('回归①:已结算但仍驻留注册表的孩子 ⇒ 不 disarm(旧判据在这里会压住门)', () => {
  const plan = planGate({ config: cfg(), goal: armedGoal(), children: settledChild, selfAgentId: 'p1' })
  assert.deepEqual(plan, {
    action: 'none', reason: 'no-active-child', apply: false, active: 0, key: 'goal-1:', clearLatch: false,
  })
  assert.equal(needsGate(settledChild, armedGoal(), 'p1'), false)
})

test('回归②:正在跑的孩子 ⇒ 仍然 disarm(防空转的本意不变)', () => {
  assert.equal(needsGate(oneChild, armedGoal(), 'p1'), true)
  const plan = planGate({ config: cfg(), goal: armedGoal(), children: oneChild, selfAgentId: 'p1' })
  assert.equal(plan.action, 'disarm')
  assert.equal(plan.apply, true)
  assert.equal(plan.active, 1)
  assert.equal(plan.key, 'goal-1:c1')
})

test('回归③:孩子自己 idle 但名下有未结算孙代理 ⇒ 仍然 disarm', () => {
  assert.equal(needsGate(childWithGrandchild, armedGoal(), 'p1'), true)
  const plan = planGate({ config: cfg(), goal: armedGoal(), children: childWithGrandchild, selfAgentId: 'p1' })
  assert.equal(plan.action, 'disarm', '③:孩子名下还有未结算的孙代理 ⇒ 它算在飞')
  assert.equal(plan.active, 1)
  assert.equal(plan.key, 'goal-1:c1', '闩锁指纹只含"在飞"的直接孩子')
})

test('H1 回归:孩子 status=idle 但 inbox 还有排队消息(maintenance 阶段)⇒ 仍然 disarm', () => {
  // dsh-agent-loop:790-792 把 maintenance 折叠成 idle;:854-858 在 maintenance 期间只置 wakeRequested。
  // 只看 status 会判"不在飞"⇒ 门误开、goal 轮与孩子的工作并行。
  assert.equal(needsGate(maintenanceChild, armedGoal(), 'p1'), true)
  const plan = planGate({ config: cfg(), goal: armedGoal(), children: maintenanceChild, selfAgentId: 'p1' })
  assert.equal(plan.action, 'disarm', 'H1:有待办的孩子必须压住门')
  assert.equal(plan.apply, true)
  assert.equal(plan.active, 1)
  assert.equal(plan.key, 'goal-1:c1')
})

test('M2 回归:活代理表读不到(children=null)⇒ planGate 不判定、绝不动闩锁', () => {
  // 旧实现把读失败当空表 ⇒ no-active-child ⇒ 门直接开(方向与"保守"相反)。
  const plan = planGate({ config: cfg(), goal: armedGoal(), children: null, selfAgentId: 'p1' })
  assert.deepEqual(plan, {
    action: 'none', reason: 'children-unreadable', apply: false, active: 0, key: 'goal-1:', clearLatch: false,
  })
  // 关键:即使挂着闩锁也不能因为"读不到"而把它清掉(clearLatch 恒 false)
  const withLatch = planGate({
    config: cfg(), goal: armedGoal(), children: null, selfAgentId: 'p1', releasedKey: 'goal-1:c1',
  })
  assert.equal(withLatch.reason, 'children-unreadable')
  assert.equal(withLatch.clearLatch, false, 'M2:读不到时不得作废闩锁(分不清"变了"与"看不见")')
})

test('M2 回归:活代理表读不到 ⇒ planReArm 走 hold(保留 claim,不提前放行)', () => {
  const claim = { agentId: 'p1', goalId: 'goal-1', since: 1_000 }
  const disarmed = armedGoal({ activation: 'disarmed' })
  // 旧实现:children=[] ⇒ children-settled ⇒ resume(提前放行)
  const plan = planReArm({ config: cfg(), claim, goal: disarmed, children: null, selfAgentId: 'p1', now: 2_000 })
  assert.deepEqual(plan, {
    action: 'hold', reason: 'children-unreadable', apply: false, active: 0, key: 'goal-1:', forced: false,
  })
  // 对照:真的读到"没有在飞孩子"才 resume
  assert.equal(
    planReArm({ config: cfg(), claim, goal: disarmed, children: [{ id: 'p1' }], selfAgentId: 'p1', now: 2_000 }).action,
    'resume',
  )
  // 且读不到时即使 claim 早已超时也**不**强制放行(超时兜底只在真的读到孩子时才有意义)
  const expired = planReArm({ config: cfg({ maxHoldMs: 1 }), claim, goal: disarmed, children: null, selfAgentId: 'p1', now: 99_999 })
  assert.equal(expired.action, 'hold')
  assert.equal(expired.forced, false)
})

test('planGate:强制放行闩锁 —— 同一 goal + 同一批孩子不再压住,集合一变闩锁作废', () => {
  const latch = 'goal-1:c1,c2'
  const latched = planGate({
    config: cfg(), goal: armedGoal(), children: twoChildren, selfAgentId: 'p1', releasedKey: latch,
  })
  assert.deepEqual(latched, {
    action: 'none', reason: 'force-released-latch', apply: false, active: 2, key: 'goal-1:c1,c2', clearLatch: false,
  })
  // 集合变了(c2 结算)⇒ 闩锁作废,门控恢复(此时只剩 c1,仍然要压)
  const changed = planGate({
    config: cfg(), goal: armedGoal(), children: oneChild, selfAgentId: 'p1', releasedKey: latch,
  })
  assert.equal(changed.action, 'disarm')
  assert.equal(changed.clearLatch, true)
  // 集合空了 ⇒ 闩锁作废,但无需动手
  const empty = planGate({ config: cfg(), goal: armedGoal(), children: [{ id: 'p1' }], selfAgentId: 'p1', releasedKey: 'goal-1:c1' })
  assert.equal(empty.action, 'none')
  assert.equal(empty.reason, 'no-active-child')
  assert.equal(empty.clearLatch, true)
})

test('W1 回归:闩锁键含 goal 身份 —— 兜底放行后换新目标,新目标必须继续被门控', () => {
  // 场景:超时强制放行写下了闩锁(那批孩子一个都没结算),人类随后 /goal clear 再建 goal-2。
  const latch = latchKey(armedGoal(), twoChildren, 'p1') // 'goal-1:c1,c2'
  const sameGoal = planGate({
    config: cfg(), goal: armedGoal({ revision: 4 }), children: twoChildren, selfAgentId: 'p1', releasedKey: latch,
  })
  assert.equal(sameGoal.reason, 'force-released-latch', '同一目标(哪怕 resume 把 revision 顶到 4)仍在闩锁内')
  const newGoal = planGate({
    config: cfg(), goal: armedGoal({ id: 'goal-2', revision: 1 }), children: twoChildren, selfAgentId: 'p1', releasedKey: latch,
  })
  assert.equal(newGoal.action, 'disarm', '换了 goal ⇒ 旧闩锁不得短路新目标的门控(旧实现就是在这里静默退化)')
  assert.equal(newGoal.reason, 'active-child-with-armed-goal')
  assert.equal(newGoal.clearLatch, true, '换 goal ⇒ 闩锁必须被清掉')
  assert.equal(newGoal.key, 'goal-2:c1,c2')
})

test('W1 残留:闩锁键不含 revision ⇒ 同 id 的 /goal edit(revision+1、仍 armed)不作废闩锁', () => {
  // `/goal edit` 保持同一 goal id、revision+1,phase 与 activation 不变(dsh-goal:657-669)⇒
  // 指纹不变 ⇒ 兜底放行过的那个目标**不再被门控**。这是"指纹不含 revision"的代价(好处见上一用例:
  // resume 自己会把 revision +1,含进去就会变成每 maxHoldMs 放行一次的活锁)。
  const latch = latchKey(armedGoal(), twoChildren, 'p1') // 'goal-1:c1,c2'
  const edited = planGate({
    config: cfg(), goal: armedGoal({ revision: 4 }), children: twoChildren, selfAgentId: 'p1', releasedKey: latch,
  })
  assert.equal(edited.action, 'none', '同 id 的 edit 不改指纹 ⇒ 该目标不再被门控')
  assert.equal(edited.reason, 'force-released-latch')
  assert.equal(edited.clearLatch, false)
  // 对照:换 id(/goal clear 后新建)才作废闩锁、恢复门控
  const replaced = planGate({
    config: cfg(), goal: armedGoal({ id: 'goal-2', revision: 1 }), children: twoChildren, selfAgentId: 'p1', releasedKey: latch,
  })
  assert.equal(replaced.action, 'disarm')
  assert.equal(replaced.clearLatch, true)
})

test('planGate / planReArm:observeOnly ⇒ apply=false(判定照出,但不改状态)', () => {
  const observe = cfg({ observeOnly: true })
  const gate = planGate({ config: observe, goal: armedGoal(), children: oneChild, selfAgentId: 'p1' })
  assert.equal(gate.action, 'disarm')
  assert.equal(gate.apply, false)
  const rearm = planReArm({
    config: observe, claim: { agentId: 'p1', goalId: 'goal-1', since: 0 }, goal: armedGoal({ activation: 'disarmed' }),
    children: [{ id: 'p1' }], selfAgentId: 'p1', now: 1,
  })
  assert.equal(rearm.action, 'resume')
  assert.equal(rearm.apply, false)
})

test('planReArm:子代理还有活 → hold(不改状态);真的没活了 → resume', () => {
  const claim = { agentId: 'p1', goalId: 'goal-1', since: 1_000 }
  const disarmed = armedGoal({ activation: 'disarmed' })
  const hold = planReArm({ config: cfg(), claim, goal: disarmed, children: oneChild, selfAgentId: 'p1', now: 2_000 })
  assert.deepEqual(hold, { action: 'hold', reason: 'children-running(1)', apply: false, active: 1, key: 'goal-1:c1', forced: false })
  // H1:maintenance 里有待办 ⇒ 也是 hold
  assert.equal(
    planReArm({ config: cfg(), claim, goal: disarmed, children: maintenanceChild, selfAgentId: 'p1', now: 2_000 }).action,
    'hold',
  )
  const settle = planReArm({ config: cfg(), claim, goal: disarmed, children: [{ id: 'p1' }], selfAgentId: 'p1', now: 2_000 })
  assert.deepEqual(settle, { action: 'resume', reason: 'children-settled', apply: true, active: 0, key: 'goal-1:', forced: false })
})

test('回归④:孩子结算(转 idle + inbox 空)后 claim 重算 ⇒ resume;孙代理还挂着时仍 hold', () => {
  const claim = { agentId: 'p1', goalId: 'goal-1', since: 1_000 }
  const disarmed = armedGoal({ activation: 'disarmed' })
  // 孩子在跑 ⇒ hold(claim 不交还)
  assert.equal(
    planReArm({ config: cfg(), claim, goal: disarmed, children: oneChild, selfAgentId: 'p1', now: 2_000 }).action,
    'hold',
  )
  // 孩子结算(仍在注册表里,但 status=idle + inbox 空 + 名下无后代)⇒ resume
  assert.deepEqual(
    planReArm({ config: cfg(), claim, goal: disarmed, children: settledChild, selfAgentId: 'p1', now: 2_000 }),
    { action: 'resume', reason: 'children-settled', apply: true, active: 0, key: 'goal-1:', forced: false },
  )
  // 孩子自己 idle,但名下还有未结算的孙代理 ⇒ 仍然 hold
  const stillHeld = planReArm({ config: cfg(), claim, goal: disarmed, children: childWithGrandchild, selfAgentId: 'p1', now: 2_000 })
  assert.equal(stillHeld.action, 'hold')
  assert.equal(stillHeld.active, 1)
})

test('planReArm:额度用尽 → block(而不是 resume);roundsStarted 与 driver 判据同源', () => {
  const claim = { agentId: 'p1', goalId: 'goal-1', since: 1_000 }
  const exhausted = armedGoal({ activation: 'disarmed', roundsStarted: 25, maxGoalRounds: 25 })
  assert.equal(isRoundLimit(exhausted), true)
  assert.equal(isRoundLimit(armedGoal({ activation: 'disarmed', roundsStarted: 24 })), false)
  const plan = planReArm({ config: cfg(), claim, goal: exhausted, children: [{ id: 'p1' }], selfAgentId: 'p1', now: 2_000 })
  assert.deepEqual(plan, { action: 'block', reason: 'round-limit', apply: true, active: 0, key: 'goal-1:', forced: false })
})

test('planReArm:claim 超时仍未放行 → 强制 resume + forced + 带回闩锁指纹(安全兜底)', () => {
  const claim = { agentId: 'p1', goalId: 'goal-1', since: 0 }
  const plan = planReArm({
    config: cfg({ maxHoldMs: 1_000 }), claim, goal: armedGoal({ activation: 'disarmed' }),
    children: oneChild, selfAgentId: 'p1', now: 1_000,
  })
  assert.deepEqual(plan, { action: 'resume', reason: 'claim-expired', apply: true, active: 1, key: 'goal-1:c1', forced: true })
  const planBlock = planReArm({
    config: cfg({ maxHoldMs: 1_000 }), claim, goal: armedGoal({ activation: 'disarmed', roundsStarted: 30, maxGoalRounds: 25 }),
    children: oneChild, selfAgentId: 'p1', now: 99_999,
  })
  assert.equal(planBlock.action, 'block')
  assert.equal(planBlock.forced, true)
})

test('planReArm:别人已处置 / 状态变了 → drop(不覆盖别人的决定)', () => {
  const claim = { agentId: 'p1', goalId: 'goal-1', since: 0 }
  const base = { config: cfg(), claim, children: [{ id: 'p1' }], selfAgentId: 'p1', now: 1 }
  assert.equal(planReArm({ ...base, goal: armedGoal() }).reason, 'already-armed')
  assert.equal(planReArm({ ...base, goal: armedGoal({ activation: 'disarmed', phase: 'paused' }) }).reason, 'phase-paused')
  assert.equal(planReArm({ ...base, goal: armedGoal({ activation: 'disarmed', phase: 'complete' }) }).reason, 'phase-complete')
  assert.equal(planReArm({ ...base, goal: armedGoal({ activation: 'disarmed', phase: 'blocked' }) }).reason, 'phase-blocked')
  assert.equal(planReArm({ ...base, goal: armedGoal({ activation: 'disarmed', id: 'goal-2' }) }).reason, 'goal-changed')
  assert.equal(planReArm({ ...base, goal: undefined }).reason, 'no-goal')
  assert.equal(planReArm({ ...base, claim: undefined, goal: armedGoal({ activation: 'disarmed' }) }).action, 'none')
  assert.equal(planReArm({ ...base, config: cfg({ enabled: false }), goal: armedGoal({ activation: 'disarmed' }) }).action, 'none')
})
