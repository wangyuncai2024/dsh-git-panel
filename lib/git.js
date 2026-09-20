// dsh-git-panel —— git 执行与输出解析
// ============================================================================
// 用 child_process.execFile + 参数数组执行 git，**不经过 shell**：路径/提交信息里
// 的引号、空格、分号都不构成注入面。非零退出不抛异常，归一化成
// { code, stdout, stderr }（code === -1 表示进程没能启动）。
// 解析函数都是纯函数，porcelain / branch / remote / rev-list 的格式集中在这里。
// ============================================================================

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { promisify } from 'node:util'
import { appendLog } from './log.js'
import { displayArgv, firstLine, message, normalizeDir } from './util.js'

/**
 * 把 execFile 变成 promise 形态。
 *
 * 注意：这一行在 0.10 的模块拆分里**曾经漏掉**，而当时能覆盖它的用例（真 git、
 * POSIX 假 git）在受限沙箱里全被跳过 —— 于是 `runGit` 每次都以
 * `code: -1 / stderr: 'execFileAsync is not defined'` 返回，面板和工具全部失灵，
 * 而 143 个用例仍然全绿。放开沙箱、真跑一次 git 立刻暴露。
 * 这也是为什么 README 把「换机器先跑一次 npm test」写成第一道回归。
 */
const execFileAsync = promisify(execFile)

/** git 输出缓冲上限（8 MiB）与默认超时。 */
const MAX_BUFFER = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120000

/** 本地（不联网）git 查询的默认超时：状态、分支、远程列表这类都是毫秒级。 */
const GIT_LOCAL_TIMEOUT_MS = 20000

/** 一次状态读取最多回给面板的改动条数（真实总数另由 changesTotal 回传，不静默截断）。 */
const MAX_STATE_CHANGES = 100

/** git 命令缺失（spawn ENOENT 等）时给可读提示，而不是把英文报错原样甩给用户。 */
function gitMissingMessage(result) {
  if (result === null || result === undefined) return null
  if (result.code !== -1) return null
  if (/ENOENT|not found/i.test(String(result.stderr))) {
    return '未检测到 git：请先安装 git（https://git-scm.com）后重试。'
  }
  return null
}

/**
 * spawn 失败时的 stderr 文案。
 *
 * `spawn git ENOENT` 有两个完全不同的原因，而 Node 给的错误对象**一模一样**
 * （实测：code=ENOENT、errno=-4058、syscall='spawn git'、path='git'）：
 * 一是没有 git 可执行文件，二是 `cwd` 这个目录不存在。
 * 后者若照原样交给 gitMissingMessage，用户在面板里敲错一个路径就会被要求
 * 「请先安装 git」—— 实测就是这个误导。所以这里对 cwd 做一次探测，
 * 而且**只在失败路径上**做（正常调用不付任何代价）。
 */
function spawnFailureText(raw, cwd) {
  const detail = message(raw)
  // cwd 不存在时 execFile 报 ENOENT；cwd 是一个**文件**时系统不同给 errno 也不同
  // （Linux 报 ENOTDIR、部分 macOS 报 EISDIR、个别平台仍报 ENOENT）——三种都要
  // 认出来走进下面的 stat 分流，否则「把 cwd 指向文件」会被翻译成一段看不懂的
  // `spawn git ENOTDIR`（实测 WSL 上就是这个）。
  if (!/ENOENT|ENOTDIR|EISDIR|not found/i.test(detail)) return detail
  if (typeof cwd !== 'string' || cwd.length === 0) return detail
  let stats = null
  try {
    stats = statSync(cwd)
  } catch {
    stats = null
  }
  if (stats === null) return '目录不存在或无法进入：' + cwd
  if (!stats.isDirectory()) return '这不是一个目录：' + cwd
  return detail
}

// ── git 执行 ──────────────────────────────────────────────────────────────

/**
 * `child_process` 是否支持 `signal` 选项（Node 15.4.0 起）。
 * 更老的 Node 会把 signal 当成"未知选项"直接让每次 git 调用失败，
 * 所以这里探测一次：不支持就不传 signal（代价只是取消传播失效，功能仍可用）。
 * 注意：DSH 本身要求 Node ^22.19.0 || >=24，这只是换机器时的额外兜底。
 */
const SUPPORTS_EXEC_SIGNAL = (() => {
  const [major = 0, minor = 0] = String(process.versions?.node ?? '0').split('.').map((part) => Number.parseInt(part, 10))
  return Number.isFinite(major) && (major > 15 || (major === 15 && minor >= 4))
})()

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
  const startedAt = Date.now()
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS
  let result
  try {
    const execResult = await execFileAsync('git', argv, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      ...(SUPPORTS_EXEC_SIGNAL && options.signal !== undefined ? { signal: options.signal } : {}),
    })
    result = { code: 0, stdout: String(execResult.stdout ?? ''), stderr: String(execResult.stderr ?? '') }
  } catch (error) {
    const raw = error ?? {}
    // 超时/被信号杀掉时 execFile 给不出退出码，必须先于下面的 code 判断归一化：
    // 否则「10 分钟没响应」和「git 报错退出」在调用方看来长得一样，网络加速的
    // 自动回退与「检测网络」的耗时提示就无法区分这两种情况。
    if (raw.killed === true || (raw.code === undefined && raw.signal !== undefined && raw.signal !== null)) {
      const detail = firstLine(String(raw.stderr ?? ''))
      result = {
        code: -1,
        stdout: String(raw.stdout ?? ''),
        stderr: '命令超时（' + timeoutMs + 'ms 内无响应）' + (detail.length > 0 ? '：' + detail : ''),
      }
    } else if (typeof raw.code === 'number') {
      result = { code: raw.code, stdout: String(raw.stdout ?? ''), stderr: String(raw.stderr ?? '') }
    } else {
      result = { code: -1, stdout: '', stderr: spawnFailureText(raw, cwd) }
    }
  }
  // 每条 git 命令都留痕（debug 级：面板每次刷新状态就会跑几条，不该占 info 额度）：
  // argv 经 displayArgv 打码，代理凭据不会进日志。
  appendLog('debug', 'git', {
    argv: displayArgv(argv),
    dir: cwd ?? null,
    exit: result.code,
    ms: Date.now() - startedAt,
    timeoutMs,
  })
  return result
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
 * 配置推送目标的决策：同名远程已存在就改地址，不存在才新增。
 * 面板的 setRemote 与 AI 工具 git_remote action=set 共用，保证两条路径行为一致。
 * @param listedStdout - `git remote` 的输出（每行一个远程名）。
 */
function remoteOpFor(name, url, listedStdout) {
  const exists = String(listedStdout ?? '').split('\n').some((line) => line.trim() === name)
  return exists ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url]
}

/**
 * 由仓库地址推导 git clone 的默认目标目录名（与 git 行为一致：取路径最后一段、去掉 .git）。
 * 支持 https://…、git://… 与 scp 风格 git@host:path/to/repo.git。
 */
function cloneTargetName(url) {
  try {
    const text = String(url ?? '')
    let path = text
    try {
      path = new URL(text).pathname
    } catch {
      // scp 语法（git@host:path/to/repo.git）：冒号后到结尾就是路径。
      const at = text.indexOf(':')
      if (at >= 0 && at < text.length - 1) path = text.slice(at + 1)
      else path = text
    }
    const base = decodeURIComponent(path.split(/[\\/]/).filter(Boolean).pop() ?? '')
    const name = base.replace(/\.git$/, '')
    if (name.length > 0) return name
  } catch {
    /* 非 URL 时 git 自行决定目标名，这里退化为占位名 */
  }
  return 'repository'
}

/**
 * 由远程仓库地址推导「在浏览器里打开仓库主页」的 URL（面板「仓库页 ↗」入口）。
 *
 * 支持 https / http / git / ssh 协议与 scp 风格（git@host:path）地址，统一转成
 * https 页面地址并去掉结尾的 .git；query / hash 不保留。推导不出来（本地路径、
 * file://、空串、主机或路径缺失等）返回 null —— 面板据此决定是否显示入口，
 * 宁可少一个按钮，也不能给出一个打不开的链接。
 */
function repoPageUrl(url) {
  const text = String(url ?? '').trim()
  if (text.length === 0) return null
  let host = null
  let path = ''
  if (text.includes('://')) {
    let parsed
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    const scheme = parsed.protocol.replace(/:$/, '')
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'git' && scheme !== 'ssh') return null
    host = parsed.hostname
    path = parsed.pathname
    if (parsed.port !== '') host = host + ':' + parsed.port
  } else {
    // scp 风格 git@host:path/to/repo.git —— 没有协议头，冒号前是 user@host。
    const colon = text.indexOf(':')
    if (colon <= 0) return null
    const authority = text.slice(0, colon)
    const at = authority.lastIndexOf('@')
    const candidateHost = at >= 0 ? authority.slice(at + 1) : authority
    if (candidateHost.length === 0 || candidateHost.includes('/') || candidateHost.includes('\\')) return null
    path = text.slice(colon + 1)
    // Windows 盘符路径（C:\…）冒号后是反斜杠，不是 scp 路径；别当主机解析。
    if (path.startsWith('/') || path.startsWith('\\')) return null
    host = candidateHost
  }
  if (host === null || host.length === 0 || path.length === 0) return null
  // 去掉结尾的 .git（大小写不敏感，可带尾部斜杠）与多余的尾部斜杠。
  let clean = path.replace(/\.git\/?$/i, '').replace(/\/+$/, '')
  if (clean.length === 0) return null
  // scp 风格的路径没有开头的斜杠（git@host:user/repo），拼 https 地址时要补上。
  if (!clean.startsWith('/')) clean = '/' + clean
  return 'https://' + host + clean
}

/**
 * 解析 `git branch --no-color` 的输出（面板的分支管理器用）。
 *  `* main`      —— 当前分支
 *  `  feature/x` —— 其他本地分支
 *  游离 HEAD 的 `(HEAD detached at …)` 伪条目跳过（不能按名字切换，面板另有展示）。
 * @returns { current, items }；current 为 null 表示游离 HEAD 或还没有分支。
 */
function parseBranchOutput(stdout) {
  const items = []
  let current = null
  for (const line of String(stdout).split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const name = text.replace(/^\*\s+/, '').trim()
    if (name.startsWith('(') && name.endsWith(')')) continue
    const isCurrent = line.startsWith('*')
    items.push({ name, current: isCurrent })
    if (isCurrent) current = name
  }
  return { current, items }
}

/**
 * 解析 `git branch --remotes --no-color` 的输出（面板「管理」里的远端分支分组）。
 *
 * 两种行，必须分开处理：
 *   `origin/HEAD -> origin/main` —— 远程的默认分支指针，**不是一个能拉的分支**；
 *   `origin/main`                —— 真正的远端分支。
 *
 * 为什么要列出来：本地 `git init` 出来的分支叫 master、远端默认分支叫 main 时，
 * 面板原先只看本地分支，用户既看不到 origin/main，也没有任何入口去点它 ——
 * 「远端有 main 而我没有」这件事在界面上完全不存在（见 pullRemoteDefaultBranch）。
 *
 * @returns { items: [{ remote, name, ref, head }], defaultRef }；items 按 ref 排序。
 */
function parseRemoteBranchOutput(stdout) {
  const items = []
  let defaultRef = null
  for (const line of String(stdout ?? '').split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const arrow = text.indexOf(' -> ')
    if (arrow >= 0) {
      const alias = text.slice(0, arrow).trim()
      if (alias.endsWith('/HEAD')) {
        const target = text.slice(arrow + 4).trim()
        if (target.length > 0) defaultRef = target
      }
      continue
    }
    const slash = text.indexOf('/')
    if (slash <= 0 || slash >= text.length - 1) continue
    const remote = text.slice(0, slash)
    const name = text.slice(slash + 1)
    if (name === 'HEAD') continue
    items.push({ remote: remote, name: name, ref: remote + '/' + name, head: false })
  }
  for (const item of items) {
    if (item.ref === defaultRef) item.head = true
  }
  items.sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0))
  return { items: items, defaultRef: defaultRef }
}

/**
 * 解析 `git ls-remote --symref <远程> HEAD` 的输出，取「远程自己声明的默认分支」。
 *
 * 期望首行是符号引用行 `ref: refs/heads/master\tHEAD`；服务器不支持 --symref（或
 * 只回 `git ls-remote HEAD` 的裸哈希行 `<sha>\tHEAD`）时解析不出分支名 → null，
 * 调用方照旧显示，绝不因此中断列表。
 * @returns 分支名（如 'master'），解析不出来返回 null。
 */
function parseLsRemoteHead(stdout) {
  const first = String(stdout ?? '').split('\n')[0] ?? ''
  const match = /^ref:\s*refs\/heads\/([^\s]+)\s+HEAD$/.exec(first.trim())
  return match === null ? null : match[1]
}

/**
 * 远端引用能不能安全地当参数交给 git。
 *
 * 面板把远端分支的 ref 原样回传给宿主（compare / adoptRemote），所以这是一道
 * **输入校验**：以 `-` 开头会被 git 当成选项，含 `..` 会把单个引用变成一条区间，
 * 含空白 / `~` / `^` / `:` 的也不是真的分支名。
 */
function isSafeRemoteRef(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0 || text.length > 200) return false
  if (text.startsWith('-')) return false
  if (/[\s~^:?*\\[\]]/.test(text)) return false
  if (text.includes('..') || text.includes('@{')) return false
  if (text.startsWith('/') || text.endsWith('/') || text.endsWith('.lock')) return false
  return true
}

/**
 * 解析 `git rev-list --left-right --count HEAD...<ref>` 的输出。
 *
 * 两列：左边 = 「HEAD 有、ref 没有」= 本地领先；右边 = 「ref 有、HEAD 没有」= 本地落后。
 * 解析不出来时都算 0：面板宁可不说，也不能报一个假数字。
 * @returns { ref, ahead, behind }
 */
function parseCompareOutput(stdout, ref) {
  const columns = String(stdout ?? '').trim().split(/\s+/).filter((part) => part.length > 0)
  const ahead = columns.length > 0 ? Number.parseInt(columns[0], 10) : 0
  const behind = columns.length > 1 ? Number.parseInt(columns[1], 10) : 0
  return {
    ref: typeof ref === 'string' ? ref : '',
    ahead: Number.isFinite(ahead) && ahead > 0 ? ahead : 0,
    behind: Number.isFinite(behind) && behind > 0 ? behind : 0,
  }
}

/**
 * 非仓库（或读取失败）时的状态骨架。
 *
 * **只有这一处**定义「一个状态对象长什么样」：readState 的非仓库分支与
 * 路由的异常分支原先各手写一份 11 个字段的字面量，加一个字段就会漏一处。
 * notice 是给用户看的诊断（未装 git / 读取失败 / 还不是仓库），面板直接渲染它。
 */
function emptyState(notice, dir = null, ok = true) {
  return {
    ok,
    dir,
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    changesTotal: 0,
    log: [],
    remotes: [],
    pageUrl: null,
    notice,
  }
}

/**
 * 「这个目录不是工作区」时给用户看的那句话。
 *
 * **客户端会拿 NOT_REPO_NOTICE 去重**（见 client.js 的 EmptyState：它自己已经写了
 * 「还不是 Git 仓库」，不该再叠一遍同样的字），所以宿主必须发**同一个字符串**。
 * 这条耦合原先断了：宿主把 git 的英文原文
 * `fatal: not a git repository (or any of the parent directories): .git` 原样发出去，
 * 客户端的 `notice !== '当前目录还不是 Git 仓库'` 因此永远为真 —— 去重分支是死代码，
 * 用户看到的是中英各一句。现在由 test/standalone.test.mjs 钉住两边一致。
 *
 * 四种情况必须分开，否则用户会被指去修错的东西：
 *   1. git 没装 → 安装提示；
 *   2. 目录不存在 / 不是目录 → 路径问题（见 spawnFailureText）；
 *   3. 目录在但不在任何工作区里 → NOT_REPO_NOTICE；
 *   4. 裸仓库或位于 .git 内部 → rev-parse **成功**却回答 false，
 *      此前与「完全没有仓库」共用一句话（说裸仓库「还不是 Git 仓库」并不准确）。
 */
const NOT_REPO_NOTICE = '当前目录还不是 Git 仓库'
const BARE_REPO_NOTICE = '这里没有工作区（裸仓库或 .git 内部）：请选择工作区目录'
// git 的「不是仓库」报错文案随系统语言走：英文 `not a git repository` / 中文
// `不是 Git 仓库`（实测中文 locale 下 rev-parse 就是这么报的）。只认英文的话，
// 中文环境会漏掉去重分支，用户看到中英各一句（standalone 测试钉住这个契约）。
const NOT_REPO_PATTERN = /not a git repository|not a git repo|not a working (tree|copy)|不是.{0,8}git.{0,2}仓库/i

function notRepoNotice(probe) {
  const missing = gitMissingMessage(probe)
  if (missing !== null) return missing
  // rev-parse 成功但明确回答「不是工作区」= 裸仓库 / .git 内部。
  if (probe.code === 0 && String(probe.stdout).trim() === 'false') return BARE_REPO_NOTICE
  const detail = firstLine(String(probe.stderr ?? ''))
  if (NOT_REPO_PATTERN.test(detail)) return NOT_REPO_NOTICE
  return detail.length > 0 ? detail : NOT_REPO_NOTICE
}

/**
 * 读取一个目录的仓库状态（面板与工具共用）。
 * 永不抛异常：任何失败都折成 notice 字段返回，保证面板总能渲染。
 */
async function readState(dir) {
  const startedAt = Date.now()
  const shown = normalizeDir(dir) ?? null
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  const isRepo = probe.code === 0 && probe.stdout.trim() === 'true'
  if (!isRepo) {
    const state = emptyState(notRepoNotice(probe), shown)
    appendLog('debug', 'state', { dir: shown, isRepo: false, ms: Date.now() - startedAt })
    return state
  }

  // 注意：`git status` 不接受 --no-color（与 log/branch/diff 不同）；
  // porcelain 格式本身无色，因此这里不能带该选项，否则命令直接报错、改动列表永远为空。
  const [status, log, remotesResult] = await Promise.all([
    runGit(['status', '--porcelain=v1', '-b'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(['log', '--oneline', '--no-color', '-n', '8'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
  ])

  let branch = null
  let upstream = null
  let ahead = 0
  let behind = 0
  const changes = []
  // changesTotal 是**真实条数**，changes 最多回 MAX_STATE_CHANGES 条：
  // 面板据此显示「还有 N 处未显示」，截断因此不再静默。
  let changesTotal = 0
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
    changesTotal += 1
    if (changes.length >= MAX_STATE_CHANGES) continue
    // porcelain 的 XY 两列：X = 暂存区、Y = 工作区。'?' 表示未跟踪。
    // staged 让面板能显示「N 处改动（M 已暂存）」，点「全部暂存」后才看得出变化。
    const code = line.slice(0, 2)
    changes.push({ code, path: line.slice(3), staged: code[0] !== ' ' && code[0] !== '?' })
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

  const remotes = parseRemotes(remotesResult.stdout)
  const state = {
    ok: true,
    dir: shown,
    isRepo: true,
    branch,
    upstream,
    ahead,
    behind,
    changes,
    changesTotal,
    log: commits,
    remotes,
    // 仓库主页入口：用「远程行展示的那一条地址」（按名称排序后的第一个）推导，
    // 面板上的「仓库页 ↗」按钮与这一行显示的是同一个远程，不会对不上号。
    pageUrl: remotes.length > 0 ? repoPageUrl(remotes[0].url) : null,
    notice: null,
  }
  appendLog('debug', 'state', {
    dir: shown,
    isRepo: true,
    branch,
    changes: changes.length,
    changesTotal,
    ms: Date.now() - startedAt,
  })
  return state
}

/**
 * 当前分支名（不知道就返回空串）。
 *
 * 为什么要这么绕：**刚 `git init`、还没有任何提交**的仓库（正是"新建仓库 → 填地址 →
 * 拉取"这条最普通的路）里，`rev-parse --abbrev-ref HEAD` 会直接失败
 * （`fatal: ambiguous argument 'HEAD'`），于是它会被误判成「游离 HEAD」，
 * 该自动做的补救全被跳过。这两个命令在"分支还没出生"时同样能给出名字：
 *   - `git branch --show-current`（git 2.22+）：直接读 HEAD 指向的名字；
 *   - `git symbolic-ref --short HEAD`：更老也有的等价写法。
 * 真正游离 HEAD 时两个都拿不到名字（前者输出空、后者报错），返回空串由调用方处理。
 */
async function currentBranchName(dir, timeoutMs) {
  const attempts = [['branch', '--show-current'], ['symbolic-ref', '--short', 'HEAD']]
  for (const argv of attempts) {
    const result = await runGit(argv, dir, { timeoutMs: timeoutMs })
    if (result.code !== 0) continue
    const name = result.stdout.trim()
    if (name.length > 0 && name !== 'HEAD') return name
  }
  return ''
}

/**
 * 解析 `git stash list` 的输出（面板「stash 备份」用）。
 *
 * 行形如 `stash@{0}: WIP on main: 1234abc 提交说明` —— ref 是可执行操作的编号，
 * 冒号后的整段是给人看的内容。解析不出来的一律跳过：宁可少列一条，
 * 也不能把 `stash@{x}` 编号拼错（拼错就操作到错误的备份上了）。
 * @returns [{ ref, text }]；空输出返回 []。
 */
function parseStashList(stdout) {
  const items = []
  for (const line of String(stdout ?? '').split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const match = /^(stash@\{\d+\}):\s*(.*)$/.exec(text)
    if (match === null) continue
    items.push({ ref: match[1], text: match[2].trim() })
  }
  return items
}

/**
 * 远端引用 → 本地新分支名：`origin/master` → `origin-master`（/ 不能出现在分支名里）。 */
function localBranchNameFor(remoteRef) {
  const cleaned = String(remoteRef ?? '')
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/[^\w.\-]/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'remote-branch'
}

export {
  MAX_BUFFER, DEFAULT_TIMEOUT_MS, GIT_LOCAL_TIMEOUT_MS, MAX_STATE_CHANGES,
  runGit, gitMissingMessage, emptyState,
  NOT_REPO_NOTICE, BARE_REPO_NOTICE, notRepoNotice,
  parseBranchLine, parseRemotes, remoteOpFor, cloneTargetName, repoPageUrl, parseBranchOutput,
  parseRemoteBranchOutput, parseLsRemoteHead, isSafeRemoteRef, parseCompareOutput,
  parseStashList,
  localBranchNameFor, readState, currentBranchName,
}
