// dsh-git-panel —— HTTP 路由（面板与宿主之间的唯一通道）
// ============================================================================
// 六条路由：state（读状态）/ op（执行操作）/ net（网络加速配置）/ diag（客户端
// 注册诊断）/ log（日志尾读）/ help（帮助文档）。
//
// op 路由刻意写成一条**流水线**而不是一个两百行的函数：
//   解析请求 → 查注册表拿 argv → 带加速执行（含镜像回退）→ 补救 → 收集结果
//   → 组装提示与选择 → 回状态 → 记日志
// 每一步都是一个命名函数，出问题时能一眼看出是哪一段。
// ============================================================================

import { join } from 'node:path'

import {
  classifyNetworkFailure, classifyPushFailure, mirrorFallbackWorthwhile, networkHint, pushHint,
} from './failure.js'
import {
  GIT_LOCAL_TIMEOUT_MS, cloneTargetName, emptyState, gitMissingMessage, readState, runGit,
} from './git.js'
import { renderHelpHtml } from './help.js'
import { appendLog, readLogTail } from './log.js'
import {
  mirrorLabel, netConfigView, networkExtraArgs, probeNetwork, readNetConfig, writeNetConfig,
} from './net.js'
import {
  OPS, abortMerge, adoptRemote, buildOpArgv, mergeAbortChoice, opResponse, opTimeoutMs,
  unrelatedChoices,
} from './ops.js'
import { MASK_TOKEN, displayArgv, firstLine, hasText, maskProxy, message, normalizeDir } from './util.js'

// ── 请求 / 响应小工具 ─────────────────────────────────────────────────────

/** 请求 URL（所有路由原先各抄一份 new URL(...)，这里收成一个）。 */
function requestUrl(request) {
  return new URL(typeof request.url === 'string' ? request.url : '/', 'http://localhost')
}

/** 以 JSON 回复（面板一律用 JSON，便于前端统一处理）。 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * 统一的失败响应。状态码如实反映错误种类：
 * 内部错误 500 / 参数或请求错误 400 / 跨站 403。客户端只读 body 里的 ok，
 * 但状态码是给日志、代理和排查的人看的，不能全都写成 200。
 */
function fail(response, status, error, extra = {}) {
  sendJson(response, status, { ok: false, message: message(error), state: null, ...extra })
}

/** POST 请求的同源校验：拒绝跨站提交。 */
function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * POST 路由的公共守卫：方法不对 → 405，来源不对 → 403。
 * 返回 true 表示**已经回复过**，调用方直接 return。
 * 三个 POST 路由原先各抄一份，改一处忘一处就是一个安全缺口。
 */
function guardPost(request, response, allow = 'POST') {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow })
    response.end()
    return true
  }
  if (!sameOrigin(request)) {
    sendJson(response, 403, { ok: false, message: '拒绝执行：请求来源不可信', state: null })
    return true
  }
  return false
}

/** 读取 POST 的 JSON 请求体（上限 1 MiB）。 */
async function readJsonBody(request, maxBytes = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  return JSON.parse(text)
}

// ── /git-panel/op 的流水线 ────────────────────────────────────────────────

/**
 * 不属于「一条 git 命令」的面板操作：多步、带前置检查、可能不可逆。
 * 它们在 ops.js 里各自实现（见 adoptRemote / abortMerge 的注释），
 * 这里只登记「怎么调用」。
 */
const SPECIAL_OPS = {
  adoptRemote: (body, dir) => adoptRemote(body, dir),
  abortMerge: (body, dir) => abortMerge(dir),
}

/**
 * 执行一条命令，并把网络加速参数插在 `git` 与子命令之间（只影响这一次调用）。
 *
 * 镜像不是官方线路，随时可能失效。**开了加速反而连不上**是最糟的体验，所以镜像
 * 一旦因为线路问题失败就自动回退直连（代理参数保留 —— 那是用户自己的线路）。
 * 但「命令失败」不等于「镜像的错」：没有上游、无关历史这类**本地**错误同样会让
 * 命令失败，早先一律回退并写下「镜像没走通」，用户于是被引去折腾网络加速 ——
 * 所以先用 mirrorFallbackWorthwhile 把失败类型分清楚。
 *
 * @returns { argv, args, result, accel, notes }；args 是**这次真正用的**加速参数，
 *   补救重试必须带同一套，否则会退化成直连。
 */
async function executeWithAcceleration(op, argv, dir, timeoutMs) {
  const netConfig = await readNetConfig()
  const accel = networkExtraArgs(op, netConfig)
  const notes = []
  if (accel.mode.includes('proxy')) {
    // 措辞要是**事实**而不是结论：这条命令确实会走代理，但它成不成功还不知道。
    notes.push('本次命令走代理 ' + maskProxy(netConfig.proxy) + '（只作用于本次命令）')
  }
  // 克隆大仓库要给足预算；fetch/pull 通常很快，配合 http.lowSpeedTime 把上限压短，
  // 卡住时能尽快回退，而不是干等 10 分钟。
  const mirrorTimeoutMs = op === 'clone' ? timeoutMs : Math.min(timeoutMs, 120000)
  let args = accel.args
  let fullArgv = [...args, ...argv]
  let result = await runGit(fullArgv, dir, { timeoutMs: accel.mirror ? mirrorTimeoutMs : timeoutMs })

  if (accel.mirror === true) {
    if (result.code === 0) {
      notes.push('已通过镜像 ' + mirrorLabel(netConfig.mirror) + ' 加速（只作用于本次命令，不改你的 git 配置）')
    } else if (mirrorFallbackWorthwhile(result.stderr)) {
      args = networkExtraArgs(op, netConfig, { noMirror: true }).args
      fullArgv = [...args, ...argv]
      const retry = await runGit(fullArgv, dir, { timeoutMs })
      // 直连也没成功时要照实说，否则「已改用直连」会让用户以为问题出在镜像上。
      notes.push('镜像 ' + mirrorLabel(netConfig.mirror) + ' 没走通（'
        + (firstLine(result.stderr) || 'git 退出码 ' + result.code)
        + '），已自动改用直连' + (retry.code === 0 ? '' : '，直连也没成功'))
      result = retry
    } else {
      // 与网络无关：既不回退（白跑一次），也不写「镜像没走通」（会把用户引偏）。
      notes.push('这次失败与网络无关，没有按镜像故障回退直连：问题不在加速设置上')
    }
  }
  return { argv: fullArgv, args, result, accel, notes }
}

/**
 * 失败后的自动补救（push 补 -u、pull 改按「远程 + 分支」）。
 * 注册表里没声明 recover 的操作只做失败分类 —— 但分类结果仍要回传，
 * 面板的「推送失败 → 自动展开地址输入框」就靠它。
 */
async function recoverOp(op, spec, attempt, body, dir, timeoutMs) {
  const ctx = {
    op, body, argv: attempt.argv, result: attempt.result, dir, timeoutMs, extraArgs: attempt.args,
  }
  if (spec.recover !== undefined) return spec.recover(ctx)
  return {
    argv: attempt.argv,
    result: attempt.result,
    reason: attempt.result.code === 0 ? 'none' : classifyPushFailure(attempt.result.stderr),
    retried: false,
  }
}

/**
 * 收集「数据型操作」的结果：注册表声明了 field/parse 的操作把 stdout 解析成
 * 结构化字段（面板不读原始 stdout），`also` 再补一份（分支管理器的远端列表）。
 * `also` 上的 enhance 钩子在 parse 之后跑：分支列表的「默认分支兜底」用它补查
 * 远程 HEAD（本地 origin/HEAD 缺失时），失败的兜底绝不能拖垮列表本身。
 */
async function collectOpData(spec, input, dir, result) {
  const fields = {}
  const notes = []
  if (result.code !== 0) return { fields, notes }
  if (spec.field !== undefined && spec.parse !== undefined) {
    fields[spec.field] = spec.parse(result.stdout, input)
  }
  if (spec.also !== undefined) {
    const extra = await runGit(spec.also.argv(input), dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (extra.code === 0) {
      const parsed = spec.also.parse === undefined
        ? extra.stdout
        : spec.also.parse(extra.stdout, input)
      fields[spec.also.field] = spec.also.enhance === undefined
        ? parsed
        : await spec.also.enhance(parsed, dir)
    }
  }
  if (spec.note !== undefined) {
    const text = spec.note(fields, input)
    if (hasText(text)) notes.push(text)
  }
  return { fields, notes }
}

/** 「需要用户做个决定」的按钮组：无关历史二选一，冲突/合并没收尾给一条退路。 */
function opChoices(op, recovery) {
  if (op !== 'pull') return null
  if (recovery.reason === 'unrelated' && hasText(recovery.remote) && hasText(recovery.branch)) {
    return unrelatedChoices(recovery.remote, recovery.branch)
  }
  if (recovery.reason === 'conflict' || recovery.reason === 'merge-unfinished') {
    return mergeAbortChoice()
  }
  return null
}

/** 失败时回给面板的 message：补救过程写的中文结论优先于 git 的英文原文。 */
function opMessage(recovery) {
  if (recovery.result.code === 0) return null
  if (hasText(recovery.message)) return recovery.message
  return gitMissingMessage(recovery.result)
    ?? (recovery.result.stderr.trim() || 'git 退出码 ' + recovery.result.code)
}

/**
 * 「还没执行就失败」的响应（未知操作、参数不合法）。
 *
 * **形状必须与成功分支完全一致**：面板要读 network / notes / accelerated 来判断
 * 「是不是网络问题、要不要展开加速设置」，缺字段它就读到 undefined。
 * 这条约束原先只写在注释里，现在由 network.test.mjs 的一条断言钉住。
 */
function shapedFailure(text) {
  return {
    payload: { ...opResponse(), message: text },
    meta: { argv: null, exit: null, retried: false },
  }
}

/**
 * 执行一个面板操作，返回 { payload, meta }。
 * meta 只用于写日志（真正的 argv / 退出码），不进响应体。
 */
async function runPanelOp(op, body, dir) {
  const special = SPECIAL_OPS[op]
  if (special !== undefined) {
    const payload = await special(body, dir)
    return { payload, meta: { argv: null, exit: payload.exitCode ?? null, retried: payload.retried === true } }
  }

  const spec = OPS[op]
  if (spec === undefined) return shapedFailure('未知操作：' + op)

  let argv
  try {
    argv = await buildOpArgv(op, body, dir)
  } catch (error) {
    return shapedFailure(message(error))
  }

  const timeoutMs = opTimeoutMs(spec)
  const attempt = await executeWithAcceleration(op, argv, dir, timeoutMs)
  const recovery = await recoverOp(op, spec, attempt, body, dir, timeoutMs)

  const notes = [...attempt.notes]
  if (hasText(recovery.note)) notes.push(recovery.note)
  const collected = await collectOpData(spec, body, dir, recovery.result)
  notes.push(...collected.notes)

  // 失败原因分流：网络不通要给出「去开加速」的提示，其余交给各自的提示表。
  // 顺序不能反 —— classifyPushFailure 对网络类报错返回 none，先问它会得到空提示。
  const failure = recovery.result.code === 0 ? null : recovery.result
  const networkFailure = failure === null ? null : classifyNetworkFailure(failure.stderr)
  const hintFor = spec.hint ?? pushHint
  const hint = failure === null
    ? null
    : (networkFailure !== null ? networkHint(attempt.accel.mode !== 'direct') : hintFor(recovery.reason))

  // 克隆成功后告诉面板新仓库落在哪，让面板可以自动切进去（默认目标名与 git 一致）。
  let clonedDir = null
  if (op === 'clone' && recovery.result.code === 0) {
    const target = normalizeDir(body.target)
    clonedDir = target !== undefined ? join(dir, target) : join(dir, cloneTargetName(body.url))
  }

  const payload = {
    ok: recovery.result.code === 0,
    command: 'git ' + displayArgv(recovery.argv).join(' '),
    exitCode: recovery.result.code,
    stdout: recovery.result.stdout,
    stderr: recovery.result.stderr,
    message: opMessage(recovery),
    reason: recovery.reason,
    hint,
    retried: recovery.retried === true,
    // 本次实际用了哪条线路，以及给面板看的说明（走镜像意味着请求经过了第三方，
    // 用户必须能看见这件事，不能在后台默默发生）。
    accelerated: attempt.accel.mode,
    network: networkFailure !== null,
    notes,
    clonedDir,
    choices: opChoices(op, recovery),
    ...collected.fields,
  }
  return {
    payload,
    meta: { argv: recovery.argv, exit: recovery.result.code, retried: recovery.retried === true },
  }
}

/** 面板操作的日志字段（argv 打码后才落盘；每次操作都留痕，含补救动作）。 */
function opLogFields(op, dir, startedAt, payload, meta) {
  return {
    op,
    dir,
    argv: meta.argv === null ? null : displayArgv(meta.argv),
    exit: meta.exit,
    ms: Date.now() - startedAt,
    retried: meta.retried === true,
    accelerated: payload.accelerated,
    network: payload.network === true,
    reason: payload.reason,
    message: payload.ok === true ? null : (firstLine(String(payload.message ?? '')) || null),
  }
}

// ── 路由表 ────────────────────────────────────────────────────────────────

/**
 * 构造面板使用的 HTTP 路由：状态 / 操作 / 网络加速 / 诊断 / 日志 / 帮助文档。
 * @param getDefaultDir - 返回缺省执行目录（未传 dir 时使用）。
 */
function createRoutes(getDefaultDir) {
  /** GET /git-panel/state?dir=<绝对路径> —— 读取仓库状态。 */
  const stateRoute = {
    kind: 'exact',
    path: '/git-panel/state',
    handler: async (request, response) => {
      try {
        const dir = normalizeDir(requestUrl(request).searchParams.get('dir')) ?? getDefaultDir()
        sendJson(response, 200, await readState(dir))
      } catch (error) {
        // 形状必须与 readState 完全一致（见 git.js 的 emptyState）——否则面板读到的
        // 字段会缺一块，只能靠 undefined 兜底。
        sendJson(response, 200, emptyState('读取失败：' + message(error), null, false))
      }
    },
  }

  /** POST /git-panel/op —— 执行一个白名单 git 操作，并回带最新状态。 */
  const opRoute = {
    kind: 'exact',
    path: '/git-panel/op',
    handler: async (request, response) => {
      const startedAt = Date.now()
      if (guardPost(request, response)) return
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        // 请求本身不合法（非法 JSON / 过大）→ 400，与「服务内部出错」区分开。
        await appendLog('warn', 'op', { op: null, error: message(error), ms: Date.now() - startedAt })
        fail(response, 400, error)
        return
      }
      const dir = normalizeDir(body.dir) ?? getDefaultDir()
      const op = typeof body.op === 'string' ? body.op : ''
      try {
        const { payload, meta } = await runPanelOp(op, body, dir)
        // noState：数据型操作（列分支、查 diff）不需要仓库状态，跳过这 4 条 git 进程。
        const state = body.noState === true ? null : await readState(dir)
        sendJson(response, 200, { ...payload, state })
        await appendLog(payload.ok === true ? 'info' : 'warn', 'op', opLogFields(op, dir, startedAt, payload, meta))
      } catch (error) {
        await appendLog('error', 'op', { op, error: message(error), ms: Date.now() - startedAt })
        fail(response, 500, error)
      }
    },
  }

  /**
   * /git-panel/net —— 网络加速配置。
   *   GET             读配置（代理凭据一律打码，不回显明文）
   *   GET  ?probe=1   现场实测每条线路，返回各条通不通、耗时多少
   *   POST            保存配置
   *
   * POST 必须同源校验：这个接口决定 git 命令**怎么执行**（注入代理/镜像），
   * 能被跨站改写就等于把用户的仓库流量导向别处。
   * 三条方法合并在一个 handler 里：路由注册是按 path 索引的，同 path 挂多个会互相覆盖。
   */
  const netRoute = {
    kind: 'exact',
    path: '/git-panel/net',
    handler: async (request, response) => {
      const startedAt = Date.now()
      try {
        const url = requestUrl(request)
        if (request.method === 'GET') {
          const config = await readNetConfig()
          if (url.searchParams.get('probe') === '1') {
            const results = await probeNetwork(config)
            await appendLog('info', 'net', {
              action: 'probe',
              results: results.map((item) => ({ kind: item.kind, ok: item.ok, ms: item.ms })),
              ms: Date.now() - startedAt,
            })
            sendJson(response, 200, { ok: true, results })
            return
          }
          sendJson(response, 200, { ok: true, ...netConfigView(config) })
          return
        }
        if (guardPost(request, response, 'GET, POST')) return
        const saved = await writeNetConfig(netPatch(await readJsonBody(request)))
        // 网络加速配置决定 git 命令**怎么执行**，改动必须留痕（凭据打码，只记有没有）。
        await appendLog('info', 'net', {
          action: 'save',
          mirrorEnabled: saved.mirrorEnabled,
          mirror: saved.mirror,
          hasProxy: saved.proxy.length > 0,
          ms: Date.now() - startedAt,
        })
        sendJson(response, 200, { ok: true, ...netConfigView(saved) })
      } catch (error) {
        fail(response, 500, error)
      }
    },
  }

  /**
   * POST /git-panel/diag —— 客户端把界面注册过程回报到宿主日志。
   * 只写本地文件、不回显敏感信息；用于排查「面板出现但设置开关没出现」这类
   * 客户端注册问题（浏览器控制台对用户不可见时，这是唯一的观测通道）。
   */
  const diagRoute = {
    kind: 'exact',
    path: '/git-panel/diag',
    handler: async (request, response) => {
      if (guardPost(request, response)) return
      try {
        const body = await readJsonBody(request)
        await appendLog('info', 'diag', {
          stage: typeof body.stage === 'string' ? body.stage : 'unknown',
          detail: body.detail === undefined || body.detail === null ? null : String(body.detail),
        })
        sendJson(response, 200, { ok: true })
      } catch (error) {
        fail(response, 400, error)
      }
    },
  }

  /**
   * GET /git-panel/log?lines=N —— 读取日志尾部（最近 N 行原文，上限 2000）。
   * 供维护排查用：面板出问题后在这里核对操作经过；也可以配合工具直接读。
   */
  const logRoute = {
    kind: 'exact',
    path: '/git-panel/log',
    handler: async (request, response) => {
      try {
        const parsed = Number.parseInt(requestUrl(request).searchParams.get('lines') ?? '', 10)
        const lines = await readLogTail(Number.isFinite(parsed) && parsed > 0 ? parsed : 200)
        sendJson(response, 200, { ok: true, lines })
      } catch (error) {
        fail(response, 500, error)
      }
    },
  }

  /**
   * GET /git-panel/help —— 帮助文档（独立 HTML 页面，面板的「?」在新标签页打开）。
   * 纯静态内容：不读仓库、不执行 git，因此不涉及目录参数与权限。
   */
  const helpRoute = {
    kind: 'exact',
    path: '/git-panel/help',
    handler: (request, response) => {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      })
      response.end(renderHelpHtml())
    },
  }

  return [stateRoute, opRoute, netRoute, diagRoute, logRoute, helpRoute]
}

/**
 * 面板回传的配置 → 落盘 patch。
 * 面板拿到的代理地址是**打码后**的（`***@`），原样存回去会把真凭据覆盖掉；
 * 见到打码串一律理解为「不变」。清空代理请传空串。
 */
function netPatch(body) {
  const patch = {}
  if (typeof body.mirrorEnabled === 'boolean') patch.mirrorEnabled = body.mirrorEnabled
  if (typeof body.mirror === 'string') patch.mirror = body.mirror
  if (typeof body.proxy === 'string' && !body.proxy.includes(MASK_TOKEN)) patch.proxy = body.proxy
  return patch
}

export {
  createRoutes, runPanelOp, requestUrl, sendJson, fail, guardPost, sameOrigin,
  readJsonBody, netPatch, opLogFields,
}
