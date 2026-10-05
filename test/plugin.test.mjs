/**
 * dsh-host-goal-subagent-gate / test/plugin.test.mjs
 *
 * 用**假宿主**驱动真实插件模块,固定"事件接线 + claim 生命周期 + prepend 时序 + 门控时机"这些
 * lib/gate.js 纯函数覆盖不到的东西:
 *   · 装载自检日志、agent/status 监听确实 prepend(排在最前);
 *   · prepend 时序:driver 在同一次 idle 派发里看到的是 disarmed(不续轮)—— 这是整个修复的支点;
 *   · **S1 回归**:`subagent/start` 不改 activation;running 期间 goal 保持 armed;门控只在 idle 生效;
 *     用户 abort / max-tokens 时 driver 的 disarm 闸门不再被插件抢先(旧实现下它是 no-op,随后还会被 resume 撤销);
 *   · claim 生命周期:idle 压住 → 孩子还在跑则 hold → 摘除后 resume → driver 正常续轮;
 *   · **v0.2.0 判据回归**(4 条):已结算但仍驻留注册表的孩子**不再**压门(旧判据会 disarm)、
 *     正在跑的孩子**仍然**压门、孩子自己 idle 但名下有未结算孙代理**仍然**压门、孩子结算后能 re-arm;
 *   · 额度用尽走 block(code=round-limit)而不是 resume;
 *   · **W1 回归**:闩锁不认新 goal —— 换目标后必须继续门控;
 *   · **W5 回归**:`disarm` 抛错时保留 claim(否则目标停在 active+disarmed 且无人放行);
 *   · observeOnly 一个状态都不改;归属安全(别人改 activation ⇒ 丢 claim,不抢方向盘);
 *   · 看门狗超时兜底 + 闩锁(常驻子代理长期不结算 ⇒ 兜底放行不被当场撤销,集合一变即恢复);
 *   · 卸载收尾(disposer)不漏放、也不静默。
 *
 * 假宿主的语义与真宿主逐条对齐,不做"随便收下"的宽松桩 —— 否则测试对 stale-ref / 非法转移 /
 * 缺 assertLive 这类缺陷结构性失明:
 *   · goals 服务按真契约校验(dsh-goal/lib/index.js):每个变更方法先 `assertLive`(`:767-769`,
 *     按 id 查到的必须是**同一个对象实例**)、带 ref 的先 `expectCurrent`(`:760-765`,id + revision
 *     逐字相等)、`resume` 拒绝 active+armed(`:696`)与额度用尽(`:697`)、`block`(`:724`)/`pause`
 *     (`:677`)只接受 phase=active;`disarm` 的顺序是 assertLive → setActivation(**同步 emit
 *     `goal/activation-changed`**)→ 读 projection(`:622-627`,可抛)⇒ 注入"翻完 activation 再抛"
 *     就能复现 W5;
 *   · agent 的 status 是 getter(dsh-agent-loop `:790-792`),`setPhase` **先改 status 再 emit**
 *     (`:793-799`)⇒ 假宿主用 setStatus 走同一条路;
 *   · 事件总线按 cordis 的 `prepend ⇒ unshift`(`cordis/lib/index.js:335-345`)派发。
 *
 * ⚠ 本目录不进运行副本(package.json 的 files 白名单不含 test),从源码目录跑。
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

const PLUGIN = new URL('../lib/index.js', import.meta.url)
let seq = 0
/** 每次拿一个**全新的模块实例**(CLAIMS / RELEASED / ABORTED 是模块作用域,用例之间必须隔离)。 */
const loadPlugin = () => import(`${PLUGIN.href}?case=${++seq}`)

/**
 * 轮询等待一个条件成立(默认最多 5s)。看门狗用例**不能用固定 sleep**:interval=1000ms 与
 * sleep=1300ms 只差 300ms,机器一忙就会抢跑成假红(实测出现过一次)。断言仍逐字比对最终序列。
 */
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/**
 * 本插件**双写**日志(ctx.logger + console)。测试里把 console 收进 `consoleLines`,
 * 一是别把用例输出刷满,二是顺便断言"stdout 那一路确实有"(真机上唯一能事后翻到的就是它)。
 */
const consoleLines = []
let savedConsole = null
beforeEach(() => {
  consoleLines.length = 0
  savedConsole = { log: console.log, warn: console.warn, error: console.error }
  const capture = (...args) => consoleLines.push(args.join(' '))
  console.log = capture
  console.warn = capture
  console.error = capture
})
afterEach(() => {
  if (savedConsole !== null) Object.assign(console, savedConsole)
  savedConsole = null
})

/** 假宿主:agents 注册表 + goals 服务(真契约)+ 事件总线 + effect 收集。 */
function makeHost({ activation = 'armed', phase = 'active', roundsStarted = 0, maxGoalRounds = 25, revision = 3, goalId = 'goal-1' } = {}) {
  const listeners = new Map()
  const logs = []
  const calls = []
  const cleanups = []
  const agents = new Map() // id -> { agent, ownerId }
  const state = {
    activation, phase, roundsStarted, maxGoalRounds, revision, goalId,
    /** 非 null ⇒ **下一次 disarm 在翻完 activation 之后**抛这个错(一次性;复现 W5)。 */
    disarmProjectionFailure: null,
    /** true ⇒ `ctx.agents.list()` 抛错,模拟"活代理表读不到"(M2)。 */
    agentsListThrows: false,
  }

  const emit = (event, ...payload) => {
    for (const hook of [...(listeners.get(event) ?? [])]) hook.cb(...payload)
  }
  /** 真实现只在 activation **真的变化**时才 emit(dsh-goal `:789-792`)。 */
  const setActivation = (next) => {
    if (state.activation === next) return
    state.activation = next
    emit('goal/activation-changed', {
      sessionId: 'p1', // 目标持有者固定是 p1(每个假宿主只有一个 goal;真实现里 agent.id === session.id)
      goal: { id: state.goalId, revision: state.revision, activation: next },
    })
  }
  const view = () => ({
    id: state.goalId, revision: state.revision, objective: 'obj', phase: state.phase,
    maxGoalRounds: state.maxGoalRounds, roundsStarted: state.roundsStarted,
    createdAt: 0, updatedAt: 0, activation: state.activation,
  })

  const goals = {
    /** dsh-goal:767-769 —— 按 id 查到的必须是**同一个实例**,只对 id 不算活。 */
    assertLive(agent) {
      if (agent === null || typeof agent !== 'object' || agents.get(agent.id)?.agent !== agent) {
        throw new Error(`agent "${agent?.id}" is not live in this registry`)
      }
    },
    /** dsh-goal:760-765 —— ref 的 id + revision 必须逐字等于当前目标,否则 stale。 */
    expectCurrent(ref) {
      if (state.goalId === undefined) throw new Error('no current goal')
      if (ref?.id !== state.goalId || ref?.revision !== state.revision) {
        throw new Error(`stale goal ref "${ref?.id}" revision ${ref?.revision}; current is "${state.goalId}" revision ${state.revision}`)
      }
    },
    /** dsh-goal:771-776 —— projection 读取点(真实现失败时抛错)。 */
    projection() { return state },
    get(agent) {
      goals.assertLive(agent)
      goals.projection()
      return state.goalId === undefined ? undefined : view()
    },
    disarm(agent) {
      calls.push(`disarm:${agent.id}`)
      goals.assertLive(agent)
      setActivation('disarmed')
      // 真实现里这一步在 emit **之后**(`dsh-goal:622-627`)⇒ 抛错时 activation 已经是 disarmed。
      if (state.disarmProjectionFailure !== null) {
        const message = state.disarmProjectionFailure
        state.disarmProjectionFailure = null
        throw new Error(message)
      }
      goals.projection()
      return view()
    },
    pause(agent, ref) {
      calls.push(`pause:${agent.id}`)
      goals.assertLive(agent)
      goals.projection()
      goals.expectCurrent(ref)
      if (state.phase !== 'active') throw new Error(`cannot pause goal "${state.goalId}" from phase "${state.phase}"; expected active`)
      state.phase = 'paused'
      state.revision += 1
      setActivation('disarmed')
    },
    resume(agent, ref) {
      calls.push(`resume:${agent.id}:${ref?.id}:rev${ref?.revision}`)
      goals.assertLive(agent)
      goals.projection()
      goals.expectCurrent(ref)
      if (!['active', 'paused', 'blocked'].includes(state.phase)) throw new Error(`cannot resume goal "${state.goalId}" from phase "${state.phase}"`)
      if (state.phase === 'active' && state.activation === 'armed') throw new Error(`goal "${state.goalId}" is already active and armed`)
      if (state.roundsStarted >= state.maxGoalRounds) throw new Error(`goal "${state.goalId}" exhausted ${state.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`)
      state.phase = 'active'
      state.revision += 1
      setActivation('armed')
    },
    block(agent, ref, reason) {
      calls.push(`block:${agent.id}:${reason.code}`)
      goals.assertLive(agent)
      goals.projection()
      goals.expectCurrent(ref)
      if (state.phase !== 'active') throw new Error(`cannot block goal "${state.goalId}" from phase "${state.phase}"; expected active`)
      state.phase = 'blocked'
      state.blockedReason = reason
      state.revision += 1
      setActivation('disarmed')
    },
  }

  const ctx = {
    logger() {
      const push = (level) => (message) => logs.push(`${level}|${message}`)
      return { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
    },
    goals,
    agents: {
      get: (id) => agents.get(id)?.agent,
      list: () => {
        if (state.agentsListThrows) throw new Error('agents registry unavailable')
        return [...agents.values()].map((e) => e.agent)
      },
      isOwnedBy: (id, owner) => agents.get(id)?.ownerId === owner?.id,
    },
    on(event, cb, options) {
      const hooks = listeners.get(event) ?? []
      if (options?.prepend) hooks.unshift({ cb, options })
      else hooks.push({ cb, options })
      listeners.set(event, hooks)
      return () => {}
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
  }

  return {
    ctx, logs, calls, state, emit, listeners,
    text: () => logs.join('\n'),
    runCleanups() { for (const fn of cleanups.splice(0)) fn() },
    /**
     * 加一个活代理。`status` / `pending` **就是门控判据的两个字段** ⇒ 每个用例都必须显式声明
     * 它站在哪一边(默认 `idle` + 空 inbox = "没活干"):
     *   · `status='running'` —— 正在跑,压住门;
     *   · `status='idle'` + `pending=false` —— 已结算但仍驻留注册表,不压门;
     *   · `status='idle'` + `pending=true`  —— H1:maintenance 阶段(读出来是 idle,但 inbox 还有
     *     排队消息、马上还要干活),**仍压门**;
     *   · 传 `null` 模拟"读不到"(status 非字符串 / inbox 形态不符)⇒ 保守按在飞。
     * `inbox` 按真契约造(`runtime-types.d.ts:41-45`:`nextTurn` / `nextStep` 都是数组)。
     */
    addAgent(id, ownerId, status = 'idle', pending = false) {
      // ⚠ 真不变量:agent.id === session.id(dsh-agent 的注册表按"共享 agent/session id"寻址,
      // driver 也用 `ctx.agents.get(session.id)` 反查),这里不能给 session 编另一个 id。
      const agent = {
        id,
        session: { id },
        status,
        inbox: { nextTurn: pending ? [{ id: `${id}-pending-turn` }] : [], nextStep: [] },
      }
      agents.set(id, { agent, ownerId })
      return agent
    },
    removeAgent(id) { const entry = agents.get(id); agents.delete(id); return entry?.agent },
    /** 模拟 dsh-agent-loop 的 setPhase:先改 status、再 emit(仅状态真的变化时,`:793-799`)。 */
    setStatus(agent, status) {
      if (agent.status === status) return
      agent.status = status
      emit('agent/status', { agent, status })
    },
    /**
     * 往 inbox 里塞/清排队消息 —— 真实现里这**不改 status、也不 emit**
     * (`dsh-agent-loop:854-858`:maintenance 期间 `wakeDriver` 只置 `wakeRequested`)。
     */
    setPending(agent, pending) {
      agent.inbox.nextTurn = pending ? [{ id: `${agent.id}-pending-turn` }] : []
    },
    /** 让 `ctx.agents.list()` 抛错:模拟"活代理表读不到"(M2)。 */
    breakAgentsList(broken) { state.agentsListThrows = broken === true },
    /** 原样派发一次 agent/status(不经过状态机):用于"代理就在 idle 上"的重复派发场景。 */
    emitStatus(agent, status) { emit('agent/status', { agent, status }) },
    /**
     * 模拟宿主往 session/event 上发事件(turn/end 等)。session 必须用**注册表里那个实例**:
     * 真实现(以及本插件/driver)都做 `agent.session !== session` 的同一实例校验,传副本会被正确地拒收。
     */
    emitSession(sessionId, event) {
      const entry = [...agents.values()].find((e) => e.agent.session.id === sessionId)
      emit('session/event', entry === undefined ? { id: sessionId } : entry.agent.session, event)
    },
    /** 模拟**别人**改了 activation(人工 /goal resume、driver 的 disarm 等):真实现只 emit 不写 phase。 */
    externalActivation(next) { setActivation(next) },
    /** 模拟人类 /goal clear 后新建目标:换 id + revision 归 1,新目标 create 即 armed。 */
    newGoal({ id, revision: rev = 1, phase: ph = 'active', activation: act = 'armed' } = {}) {
      state.goalId = id
      state.revision = rev
      state.phase = ph
      state.activation = act
    },
    /**
     * 模拟 driver 里与 S1 有关的三段(逐行对照 dsh-goal-round-driver/lib/index.js):
     *   · `disarm(state)`(`:87-93`):只有 `activation === "armed"` 才真的 disarm;
     *   · `turn/end` max-tokens(`:262-264`)⇒ disarm;aborted(`:266-269`):本轮有 claimed/admitted
     *     预约 ⇒ 标记 cancelled,否则 disarm;
     *   · `agent/inbox/discarded`(`:249-252`):被丢弃的是已排队的 goal 轮 ⇒ 标记 cancelled
     *     (idle 状态下被 cancel 时没有 turn/end,这条是唯一信号 —— 见 N1);
     *   · `agent/status` idle(`:213-228`):预约 queued/claimed/cancelled 且
     *     `phase === "active" && activation === "armed"` ⇒ `ctx.goals.pause(...)`(durable 停车闸)。
     * 另外记录"每次 idle 时 driver 看到的 activation",供 prepend 时序断言用。
     */
    installFakeDriver() {
      const seen = []
      const gate = { attempt: undefined, pauses: [], disarmedByDriver: [] }
      const driverDisarm = (agent) => {
        if (goals.get(agent).activation === 'armed') {
          gate.disarmedByDriver.push(agent.id)
          goals.disarm(agent)
        }
      }
      ctx.on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return
        const agent = [...agents.values()].map((e) => e.agent).find((a) => a.session.id === session.id)
        if (agent === undefined) return
        const kind = event.data?.reason?.kind
        if (kind === 'max-tokens') { driverDisarm(agent); return }
        if (kind !== 'aborted') return
        if (gate.attempt?.phase === 'claimed' || gate.attempt?.phase === 'admitted') gate.attempt.cancelled = true
        else driverDisarm(agent)
      })
      ctx.on('agent/inbox/discarded', ({ agent, message }) => {
        if (agent === undefined || message?.source?.kind !== 'goal' || !(message.source.round > 0)) return
        if (gate.attempt !== undefined) gate.attempt.cancelled = true
      })
      ctx.on('agent/status', ({ agent, status }) => {
        if (status !== 'idle') return
        const goal = goals.get(agent)
        seen.push(goal?.activation)
        if (gate.attempt !== undefined
          && (gate.attempt.phase === 'queued' || gate.attempt.phase === 'claimed' || gate.attempt.cancelled === true)
          && goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
          && gate.attempt.goalId === goal.id && gate.attempt.revision === goal.revision) {
          gate.attempt = undefined
          gate.pauses.push(agent.id)
          goals.pause(agent, { id: goal.id, revision: goal.revision })
        }
      })
      return {
        seen,
        gate,
        /** 模拟 driver 刚预约并 admitted 了一轮(只有此时 attempt 才参与停车判据)。 */
        admitRound() {
          gate.attempt = { phase: 'admitted', goalId: state.goalId, revision: state.revision, cancelled: false }
        },
      }
    },
  }
}

test('装载自检 + 无子代理不 disarm + 有子代理只在 idle 压住 + prepend 时序', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  const text = host.text()
  assert.match(text, /自检:goals 服务=可用 agents 服务=可用/)
  assert.match(text, /已有 claim=0 已有闩锁=0/)
  assert.match(text, /订阅=\[subagent\/start\(只登记\), subagent\/end\(\+闩锁复核\), agent\/status\(prepend\+global, 唯一门控入口, \+闩锁复核\), agent\/disposed\(\+闩锁复核\), goal\/activation-changed, session\/event\(turn\/end:aborted ⇒ 让位标记\), agent\/inbox\/discarded\(goal 轮被丢弃 ⇒ 让位标记\), 看门狗定时器\(闩锁复核 \+ claim 重算\)\]/)
  assert.match(text, /看门狗已挂:每 30000ms 复核全部闩锁 \+ 重算全部 claim/)
  assert.match(text, /装载扫描完成:活代理 1 个\(idle 1 个参与判定\),压住 0 个/)

  host.emitStatus(p1, 'idle')
  assert.deepEqual(host.calls, [], '无子代理时不该动任何状态')
  assert.deepEqual(driver.seen, ['armed'])

  const hooks = host.listeners.get('agent/status')
  assert.equal(hooks.length, 2)
  assert.equal(hooks[0].options.prepend, true, 'agent/status 监听必须 prepend,否则抢不到 driver')
  assert.equal(hooks[1].options, undefined, 'driver 那条按真实现不带 options(先注册也会被 unshift 挤到后面)')

  // 父代理正在跑(委派就发生在 running 期间)⇒ 子代理建立:只登记,不动 activation
  host.setStatus(p1, 'running')
  host.addAgent('c1', 'p1', 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  assert.deepEqual(host.calls, [], 'S1:subagent/start 绝不改 activation')
  assert.equal(host.state.activation, 'armed', 'S1:running 期间 goal 必须保持 armed')
  assert.match(host.text(), /subagent\/start 登记:child=c1 owner=p1/)

  // 父代理 idle ⇒ 门控在这一次派发里生效(driver 看到 disarmed)
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])
  assert.deepEqual(driver.seen, ['armed', 'disarmed'])
  assert.match(host.text(), /disarm\[agent\/status:idle\] agent=p1 goal=goal-1 rev=3 在飞子代理=1/)
  // 双写:同一行也必须落到 stdout(真机上 ctx.logger 只进内存 buffer,只有 stdout 能事后翻到)
  assert.ok(
    consoleLines.some((line) => line.startsWith('[goal-subagent-gate] disarm[agent/status:idle] agent=p1')),
    `stdout 那一路缺日志;实际收到:${JSON.stringify(consoleLines)}`,
  )

  // 已 disarmed 的重复 idle:不重复动手
  host.emitStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'], '已 disarmed 不应重复 disarm')

  // 子代理此刻仍在跑(status=running)⇒ hold,不放行(v0.2.0:判据看的是"在不在跑",不是"在不在表里")
  host.emit('subagent/end', { runId: 'r1', provider: 'spawn', id: 'c1', local: true, stopReason: 'completed' })
  assert.deepEqual(host.calls, ['disarm:p1'])

  // 摘除 ⇒ resume(自带重发路径)+ 丢 claim
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])
  assert.match(host.text(), /re-arm\[agent\/disposed:c1\] agent=p1 goal=goal-1 rev=3 在飞子代理=0 依据=children-settled/)

  // 放行后 driver 再 idle:正常续轮
  host.emitStatus(p1, 'idle')
  assert.equal(driver.seen.at(-1), 'armed')
  assert.equal(host.state.revision, 4)
})

test('v0.2.0 回归①:已结算但仍驻留注册表的子代理不再压住门(旧判据会在这里 disarm)', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  // 已结算但仍驻留:它还在活代理表里(owner 指向 p1),但 status 已经是 idle、名下也没有孩子。
  host.addAgent('c1', 'p1', 'idle')
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')

  assert.deepEqual(host.calls, [], 'v0.2.0:结算后驻留的孩子不再压住门(旧判据只看"在不在表里",会 disarm)')
  assert.equal(host.state.activation, 'armed', '目标保持 armed ⇒ driver 可以正常续轮')
  assert.equal(driver.seen.at(-1), 'armed', 'prepend 那次派发里 driver 看到的是 armed(没有被抢跑)')
  assert.equal(mod.__internals.CLAIMS.size, 0, '不压住就不建 claim')
  assert.match(
    host.text(),
    /不压住\[agent\/status:idle\] agent=p1 goal=goal-1:名下 1 个子代理都已结算\(不在飞;判据=v0\.2\.1 的 status==='running' ∨ inbox 有排队消息 ∨ 名下有活后代\)⇒ 门控放行/,
  )
})

test('v0.2.0 回归②:正在跑的子代理仍然压住门(防空转的本意不变)', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')

  assert.deepEqual(host.calls, ['disarm:p1'], 'v0.2.0:running 的孩子仍然压住门')
  assert.deepEqual(driver.seen, ['disarmed'], 'prepend 时序不变:driver 在同一次 idle 派发里看到 disarmed')
  assert.equal(mod.__internals.CLAIMS.size, 1)
  assert.match(host.text(), /disarm\[agent\/status:idle\] agent=p1 goal=goal-1 rev=3 在飞子代理=1/)
})

test('v0.2.0 回归③:孩子自己 idle,但名下还有未结算的孙代理 ⇒ 仍然压住门', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, {})

  host.addAgent('c1', 'p1', 'idle') // 孩子自己已经不在跑
  const g1 = host.addAgent('g1', 'c1', 'running') // 但它名下还有一个在跑的孙子 ⇒ 它自己还没结算
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')

  assert.deepEqual(host.calls, ['disarm:p1'], 'v0.2.0:名下还有未结算孙代理的孩子算在飞')
  assert.match(host.text(), /disarm\[agent\/status:idle\] agent=p1 goal=goal-1 rev=3 在飞子代理=1/)

  // 孙子自己停了,但仍驻留注册表 ⇒ 孩子名下**仍有活后代** ⇒ 孩子仍算在飞(它还没结算)
  host.setStatus(g1, 'idle')
  host.emit('subagent/end', { runId: 'r2', provider: 'spawn', id: 'g1', local: true, stopReason: 'completed' })
  assert.deepEqual(host.calls, ['disarm:p1'], '孙子转 idle 但没摘除 ⇒ 孩子名下还有活后代 ⇒ 仍 hold')

  // 孙子被摘除(真机上它结算后会 dispose)⇒ 孩子名下不再有后代、自己也是 idle ⇒ 整条链都不在飞 ⇒ 放行
  host.removeAgent('g1')
  host.emit('agent/disposed', { agent: g1 })
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'], '孙子摘除后门才开')
  assert.equal(mod.__internals.CLAIMS.size, 0)
})

test('v0.2.0 回归④:孩子结算(转 idle)后 claim 重算 ⇒ re-arm;孙代理还挂着时仍 hold', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  const c1 = host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])
  assert.equal(mod.__internals.CLAIMS.size, 1)

  // 孩子这一轮跑完 ⇒ status 转 idle,但它仍驻留注册表(没有 agent/disposed)
  host.setStatus(c1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'], 'claim 属于 p1:孩子转 idle 本身不触发重算,等结算/摘除事件或看门狗')

  // 结算事件 ⇒ 重算 ⇒ 名下已无在飞子代理 ⇒ resume(自带重发路径)
  host.emit('subagent/end', { runId: 'r1', provider: 'spawn', id: 'c1', local: true, stopReason: 'completed' })
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])
  assert.match(
    host.text(),
    /re-arm\[subagent\/end:c1:completed\] agent=p1 goal=goal-1 rev=3 在飞子代理=0 依据=children-settled/,
  )
  assert.equal(mod.__internals.CLAIMS.size, 0, '放行后 claim 交还')
  assert.equal(host.state.activation, 'armed')

  // 放行后 driver 再 idle:正常续轮
  host.emitStatus(p1, 'idle')
  assert.equal(driver.seen.at(-1), 'armed')
})

test('H1 回归:孩子 status=idle 但 inbox 还有排队消息(maintenance 阶段)⇒ 仍然压住门', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  // 孩子在 maintenance 阶段:status 读出来是 idle,但 inbox 里已经排了活(dsh-agent-loop:790-792 / :854-858)
  host.addAgent('c1', 'p1', 'idle', true)
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'], 'H1:有待办的孩子必须压住门(旧判据只看 status ⇒ 门误开)')
  assert.deepEqual(driver.seen, ['disarmed'], 'prepend 时序不变')
  assert.equal(mod.__internals.CLAIMS.size, 1)
  assert.match(host.text(), /disarm\[agent\/status:idle\] agent=p1 goal=goal-1 rev=3 在飞子代理=1/)

  // 待办被领走(inbox 空)⇒ 孩子真的没事了 ⇒ 重算即放行
  const c1 = host.ctx.agents.get('c1')
  host.setPending(c1, false)
  host.emit('subagent/end', { runId: 'r1', provider: 'spawn', id: 'c1', local: true, stopReason: 'completed' })
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'], '待办清空后才放行')
})

test('M1 回归:闩锁期内同一批孩子"先停再跑" ⇒ 门控必须恢复(旧实现静默失效)', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, { maxHoldMs: 1000, watchdogIntervalMs: 1000 })
  const c1 = host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])

  // 孩子一直不结算 ⇒ 看门狗到点强制放行,并对 (goal-1, {c1}) 上闩锁
  assert.ok(
    await waitFor(() => host.calls.length >= 2),
    `看门狗未在 5s 内强制放行;实际 calls=${JSON.stringify(host.calls)}`,
  )
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])
  assert.equal(mod.__internals.RELEASED.get('p1'), 'goal-1:c1')

  // 同一批孩子"先停":status → idle。这一刻在飞集合变空 ⇒ 闩锁必须当场作废。
  // ⚠ 这是旧实现漏掉的那一步:它只在 owner 下一次 idle 时比快照,而那时快照已经绕回原值。
  host.setStatus(c1, 'idle')
  assert.equal(mod.__internals.RELEASED.has('p1'), false, 'M1:观察到"那批孩子已经不在飞"⇒ 闩锁当场作废')
  assert.match(host.text(), /闩锁作废\[agent\/status:idle:c1\] agent=p1:goal 或子代理集合已变\(原=goal-1:c1 现=goal-1:\)⇒ 门控恢复/)

  // 再被派活(status → running)⇒ 下一次 idle 必须重新压住门(旧实现在这里静默不压)
  host.setStatus(c1, 'running')
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')
  assert.deepEqual(
    host.calls,
    ['disarm:p1', 'resume:p1:goal-1:rev3', 'disarm:p1'],
    'M1:同一批孩子先停再跑,门控必须恢复(否则该目标再也不压 = 空转)',
  )
})

test('M2 回归:活代理表读不到 ⇒ 本 tick 不判定(不 disarm、不放行、保留 claim)', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, {})
  host.addAgent('c1', 'p1', 'running')

  // ① idle 时读表失败:旧实现把失败当空表 ⇒ no-active-child ⇒ 门直接开;现在必须什么都不做
  host.breakAgentsList(true)
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, [], 'M2:读不到活代理表时不得动手')
  assert.equal(host.state.activation, 'armed')
  assert.equal(mod.__internals.CLAIMS.size, 0)

  // ② 恢复后正常压住
  host.breakAgentsList(false)
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])
  assert.equal(mod.__internals.CLAIMS.size, 1)

  // ③ 有 claim 时读表失败 —— **这条是本用例的判别点**:旧实现把失败当空表 ⇒
  //    `planReArm` 判 `children-settled` ⇒ 提前 resume;现在必须保留 claim。
  host.breakAgentsList(true)
  host.emit('subagent/end', { runId: 'r1', provider: 'spawn', id: 'c1', local: true, stopReason: 'completed' })
  assert.deepEqual(host.calls, ['disarm:p1'], 'M2:读不到表时绝不提前放行(旧实现在这里会 resume)')
  assert.equal(mod.__internals.CLAIMS.size, 1, 'M2:claim 必须保留,等下一 tick 重判')
  assert.equal(host.state.activation, 'disarmed')

  // ④ 恢复 ⇒ 孩子其实已经摘除 ⇒ 正常放行
  host.breakAgentsList(false)
  const gone = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: gone })
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])
  assert.equal(mod.__internals.CLAIMS.size, 0)

  // ⑤ 日志(放在最后:用例的判别点是上面的行为,不是文案)
  assert.match(host.text(), /拍平活代理表失败\(本 tick 不判定,保留 claim 等下一 tick\)/)
})

test('S1 回归:subagent/start 不改 activation,running 期间也不门控,idle 才压住', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, {})

  host.setStatus(p1, 'running')
  host.addAgent('c1', 'p1', 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  assert.deepEqual(host.calls, [], 'S1:start 处理器只登记')
  assert.equal(host.state.activation, 'armed', 'S1:start 后 activation 仍是 armed')

  // running 期间的其他事件(孩子结算)也不得改 activation —— 没有 claim 就什么都不做
  host.emit('subagent/end', { runId: 'r1', provider: 'spawn', id: 'c1', local: true, stopReason: 'completed' })
  assert.deepEqual(host.calls, [])
  assert.equal(host.state.activation, 'armed')

  // idle 派发里才压住(这一次 disarm 就是"压住"的全部所需:driver 只在 idle 开新轮)
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])
  assert.equal(host.state.activation, 'disarmed')
  assert.match(host.text(), /disarm\[agent\/status:idle\] agent=p1 goal=goal-1 rev=3 在飞子代理=1/)
})

test('S1 回归:用户 abort 时 driver 的 disarm 闸门不再被插件抢先(旧实现下它是 no-op 且随后被 resume 撤销)', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  // 父代理在跑、孩子还活着;这一轮没有 driver 预约(attempt === undefined)
  host.setStatus(p1, 'running')
  host.addAgent('c1', 'p1', 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })

  // 用户按停止
  host.emitSession('p1', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.deepEqual(
    driver.gate.disarmedByDriver, ['p1'],
    'S1:driver 的 abort ⇒ disarm 必须真的执行(旧实现里 activation 已被插件翻掉,这一步是 no-op)',
  )
  assert.deepEqual(host.calls, ['disarm:p1'])
  assert.equal(host.state.activation, 'disarmed')

  // 随后的 idle:插件看到 already-disarmed,不抢方向盘
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])

  // 孩子结算 ⇒ 插件**不得**把它 resume 回来(旧实现会在这里把用户的停止撤销)
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['disarm:p1'], 'S1:被 driver 停下的目标不许被插件重新开起来')
  assert.equal(host.state.activation, 'disarmed')
})

test('S1 回归:max-tokens 时 driver 的 disarm 闸门同样完好', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  host.setStatus(p1, 'running')
  host.addAgent('c1', 'p1', 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  host.emitSession('p1', { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })
  assert.deepEqual(driver.gate.disarmedByDriver, ['p1'], 'S1:max-tokens ⇒ disarm 必须真的执行')
  assert.equal(host.state.activation, 'disarmed')

  host.setStatus(p1, 'idle')
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['disarm:p1'], 'S1:额度/错误制动停下的目标不许被插件重新开起来')
})

test('用户叫停撞上"压住":有 driver 预约 + 有在飞子代理 ⇒ durable pause 必须写出,插件不得 disarm/resume', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  host.setStatus(p1, 'running')
  host.addAgent('c1', 'p1', 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  driver.admitRound() // driver 已预约并 admitted 这一轮

  host.emitSession('p1', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(driver.gate.attempt.cancelled, true, 'driver 把本轮预约标成 cancelled')
  assert.equal(host.state.activation, 'armed', '插件此刻还没动过 activation')
  assert.deepEqual(host.calls, [])

  // idle:插件消费"用户叫停"标记 ⇒ 跳过门控;driver 的停车闸门正常执行
  host.setStatus(p1, 'idle')
  assert.deepEqual(driver.gate.pauses, ['p1'], 'driver 必须写出 durable pause(旧实现被插件的 prepend disarm 吞掉)')
  assert.equal(host.state.phase, 'paused')
  assert.deepEqual(host.calls, ['pause:p1'], '插件既没 disarm 也没 resume')
  assert.match(host.text(), /用户叫停\[cause=user\] agent=p1 trigger=agent\/status:idle:跳过门控并丢 claim/)
  assert.equal(mod.__internals.ABORTED.size, 0, '标记一次性,用完即清')
  assert.equal(mod.__internals.CLAIMS.size, 0)

  // 孩子结算 ⇒ 插件不得把它 resume 回来
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['pause:p1'], '插件不得把用户叫停的目标重新开起来')
  assert.equal(host.state.phase, 'paused')
  assert.equal(host.state.activation, 'disarmed')
})

test('用户叫停:插件已压住(有 claim)时叫停 ⇒ 丢 claim 且绝不放行,目标停在 disarmed 等人工 resume', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, {})
  host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])
  assert.equal(mod.__internals.CLAIMS.size, 1)

  // 父代理又跑了一轮(用户消息),并在这一轮按了停止
  host.setStatus(p1, 'running')
  host.emitSession('p1', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  host.setStatus(p1, 'idle')
  assert.equal(mod.__internals.CLAIMS.size, 0, '叫停后 claim 必须丢弃')
  assert.deepEqual(host.calls, ['disarm:p1'], '插件不得 resume(否则等于撤销用户的停止)')
  assert.equal(host.state.activation, 'disarmed')
  assert.match(host.text(), /丢 claim\[agent\/status:idle\] agent=p1 goal=goal-1 原因=abort-handoff/)

  // 孩子结算也不得把它开起来
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['disarm:p1'])
  assert.equal(host.state.activation, 'disarmed')
})

test('N1 回归:idle 状态下 cancel(丢弃已排队的 goal 轮)也让位 ⇒ durable pause 写出、插件不 resume', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})

  driver.admitRound() // driver 已预约并 admitted 一轮
  host.addAgent('c1', 'p1', 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })

  // 非 goal 消息被丢弃 ⇒ 不置位(用户自己排队的消息不算叫停)
  host.emit('agent/inbox/discarded', { agent: p1, message: { id: 'm-user', source: { kind: 'user' } } })
  assert.equal(mod.__internals.ABORTED.size, 0, 'N1:非 goal 消息的丢弃不置位')
  // round=0 是目标的初始消息,丢弃它不代表取消某一轮 ⇒ 也不置位
  host.emit('agent/inbox/discarded', {
    agent: p1, message: { id: 'm-goal0', source: { kind: 'goal', goalId: 'goal-1', revision: 3, round: 0 } },
  })
  assert.equal(mod.__internals.ABORTED.size, 0, 'N1:round=0 不置位(与 driver 的 isGoalRoundSource 同源)')

  // idle 状态下 cancel():cancel() 无条件 inbox.clear(),已排队的 goal 轮被丢弃 —— 没有 turn ⇒ 没有 turn/end
  host.emit('agent/inbox/discarded', {
    agent: p1, message: { id: 'm-goal', source: { kind: 'goal', goalId: 'goal-1', revision: 3, round: 1 } },
  })
  assert.equal(mod.__internals.ABORTED.get('p1'), 'inbox-discarded', 'N1:丢弃 goal 轮必须置位让位标记')
  assert.deepEqual(host.calls, [], 'N1:置位那一刻不动 activation')
  assert.equal(host.state.activation, 'armed')

  // 下一次 idle:让位 ⇒ driver 写 durable pause;插件不 disarm、不 resume
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')
  assert.deepEqual(driver.gate.pauses, ['p1'], 'N1:durable pause 必须写出(旧实现被插件的 prepend disarm 吞掉)')
  assert.equal(host.state.phase, 'paused')
  assert.deepEqual(host.calls, ['pause:p1'])
  assert.match(host.text(), /叫停让位\[cause=inbox-discarded\] agent=p1 trigger=agent\/status:idle/)
  assert.equal(mod.__internals.ABORTED.size, 0, '标记一次性,用完即清')

  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['pause:p1'], 'N1:不得把叫停的目标重新开起来')
})

test('N2 回归:让位标记跨多个整轮(kick 连跑、不经 idle)仍然有效,直到那次 idle 才消费', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  const driver = host.installFakeDriver()
  mod.apply(host.ctx, {})
  driver.admitRound()
  host.addAgent('c1', 'p1', 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })

  host.emitSession('p1', { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(mod.__internals.ABORTED.get('p1'), 'user', 'N3:cause 必须记进标记')

  // dsh-agent-loop 的 kick() 是 while (await this.turn()):inbox 有 pending 就连跑整轮,中间不经 idle
  host.setStatus(p1, 'running')
  host.emit('subagent/end', { runId: 'r1', provider: 'spawn', id: 'c1', local: true, stopReason: 'completed' })
  host.emit('subagent/end', { runId: 'r2', provider: 'spawn', id: 'c2', local: true, stopReason: 'completed' })
  assert.equal(mod.__internals.ABORTED.get('p1'), 'user', 'N2:整轮之间不得丢标记')
  assert.deepEqual(host.calls, [], 'N2:整轮之间也不得借机门控')

  // 真正的那次 idle 才消费它
  host.setStatus(p1, 'idle')
  assert.equal(mod.__internals.ABORTED.size, 0, 'N2:只在 idle 消费')
  assert.deepEqual(driver.gate.pauses, ['p1'])
  assert.deepEqual(host.calls, ['pause:p1'])
})

test('额度用尽 → block(code=round-limit),绝不 resume', async () => {
  const host = makeHost({ roundsStarted: 25, maxGoalRounds: 25 })
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, {})
  host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['disarm:p1', 'block:p1:round-limit'])
  assert.match(host.text(), /code=round-limit roundsStarted=25\/25/)
  assert.equal(host.state.phase, 'blocked')
})

test('observeOnly:判定照出、状态一个字节不动', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, { observeOnly: true })
  host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, [])
  assert.match(host.text(), /observeOnly:本应 disarm agent=p1 goal=goal-1 rev=3 在飞子代理=1\(未改状态\)/)
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  host.emitStatus(p1, 'idle')
  assert.deepEqual(host.calls, [])
  assert.equal(host.state.activation, 'armed')
})

test('归属安全:别人改了 activation(人工 /goal resume 等)⇒ 丢 claim,不抢方向盘', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, {})
  host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])
  assert.equal(mod.__internals.CLAIMS.size, 1)

  // 别人把目标重新武装 ⇒ 本插件让位(不再拿 claim 去 resume/覆盖别人的决定)
  host.externalActivation('armed')
  assert.match(host.text(), /丢 claim\[goal\/activation-changed\] agent=p1 goal=goal-1 原因=activation-changed-by-other\(armed\)/)
  assert.equal(mod.__internals.CLAIMS.size, 0)
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['disarm:p1'], '丢 claim 后不再 resume')
})

test('看门狗超时兜底 + 闩锁:常驻子代理长期不结算 ⇒ 强制放行,同一 goal 的同一批孩子不再压回去', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, { maxHoldMs: 1000, watchdogIntervalMs: 1000 })
  host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1'])

  // c1 一直不结算(常驻子代理)⇒ 看门狗到点强制放行
  assert.ok(
    await waitFor(() => host.calls.length >= 2),
    `看门狗未在 5s 内强制放行;实际 calls=${JSON.stringify(host.calls)}`,
  )
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])
  assert.match(host.text(), /兜底 re-arm:claim 持有 \d+s 已达 maxHoldMs=1000ms,仍有 1 个在飞子代理 —— 强制放行,/)
  assert.equal(mod.__internals.RELEASED.get('p1'), 'goal-1:c1', '闩锁指纹 = goal 身份 + 子代理集合')
  assert.equal(mod.__internals.CLAIMS.size, 0, '兜底放行后 claim 必须已经交还')

  host.emitStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'], '闩锁内不得重新压住')
  assert.equal(host.state.activation, 'armed')

  // 孩子集合一变(c2 新委派)⇒ 闩锁作废,下一次 idle 恢复门控
  host.setStatus(p1, 'running')
  host.addAgent('c2', 'p1', 'running')
  host.emit('subagent/start', { runId: 'r2', provider: 'spawn', id: 'c2', local: true })
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3', 'disarm:p1'], '集合一变,门控恢复')
  assert.match(host.text(), /闩锁作废\[agent\/status:idle\] agent=p1:goal 或子代理集合已变\(原=goal-1:c1 现=goal-1:c1,c2\)⇒ 门控恢复/)
})

test('W1 回归:闩锁挂着时换新 goal(同一批孩子还活着)⇒ 新目标必须继续被门控', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, { maxHoldMs: 1000, watchdogIntervalMs: 1000 })
  host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  host.setStatus(p1, 'idle')
  assert.ok(
    await waitFor(() => host.calls.length >= 2),
    `看门狗未在 5s 内强制放行;实际 calls=${JSON.stringify(host.calls)}`,
  )
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])
  assert.equal(mod.__internals.RELEASED.get('p1'), 'goal-1:c1')

  // 同一目标的下一次 idle:仍在闩锁内(resume 把 revision 顶到 4,但指纹不含 revision ⇒ 不误作废)
  host.emitStatus(p1, 'idle')
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])

  // 人类 /goal clear 再建 goal-2,那批孩子(c1)还活着
  host.setStatus(p1, 'running')
  host.newGoal({ id: 'goal-2' })
  host.setStatus(p1, 'idle')
  assert.deepEqual(
    host.calls,
    ['disarm:p1', 'resume:p1:goal-1:rev3', 'disarm:p1'],
    'W1:换目标后旧闩锁不得短路新目标的门控(旧实现会静默退化成"没有插件")',
  )
  assert.match(host.text(), /闩锁作废\[agent\/status:idle\] agent=p1:goal 或子代理集合已变\(原=goal-1:c1 现=goal-2:c1\)⇒ 门控恢复/)
  assert.equal(mod.__internals.RELEASED.has('p1'), false)
})

test('W5 回归:disarm 抛错时保留 claim(activation 已翻 ⇒ 之后仍有人放行)', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, {})
  host.addAgent('c1', 'p1', 'running')
  host.setStatus(p1, 'running')
  host.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })

  // 真实现:disarm 先翻 activation 再读 projection ⇒ projection 失败时"已 disarm 但抛错"
  host.state.disarmProjectionFailure = 'goal projection failed'
  host.setStatus(p1, 'idle')
  assert.equal(host.state.activation, 'disarmed', 'activation 已经翻了')
  assert.match(host.text(), /disarm 失败\[agent\/status:idle\] agent=p1 goal=goal-1:goal projection failed ⇒ 保留 claim/)
  assert.ok(!host.text().includes('原因=disarm-failed'), 'W5:不得丢 claim(否则没人放行)')
  assert.equal(mod.__internals.CLAIMS.size, 1, 'W5:claim 必须保留,交给看门狗下一 tick 重判')

  // 恢复 + 孩子结算 ⇒ 插件必须把它放行(旧实现丢了 claim,目标会永久停在 active+disarmed)
  const c1 = host.removeAgent('c1')
  host.emit('agent/disposed', { agent: c1 })
  assert.deepEqual(host.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])
  assert.equal(host.state.activation, 'armed')
  assert.equal(mod.__internals.CLAIMS.size, 0)
})

test('查不到 owner 的 subagent/start(非本进程子代理)⇒ 不猜 owner、不动状态', async () => {
  const host = makeHost()
  const p1 = host.addAgent('p1')
  const mod = await loadPlugin()
  mod.apply(host.ctx, {})
  host.emit('subagent/start', { runId: 'r9', provider: 'remote', id: 'ghost', local: false })
  host.setStatus(p1, 'running')
  host.setStatus(p1, 'idle')
  assert.deepEqual(host.calls, [])
})

test('卸载收尾:孩子已走但漏了事件 ⇒ disposer 兜底放行;孩子仍在跑 ⇒ 点名不静默', async () => {
  const settled = makeHost()
  const sp1 = settled.addAgent('p1')
  const modA = await loadPlugin()
  modA.apply(settled.ctx, {})
  settled.addAgent('c1', 'p1', 'running')
  settled.setStatus(sp1, 'running')
  settled.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  settled.setStatus(sp1, 'idle')
  assert.deepEqual(settled.calls, ['disarm:p1'])
  settled.removeAgent('c1') // 孩子走了但没发 agent/disposed
  settled.runCleanups()
  assert.deepEqual(settled.calls, ['disarm:p1', 'resume:p1:goal-1:rev3'])
  assert.match(settled.text(), /dispose:无遗留 claim/)

  const running = makeHost()
  const rp1 = running.addAgent('p1')
  const modB = await loadPlugin()
  modB.apply(running.ctx, {})
  running.addAgent('c1', 'p1', 'running')
  running.setStatus(rp1, 'running')
  running.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
  running.setStatus(rp1, 'idle')
  running.runCleanups()
  assert.deepEqual(running.calls, ['disarm:p1'])
  assert.match(running.text(), /dispose:仍有 1 个 claim 未能放行\(agent=p1\)⇒ 这些目标会停在 active\+disarmed/)
})
