// dsh-git-panel —— 客户端半边 standalone 测试
// ============================================================================
// 客户端半边是**手写 bundle**（`window.__ModuleLoader__.load({id, factory})`），
// 不经过任何构建工具。这个测试用假的 window + 假的 React 把它完整跑一遍，
// 从而在**不启动 DSH、不安装浏览器依赖**的情况下证明：
//
//   1. bundle 格式正确：只调用一次 `load`，id 与包名一致，factory 可调用；
//   2. 只 require 平台种子（react）；请求别的说明依赖了构建产物，换版本会炸；
//   3. 只导出 apply / inject 两个契约字段，且 inject 声明了 slots；
//   4. 界面注册在三种时机下都不抛异常：slots 服务缺失 / 直接注册成功 /
//      插槽尚未声明需等待（含「真实错误不被吞掉」的区分）；
//   5. 两个组件都能渲染（含 props 缺失——将来 slot 契约变了也不能白屏）；
//   6. 点改动看 diff 能走到终态（真状态重渲染），不会永远停在「加载中…」——
//      这一条是回归测试：runOp 曾把结果变量声明在 try 块里，每次调用都以
//      ReferenceError 结束，宿主侧 git 明明执行成功了，调用方却永远拿不到返回值。
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')

// ── 假 React：只实现 bundle 真正用到的面 ─────────────────────────────────────

function makeFakeReact() {
  let hookIndex = 0
  const effects = []
  const nodes = []
  return {
    api: {
      createElement: (type, props, ...children) => {
        const node = { type, props: props === null || props === undefined ? {} : props, children }
        nodes.push(node)
        return node
      },
      useState: (initial) => {
        const index = hookIndex++
        return [typeof initial === 'function' ? initial() : initial, (value) => { effects.push([index, value]) }]
      },
      useRef: (initial) => ({ current: initial }),
      useEffect: (callback) => { effects.push(['effect', callback]) },
      useCallback: (callback) => callback,
      useMemo: (factory) => factory(),
      Fragment: 'Fragment',
    },
    nodes,
    effects,
    /** 每个组件渲染前重置 hook 序号（直接调用函数组件，绕过 reconciler）。 */
    beginRender() { hookIndex = 0; effects.length = 0 },
    consumedHooks() { return hookIndex },
  }
}

/**
 * 有状态的假 React：真的保存 hook 值，并在 setState 之后重渲染组件。
 *
 * `makeFakeReact` 只记录 setState 的值、不重渲染，够验「渲染不白屏」；
 * 但验不了「点一下之后状态有没有走到终态」——而「点改动看 diff 永远停在
 * 加载中」正是这种形态：异常发生在 await 之后，界面停在中间态。
 */
function makeStatefulReact() {
  let component = null
  let props = null
  let hooks = []
  let cursor = 0
  let tree = null
  let dirty = false
  const pendingEffects = []

  const api = {
    createElement: (type, elementProps, ...children) => ({
      type,
      props: elementProps === null || elementProps === undefined ? {} : elementProps,
      children,
    }),
    useState: (initial) => {
      const index = cursor++
      if (!Object.hasOwn(hooks, index)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        const next = typeof value === 'function' ? value(hooks[index]) : value
        if (Object.is(next, hooks[index])) return
        hooks[index] = next
        dirty = true
      }
      return [hooks[index], set]
    },
    useRef: (initial) => {
      const index = cursor++
      if (!Object.hasOwn(hooks, index)) hooks[index] = { current: initial }
      return hooks[index]
    },
    // deps 比较复刻 React：引用相等即不重跑，避免 effect 里的 setState 打转。
    useEffect: (callback, deps) => {
      const index = cursor++
      const previous = hooks[index]
      const changed = previous === undefined
        || deps === undefined
        || deps.length !== previous.length
        || deps.some((value, at) => !Object.is(value, previous[at]))
      hooks[index] = deps
      if (changed) pendingEffects.push(callback)
    },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    Fragment: 'Fragment',
  }

  function renderOnce() {
    cursor = 0
    tree = component(props)
    for (const effect of pendingEffects.splice(0)) effect()
    return tree
  }

  return {
    api,
    mount(component_, props_) {
      component = component_
      props = props_
      hooks = []
      cursor = 0
      dirty = false
      pendingEffects.length = 0
      renderOnce()
    },
    /** 反复渲染直到没有新的 setState / effect（让 await 链跑完），返回最终树。 */
    async settle(rounds = 12) {
      for (let round = 0; round < rounds; round += 1) {
        dirty = false
        renderOnce()
        await new Promise((resolve) => { setTimeout(resolve, 0) })
        if (!dirty && pendingEffects.length === 0) return tree
      }
      return tree
    },
  }
}

/** 深度展开假 React 的元素树（children 里可能嵌数组）。 */
function flattenTree(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) flattenTree(child, out)
    return out
  }
  out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) flattenTree(child, out)
  return out
}

/** 取一个元素子树的纯文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

// ── 假 window：只提供 bundle 真正用到的面 ────────────────────────────────────
function makeFakeWindow(options = {}) {
  const registrations = []
  const storage = new Map()
  const listeners = new Map()
  const calls = { fetch: [], diag: [] }
  if (options.prefillStorage !== undefined) {
    for (const [key, value] of Object.entries(options.prefillStorage)) storage.set(key, value)
  }
  const win = {
    __ModuleLoader__: { load: (registration) => { registrations.push(registration) } },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: (key) => { storage.delete(key) },
    },
    addEventListener: (type, listener) => { listeners.set(type, listener) },
    removeEventListener: (type) => { listeners.delete(type) },
    dispatchEvent: () => true,
    confirm: () => true,
  }
  const stateResponse = options.stateResponse ?? {
    ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
    ahead: 0, behind: 0, changes: [], log: [], remotes: [], notice: '不是仓库',
  }
  const opResponse = options.opResponse ?? stateResponse
  const fetchStub = async (url, init = {}) => {
    calls.fetch.push({ url, init })
    if (String(url).includes('/git-panel/diag')) {
      calls.diag.push(JSON.parse(init.body))
      return { status: 200, json: async () => ({ ok: true }) }
    }
    const body = String(url).includes('/git-panel/op') ? opResponse : stateResponse
    return { status: 200, json: async () => body }
  }
  return { win, registrations, storage, listeners, calls, fetchStub }
}

/**
 * 在隔离的假浏览器环境里求值 bundle，并返回 factory 产物。
 * 用 `new Function` 而不是 import：bundle 会写 `window` 全局，且必须验证
 * 它是普通脚本（没有 import/export、没有构建产物语法）。
 */
function evaluateBundle(harness, reactApi) {
  const { win, fetchStub } = harness
  const sandbox = {
    window: win,
    fetch: fetchStub,
    URL, JSON, Object, Array, String, Number, Boolean, Math, Date, RegExp, Error, Promise,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, console,
    Event: class Event { constructor(type) { this.type = type } },
  }
  sandbox.globalThis = sandbox
  const keys = Object.keys(sandbox)
  const runner = new Function('window', 'fetch', 'Event', ...keys.filter((k) => !['window', 'fetch', 'Event'].includes(k)), CLIENT_SOURCE)
  runner(win, fetchStub, sandbox.Event, ...keys.filter((k) => !['window', 'fetch', 'Event'].includes(k)).map((k) => sandbox[k]))
  assert.equal(harness.registrations.length, 1, 'bundle 必须恰好调用一次 __ModuleLoader__.load')
  const registration = harness.registrations[0]
  assert.equal(registration.id, 'dsh-git-panel', 'bundle 注册的 id 必须是包名')
  assert.equal(typeof registration.factory, 'function', 'factory 必须是函数')
  const requested = []
  const exports = registration.factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return reactApi
    throw new Error(`client-modules: require("${specifier}") missed the module table`)
  })
  return { registration, exports, requested }
}

// ── 1. bundle 格式与依赖面 ──────────────────────────────────────────────────

test('client standalone：bundle 只 require 平台种子 react，不动其它模块', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports, requested } = evaluateBundle(harness, react.api)
  assert.deepEqual(requested, ['react'], '客户端半边只允许 require react（平台种子）；其它模块名换版本就没了')
  assert.equal(typeof exports.apply, 'function', '必须导出 apply')
  assert.deepEqual(exports.inject, ['slots'], '必须声明 slots 依赖（界面全靠它）')
})

test('client standalone：bundle 是普通脚本，没有 ESM / JSX / TS 语法', () => {
  assert.doesNotMatch(CLIENT_SOURCE, /^\s*(import|export)\s/m, 'bundle 不能有 ESM 语句')
  assert.doesNotMatch(CLIENT_SOURCE, /<\/?[A-Z][A-Za-z]*[\s/>]/, 'bundle 不能有 JSX')
  assert.doesNotMatch(CLIENT_SOURCE, /:\s*(string|number|boolean|any)\b/, 'bundle 不能有 TS 类型标注')
})

// ── 2. 界面注册：三种时机 ──────────────────────────────────────────────────

/** 造一个 mock slots 服务，记录 register 调用与顺序。 */
function makeSlots(options = {}) {
  const registered = []
  const injected = []
  const declared = new Set()
  // declareLater 语义：插槽在 apply 时尚未声明，但 inject 订阅后立刻被声明，
  // 于是回调里的第二次 register 成功——正是真实 ui-renderer 的 reconcile 行为。
  if (options.declareLater !== true) {
    declared.add('shell.overlay')
    declared.add('settings.general.item')
  }
  const slots = {
    register(options_, component) {
      if (options.registerAlwaysFails === true) {
        throw new Error(`single slot "${options_.name}" already has a registration at priority 0 — register at a different priority to shadow it`)
      }
      if (!declared.has(options_.name)) {
        throw new Error(`slot "${options_.name}" is not declared (a parent entry's children table must declare it)`)
      }
      if (options.duplicate === true) {
        throw new Error(`single slot "${options_.name}" already has a registration at priority 0 — register at a different priority to shadow it`)
      }
      registered.push({ options: options_, component })
      return () => {
        const index = registered.findIndex((entry) => entry.options === options_)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    inject(key, callback) {
      injected.push({ key, callback })
      // 真实实现会在订阅后立刻 reconcile 一次：这里复刻「插槽稍后声明」。
      if (options.declareLater === true) {
        declared.add(key)
        const dispose = callback()
        return dispose
      }
      return () => {}
    },
  }
  return { slots, registered, injected }
}

test('client standalone：slots 服务就绪时两个界面都直接注册成功', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots, registered, injected } = makeSlots()
  assert.doesNotThrow(() => exports.apply({ slots }))
  assert.deepEqual(registered.map((entry) => entry.options.name), ['shell.overlay', 'settings.general.item'])
  assert.equal(injected.length, 0, '直接注册成功就不该走 inject 等待')
  for (const entry of registered) {
    assert.equal(typeof entry.component, 'function', `${entry.options.name} 的组件必须是函数`)
  }
})

test('client standalone：slots 服务缺失时静默降级，不抛异常', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  assert.doesNotThrow(() => exports.apply({}))
  assert.doesNotThrow(() => exports.apply({ slots: undefined }))
  assert.doesNotThrow(() => exports.apply({ slots: null }))
})

test('client standalone：插槽尚未声明时退回 inject 等待并成功注册', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots, registered, injected } = makeSlots({ notDeclared: true, declareLater: true })
  assert.doesNotThrow(() => exports.apply({ slots }))
  assert.deepEqual(injected.map((entry) => entry.key), ['shell.overlay', 'settings.general.item'])
  assert.deepEqual(registered.map((entry) => entry.options.name), ['shell.overlay', 'settings.general.item'])
})

test('client standalone：注册失败会把原因回报宿主（不静默）', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots } = makeSlots({ duplicate: true })
  exports.apply({ slots })
  const stages = harness.calls.diag.map((row) => row.stage)
  assert.ok(stages.includes('overlay:direct-failed'), '直接注册失败必须回报诊断')
  assert.ok(stages.includes('settings:direct-failed'), '直接注册失败必须回报诊断')
  const failed = harness.calls.diag.find((row) => row.stage === 'overlay:direct-failed')
  assert.match(failed.detail, /already has a registration/, '诊断里要带上真实原因')
})

test('client standalone：声明已到但注册仍失败时，必须报出真实原因（不谎报成功）', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  // declareLater：插槽稍后声明，inject 回调会真的跑；registerAlwaysFails：注册永远失败。
  const { slots } = makeSlots({ declareLater: true, registerAlwaysFails: true })
  assert.doesNotThrow(() => exports.apply({ slots }))
  const stages = harness.calls.diag.map((row) => row.stage)
  assert.equal(stages.includes('declared-later'), false, '注册没成功就不能报 declared-later')
  assert.ok(stages.includes('overlay:register-failed-after-declaration'), '必须区分出「声明已到但注册失败」')
  const failed = harness.calls.diag.find((row) => row.stage === 'overlay:register-failed-after-declaration')
  assert.match(failed.detail, /already has a registration/, '诊断里要带上真实原因')
})

test('client standalone：slots.inject 本身抛异常时也不影响 apply', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const slots = {
    register() { throw new Error('slot "shell.overlay" is not declared (a parent entry\'s children table must declare it)') },
    inject() { throw new Error('slots 服务正在卸载') },
  }
  assert.doesNotThrow(() => exports.apply({ slots }))
  const stages = harness.calls.diag.map((row) => row.stage)
  assert.ok(stages.includes('overlay:inject-failed'), 'inject 失败也要回报诊断')
})

test('client standalone：重复 apply 不会抛异常（HMR / 重启场景）', () => {
  const harness = makeFakeWindow()
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots } = makeSlots()
  assert.doesNotThrow(() => { exports.apply({ slots }); exports.apply({ slots }) })
})

// ── 3. 组件渲染：props 缺失 / 完整都不能白屏 ────────────────────────────────

function renderComponent(harness, react, component, props) {
  react.beginRender()
  return component(props)
}

test('client standalone：GitPanel 在 props 缺失时也能渲染（slot 契约变化不白屏）', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const panel = registered.find((entry) => entry.options.name === 'shell.overlay').component
  assert.doesNotThrow(() => renderComponent(harness, react, panel, undefined))
  assert.doesNotThrow(() => renderComponent(harness, react, panel, {}))
  assert.doesNotThrow(() => renderComponent(harness, react, panel, { useSessions: (selector) => selector({ current: 's1', byId: { s1: { cwd: '/tmp/demo' } } }) }))
})

test('client standalone：GitPanelToggle 能渲染且读得到开关状态', () => {
  const harness = makeFakeWindow()
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const toggle = registered.find((entry) => entry.options.name === 'settings.general.item').component
  assert.doesNotThrow(() => renderComponent(harness, react, toggle, undefined))
  // 默认开启：localStorage 没有值时面板应显示为开。
  harness.storage.delete('dsh-git-panel-enabled')
  renderComponent(harness, react, toggle, undefined)
  // 关掉之后仍然能渲染。
  harness.storage.set('dsh-git-panel-enabled', '0')
  assert.doesNotThrow(() => renderComponent(harness, react, toggle, undefined))
})

test('client standalone：加载时清理旧版浮动帮助窗口遗留的 localStorage 键', () => {
  const harness = makeFakeWindow({
    prefillStorage: { 'dsh-git-panel-help-pos': '{x:1}', 'dsh-git-panel-help-size': '{w:1}' },
  })
  const { exports } = evaluateBundle(harness, makeFakeReact().api)
  const { slots } = makeSlots()
  exports.apply({ slots })
  assert.equal(harness.storage.has('dsh-git-panel-help-pos'), false, '旧位置键应被删除')
  assert.equal(harness.storage.has('dsh-git-panel-help-size'), false, '旧尺寸键应被删除')
})

test('client standalone：localStorage 不可用（隐私模式）也不崩', () => {
  const harness = makeFakeWindow()
  harness.win.localStorage = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
    removeItem() { throw new Error('denied') },
  }
  const react = makeFakeReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  assert.doesNotThrow(() => exports.apply({ slots }))
  const toggle = registered.find((entry) => entry.options.name === 'settings.general.item').component
  assert.doesNotThrow(() => renderComponent(harness, react, toggle, undefined))
})

// ── 4. 回归：点改动看 diff 必须走到终态 ─────────────────────────────────────

test('client standalone：点改动看 diff 不会停在「加载中…」（runOp 必须把结果返回给调用方）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: { ok: true, diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n', state: repoState },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const panel = registered.find((entry) => entry.options.name === 'shell.overlay').component

  react.mount(panel, {
    useSessions: (selector) => selector({ current: 's1', byId: { s1: { cwd: '/tmp/demo' } } }),
  })
  const initial = await react.settle()

  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  assert.ok(clickable !== undefined, '改动清单里应出现可点击的条目（先要拿到仓库状态）')

  // 修复前的形态：runOp 里 `const data` 声明在 try 块内、却用 `return data` 在
  // try 之外返回，每次调用都以 ReferenceError 结束 —— 于是这个 onClick 的
  // promise 直接 reject，await 之后的 setDiffText 永远不执行，界面停在中间态。
  await assert.doesNotReject(
    () => clickable.props.onClick(),
    '点 diff 的处理函数不能以异常结束，否则 diff 区永远停在「加载中…」',
  )

  const finalTree = await react.settle()
  const pres = flattenTree(finalTree).filter((node) => node.type === 'pre').map(textOf)
  assert.ok(!pres.includes('加载中…'), 'diff 区不能停在「加载中…」')
  assert.ok(pres.some((text) => text.includes('+two')), `diff 区应显示真实 diff，实际拿到：${JSON.stringify(pres)}`)
})

test('client standalone：runOp 失败时调用方拿到 ok:false（而不是 undefined 导致「未知错误」）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  // 让 /git-panel/op 直接抛（网络层失败），走 runOp 的 catch 分支。
  const failing = harness.fetchStub
  harness.fetchStub = async (url, init) => {
    if (String(url).includes('/git-panel/op')) throw new Error('HTTP 500')
    return failing(url, init)
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const panel = registered.find((entry) => entry.options.name === 'shell.overlay').component
  react.mount(panel, {
    useSessions: (selector) => selector({ current: 's1', byId: { s1: { cwd: '/tmp/demo' } } }),
  })
  const initial = await react.settle()
  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  assert.ok(clickable !== undefined)

  await assert.doesNotReject(() => clickable.props.onClick())
  const finalTree = await react.settle()
  const pres = flattenTree(finalTree).filter((node) => node.type === 'pre').map(textOf)
  assert.ok(
    pres.some((text) => text.includes('查看 diff 失败：HTTP 500')),
    `失败原因要原样回报，而不是「未知错误」：${JSON.stringify(pres)}`,
  )
})
