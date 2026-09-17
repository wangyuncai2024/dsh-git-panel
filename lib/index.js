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
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 插件名（cordis patch 通过包名挂载，这里同时导出以便调试识别）。 */
export const name = 'dsh-git-panel'

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

/** 展开开头的 `~` 为用户主目录（与 shell 直觉一致；对绝对路径无影响）。 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/** 归一化一个可选的目录参数：空白串按“未提供”处理；`~` 展开为主目录。 */
function normalizeDir(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? expandHome(trimmed) : undefined
}

/** git 命令缺失（spawn ENOENT 等）时给可读提示，而不是把英文报错原样甩给用户。 */
function gitMissingMessage(result) {
  if (result === null || result === undefined) return null
  if (result.code !== -1) return null
  if (/ENOENT|not found/i.test(String(result.stderr))) {
    return '未检测到 git：请先安装 git（https://git-scm.com）后重试。'
  }
  return null
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

// ── 日志 ──────────────────────────────────────────────────────────────────
//
// 统一的操作日志：面板/工具每次动作、每条 git 命令、每次注册/配置变更都写进
// `$DSH_HOME/git-panel.log`（JSONL：一行一条，`{ at, level, event, … }`）。
// 目的是「出了问题能复盘」：命令是什么、在哪个目录、跑多久、退出码多少、失败原因
// 是什么、走了哪条网络线路 —— 全都有迹可循，方便维护与排查。
//
// 设计要点：
//   * 级别：off < error < warn < info < debug。默认 info。
//       - info：一次操作 / 一条命令 / 一次配置变更的**结果**（含失败原因）；
//       - debug：细粒度现场（面板每次刷新状态都会跑几条 git，归入 debug，默认不落盘）；
//       - error / warn：分别对应不该发生的事（注册失败、内部异常）与操作失败。
//   * 敏感信息：argv 一律经 displayArgv 打码（代理凭据 → `***@`）后才落盘，
//     和面板回显、模型工具输出同一套规则。
//   * 永不抛异常：写失败只落到宿主 console.error，绝不影响面板与 git 功能。
//   * 轮转：超过 logMaxBytes（默认 2 MiB）就把旧文件改名为 `.1` 再重新写，
//     只保留最近两份 —— 日志不会无限膨胀。
// ──────────────────────────────────────────────────────────────────────────

const LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }
const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024

/** 日志配置（可由插件 config 的 logLevel / logMaxBytes / logFile 覆盖；模块级，测试可直接改）。 */
let logConfig = { level: 'info', maxBytes: DEFAULT_LOG_MAX_BYTES, file: null }

/** 归一化日志级别：非法值与缺省一律落到 info（保持“默认可观测”）。 */
function normalizeLogLevel(value) {
  return typeof value === 'string' && Object.hasOwn(LOG_LEVELS, value) ? value : 'info'
}

/** 归一化轮转上限：非正数落到默认值。 */
function normalizeLogMaxBytes(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_LOG_MAX_BYTES
}

/** 日志文件路径：显式指定优先，否则落在 $DSH_HOME（与网络配置同一目录）。 */
function logFilePath() {
  return (logConfig.file !== null && logConfig.file !== undefined && String(logConfig.file).trim().length > 0)
    ? String(logConfig.file)
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'git-panel.log')
}

/** 设置日志配置（apply 时按插件 config 调用；测试可直接调用）。 */
function setLogConfig(config = {}) {
  const input = config !== null && typeof config === 'object' ? config : {}
  logConfig = {
    level: normalizeLogLevel(input.level),
    maxBytes: normalizeLogMaxBytes(input.maxBytes),
    file: typeof input.file === 'string' && input.file.trim().length > 0 ? input.file.trim() : null,
  }
}

/** 该级别在当前配置下是否会被记录。 */
function shouldLog(level) {
  return LOG_LEVELS[normalizeLogLevel(level)] <= LOG_LEVELS[logConfig.level]
}

/** 轮转：文件超过上限时改名 `.1`（覆盖旧备份），只保留两份。 */
async function rotateLogIfNeeded(path) {
  try {
    const info = await stat(path)
    if (info.size < logConfig.maxBytes) return
    const backup = path + '.1'
    await rm(backup, { force: true })
    await rename(path, backup)
  } catch (error) {
    // 文件不存在（还没写过）或不可读：不轮转，正常走追加。
    if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
      console.error('[git-panel] 日志轮转失败：' + message(error))
    }
  }
}

/**
 * 追加一条日志（JSONL）。所有失败都在内部消化 —— 日志不能成为插件的新故障点。
 * @param level - error | warn | info | debug
 * @param event - 事件名（op / tool / git / state / net / diag / lifecycle / error…）
 * @param fields - 事件字段（**敏感值必须由调用方先打码再传入**）。
 */
async function appendLog(level, event, fields) {
  if (!shouldLog(level)) return
  const record = { at: new Date().toISOString(), level, event, ...(fields !== null && typeof fields === 'object' ? fields : {}) }
  const path = logFilePath()
  try {
    await rotateLogIfNeeded(path)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
  } catch (error) {
    try {
      console.error('[git-panel] 日志写入失败：' + message(error))
    } catch {
      /* 连 console 都没有时只能放弃 */
    }
  }
}

/** 读日志尾部（调试 / GET /git-panel/log 用）：返回最近 maxLines 行的原文数组。 */
async function readLogTail(maxLines = 200) {
  const count = typeof maxLines === 'number' && Number.isFinite(maxLines) && maxLines > 0
    ? Math.min(Math.floor(maxLines), 2000)
    : 200
  try {
    const text = await readFile(logFilePath(), 'utf8')
    const lines = text.split('\n')
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop()
    return lines.slice(-count)
  } catch {
    return []
  }
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
      result = { code: -1, stdout: '', stderr: message(raw) }
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

// ── 网络加速 ──────────────────────────────────────────────────────────────
//
// 背景：国内直连 github.com 经常连不上（典型报错 `Recv failure: Connection was
// reset`，或者干脆一直挂着直到超时）。这里提供两级加速，**都只作用于单条 git
// 命令**（通过 `git -c …` 注入），不写用户的 ~/.gitconfig，也不写仓库的
// .git/config —— 终端里的 git 行为完全不变，关掉开关就等于什么都没发生过。
//
//   1. 镜像（只读操作）：`url.<镜像>.insteadOf=https://github.com/` 让
//      clone / fetch / pull 改走第三方镜像。**实测 git 只重写传输时用的地址，
//      克隆完成后 origin 里存的仍然是原始 github URL**，因此不会污染仓库配置。
//   2. 代理（全部联网操作，含 push）：`http.proxy` / `https.proxy`。
//
// 镜像默认**关闭**，这是有意的安全取舍：请求会经过第三方，私有仓库的内容（以及
// 需要认证时携带的凭据）对它都是可见的。必须由用户显式打开，不能替他默认决定。
// ──────────────────────────────────────────────────────────────────────────

/** 网络加速配置的落盘位置。写成函数而非常量：测试可以改 DSH_HOME 后再读。 */
function netConfigPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'git-panel-net.json')
}

/** 内存缓存：只在写入时更新，避免每条 git 命令都去读一次盘。 */
let netConfigCache = null

/**
 * 候选镜像。这里**不写死「哪个能用」的结论** —— 镜像的可用性随时间和地区变化，
 * 面板上的「检测网络」按钮会在这台机器上现场实测（见 probeNetwork）。
 */
const MIRROR_CANDIDATES = [
  { id: 'gh-proxy', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { id: 'ghproxy-net', label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' },
]

/** 会走网络的操作 —— 只有这些才可能被加速（其余操作注入参数纯属噪音）。 */
const NETWORK_OPS = new Set(['clone', 'fetch', 'pull', 'push'])
/** 其中只读的那几个：镜像只能给它们用。push 走镜像会丢掉 origin 的凭据主体，必然认证失败。 */
const READONLY_NET_OPS = new Set(['clone', 'fetch', 'pull'])
/**
 * 镜像只重写 GitHub 的 HTTP(S) 地址。SSH 形态（`git@github.com:…`）**故意不碰**：
 * 把它改写成 HTTPS 会同时改掉认证方式，私有仓库会因此失败 —— 这个决定不该替他做。
 */
const GITHUB_PREFIXES = ['https://github.com/', 'http://github.com/']

/** 打码后的凭据形态；用户不可能真拿它当密码，见到它就表示「保持原值」。 */
const MASK_TOKEN = '***@'

/** 取多行文本的第一行非空内容（错误提示展示第一行就够了）。 */
function firstLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/** 镜像前缀 → 给人看的短名字（面板显示域名，不显示整条 URL）。 */
function mirrorLabel(prefix) {
  const text = String(prefix ?? '')
  try {
    return new URL(text).host
  } catch {
    return text
  }
}

/**
 * 把凭据部分打码。GET /git-panel/net 在局域网内是可达的（见 README 的安全说明），
 * 所以代理地址里的用户名/密码绝不能原样回显。
 */
function maskProxy(value) {
  return String(value ?? '').replace(/\/\/[^/@\s]+@/g, '//' + MASK_TOKEN)
}

/** 面板回显用的参数：`-c http.proxy=http://user:pass@…` 同样要打码。 */
function displayArgv(argv) {
  const list = Array.isArray(argv) ? argv : []
  return list.map((item) => maskProxy(item))
}

/** 镜像地址归一化：只接受 https（镜像看得见你的仓库内容，明文 http 不能接受）。 */
function normalizeMirror(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (!/^https:\/\/[^\s]+$/i.test(trimmed)) return ''
  return trimmed.endsWith('/') ? trimmed : trimmed + '/'
}

/** 代理地址归一化：只接受带协议的 http/https/socks5。 */
function normalizeProxy(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (!/^(?:https?|socks5h?):\/\/[^\s]+$/i.test(trimmed)) return ''
  return trimmed
}

/** 把任意输入压成一份合法配置：非法字段退化为默认值，而不是抛异常中断 git 功能。 */
function normalizeNetConfig(input) {
  const value = input !== null && typeof input === 'object' ? input : {}
  const mirror = normalizeMirror(value.mirror)
  // 用户没填 / 填了非法值时用第一个候选兜底。**判断开关必须用兜底后的值**：
  // 早先这里用用户填的那个空串去算，于是「只把开关打开」会被归一化成关闭 ——
  // 表现是开了加速却仍然直连，然后卡死在 github.com 上超时，极难排查。
  const effective = mirror.length > 0 ? mirror : MIRROR_CANDIDATES[0].prefix
  return {
    mirrorEnabled: value.mirrorEnabled === true,
    mirror: effective,
    proxy: normalizeProxy(value.proxy),
  }
}

/** 读配置（带缓存）。任何读取/解析失败都退化成「不加速」，绝不让 git 功能跟着挂掉。 */
async function readNetConfig() {
  if (netConfigCache !== null) return netConfigCache
  try {
    netConfigCache = normalizeNetConfig(JSON.parse(await readFile(netConfigPath(), 'utf8')))
  } catch {
    netConfigCache = normalizeNetConfig({})
  }
  return netConfigCache
}

/** 写配置：先与现有配置合并，落盘，再更新缓存。落盘失败不阻断本次设置。 */
async function writeNetConfig(input) {
  const current = await readNetConfig()
  const patch = input !== null && typeof input === 'object' ? input : {}
  // proxy 为空串时 normalizeProxy 会退化成空 —— 这正是「关闭代理」的表达方式。
  const merged = normalizeNetConfig({
    mirrorEnabled: patch.mirrorEnabled === undefined ? current.mirrorEnabled : patch.mirrorEnabled,
    mirror: patch.mirror === undefined ? current.mirror : patch.mirror,
    proxy: patch.proxy === undefined ? current.proxy : patch.proxy,
  })
  netConfigCache = merged
  try {
    const path = netConfigPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  } catch (error) {
    // 写不进去也要让本进程内生效（用户点的那一下不能白点），只在宿主日志里说一声。
    const detail = message(error)
    console.error('[git-panel] 网络加速配置写入失败：' + detail)
    await appendLog('error', 'net-save', { ok: false, error: detail })
  }
  return merged
}

/** 仅供测试：丢掉内存缓存，下次读取重新落盘解析。 */
function resetNetConfigCache() {
  netConfigCache = null
}

/** 回给面板的配置视图：代理凭据打码，只回「有没有设」。 */
function netConfigView(config) {
  const cfg = normalizeNetConfig(config)
  return {
    mirrorEnabled: cfg.mirrorEnabled,
    mirror: cfg.mirror,
    proxy: maskProxy(cfg.proxy),
    hasProxy: cfg.proxy.length > 0,
    candidates: MIRROR_CANDIDATES.map((item) => ({ id: item.id, label: item.label, prefix: item.prefix })),
  }
}

/**
 * 计算一条 git 命令要插入的加速参数，**已经带好 `-c`**，调用方直接展开在
 * `git` 与子命令之间即可（`git <…args> <cmd>`）。
 *
 * 为什么把 `-c` 收进来：早先这里只回裸的 `key=value`，指望各调用点自己补 `-c`，
 * 结果每处都忘了补 —— git 把 `url.<…>.insteadOf=…` 当成了**子命令**，报
 * 「不是一个 git 命令」。后果极其隐蔽：加速完全没生效、全部悄悄退回直连，
 * 而面板只显示 git 那句莫名其妙的报错。把 `-c` 收在这里，调用方就没有拼错的机会。
 *
 * @param op - git 子命令名（'clone' / 'fetch' / …）。
 * @param config - 网络加速配置。
 * @param options.noMirror - 为 true 时只用代理、不用镜像（镜像失败后的回退重试用）。
 * @returns { args, mode, mirror }：mode ∈ direct | proxy | mirror | mirror+proxy。
 */
function networkExtraArgs(op, config, options = {}) {
  const command = String(op ?? '')
  if (!NETWORK_OPS.has(command)) return { args: [], mode: 'direct', mirror: false }

  const cfg = config !== null && config !== undefined ? config : {}
  const args = []
  const modes = []
  /** 追加一条 `-c key=value`。 */
  const setConfig = (key, value) => {
    args.push('-c', key + '=' + value)
  }

  const proxy = normalizeProxy(cfg.proxy)
  if (proxy.length > 0) {
    setConfig('http.proxy', proxy)
    setConfig('https.proxy', proxy)
    modes.push('proxy')
  }

  const mirror = normalizeMirror(cfg.mirror)
  const useMirror = cfg.mirrorEnabled === true && mirror.length > 0
    && READONLY_NET_OPS.has(command) && options.noMirror !== true
  if (useMirror) {
    for (const original of GITHUB_PREFIXES) {
      // 注意 base 必须是「镜像 + 原前缀」：insteadOf 做的是**前缀替换**，写成
      // `url.<镜像>.insteadOf=<原前缀>` 会得到 `https://gh-proxy.com/owner/repo`，
      // 而这类镜像要的是 `https://gh-proxy.com/https://github.com/owner/repo`。
      // 拼错的后果不是报错，而是静默地连到一个不存在的地址然后挂到超时。
      setConfig('url.' + mirror + original + '.insteadOf', original)
    }
    // 镜像不是官方线路，随时可能不通。卡住时不该让用户干等满 10 分钟：60 秒内
    // 几乎没有数据就主动中断，外层会立刻回退直连。**只给镜像这一次尝试加**，
    // 回退的直连那次不加 —— 免得误杀一个只是慢、但确实在下载的大仓库。
    setConfig('http.lowSpeedLimit', '1000')
    setConfig('http.lowSpeedTime', '60')
    modes.push('mirror')
  }

  return { args, mode: modes.length > 0 ? modes.join('+') : 'direct', mirror: useMirror }
}

/**
 * 判断一次失败是不是「网络连不上」这一类。
 *
 * 关键是和「服务器答复了」区分开：`The requested URL returned error: 404` 说明链路
 * 是通的，报的是仓库不存在 —— 归成网络问题会把用户引到完全错误的排查方向。
 */
function classifyNetworkFailure(text) {
  const value = String(text ?? '')
  if (value.length === 0) return null
  if (/The requested URL returned error: \d{3}/i.test(value)) return null
  if (/Recv failure|Send failure|Connection was reset|connection reset|Could not connect|Failed to connect|Connection timed out|Operation timed out|Empty reply from server|Connection refused|gnutls_handshake|SSL_ERROR|TLS handshake|unable to access|Proxy CONNECT aborted|命令超时/i.test(value)) {
    return 'network'
  }
  return null
}

/**
 * 这次失败该不该算在镜像头上（= 要不要回退直连、要不要提「镜像没走通」）。
 *
 * 判据只取「可能是镜像线路造成的」两类特征：
 *   1. 网络类故障（连不上 / 连接被重置 / 超时 / TLS 握手失败 …）；
 *   2. 服务器回了 HTTP 状态码（404/403/5xx —— 镜像没缓存、私有仓库它看不到，直连可能通）。
 *
 * 本地配置类错误（没有上游、没有远程、无关历史、冲突、SSH 认证失败）两个特征都没有，
 * 因此不会被误判成镜像故障。早先只要命令失败就回退并写下「镜像没走通」，结果是用户
 * 被引去折腾网络加速，而真正的原因在本地 —— 排查方向被彻底带偏。
 *
 * 注：classifyNetworkFailure 故意把 `The requested URL returned error: 404` 排除在
 * 「网络问题」之外（服务器答复了就不算连不上），所以状态码这一类在这里单独补上。
 */
function mirrorFallbackWorthwhile(stderr) {
  const value = String(stderr ?? '')
  if (value.length === 0) return false
  if (classifyNetworkFailure(value) !== null) return true
  return /The requested URL returned error: \d{3}/i.test(value)
}

/** 网络失败时给面板的「下一步点哪里」（区分「已经开过加速还是不通」）。 */
function networkHint(accelerated) {
  if (accelerated === true) {
    return '还是连不上。镜像对私有仓库、刚建的空仓库常常不可用，换一个镜像再试；'
      + '要推送或访问私有仓库，请改填本机代理（如 http://127.0.0.1:7890）。'
  }
  return '连不上远端（连接被重置 / 超时），国内直连 github.com 很常见。'
    + '点面板右上角的 🌐 打开「网络加速」：公开仓库用镜像，私有仓库或要推送就填本机代理。'
}

/** 「检测网络」用的公开小仓库，只做 ls-remote，不下载任何内容。 */
const PROBE_URL = 'https://github.com/octocat/Hello-World'
/** 单条线路的探测上限：够慢网络握手，又不至于让按钮转太久。 */
const PROBE_TIMEOUT_MS = 8000

/**
 * 构造探测任务清单（纯函数，不触网 —— 所以「代理那条带没带 `-c`」可以直接断言）。
 *
 * 两条线路的测法不同，是有意的：
 *   - 镜像：直接把地址换成 `镜像 + 原地址` 去连，测的是**这个镜像端点通不通**。
 *   - 代理：原地址不变，靠 `-c http.proxy=…` 走代理。
 *
 * 代理那份参数**复用 `networkExtraArgs`**，绝不在这里手写 `-c key=value`：
 * 手写过一次，就漏了 `-c`，于是 git 把 `http.proxy=…` 当成子命令，
 * 「检测网络」里代理那条永远显示成一个看不懂的失败。
 */
function probeJobs(config) {
  const cfg = normalizeNetConfig(config)
  const jobs = [{ kind: 'direct', label: '直连 github.com', url: PROBE_URL, args: [] }]
  for (const mirror of MIRROR_CANDIDATES) {
    jobs.push({ kind: 'mirror', label: mirror.label, url: mirror.prefix + PROBE_URL, args: [] })
  }
  // 只传 proxy：镜像那条已经单独测过了，这里再叠一层反而说不清是哪一段起作用。
  const proxyArgs = networkExtraArgs('fetch', { proxy: cfg.proxy }).args
  if (proxyArgs.length > 0) {
    jobs.push({ kind: 'proxy', label: '代理 ' + maskProxy(cfg.proxy), url: PROBE_URL, args: proxyArgs })
  }
  return jobs
}

/**
 * 现场实测每条线路，让用户知道「这台机器上哪条路通」。
 * 几条线路并发跑，所以「耗时」是参考值而不是精确延迟 —— 用来排序足够了。
 */
async function probeNetwork(config) {
  // 在临时目录里跑：宿主的 cwd 有可能已经被删掉（换工作时清理过目录），而在某个
  // 仓库里跑又会受那个仓库的本地 git 配置影响 —— 探测要测的是「这台机器通不通」，
  // 不该被这两件事干扰。
  const cwd = tmpdir()

  return Promise.all(probeJobs(config).map(async (job) => {
    const started = Date.now()
    const result = await runGit([...job.args, 'ls-remote', job.url, 'HEAD'], cwd, { timeoutMs: PROBE_TIMEOUT_MS })
    const ms = Date.now() - started
    const ok = result.code === 0 && result.stdout.trim().length > 0
    return {
      kind: job.kind,
      label: job.label,
      ok,
      ms,
      error: ok ? null : (firstLine(result.stderr) || 'git 退出码 ' + result.code),
    }
  }))
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

/** 超长文本截断：diff 容易达到几十 KB，面板小窗口放不下，截断并留一行提示。 */
function truncateText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n…（内容过长，已截断）'
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
    // 顺序要写全：先「获取远程」再「拉取」——只写「先拉取」时，没有上游的分支
    // 会当场再撞一次墙，用户就卡在两条提示互相指的死循环里。
    return '推送被拒绝（远端有你本地没有的提交）：先点「获取远程」，再点「拉取」，合并后重新推送。'
  }
  return null
}

/**
 * 探测一次 pull 为什么失败。
 *
 * 与 push 分开是必要的：拉取的报错文本是另一套，而最常见的那条
 * （`There is no tracking information for the current branch`）在 push 的分类里
 * 认不出来，于是面板只能把英文原文甩给用户 —— 这正是「想拉取却卡住」的现场。
 * @returns 归一化原因；`none` 表示不是已知的拉取类故障。
 */
function classifyPullFailure(text) {
  const value = String(text ?? '')
  if (/has no tracking information|no tracking information|没有跟踪信息/i.test(value)) return 'no-upstream'
  if (/No remote repository specified|no configured push destination|没有配置推送目标/i.test(value)) return 'no-remote'
  if (/couldn't find remote ref|Could not find remote branch|Remote branch .* not found|找不到远程引用/i.test(value)) return 'remote-branch-missing'
  // 「仓库卡在某个中间状态」这一类：命令没错、网络也没错，只是上一次合并没收尾。
  // 三种真实文案都要认：git 在不同阶段给的是不同句子（实测都出现过）：
  //   - `Pulling is not possible because you have unmerged files.`（冲突还没解决）
  //   - `error: You have not concluded your merge (MERGE_HEAD exists).`
  //   - `fatal: Exiting because of an unresolved conflict.`
  // 必须排在 conflict 之前：这些句子里也带 conflict/merge 字样。
  if (/unmerged files|unresolved conflict|You have not concluded your merge|MERGE_HEAD exists|unfinished merge|尚未结束的合并/i.test(value)) return 'merge-unfinished'
  if (/Your local changes to the following files would be overwritten|commit your changes or stash them before you merge/i.test(value)) return 'dirty-worktree'
  if (/refusing to merge unrelated histories|unrelated histories/i.test(value)) return 'unrelated'
  if (/CONFLICT|Automatic merge failed|fix conflicts|冲突/i.test(value)) return 'conflict'
  return 'none'
}

/**
 * pull 的报错**分散在两个流上**，分类必须看两边。
 *
 * 实测（见 test 里的真实文案）：
 *   - 合并冲突整段在 **stdout**：`Auto-merging … / CONFLICT (content): … / Automatic merge failed…`
 *   - 网络类故障在 stderr。
 * 早先只喂 stderr，于是最常见的"拉取撞上冲突"被判成「未知错误」，面板一个提示都没有 ——
 * 恰恰是最需要提示的那一种。
 */
function pullFailureText(result) {
  const value = result !== null && result !== undefined ? result : {}
  return String(value.stderr ?? '') + '\n' + String(value.stdout ?? '')
}

/** 把探测到的拉取失败原因翻译成可操作的中文提示（每条都要说清下一步点哪里）。 */
function pullHint(reason) {
  if (reason === 'no-remote') {
    return '这个仓库还没有配置远程地址：在「远程」里填入地址并保存，再点「拉取」。'
  }
  if (reason === 'no-upstream') {
    return '当前分支既没有上游、也推不出该拉远程哪个分支（例如处于游离 HEAD）：先在「管理」里切到一个分支，再点「拉取」。'
  }
  if (reason === 'remote-branch-missing') {
    // 措辞不能再是「先点一次推送把它推上去」：远端往往**有**分支，只是名字不一样
    // （本地 master、远端 main）。照老话去推送，只会在 GitHub 上多出一个 master。
    return '远端没有和当前分支同名的分支，也没有对得上的默认分支：先点「获取远程」，再展开「管理」'
      + '看看远端有哪些分支（在那里可以把远端那份一键拿成新分支）；或者确实想推本地这一份时再点「推送」。'
  }
  if (reason === 'merge-unfinished') {
    return '上一次拉取留下的合并还没结束（工作区里有未合并的文件），git 因此拒绝再拉一次：'
      + '要么在终端里把冲突文件改好 → git add 那个文件 → git commit 收尾；'
      + '要么执行 git merge --abort 撤销这次合并，直接回到拉取之前的样子（撤销是安全的，不会动你已有的提交）。'
  }
  if (reason === 'dirty-worktree') {
    return '工作区里有未提交的改动，会被这次合并覆盖，所以 git 先拒绝了：'
      + '先「全部暂存」并写提交信息提交（不想要的改动则点「丢弃改动」），再点「拉取」。'
  }
  if (reason === 'unrelated') {
    // 这条提示下面是两个真正的按钮（见 unrelatedChoices），所以绝不能再写「请去终端处理」——
    // 那等于把已经替用户铺好的路又收回去了。
    return '本地和远端是两套互不相关的历史，git 不会替你合并：在下面的选项里选一个结果就行，不用敲命令。'
  }
  if (reason === 'conflict') {
    return '合并出现冲突：面板不替你决定要哪边。改好冲突文件后 git add + git commit 收尾；'
      + '不想合了执行 git merge --abort，回到拉取之前的样子。'
  }
  return null
}

/**
 * 读取一个目录的仓库状态（面板与工具共用）。
 * 永不抛异常：任何失败都折成 notice 字段返回，保证面板总能渲染。
 */
async function readState(dir) {
  const startedAt = Date.now()
  const shown = normalizeDir(dir) ?? null
  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], dir, { timeoutMs: 20000 })
  const isRepo = probe.code === 0 && probe.stdout.trim() === 'true'
  if (!isRepo) {
    const state = {
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
      notice: gitMissingMessage(probe) ?? (probe.stderr.trim().length > 0 ? probe.stderr.trim() : '当前目录还不是 Git 仓库'),
    }
    appendLog('debug', 'state', { dir: shown, isRepo: false, ms: Date.now() - startedAt })
    return state
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

  const state = {
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
  appendLog('debug', 'state', {
    dir: shown,
    isRepo: true,
    branch,
    changes: changes.length,
    ms: Date.now() - startedAt,
  })
  return state
}

/**
 * 把面板发来的操作名翻译成 git 参数数组。
 * 只接受白名单操作，任何用户字符串都作为独立参数传递，不参与命令拼接。
 * @throws 参数不合法时抛出带中文提示的错误（面板直接展示）。
 */
async function buildOpArgv(op, input) {
  if (op === 'init') return ['init']
  if (op === 'addAll') return ['add', '-A']
  // 撤销暂存：把暂存区重置回 HEAD，不动工作区（git reset 不支持 --no-color，无需加）。
  if (op === 'unstage') return ['reset']
  // 丢弃改动：用暂存区/HEAD 内容覆盖工作区（不影响未跟踪文件；已暂存内容先「撤销暂存」）。
  if (op === 'discard') return ['checkout', '--', '.']
  // 分支管理器：列出本地分支（面板解析后再渲染成可点列表）。
  if (op === 'branches') return ['branch', '--no-color']
  // 分支管理器里的远端分组：获取远程之后这里才有东西（面板解析后渲染）。
  if (op === 'remoteBranches') return ['branch', '--remotes', '--no-color']
  // 和某个远端分支比一比领先/落后（面板里点远端分支的「比较」）。
  if (op === 'compare') {
    const ref = typeof input.ref === 'string' ? input.ref.trim() : ''
    if (!isSafeRemoteRef(ref)) throw new Error('请选择一个远端分支再比较')
    return ['rev-list', '--left-right', '--count', 'HEAD...' + ref]
  }
  // 切换分支用 git switch（而非 checkout）：switch 只做分支语义，
  // 不会像 checkout 那样在「名字既像分支又像路径」时误判成还原文件。
  if (op === 'checkout') {
    const branch = typeof input.branch === 'string' ? input.branch.trim() : ''
    if (branch.length === 0) throw new Error('请选择要切换的分支')
    return ['switch', branch]
  }
  if (op === 'createBranch') {
    const branch = typeof input.branch === 'string' ? input.branch.trim() : ''
    if (branch.length === 0) throw new Error('请填写新分支名')
    return ['switch', '-c', branch]
  }
  // 安全删除：-d 只删已合并的分支，未合并提交会被 git 拒绝（避免误删历史）。
  if (op === 'deleteBranch') {
    const branch = typeof input.branch === 'string' ? input.branch.trim() : ''
    if (branch.length === 0) throw new Error('请选择要删除的分支')
    return ['branch', '-d', branch]
  }
  // 查看单个改动的 diff：面板「点改动条目看 diff」用；cached 看暂存区版本。
  if (op === 'diff') {
    const argv = ['diff', '--no-color']
    if (input.cached === true) argv.push('--cached')
    const path = typeof input.path === 'string' ? input.path : ''
    if (path.length > 0) argv.push('--', path)
    return argv
  }
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
    return remoteOpFor(name, url, listed.stdout)
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
 * @param extraArgs - 网络加速参数。重试也必须带上：否则「开着代理重推一次」会退化成直连。
 */
async function recoverPush(op, body, argv, result, dir, timeoutMs, extraArgs = []) {
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
  const retryArgv = [...extraArgs, 'push', '--set-upstream', chosen, 'HEAD']
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

/**
 * 当前分支的上游拆成 { remote, branch }；没有上游返回 null。
 *
 * 用途：裸 `git pull` 直接撞上「两套历史互不相关」时（分支已经配了上游，
 * 所以第一步就走到了合并），报错里没有远程名和分支名 —— 而渲染「选一个结果」
 * 的两个按钮恰恰需要它们（见路由里的 choices）。
 */
async function upstreamRef(dir, timeoutMs) {
  const found = await runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    dir,
    { timeoutMs: timeoutMs ?? 20000 },
  )
  const name = found.code === 0 ? found.stdout.trim() : ''
  const slash = name.indexOf('/')
  if (slash <= 0 || slash >= name.length - 1) return null
  return { remote: name.slice(0, slash), branch: name.slice(slash + 1) }
}

/**
 * 在远端分支列表里挑出「该按哪个分支拉」的那一个。
 *
 * 规则（都是**确定**的推断，绝不猜）：
 *   - 远端自己的默认分支（`origin/HEAD -> origin/main`）优先；
 *   - 拿不到指针、但该远程只有一个分支时，就是它；
 *   - 多个分支又没有指针 → 返回 null，交回给 remote-branch-missing 的提示，
 *     让用户自己去「管理」里选。
 * 结果和本地分支同名时也返回 null：同名说明走到这里的场景不成立。
 *
 * @param parsed - parseRemoteBranchOutput 的结果。
 * @returns 远端分支名（如 'main'）或 null。
 */
function pickRemoteDefaultBranch(parsed, remote, localBranch) {
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const items = Array.isArray(source.items) ? source.items : []
  const own = items.filter((item) => item.remote === remote)
  if (own.length === 0) return null
  let target = null
  if (typeof source.defaultRef === 'string' && own.some((item) => item.ref === source.defaultRef)) {
    target = source.defaultRef
  } else if (own.length === 1) {
    target = own[0].ref
  }
  if (target === null || target.slice(0, remote.length + 1) !== remote + '/') return null
  const branch = target.slice(remote.length + 1)
  if (branch.length === 0 || branch === localBranch) return null
  return branch
}

/**
 * 本地分支名在远端不存在时的第二条路（见 recoverPull）。
 *
 * 现场：本地是 `git init` 出来的 `master`，远端默认分支叫 `main`。裸 `git pull` 报
 * 「没有跟踪信息」，自动重试 `git pull origin master` 又报 `couldn't find remote ref
 * master`；面板于是给一句「先点一次推送把它推上去」—— 用户照做会在 GitHub 上多出一个
 * master 分支，而真正的出路（远端那份要不要拿过来）一个字都没提。
 *
 * 这里按远端的默认分支（`origin/HEAD -> origin/main`）再判断一次：
 *   - 两套历史互不相关 → **不合并**（git 自己也会拒绝），把 reason 报成 unrelated，
 *     面板据此渲染「要远端那份 / 要本地那份」两个按钮，动作指向真正的 origin/main；
 *   - 历史相关（同名分支被改名这类）→ 用「远程 + 远端默认分支」拉一次并说明用了哪个分支。
 *
 * @returns { argv, result, reason, retried, remote, branch, note?, message? }；没有可用的
 *   远端默认分支时返回 null，交回给原来的 remote-branch-missing 提示。
 * @param failed - 刚才那次真正跑过、失败的 pull（{ argv, result }）。无关历史那一支
 *   直接把它报回去：结论（远端没有这个分支、默认分支是哪个、两边无关）写在 message 里，
 *   **不伪造 git 的报错原文**。
 */
async function pullRemoteDefaultBranch(dir, remote, localBranch, timeoutMs, extraArgs, failed) {
  const listed = await runGit(['branch', '--remotes', '--no-color'], dir, { timeoutMs: 20000 })
  if (listed.code !== 0) return null
  const remoteBranch = pickRemoteDefaultBranch(parseRemoteBranchOutput(listed.stdout), remote, localBranch)
  if (remoteBranch === null) return null
  const remoteRef = remote + '/' + remoteBranch

  const situation = '远端没有和当前分支同名的 ' + localBranch + '；远端的默认分支是 ' + remoteRef + '，'
  const base = await runGit(['merge-base', remoteRef, 'HEAD'], dir, { timeoutMs: 20000 })
  const unrelated = base.code !== 0 || base.stdout.trim().length === 0
  if (unrelated) {
    return {
      argv: failed.argv,
      result: failed.result,
      reason: 'unrelated',
      retried: true,
      remote: remote,
      branch: remoteBranch,
      message: situation + '两边是两套互不相关的历史（git 不会替你合并）',
    }
  }

  const argv = [...extraArgs, 'pull', remote, remoteBranch]
  const result = await runGit(argv, dir, { timeoutMs })
  if (result.code !== 0) {
    return {
      argv: argv,
      result: result,
      reason: classifyPullFailure(pullFailureText(result)),
      retried: true,
      remote: remote,
      branch: remoteBranch,
      note: situation + '这次按它拉取（结果见上）',
    }
  }
  return {
    argv: argv,
    result: result,
    reason: 'none',
    retried: true,
    remote: remote,
    branch: remoteBranch,
    note: situation + '这次按它拉取；没有登记上游（分支名不同，登记后推送会撞上 git 的 simple 规则）',
  }
}

/**
 * 拉取失败后的自动补救。
 *
 * 背景：面板的「拉取」原先固定跑裸 `git pull`，而**没有上游的分支上它必然失败**
 * （`There is no tracking information for the current branch`）—— 那条命令连网络
 * 都没碰，面板却把它当成网络/镜像故障，用户就卡在「要推送得先拉取、要拉取又得先有上游」
 * 的循环里。这里按 git 自己给的补救办法处理：
 *
 *   - 没有上游 → 用「远程 + 当前分支」再拉一次（`git pull <远程> <分支>` 不要求上游），
 *     成功后顺手登记上游（`branch --set-upstream-to`），以后裸 pull 就能直接用。
 *   - 重试报「远端没有这个分支」→ 改用远端的默认分支再判断一次（见 pullRemoteDefaultBranch）。
 *   - 没有远程 / 无关历史 / 冲突 → 不做自动动作，只回传 reason，
 *     由 pullHint 告诉用户下一步点哪里（无关历史还会附带两个按钮）。
 *
 * @returns { argv, result, reason, retried, remote?, branch?, note?, message? } —— 与
 *   recoverPush 同形，路由同一处处理。
 * @param extraArgs - 网络加速参数。重试也要带上：否则「开着代理重拉一次」会退化成直连。
 */
async function recoverPull(op, argv, result, dir, timeoutMs, extraArgs = []) {
  const reason = result.code === 0 ? 'none' : classifyPullFailure(pullFailureText(result))
  if (op !== 'pull' || result.code === 0) return { argv, result, reason, retried: false }

  // 「两套历史互不相关」有两种到达方式：有上游时裸 pull 就撞上，或者下面的自动重试撞上。
  // 第一种原先只带回 reason、不带 remote/branch，于是按钮渲染不出来，而提示里却写着
  // 「在下面的选项里选一个结果」—— 用户看到的是一句指向不存在按钮的话。这里把上游补出来。
  if (reason === 'unrelated') {
    const upstream = await upstreamRef(dir, timeoutMs)
    if (upstream === null) return { argv, result, reason, retried: false }
    return {
      argv: argv,
      result: result,
      reason: reason,
      retried: false,
      remote: upstream.remote,
      branch: upstream.branch,
    }
  }
  if (reason !== 'no-upstream') return { argv, result, reason, retried: false }

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: 20000 })).stdout)
  if (remotes.length === 0) return { argv, result, reason: 'no-remote', retried: false }
  // 优先 origin；没有 origin（且只有一个远程）就用那一个，避免硬编码失败。
  const chosen = remotes.some((item) => item.name === 'origin') ? 'origin' : remotes[0].name

  // 当前分支名。真游离 HEAD 时拿不到名字，那就不硬猜了，交回给 pullHint 说清楚。
  const branch = await currentBranchName(dir, 20000)
  if (branch.length === 0) return { argv, result, reason, retried: false }

  const retryArgv = [...extraArgs, 'pull', chosen, branch]
  const retry = await runGit(retryArgv, dir, { timeoutMs })
  if (retry.code !== 0) {
    const retryReason = classifyPullFailure(pullFailureText(retry))
    // 只有「远端没有这个分支」才值得换默认分支再试：别的失败（冲突、认证、网络）与分支名无关。
    if (retryReason === 'remote-branch-missing') {
      const fallback = await pullRemoteDefaultBranch(
        dir, chosen, branch, timeoutMs, extraArgs, { argv: retryArgv, result: retry },
      )
      if (fallback !== null) return fallback
    }
    // 把这次真正用的远程与分支带回去：路由要靠它们构造「两套历史互不相关」时的
    // 两个选择（见 unrelatedChoices），否则又得多查一遍 git。
    return {
      argv: retryArgv,
      result: retry,
      reason: retryReason,
      retried: true,
      remote: chosen,
      branch: branch,
    }
  }

  // 拉成功：顺手把上游登记上，让「拉取」按钮下次能直接用。登记失败也要照实说
  // （本次拉取确实完成了，只是下次还得再走一遍自动判断），不能写成「已建立跟踪」。
  const tracked = await runGit(
    ['branch', '--set-upstream-to=' + chosen + '/' + branch, branch],
    dir,
    { timeoutMs: 20000 },
  )
  const note = tracked.code === 0
    ? '这个分支原先没有上游：已自动按「' + chosen + ' ' + branch + '」拉取，并把它登记为上游（以后直接点「拉取」即可）'
    : '这个分支原先没有上游：已自动按「' + chosen + ' ' + branch + '」拉取；上游没能自动登记（'
      + (firstLine(tracked.stderr) || 'git 退出码 ' + tracked.code) + '）'
  return { argv: retryArgv, result: retry, reason: 'none', retried: true, note: note }
}

// ── 「两套历史互不相关」时用户要做的选择 ──────────────────────────────────
//
// 背景：本地是 `git init` 出来的一条历史、远端是别人另一条历史时，git 不会自动合并
// （`refusing to merge unrelated histories`）。**这不是命令写错了，而是要用户做一个
// 决定**：要远端那份，还是要本地那份。以前面板只能把这个决定翻译成中文再丢回给用户
// （「请在终端里处理」），对不懂 git 的人来说等于没帮上忙。
//
// 这里把两条路都实现成可执行的操作，由面板渲染成按钮：
//   branch —— 安全：把远端那份开成一个新分支（当前分支一点不动）；
//   reset  —— 覆盖：让当前分支直接等于远端（有前置检查，并告诉用户旧提交怎么找回）。
// 面板不替用户猜哪条对，但把「选哪个结果」变成只需要点一下。
// ──────────────────────────────────────────────────────────────────────────

/** `/git-panel/op` 的响应骨架：面板会读这些字段，缺哪个它就读到 undefined。 */
function opResponse(partial = {}) {
  return {
    ok: false,
    command: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    message: null,
    reason: 'none',
    hint: null,
    retried: false,
    accelerated: 'direct',
    network: false,
    notes: [],
    clonedDir: null,
    branches: null,
    remoteBranches: null,
    compare: null,
    diff: null,
    choices: null,
    ...partial,
  }
}

/** 远端引用 → 本地新分支名：`origin/master` → `origin-master`（/ 不能出现在分支名里）。 */
function localBranchNameFor(remoteRef) {
  const cleaned = String(remoteRef ?? '')
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/[^\w.\-]/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'remote-branch'
}

/**
 * 构造「两套历史互不相关」时给面板的两条路（面板渲染成按钮）。
 * @param remote - 远程名（如 origin）。
 * @param branch - 当前本地分支名（如 master）。
 */
function unrelatedChoices(remote, branch) {
  const remoteRef = remote + '/' + branch
  return [
    {
      id: 'branch',
      label: '把远端那份拿成新分支（安全）',
      detail: '新开一个分支，内容就是远端的 ' + remoteRef + '；当前分支 ' + branch + ' 一点都不动。',
      op: 'adoptRemote',
      // 远端分支名必须**显式带上**：这两个按钮出现的场景恰恰是「本地分支名和远端对不上」
      // （本地 master、远端 main 就是最常见的一种），再让 adoptRemote 按当前分支去猜，
      // 只会拼出一个不存在的 origin/master。
      params: { mode: 'branch', remote: remote, branch: branch },
      confirm: null,
    },
    {
      id: 'reset',
      label: '让当前分支直接变成远端那份',
      detail: '用 ' + remoteRef + ' 覆盖当前分支和工作区文件；本地现有提交不再有分支指着（还能用 git reflog 找回）。',
      op: 'adoptRemote',
      params: { mode: 'reset', remote: remote, branch: branch },
      confirm: '确定用远端 ' + remoteRef + ' 覆盖当前分支 ' + branch + ' 吗？\n\n'
        + '· 工作区里已提交的内容会被远端那份替换\n'
        + '· 本地现有提交不再有分支指着（可以用 git reflog 找回）\n'
        + '· 若有未提交的改动，面板会先拒绝执行，不会静默抹掉\n'
        + '· 未跟踪的文件（?? 那些）不受影响',
    },
  ]
}

/**
 * 冲突 / 合并没收尾时给面板的退路：撤销这次合并，回到拉取之前。
 *
 * 为什么「撤销」可以做成按钮，而「解决冲突」不行：解决冲突要用户对每个文件判断留哪边，
 * 面板不能替他选；而「我不想合了」是一个**不需要判断**的决定，git 又恰好有一个安全的
 * 对应动作 —— `merge --abort` 把仓库退回合并开始前，已提交的内容一点不动。
 * 所以这里只给退路，不给答案。
 */
function mergeAbortChoice() {
  return [
    {
      id: 'abort-merge',
      label: '撤销这次合并（回到拉取之前）',
      detail: '你已提交的内容一点不动；冲突文件里那些还没提交的临时改动（包括你已经改了一部分的解决结果）会没有。',
      op: 'abortMerge',
      params: {},
      confirm: '确定撤销这次合并吗？\n\n'
        + '· 仓库回到「拉取之前」的样子\n'
        + '· 你自己已经提交的内容不受影响\n'
        + '· 冲突文件里还没提交的临时改动（含你已经解决了一部分的结果）会丢失，'
        + '需要重新拉取、重新处理',
    },
  ]
}

/**
 * 执行「撤销这次合并」（见 mergeAbortChoice）。
 *
 * 先确认真的有一次合并在进行（MERGE_HEAD 存在），否则 `git merge --abort` 只会回一句
 * 英文报错 —— 用户看到的是"我点了撤销，它却报错"，而真相是"本来就没有需要撤销的东西"。
 */
async function abortMerge(dir, timeoutMs = 120000) {
  const mergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir, { timeoutMs: 20000 })
  if (mergeHead.code !== 0) {
    return opResponse({
      ok: false,
      message: '现在没有正在进行的合并，不需要撤销（上一次可能已经撤销掉或提交完成了）。点「刷新」看看当前状态。',
    })
  }

  const branch = await currentBranchName(dir, 20000)
  const argv = ['merge', '--abort']
  const result = await runGit(argv, dir, { timeoutMs })
  const ok = result.code === 0
  return opResponse({
    ok: ok,
    command: 'git ' + argv.join(' '),
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    message: ok ? null : (firstLine(result.stderr) || 'git 退出码 ' + result.code),
    notes: ok
      ? ['已撤销这次合并：' + (branch.length > 0 ? '分支 ' + branch + ' ' : '')
        + '回到拉取之前的样子，你已提交的内容没有受影响']
      : [],
  })
}

/**
 * 执行面板上那两条路之一（见 unrelatedChoices）。
 *
 * 为什么单独成一个操作、不走 buildOpArgv：它不是一个「参数 → argv」的纯函数，
 * 而是一段有前置检查、有不可逆后果的动作（看远程、看当前分支、看远端引用在不在、
 * 看工作区干不干净），塞进纯函数里既读不懂也守不住。
 *
 * @param body.mode - 'branch'（安全）| 'reset'（覆盖当前分支）。
 * @param body.name - mode=branch 时可指定新分支名，缺省用 `<远程>-<分支>`。
 * @param body.remote / body.branch - 要拿的是**哪个**远端分支。面板「管理」里点
 *   远端分支时用它（用户点的是 origin/main，不能被当成「当前分支叫 main」）；
 *   缺省仍按当前分支推导 —— 「两套历史互不相关」的两个按钮走这条缺省路。
 * @returns 与 /git-panel/op 其余分支同形的响应（不含 state，由调用方补）。
 */
async function adoptRemote(body, dir, timeoutMs = 120000) {
  const input = body !== null && typeof body === 'object' ? body : {}
  const mode = typeof input.mode === 'string' ? input.mode : ''
  if (mode !== 'branch' && mode !== 'reset') {
    return opResponse({ ok: false, message: '未知的操作方式：' + (mode.length > 0 ? mode : '(空)') })
  }

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: 20000 })).stdout)
  if (remotes.length === 0) {
    return opResponse({ ok: false, message: '这个仓库还没有配置远程地址：先在「远程」里填地址并保存。' })
  }

  const askedRemote = typeof input.remote === 'string' ? input.remote.trim() : ''
  const askedBranch = typeof input.branch === 'string' ? input.branch.trim() : ''
  let remote
  if (askedRemote.length > 0) {
    if (!remotes.some((item) => item.name === askedRemote)) {
      return opResponse({ ok: false, message: '这个仓库没有远程 ' + askedRemote + '：先在「远程」里配置。' })
    }
    remote = askedRemote
  } else {
    remote = remotes.some((item) => item.name === 'origin') ? 'origin' : remotes[0].name
  }

  let branch = askedBranch
  if (branch.length === 0) {
    branch = await currentBranchName(dir, 20000)
    if (branch.length === 0) {
      return opResponse({ ok: false, message: '当前不在任何分支上（游离 HEAD）：先切到一个分支再操作。' })
    }
  }
  // 远端分支名同样要校验：它会作为参数交给 git switch / reset。
  if (!isSafeRemoteRef(remote + '/' + branch)) {
    return opResponse({ ok: false, message: '远端分支名不合法：' + remote + '/' + branch })
  }

  const remoteRef = remote + '/' + branch
  const known = await runGit(['rev-parse', '--verify', '--quiet', remoteRef], dir, { timeoutMs: 20000 })
  if (known.code !== 0) {
    return opResponse({
      ok: false,
      message: '本地还没有 ' + remoteRef + '：先点「获取远程」把它下载下来，再做这个选择。',
    })
  }

  if (mode === 'branch') {
    const wanted = typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim()
      : localBranchNameFor(remoteRef)
    // 同名分支可能已经存在（用户点过两次）：顺延后缀，而不是直接报错。
    let target = wanted
    for (let index = 2; index <= 9; index += 1) {
      const taken = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + target], dir, { timeoutMs: 20000 })
      if (taken.code !== 0) break
      target = wanted + '-' + index
    }
    const occupied = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + target], dir, { timeoutMs: 20000 })
    if (occupied.code === 0) {
      return opResponse({
        ok: false,
        message: '分支 ' + wanted + ' 及其后缀都已被占用：先在「管理」里删掉，或换个名字。',
      })
    }

    const argv = ['switch', '-c', target, remoteRef]
    const result = await runGit(argv, dir, { timeoutMs })
    const ok = result.code === 0
    return opResponse({
      ok: ok,
      command: 'git ' + argv.join(' '),
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      message: ok ? null : (firstLine(result.stderr) || 'git 退出码 ' + result.code),
      notes: ok
        ? ['已新建分支 ' + target + '（内容 = ' + remoteRef + '），你现在就在这个分支上；原来的 '
          + branch + ' 一点没动，随时可以切回去']
        : [],
    })
  }

  // mode === 'reset'：会覆盖工作区，先做前置检查（未跟踪文件不受影响，所以只拦已跟踪的改动）。
  const status = await runGit(['status', '--porcelain'], dir, { timeoutMs: 20000 })
  const trackedChanges = status.stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('??'))
  if (trackedChanges.length > 0) {
    return opResponse({
      ok: false,
      message: '工作区还有 ' + trackedChanges.length + ' 处未提交的改动：先「全部暂存」并提交（或丢弃），'
        + '再执行覆盖 —— 否则这些改动会被直接抹掉。',
    })
  }

  const before = await runGit(['rev-parse', 'HEAD'], dir, { timeoutMs: 20000 })
  const argv = ['reset', '--hard', remoteRef]
  const result = await runGit(argv, dir, { timeoutMs })
  const ok = result.code === 0
  const oldHead = before.code === 0 ? before.stdout.trim() : ''
  return opResponse({
    ok: ok,
    command: 'git ' + argv.join(' '),
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    message: ok ? null : (firstLine(result.stderr) || 'git 退出码 ' + result.code),
    notes: ok && oldHead.length > 0
      ? ['当前分支 ' + branch + ' 现在等于 ' + remoteRef + '；被替换掉的提交是 ' + oldHead
        + '，需要找回时执行 git reset --hard ' + oldHead + '（或 git reflog）']
      : [],
  })
}

// ── 帮助文档 ──────────────────────────────────────────────────────────────
//
// 说明：帮助内容做成**独立 HTML 文档**由宿主直接提供（GET /git-panel/help），
// 面板上的「?」在新标签页打开它。相比在浮层里画窗口，文档页面是浏览器原生
// 滚动/查找/打印/收藏，没有 overlay 层级与 flex 收缩那一堆坑。
// 内容在这里是唯一来源，将来也可以给模型工具复用。

/** HTML 转义：内容目前由本插件提供，但生成器一律按数据转义，改内容时不会漏。 */
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 面板操作方式：文档开头（面向不熟 git 的用户）。 */
const HELP_HOWTO = [
  '第一次连远端：在「远程」里填仓库地址并保存 —— 这只是记下仓库在哪；点一次「推送」才会把本地分支和远端分支对应起来（面板自动做，不用记命令）。',
  '「仓库地址」和「上游」不是一回事：地址回答"仓库在哪"，上游回答"本地分支对应远端哪个分支"。没有上游时直接点「拉取」也行，面板会自动按「远程 + 当前分支」拉取并顺手登记上游。',
  '查更新：点「获取远程」→ 看分支行「落后 N」，N>0 就是有更新；确认后再点「拉取」合并。',
  '提交：点「全部暂存」→ 在提交框写说明 → 回车。推送失败后面板会提示下一步点哪里。',
  '看改动：改动清单里点任意条目，直接展开这个文件的 diff；再点一次收起。',
  '切分支：分支行点「管理」→ 点分支名切换；输入新名字可新建并切换。',
  '看远端分支：先点「获取远程」，再展开「管理」—— 下面会列出 origin/main 这些远端分支，'
    + '点「拿成新分支」就把远端那一份取成本地新分支（当前分支一点不动），点「比较」看差几个提交。',
  '本地分支名和远端不一样（例如本地是 master、远端默认分支叫 main）：直接点「拉取」会报「远端没有这个分支」。'
    + '这不是让你去推送一个 master 出来 —— 先在「管理」里看远端有哪些分支，把需要的那份「拿成新分支」，或按下面那一节处理两套无关历史。',
  '救场：改动没弄完要切分支？先「全部暂存」或先提交，再切，就不会丢。',
  '拉取撞上冲突：面板不替你决定要哪边。改好冲突文件 → git add → git commit 收尾；不想合了就点面板上的「撤销这次合并」（等价于 git merge --abort，安全，不动你已有的提交）。下面有专门一节。',
  '连不上：报错里有 Connection was reset / timed out 时，点面板右上角的 🌐 打开「网络加速」——公开仓库用镜像，私有仓库或要推送就填本机代理。',
]

/** 常用命令分组：每条命令在文档里点一下即复制。 */
const HELP_SECTIONS = [
  {
    title: '👀 查看状态与更新',
    cmds: [
      { cmd: 'git status -sb', desc: '看当前分支、改动和领先/落后几个提交' },
      { cmd: 'git fetch', desc: '下载远程更新信息（不会改动你的代码）' },
      { cmd: 'git log HEAD..origin/main --oneline', desc: '看远程 origin/main 上你还没有的提交明细' },
    ],
  },
  {
    title: '✍️ 提交与推送',
    cmds: [
      { cmd: 'git add -A', desc: '暂存所有改动' },
      { cmd: 'git commit -m "提交说明"', desc: '创建一次提交，引号里换成你的话' },
      { cmd: 'git push', desc: '把本地提交推到远程' },
      { cmd: 'git push -u origin main', desc: '新分支第一次推送，顺便建立上游跟踪' },
    ],
  },
  {
    title: '🌿 分支',
    cmds: [
      { cmd: 'git branch -a', desc: '列出所有本地和远程分支' },
      { cmd: 'git switch 分支名', desc: '切换到已有分支' },
      { cmd: 'git switch -c 新分支名', desc: '新建分支并切换过去' },
      { cmd: 'git branch -d 分支名', desc: '安全删除分支（未合并的分支会被拒绝）' },
      { cmd: 'git merge 分支名', desc: '把某个分支合并到当前分支' },
    ],
  },
  {
    title: '📦 救场 stash（临时收起改动）',
    cmds: [
      { cmd: 'git stash', desc: '把当前改动收起来，工作区瞬间变干净' },
      { cmd: 'git stash pop', desc: '恢复最近收起的那次改动' },
      { cmd: 'git stash list', desc: '看看收起了几份' },
    ],
  },
  {
    title: '⌛ 撤销（小心）',
    cmds: [
      { cmd: 'git reset', desc: '撤销「暂存」，工作区改动保留' },
      { cmd: 'git restore 文件路径', desc: '只丢弃某个文件的改动' },
      { cmd: 'git checkout -- .', desc: '丢弃所有未提交改动！不可恢复，慎用' },
    ],
  },
  {
    title: '⚔️ 拉取撞上冲突怎么办',
    cmds: [
      { cmd: 'git status', desc: '看哪些文件冲突了（会列在 "Unmerged paths" 下面）' },
      { cmd: 'git checkout --ours 文件路径', desc: '这个文件保留「我这边」的版本（拉取方是 --theirs）' },
      { cmd: 'git add 文件路径', desc: '冲突解决完，把文件标记为已解决' },
      { cmd: 'git commit', desc: '收尾这次合并（git 已经写好了提交信息，直接保存即可）' },
      { cmd: 'git merge --abort', desc: '不想合了：撤销这次合并，回到拉取之前的样子（安全，不动已有提交）' },
    ],
  },
  {
    title: '🧭 本地和远端是两套无关历史 / 分支名对不上',
    cmds: [
      { cmd: 'git branch -r', desc: '看远端有哪些分支（远端默认分支标在 origin/HEAD 上）' },
      { cmd: 'git fetch origin', desc: '先把远端分支信息下载下来，上面那条才有东西可看' },
      { cmd: 'git switch -c main origin/main', desc: '把远端那份拿成本地新分支，当前分支一点不动' },
      { cmd: 'git rev-list --left-right --count HEAD...origin/main', desc: '看本地和远端各差几个提交（左=本地多，右=远端多）' },
      { cmd: 'git pull origin main --allow-unrelated-histories', desc: '确认要把两套无关历史合成一条时才用（会创建一次合并提交）' },
      { cmd: 'git branch -m master main', desc: '把本地分支改名成和远端一致，之后裸 pull / push 都能直接用' },
    ],
  },
  {
    title: '🏷️ 标签与历史',
    cmds: [
      { cmd: 'git log --oneline -10', desc: '看最近 10 条提交' },
      { cmd: 'git diff', desc: '看工作区改动的具体内容' },
      { cmd: 'git diff --staged', desc: '看已经暂存、即将提交的内容' },
      { cmd: 'git tag -a v1.0 -m "版本说明"', desc: '给当前提交打一个标签' },
      { cmd: 'git push origin v1.0', desc: '把标签推到远程' },
    ],
  },
  {
    title: '🔌 远程仓库',
    cmds: [
      { cmd: 'git remote -v', desc: '查看配置了哪些远程地址' },
      { cmd: 'git branch -vv', desc: '看每个本地分支「对应远端的哪个分支」（方括号里就是上游）' },
      { cmd: 'git branch --set-upstream-to=origin/main', desc: '把当前分支的上游设为 origin/main，之后 pull / push 不用再带参数' },
      { cmd: 'git pull origin main', desc: '还没有上游时也能拉一次（面板的「拉取」会自动这样做）' },
      { cmd: 'git remote set-url origin 新地址', desc: '改远程地址（比如从 HTTPS 换成 SSH）' },
      { cmd: 'git clone 仓库地址', desc: '克隆远程仓库到当前目录' },
    ],
  },
  {
    title: '🌐 连不上 GitHub？（报错：Connection was reset / timed out）',
    cmds: [
      {
        cmd: 'git -c url."https://gh-proxy.com/https://github.com/".insteadOf="https://github.com/" fetch --all',
        desc: '临时走镜像获取更新 —— 只影响这一条命令，不改任何配置，克隆下来的 origin 也还是原地址',
      },
      {
        cmd: 'git config --global http.proxy http://127.0.0.1:7890',
        desc: '给所有 git 命令设本机代理（Clash / V2Ray 等），推送和私有仓库也能走',
      },
      { cmd: 'git config --global --unset http.proxy', desc: '不需要代理了，取消这个设置' },
      { cmd: 'git config --global --get http.proxy', desc: '看看当前设了代理没有' },
    ],
  },
]

/** 文档样式：跟随系统深浅色，命令行点一下复制。 */
const HELP_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 30px 18px 64px;
    font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #1a1a1a;
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 23px; margin: 0 0 8px; }
  .lead { margin: 0 0 18px; color: #55606e; }
  .lead strong { color: #1a1a1a; }
  nav.toc { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 22px; }
  nav.toc a {
    padding: 4px 11px; border-radius: 999px; text-decoration: none; font-size: 13px;
    background: #ffffff; border: 1px solid #dfe3e8; color: #334155;
  }
  nav.toc a:hover { border-color: #2563eb; color: #2563eb; }
  section {
    background: #ffffff; border: 1px solid #e6e9ee; border-radius: 12px;
    padding: 14px 16px; margin-bottom: 14px;
  }
  h2 { font-size: 15px; margin: 0 0 10px; }
  ul.howto { margin: 0; padding-left: 20px; }
  ul.howto li { margin-bottom: 6px; }
  .row { padding: 9px 0; border-top: 1px dashed #eceff3; }
  .row:first-of-type { border-top: 0; }
  .desc { color: #55606e; font-size: 13px; margin-bottom: 4px; }
  button.cmd {
    display: block; width: 100%; text-align: left; cursor: pointer;
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 8px 11px; border-radius: 8px; word-break: break-all;
    background: #f4f6f8; border: 1px solid #e2e6ea; color: #0f172a;
  }
  button.cmd:hover { border-color: #2563eb; background: #eef4ff; }
  button.cmd.copied { border-color: #16a34a; color: #15803d; background: #f0fdf4; }
  footer { margin-top: 22px; color: #7b8794; font-size: 12.5px; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e6e8eb; }
    .lead, .desc { color: #9aa4b2; }
    .lead strong { color: #e6e8eb; }
    nav.toc a, section { background: #1e2127; border-color: #2b3038; color: #cbd5e1; }
    button.cmd { background: #23272e; border-color: #333a44; color: #e6e8eb; }
    button.cmd:hover { border-color: #60a5fa; background: #1d2735; }
    button.cmd.copied { border-color: #22c55e; color: #4ade80; background: #17251c; }
    .row { border-top-color: #2b3038; }
  }
`

/** 文档脚本：点命令复制（Clipboard API，失败退回 execCommand，再失败弹出手动复制）。 */
const HELP_JS = `
  document.querySelectorAll('button.cmd').forEach(function (button) {
    button.addEventListener('click', function () {
      var text = button.getAttribute('data-cmd') || button.textContent || '';
      var original = button.textContent;
      var done = function (ok) {
        if (!ok) { window.prompt('复制失败，请手动复制这行命令：', text); return; }
        button.textContent = '✓ 已复制：' + text;
        button.classList.add('copied');
        window.setTimeout(function () {
          button.textContent = original;
          button.classList.remove('copied');
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        return;
      }
      try {
        var area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        done(ok);
      } catch (error) {
        done(false);
      }
    });
  });
`

/** 生成完整的帮助 HTML 文档（零外部依赖：可直接打开、收藏、打印）。 */
function renderHelpHtml() {
  const toc = HELP_SECTIONS
    .map((section, index) => '<a href="#s' + String(index) + '">' + escapeHtml(section.title) + '</a>')
    .join('')

  const sections = HELP_SECTIONS.map((section, index) => {
    const rows = section.cmds.map((item) => [
      '<div class="row">',
      '<div class="desc">' + escapeHtml(item.desc) + '</div>',
      '<button class="cmd" type="button" data-cmd="' + escapeHtml(item.cmd) + '">'
        + escapeHtml(item.cmd) + '</button>',
      '</div>',
    ].join('')).join('')
    return [
      '<section id="s' + String(index) + '">',
      '<h2>' + escapeHtml(section.title) + '</h2>',
      rows,
      '</section>',
    ].join('')
  }).join('')

  const howto = HELP_HOWTO.map((text) => '<li>' + escapeHtml(text) + '</li>').join('')

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Git 帮助 · dsh-git-panel</title>',
    '<style>' + HELP_CSS + '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '<header>',
    '<h1>Git 帮助</h1>',
    '<p class="lead">面板怎么用 + 常用命令小抄。<strong>点任意命令即可复制</strong>，'
      + '粘到终端就能跑；命令里需要替换的地方（「提交说明」「分支名」等）换成你自己的即可。</p>',
    '</header>',
    '<nav class="toc">' + toc + '</nav>',
    '<section id="howto">',
    '<h2>🧭 面板操作方式</h2>',
    '<ul class="howto">' + howto + '</ul>',
    '</section>',
    sections,
    '<footer>由 dsh-git-panel 提供 · 面板上的「?」就是打开本页 · 可以收藏，边看边敲</footer>',
    '</div>',
    '<script>' + HELP_JS + '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

// ── HTTP 路由 ─────────────────────────────────────────────────────────────

/**
 * 构造面板使用的 HTTP 路由：状态 / 操作 / 诊断 / 帮助文档。
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
      const startedAt = Date.now()
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

        // 面板上那几种「需要用户做个决定」的按钮：这是一段多步、带前置检查、
        // 可能不可逆的动作，不是一条 git 命令，所以不走 buildOpArgv 的纯函数。
        if (op === 'adoptRemote') {
          const adopted = await adoptRemote(body, dir)
          sendJson(response, 200, { ...adopted, state: await readState(dir) })
          await appendLog(adopted.ok === true ? 'info' : 'warn', 'op', {
            op,
            dir,
            ok: adopted.ok === true,
            ms: Date.now() - startedAt,
            message: adopted.message ?? adopted.hint ?? null,
          })
          return
        }
        if (op === 'abortMerge') {
          const aborted = await abortMerge(dir)
          sendJson(response, 200, { ...aborted, state: await readState(dir) })
          await appendLog(aborted.ok === true ? 'info' : 'warn', 'op', {
            op,
            dir,
            ok: aborted.ok === true,
            ms: Date.now() - startedAt,
            message: aborted.message ?? aborted.hint ?? null,
          })
          return
        }

        let argv
        try {
          argv = await buildOpArgv(op, body)
        } catch (error) {
          // 响应形状要和下面的成功分支保持一致：面板读 network / notes / accelerated
          // 来判断「是不是网络问题、要不要展开加速设置」，缺字段会让它读到 undefined。
          sendJson(response, 200, {
            ok: false,
            message: message(error),
            hint: null,
            accelerated: 'direct',
            network: false,
            notes: [],
            state: await readState(dir),
          })
          await appendLog('warn', 'op', { op, dir, ok: false, ms: Date.now() - startedAt, error: message(error) })
          return
        }

        const slow = NETWORK_OPS.has(op)
        const timeoutMs = slow ? 600000 : 120000

        // 网络加速：参数插在 `git` 与子命令之间，只影响这一次调用。
        const netConfig = await readNetConfig()
        const accel = networkExtraArgs(op, netConfig)
        const notes = []
        if (accel.mode.includes('proxy')) {
          // 措辞要是**事实**而不是结论：这条命令确实会走代理，但它成不成功还不知道
          // （下面才拿到退出码）。这里写成「已通过代理加速」会在一失败就变成谎话。
          notes.push('本次命令走代理 ' + maskProxy(netConfig.proxy) + '（只作用于本次命令）')
        }
        // 镜像用于只读操作。克隆大仓库要给足预算；fetch/pull 通常很快，配合
        // http.lowSpeedTime 把上限压短，卡住时能尽快回退，而不是干等 10 分钟。
        const mirrorTimeoutMs = op === 'clone' ? timeoutMs : Math.min(timeoutMs, 120000)
        // attemptArgs 始终与 fullArgv 配套：回退之后传给 recoverPush 的必须是**这次
        // 真正用的那套参数**，否则重试会带着上一次尝试的参数跑出去。
        let attemptArgs = accel.args
        let fullArgv = [...attemptArgs, ...argv]
        let result = await runGit(fullArgv, dir, { timeoutMs: accel.mirror ? mirrorTimeoutMs : timeoutMs })

        // 镜像不是官方线路，随时可能失效。**开了加速反而连不上**是最糟的体验，所以
        // 镜像一旦因为线路问题失败就自动回退直连（代理参数保留 —— 那是用户自己的线路，
        // 没理由绕开）。
        //
        // 但「命令失败」不等于「镜像的错」：没有上游、没有远程、无关历史这类**本地**
        // 错误同样会让命令失败。早先这里一律回退并写下「镜像没走通」，用户于是被引去
        // 折腾网络加速 —— 必须先把失败类型分清楚（见 mirrorFallbackWorthwhile）。
        if (accel.mirror === true) {
          if (result.code === 0) {
            notes.push('已通过镜像 ' + mirrorLabel(netConfig.mirror) + ' 加速（只作用于本次命令，不改你的 git 配置）')
          } else if (mirrorFallbackWorthwhile(result.stderr)) {
            const plain = networkExtraArgs(op, netConfig, { noMirror: true })
            attemptArgs = plain.args
            fullArgv = [...attemptArgs, ...argv]
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

        // 推送与拉取各有各的补救：push 缺上游补 -u，pull 缺上游改用「远程 + 分支」。
        const recovery = op === 'pull'
          ? await recoverPull(op, fullArgv, result, dir, timeoutMs, attemptArgs)
          : await recoverPush(op, body, fullArgv, result, dir, timeoutMs, attemptArgs)
        if (typeof recovery.note === 'string' && recovery.note.length > 0) notes.push(recovery.note)

        // 克隆成功后告诉面板新仓库落在哪，让面板可以自动切进去（git clone 的默认
        // 目标名与 git 一致：地址最后一段去掉 .git）。
        let clonedDir = null
        if (op === 'clone' && recovery.result.code === 0) {
          const target = normalizeDir(body.target)
          clonedDir = target !== undefined ? join(dir, target) : join(dir, cloneTargetName(body.url))
        }

        // 数据型操作的结果：branches / remoteBranches / compare 解析成结构化数据，
        // diff 截断到面板能接受的长度。（stdout 原样也会回传，仅供调试；面板渲染用这里的字段。）
        let branchesData = null
        let remoteBranchesData = null
        let compareData = null
        let diffData = null
        if (op === 'branches' && recovery.result.code === 0) {
          branchesData = parseBranchOutput(recovery.result.stdout)
        }
        if (op === 'remoteBranches' && recovery.result.code === 0) {
          remoteBranchesData = parseRemoteBranchOutput(recovery.result.stdout)
        }
        if (op === 'compare' && recovery.result.code === 0) {
          const comparedRef = typeof body.ref === 'string' ? body.ref.trim() : ''
          compareData = parseCompareOutput(recovery.result.stdout, comparedRef)
          // 原始输出是两列数字（`0	3`），直接甩到结果栏没人看得懂；这里翻成人话。
          notes.push(compareData.ahead === 0 && compareData.behind === 0
            ? '本地和 ' + compareData.ref + ' 完全一致：没有多出来的、也没有还没拉下来的提交'
            : '相对 ' + compareData.ref + '：本地领先 ' + compareData.ahead + ' 个提交、落后 '
              + compareData.behind + ' 个提交'
              + (compareData.behind > 0 ? '（落后的就是远端有、你还没有的）' : ''))
        }
        if (op === 'diff' && recovery.result.code === 0) {
          diffData = truncateText(recovery.result.stdout, 40000)
        }

        // 失败原因分流：网络不通要给出「去开加速」的提示，其余交给各自的提示表。
        // 顺序不能反 —— classifyPushFailure 对网络类报错返回 none，先问它会得到空提示。
        // 拉取与推送的提示表必须分开：「没有跟踪信息」是最常见的拉取卡点，落回
        // pushHint 只会得到 null，用户就又只剩英文原文了。
        const failure = recovery.result.code === 0 ? null : recovery.result
        const networkFailure = failure === null ? null : classifyNetworkFailure(failure.stderr)
        const hint = failure === null
          ? null
          : (networkFailure !== null
              ? networkHint(accel.mode !== 'direct')
              : (op === 'pull' ? pullHint(recovery.reason) : pushHint(recovery.reason)))

        // 拉取失败里有两类「需要用户做个决定」，各给一组按钮：
        //   - 无关历史：要远端那份、还是要本地这份（unrelatedChoices）；
        //   - 冲突 / 合并没收尾：退路「撤销这次合并」（mergeAbortChoice）。
        // 注意「解决冲突」本身**不做按钮** —— 那要用户对每个文件判断留哪边，面板不能替他选；
        // 而"我不想合了"不需要判断，所以只给退路。
        let choices = null
        if (op === 'pull' && recovery.reason === 'unrelated'
          && typeof recovery.remote === 'string' && typeof recovery.branch === 'string') {
          choices = unrelatedChoices(recovery.remote, recovery.branch)
        } else if (op === 'pull' && (recovery.reason === 'conflict' || recovery.reason === 'merge-unfinished')) {
          choices = mergeAbortChoice()
        }

        const payload = {
          ok: recovery.result.code === 0,
          command: 'git ' + displayArgv(recovery.argv).join(' '),
          exitCode: recovery.result.code,
          stdout: recovery.result.stdout,
          stderr: recovery.result.stderr,
          // recovery.message 是补救过程自己写的中文结论（例如「远端没有 master，
          // 默认分支是 origin/main，两边互不相关」）——它比 git 的英文原文更接近
          // 用户需要知道的事，所以优先于 result 里的原文。
          message: recovery.result.code === 0
            ? null
            : (typeof recovery.message === 'string' && recovery.message.length > 0
                ? recovery.message
                : (gitMissingMessage(recovery.result) ?? (recovery.result.stderr.trim() || 'git 退出码 ' + recovery.result.code))),
          reason: recovery.reason,
          hint,
          retried: recovery.retried,
          // 本次实际用了哪条线路，以及给面板看的说明（面板把它们回显在结果栏里，
          // 用户因此能看到「这条命令刚才走了镜像」而不是被蒙在鼓里）。
          accelerated: accel.mode,
          network: networkFailure !== null,
          notes,
          clonedDir,
          branches: branchesData,
          remoteBranches: remoteBranchesData,
          compare: compareData,
          diff: diffData,
          choices,
          state: await readState(dir),
        }
        // 每次面板操作都留痕（含失败原因与补救动作）——「维护优化」的第一步是知道
        // 用户点过什么、得到了什么。argv 打码后才落盘。
        await appendLog(payload.ok === true ? 'info' : 'warn', 'op', {
          op,
          dir,
          argv: displayArgv(recovery.argv ?? fullArgv),
          exit: recovery.result.code,
          ms: Date.now() - startedAt,
          retried: recovery.retried === true,
          accelerated: accel.mode,
          network: networkFailure !== null,
          reason: recovery.reason,
          message: payload.ok === true ? null : (firstLine(String(payload.message ?? '')) || 'git 退出码 ' + recovery.result.code),
        })
        sendJson(response, 200, payload)
      } catch (error) {
        await appendLog('error', 'op', { op: null, error: message(error) })
        sendJson(response, 400, { ok: false, message: message(error), state: null })
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
        const url = new URL(typeof request.url === 'string' ? request.url : '/', 'http://localhost')

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

        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { ok: false, message: '拒绝执行：请求来源不可信' })
          return
        }

        const body = await readJsonBody(request)
        const patch = {}
        if (typeof body.mirrorEnabled === 'boolean') patch.mirrorEnabled = body.mirrorEnabled
        if (typeof body.mirror === 'string') patch.mirror = body.mirror
        // 回传的是打码后的代理地址（面板拿到的就是那样），原样存回去会把真凭据覆盖成
        // `***@`。见到打码串一律理解为「不变」。清空代理请传空串。
        if (typeof body.proxy === 'string' && !body.proxy.includes(MASK_TOKEN)) patch.proxy = body.proxy

        const saved = await writeNetConfig(patch)
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
        sendJson(response, 200, { ok: false, message: message(error) })
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
        await appendLog('info', 'diag', {
          stage: typeof body.stage === 'string' ? body.stage : 'unknown',
          detail: body.detail === undefined || body.detail === null ? null : String(body.detail),
        })
        sendJson(response, 200, { ok: true })
      } catch (error) {
        sendJson(response, 200, { ok: false, message: message(error) })
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
        const url = new URL(typeof request.url === 'string' ? request.url : '/', 'http://localhost')
        const parsed = Number.parseInt(url.searchParams.get('lines') ?? '', 10)
        const lines = await readLogTail(Number.isFinite(parsed) && parsed > 0 ? parsed : 200)
        sendJson(response, 200, { ok: true, lines })
      } catch (error) {
        sendJson(response, 200, { ok: false, message: message(error) })
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
    toArgv: async (args, helpers) => {
      const action = args.action === 'add' || args.action === 'set' || args.action === 'remove' ? args.action : 'list'
      const named = typeof args.name === 'string' && args.name.length > 0
      const remote = named ? args.name : 'origin'
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (action === 'add') {
        if (!named || url.length === 0) throw new Error('git_remote: add 需要提供 name 和 url')
        return ['remote', 'add', remote, url]
      }
      if (action === 'set') {
        // 「配置推送目标」的语义：与面板一致 —— 同名远程已存在则改地址，否则新增。
        // 否则 origin 已存在时 remote add 会直接报错（fatal: remote origin already exists）。
        if (url.length === 0) throw new Error('git_remote: set 需要提供 url')
        const listed = await runGit(['remote'], helpers !== undefined && helpers !== null ? helpers.dir : undefined, { timeoutMs: 20000 })
        return remoteOpFor(remote, url, listed.stdout)
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
          const toolStartedAt = Date.now()
          let argv
          try {
            // toArgv 可以是同步纯函数，也可以是 async（git_remote set 需要查远程列表）。
            argv = await spec.toArgv(input, { dir })
          } catch (error) {
            const detail = message(error)
            await appendLog('warn', 'tool', { tool: spec.name, dir, ok: false, ms: Date.now() - toolStartedAt, error: detail })
            return detail
          }
          const signal = exec !== undefined && exec !== null ? exec.signal : undefined
          // 模型工具走同一套加速：AI 在会话里执行 git_pull / git_fetch 时，联网的
          // 还是这台机器，没理由只有「面板上点的那条命令」能加速。非网络操作拿到空参数。
          const accel = networkExtraArgs(argv[0], await readNetConfig())
          const fullArgv = [...accel.args, ...argv]
          const result = await runGit(fullArgv, dir, {
            timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined,
            signal,
          })
          // 工具调用留痕：AI 在会话里执行了什么、结果如何，是 `git_* 工具失灵/误操作`
          // 类问题的主要排查入口（argv 打码后才落盘）。
          await appendLog(result.code === 0 ? 'info' : 'warn', 'tool', {
            tool: spec.name,
            dir,
            argv: displayArgv(fullArgv),
            exit: result.code,
            ms: Date.now() - toolStartedAt,
            error: result.code === 0 ? undefined : firstLine(result.stderr),
          })
          // 命令回显要打码：工具输出会进会话记录，代理凭据不能留在里面。
          return formatGitResult(displayArgv(fullArgv), result)
        },
      }))
    } catch (error) {
      const detail = message(error)
      console.error('[git-panel] 注册工具 ' + spec.name + ' 失败：' + detail)
      appendLog('error', 'tool-register', { tool: spec.name, error: detail })
    }
  }
  return disposers
}

// ── cordis apply ──────────────────────────────────────────────────────────

/**
 * 插件入口：挂载面板 HTTP 路由并注册 git 模型工具。
 * @param ctx - cordis 上下文。
 * @param config - 行配置（defaultDir：面板缺省执行目录）。
 *
 * 网络加速（镜像 / 代理）**不在这里配置**，而是落在 $DSH_HOME/git-panel-net.json，
 * 由面板的 🌐 按钮读写 —— 那个设置要能在换机器后随时改，不该逼用户去编辑 yml 再重启。
 */
export function apply(ctx, config = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const configured = normalizeDir(cfg.defaultDir)
  const getDefaultDir = () => configured ?? process.cwd()
  // 插件级配置可覆盖日志行为（logLevel / logMaxBytes / logFile）；默认 info + $DSH_HOME。
  setLogConfig({ level: cfg.logLevel, maxBytes: cfg.logMaxBytes, file: cfg.logFile })
  const startedAt = Date.now()
  appendLog('info', 'lifecycle', { msg: 'apply', defaultDir: configured ?? process.cwd(), logFile: logFilePath() })

  const disposers = []

  /** webServer 是惰性服务：拿到实例后挂上全部路由（state / op / net / diag / log / help）。 */
  const mount = (server) => {
    if (server === undefined || server === null) return
    for (const route of createRoutes(getDefaultDir)) {
      try {
        disposers.push(server.register(route))
      } catch (error) {
        const detail = message(error)
        console.error('[git-panel] 注册路由 ' + route.path + ' 失败：' + detail)
        appendLog('error', 'route-register', { path: route.path, error: detail })
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
    const detail = '未找到 tools 服务：git 模型工具未注册（面板不受影响）'
    console.error('[git-panel] ' + detail)
    appendLog('error', 'lifecycle', { msg: 'tools-missing', detail })
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
      appendLog('info', 'lifecycle', { msg: 'disposed' })
    })
  }

  console.log('[git-panel] 就绪：面板路由 /git-panel/* + ' + TOOL_SPECS.length + ' 个 git 工具')
  appendLog('info', 'lifecycle', { msg: 'ready', routes: 6, tools: TOOL_SPECS.length })
}

// 供单元测试导入的内部纯函数（对运行时无影响）。
// 网络加速那几个也一并导出：配置归一化、参数注入、失败分类都不触网，适合直接断言；
// readNetConfig / writeNetConfig / probeNetwork 则用于配合临时 DSH_HOME 的集成测试。
export {
  parseBranchLine, parseRemotes, classifyPushFailure, pushHint, remoteOpFor, cloneTargetName,
  classifyPullFailure, pullHint, mirrorFallbackWorthwhile, pullFailureText,
  opResponse, localBranchNameFor, unrelatedChoices, mergeAbortChoice,
  normalizeDir, parseBranchOutput, parseRemoteBranchOutput, isSafeRemoteRef, parseCompareOutput,
  pickRemoteDefaultBranch, buildOpArgv, truncateText, renderHelpHtml, escapeHtml,
  normalizeNetConfig, networkExtraArgs, classifyNetworkFailure, networkHint, maskProxy, displayArgv,
  netConfigView, netConfigPath, readNetConfig, writeNetConfig, resetNetConfigCache, probeNetwork,
  probeJobs, mirrorLabel, firstLine, MIRROR_CANDIDATES,
  // 日志模块（测试直接驱动：级别过滤、打码、轮转、尾读）。
  appendLog, readLogTail, logFilePath, setLogConfig, shouldLog,
  normalizeLogLevel, normalizeLogMaxBytes,
}
