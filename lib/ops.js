// dsh-git-panel —— 操作注册表（面板与模型工具的唯一事实来源）
// ============================================================================
// 每个 git 操作的 argv 形状只在这里定义一次：面板的 OPS 与模型工具的 toArgv
// 都指向下面这组 argv* 构造器，两条路径不可能再分叉。
//
// 操作元数据（是否联网、超时、结果怎么解析、失败给什么提示）也收在同一张表里，
// 路由因此不再散落 if (op === …) 分支。
// ============================================================================

import {
  GIT_LOCAL_TIMEOUT_MS, currentBranchName, isSafeRemoteRef, localBranchNameFor,
  parseBranchOutput, parseRemoteBranchOutput, parseCompareOutput, parseRemotes,
  remoteOpFor, runGit,
} from './git.js'
import { classifyPullFailure, classifyPushFailure, pullFailureText, pullHint, pushHint } from './failure.js'
import { firstLine, message, normalizeDir, trimmedOrNull, truncateText } from './util.js'

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

/** diff 回给面板的字符上限（客户端还要逐行着色，太长的 diff 会拖慢渲染）。 */
const DIFF_MAX_CHARS = 40000

/** 取一个必填的字符串参数；缺失时抛出面板可直接展示的中文提示。 */
function requiredText(input, key, errorText) {
  const value = trimmedOrNull(input === null || input === undefined ? undefined : input[key])
  if (value === null) throw new Error(errorText)
  return value
}

const OPS = {
  init: { argv: () => argvInit({}) },
  addAll: { argv: () => argvAdd({ all: true }) },
  // 撤销暂存：把暂存区重置回 HEAD，不动工作区（git reset 不支持 --no-color，无需加）。
  unstage: { argv: () => ['reset'] },
  // 丢弃改动：用暂存区内容覆盖工作区（不影响未跟踪文件）。用 git restore 而不是
  // 早已过时的 `checkout --`：帮助文档给用户的就是 restore，两边必须是同一条命令。
  discard: { argv: () => ['restore', '--', '.'] },
  branches: {
    argv: () => argvBranch({}),
    field: 'branches',
    parse: parseBranchOutput,
    // 分支管理器要同时看本地和远端 —— **一次 HTTP 往返拿两份**。原先客户端连发两次
    // op，而每次 op 宿主都要额外回读一次仓库状态（4 条 git）：展开一次就是 10 条进程。
    // 注意远端那份用 `--remotes`（只列远端），不是 `-a`（本地 + 远端）：
    // 面板的远端分组只要远端，混进本地分支会多出一堆点不动的行。
    also: {
      field: 'remoteBranches',
      argv: () => ['branch', '--remotes', '--no-color'],
      parse: parseRemoteBranchOutput,
    },
  },
  remoteBranches: {
    argv: () => ['branch', '--remotes', '--no-color'],
    field: 'remoteBranches',
    parse: parseRemoteBranchOutput,
  },
  compare: {
    argv: (input) => {
      const ref = requiredText(input, 'ref', '请选择一个远端分支再比较')
      if (!isSafeRemoteRef(ref)) throw new Error('远端分支名不合法，请重新选择')
      return ['rev-list', '--left-right', '--count', 'HEAD...' + ref]
    },
    field: 'compare',
    parse: (stdout, input) => parseCompareOutput(stdout, requiredText(input, 'ref', '请选择一个远端分支再比较')),
    // 原始输出只是两列数字（`0\t3`），直接甩到结果栏没人看得懂。
    note: (fields) => compareNote(fields.compare),
  },
  checkout: {
    argv: (input) => argvCheckout({ branch: requiredText(input, 'branch', '请选择要切换的分支') }),
  },
  createBranch: {
    argv: (input) => argvCheckout({ branch: requiredText(input, 'branch', '请填写新分支名'), create: true }),
  },
  deleteBranch: {
    argv: (input) => argvBranch({ name: requiredText(input, 'branch', '请选择要删除的分支'), delete: true }),
  },
  diff: {
    argv: (input) => argvDiff({ path: input.path, cached: input.cached }),
    field: 'diff',
    parse: (stdout) => truncateText(stdout, DIFF_MAX_CHARS),
  },
  commit: { argv: (input) => argvCommit({ message: input.message }) },
  pull: { argv: () => argvPull({}), network: true, recover: recoverPull, hint: pullHint },
  push: { argv: (input) => argvPush({ mode: input.mode }), network: true, recover: recoverPush, hint: pushHint },
  setRemote: { argv: (input, ctx) => argvRemote({ action: 'set', name: input.name, url: input.url }, ctx) },
  // fetch / clone 的失败分类与 push 同一套（remote-not-found / auth-failed 都要给下一步），
  // 其余操作的 classifyPushFailure 只会返回 none → pushHint 给 null，行为与原先一致。
  fetch: { argv: () => ['fetch', '--all', '--prune'], network: true, hint: pushHint },
  clone: { argv: (input) => argvClone({ url: input.url, target: input.target }), network: true, hint: pushHint },
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

/** 该操作的时间预算（联网操作给足 10 分钟：克隆大仓库、镜像卡住后回退都要时间）。 */
function opTimeoutMs(spec) {
  if (spec.network === true) return NETWORK_OP_TIMEOUT_MS
  return OP_TIMEOUT_MS
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
  const { op, body, argv, result, dir, timeoutMs, extraArgs = [] } = ctx
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
 * @param ctx.extraArgs - 网络加速参数。重试也要带上：否则「开着代理重拉一次」会退化成直连。
 *
 * 与 recoverPush 共用同一个 `(ctx)` 形状：两者原先签名不同（push 多一个 body），
 * 挂到 OPS 表上时就得在两处记两套参数顺序 —— 那种差异正是分叉的起点。
 */
async function recoverPull(ctx) {
  const { op, argv, result, dir, timeoutMs, extraArgs = [] } = ctx
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

export {
  opResponse, unrelatedChoices, mergeAbortChoice, abortMerge, adoptRemote,
  recoverPush, recoverPull, pickRemoteDefaultBranch,
  // 共享 argv 构造器（tools.js 的 toArgv 全部指向它们）
  argvStatus, argvAdd, argvCommit, argvLog, argvDiff, argvBranch, argvCheckout,
  argvPull, argvPush, argvClone, argvInit, argvRemote, argvRun,
  // 注册表与面板入口
  OPS, buildOpArgv, opTimeoutMs, toolArgv, formatGitResult, requiredText,
  LOCAL_OP_TIMEOUT_MS, OP_TIMEOUT_MS, NETWORK_OP_TIMEOUT_MS, DIFF_MAX_CHARS,
}
