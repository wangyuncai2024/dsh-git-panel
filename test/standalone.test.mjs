// dsh-git-panel —— 独立运行（standalone）回归测试
// ============================================================================
// 目标：**不装进 DSH、不依赖任何外部依赖**，只用一个 mock ctx 就把宿主半边完整
// 跑一遍，从而在任何机器 / 任何 DSH 版本上都能先证明「插件本身能加载、能注册」。
//
// 覆盖三件在换机器/换 DSH 版本时最容易坏、又最难发现的事：
//   1. 模块能被 import —— 只用 node: 内置模块，不带任何 npm 依赖。
//   2. apply(ctx) 不抛异常 —— webServer / tools 两种惰性服务都覆盖
//      （立刻可用 / 稍后就绪 / 两者都缺）。
//   3. 每个 git 工具的 parameters 都是 harness 支持的 JSON Schema 子集
//      （type/oneOf/properties/required/additionalProperties/items/enum/const
//      + description/title/default/examples）。**不支持 anyOf / $ref / format /
//      pattern 等**；一旦用了，tools.register 会抛错，13 个工具会静默全丢。
//      mock 注册表在这里复刻 harness 的校验，跑测试就等价于跑一次真注册。
// ============================================================================

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 日志会落在 $DSH_HOME 下；测试期间把它指到临时目录，绝不能写进用户真实主目录。
let tempHome = null
before(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'git-panel-standalone-'))
  process.env.DSH_HOME = tempHome
})
after(async () => {
  if (tempHome !== null) await rm(tempHome, { recursive: true, force: true })
})

// ── harness JSON Schema 子集校验（复刻 dsh-tools 的 assertSupportedJsonSchema） ──
// 只复刻判定规则，不引入任何依赖；规则见 packages/core/tools/src/json-schema.ts。

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const ALLOWED_FOR = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null'],
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 返回违规说明数组；空数组 = 该 schema 在 harness 里合法。 */
function schemaViolations(node, path = 'schema') {
  const out = []
  if (!isPlainObject(node)) return [`${path} is not a schema object`]
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue
    if (ANNOTATION_KEYWORDS.has(key)) continue
    out.push(`${path}.${key} is not a supported keyword`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) return [...out, `${path} cannot declare both type and oneOf`]
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLING_KEYWORDS) {
      if (Object.hasOwn(node, key)) out.push(`${path}.${key} requires type or oneOf`)
    }
    return out
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      return [...out, `${path}.oneOf must be an array of at least two schemas`]
    }
    node.oneOf.forEach((child, index) => out.push(...schemaViolations(child, `${path}.oneOf[${index}]`)))
    return out
  }
  if (typeof node.type !== 'string' || !SCHEMA_TYPES.includes(node.type)) {
    return [...out, `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`]
  }
  for (const [key, types] of Object.entries(ALLOWED_FOR)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) {
      out.push(`${path}.${key} is not supported on type "${node.type}"`)
    }
  }
  if (node.type === 'object' && Object.hasOwn(node, 'properties')) {
    if (!isPlainObject(node.properties)) {
      out.push(`${path}.properties must be an object of schemas`)
    } else {
      for (const [name, child] of Object.entries(node.properties)) {
        out.push(...schemaViolations(child, `${path}.properties.${name}`))
      }
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    out.push(...schemaViolations(node.items, `${path}.items`))
  }
  return out
}

// ── mock ctx：复刻插件用到的全部宿主契约 ────────────────────────────────────

/**
 * 造一个 mock ctx。
 * @param options.withWebServer - 是否在 apply 之前就有 webServer 实例。
 * @param options.withTools - 是否在 apply 之前就有 tools 实例。
 * @param options.deferServices - true 时两者都不在 apply 时提供，只在稍后
 *   通过 ctx.inject 的回调里给（复刻 harness 的惰性服务就绪时机）。
 */
function makeCtx(options = {}) {
  const routes = []
  const tools = []
  const effects = []
  const pendingInject = []
  const server = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const registry = {
    register(definition) {
      assert.equal(typeof definition.name, 'string', 'tool.name 必须是字符串')
      assert.ok(definition.name.length > 0, 'tool.name 不能为空')
      assert.equal(typeof definition.description, 'string', `工具 ${definition.name} 缺少 description`)
      const violations = schemaViolations(definition.parameters)
      assert.deepEqual(violations, [], `工具 ${definition.name} 的 parameters 不是受支持的 JSON Schema：\n  ${violations.join('\n  ')}`)
      assert.equal(typeof definition.output?.render, 'function', `工具 ${definition.name} 缺少 output.render`)
      assert.equal(typeof definition.execute, 'function', `工具 ${definition.name} 缺少 execute`)
      tools.push(definition)
      return () => {
        const index = tools.indexOf(definition)
        if (index >= 0) tools.splice(index, 1)
      }
    },
  }
  const deferred = options.deferServices === true
  const ctx = {
    get(service) {
      if (deferred) return undefined
      if (service === 'webServer' && options.withWebServer !== false) return server
      if (service === 'tools' && options.withTools !== false) return registry
      return undefined
    },
    inject(services, callback) {
      pendingInject.push({ services: [...services], callback })
    },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
  }
  return {
    ctx,
    routes,
    tools,
    server,
    registry,
    /** 触发所有排队的 ctx.inject 回调（复刻惰性服务就绪）。 */
    flushInject() {
      for (const entry of pendingInject.splice(0)) entry.callback({ webServer: server, tools: registry })
    },
    /** 触发 effect 的清理函数（复刻卸载）。 */
    dispose() {
      for (const factory of effects) {
        const disposer = factory()
        if (typeof disposer === 'function') disposer()
      }
    },
  }
}

// ── 1. 模块可独立 import（零 npm 依赖） ─────────────────────────────────────

test('standalone：import 宿主半边不抛异常，且只依赖 node: 内置模块', async () => {
  const module = await import('../lib/index.js')
  assert.equal(typeof module.apply, 'function', '宿主半边必须导出 apply')
  assert.equal(module.name, 'dsh-git-panel', '宿主半边必须导出包名 name')
})

// ── 2. apply() 在三种惰性服务时机下都不抛异常 ───────────────────────────────

test('standalone：webServer / tools 就绪时，apply 直接注册成功', () => {
  const harness = makeCtx()
  return import('../lib/index.js').then(({ apply }) => {
    assert.doesNotThrow(() => apply(harness.ctx, {}))
    assert.equal(harness.routes.length, 6, '应注册 6 条路由（state/op/net/diag/log/help）')
    assert.equal(harness.tools.length, 13, '应注册 13 个 git 工具')
    const paths = harness.routes.map((route) => route.path).sort()
    assert.deepEqual(paths, ['/git-panel/diag', '/git-panel/help', '/git-panel/log', '/git-panel/net', '/git-panel/op', '/git-panel/state'])
    for (const route of harness.routes) {
      assert.equal(route.kind, 'exact', `路由 ${route.path} 必须是 exact`)
      assert.equal(typeof route.handler, 'function', `路由 ${route.path} 必须有 handler`)
    }
  })
})

test('standalone：webServer / tools 稍后就绪时，apply 不抛异常且不丢注册', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx({ deferServices: true })
  assert.doesNotThrow(() => apply(harness.ctx, {}))
  assert.equal(harness.routes.length, 0, '服务未就绪时不应有路由')
  assert.equal(harness.tools.length, 0, '服务未就绪时不应有工具')
  harness.flushInject()
  assert.equal(harness.routes.length, 6, '服务就绪后应补上 6 条路由')
  assert.equal(harness.tools.length, 13, '服务就绪后应补上 13 个工具')
})

test('standalone：webServer / tools 都不存在时，apply 也不抛异常（面板/工具降级）', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx({ withWebServer: false, withTools: false })
  assert.doesNotThrow(() => apply(harness.ctx, {}))
  assert.equal(harness.routes.length, 0)
  assert.equal(harness.tools.length, 0)
})

test('standalone：ctx 连 get / inject / effect 都没有时（老/裁剪版本）也不抛异常', async () => {
  const { apply } = await import('../lib/index.js')
  assert.doesNotThrow(() => apply({}, {}))
  assert.doesNotThrow(() => apply({ get: () => undefined }, undefined))
})

test('standalone：卸载会清空路由与工具（可重复 apply / dispose）', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx()
  apply(harness.ctx, {})
  assert.equal(harness.routes.length, 6)
  assert.equal(harness.tools.length, 13)
  harness.dispose()
  assert.equal(harness.routes.length, 0, '卸载后路由应被注销')
  assert.equal(harness.tools.length, 0, '卸载后工具应被注销')
})

// ── 3. 13 个工具的 schema 都必须落在 harness 支持的子集内 ────────────────────

test('standalone：13 个工具名唯一、schema 合法、必填项都声明了', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx()
  apply(harness.ctx, {})
  const names = harness.tools.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length, '工具名不能重复')
  for (const tool of harness.tools) {
    assert.equal(tool.parameters.type, 'object', `工具 ${tool.name} 的 parameters 必须是 object 根`)
    assert.ok(tool.parameters.properties !== undefined, `工具 ${tool.name} 必须有 properties`)
    // 公共参数（workdir / timeoutMs）每个工具都要有。
    assert.ok(Object.hasOwn(tool.parameters.properties, 'workdir'), `工具 ${tool.name} 缺少公共参数 workdir`)
    assert.ok(Object.hasOwn(tool.parameters.properties, 'timeoutMs'), `工具 ${tool.name} 缺少公共参数 timeoutMs`)
    // required 若声明，必须指向真实存在的属性，否则模型侧永远校验失败。
    for (const required of tool.parameters.required ?? []) {
      assert.ok(Object.hasOwn(tool.parameters.properties, required), `工具 ${tool.name} 的 required "${required}" 不在 properties 里`)
    }
    // output 声明必须与 harness 契约一致：schema + render。
    assert.equal(typeof tool.output.render, 'function', `工具 ${tool.name} 的 output.render 必须是函数`)
    assert.doesNotThrow(() => schemaViolations(tool.output.schema), `工具 ${tool.name} 的 output.schema 非法`)
    // render 必须对普通字符串值返回非空 content 数组（面板/模型都靠它显示结果）。
    const rendered = tool.output.render({}, 'hello')
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `工具 ${tool.name} 的 render 必须返回非空数组`)
    assert.equal(rendered[0].type, 'text')
  }
})

test('standalone：工具 execute 对缺参/非法参**抛错**（让 harness 标成失败调用）', async () => {
  const { apply } = await import('../lib/index.js')
  const harness = makeCtx()
  apply(harness.ctx, {})
  const byName = new Map(harness.tools.map((tool) => [tool.name, tool]))
  const exec = { signal: undefined, agent: undefined }
  // 契约变更（原来返回一段普通文本）：execute 抛出的异常会被 harness 记成**失败的调用**，
  // 而返回文本会被模型读成「命令跑完了」——参数写错就变成静默的假成功。
  // 消息里必须带工具名，否则模型不知道该重试哪个工具。
  await assert.rejects(() => byName.get('git_add').execute({}, exec), /git_add/)
  await assert.rejects(() => byName.get('git_run').execute({ subcommand: 'Bad Name' }, exec), /git_run/)
  await assert.rejects(() => byName.get('git_commit').execute({ message: '   ' }, exec), /git_commit/)
  await assert.rejects(() => byName.get('git_clone').execute({}, exec), /git_clone/)
})

// ── 4. 操作注册表：面板与模型工具必须共用同一份 argv 定义 ────────────────────
//
// 现场：面板切分支用 git switch（checkout 在「名字既像分支又像路径」时会误判成
// 还原文件，注释里写了原因），而工具 git_checkout 一直在用 git checkout -b。
// 同一个插件里点按钮和让 AI 做，行为不一样 —— 现在两条路径都指向 ops.js 的构造器。

test('standalone：面板与工具对切换/新建分支生成同一份 argv', async () => {
  const { buildOpArgv, TOOL_SPECS } = await import('../lib/index.js')
  const toolArgvFor = (name, args) => TOOL_SPECS.find((item) => item.name === name).toArgv(args, { dir: '.' })
  assert.deepEqual(await toolArgvFor('git_checkout', { branch: 'main' }), ['switch', 'main'])
  assert.deepEqual(await toolArgvFor('git_checkout', { branch: 'dev', create: true }), ['switch', '-c', 'dev'])
  assert.deepEqual(await buildOpArgv('checkout', { branch: 'main' }), ['switch', 'main'])
  assert.deepEqual(await buildOpArgv('createBranch', { branch: 'dev' }), ['switch', '-c', 'dev'])
  // 删除分支：面板只做安全删除（-d），工具的 force 走 -D —— 同一份构造器。
  assert.deepEqual(await toolArgvFor('git_branch', { name: 'x', delete: true }), ['branch', '-d', 'x'])
  assert.deepEqual(await buildOpArgv('deleteBranch', { branch: 'x' }), ['branch', '-d', 'x'])
})

test('standalone：OPS 的 network 标记与 net.js 的 NETWORK_OPS 完全一致', async () => {
  const { OPS, NETWORK_OPS } = await import('../lib/index.js')
  // 两个集合按不同的键索引（面板操作名 vs git 子命令），必须由断言钉住，否则
  // 「加了新操作却忘了让加速生效」会变成静默的直连。
  for (const [op, spec] of Object.entries(OPS)) {
    assert.equal(spec.network === true, NETWORK_OPS.has(op), `OPS.${op} 与 NETWORK_OPS 不一致`)
  }
  for (const op of NETWORK_OPS) {
    assert.ok(OPS[op] !== undefined, `NETWORK_OPS 里的 ${op} 必须在 OPS 注册表里`)
  }
})

test('standalone：setRemote 的查重与执行用同一个目录（回归：曾用原始 body.dir 查重）', async (context) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const repo = await mkdtemp(join(tmpdir(), 'git-panel-setremote-'))
  try {
    await run('git', ['init'], { cwd: repo })
  } catch {
    await rm(repo, { recursive: true, force: true })
    context.skip('本机没有可用的 git')
    return
  }
  try {
    await run('git', ['remote', 'add', 'origin', 'https://old/x.git'], { cwd: repo })
    const { buildOpArgv } = await import('../lib/index.js')
    // 请求体里的 dir 是个不存在的地方（模拟 `~/…` 展开前的形态）；真正的目录由路由
    // 归一化后传进来。若查重跑在 body.dir 上，git remote 会失败 → 误判成「远程不存在」
    // → 返回 remote add → 真执行时报 fatal: remote origin already exists。
    const argv = await buildOpArgv(
      'setRemote',
      { url: 'https://new/x.git', dir: '~/definitely-not-a-repo-xyz' },
      repo,
    )
    assert.deepEqual(argv, ['remote', 'set-url', 'origin', 'https://new/x.git'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ── 5. 「不是工作区」的诊断文案：四种情况不能互相冒充 ────────────────────────
//
// 现场（在真实运行中的 dsh 上冒烟时发现）：
//   * 面板里敲错一个目录 → 提示「未检测到 git：请先安装 git」。Node 对「git 不存在」
//     和「cwd 不存在」给的错误对象一模一样（code=ENOENT、path='git'），
//     gitMissingMessage 一律当成前者 → 用户被指去装一个已经装好的 git。
//   * 真实存在的普通目录 → 面板显示 git 的英文原文
//     `fatal: not a git repository (or any of the parent directories): .git`，
//     而客户端 EmptyState 拿 '当前目录还不是 Git 仓库' 去重 → 去重分支永远是死的，
//     用户中英各看一句。

test('standalone：目录不存在 / 不是目录 / 不是仓库 / 裸仓库，四种诊断互不冒充', async () => {
  const { readState, NOT_REPO_NOTICE, BARE_REPO_NOTICE } = await import('../lib/index.js')

  // 1. 目录不存在 —— 绝不能再报「未检测到 git」（用户已经装好了 git）。
  const missing = join(tmpdir(), 'git-panel-definitely-missing-' + Date.now())
  const missingNotice = (await readState(missing)).notice
  assert.ok(missingNotice.includes('目录不存在或无法进入'), `应报路径问题，实际：${missingNotice}`)
  assert.ok(!missingNotice.includes('未检测到 git'), `不该把路径写错说成没装 git，实际：${missingNotice}`)

  // 2. 目录存在但不是目录（把文件当目录传进来）。
  const plain = await mkdtemp(join(tmpdir(), 'git-panel-plain-'))
  try {
    const file = join(plain, 'a-file.txt')
    await writeFile(file, 'x')
    const fileNotice = (await readState(file)).notice
    assert.ok(fileNotice.includes('不是一个目录'), `应报「不是目录」，实际：${fileNotice}`)

    // 3. 目录在、但不在任何工作区里 → 必须是客户端去重用的那个字符串。
    const notice = (await readState(plain)).notice
    assert.equal(notice, NOT_REPO_NOTICE, `非仓库的 notice 必须是 ${NOT_REPO_NOTICE}，实际：${notice}`)

    // 跨半边耦合：客户端 EmptyState 靠这个字面量去重，改一边不改另一边就会漏出重复文案。
    const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    assert.ok(
      clientSource.includes("'" + NOT_REPO_NOTICE + "'"),
      `client.js 必须原样比较 '${NOT_REPO_NOTICE}'（否则去重分支是死代码）`,
    )
  } finally {
    await rm(plain, { recursive: true, force: true })
  }

  // 4. 裸仓库：rev-parse **成功**却回答 false，此前与「完全没有仓库」共用一句话。
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const bare = await mkdtemp(join(tmpdir(), 'git-panel-bare-'))
  try {
    await run('git', ['init', '--bare'], { cwd: bare })
  } catch {
    await rm(bare, { recursive: true, force: true })
    return
  }
  try {
    assert.equal((await readState(bare)).notice, BARE_REPO_NOTICE)
    // .git 内部同理（--is-inside-work-tree 也回答 false）。
    assert.equal((await readState(join(bare, 'objects'))).notice, BARE_REPO_NOTICE)
  } finally {
    await rm(bare, { recursive: true, force: true })
  }
})
