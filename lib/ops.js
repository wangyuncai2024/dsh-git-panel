// dsh-git-panel —— 操作注册表（面板与模型工具的唯一事实来源）
// ============================================================================
// 每个 git 操作的 argv 形状只在这里定义一次：面板的 OPS 与模型工具的 toArgv
// 都指向下面这组 argv* 构造器，两条路径不可能再分叉。
//
// 操作元数据（是否联网、超时、结果怎么解析、失败给什么提示）也收在同一张表里，
// 路由因此不再散落 if (op === …) 分支。
// ============================================================================

import {
  GIT_LOCAL_TIMEOUT_MS, currentBranchName, gitMissingMessage, isSafeRemoteRef,
  localBranchNameFor, parseBranchOutput, parseLsRemoteHead, parseRemoteBranchOutput,
  parseCompareOutput, parseRemotes, parseStashList, remoteOpFor, runGit,
} from './git.js'
import { mirrorLabel, networkExtraArgs, readNetConfig } from './net.js'
import {
  classifyCheckoutFailure, classifyCommitFailure, classifyNetworkFailure,
  classifyPullFailure, classifyPushFailure, checkoutHint, commitHint, mirrorFallbackWorthwhile,
  networkHint, pullFailureText, pullHint, pushHint,
} from './failure.js'
import {
  displayArgv, firstLine, hasText, maskProxy, message, normalizeDir, trimmedOrNull, truncateText,
} from './util.js'

// ── 共享 argv 构造器：面板与模型工具的唯一事实来源 ──────────────────────────
//
// 这些函数只回答一件事：「这个操作对应哪几个 git 参数」。校验消息写成中性的
// （不带工具名），工具侧由 toolArgv() 统一加上 `git_xxx: ` 前缀 —— 于是
// 「面板的 switch」与「工具的 checkout」不可能再各写一套。它们**曾经就是两套**，
// 而且行为已经分叉：面板切分支用 git switch（注释里写了为什么），工具用 checkout。

/** git_status */
function argvStatus(input = {}) {
  return input.porcelain === true ? ['status', '--porcelain=v1', '--branch'] : ['status']
}

/** git_add：paths 列表，或 all=true。 */
function argvAdd(input = {}) {
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((item) => typeof item === 'string' && item.length > 0)
    : []
  if (input.all === true) return paths.length > 0 ? ['add', '-A', ...paths] : ['add', '-A']
  if (paths.length === 0) throw new Error('需要提供 paths 或设置 all=true')
  return ['add', '--', ...paths]
}

/** git_commit */
function argvCommit(input = {}) {
  const text = typeof input.message === 'string' ? input.message : ''
  if (text.trim().length === 0) throw new Error('提交信息不能为空')
  const argv = ['commit']
  if (input.all === true) argv.push('-a')
  if (input.amend === true) argv.push('--amend')
  argv.push('-m', text)
  return argv
}

/** git_log */
function argvLog(input = {}) {
  const argv = ['log', '--oneline', '--no-color']
  if (input.graph === true) argv.push('--graph')
  if (input.all === true) argv.push('--all')
  let count = typeof input.count === 'number' ? Math.floor(input.count) : 10
  if (!(count >= 1)) count = 10
  if (count > 200) count = 200
  argv.push('-n', String(count))
  return argv
}

/** git_diff（面板看单个改动的 diff 也走这里） */
function argvDiff(input = {}) {
  const argv = ['diff']
  if (input.cached === true) argv.push('--cached')
  if (input.stat === true) argv.push('--stat')
  const path = trimmedOrNull(input.path)
  if (path !== null) argv.push('--', path)
  return argv
}

/** git_branch：列表（--no-color / -a）、新建（不切换）、删除（-d / -D）。 */
function argvBranch(input = {}) {
  const name = trimmedOrNull(input.name)
  if (name !== null) {
    if (input.delete === true) return ['branch', input.force === true ? '-D' : '-d', name]
    return ['branch', name]
  }
  if (input.delete === true) throw new Error('删除分支需要提供 name')
  return input.all === true ? ['branch', '-a', '--no-color'] : ['branch', '--no-color']
}

/**
 * 切换 / 新建并切换。**一律用 git switch，不用 checkout**：switch 只做分支语义，
 * 不会在「名字既像分支又像路径」时把切换误判成还原文件。
 */
function argvCheckout(input = {}) {
  const branch = trimmedOrNull(input.branch)
  if (branch === null) throw new Error('需要提供分支名')
  return input.create === true ? ['switch', '-c', branch] : ['switch', branch]
}

/** git_pull */
function argvPull(input = {}) {
  const argv = ['pull']
  if (input.rebase === true) argv.push('--rebase')
  const remote = trimmedOrNull(input.remote)
  const branch = trimmedOrNull(input.branch)
  if (remote !== null) argv.push(remote)
  if (branch !== null) argv.push(branch)
  return argv
}

/** git_push：面板的 mode=upstream 与工具的 setUpstream=true 是同一件事。 */
function argvPush(input = {}) {
  const argv = ['push']
  const setUpstream = input.setUpstream === true || input.mode === 'upstream'
  if (setUpstream) argv.push('--set-upstream')
  if (input.force === true) argv.push('--force')
  if (input.mode === 'upstream') {
    argv.push('origin', 'HEAD')
    return argv
  }
  const remote = trimmedOrNull(input.remote)
  const branch = trimmedOrNull(input.branch)
  if (remote !== null) argv.push(remote)
  if (branch !== null) argv.push(branch)
  return argv
}

/** git_clone：面板叫 target、工具叫 dir —— 同一个东西的两个名字，在这里归一。 */
function argvClone(input = {}) {
  const url = trimmedOrNull(input.url)
  if (url === null) throw new Error('需要提供仓库地址')
  const argv = ['clone']
  if (typeof input.depth === 'number' && input.depth >= 1) argv.push('--depth', String(Math.floor(input.depth)))
  argv.push(url)
  const target = trimmedOrNull(input.target) ?? trimmedOrNull(input.dir)
  if (target !== null) argv.push(target)
  return argv
}

/** git_init */
function argvInit(input = {}) {
  const branch = trimmedOrNull(input.branch)
  return branch === null ? ['init'] : ['init', '-b', branch]
}

/**
 * git_remote：list / add / set / remove。
 *
 * set 的语义是「同名远程已存在就改地址，否则新增」，因此**必须先查一次 git remote**；
 * 而查重与真正执行必须在**同一个目录**里。ctx.dir 由调用方（buildOpArgv）归一化后
 * 传入 —— 早先这里读的是原始请求体里的 dir，于是配置了 defaultDir 或传了 `~/…`
 * 时会误判成「远程不存在」，接着 `remote add` 撞上 `fatal: remote origin already exists`。
 */
async function argvRemote(input = {}, ctx = {}) {
  const action = input.action === 'add' || input.action === 'set' || input.action === 'remove'
    ? input.action
    : 'list'
  const named = trimmedOrNull(input.name)
  const remote = named ?? 'origin'
  const url = trimmedOrNull(input.url)
  if (action === 'list') return ['remote', '-v']
  if (action === 'add') {
    if (named === null || url === null) throw new Error('add 需要提供 name 和 url')
    return ['remote', 'add', remote, url]
  }
  if (action === 'set') {
    if (url === null) throw new Error('需要提供仓库地址')
    const listed = await runGit(['remote'], ctx.dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    return remoteOpFor(remote, url, listed.stdout)
  }
  if (named === null) throw new Error('remove 需要提供 name')
  return ['remote', 'remove', remote]
}

/** git_run：任意子命令（子命令名会成为 argv[0]，所以必须先校验形状）。 */
function argvRun(input = {}) {
  const sub = typeof input.subcommand === 'string' ? input.subcommand : ''
  if (!/^[a-z][a-z0-9-]*$/.test(sub)) throw new Error('subcommand 必须是小写字母开头的合法子命令名')
  const rest = Array.isArray(input.args) ? input.args.filter((item) => typeof item === 'string') : []
  return [sub, ...rest]
}

/**
 * 工具侧包装：给共享构造器的中性消息加上工具名前缀，并统一在**这里抛错**。
 *
 * 为什么必须抛：`execute` 抛出的异常会被 harness 标成一次失败的调用；而返回一段
 * 普通文本会被模型读成「命令跑完了」。参数错误（缺 paths、非法子命令）属于前者。
 */
async function toolArgv(toolName, build) {
  try {
    return await build()
  } catch (error) {
    throw new Error(toolName + ': ' + message(error))
  }
}

// ── 面板操作注册表 ────────────────────────────────────────────────────────
//
// 每个面板操作只在这里声明一次：argv 形状、超时、结果怎么解析、失败给什么提示、
// 要不要做补救。路由因此不再散落 if (op === …) 分支，新增操作也只改这一处。
//
// network 标记与 net.js 的 NETWORK_OPS 是**两个不同的索引**（那边按 git 子命令，
// 这里按面板操作名），unit.test.mjs 有一条断言钉住两者一致，防止悄悄分叉。

/** 本地查询 / 普通操作 / 联网操作的三档超时。 */
const LOCAL_OP_TIMEOUT_MS = GIT_LOCAL_TIMEOUT_MS
const OP_TIMEOUT_MS = 120000
const NETWORK_OP_TIMEOUT_MS = 600000

/**
 * 「远端默认分支」兜底查询的超时：一条 ls-remote 只读 HEAD 一个引用，正常几秒内
 * 返回；卡住的网络不值得让「打开分支管理器」干等，超时就当查不到，列表照常显示。
 */
const REMOTE_HEAD_TIMEOUT_MS = 30000

/** diff 回给面板的字符上限（客户端还要逐行着色，太长的 diff 会拖慢渲染）。 */
const DIFF_MAX_CHARS = 40000

/** 取一个必填的字符串参数；缺失时抛出面板可直接展示的中文提示。 */
function requiredText(input, key, errorText) {
  const value = trimmedOrNull(input === null || input === undefined ? undefined : input[key])
  if (value === null) throw new Error(errorText)
  return value
}

/** stash 操作的编号必须长这样：它是会交给 git 当参数的。 */
function stashRef(input) {
  const ref = requiredText(input, 'ref', '请选择要操作的 stash')
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error('stash 编号不合法：' + ref)
  return ref
}

const OPS = {
  init: { argv: () => argvInit({}) },
  addAll: { argv: () => argvAdd({ all: true }) },
  // 单文件暂存 / 取消暂存 / 还原：改动清单每一行的小按钮。
  add: { argv: (input) => argvAdd({ paths: [requiredText(input, 'path', '缺少文件路径')] }) },
  unstageFile: { argv: (input) => ['restore', '--staged', '--', requiredText(input, 'path', '缺少文件路径')] },
  restoreFile: { argv: (input) => ['restore', '--', requiredText(input, 'path', '缺少文件路径')] },
  // 撤销暂存：把暂存区重置回 HEAD，不动工作区（git reset 不支持 --no-color，无需加）。
  unstage: { argv: () => ['reset'] },
  // 丢弃改动：用暂存区内容覆盖工作区（不影响未跟踪文件）。用 git restore 而不是
  // 早已过时的 `checkout --`：帮助文档给用户的就是 restore，两边必须是同一条命令。
  discard: { argv: () => ['restore', '--', '.'] },
  branches: {
    argv: () => argvBranch({}),
    field: 'branches',
    parse: parseBranchOutput,
    local: true,
    // 分支管理器要同时看本地和远端 —— **一次 HTTP 往返拿两份**。原先客户端连发两次
    // op，而每次 op 宿主都要额外回读一次仓库状态（4 条 git）：展开一次就是 10 条进程。
    // 注意远端那份用 `--remotes`（只列远端），不是 `-a`（本地 + 远端）：
    // 面板的远端分组只要远端，混进本地分支会多出一堆点不动的行。
    also: {
      field: 'remoteBranches',
      argv: () => ['branch', '--remotes', '--no-color'],
      parse: parseRemoteBranchOutput,
      // 本地没有 origin/HEAD 指针（旧版 git 的 init+remote、镜像远端）时，
      // 靠 enhance 补查一次远程 HEAD，默认分支照样能标出来。
      enhance: enhanceRemoteBranches,
    },
  },
  remoteBranches: {
    argv: () => ['branch', '--remotes', '--no-color'],
    field: 'remoteBranches',
    parse: parseRemoteBranchOutput,
    local: true,
    enhance: enhanceRemoteBranches,
  },
  compare: {
    argv: (input) => {
      const ref = requiredText(input, 'ref', '请选择一个远端分支再比较')
      if (!isSafeRemoteRef(ref)) throw new Error('远端分支名不合法，请重新选择')
      return ['rev-list', '--left-right', '--count', 'HEAD...' + ref]
    },
    field: 'compare',
    parse: (stdout, input) => parseCompareOutput(stdout, requiredText(input, 'ref', '请选择一个远端分支再比较')),
    local: true,
    // 原始输出只是两列数字（`0\t3`），直接甩到结果栏没人看得懂。
    note: (fields) => compareNote(fields.compare),
  },
  checkout: {
    argv: (input) => argvCheckout({ branch: requiredText(input, 'branch', '请选择要切换的分支') }),
    // 普通切换的失败分类（脏工作区 / 分支不存在）。面板在脏工作区下会优先走
    // 「安全切分支」（stashSwitch），这个分类器服务模型工具与剩余路径。
    classify: (result) => classifyCheckoutFailure(result.stderr),
    hint: checkoutHint,
  },
  createBranch: {
    argv: (input) => argvCheckout({ branch: requiredText(input, 'branch', '请填写新分支名'), create: true }),
  },
  deleteBranch: {
    argv: (input) => argvBranch({ name: requiredText(input, 'branch', '请选择要删除的分支'), delete: true }),
  },
  renameBranch: {
    argv: (input) => {
      const name = requiredText(input, 'name', '请填写新分支名')
      if (!isSafeRemoteRef(name)) throw new Error('分支名不合法：' + name)
      return ['branch', '-m', name]
    },
  },
  diff: {
    argv: (input) => argvDiff({ path: input.path, cached: input.cached }),
    field: 'diff',
    parse: (stdout) => truncateText(stdout, DIFF_MAX_CHARS),
    local: true,
  },
  // 提交详情（最近提交行点开看）：git show --stat + 完整作者信息。
  show: {
    argv: (input) => ['show', '--no-color', '--stat', '--format=fuller', requiredText(input, 'ref', '缺少提交号')],
    field: 'show',
    parse: (stdout) => truncateText(stdout, DIFF_MAX_CHARS),
    local: true,
  },
  commit: { argv: (input) => argvCommit({ message: input.message, amend: input.amend === true }), classify: (result) => classifyCommitFailure(result.stderr), hint: commitHint },
  pull: { argv: (input) => argvPull({ rebase: input.rebase === true }), network: true, recover: recoverPull, hint: pullHint },
  push: { argv: (input) => argvPush({ mode: input.mode }), network: true, recover: recoverPush, hint: pushHint },
  setRemote: { argv: (input, ctx) => argvRemote({ action: 'set', name: input.name, url: input.url }, ctx) },
  // fetch / clone 的失败分类与 push 同一套（remote-not-found / auth-failed 都要给下一步），
  // 其余操作的 classifyPushFailure 只会返回 none → pushHint 给 null，行为与原先一致。
  fetch: { argv: () => ['fetch', '--all', '--prune'], network: true, hint: pushHint },
  clone: { argv: (input) => argvClone({ url: input.url, target: input.target, depth: input.depth }), network: true, hint: pushHint },
  // stash 备份：列表（数据型）+ 应用 + 删除（「安全拉取」「安全切分支」的备份在这里收尾）。
  stashList: { argv: () => ['stash', 'list'], field: 'stash', parse: parseStashList, local: true },
  stashApply: { argv: (input) => ['stash', 'apply', stashRef(input)] },
  stashDrop: { argv: (input) => ['stash', 'drop', stashRef(input)] },
}

/** 把 `rev-list --left-right --count` 的两列数字翻成人话。 */
function compareNote(compare) {
  if (compare === null || compare === undefined) return null
  if (compare.ahead === 0 && compare.behind === 0) {
    return '本地和 ' + compare.ref + ' 完全一致：没有多出来的、也没有还没拉下来的提交'
  }
  return '相对 ' + compare.ref + '：本地领先 ' + compare.ahead + ' 个提交、落后 '
    + compare.behind + ' 个提交'
    + (compare.behind > 0 ? '（落后的就是远端有、你还没有的）' : '')
}

/**
 * 该操作的时间预算：
 *   - 联网操作给足 10 分钟（克隆大仓库、镜像卡住后回退都要时间）；
 *   - 数据型/本地操作（diff / branches / compare / show / stashList）走 20 秒的
 *     本地档 —— 它们正常是毫秒级，真出问题时不该让面板干等满两分钟才有提示。
 * @param spec - OPS 注册表条目。
 */
function opTimeoutMs(spec) {
  if (spec.network === true) return NETWORK_OP_TIMEOUT_MS
  if (spec.local === true) return GIT_LOCAL_TIMEOUT_MS
  return OP_TIMEOUT_MS
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
 * 面板（routes.js 的 op 流水线）与模型工具（tools.js）共用这一条执行通道：
 * 镜像回退与失败补救因此不可能只对一边生效。
 *
 * @returns { argv, args, result, accel, notes }；args 是**这次真正用的**加速参数，
 *   补救重试必须带同一套，否则会退化成直连。
 * @param options.signal - 可选的取消信号（模型工具把 exec.signal 传进来）。
 */
async function executeWithAcceleration(op, argv, dir, timeoutMs, options = {}) {
  const netConfig = await readNetConfig()
  const accel = networkExtraArgs(op, netConfig)
  const notes = []
  const signal = options !== null && typeof options === 'object' ? options.signal : undefined
  if (accel.mode.includes('proxy')) {
    // 措辞要是**事实**而不是结论：这条命令确实会走代理，但它成不成功还不知道。
    notes.push('本次命令走代理 ' + maskProxy(netConfig.proxy) + '（只作用于本次命令）')
  }
  // 克隆大仓库要给足预算；fetch/pull 通常很快，配合 http.lowSpeedTime 把上限压短，
  // 卡住时能尽快回退，而不是干等 10 分钟。
  const mirrorTimeoutMs = op === 'clone' ? timeoutMs : Math.min(timeoutMs, 120000)
  let args = accel.args
  let fullArgv = [...args, ...argv]
  let result = await runGit(fullArgv, dir, {
    timeoutMs: accel.mirror ? mirrorTimeoutMs : timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  })

  if (accel.mirror === true) {
    if (result.code === 0) {
      notes.push('已通过镜像 ' + mirrorLabel(netConfig.mirror) + ' 加速（只作用于本次命令，不改你的 git 配置）')
    } else if (mirrorFallbackWorthwhile(result.stderr)) {
      args = networkExtraArgs(op, netConfig, { noMirror: true }).args
      fullArgv = [...args, ...argv]
      const retry = await runGit(fullArgv, dir, {
        timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      })
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
 * 冲突文件清单（`git diff --name-only --diff-filter=U`，纯本地只读）。
 * 面板给「撤销这次合并」按钮的同时，把要处理的文件列出来 ——
 * 否则用户只知道「有冲突」，还得自己去终端里 git status 才知道是哪些文件。
 * 任何失败都返回空列表：清单是提示，不是依赖。
 */
async function conflictedFiles(dir) {
  const result = await runGit(['diff', '--name-only', '--diff-filter=U'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (result.code !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/**
 * 把面板操作翻译成 git 参数数组。只接受注册表里的操作；任何用户字符串都作为
 * 独立参数传递，不参与命令拼接。
 *
 * @param dir - **已经归一化**的执行目录（路由传 getDefaultDir() 的结果）。
 *   setRemote 要用它做「同名远程在不在」的查重，必须与真正执行命令的目录一致。
 * @throws 参数不合法时抛带中文提示的错误（面板直接展示）。
 */
async function buildOpArgv(op, input = {}, dir) {
  const spec = OPS[op]
  if (spec === undefined) throw new Error('未知操作：' + String(op))
  const body = input === null || input === undefined ? {} : input
  const cwd = normalizeDir(dir) ?? normalizeDir(body.dir)
  return spec.argv(body, { dir: cwd })
}

/** 模型工具与面板共用的结果文本（命令回显 + stdout + stderr + 退出码）。 */
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
 * @param ctx.extraArgs - 网络加速参数。重试也必须带上：否则「开着代理重推一次」会退化成直连。
 */
async function recoverPush(ctx) {
  const { op, body, argv, result, dir, timeoutMs, extraArgs = [], signal } = ctx
  const reason = result.code === 0 ? 'none' : classifyPushFailure(result.stderr)
  if (op !== 'push' || result.code === 0 || reason !== 'no-upstream') {
    return { argv, result, reason, retried: false }
  }
  const mode = body !== null && typeof body.mode === 'string' ? body.mode : 'auto'
  if (mode === 'plain') return { argv, result, reason, retried: false }

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout)
  if (remotes.length === 0) return { argv, result, reason: 'no-remote', retried: false }

  // 优先 origin；没有 origin（且只有一个远程）就用那一个，避免硬编码失败。
  const chosen = remotes.some((item) => item.name === 'origin') ? 'origin' : remotes[0].name
  const retryArgv = [...extraArgs, 'push', '--set-upstream', chosen, 'HEAD']
  const retry = await runGit(retryArgv, dir, { timeoutMs, ...(signal !== undefined ? { signal } : {}) })
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
      // 多远程时把「替用户选了哪个远程」说出来：补救动作不能默默发生。
      note: remotes.length > 1
        ? '已自动改用 git push --set-upstream ' + chosen + ' HEAD 重推并建立跟踪（仓库有多个远程，选的是 '
          + chosen + '）。以后点「推送」即可'
        : '已自动改用 git push --set-upstream ' + chosen + ' HEAD 重推，并把这个分支登记为跟踪（以后点「推送」即可）',
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
    { timeoutMs: timeoutMs ?? GIT_LOCAL_TIMEOUT_MS },
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
 * 逐个远程向服务器问「你的默认分支是哪个」。
 *
 * 为什么需要这一问：本地标出默认分支靠的是 `origin/HEAD` 这个符号引用，而它**只在
 * git clone 时建立**（新版 git 也会在首次 fetch 顺手补一个，但旧版不会）。于是：
 *   - `git init` + 手动加远程（旧版 git）→ 本地没有 origin/HEAD → 列表里没有任何标记；
 *   - 从镜像拉取 → 镜像常常不导出 HEAD 符号引用 → 同样没有；
 *   - 远端默认分支改过名 → 本地 origin/HEAD 还指旧名字，指向的分支被 `--prune` 清掉后
 *     就成了「有指针、没着落」，同样标不出来。
 * 这里用 `git ls-remote --symref <远程> HEAD` 直接问服务器（只读、只传一个引用），
 * 三种现场都能拿到正确答案。加速设置（镜像/代理）同样作用于这条查询：
 * 开了加速却连不上 github.com 的用户，这条查询也必须走同一套线路。
 *
 * @returns [{ remote, branch }]；每个远程最多一条，查不到（失败/超时/服务器不认
 *   --symref）就跳过 —— 兜底是加分项，任何失败都不能让分支列表跟着报错。
 */
async function remoteDefaultBranches(dir) {
  const listed = await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (listed.code !== 0) return []
  const remotes = parseRemotes(listed.stdout).map((item) => item.name)
  if (remotes.length === 0) return []
  const accel = networkExtraArgs('ls-remote', await readNetConfig())
  const results = await Promise.all(remotes.map(async (name) => {
    const result = await runGit(
      [...accel.args, 'ls-remote', '--symref', name, 'HEAD'],
      dir,
      { timeoutMs: REMOTE_HEAD_TIMEOUT_MS },
    )
    if (result.code !== 0) return null
    const branch = parseLsRemoteHead(result.stdout)
    return branch === null || branch.length === 0 ? null : { remote: name, branch: branch }
  }))
  return results.filter((item) => item !== null)
}

/**
 * 远端分支列表的「默认分支补全」（挂在 branches / remoteBranches 的 enhance 上）。
 *
 * 本地 `git branch --remotes` 已经给出 origin/HEAD 指针时（典型克隆），**不做任何
 * 网络查询**，原样返回；只有指针缺失或指向的分支不在列表里（见 remoteDefaultBranches
 * 的三种现场）才补查。补查结果里能对应上的分支标 head=true，同时把
 * `defaults: [{ remote, branch }]` 带回 —— 面板据此在远端分组顶部写一行
 * 「远端默认分支：origin/main」，即使那个分支还没下载到本地也能看见。
 *
 * @param parsed - parseRemoteBranchOutput 的结果。
 * @returns { items, defaultRef, defaults }：defaultRef 仍是本地解析出来的指针
 *   （可能为 null），defaults 是本次查到的服务器答案。
 */
async function enhanceRemoteBranches(parsed, dir) {
  const base = parsed !== null && typeof parsed === 'object' ? parsed : { items: [], defaultRef: null }
  const items = Array.isArray(base.items) ? base.items.slice() : []
  const known = typeof base.defaultRef === 'string' && base.defaultRef.length > 0
    && items.some((item) => item.ref === base.defaultRef)
  if (known) return { items: items, defaultRef: base.defaultRef, defaults: [] }

  let defaults = []
  try {
    defaults = await remoteDefaultBranches(dir)
  } catch {
    // 查远程失败绝不能让分支列表跟着失败：默认标记是加分项，不是依赖项。
    defaults = []
  }
  const marked = new Set()
  for (const found of defaults) {
    const ref = found.remote + '/' + found.branch
    if (marked.has(ref)) continue
    const item = items.find((entry) => entry.ref === ref)
    if (item !== undefined) item.head = true
    marked.add(ref)
  }
  return { items: items, defaultRef: base.defaultRef, defaults: defaults }
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
async function pullRemoteDefaultBranch(dir, remote, localBranch, timeoutMs, extraArgs, failed, signal) {
  const listed = await runGit(['branch', '--remotes', '--no-color'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (listed.code !== 0) return null
  const remoteBranch = pickRemoteDefaultBranch(parseRemoteBranchOutput(listed.stdout), remote, localBranch)
  if (remoteBranch === null) return null
  const remoteRef = remote + '/' + remoteBranch

  const situation = '远端没有和当前分支同名的 ' + localBranch + '；远端的默认分支是 ' + remoteRef + '，'
  const base = await runGit(['merge-base', remoteRef, 'HEAD'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
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
  const result = await runGit(argv, dir, { timeoutMs, ...(signal !== undefined ? { signal } : {}) })
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
 * @param ctx.extraArgs - 网络加速参数。重试也要带上：否则「开着代理重拉一次」会退化成直连。
 *
 * 与 recoverPush 共用同一个 `(ctx)` 形状：两者原先签名不同（push 多一个 body），
 * 挂到 OPS 表上时就得在两处记两套参数顺序 —— 那种差异正是分叉的起点。
 */
async function recoverPull(ctx) {
  const { op, argv, result, dir, timeoutMs, extraArgs = [], signal } = ctx
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

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout)
  if (remotes.length === 0) return { argv, result, reason: 'no-remote', retried: false }
  // 优先 origin；没有 origin（且只有一个远程）就用那一个，避免硬编码失败。
  const chosen = remotes.some((item) => item.name === 'origin') ? 'origin' : remotes[0].name

  // 当前分支名。真游离 HEAD 时拿不到名字，那就不硬猜了，交回给 pullHint 说清楚。
  const branch = await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS)
  if (branch.length === 0) return { argv, result, reason, retried: false }

  const retryArgv = [...extraArgs, 'pull', chosen, branch]
  const retry = await runGit(retryArgv, dir, { timeoutMs, ...(signal !== undefined ? { signal } : {}) })
  if (retry.code !== 0) {
    const retryReason = classifyPullFailure(pullFailureText(retry))
    // 只有「远端没有这个分支」才值得换默认分支再试：别的失败（冲突、认证、网络）与分支名无关。
    if (retryReason === 'remote-branch-missing') {
      const fallback = await pullRemoteDefaultBranch(
        dir, chosen, branch, timeoutMs, extraArgs, { argv: retryArgv, result: retry }, signal,
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
    { timeoutMs: GIT_LOCAL_TIMEOUT_MS },
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
async function abortMerge(dir, timeoutMs = OP_TIMEOUT_MS) {
  const mergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (mergeHead.code !== 0) {
    return opResponse({
      ok: false,
      message: '现在没有正在进行的合并，不需要撤销（上一次可能已经撤销掉或提交完成了）。点「刷新」看看当前状态。',
    })
  }

  const branch = await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS)
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
async function adoptRemote(body, dir, timeoutMs = OP_TIMEOUT_MS) {
  const input = body !== null && typeof body === 'object' ? body : {}
  const mode = typeof input.mode === 'string' ? input.mode : ''
  if (mode !== 'branch' && mode !== 'reset') {
    return opResponse({ ok: false, message: '未知的操作方式：' + (mode.length > 0 ? mode : '(空)') })
  }

  const remotes = parseRemotes((await runGit(['remote', '-v'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout)
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
    branch = await currentBranchName(dir, GIT_LOCAL_TIMEOUT_MS)
    if (branch.length === 0) {
      return opResponse({ ok: false, message: '当前不在任何分支上（游离 HEAD）：先切到一个分支再操作。' })
    }
  }
  // 远端分支名同样要校验：它会作为参数交给 git switch / reset。
  if (!isSafeRemoteRef(remote + '/' + branch)) {
    return opResponse({ ok: false, message: '远端分支名不合法：' + remote + '/' + branch })
  }

  const remoteRef = remote + '/' + branch
  const known = await runGit(['rev-parse', '--verify', '--quiet', remoteRef], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
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
      const taken = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + target], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
      if (taken.code !== 0) break
      target = wanted + '-' + index
    }
    const occupied = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/' + target], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
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
  const status = await runGit(['status', '--porcelain'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
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

  // 未跟踪文件不是「改动」，但远端那份里同名文件会把它们撞掉（git 会拒绝覆盖并报
  // untracked working tree files would be overwritten —— 那条报错原先会落到「未知错误」）。
  // 这里把「远端树里将要出现的名字」与本地未跟踪清单做交集，提前拦下来。
  const untracked = (await runGit(['ls-files', '--others', '--exclude-standard'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })).stdout
  const remoteTree = await runGit(['ls-tree', '-r', '--name-only', remoteRef], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (remoteTree.code === 0) {
    const remoteFiles = remoteTree.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    const blockers = []
    for (const entry of untracked.split('\n')) {
      const name = entry.trim()
      if (name.length === 0) continue
      // 未跟踪的目录在 ls-files 里是一整行 `dir/`，远端树里是 `dir/file` —— 按前缀比。
      if (name.endsWith('/')) {
        if (remoteFiles.some((file) => file.startsWith(name))) blockers.push(name)
      } else if (remoteFiles.includes(name)) {
        blockers.push(name)
      }
    }
    if (blockers.length > 0) {
      return opResponse({
        ok: false,
        message: '工作区有 ' + blockers.length + ' 个未跟踪文件/目录会和远端那份撞名（'
          + blockers.slice(0, 5).join('、') + (blockers.length > 5 ? ' 等' : '')
          + '）：先移走或提交它们，再做这次覆盖 —— 否则它们会被远端覆盖掉。',
      })
    }
  }

  const before = await runGit(['rev-parse', 'HEAD'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
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


// ── 「安全拉取」：有未提交改动时也可以拉取 ─────────────────────────────────
//
// 背景：面板的「拉取」要求工作区干净（git 会拒绝覆盖未提交改动），于是
// 「本地有改动、又想拉更新」只能先提交 / 丢弃 / 手动 stash，三条路都要用户
// 自己弄明白。这一节把其中最安全的一条路做成一个按钮：
//   1. git stash push -u —— 把改动（**含未跟踪文件**）藏起来，工作区变干净；
//   2. git pull —— 与「拉取」按钮同一条路：网络加速、失败自动补救全都有；
//   3. git stash pop —— 拉取成功后把改动原样弹回来。
// 安全保证（改动绝不能丢）：
//   · 第一步失败（藏不起来）→ 拉取根本不开始，改动原样在工作区；
//   · 第二步失败 → 先撤销这次合并撞出的冲突现场（只有冲突才会留下合并现场），
//     再把改动弹回工作区，仓库回到拉取前；弹不回（极少数）→ 改动仍安全存在
//     stash 里，提示给出恢复命令；
//   · 第三步弹回时冲突 → 拉取已经完成，两边的改动都在冲突文件里，stash 那份
//     备份也还留着，提示给出怎么收尾。

/** 「安全拉取」藏起来时写的 stash 说明（git stash list 里能认出是面板藏的）。 */
const STASH_PULL_LABEL = 'dsh-git-panel：拉取前暂存（自动）'

/** 「安全切分支」藏起来时写的 stash 说明（与安全拉取分开，收尾时能分清是谁藏的）。 */
const STASH_SWITCH_LABEL = 'dsh-git-panel：切分支前暂存（自动）'

/** 拉取失败的原始报错里取第一行（没有就退回退出码）。 */
function pullFailureLine(result) {
  return firstLine(String(result.stderr ?? '').trim()) || 'git 退出码 ' + result.code
}

/**
 * 组装一段「git 命令链」的展示文本（stashPush → pull → pop 这类多步操作）。
 * argv 经 displayArgv 打码：代理之类的东西不会进面板结果栏。
 */
function chainCommand(...argvLists) {
  return argvLists.map((argv) => 'git ' + displayArgv(argv).join(' ')).join(' → ')
}

/** 把多步 git 命令的结果合并成一份（每一步的 stdout / stderr 串联，不丢信息）。 */
function mergeResults(...results) {
  const list = results.filter((item) => item !== null && item !== undefined)
  return {
    code: list.length > 0 ? list[list.length - 1].code : -1,
    stdout: list.map((item) => String(item.stdout ?? '')).filter((text) => text.length > 0).join('\n'),
    stderr: list.map((item) => String(item.stderr ?? '')).filter((text) => text.length > 0).join('\n'),
  }
}

/**
 * 组装「拉取类」操作的响应体（与 runPanelOp 对 pull 的组装规则一致）：
 * 网络失败给 networkHint、其余走 pullHint；无关历史 / 冲突给可点的按钮。
 * @param attempt - { argv, args, result, accel, notes }：executeWithAcceleration / 测试执行器的返回。
 * @param recovery - recoverPull 的返回（{ argv, result, reason, retried, note?, … }）。
 * @param notes - 本次多步操作的说明（按时间顺序，already 含 attempt.notes 之外的面板文案）。
 * @param patch - 覆盖字段（多步流程的特殊分支改 message / hint / choices 用）。
 */
function pullOpPayload(attempt, recovery, notes, patch = {}) {
  const failure = recovery.result.code === 0 ? null : recovery.result
  const networkFailure = failure === null ? null : classifyNetworkFailure(failure.stderr)
  let choices = null
  if (recovery.reason === 'unrelated' && hasText(recovery.remote) && hasText(recovery.branch)) {
    choices = unrelatedChoices(recovery.remote, recovery.branch)
  } else if (recovery.reason === 'conflict' || recovery.reason === 'merge-unfinished') {
    choices = mergeAbortChoice()
  }
  return opResponse({
    ok: recovery.result.code === 0,
    command: chainCommand(recovery.argv),
    exitCode: recovery.result.code,
    stdout: recovery.result.stdout,
    stderr: recovery.result.stderr,
    message: recovery.result.code === 0
      ? null
      : (hasText(recovery.message) ? recovery.message : pullFailureLine(recovery.result)),
    reason: recovery.reason,
    hint: failure === null
      ? null
      : (networkFailure !== null ? networkHint(attempt.accel.mode !== 'direct') : pullHint(recovery.reason)),
    retried: recovery.retried === true,
    accelerated: attempt.accel.mode,
    network: networkFailure !== null,
    notes: [...notes, ...(hasText(recovery.note) ? [recovery.note] : [])],
    choices,
    ...patch,
  })
}

/**
 * 「安全拉取」弹回改动失败时告诉用户怎么收尾的提示（改动还在 stash 里，没丢）。
 */
function popFailedHint() {
  return '改动没有丢：还安全地存在 stash 里（git stash list 可以确认）。'
    + '先执行 git stash pop 把改动拿回来 —— 如果弹出冲突，解决后用 git add + git commit 收尾，'
    + '再执行 git stash drop 清掉备份；不想要这些改动了，直接 git stash drop 即可。'
}

/**
 * 执行「安全拉取」（面板按钮；见本文件「安全拉取」一节的流程与安全保证）。
 *
 * @param body - 请求体（当前只读 dir 之外的字段；与 adoptRemote 同形）。
 * @param dir - **已经归一化**的执行目录（路由传 getDefaultDir() 的结果）。
 * @param pullRunner - 执行 `git pull` 的通道：路由把 executeWithAcceleration 传进来，
 *   于是拉取这一步和「拉取」按钮完全同路（镜像 / 代理 / 失败补救）。
 *   测试可以直接传一个直连执行器。形状：async (argv, timeoutMs) => attempt。
 * @param timeoutMs - 拉取这步的预算（联网操作，给足 10 分钟）。
 * @returns 与 /git-panel/op 其余分支同形的响应（不含 state，由调用方补）。
 */
async function stashPull(body, dir, pullRunner = null, timeoutMs = NETWORK_OP_TIMEOUT_MS) {
  // 0. 工作区干不干净？干净就直接拉取（与「拉取」按钮完全一致），不需要 stash。
  const status = await runGit(['status', '--porcelain'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (status.code !== 0) {
    return opResponse({
      ok: false,
      message: gitMissingMessage(status) ?? (firstLine(status.stderr) || 'git 退出码 ' + status.code),
    })
  }
  const dirty = status.stdout.trim().length > 0
  const stashNotes = []

  // 1. 有改动 → 连未跟踪文件一起藏起来（藏不起来就到此为止，改动不动用户的东西）。
  let stashArgv = null
  if (dirty) {
    stashArgv = ['stash', 'push', '-u', '-m', STASH_PULL_LABEL]
    const stash = await runGit(stashArgv, dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (stash.code !== 0) {
      return opResponse({
        ok: false,
        message: '你的改动原样没动：藏起改动这一步就失败了（' + pullFailureLine(stash) + '），拉取没有开始。',
        command: chainCommand(stashArgv),
        exitCode: stash.code,
        stderr: stash.stderr,
      })
    }
    stashNotes.push('已把你的改动（含未跟踪文件）藏进 stash（git stash push -u）：拉取成功会原样恢复，失败也会自动还给你')
  }

  if (pullRunner === null) {
    return opResponse({
      ok: false,
      message: '插件内部错误：拉取通道没有就绪',
      notes: stashNotes,
    })
  }

  // 2. 拉取：与「拉取」按钮同一条路（加速 + 失败自动补救，见 recoverPull）。
  const attempt = await pullRunner(['pull'], timeoutMs)
  const recovery = await recoverPull({
    op: 'pull',
    body: null,
    argv: attempt.argv,
    result: attempt.result,
    dir,
    timeoutMs,
    extraArgs: attempt.args,
  })

  // 3. 没藏东西：结果与「拉取」按钮完全一致。
  if (!dirty) {
    return pullOpPayload(attempt, recovery, attempt.notes)
  }

  // 4. 拉取成功 → 把改动弹回工作区。
  if (recovery.result.code === 0) {
    const pop = await runGit(['stash', 'pop'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (pop.code === 0) {
      return pullOpPayload(attempt, recovery, [
        ...stashNotes,
        ...attempt.notes,
        '拉取成功，你的改动已原样还原（git stash pop）',
      ], {
        command: chainCommand(stashArgv, attempt.argv, ['stash', 'pop']),
        stdout: mergeResults(recovery.result, pop).stdout,
        stderr: mergeResults(recovery.result, pop).stderr,
      })
    }
    // 弹回时冲突：拉取已完成，两边的改动都在冲突文件里，stash 备份也还留着。
    const popConflicts = await conflictedFiles(dir)
    return pullOpPayload(attempt, recovery, [
      ...stashNotes,
      ...attempt.notes,
      '拉取这一步成功了；还原你的改动时和拉下来的内容撞了车（有冲突）——',
      '两边的改动都没有丢：冲突文件就在工作区里（你的改动 + 拉取内容，用 <<<<<<< 标着）。',
      ...(popConflicts.length > 0 ? ['要处理的冲突文件：' + popConflicts.join('、')] : []),
      '你原来的改动还额外留着一份备份：git stash list 能看到，git stash show -p 可以查看内容',
    ], {
      ok: false,
      reason: 'stash-pop-conflict',
      message: '拉取成功了，但把你的改动还原回工作区时发生了冲突，需要你处理一下。',
      hint: '先把冲突文件改好（每处冲突选一边，或合并两边）：git add 冲突文件 → git commit 收尾，'
        + '再执行 git stash drop 清掉那份备份；不想要你的改动了，就执行 git checkout -- . '
        + '清掉冲突现场，再执行 git stash drop。',
      command: chainCommand(stashArgv, attempt.argv, ['stash', 'pop']),
      exitCode: pop.code,
      stdout: mergeResults(recovery.result, pop).stdout,
      stderr: mergeResults(recovery.result, pop).stderr,
      choices: null,
    })
  }

  // 5. 拉取失败 → 把改动还给用户：这次拉取撞出的冲突现场先撤销（只有冲突会留下
  //    合并现场；merge-unfinished 是**上一次**没收尾的合并，不是这次造成的，
  //    不能替用户撤——那是面板上「撤销这次合并」按钮的决策），再 stash pop。
  if (recovery.reason === 'conflict') {
    const aborted = await runGit(['merge', '--abort'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (aborted.code === 0) stashNotes.push('已自动撤销这次合并（git merge --abort），仓库回到拉取前的样子')
  }
  const pop = await runGit(['stash', 'pop'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (pop.code !== 0) {
    // 极少数：弹不回来。改动仍在 stash 里，是安全的 —— 提示给出恢复命令。
    return pullOpPayload(attempt, recovery, [
      ...stashNotes,
      ...attempt.notes,
      '拉取失败；自动把改动弹回工作区这一步也没成功 —— 改动没有丢，还在 stash 里',
    ], {
      message: '拉取失败（' + pullFailureLine(recovery.result) + '），自动还原你的改动也没成功。',
      hint: popFailedHint(),
      command: chainCommand(stashArgv, attempt.argv, ['stash', 'pop']),
      exitCode: recovery.result.code,
      stdout: mergeResults(recovery.result, pop).stdout,
      stderr: mergeResults(recovery.result, pop).stderr,
    })
  }
  const rollbackPatch = {
    // 多步操作的结果串起来展示（每一步的真实输出都保留）。
    command: chainCommand(stashArgv, attempt.argv, ['stash', 'pop']),
    exitCode: recovery.result.code,
    stdout: mergeResults(recovery.result, pop).stdout,
    stderr: mergeResults(recovery.result, pop).stderr,
  }
  if (recovery.reason === 'conflict') {
    // 这次拉取撞出的冲突已经被我们撤销（merge --abort），不能再给「改好冲突文件 /
    // 撤销这次合并」这类提示和按钮 —— 那两句话指向的现场已经不存在了。
    rollbackPatch.hint = '冲突说明两个版本改了同一个地方。想保留本地改动，先把它提交了再点「拉取」'
      + '（两边的提交会合到一起）；不想要本地改动，就点「丢弃改动」后再点「拉取」。'
    rollbackPatch.choices = null
  }
  return pullOpPayload(attempt, recovery, [
    ...stashNotes,
    ...attempt.notes,
    '拉取没有成功，但你的改动已经原样还给了工作区（仓库回到拉取前的样子）',
  ], rollbackPatch)
}

// ── 「安全切分支」：有未提交改动时也可以切分支 ──────────────────────────────
//
// 与「安全拉取」完全对称的一条路（stash push -u → switch → stash pop）：
// git 的裸 switch 在脏工作区上会直接拒绝（Your local changes would be overwritten），
// 面板原先只能把英文原文甩给用户，让人自己去 commit / stash / 丢弃。这里把最安全的
// 那条做成默认路径，安全保证与 stashPull 一致：
//   · 藏不起来 → 切换根本不开始，改动原样不动；
//   · 切换失败 → 立刻把改动还回工作区（仓库回到切换前）；
//   · 弹回冲突 → 切换已完成，两边改动都在冲突文件里，原改动仍留着一份 stash 备份。
//
// @param body.branch - 要切换到的分支名（必填，且必须是合法分支名）。
// @returns 与 /git-panel/op 其余分支同形的响应（不含 state，由调用方补）。
async function stashSwitch(body, dir, timeoutMs = OP_TIMEOUT_MS) {
  const input = body !== null && typeof body === 'object' ? body : {}
  const branch = trimmedOrNull(input.branch)
  if (branch === null) return opResponse({ ok: false, message: '请选择要切换的分支' })
  if (!isSafeRemoteRef(branch)) return opResponse({ ok: false, message: '分支名不合法：' + branch })

  const status = await runGit(['status', '--porcelain'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (status.code !== 0) {
    return opResponse({
      ok: false,
      message: gitMissingMessage(status) ?? (firstLine(status.stderr) || 'git 退出码 ' + status.code),
    })
  }
  const dirty = status.stdout.trim().length > 0
  const notes = []
  let stashArgv = null

  // 1. 有改动 → 连未跟踪文件一起藏起来（藏不起来就到此为止，不动用户的东西）。
  if (dirty) {
    stashArgv = ['stash', 'push', '-u', '-m', STASH_SWITCH_LABEL]
    const stash = await runGit(stashArgv, dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (stash.code !== 0) {
      return opResponse({
        ok: false,
        reason: 'stash-failed',
        message: '你的改动原样没动：藏起改动这一步就失败了（' + pullFailureLine(stash) + '），切换没有开始。',
        command: chainCommand(stashArgv),
        exitCode: stash.code,
        stderr: stash.stderr,
      })
    }
    notes.push('已把你的改动（含未跟踪文件）藏进 stash：切换成功会原样恢复，切换失败也会自动还给你')
  }

  const switchArgv = ['switch', branch]
  const switched = await runGit(switchArgv, dir, { timeoutMs })

  // 2. 切换失败 → 把改动还回去（藏过才需要还）。
  if (switched.code !== 0) {
    const reason = classifyCheckoutFailure(switched.stderr)
    let pop = null
    if (dirty) {
      pop = await runGit(['stash', 'pop'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
      notes.push(pop.code === 0
        ? '切换没有成功，你的改动已经原样还给了工作区（仓库回到切换前的样子）'
        : '切换没有成功；改动仍安全存在 stash 里（git stash list 可查）')
    }
    const merged = pop === null ? switched : mergeResults(switched, pop)
    return opResponse({
      ok: false,
      reason: reason === 'none' ? 'switch-failed' : reason,
      message: firstLine(switched.stderr) || 'git 退出码 ' + switched.code,
      hint: reason === 'none'
        ? (pop !== null && pop.code !== 0 ? popFailedHint() : null)
        : checkoutHint(reason),
      command: dirty ? chainCommand(stashArgv, switchArgv, ['stash', 'pop']) : 'git switch ' + branch,
      exitCode: switched.code,
      stdout: merged.stdout,
      stderr: merged.stderr,
      notes: notes,
    })
  }

  // 3. 工作区本来就干净：行为与普通「切换分支」完全一致。
  if (!dirty) {
    return opResponse({
      ok: true,
      command: 'git switch ' + branch,
      exitCode: 0,
      stdout: switched.stdout,
      stderr: switched.stderr,
      notes: ['已切换到 ' + branch],
    })
  }

  const pop = await runGit(['stash', 'pop'], dir, { timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (pop.code === 0) {
    return opResponse({
      ok: true,
      command: chainCommand(stashArgv, switchArgv, ['stash', 'pop']),
      exitCode: 0,
      stdout: mergeResults(switched, pop).stdout,
      stderr: mergeResults(switched, pop).stderr,
      notes: [...notes, '已切换到 ' + branch + '，你的改动已原样恢复（git stash pop）'],
    })
  }

  // 4. 弹回冲突：切换已完成，两边改动都在冲突文件里，stash 备份仍留着。
  const conflicts = await conflictedFiles(dir)
  return opResponse({
    ok: false,
    reason: 'stash-pop-conflict',
    message: '已切换到 ' + branch + '，但把你的改动还原回工作区时发生了冲突，需要你处理一下。',
    hint: '冲突文件里是你的改动 + 新分支上的内容（用 <<<<<<< 标着）。改好后 git add 冲突文件 → git commit 收尾，'
      + '再执行 git stash drop 清掉备份（stash 备份在面板的「stash 备份」里也能看到）；不想要这些改动了，直接 git stash drop 即可。',
    command: chainCommand(stashArgv, switchArgv, ['stash', 'pop']),
    exitCode: pop.code,
    stdout: mergeResults(switched, pop).stdout,
    stderr: mergeResults(switched, pop).stderr,
    notes: [
      ...notes,
      '切换已成功，但还原改动时撞了车（有冲突）——',
      '两边的改动都没有丢：冲突文件在工作区里，你原来的改动还留着一份 stash 备份',
      ...(conflicts.length > 0 ? ['要处理的冲突文件：' + conflicts.join('、')] : []),
    ],
  })
}

export {
  opResponse, unrelatedChoices, mergeAbortChoice, abortMerge, adoptRemote, stashPull, stashSwitch,
  recoverPush, recoverPull, pickRemoteDefaultBranch,
  remoteDefaultBranches, enhanceRemoteBranches, REMOTE_HEAD_TIMEOUT_MS,
  executeWithAcceleration, conflictedFiles,
  // 共享 argv 构造器（tools.js 的 toArgv 全部指向它们）
  argvStatus, argvAdd, argvCommit, argvLog, argvDiff, argvBranch, argvCheckout,
  argvPull, argvPush, argvClone, argvInit, argvRemote, argvRun,
  // 注册表与面板入口
  OPS, buildOpArgv, opTimeoutMs, toolArgv, formatGitResult, requiredText,
  LOCAL_OP_TIMEOUT_MS, OP_TIMEOUT_MS, NETWORK_OP_TIMEOUT_MS, DIFF_MAX_CHARS,
}
