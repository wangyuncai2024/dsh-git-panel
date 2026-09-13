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
//   5. 两个组件都能渲染（含 props 缺失——将来 slot 契约变了也不能白屏）。
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
  const fetchStub = async (url, init = {}) => {
    calls.fetch.push({ url, init })
    if (String(url).includes('/git-panel/diag')) {
      calls.diag.push(JSON.parse(init.body))
      return { status: 200, json: async () => ({ ok: true }) }
    }
    return {
      status: 200,
      json: async () => ({
        ok: true, dir: '/tmp/demo', isRepo: false, branch: null, upstream: null,
        ahead: 0, behind: 0, changes: [], log: [], remotes: [], notice: '不是仓库',
      }),
    }
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
