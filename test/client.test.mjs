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
//   7. 切换工作区后，面板上的东西（命令结果栏 / diff / 分支列表 / 状态）都属于
//      新工作区：属于旧仓库的瞬时结果会被清掉，切走之后才回来的异步结果会被丢弃。
//   8. 「跟随会话工作目录」真的会跟随：假 store 用的是**真实形状**的 SessionListState
//      （当前会话 = `retainedBy.mainView > 0` 的那一行，没有 `state.current` 这个字段）。
//      回归的是：面板曾读一个不存在的字段，于是永远按宿主进程的 cwd 跑。
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
        // 函数组件就地展开（复刻 reconciler 唯一必需的那一步）。面板被拆成多个
        // 展示组件之后，测试仍然拿到一棵扁平的宿主元素树 —— 不需要真的实现 reconciler，
        // 但**必须**有这一步，否则组件的内容在树里根本不存在。
        if (typeof type === 'function') return type(Object.assign({}, props, { children: children }))
        const node = { type, props: props === null || props === undefined ? {} : props, children }
        nodes.push(node)
        return node
      },
      useState: (initial) => {
        const index = hookIndex++
        return [typeof initial === 'function' ? initial() : initial, (value) => { effects.push([index, value]) }]
      },
      useReducer: (reducer, initial) => [
        typeof initial === 'function' ? initial() : initial,
        (action) => { effects.push(['reducer', action]) },
      ],
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
    createElement: (type, elementProps, ...children) => {
      // 与 makeFakeReact 同一套展开规则：函数组件就地调用，返回它画出的宿主元素。
      if (typeof type === 'function') return type(Object.assign({}, elementProps, { children: children }))
      return {
        type,
        props: elementProps === null || elementProps === undefined ? {} : elementProps,
        children,
      }
    },
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
    // 面板的状态全部收在一个 reducer 里（见 lib/client.js 的 panelReducer）：
    // 假 React 必须真的存值、真的跑 reducer，才能验「切工作区把旧仓库的字段清掉」。
    useReducer: (reducer, initial) => {
      const index = cursor++
      if (!Object.hasOwn(hooks, index)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const dispatch = (action) => {
        const next = reducer(hooks[index], action)
        if (Object.is(next, hooks[index])) return
        hooks[index] = next
        dirty = true
      }
      return [hooks[index], dispatch]
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
  /**
   * 每个 op 可以给不同的响应（options.opResponses，按 op 名索引）；没配的 op 仍然
   * 落在 opResponse 上 —— 老用例因此一行都不用改。
   */
  const opResponseFor = (init) => {
    if (options.opResponses === undefined) return opResponse
    try {
      const parsed = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
      const found = options.opResponses[parsed.op]
      return found !== undefined ? found : opResponse
    } catch {
      return opResponse
    }
  }
  // 网络加速配置：默认是「什么都没开」的干净状态。
  const netResponse = options.netResponse ?? {
    ok: true, mirrorEnabled: false, mirror: 'https://gh-proxy.com/',
    proxy: '', hasProxy: false,
    candidates: [
      { id: 'gh-proxy', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
      { id: 'ghproxy-net', label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
      { id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' },
    ],
  }
  const fetchStub = async (url, init = {}) => {
    calls.fetch.push({ url, init })
    if (String(url).includes('/git-panel/diag')) {
      calls.diag.push(JSON.parse(init.body))
      return { status: 200, json: async () => ({ ok: true }) }
    }
    if (String(url).includes('/git-panel/net')) {
      // 面板一挂载就会读这份配置；点「检测网络」时走 probe=1 那条分支。
      const body = options.probeResults !== undefined && String(url).includes('probe=1')
        ? { ok: true, results: options.probeResults }
        : netResponse
      return { status: 200, json: async () => body }
    }
    const body = String(url).includes('/git-panel/op') ? opResponseFor(init) : stateResponse
    return { status: 200, json: async () => body }
  }
  return { win, registrations, storage, listeners, calls, fetchStub, netResponse }
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
  assert.doesNotThrow(() => renderComponent(harness, react, panel, { useSessions: (selector) => selector(sessionStore({ s1: { cwd: '/tmp/demo' } })) }))
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
    useSessions: (selector) => selector(sessionStore({ s1: { cwd: '/tmp/demo' } })),
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
    useSessions: (selector) => selector(sessionStore({ s1: { cwd: '/tmp/demo' } })),
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

// ── 4b. 回归：展开的 diff 必须内联在改动清单里 ──────────────────────────────
//
// 现场：点改动条目后，diff 原先渲染在清单**外面**，而面板正文是一个可滚动的 flex 列
// —— 展开后 diff 既把清单挤成一条缝（`overflow:auto` 的 flex 子项自动最小尺寸为 0，
// 默认的 flex-shrink:1 会压缩它），又常常落到可视区之外。用户看到的现象就是
// 「弹出来的改动信息框把改动文件展示框盖住了」。
//
// 修法：diff 内联在被点的那一行下面，与文件行共用清单这一个滚动区；清单本身
// flex:0 0 auto（自带滚动，永不被压），展开期间把清单取景框放高。

test('client standalone：展开的 diff 内联在改动清单里，不挤掉也不盖住清单', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0,
    changes: [
      { code: ' M', path: 'a.txt', staged: false },
      { code: ' M', path: 'b.txt', staged: false },
    ],
    log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: {
      ok: true, diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n', state: repoState,
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))

  const initial = await react.settle()
  const list = flattenTree(initial).find((node) => node.props.key === 'changes')
  assert.ok(list !== undefined, '应渲染出改动清单容器')
  // 这一条钉的是根因：清单自带滚动，绝不能被 flex 压缩（否则就是「被盖住」）。
  assert.equal(list.props.style.flex, '0 0 auto', '改动清单不能被 flex 压扁')
  assert.equal(list.props.style.maxHeight, '148px', '没展开 diff 时清单保持紧凑高度')

  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  assert.ok(clickable !== undefined, '改动清单里应出现可点击的条目')
  await clickable.props.onClick()
  const opened = await react.settle()

  const openedList = flattenTree(opened).find((node) => node.props.key === 'changes')
  assert.ok(openedList !== undefined, '展开后清单容器仍在')
  const inline = flattenTree(openedList).find((node) =>
    node.type === 'pre' && textOf(node).includes('+two'))
  assert.ok(
    inline !== undefined,
    '展开的 diff 必须是改动清单的子树：放在清单外面会被正文滚动挤走，表现就是「盖住了清单」',
  )
  assert.equal(openedList.props.style.maxHeight, '360px', '展开 diff 时清单取景框要放高，否则 diff 只露一两行')
  assert.ok(textOf(openedList).includes('b.txt'), '展开一个文件的 diff 不能顶掉其它文件行')

  // 展开中的那一行要有标记，用户才知道下面那块 diff 是谁的。
  const active = flattenTree(openedList).find((node) =>
    typeof node.props.className === 'string' && node.props.className.includes('dgp-rowitem-active'))
  assert.ok(active !== undefined, '展开中的那一行要高亮')
  assert.ok(textOf(active).includes('a.txt'), '高亮的应该是被点开的那个文件')
})

// ── 5. 回归：切换工作区后，面板上的东西必须跟着切 ───────────────────────────
//
// 曾出现的问题：换工作区（切会话 / 手动切目录）后只有 snapshot 被替换，命令结果栏
// 还挂着旧仓库上一次 git 操作的输出。根因是有一批状态属于「某个具体仓库」却没有
// 任何人在切换时清理；同时迟到的异步结果也没有归属校验，慢操作（拉取/推送/克隆的
// 宿主超时是 10 分钟）回来时会直接盖到新工作区上。

/** 让 `/git-panel/state` 按 `?dir=` 返回不同仓库，用来验证面板真的换了工作区。 */
function makeDirAwareFetch(harness, byDir) {
  const base = harness.fetchStub
  return async (url, init = {}) => {
    const text = String(url)
    if (text.includes('/git-panel/state')) {
      const match = /[?&]dir=([^&]*)/.exec(text)
      const dir = match === null ? '' : decodeURIComponent(match[1])
      if (Object.hasOwn(byDir, dir)) {
        harness.calls.fetch.push({ url, init })
        return { status: 200, json: async () => byDir[dir] }
      }
    }
    return base(url, init)
  }
}

/**
 * 造一份**真实形状**的 SessionListState（宿主的 `@deepseek-ai/dsh-api-session-controller`
 * 契约）：字段是 ids / byId / phase / subagentsByParent / jobsBySession。
 *
 * 关键：「当前会话」**不是** `state.current` —— 那个字段不存在。宿主自己的
 * publishMain 与 ui-workspace 都是认列表里 `retainedBy.mainView > 0` 的那一行，
 * 这里刻意不提供 `current`：谁再照着不存在的字段写，测试立刻红。
 *
 * 缺省把第一行当作「主视图持有的会话」，要造别的形态（例如没有当前会话）就显式传
 * `retainedBy`。
 */
function sessionStore(rows) {
  const ids = Object.keys(rows)
  const byId = {}
  ids.forEach((id, index) => {
    byId[id] = {
      id,
      displayTitle: id,
      running: false,
      blank: false,
      updatedAt: 0,
      retainedBy: index === 0 ? { mainView: 1 } : {},
      ...rows[id],
    }
  })
  return { ids, byId, phase: 'ready', subagentsByParent: {}, jobsBySession: {} }
}

/** 把「当前会话」换成另一行 —— 等价于用户在会话列表里点了另一个会话。 */
function selectSession(store, id) {
  for (const row of Object.values(store.byId)) {
    row.retainedBy = { mainView: row.id === id ? 1 : 0 }
  }
  return store
}

/** 在给定会话 store 上挂载面板组件（`store` 可变，用来模拟切换工作区）。 */
function mountPanel(exports, react, store) {
  const { slots, registered } = makeSlots()
  exports.apply({ slots })
  const panel = registered.find((entry) => entry.options.name === 'shell.overlay').component
  react.mount(panel, { useSessions: (selector) => selector(store) })
}

/** 命令结果栏（面板里所有 <pre> 的文本）。 */
function outputBars(tree) {
  return flattenTree(tree).filter((node) => node.type === 'pre').map(textOf)
}

/** 找一个按钮元素（按可见文本）。 */
function findButton(tree, label) {
  return flattenTree(tree).find((node) => node.type === 'button' && textOf(node) === label)
}

const WS_A = {
  ok: true, dir: '/tmp/ws-a', isRepo: true, branch: 'main', upstream: null,
  ahead: 0, behind: 0, changes: [{ code: ' M', path: 'a.txt', staged: false }],
  log: [], remotes: [],
}
const WS_B = {
  ok: true, dir: '/tmp/ws-b', isRepo: true, branch: 'dev', upstream: null,
  ahead: 0, behind: 0, changes: [], log: [], remotes: [],
}

test('client standalone：切换工作区后命令结果栏不再挂着上一个工作区的输出', async () => {
  const opResult = {
    ok: true, command: 'git add -A', exitCode: 0, stdout: '', stderr: '', message: null,
    hint: null, clonedDir: null, branches: null, diff: null, state: WS_A,
  }
  const harness = makeFakeWindow({ stateResponse: WS_A, opResponse: opResult })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const store = sessionStore({ s1: { cwd: '/tmp/ws-a' } })
  mountPanel(exports, react, store)

  const first = await react.settle()
  assert.ok(textOf(first).includes('/tmp/ws-a'), '前置条件：面板要先加载到工作区 A')

  const addAll = findButton(first, '全部暂存')
  assert.ok(addAll !== undefined, 'A 是仓库，「全部暂存」按钮应该出现')
  await addAll.props.onClick()
  const afterOp = await react.settle()
  assert.ok(
    outputBars(afterOp).some((text) => text.includes('git add -A')),
    `前置条件：A 的命令结果栏里要有刚跑完的输出，实际：${JSON.stringify(outputBars(afterOp))}`,
  )

  // 换工作区：等价于用户在界面上切到另一个会话（当前会话的 cwd 变了）。
  store.byId.s1.cwd = '/tmp/ws-b'
  const afterSwitch = await react.settle()

  assert.ok(textOf(afterSwitch).includes('/tmp/ws-b'), '面板本身要跟着切到工作区 B')
  assert.ok(textOf(afterSwitch).includes('dev'), '分支要显示 B 的分支')
  assert.ok(
    !outputBars(afterSwitch).some((text) => text.includes('git add -A')),
    `切换工作区后命令结果栏不能还挂着 A 的输出，实际：${JSON.stringify(outputBars(afterSwitch))}`,
  )
})

test('client standalone：切到另一个会话后，面板跟着换到那个会话的工作目录', async () => {
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  // 两个会话、两个工作目录：这才是「跟着会话切换工作目录」的真实形态
  // （旧测试只动同一个会话的 cwd，恰好绕过了「认哪一行是当前会话」这一步）。
  const store = sessionStore({ 's-a': { cwd: '/tmp/ws-a' }, 's-b': { cwd: '/tmp/ws-b' } })
  mountPanel(exports, react, store)

  const first = await react.settle()
  assert.ok(textOf(first).includes('/tmp/ws-a'), '前置条件：面板先跟着会话 A 的工作目录')
  assert.ok(textOf(first).includes('main'), '前置条件：显示的是 A 的分支')

  selectSession(store, 's-b')
  const after = await react.settle()

  assert.ok(textOf(after).includes('/tmp/ws-b'), `切会话后面板要落到新会话的工作目录，实际：${textOf(after).slice(0, 300)}`)
  assert.ok(textOf(after).includes('dev'), '分支要变成 B 的分支')
  assert.ok(!textOf(after).includes('/tmp/ws-a'), '面板不能再显示旧会话的工作目录')
})

test('client standalone：没有当前会话时退回宿主缺省目录，而不是瞎猜一行', async () => {
  const harness = makeFakeWindow({ stateResponse: WS_A })
  const requested = []
  const base = harness.fetchStub
  harness.fetchStub = async (url, init) => {
    if (String(url).includes('/git-panel/state')) requested.push(String(url))
    return base(url, init)
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  // 两行都没有 mainView：一份「还没选中任何会话」的列表。
  const store = sessionStore({
    's-a': { cwd: '/tmp/ws-a', retainedBy: {} },
    's-b': { cwd: '/tmp/ws-b', retainedBy: {} },
  })
  mountPanel(exports, react, store)
  await react.settle()

  assert.ok(requested.length > 0, '面板还是要读一次状态（用宿主缺省目录）')
  assert.ok(
    requested.every((url) => !url.includes('dir=')),
    `没有当前会话时不能挑一行当当前会话，实际请求：${JSON.stringify(requested)}`,
  )
})

test('client standalone：手动切过目录后不再被会话目录覆盖（跟随会话按钮才恢复）', async () => {
  // 手填的目录必须由「宿主回传的 state.dir」确认（面板以宿主归一化后的路径为准），
  // 所以这一份响应的 dir 就是 /tmp/manual。
  const wsManual = { ...WS_B, dir: '/tmp/manual' }
  const harness = makeFakeWindow({ stateResponse: WS_A })
  harness.fetchStub = makeDirAwareFetch(harness, {
    '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B, '/tmp/manual': wsManual,
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const store = sessionStore({ 's-a': { cwd: '/tmp/ws-a' }, 's-b': { cwd: '/tmp/ws-b' } })
  mountPanel(exports, react, store)

  const first = await react.settle()
  const switchButton = findButton(first, '切换')
  assert.ok(switchButton !== undefined, '目录行应有「切换」按钮')
  switchButton.props.onClick()

  const editing = await react.settle()
  const input = flattenTree(editing).find((node) => node.type === 'input')
  assert.ok(input !== undefined, '点「切换」后应出现目录输入框')
  input.props.onChange({ target: { value: '/tmp/manual' } })

  const typed = await react.settle()
  const confirm = findButton(typed, '确定')
  assert.ok(confirm !== undefined, '输入框旁应有「确定」')
  await confirm.props.onClick()
  const manual = await react.settle()
  assert.ok(textOf(manual).includes('/tmp/manual'), '手动切换后应停在自己填的目录')

  // 会话切走了：手动选过目录就不再跟随（这是有意的，避免覆盖用户的输入）。
  selectSession(store, 's-b')
  const stillManual = await react.settle()
  assert.ok(textOf(stillManual).includes('/tmp/manual'), '手动选过目录后不应被会话目录覆盖')

  // 点「跟随会话」才回到当前会话的工作目录。
  const follow = findButton(stillManual, '跟随会话')
  assert.ok(follow !== undefined, '手动切换后应出现「跟随会话」按钮')
  await follow.props.onClick()
  const followed = await react.settle()
  assert.ok(textOf(followed).includes('/tmp/ws-b'), `点「跟随会话」后应回到会话 B 的目录，实际：${textOf(followed).slice(0, 300)}`)
})

test('client standalone：切走之后才回来的操作结果不能盖到新工作区上', async () => {
  const opResult = {
    ok: true, command: 'git pull', exitCode: 0, stdout: 'Already up to date.', stderr: '',
    message: null, hint: null, clonedDir: null, branches: null, diff: null, state: WS_A,
  }
  const harness = makeFakeWindow({ stateResponse: WS_A })
  const dirAware = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B })
  // 让 /git-panel/op 卡住不返回：模拟一次耗时的 pull（宿主侧超时 10 分钟）。
  let releaseOp = null
  harness.fetchStub = async (url, init = {}) => {
    if (String(url).includes('/git-panel/op')) {
      harness.calls.fetch.push({ url, init })
      return await new Promise((resolve) => { releaseOp = resolve })
    }
    return dirAware(url, init)
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const store = sessionStore({ s1: { cwd: '/tmp/ws-a' } })
  mountPanel(exports, react, store)

  const first = await react.settle()
  const pull = findButton(first, '拉取')
  assert.ok(pull !== undefined, 'A 是仓库，「拉取」按钮应该出现')
  const pending = pull.props.onClick()
  assert.equal(typeof releaseOp, 'function', '拉取请求应该已经发出去（并且还没回来）')

  // 操作还没回来，用户就切到了另一个工作区。
  store.byId.s1.cwd = '/tmp/ws-b'
  const afterSwitch = await react.settle()
  assert.ok(textOf(afterSwitch).includes('/tmp/ws-b'), '面板要先切到工作区 B')

  // 现在旧工作区的操作结果才回来。
  releaseOp({ status: 200, json: async () => opResult })
  await pending
  const finalTree = await react.settle()

  assert.ok(
    !outputBars(finalTree).some((text) => text.includes('git pull') || text.includes('up to date')),
    `旧工作区的输出不能盖到新工作区上，实际：${JSON.stringify(outputBars(finalTree))}`,
  )
  assert.ok(textOf(finalTree).includes('/tmp/ws-b'), '面板不能被旧工作区的状态切回去')
  assert.ok(textOf(finalTree).includes('dev'), '旧工作区的状态不能盖掉新工作区的状态')
})

// ── 6. 网络加速界面 ───────────────────────────────────────────────────────
//
// 这一节保的是「点了按钮真的有反应」和「渲染分支不白屏」：面板是新写的手绘
// createElement，任何一处笔误都会让整个 shell.overlay 渲染抛异常 —— 表现是
// Git 面板直接消失，而不是局部出错。

/** 打开 🌐 网络加速折叠块。 */
async function openNet(react) {
  const before = await react.settle()
  const globe = findButton(before, '🌐')
  assert.ok(globe !== undefined, '头部应有 🌐 按钮')
  assert.equal(typeof globe.props.onClick, 'function')
  globe.props.onClick()
  return react.settle()
}

test('client standalone：点 🌐 能展开加速设置，且渲染不抛异常', async () => {
  const harness = makeFakeWindow()
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))

  const tree = await openNet(react)
  const text = textOf(tree)
  assert.ok(text.includes('网络加速'), `展开后要看到设置块，实际：${text.slice(0, 200)}`)
  assert.ok(text.includes('gh-proxy.com'), '镜像候选要列出来')
  assert.ok(text.includes('检测网络'), '要有现场检测入口')
  // 安全提示必须在，且要说明私有仓库该怎么办 —— 这是这个功能的取舍核心。
  assert.ok(text.includes('第三方') && text.includes('私有仓库'))
  assert.ok(findButton(tree, '保存代理') !== undefined)
})

test('client standalone：面板挂载时会读一次宿主配置', async () => {
  const harness = makeFakeWindow({
    netResponse: {
      ok: true, mirrorEnabled: true, mirror: 'https://ghfast.top/',
      proxy: 'http://***@127.0.0.1:7890', hasProxy: true,
      candidates: [{ id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' }],
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  assert.ok(
    harness.calls.fetch.some((call) => String(call.url).includes('/git-panel/net')),
    '挂载时应读 /git-panel/net',
  )
  // 草稿框里应当是打码后的地址：真凭据永远不进浏览器。
  const text = textOf(tree)
  assert.ok(!text.includes('secret'))
  const globe = findButton(tree, '🌐')
  const opened = await (async () => { globe.props.onClick(); return react.settle() })()
  const proxyInput = flattenTree(opened).find((node) => node.type === 'input' && String(node.props.value).includes('127.0.0.1:7890'))
  assert.ok(proxyInput !== undefined, '代理输入框应预填宿主返回的（已打码）地址')
  assert.ok(String(proxyInput.props.value).includes('***'), '回传的必须是打码串')
})

test('client standalone：保存代理会把输入框内容 POST 给 /git-panel/net', async () => {
  const harness = makeFakeWindow()
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await openNet(react)

  const input = flattenTree(tree).find((node) => node.type === 'input' && String(node.props.placeholder).includes('本机代理'))
  assert.ok(input !== undefined, '应有代理输入框')
  input.props.onChange({ target: { value: 'http://127.0.0.1:7890' } })
  const afterType = await react.settle()

  const save = findButton(afterType, '保存代理')
  assert.equal(typeof save.props.onClick, 'function', '保存按钮必须真的接上处理函数')
  await save.props.onClick()
  await react.settle()

  // 只数打到 /git-panel/net 的 POST：/git-panel/diag 也是 POST，不能混进来。
  const posted = harness.calls.fetch.filter((call) =>
    String(call.url).includes('/git-panel/net') && call.init !== undefined && call.init.method === 'POST')
  assert.equal(posted.length, 1, `应恰好 POST 一次，实际 ${posted.length} 次`)
  assert.deepEqual(JSON.parse(posted[0].init.body), { proxy: 'http://127.0.0.1:7890' })
})

test('client standalone：宿主是旧版本、还没有 /git-panel/net 时，面板照常渲染并说明不可用', async () => {
  // 这正是「客户端已热重载、宿主还没重启」时的真实状态：404 回的是 HTML，
  // response.json() 会抛。读配置失败绝不能把整个面板带崩。
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const base = harness.fetchStub
  harness.fetchStub = async (url, init = {}) => {
    if (String(url).includes('/git-panel/net')) {
      return {
        status: 404,
        json: async () => { throw new Error('Unexpected token < in JSON') },
      }
    }
    return base(url, init)
  }
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))

  const tree = await react.settle()
  assert.ok(textOf(tree).includes('main'), '读不到加速配置不影响仓库状态显示')
  assert.ok(findButton(tree, '获取远程') !== undefined, '按钮照常在')

  const opened = await openNet(react)
  assert.ok(textOf(opened).includes('读不到宿主配置'), '要明确告诉用户是宿主版本的问题，而不是静默空白')
  // 检测按钮不该在一个必然 404 的宿主上还让用户点。
  assert.equal(findButton(opened, '检测网络'), undefined)
})

test('client standalone：点「检测网络」把各线路结果列出来（含失败的线路）', async () => {
  const harness = makeFakeWindow({
    probeResults: [
      { kind: 'direct', label: '直连 github.com', ok: false, ms: 8000, error: '命令超时（8000ms 内无响应）' },
      { kind: 'mirror', label: 'gh-proxy.com', ok: true, ms: 820, error: null },
      { kind: 'mirror', label: 'ghfast.top', ok: true, ms: 1040, error: null },
    ],
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await openNet(react)

  await findButton(tree, '检测网络').props.onClick()
  const after = await react.settle()
  const text = textOf(after)

  assert.ok(harness.calls.fetch.some((call) => String(call.url).includes('probe=1')), '应请求 probe=1')
  assert.ok(text.includes('ghfast.top'), '通的线路要列出来')
  assert.ok(text.includes('820ms'), '通了的要显示耗时')
  assert.ok(text.includes('直连 github.com'), '不通的线路也要列出来（否则用户不知道差别在哪）')
  assert.ok(text.includes('✗'), '失败的线路要有明确标记')
})

test('client standalone：宿主判定是网络问题时自动展开加速设置，并把说明回显到结果栏', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: {
      ok: false, command: 'git fetch --all --prune', exitCode: 128,
      stdout: '', stderr: "fatal: unable to access 'https://github.com/x/y': Recv failure: Connection was reset",
      message: 'Recv failure: Connection was reset',
      hint: '连不上远端（连接被重置 / 超时），国内直连 github.com 很常见。点面板右上角的 🌐 打开「网络加速」…',
      network: true, accelerated: 'direct', notes: [],
      state: repoState,
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))

  const initial = await react.settle()
  // 先确认设置块确实是收起的（不然下面那条断言会因为「本来就开着」而假通过）。
  assert.equal(findButton(initial, '检测网络'), undefined, '初始状态加速设置应是收起的')

  const fetchBtn = findButton(initial, '获取远程')
  assert.ok(fetchBtn !== undefined, '仓库里应有「获取远程」按钮')
  await fetchBtn.props.onClick()
  const after = await react.settle()
  const text = textOf(after)

  // 断言「只有展开时才存在」的控件，而不是「网络加速」这四个字 —— 后者在提示
  // 文案里也有（「点面板右上角的 🌐 打开「网络加速」」），拿它断言会假通过。
  assert.ok(
    findButton(after, '检测网络') !== undefined,
    '网络失败要自动把加速设置展开，而不是只说「点 🌐」让用户自己找',
  )
  assert.ok(text.includes('Connection was reset'), '原始报错要保留，用户才能搜')
  assert.ok(text.includes('连不上远端'), '要给出下一步提示')
})

test('client standalone：开了加速时，命令结果栏要说明这条命令走了哪条线路', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponse: {
      ok: true, command: 'git fetch --all --prune', exitCode: 0, stdout: '', stderr: '',
      message: null, hint: null, network: false, accelerated: 'mirror',
      notes: ['已通过镜像 gh-proxy.com 加速（只作用于本次命令，不改你的 git 配置）'],
      state: repoState,
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  await findButton(initial, '获取远程').props.onClick()
  const after = await react.settle()
  const bars = outputBars(after).join('\n')

  // 走镜像 = 请求经过了第三方，用户必须看得见，不能在后台默默发生。
  assert.ok(bars.includes('已通过镜像 gh-proxy.com'), `结果栏应说明走了镜像，实际：${JSON.stringify(outputBars(after))}`)
  assert.ok(bars.includes('$ git fetch --all --prune'), '命令回显仍要在')
})

// ── 7. 远端分支：获取远程之后要能看见，并且能一键拿成本地新分支 ─────────────
//
// 现场：本地 `git init` 出来的分支叫 master，远端默认分支叫 main。面板原先只列本地
// 分支，界面上根本看不到 origin/main —— 用户既不知道远端有什么，也没有入口去点它，
// 于是「拉取」只会在 couldn't find remote ref master 上打转。

test('client standalone：分支管理器列出远端分支，点「拿成新分支」把显式的 origin/main 交给宿主', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'master', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: 'https://example.com/demo.git' }],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      // 合并后的契约：一次 branches 同时回本地与远端两份。宿主因此只花一次 HTTP
      // 往返，而且数据型操作不回读仓库状态（noState）—— 展开一次管理器由原先的
      // 两次 op ×（1 条 git + 4 条状态 git）降到 2 条 git。
      branches: {
        ok: true,
        branches: { current: 'master', items: [{ name: 'master', current: true }] },
        remoteBranches: {
          defaultRef: 'origin/main',
          items: [
            { remote: 'origin', name: 'main', ref: 'origin/main', head: true },
            { remote: 'origin', name: 'dev', ref: 'origin/dev', head: false },
          ],
        },
        state: null,
      },
      adoptRemote: { ok: true, state: repoState },
      compare: { ok: true, compare: { ref: 'origin/main', ahead: 0, behind: 3 }, state: repoState },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const manage = findButton(initial, '管理')
  assert.ok(manage !== undefined, '应渲染出「管理」按钮')
  await manage.props.onClick()
  const opened = await react.settle()

  const opCalls = () => harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-panel/op'))
    .map((call) => JSON.parse(call.init.body))
  // 展开管理器只发**一次** branches（本地 + 远端一次拿回），且带 noState：
  // 数据型操作没必要让宿主再回读一次仓库状态（那要额外跑 4 条 git）。
  const branchCalls = opCalls().filter((payload) => payload.op === 'branches')
  assert.equal(branchCalls.length, 1, '展开时应恰好查一次 branches：' + JSON.stringify(opCalls()))
  assert.equal(branchCalls[0].noState, true, '数据型操作应带 noState')
  assert.ok(
    !opCalls().some((payload) => payload.op === 'remoteBranches'),
    '远端分支已随 branches 一起回来，不该再发第二次 op',
  )
  const texts = flattenTree(opened).map(textOf)
  assert.ok(
    texts.some((text) => text.includes('origin/main')),
    `远端分支要出现在管理器里，实际：${JSON.stringify(texts.slice(0, 30))}`,
  )
  assert.ok(texts.some((text) => text.includes('origin/dev')), '远端不止一个分支时都要列出来')

  // 「拿成新分支」：必须显式带 remote/branch —— 当前分支叫 master，猜不出来。
  const take = findButton(opened, '拿成新分支')
  assert.ok(take !== undefined, '远端分支旁边要有「拿成新分支」')
  await assert.doesNotReject(() => take.props.onClick(), '点「拿成新分支」不能以异常结束')
  const afterTake = await react.settle()
  const asked = opCalls().filter((payload) => payload.op === 'adoptRemote')
  assert.equal(asked.length, 1, '应该 POST 过一次 adoptRemote：' + JSON.stringify(opCalls()))
  assert.deepEqual(
    { mode: asked[0].mode, remote: asked[0].remote, branch: asked[0].branch },
    { mode: 'branch', remote: 'origin', branch: 'main' },
  )
  // 点远端分支**不是**切换分支：不能顺手发出 checkout（那会变成游离 HEAD）。
  assert.ok(!opCalls().some((payload) => payload.op === 'checkout'), '点远端分支不该触发 checkout')

  // 「比较」：把 ref 交给宿主，原始两列数字由宿主翻成人话放进 notes。
  const compare = findButton(afterTake, '比较')
  assert.ok(compare !== undefined, '远端分支旁边要有「比较」')
  await assert.doesNotReject(() => compare.props.onClick(), '点「比较」不能以异常结束')
  await react.settle()
  const compares = opCalls().filter((payload) => payload.op === 'compare')
  assert.equal(compares.length, 1, '应该 POST 过一次 compare')
  assert.equal(compares[0].ref, 'origin/main')
})

test('client standalone：默认分支有独立「默认」徽章、全名进 tooltip、分组顶部有提示行且钉在第一行', async () => {
  // 回归一：默认标记原先写在名字字符串里（`origin/main（默认）`），名字一被省略号
  // 截断标记就跟着消失；远端行的 title 又不含 ref，截断后全名无法看到。现在
  // 「默认」是独立徽章（截图不影响），名字的 tooltip 带完整 ref，分组标题下
  // 多一行「远端默认分支：…」（本地指针缺失时由宿主补查 remoteBranches.defaults）。
  // 回归二：默认分支按字母序会夹在几十条分支中间（llama.cpp 的 master 就在第二十几条），
  // 用户看着像「没下载下来」。渲染时把 head 的那条钉到远端分组**第一行**。
  const LONG_REF = 'origin/feature/very-long-branch-name-that-will-definitely-be-ellipsized'
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'master', upstream: null,
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: 'https://example.com/demo.git' }],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'master', items: [{ name: 'master', current: true }] },
        remoteBranches: {
          defaultRef: null, // 本地没有 origin/HEAD（镜像/旧 git 现场）
          defaults: [{ remote: 'origin', branch: 'main' }],
          // 刻意让默认分支**不在第一个**：wire 数据是字母序（长分支在前），
          // 钉到第一行必须是客户端的渲染职责。
          items: [
            { remote: 'origin', name: 'feature/very-long-branch-name-that-will-definitely-be-ellipsized',
              ref: LONG_REF, head: false },
            { remote: 'origin', name: 'main', ref: 'origin/main', head: true },
            { remote: 'origin', name: 'dev', ref: 'origin/dev', head: false },
          ],
        },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()
  await findButton(initial, '管理').props.onClick()
  const opened = await react.settle()

  const texts = flattenTree(opened).map(textOf)
  // 分组顶部提示行：即使本地没有 origin/HEAD（defaultRef 为 null），宿主的
  // 补查答案（defaults）也要显示出来 —— 用户一眼知道该拿哪份。
  assert.ok(
    texts.some((text) => text.includes('远端默认分支：origin/main')),
    `应有默认分支提示行，实际：${JSON.stringify(texts.slice(0, 30))}`,
  )
  // 「默认」徽章独立于名字存在（不再是名字后缀），且不包含在名字文本里 ——
  // 名字被 CSS 截断时徽章仍完整可见。
  assert.ok(
    texts.some((text) => text === '默认'),
    `应有独立的「默认」徽章文本，实际：${JSON.stringify(texts.slice(0, 30))}`,
  )
  // tooltip 必须带完整 ref：长分支名被省略号截断后，悬停仍能看到全名。
  const titled = flattenTree(opened).filter((node) => typeof node.props.title === 'string')
  assert.ok(
    titled.some((node) => node.props.title.startsWith(LONG_REF)),
    `长分支名的 tooltip 要带完整 ref，实际：${JSON.stringify(titled.map((node) => node.props.title).slice(0, 10))}`,
  )
  const badge = flattenTree(opened).find((node) => node.type === 'span' && textOf(node) === '默认')
  assert.ok(badge !== undefined && typeof badge.props.title === 'string' && badge.props.title.includes('origin/main'),
    '默认徽章要注明它指哪个分支')
  // 名字文本本身不再带「（默认）」后缀（截断会吃掉它）。
  assert.ok(!texts.some((text) => text.includes('（默认）')), '默认标记不再作为名字后缀显示')

  // 渲染顺序：默认分支必须排在整个远端分组的第一行（wire 数据里它在中间）。
  const remoteNameSpans = flattenTree(opened).filter((node) =>
    node.type === 'span' && typeof node.props.title === 'string'
    && node.props.title.startsWith('origin/'))
  const titles = remoteNameSpans.map((node) => node.props.title)
  const mainPos = titles.findIndex((text) => text.startsWith('origin/main'))
  const longPos = titles.findIndex((text) => text.startsWith(LONG_REF))
  const devPos = titles.findIndex((text) => text.startsWith('origin/dev'))
  assert.ok(mainPos === 0, `默认分支要钉在远端分组第一行，实际顺序：${JSON.stringify(titles)}`)
  assert.ok(longPos > mainPos && devPos > mainPos, `其余分支仍按 ref 排序，实际顺序：${JSON.stringify(titles)}`)
})

// ── 8. 新增契约：宿主诊断必须可见 / 截断必须说出来 / noState / reset-repo ─────

test('client standalone：宿主给的 notice 必须显示出来（回归：宿主算了却没人读）', async () => {
  // 没装 git 时宿主会把「请先安装 git」放进 state.notice。面板原先只显示一句通用的
  // 「还不是 Git 仓库」—— 最有用的那条诊断在传输层就丢了。
  const harness = makeFakeWindow({
    stateResponse: {
      ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
      ahead: 0, behind: 0, changes: [], changesTotal: 0, log: [], remotes: [],
      notice: '未检测到 git：请先安装 git（https://git-scm.com）后重试。',
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  assert.ok(text.includes('未检测到 git'), `面板要显示宿主的诊断，实际：${text.slice(0, 300)}`)
  assert.ok(text.includes('还没有 Git 仓库'), '通用说明仍要在（它告诉用户下一步点哪里）')
})

test('client standalone：宿主只说「还不是仓库」时不重复叠加，通用说明就够了', async () => {
  const harness = makeFakeWindow({
    stateResponse: {
      ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
      ahead: 0, behind: 0, changes: [], changesTotal: 0, log: [], remotes: [],
      notice: '当前目录还不是 Git 仓库',
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  assert.ok(text.includes('还没有 Git 仓库'))
  assert.equal(text.includes('⚠'), false, '默认 notice 与通用说明重复，不该再叠一行')
})

test('client standalone：改动被截断时必须说明「还有 N 处未显示」，胶囊用真实总数', async () => {
  const changes = []
  for (let index = 0; index < 100; index += 1) {
    changes.push({ code: ' M', path: 'f' + index + '.txt', staged: false })
  }
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: null,
    ahead: 0, behind: 0, changes, changesTotal: 137, log: [], remotes: [],
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()
  const text = textOf(tree)
  // 面板画 40 条，宿主回了 100 条、真实总数 137：差多少必须写出来。
  assert.ok(text.includes('还有 97 处未显示'), `截断要说出来，实际：${text.slice(0, 400)}`)
  assert.ok(text.includes('137 处改动'), '摘要胶囊要用宿主的真实总数，不是列表长度')
})

test('client standalone：数据型操作带 noState，state:null 也不会抹掉面板状态', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    changesTotal: 1, log: [], remotes: [],
  }
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      // 宿主对 noState 的回复：state 为 null（省掉 4 条 git 进程）。
      diff: { ok: true, diff: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-one\n+two\n', state: null },
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }] },
        remoteBranches: { defaultRef: null, items: [] },
        state: null,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const initial = await react.settle()

  const clickable = flattenTree(initial).find((node) =>
    typeof node.props.title === 'string' && node.props.title.includes('点击查看 diff'))
  await clickable.props.onClick()
  const after = await react.settle()

  const opCalls = () => harness.calls.fetch
    .filter((call) => String(call.url).includes('/git-panel/op'))
    .map((call) => JSON.parse(call.init.body))
  const diffCall = opCalls().find((payload) => payload.op === 'diff')
  assert.equal(diffCall.noState, true, 'diff 是数据型操作，应带 noState')
  assert.ok(textOf(after).includes('+two'), 'diff 仍然要显示出来')
  // state:null 绝不能把面板状态清空：分支、目录、改动清单都还在。
  assert.ok(textOf(after).includes('main'), 'state:null 不该抹掉分支')
  assert.ok(textOf(after).includes('/tmp/demo'), 'state:null 不该抹掉目录')
  assert.ok(textOf(after).includes('a.txt'), 'state:null 不该抹掉改动清单')
})

test('client standalone：数组子节点必须都带 key（真实 React 会警告，假 React 不会）', async () => {
  // 回归：GitPanel 的 children 是数组，拆分组件之后有几个元素忘了 key —— 假 React
  // 不检查这一点，真实 React 18 会打 "Each child in a list should have a unique key"。
  // 这里把规则显式编码进测试：数组里的每个元素都必须有 props.key。
  const problems = []
  const walk = (node, path) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, path + '[]')
      return
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item !== null && typeof item === 'object' && !Array.isArray(item) && item.props.key === undefined) {
              problems.push(String(item.type) + ' @' + path)
            }
          }
        }
        walk(child, path + '>' + String(node.type))
      }
    }
  }
  const assertKeys = (tree) => {
    walk(tree, 'root')
    assert.deepEqual(problems, [], '数组里的元素必须带 key：' + JSON.stringify(problems))
  }

  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0,
    changes: [{ code: ' M', path: 'a.txt', staged: false }],
    changesTotal: 1,
    log: [{ hash: 'abc1234', subject: 'first' }],
    remotes: [{ name: 'origin', url: 'https://example.com/a.git' }],
  }
  // ① 仓库 + 展开网络块与分支管理器
  const harness = makeFakeWindow({
    stateResponse: repoState,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }] },
        remoteBranches: { defaultRef: 'origin/main', items: [{ remote: 'origin', name: 'main', ref: 'origin/main', head: true }] },
        state: null,
      },
      pull: {
        ok: false, reason: 'unrelated', message: '两边是两套互不相关的历史',
        choices: [{ id: 'branch', label: '拿成新分支', detail: '安全', op: 'adoptRemote', params: {}, confirm: null }],
        network: false, notes: [], accelerated: 'direct', state: repoState,
      },
    },
  })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  let tree = await react.settle()
  assertKeys(tree)
  await findButton(tree, '🌐').props.onClick()
  tree = await react.settle()
  assertKeys(tree)
  await findButton(tree, '管理').props.onClick()
  tree = await react.settle()
  assertKeys(tree)
  await findButton(tree, '拉取').props.onClick()
  tree = await react.settle()
  assert.ok(findButton(tree, '拿成新分支') !== undefined, '前置条件：选项按钮渲染出来了')
  assertKeys(tree)

  // ② 非仓库 + 展开克隆表单
  const emptyHarness = makeFakeWindow({
    stateResponse: {
      ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
      ahead: 0, behind: 0, changes: [], changesTotal: 0, log: [], remotes: [], notice: null,
    },
  })
  const emptyReact = makeStatefulReact()
  const emptyBundle = evaluateBundle(emptyHarness, emptyReact.api)
  mountPanel(emptyBundle.exports, emptyReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  let emptyTree = await emptyReact.settle()
  assertKeys(emptyTree)
  await findButton(emptyTree, '克隆仓库').props.onClick()
  emptyTree = await emptyReact.settle()
  assert.ok(findButton(emptyTree, '开始克隆') !== undefined, '前置条件：克隆表单渲染出来了')
  assertKeys(emptyTree)
})

test('client standalone：换工作区会收起分支管理器并清掉远程地址草稿（reducer 的 reset-repo）', async () => {
  const harness = makeFakeWindow({
    stateResponse: WS_A,
    opResponses: {
      branches: {
        ok: true,
        branches: { current: 'main', items: [{ name: 'main', current: true }] },
        remoteBranches: { defaultRef: null, items: [] },
        state: null,
      },
    },
  })
  harness.fetchStub = makeDirAwareFetch(harness, { '/tmp/ws-a': WS_A, '/tmp/ws-b': WS_B })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  const store = sessionStore({ s1: { cwd: '/tmp/ws-a' } })
  mountPanel(exports, react, store)

  let tree = await react.settle()
  await findButton(tree, '管理').props.onClick()
  tree = await react.settle()
  assert.ok(textOf(tree).includes('本地分支'), '前置条件：分支管理器已展开')

  // A 没有远程 → 按钮是「配置」；展开后填一个**没保存**的地址。
  await findButton(tree, '配置').props.onClick()
  tree = await react.settle()
  // 输入框的「内容」在 props.value 里（textOf 只看子节点，DOM 里的 input 也一样）。
  const remoteInput = (node) => flattenTree(node).find((child) =>
    child.type === 'input' && String(child.props.placeholder).includes('git@github.com'))
  const before = remoteInput(tree)
  assert.ok(before !== undefined, '应出现仓库地址输入框')
  before.props.onChange({ target: { value: 'https://example.com/not-saved.git' } })
  tree = await react.settle()
  assert.ok(String(remoteInput(tree).props.value).includes('not-saved'), '前置条件：草稿已填进输入框')

  // 换工作区：属于旧仓库的东西必须清掉 —— 这正是 reducer 的 'reset-repo' 在管的事。
  store.byId.s1.cwd = '/tmp/ws-b'
  tree = await react.settle()
  assert.equal(textOf(tree).includes('本地分支'), false, '分支管理器属于旧仓库，切走后要收起')
  const after = remoteInput(tree)
  assert.equal(
    after !== undefined && String(after.props.value).includes('not-saved'),
    false,
    '远程地址草稿不能带到新仓库',
  )
})

// ── 9. 打开仓库主页：远程地址能推导出网页地址时给出「仓库页 ↗」入口 ──────────

test('client standalone：有 pageUrl 时远程行出现「仓库页 ↗」外链（新标签页，不经过宿主）', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: 'git@github.com:user/demo.git' }],
    // 宿主由远程地址推导出来（scp 风格 → https 页面地址）。
    pageUrl: 'https://github.com/user/demo',
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const link = flattenTree(tree).find((node) =>
    node !== null && typeof node === 'object' && node.type === 'a' && node.props.href === 'https://github.com/user/demo')
  assert.ok(link !== undefined, '远程行应渲染出仓库主页链接')
  assert.equal(link.props.target, '_blank', '要新标签页打开')
  assert.equal(link.props.rel, 'noopener noreferrer', '新标签页链接要带 rel=noopener')
  assert.ok(textOf(link).includes('仓库页'), '链接要自带「仓库页」字样，用户才知道它是干嘛的')
  assert.ok(
    String(link.props.title).includes('https://github.com/user/demo'),
    '链接标题要带真实地址：' + String(link.props.title),
  )
  // 它是 <a> 不是 <button>：跳转交给浏览器（支持中键/复制地址），不发任何 op。
  assert.equal(link.props.onClick, undefined, '外链不该有 onClick')
  const opCalls = harness.calls.fetch.filter((call) => String(call.url).includes('/git-panel/op'))
  assert.equal(opCalls.length, 0, '打开仓库页是纯跳转，不产生任何 git 操作')
})

test('client standalone：推导不出网页地址（本地路径 / 老宿主没回 pageUrl）时不显示死链', async () => {
  const repoState = {
    ok: true, dir: '/tmp/demo', isRepo: true, branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0, changes: [], log: [],
    remotes: [{ name: 'origin', url: '/srv/local-mirror.git' }],
    // 地址是本地路径，宿主推导不出网页地址 → pageUrl 为 null；老版本宿主干脆没这个字段。
    pageUrl: null,
  }
  const harness = makeFakeWindow({ stateResponse: repoState })
  const react = makeStatefulReact()
  const { exports } = evaluateBundle(harness, react.api)
  mountPanel(exports, react, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const tree = await react.settle()

  const links = flattenTree(tree).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'a'
    && typeof node.props.href === 'string' && node.props.href.startsWith('http'))
  assert.equal(links.length, 0, '本地路径远程不该出现仓库页链接：' + JSON.stringify(links.map((node) => node.props.href)))

  // 老宿主：state 里根本没有 pageUrl 字段（例如宿主还是旧版本、客户端已热重载）。
  const legacyState = Object.assign({}, repoState, { remotes: [{ name: 'origin', url: 'https://github.com/user/demo.git' }] })
  delete legacyState.pageUrl
  const legacyHarness = makeFakeWindow({ stateResponse: legacyState })
  const legacyReact = makeStatefulReact()
  const legacyBundle = evaluateBundle(legacyHarness, legacyReact.api)
  mountPanel(legacyBundle.exports, legacyReact, sessionStore({ s1: { cwd: '/tmp/demo' } }))
  const legacyTree = await legacyReact.settle()
  const legacyLinks = flattenTree(legacyTree).filter((node) =>
    node !== null && typeof node === 'object' && node.type === 'a'
    && typeof node.props.href === 'string' && node.props.href.startsWith('http'))
  assert.equal(legacyLinks.length, 0, '没回 pageUrl 时宁可没有入口，不能给出死链')
})

