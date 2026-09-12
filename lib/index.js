// dsh-git-panel —— Host half（宿主 / Node 侧）
// ============================================================================
// 职责：
//   1. 注册同源 HTTP 路由 /git-panel/state 与 /git-panel/op，供浏览器面板读写 git。
//   2. 把一组 git 命令注册成模型工具（git_status / git_add / git_commit / …），
//      让会话里的 AI 也能直接执行 git 操作。
//
// 设计要点：
//   * 零外部依赖：只用 Node 内置模块，因此 link 安装到任何 profile 都能解析。
//   * 用 child_process.execFile + 参数数组执行 git，**不经过 shell**：
//     路径/提交信息里的引号、空格、分号都不构成注入面。
//   * 非零退出不抛异常，归一化成 { code, stdout, stderr }，面板与模型都能读到原因。
//
// 通信：客户端半边（lib/client.js）经同源 HTTP /git-panel/* 与本模块通信。
// ============================================================================

import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 插件名（cordis patch 通过包名挂载，这里同时导出以便调试识别）。 */
export const name = 'dsh-git-panel'

/** 客户端诊断上报的落盘位置（排查界面注册问题用，可安全删除）。 */
const DIAG_LOG = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'git-panel-diag.log')

/** git 输出缓冲上限（8 MiB）与默认超时。 */
const MAX_BUFFER = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120000

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 把任意异常压成一行可读文本。 */
function message(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** 归一化一个可选的目录参数：空白串按“未提供”处理。 */
function normalizeDir(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
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

/** 以 JSON 回复（面板一律用 JSON，便于前端统一处理）。 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
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

// ── git 执行 ──────────────────────────────────────────────────────────────

/**
 * 以参数数组方式执行 git。
 * 非零退出与 spawn 失败都被归一化成结果对象，调用方按 code 判断。
 * @param argv - git 子命令与参数（不含开头的 "git"）。
 * @param cwd - 执行目录（git 的 -C 语义由 cwd 提供）。
 * @param options.timeoutMs - 超时毫秒数。
 * @param options.signal - 可选取消信号。
 * @returns { code, stdout, stderr }；code 为 -1 表示进程未能启动。
 */
async function runGit(argv, cwd, options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS
  try {
    const result = await execFileAsync('git', argv, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  } catch (error) {
    const raw = error ?? {}
    if (typeof raw.code === 'number') {
      return { code: raw.code, stdout: String(raw.stdout ?? ''), stderr: String(raw.stderr ?? '') }
    }
    return { code: -1, stdout: '', stderr: message(raw) }
  }
}

/**
 * 解析 porcelain 的 `## ` 分支行。
 * 例：`## main...origin/main [ahead 1, behind 2]`、`## HEAD (no branch)`。
 * @returns { branch, upstream, ahead, behind }
 */
function parseBranchLine(line) {
  const rest = line.slice(3)
  let body = rest
  let ahead = 0
  let behind = 0
  const bracket = rest.indexOf(' [')
  if (bracket >= 0) {
    body = rest.slice(0, bracket)
    const tracking = rest.slice(bracket)
    const count = (word) => {
      const match = new RegExp(word + ' (\\d+)').exec(tracking)
      return match === null ? 0 : Number(match[1]) || 0
    }
    ahead = count('ahead')
    behind = count('behind')
  }
  if (body.indexOf('...') >= 0) {
    const parts = body.split('...')
    return { branch: parts[0], upstream: parts[1] ?? null, ahead, behind }
  }
  // 尚无提交时 porcelain 给 `## No commits yet on main`，分支名在最后；
  // 游离 HEAD 给 `## HEAD (no branch)`，分支名在最前。
  const words = body.split(' ')
  if (words[0] === 'No') return { branch: words[words.length - 1] ?? null, upstream: null, ahead, behind }
  return { branch: words[0] ?? null, upstream: null, ahead, behind }
}

/** 解析 `git remote -v` 的输出，返回 [{ name, url }]（只取 fetch 行，按名称排序）。 */
function parseRemotes(stdout) {
  const order = []
  const seen = new Set()
  for (const line of String(stdout).split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const columns = text.split(/\s+/)
    if (columns.length < 3) continue
    if (columns[2] !== '(fetch)') continue
    if (seen.has(columns[0])) continue
    seen.add(columns[0])
    order.push({ name: columns[0], url: columns[1] })
  }
  return order.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * 探测一次 push 为什么失败：没有远程、没有上游、远程不存在、认证被拒、非快进。
 * 面板与模型工具都用它把 git 的原始 stderr 翻译成下一步该做什么。
 * @returns 归一化原因；`none` 表示不是已知的推送类故障。
 */
function classifyPushFailure(stderr) {
  const text = String(stderr ?? '')
  if (/has no upstream branch|没有上游分支/i.test(text)) return 'no-upstream'
  if (/does not appear to be a git repository|无法读取远程仓库|Repository not found/i.test(text)) return 'remote-not-found'
  if (/Permission denied \(publickey\)|Could not read from remote repository/i.test(text)) return 'auth-failed'
  if (/failed to push some refs|non-fast-forward|\[rejected\]|fetch first/i.test(text)) return 'rejected'
  if (/no configured push destination|没有配置推送目标/i.test(text)) return 'no-remote'
  return 'none'
}

/** 把探测到的失败原因翻译成可操作的中文提示。 */
function pushHint(reason) {
  if (reason === 'no-remote') {
    return '这个仓库还没有配置远程地址：填入仓库地址后点「保存并推送」即可。'
  }
  if (reason === 'no-upstream') {
    return '当前分支还没有上游分支：点一次「推送」即可自动建立跟踪（git push -u）。'
  }
  if (reason === 'remote-not-found') {
    return '远程仓库不存在或没有访问权限：检查仓库地址是否写对，以及是否已在 GitHub 上创建该仓库。'
  }
  if (reason === 'auth-failed') {
    return 'SSH 认证失败：确认这台机器的公钥已加到 GitHub 账号，或把远程地址换成 HTTPS。'
  }
  if (reason === 'rejected') {
    return '推送被拒绝（远程有你本地没有的提交）：先点「拉取」合并，再推送。'
  }
  return null
}

/**
 * 读取一个目录的仓库状态（面板与工具共用）。
 * 永不抛异常：任何失败都折成 notice 字段返回，保证面板总能渲染。
 */
async function readState(dir) {
  const shown = normalizeDir(dir) ?? null
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], dir, { timeoutMs: 20000 })
  const isRepo = probe.code === 0 && probe.stdout.trim() === 'true'
  if (!isRepo) {
    return {
      ok: true,
      dir: shown,
      isRepo: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
      log: [],
      remotes: [],
      notice: probe.stderr.trim().length > 0 ? probe.stderr.trim() : '当前目录还不是 Git 仓库',
    }
  }

  // 注意：`git status` 不接受 --no-color（与 log/branch/diff 不同）；
  // porcelain 格式本身无色，因此这里不能带该选项，否则命令直接报错、改动列表永远为空。
  const [status, log, remotesResult] = await Promise.all([
    runGit(['status', '--porcelain=v1', '-b'], dir, { timeoutMs: 20000 }),
    runGit(['log', '--oneline', '--no-color', '-n', '8'], dir, { timeoutMs: 20000 }),
    runGit(['remote', '-v'], dir, { timeoutMs: 20000 }),
  ])

  let branch = null
  let upstream = null
  let ahead = 0
  let behind = 0
  const changes = []
  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('## ')) {
      const parsed = parseBranchLine(line)
      branch = parsed.branch
      upstream = parsed.upstream
      ahead = parsed.ahead
      behind = parsed.behind
      continue
    }
    if (line.length < 4) continue
    // porcelain 的 XY 两列：X = 暂存区、Y = 工作区。'?' 表示未跟踪。
    // staged 让面板能显示「N 处改动（M 已暂存）」，点「全部暂存」后才看得出变化。
    const code = line.slice(0, 2)
    changes.push({ code, path: line.slice(3), staged: code[0] !== ' ' && code[0] !== '?' })
    if (changes.length >= 100) break
  }

  const commits = []
  for (const line of log.stdout.split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const space = text.indexOf(' ')
    if (space < 0) commits.push({ hash: text, subject: '' })
    else commits.push({ hash: text.slice(0, space), subject: text.slice(space + 1) })
    if (commits.length >= 8) break
  }

  return {
    ok: true,
    dir: shown,
    isRepo: true,
    branch,
    upstream,
    ahead,
    behind,
    changes,
    log: commits,
    remotes: parseRemotes(remotesResult.stdout),
    notice: null,
  }
}

/**
 * 把面板发来的操作名翻译成 git 参数数组。
 * 只接受白名单操作，任何用户字符串都作为独立参数传递，不参与命令拼接。
 * @throws 参数不合法时抛出带中文提示的错误（面板直接展示）。
 */
async function buildOpArgv(op, input) {
  if (op === 'init') return ['init']
  if (op === 'addAll') return ['add', '-A']
  if (op === 'commit') {
    const text = typeof input.message === 'string' ? input.message : ''
    if (text.trim().length === 0) throw new Error('请先填写提交信息')
    return ['commit', '-m', text]
  }
  if (op === 'pull') return ['pull']
  if (op === 'push') {
    // mode: auto（默认）先试普通 push，失败再由 recoverPush 补 -u；
    //       upstream 直接带 -u；plain 完全不动上游配置。
    const mode = typeof input.mode === 'string' ? input.mode : 'auto'
    if (mode === 'upstream') return ['push', '--set-upstream', 'origin', 'HEAD']
    return ['push']
  }
  if (op === 'setRemote') {
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    if (url.length === 0) throw new Error('请填写仓库地址')
    const name = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : 'origin'
    // 同名远程已存在就改地址，不存在才新增：一个按钮同时覆盖「首次配置」和「改地址」。
    const listed = await runGit(['remote'], input.dir, { timeoutMs: 20000 })
    const exists = listed.stdout.split('\n').some((line) => line.trim() === name)
    return exists ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url]
  }
  if (op === 'fetch') return ['fetch', '--all', '--prune']
  if (op === 'clone') {
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    if (url.length === 0) throw new Error('请填写仓库地址')
    const argv = ['clone', url]
    const target = typeof input.target === 'string' ? input.target.trim() : ''
    if (target.length > 0) argv.push(target)
    return argv
  }
  throw new Error('未知操作：' + op)
}

/** 面板展示用的命令回显与结果文本。 */
function formatGitResult(argv, result) {
  const lines = ['$ git ' + argv.join(' ')]
  if (result.stdout.length > 0) lines.push(result.stdout.replace(/\s+$/, ''))
  if (result.stderr.length > 0) lines.push('[stderr] ' + result.stderr.replace(/\s+$/, ''))
  if (result.code !== 0) lines.push('[exit code: ' + result.code + ']')
  return lines.join('\n')
}

// ── 推送补救 ──────────────────────────────────────────────────────────────

/**
 * 推送失败后的自动补救。一次「点了推送没反应」是最常见的卡点，所以这里按
 * git 的原始反馈再替用户做一步，而不是把 stderr 原样甩回面板：
 *
 *   - 没有上游分支（最常见：本地新分支第一次推）→ 自动补 `-u origin HEAD` 重推，
 *     等价于 git 自己提示的那条命令。origin 不存在时自动改用唯一的那个远程。
 *   - 没有远程 / 认证失败 / 非快进 → 不做自动动作，只回传 reason 让面板给提示。
 *     这三类要么缺用户输入（地址），要么会改动历史，自动做只会更糟。
 *
 * @returns { argv, result, reason, retried }：面板展示用（retried 表示命令被替换过）。
 */
async function recoverPush(op, body, argv, result, dir, timeoutMs) {
  const reason = result.code === 0 ? 'none' : classifyPushFailure(result.stderr)
  if (op !== 'push' || result.code === 0 || reason !== 'no-upstream') {
    return { argv, result, reason, retried: false }
  }
  const mode = body !== null && typeof body.mode === 'string' ? body.mode : 'auto'
  if (mode === 'plain') return { argv, result, reason, retried: false }

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: 20000 })).stdout)
  if (remotes.length === 0) return { argv, result, reason: 'no-remote', retried: false }

  // 优先 origin；没有 origin（且只有一个远程）就用那一个，避免硬编码失败。
  const chosen = remotes.some((item) => item.name === 'origin') ? 'origin' : remotes[0].name
  const retryArgv = ['push', '--set-upstream', chosen, 'HEAD']
  const retry = await runGit(retryArgv, dir, { timeoutMs })
  if (retry.code === 0) {
    return {
      argv: retryArgv,
      result: {
        code: 0,
        stdout: [result.stdout, retry.stdout].filter((text) => text.length > 0).join('\n'),
        stderr: [result.stderr, retry.stderr].filter((text) => text.length > 0).join('\n'),
      },
      reason: 'none',
      retried: true,
    }
  }
  return { argv: retryArgv, result: retry, reason: classifyPushFailure(retry.stderr), retried: true }
}

// ── HTTP 路由 ─────────────────────────────────────────────────────────────

/**
 * 构造面板使用的两条路由。
 * @param getDefaultDir - 返回缺省执行目录（未传 dir 时使用）。
 */
function createRoutes(getDefaultDir) {
  /** GET /git-panel/state?dir=<绝对路径> —— 读取仓库状态。 */
  const stateRoute = {
    kind: 'exact',
    path: '/git-panel/state',
    handler: async (request, response) => {
      try {
        const url = new URL(typeof request.url === 'string' ? request.url : '/', 'http://localhost')
        const dir = normalizeDir(url.searchParams.get('dir')) ?? getDefaultDir()
        sendJson(response, 200, await readState(dir))
      } catch (error) {
        sendJson(response, 200, {
          ok: false,
          dir: null,
          isRepo: false,
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          changes: [],
          log: [],
          remotes: [],
          notice: '读取失败：' + message(error),
        })
      }
    },
  }

  /** POST /git-panel/op —— 执行一个白名单 git 操作，并回带最新状态。 */
  const opRoute = {
    kind: 'exact',
    path: '/git-panel/op',
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, message: '拒绝执行：请求来源不可信', state: null })
          return
        }
        const body = await readJsonBody(request)
        const dir = normalizeDir(body.dir) ?? getDefaultDir()
        const op = typeof body.op === 'string' ? body.op : ''

        let argv
        try {
          argv = await buildOpArgv(op, body)
        } catch (error) {
          sendJson(response, 200, { ok: false, message: message(error), hint: null, state: await readState(dir) })
          return
        }

        const slow = op === 'clone' || op === 'pull' || op === 'push' || op === 'fetch'
        const timeoutMs = slow ? 600000 : 120000
        const result = await runGit(argv, dir, { timeoutMs })
        const recovery = await recoverPush(op, body, argv, result, dir, timeoutMs)

        sendJson(response, 200, {
          ok: recovery.result.code === 0,
          command: 'git ' + recovery.argv.join(' '),
          exitCode: recovery.result.code,
          stdout: recovery.result.stdout,
          stderr: recovery.result.stderr,
          message: recovery.result.code === 0
            ? null
            : (recovery.result.stderr.trim() || 'git 退出码 ' + recovery.result.code),
          reason: recovery.reason,
          hint: recovery.result.code === 0 ? null : pushHint(recovery.reason),
          retried: recovery.retried,
          state: await readState(dir),
        })
      } catch (error) {
        sendJson(response, 400, { ok: false, message: message(error), state: null })
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
      try {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false })
          return
        }
        const body = await readJsonBody(request)
        const line = JSON.stringify({
          at: new Date().toISOString(),
          stage: typeof body.stage === 'string' ? body.stage : 'unknown',
          detail: body.detail === undefined || body.detail === null ? null : String(body.detail),
        }) + '\n'
        await appendFile(DIAG_LOG, line, 'utf8')
        sendJson(response, 200, { ok: true })
      } catch (error) {
        sendJson(response, 200, { ok: false, message: message(error) })
      }
    },
  }

  return [stateRoute, opRoute, diagRoute]
}

// ── 模型工具 ──────────────────────────────────────────────────────────────

/** 所有 git 工具的公共参数。 */
const COMMON_PARAMS = {
  workdir: { type: 'string', description: '运行 git 命令的目录；默认是当前会话工作目录，相对路径基于它解析。' },
  timeoutMs: { type: 'number', description: '命令超时毫秒数，默认 120000。' },
}

/**
 * 工具清单：名称、说明、参数 schema，以及“参数 → git argv”的纯函数。
 * argv 直接交给 execFile，因此提交信息、路径里的特殊字符都是安全的数据。
 */
const TOOL_SPECS = [
  {
    name: 'git_status',
    description: '查看 git 仓库当前状态：当前分支、暂存区/工作区的改动、未跟踪文件。porcelain=true 时输出机器可读格式。',
    parameters: {
      porcelain: { type: 'boolean', description: '为 true 时使用 --porcelain=v1 --branch 机器可读输出。' },
    },
    toArgv: (args) => (args.porcelain === true ? ['status', '--porcelain=v1', '--branch'] : ['status']),
  },
  {
    name: 'git_add',
    description: '暂存文件到暂存区（git add）。paths 传入要暂存的文件路径列表，或设置 all=true 暂存所有改动。',
    parameters: {
      paths: { type: 'array', items: { type: 'string' }, description: '要暂存的文件或目录路径列表。' },
      all: { type: 'boolean', description: '为 true 时暂存所有改动（git add -A）。' },
    },
    toArgv: (args) => {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === 'string' && p.length > 0) : []
      if (args.all === true) return paths.length > 0 ? ['add', '-A', ...paths] : ['add', '-A']
      if (paths.length === 0) throw new Error('git_add: 需要提供 paths 或设置 all=true')
      return ['add', '--', ...paths]
    },
  },
  {
    name: 'git_commit',
    description: '创建一次提交（git commit）。message 为提交信息；all=true 先暂存所有改动（-a）；amend=true 修改上一次提交（--amend）。',
    parameters: {
      message: { type: 'string', description: '提交信息（commit message）。' },
      all: { type: 'boolean', description: '为 true 时先用 -a 暂存所有已跟踪文件的改动。' },
      amend: { type: 'boolean', description: '为 true 时用 --amend 修改上一次提交。' },
    },
    toArgv: (args) => {
      const text = typeof args.message === 'string' ? args.message : ''
      if (text.trim().length === 0) throw new Error('git_commit: message 不能为空')
      const argv = ['commit']
      if (args.all === true) argv.push('-a')
      if (args.amend === true) argv.push('--amend')
      argv.push('-m', text)
      return argv
    },
  },
  {
    name: 'git_log',
    description: '查看提交历史（git log --oneline）。count 控制条数（默认 10，最大 200）；graph=true 显示分支图；all=true 包含所有分支。',
    parameters: {
      count: { type: 'integer', description: '显示的提交条数，默认 10，最大 200。' },
      graph: { type: 'boolean', description: '为 true 时使用 --graph 显示分支图形。' },
      all: { type: 'boolean', description: '为 true 时显示所有分支（--all）。' },
    },
    toArgv: (args) => {
      const argv = ['log', '--oneline', '--no-color']
      if (args.graph === true) argv.push('--graph')
      if (args.all === true) argv.push('--all')
      let count = typeof args.count === 'number' ? Math.floor(args.count) : 10
      if (!(count >= 1)) count = 10
      if (count > 200) count = 200
      argv.push('-n', String(count))
      return argv
    },
  },
  {
    name: 'git_diff',
    description: '查看工作区改动（git diff）。cached=true 查看已暂存改动；stat=true 只显示统计摘要；path 限定单个文件。',
    parameters: {
      cached: { type: 'boolean', description: '为 true 时查看已暂存的改动。' },
      stat: { type: 'boolean', description: '为 true 时只显示 --stat 统计摘要。' },
      path: { type: 'string', description: '限定查看某个文件或目录的改动。' },
    },
    toArgv: (args) => {
      const argv = ['diff']
      if (args.cached === true) argv.push('--cached')
      if (args.stat === true) argv.push('--stat')
      if (typeof args.path === 'string' && args.path.length > 0) argv.push('--', args.path)
      return argv
    },
  },
  {
    name: 'git_branch',
    description: '分支管理。不传 name 时列出分支（all=true 含远程）；提供 name 创建分支；delete=true 删除分支（force=true 强制删除）。',
    parameters: {
      name: { type: 'string', description: '分支名。' },
      delete: { type: 'boolean', description: '为 true 时删除 name 指定的分支。' },
      force: { type: 'boolean', description: '配合 delete 使用 -D 强制删除。' },
      all: { type: 'boolean', description: '列出时包含远程分支（-a）。' },
    },
    toArgv: (args) => {
      const branch = typeof args.name === 'string' ? args.name : ''
      if (branch.length > 0) {
        if (args.delete === true) return ['branch', args.force === true ? '-D' : '-d', branch]
        return ['branch', branch]
      }
      if (args.delete === true) throw new Error('git_branch: 删除分支需要提供 name')
      return args.all === true ? ['branch', '-a', '--no-color'] : ['branch', '--no-color']
    },
  },
  {
    name: 'git_checkout',
    description: '切换分支（git checkout）。branch 为目标分支；create=true 时创建并切换（-b）。',
    parameters: {
      branch: { type: 'string', description: '要切换（或创建）的分支名。' },
      create: { type: 'boolean', description: '为 true 时用 -b 创建并切换。' },
    },
    toArgv: (args) => {
      const branch = typeof args.branch === 'string' ? args.branch : ''
      if (branch.length === 0) throw new Error('git_checkout: 需要提供 branch')
      return args.create === true ? ['checkout', '-b', branch] : ['checkout', branch]
    },
  },
  {
    name: 'git_pull',
    description: '拉取远程更新（git pull）。可选 remote 与 branch；rebase=true 使用 --rebase。',
    parameters: {
      remote: { type: 'string', description: '远程名，默认使用上游配置。' },
      branch: { type: 'string', description: '要拉取的分支名。' },
      rebase: { type: 'boolean', description: '为 true 时使用 --rebase。' },
    },
    toArgv: (args) => {
      const argv = ['pull']
      if (args.rebase === true) argv.push('--rebase')
      if (typeof args.remote === 'string' && args.remote.length > 0) argv.push(args.remote)
      if (typeof args.branch === 'string' && args.branch.length > 0) argv.push(args.branch)
      return argv
    },
  },
  {
    name: 'git_push',
    description: '推送提交到远程（git push）。可选 remote 与 branch；setUpstream=true 设置上游（-u）；force=true 强制推送。',
    parameters: {
      remote: { type: 'string', description: '远程名，默认 origin。' },
      branch: { type: 'string', description: '要推送的分支名。' },
      setUpstream: { type: 'boolean', description: '为 true 时加 -u 设置上游分支。' },
      force: { type: 'boolean', description: '为 true 时加 --force 强制推送。' },
    },
    toArgv: (args) => {
      const argv = ['push']
      if (args.setUpstream === true) argv.push('-u')
      if (args.force === true) argv.push('--force')
      if (typeof args.remote === 'string' && args.remote.length > 0) argv.push(args.remote)
      if (typeof args.branch === 'string' && args.branch.length > 0) argv.push(args.branch)
      return argv
    },
  },
  {
    name: 'git_clone',
    description: '克隆远程仓库（git clone）。url 为仓库地址；dir 指定目标目录；depth 为浅克隆深度。',
    parameters: {
      url: { type: 'string', description: '仓库地址（https/ssh/git 协议均可）。' },
      dir: { type: 'string', description: '克隆到的目标目录，缺省用仓库名。' },
      depth: { type: 'integer', description: '浅克隆深度（--depth N）。' },
    },
    toArgv: (args) => {
      const url = typeof args.url === 'string' ? args.url : ''
      if (url.length === 0) throw new Error('git_clone: 需要提供 url')
      const argv = ['clone']
      if (typeof args.depth === 'number' && args.depth >= 1) argv.push('--depth', String(Math.floor(args.depth)))
      argv.push(url)
      if (typeof args.dir === 'string' && args.dir.length > 0) argv.push(args.dir)
      return argv
    },
  },
  {
    name: 'git_init',
    description: '在当前目录初始化新的 git 仓库（git init）。branch 指定初始分支名。',
    parameters: {
      branch: { type: 'string', description: '初始分支名（git init -b）。' },
    },
    toArgv: (args) => {
      const branch = typeof args.branch === 'string' ? args.branch : ''
      return branch.length > 0 ? ['init', '-b', branch] : ['init']
    },
  },
  {
    name: 'git_remote',
    description: '管理远程仓库。默认列出所有远程（git remote -v）；action=add 需 name 与 url；action=set 配置推送目标（同名远程已存在则改地址，否则新增）；action=remove 删除远程。',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'set', 'remove'], description: '操作类型，默认 list。set 用于「配置推送目标」。' },
      name: { type: 'string', description: '远程名（add/set/remove 时使用，默认 origin）。' },
      url: { type: 'string', description: '远程地址（add/set 时必填）。' },
    },
    toArgv: (args) => {
      const action = args.action === 'add' || args.action === 'set' || args.action === 'remove' ? args.action : 'list'
      const named = typeof args.name === 'string' && args.name.length > 0
      const remote = named ? args.name : 'origin'
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (action === 'add') {
        if (!named || url.length === 0) throw new Error('git_remote: add 需要提供 name 和 url')
        return ['remote', 'add', remote, url]
      }
      if (action === 'set') {
        // 「配置推送目标」的语义：远程不存在时用 add 建出来（名字默认 origin）。
        if (url.length === 0) throw new Error('git_remote: set 需要提供 url')
        return ['remote', 'add', remote, url]
      }
      if (action === 'remove') {
        if (!named) throw new Error('git_remote: remove 需要提供 name')
        return ['remote', 'remove', remote]
      }
      return ['remote', '-v']
    },
  },
  {
    name: 'git_run',
    description: '执行任意其他 git 子命令（如 git stash、git tag）。subcommand 为子命令名，args 为原样参数列表。',
    parameters: {
      subcommand: { type: 'string', description: 'git 子命令名，例如 stash、tag、show、reset。' },
      args: { type: 'array', items: { type: 'string' }, description: '传给子命令的参数列表（每个参数原样传递）。' },
    },
    toArgv: (args) => {
      const sub = typeof args.subcommand === 'string' ? args.subcommand : ''
      if (!/^[a-z][a-z0-9-]*$/.test(sub)) throw new Error('git_run: subcommand 必须是小写字母开头的合法子命令名')
      const rest = Array.isArray(args.args) ? args.args.filter((item) => typeof item === 'string') : []
      return [sub, ...rest]
    },
  },
]

/** 为工具解析执行目录：显式 workdir → 会话工作目录 → 插件默认目录。 */
function resolveToolDir(args, exec, getDefaultDir) {
  const explicit = normalizeDir(args.workdir)
  if (explicit !== undefined) return explicit
  const session = exec !== undefined && exec !== null && exec.agent !== undefined && exec.agent !== null
    ? exec.agent.session
    : undefined
  const cwd = session !== undefined && session !== null && session.header !== undefined && session.header !== null
    ? session.header.cwd
    : undefined
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return getDefaultDir()
}

/**
 * 注册全部 git 模型工具。任何单个工具失败都只记日志，不影响面板与其它工具。
 * @param tools - ctx.tools 工具注册表。
 * @param getDefaultDir - 缺省执行目录。
 * @returns 注销函数数组。
 */
function registerTools(tools, getDefaultDir) {
  const disposers = []
  for (const spec of TOOL_SPECS) {
    try {
      const parameters = { type: 'object', properties: { ...spec.parameters, ...COMMON_PARAMS } }
      disposers.push(tools.register({
        name: spec.name,
        description: spec.description,
        parameters,
        output: {
          schema: { type: 'string' },
          render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
        },
        timeoutMs: 600000,
        execute: async (args, exec) => {
          const input = args !== null && typeof args === 'object' ? args : {}
          const dir = resolveToolDir(input, exec, getDefaultDir)
          let argv
          try {
            argv = spec.toArgv(input)
          } catch (error) {
            return message(error)
          }
          const signal = exec !== undefined && exec !== null ? exec.signal : undefined
          const result = await runGit(argv, dir, {
            timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
            signal,
          })
          return formatGitResult(argv, result)
        },
      }))
    } catch (error) {
      console.error('[git-panel] 注册工具 ' + spec.name + ' 失败：' + message(error))
    }
  }
  return disposers
}

// ── cordis apply ──────────────────────────────────────────────────────────

/**
 * 插件入口：挂载面板 HTTP 路由并注册 git 模型工具。
 * @param ctx - cordis 上下文。
 * @param config - 行配置（defaultDir：面板缺省执行目录）。
 */
export function apply(ctx, config = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const configured = normalizeDir(cfg.defaultDir)
  const getDefaultDir = () => configured ?? process.cwd()

  const disposers = []

  /** webServer 是惰性服务：拿到实例后挂两条路由。 */
  const mount = (server) => {
    if (server === undefined || server === null) return
    for (const route of createRoutes(getDefaultDir)) {
      try {
        disposers.push(server.register(route))
      } catch (error) {
        console.error('[git-panel] 注册路由 ' + route.path + ' 失败：' + message(error))
      }
    }
  }

  const existing = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (existing !== undefined) {
    mount(existing)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (hostCtx) => {
      const resolved = hostCtx !== undefined && hostCtx !== null && hostCtx.webServer !== undefined
        ? hostCtx.webServer
        : (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
      mount(resolved)
    })
  }

  /**
   * 注册全部 git 模型工具。
   * 注意：`tools` 与 `webServer` 一样是**惰性服务** —— 插件 apply 时它可能还没就绪，
   * 只读 `ctx.get('tools')` 会让工具静默缺失（实测就是如此）。所以这里同样先看
   * 现有实例，取不到就 `ctx.inject(['tools'], …)` 等它就绪，两种时机都覆盖。
   */
  const mountTools = (registry) => {
    if (registry === undefined || registry === null) return
    for (const dispose of registerTools(registry, getDefaultDir)) disposers.push(dispose)
  }

  const existingTools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (existingTools !== undefined) {
    mountTools(existingTools)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (hostCtx) => {
      const resolved = hostCtx !== undefined && hostCtx !== null && hostCtx.tools !== undefined
        ? hostCtx.tools
        : (typeof ctx.get === 'function' ? ctx.get('tools') : undefined)
      mountTools(resolved)
    })
  } else {
    console.error('[git-panel] 未找到 tools 服务：git 模型工具未注册（面板不受影响）')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 卸载期忽略 */
        }
      }
    })
  }

  console.log('[git-panel] 就绪：面板路由 /git-panel/* + ' + TOOL_SPECS.length + ' 个 git 工具')
}
