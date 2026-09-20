// dsh-git-panel —— 纯函数回归测试（node --test test/）
// ============================================================================
// 覆盖宿主侧的关键纯函数：porcelain 分支行解析、远程列表解析、推送失败分类、
// 中文提示、远程配置决策（面板与 AI 工具共用）、clone 目标名推导、目录归一化。
// 这些函数不触网、不落盘，跑一次毫秒级完成。
// ============================================================================

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseBranchLine,
  parseRemotes,
  classifyPushFailure,
  pushHint,
  remoteOpFor,
  cloneTargetName,
  repoPageUrl,
  normalizeDir,
  parseBranchOutput,
  parseRemoteBranchOutput,
  parseLsRemoteHead,
  isSafeRemoteRef,
  parseCompareOutput,
  parseStashList,
  pickRemoteDefaultBranch,
  buildOpArgv,
  unrelatedChoices,
  pullHint,
  classifyCommitFailure,
  commitHint,
  classifyCheckoutFailure,
  checkoutHint,
  classifyPullFailure,
  opTimeoutMs,
  OPS,
  GIT_LOCAL_TIMEOUT_MS,
  truncateText,
  renderHelpHtml,
  escapeHtml,
  // 日志模块
  appendLog,
  readLogTail,
  logFilePath,
  setLogConfig,
  shouldLog,
  normalizeLogLevel,
  normalizeLogMaxBytes,
} from '../lib/index.js'

// ── parseBranchLine：porcelain `## ` 分支行 ────────────────────────────────

test('parseBranchLine：常规分支 + 上游 + ahead/behind', () => {
  const parsed = parseBranchLine('## main...origin/main [ahead 1, behind 2]')
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, 'origin/main')
  assert.equal(parsed.ahead, 1)
  assert.equal(parsed.behind, 2)
})

test('parseBranchLine：有上游但无领先落后', () => {
  const parsed = parseBranchLine('## main...origin/main')
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, 'origin/main')
  assert.equal(parsed.ahead, 0)
  assert.equal(parsed.behind, 0)
})

test('parseBranchLine：只有 ahead', () => {
  const parsed = parseBranchLine('## dev...origin/dev [ahead 3]')
  assert.equal(parsed.branch, 'dev')
  assert.equal(parsed.ahead, 3)
  assert.equal(parsed.behind, 0)
})

test('parseBranchLine：尚无提交（No commits yet on …）', () => {
  const parsed = parseBranchLine('## No commits yet on main')
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, null)
})

test('parseBranchLine：游离 HEAD', () => {
  const parsed = parseBranchLine('## HEAD (no branch)')
  assert.equal(parsed.branch, 'HEAD')
  assert.equal(parsed.upstream, null)
})

test('parseBranchLine：没有上游的本地分支', () => {
  const parsed = parseBranchLine('## feature/x')
  assert.equal(parsed.branch, 'feature/x')
  assert.equal(parsed.upstream, null)
  assert.equal(parsed.ahead, 0)
})

// ── parseRemotes：git remote -v ───────────────────────────────────────────

test('parseRemotes：只取 fetch 行、去重、按名称排序', () => {
  const stdout = [
    'upstream\tssh://git@github.com/c/d.git (fetch)',
    'origin\thttps://github.com/a/b.git (fetch)',
    'origin\thttps://github.com/a/b.git (push)',
    'weird\tline\twithout\tparens',
    '',
  ].join('\n')
  const remotes = parseRemotes(stdout)
  assert.deepEqual(remotes, [
    { name: 'origin', url: 'https://github.com/a/b.git' },
    { name: 'upstream', url: 'ssh://git@github.com/c/d.git' },
  ])
})

// ── classifyPushFailure：推送失败原因探测 ─────────────────────────────────

const FAILURE_CASES = [
  ['fatal: The current branch master has no upstream branch.', 'no-upstream'],
  ["fatal: The current branch 'dev' has no upstream branch.", 'no-upstream'],
  ["ERROR: Repository not found.\nfatal: Could not read from remote repository.", 'remote-not-found'],
  ['Permission denied (publickey).', 'auth-failed'],
  ['! [rejected] main -> main (fetch first)', 'rejected'],
  ["fatal: 'origin' does not appear to be a git repository", 'remote-not-found'],
  ['fatal: No configured push destination.', 'no-remote'],
  ['fatal: 没有配置推送目标', 'no-remote'],
]

for (const [stderr, expected] of FAILURE_CASES) {
  test('classifyPushFailure：' + (stderr.split('\n')[0] || stderr).slice(0, 40) + '…', () => {
    assert.equal(classifyPushFailure(stderr), expected)
  })
}

test('classifyPushFailure：未知错误 → none', () => {
  assert.equal(classifyPushFailure('fatal: something unexpected'), 'none')
})

test('classifyPushFailure：空输出 → none', () => {
  assert.equal(classifyPushFailure(''), 'none')
})

// ── pushHint：失败原因 → 中文下一步提示 ───────────────────────────────────

test('pushHint：每个已知原因都有提示，none 返回 null', () => {
  for (const reason of ['no-remote', 'no-upstream', 'remote-not-found', 'auth-failed', 'auth-http', 'rejected']) {
    assert.equal(typeof pushHint(reason), 'string', reason + ' 应有提示')
    assert.ok(pushHint(reason).length > 0, reason + ' 提示非空')
  }
  assert.equal(pushHint('none'), null)
})

// ── 新增失败分类：HTTPS 认证失败（push / pull 两侧） ──────────────────────
//
// 回归：原先只认 SSH 的 `Permission denied (publickey)`，HTTPS 走 GitHub 时
// `Authentication failed` / `could not read Username` 全部落到 none ——
// 面板只能把 git 英文原文甩给用户，而这是新手在 HTTPS 推送时最常见的一条。

const AUTH_HTTP_CASES = [
  ["fatal: Authentication failed for 'https://github.com/o/r.git/'", 'auth-http'],
  ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth-http'],
]

for (const [stderr, expected] of AUTH_HTTP_CASES) {
  test('classifyPushFailure（HTTPS 认证）：' + stderr.slice(0, 32) + '… → ' + expected, () => {
    assert.equal(classifyPushFailure(stderr), expected)
  })
  test('classifyPullFailure（HTTPS 认证）：' + stderr.slice(0, 32) + '… → ' + expected, () => {
    assert.equal(classifyPullFailure(stderr), expected)
  })
}

test('auth-http 的提示必须指向令牌与 credential.helper，而不是 SSH 公钥', () => {
  const push = pushHint('auth-http')
  assert.match(push, /Token/i, '要说明 GitHub 不再支持密码、需要令牌')
  assert.match(push, /credential\.helper/)
  assert.doesNotMatch(push, /公钥/)
  const pull = pullHint('auth-http')
  assert.match(pull, /Token/i)
  assert.match(pull, /credential\.helper/)
})

test('classifyPushFailure：SSH 认证仍走 auth-failed（两条不能互相顶掉）', () => {
  assert.equal(classifyPushFailure('Permission denied (publickey).'), 'auth-failed')
  assert.equal(classifyPushFailure('git@github.com: Permission denied (publickey).'), 'auth-failed')
})

// ── 提交失败单独分类：身份没配置 / 没有可提交的内容 ──────────────────────

test('classifyCommitFailure：git 不知道你是谁时给出 identity-missing', () => {
  for (const text of [
    '*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"',
    'fatal: unable to auto-detect email address (got \'x@y.(none)\')',
    'Author identity unknown',
  ]) {
    assert.equal(classifyCommitFailure(text), 'identity-missing', text.slice(0, 30))
  }
})

test('classifyCommitFailure：工作区干净时给出 nothing-to-commit', () => {
  assert.equal(classifyCommitFailure('nothing to commit, working tree clean'), 'nothing-to-commit')
  assert.equal(classifyCommitFailure('无文件要提交，干净的工作区'), 'nothing-to-commit')
})

test('classifyCommitFailure：别的失败仍是 none', () => {
  assert.equal(classifyCommitFailure('fatal: something else'), 'none')
  assert.equal(classifyCommitFailure(''), 'none')
})

test('commitHint：身份问题必须给出两条确切的配置命令', () => {
  const hint = commitHint('identity-missing')
  assert.match(hint, /user\.name/)
  assert.match(hint, /user\.email/)
  assert.match(commitHint('nothing-to-commit'), /暂存/)
  assert.equal(commitHint('none'), null)
})

// ── 切换分支失败单独分类：脏工作区 / 分支不存在 ──────────────────────────

test('classifyCheckoutFailure：脏工作区与分支不存在分开认', () => {
  assert.equal(
    classifyCheckoutFailure('error: Your local changes to the following files would be overwritten by checkout:\n\tf.txt'),
    'dirty-worktree',
  )
  assert.equal(
    classifyCheckoutFailure('error: The following untracked working tree files would be overwritten by checkout:\n\tu.txt'),
    'dirty-worktree',
  )
  assert.equal(classifyCheckoutFailure("fatal: invalid reference: nope"), 'branch-missing')
  assert.equal(classifyCheckoutFailure('fatal: something else'), 'none')
})

test('checkoutHint：脏工作区要指向「安全切分支」，分支不存在要指向新建', () => {
  const dirty = checkoutHint('dirty-worktree')
  assert.match(dirty, /安全切分支/, '要把面板上真正能救场的那条路说出来')
  assert.match(checkoutHint('branch-missing'), /新建/)
  assert.equal(checkoutHint('none'), null)
})

// ── parseStashList：git stash list（面板「stash 备份」） ────────────────────

test('parseStashList：编号与说明分开取，编号必须原样（它是会交给 git 的参数）', () => {
  assert.deepEqual(parseStashList('stash@{0}: WIP on main: 1234abc 提交说明\nstash@{1}: On dev: 手头的改动\n'), [
    { ref: 'stash@{0}', text: 'WIP on main: 1234abc 提交说明' },
    { ref: 'stash@{1}', text: 'On dev: 手头的改动' },
  ])
})

test('parseStashList：空输出与不成形的行都跳过（宁可少列一条，不能拼错编号）', () => {
  assert.deepEqual(parseStashList(''), [])
  assert.deepEqual(parseStashList('stash@{x}: 坏的\n随便一行\n'), [])
  assert.deepEqual(parseStashList(null), [])
})

// ── remoteOpFor：配置推送目标（面板 setRemote 与工具 git_remote set 共用） ─

test('remoteOpFor：远程已存在 → set-url 改地址', () => {
  assert.deepEqual(remoteOpFor('origin', 'https://new/a.git', 'origin\nupstream\n'), ['remote', 'set-url', 'origin', 'https://new/a.git'])
})

test('remoteOpFor：远程不存在 → add 新建', () => {
  assert.deepEqual(remoteOpFor('origin', 'https://new/a.git', 'upstream\n'), ['remote', 'add', 'origin', 'https://new/a.git'])
})

test('remoteOpFor：空远程列表 → add', () => {
  assert.deepEqual(remoteOpFor('origin', 'https://new/a.git', ''), ['remote', 'add', 'origin', 'https://new/a.git'])
})

// ── cloneTargetName：git clone 默认目标名 ─────────────────────────────────

test('cloneTargetName：https + .git 后缀', () => {
  assert.equal(cloneTargetName('https://github.com/user/my-repo.git'), 'my-repo')
})

test('cloneTargetName：https 无 .git、带尾部斜杠', () => {
  assert.equal(cloneTargetName('https://github.com/user/my-repo'), 'my-repo')
  assert.equal(cloneTargetName('https://github.com/user/my-repo/'), 'my-repo')
})

test('cloneTargetName：scp 风格 ssh 地址', () => {
  assert.equal(cloneTargetName('git@github.com:user/other.git'), 'other')
})

test('cloneTargetName：本地路径与 Windows 路径 → 取最后一段（与 git 一致）', () => {
  assert.equal(cloneTargetName('/tmp/some/repo'), 'repo')
  assert.equal(cloneTargetName('C:\\work\\win-repo'), 'win-repo')
})

test('cloneTargetName：无路径分隔的输入原样返回（git 对本地路径即取 basename）', () => {
  assert.equal(cloneTargetName('not a url at all'), 'not a url at all')
})

test('cloneTargetName：空输入退化为占位名', () => {
  assert.equal(cloneTargetName(''), 'repository')
  assert.equal(cloneTargetName(null), 'repository')
})

// ── repoPageUrl：远程地址 → 仓库主页（面板「仓库页 ↗」入口） ────────────────

test('repoPageUrl：https + .git 后缀 → 去后缀', () => {
  assert.equal(repoPageUrl('https://github.com/user/my-repo.git'), 'https://github.com/user/my-repo')
})

test('repoPageUrl：https 无 .git、尾部斜杠、大写 .GIT', () => {
  assert.equal(repoPageUrl('https://github.com/user/my-repo'), 'https://github.com/user/my-repo')
  assert.equal(repoPageUrl('https://github.com/user/my-repo/'), 'https://github.com/user/my-repo')
  assert.equal(repoPageUrl('https://github.com/user/my-repo.GIT/'), 'https://github.com/user/my-repo')
})

test('repoPageUrl：scp 风格 ssh 地址（git@host:path）', () => {
  assert.equal(repoPageUrl('git@github.com:user/my-repo.git'), 'https://github.com/user/my-repo')
})

test('repoPageUrl：git:// 与 ssh:// 协议', () => {
  assert.equal(repoPageUrl('git://github.com/user/my-repo.git'), 'https://github.com/user/my-repo')
  assert.equal(repoPageUrl('ssh://git@github.com/user/my-repo.git'), 'https://github.com/user/my-repo')
})

test('repoPageUrl：非 GitHub 主机同样可打开（GitLab / Gitee）', () => {
  assert.equal(repoPageUrl('https://gitlab.com/group/proj.git'), 'https://gitlab.com/group/proj')
  assert.equal(repoPageUrl('git@gitee.com:user/proj.git'), 'https://gitee.com/user/proj')
})

test('repoPageUrl：带端口的主机保留端口', () => {
  assert.equal(repoPageUrl('https://example.com:8443/a.git'), 'https://example.com:8443/a')
})

test('repoPageUrl：推导不出来的一律 null（本地路径 / 盘符 / file / 空 / 无路径）', () => {
  assert.equal(repoPageUrl('/home/me/repo'), null)
  assert.equal(repoPageUrl('C:\\work\\win-repo'), null)
  assert.equal(repoPageUrl('file:///home/me/repo'), null)
  assert.equal(repoPageUrl('not a url at all'), null)
  assert.equal(repoPageUrl(''), null)
  assert.equal(repoPageUrl(null), null)
  assert.equal(repoPageUrl('https://github.com'), null)
  assert.equal(repoPageUrl('git@github.com:'), null)
})

// ── normalizeDir：目录参数归一化 + ~ 展开 ─────────────────────────────────

test('normalizeDir：空白/非字符串按“未提供”处理', () => {
  assert.equal(normalizeDir(''), undefined)
  assert.equal(normalizeDir('   '), undefined)
  assert.equal(normalizeDir(undefined), undefined)
  assert.equal(normalizeDir(null), undefined)
})

test('normalizeDir：绝对路径原样返回', () => {
  assert.equal(normalizeDir('/home/user/project'), '/home/user/project')
})

test('normalizeDir：~ 与 ~/ 展开为主目录', () => {
  assert.equal(normalizeDir('~'), homedir())
  // 期望值必须和实现用同一套拼接（path.join）：写成 homedir() + '/work/repo'
  // 在 Windows 上必然失败 —— 那是测试自己的 bug，不是代码的。
  assert.equal(normalizeDir('~/work/repo'), join(homedir(), 'work', 'repo'))
})

// ── parseBranchOutput：git branch --no-color（面板分支管理器） ─────────────

test('parseBranchOutput：常规列表，* 标记当前分支', () => {
  const parsed = parseBranchOutput('* main\n  feature/x\n  dev\n')
  assert.equal(parsed.current, 'main')
  assert.deepEqual(parsed.items, [
    { name: 'main', current: true },
    { name: 'feature/x', current: false },
    { name: 'dev', current: false },
  ])
})

test('parseBranchOutput：游离 HEAD 时伪条目被跳过且没有分支被标为当前', () => {
  const parsed = parseBranchOutput('* (HEAD detached at abc1234)\n  main\n')
  assert.equal(parsed.current, null)
  assert.deepEqual(parsed.items, [{ name: 'main', current: false }])
})

test('parseBranchOutput：只有游离 HEAD（空仓库孤儿分支）→ current 为 null', () => {
  const parsed = parseBranchOutput('* (HEAD detached at abc1234)\n')
  assert.equal(parsed.current, null)
  assert.deepEqual(parsed.items, [])
})

test('parseBranchOutput：还没有任何分支 → 空列表', () => {
  const parsed = parseBranchOutput('')
  assert.equal(parsed.current, null)
  assert.deepEqual(parsed.items, [])
})

// ── parseRemoteBranchOutput：git branch --remotes（面板「管理」的远端分组） ──

test('parseRemoteBranchOutput：HEAD 指针不是分支，真分支按 ref 排序并标出默认分支', () => {
  const parsed = parseRemoteBranchOutput(
    '  origin/HEAD -> origin/main\n  upstream/dev\n  origin/main\n',
  )
  assert.equal(parsed.defaultRef, 'origin/main')
  assert.deepEqual(parsed.items, [
    { remote: 'origin', name: 'main', ref: 'origin/main', head: true },
    { remote: 'upstream', name: 'dev', ref: 'upstream/dev', head: false },
  ])
})

test('parseRemoteBranchOutput：只有 HEAD 指针（远端分支还没下载下来）→ 没有可点的分支', () => {
  const parsed = parseRemoteBranchOutput('  origin/HEAD -> origin/main\n')
  assert.equal(parsed.defaultRef, 'origin/main')
  assert.deepEqual(parsed.items, [])
})

test('parseRemoteBranchOutput：空输出 / 非分支行都被忽略', () => {
  assert.deepEqual(parseRemoteBranchOutput(''), { items: [], defaultRef: null })
  assert.deepEqual(parseRemoteBranchOutput('  main\n  origin/\n'), { items: [], defaultRef: null })
})

// ── parseLsRemoteHead：git ls-remote --symref <远程> HEAD（默认分支兜底） ──

test('parseLsRemoteHead：符号引用行给出分支名（tab 分隔）', () => {
  assert.equal(parseLsRemoteHead('ref: refs/heads/master\tHEAD\n'), 'master')
  assert.equal(parseLsRemoteHead('ref: refs/heads/feature/llama-4\tHEAD\n'), 'feature/llama-4')
  // 老服务器不认 --symref，只回哈希行 —— 解析不出名字，返回 null 而不是瞎猜。
  assert.equal(parseLsRemoteHead('3d82ef62d47fd74e18f36c5eccbdcf965b617b17\tHEAD\n'), null)
  assert.equal(parseLsRemoteHead(''), null)
  assert.equal(parseLsRemoteHead(null), null)
})

// ── isSafeRemoteRef：远端引用会作为参数交给 git，必须先校验 ────────────────

test('isSafeRemoteRef：正常远端引用通过', () => {
  for (const ref of ['origin/main', 'origin/feature/x', 'upstream/v1.2.3', 'origin/main-2']) {
    assert.equal(isSafeRemoteRef(ref), true, ref + ' 应该通过')
  }
})

test('isSafeRemoteRef：选项、区间、空白与非法字符一个都不能放过', () => {
  for (const ref of ['-x', '--upload-pack=y', 'a..b', 'HEAD~2', 'a b', 'a^', 'a:b', 'a?b', 'a*b',
    '/x', 'x/', 'x.lock', 'a@{1}', '', null, undefined, 'x'.repeat(201)]) {
    assert.equal(isSafeRemoteRef(ref), false, JSON.stringify(ref) + ' 必须被拒绝')
  }
})

// ── parseCompareOutput：git rev-list --left-right --count ──────────────────

test('parseCompareOutput：左列是本地领先、右列是本地落后', () => {
  assert.deepEqual(parseCompareOutput('3\t5\n', 'origin/main'), { ref: 'origin/main', ahead: 3, behind: 5 })
  assert.deepEqual(parseCompareOutput('0\t0', 'origin/main'), { ref: 'origin/main', ahead: 0, behind: 0 })
})

test('parseCompareOutput：解析不出来一律 0（宁可不说，也不报假数字）', () => {
  assert.deepEqual(parseCompareOutput('', 'origin/main'), { ref: 'origin/main', ahead: 0, behind: 0 })
  assert.deepEqual(parseCompareOutput('换个说法', 'origin/main'), { ref: 'origin/main', ahead: 0, behind: 0 })
  assert.deepEqual(parseCompareOutput('7', 'origin/main'), { ref: 'origin/main', ahead: 7, behind: 0 })
  assert.deepEqual(parseCompareOutput('-1\t-2', 'origin/main'), { ref: 'origin/main', ahead: 0, behind: 0 })
})

// ── pickRemoteDefaultBranch：本地分支名在远端不存在时，该按哪个分支重试 ────
//
// 这是「本地 master / 远端 main」那条路上的推断环节：推错了会去拉一个不存在的分支，
// 所以只允许两种确定的答案 —— 远端自己的默认分支指针，或该远程唯一的分支。

test('pickRemoteDefaultBranch：优先用远端自己的默认分支指针', () => {
  const parsed = parseRemoteBranchOutput('  origin/HEAD -> origin/main\n  origin/main\n  origin/dev\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'master'), 'main')
})

test('pickRemoteDefaultBranch：没有指针但该远程只有一个分支时就是它', () => {
  const parsed = parseRemoteBranchOutput('  origin/main\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'master'), 'main')
})

test('pickRemoteDefaultBranch：多个分支又没有指针 → 不猜（null）', () => {
  const parsed = parseRemoteBranchOutput('  origin/dev\n  origin/release\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'master'), null)
})

test('pickRemoteDefaultBranch：同名、远程对不上、空列表一律 null', () => {
  const parsed = parseRemoteBranchOutput('  origin/HEAD -> origin/main\n  origin/main\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'main'), null, '同名不是这个场景')
  assert.equal(pickRemoteDefaultBranch(parsed, 'upstream', 'master'), null, '别的远程的分支不算')
  assert.deepEqual(parseRemoteBranchOutput(''), { items: [], defaultRef: null })
  assert.equal(pickRemoteDefaultBranch(parseRemoteBranchOutput(''), 'origin', 'master'), null)
  assert.equal(pickRemoteDefaultBranch(null, 'origin', 'master'), null)
})

test('pickRemoteDefaultBranch：指针指向别的远程时不能拿来用', () => {
  const parsed = parseRemoteBranchOutput('  upstream/HEAD -> upstream/main\n  upstream/main\n  origin/dev\n')
  assert.equal(pickRemoteDefaultBranch(parsed, 'origin', 'master'), 'dev', 'origin 只有一个分支 → dev')
  assert.equal(pickRemoteDefaultBranch(parsed, 'upstream', 'master'), 'main')
})

// ── buildOpArgv：新增的两种只读本地操作 ────────────────────────────────────

test('buildOpArgv：remoteBranches 只列远端分支，不碰网络', async () => {
  assert.deepEqual(await buildOpArgv('remoteBranches', {}), ['branch', '--remotes', '--no-color'])
})

test('buildOpArgv：compare 用 HEAD...<ref>，ref 非法时明确报错', async () => {
  assert.deepEqual(
    await buildOpArgv('compare', { ref: ' origin/main ' }),
    ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
  )
  await assert.rejects(() => buildOpArgv('compare', { ref: '-x' }), /远端分支/)
  await assert.rejects(() => buildOpArgv('compare', {}), /远端分支/)
})

// ── 新增操作的 argv：单文件暂存/还原、提交详情、stash、改名、变基 ─────────

test('buildOpArgv：单文件暂存 / 取消暂存 / 还原都带 `--` 分隔符', async () => {
  assert.deepEqual(await buildOpArgv('add', { path: 'a b.txt' }), ['add', '--', 'a b.txt'])
  assert.deepEqual(await buildOpArgv('unstageFile', { path: 'a.txt' }), ['restore', '--staged', '--', 'a.txt'])
  assert.deepEqual(await buildOpArgv('restoreFile', { path: 'a.txt' }), ['restore', '--', 'a.txt'])
  // 路径缺失是可展示的中文错误，而不是拼出一条 `git add --` 去执行。
  await assert.rejects(() => buildOpArgv('add', {}), /文件路径/)
  await assert.rejects(() => buildOpArgv('restoreFile', {}), /文件路径/)
})

test('buildOpArgv：提交详情带 --stat 与完整作者信息，并走本地超时档', async () => {
  const argv = await buildOpArgv('show', { ref: 'abc1234' })
  assert.deepEqual(argv, ['show', '--no-color', '--stat', '--format=fuller', 'abc1234'])
  assert.equal(opTimeoutMs(OPS.show), GIT_LOCAL_TIMEOUT_MS, '本地命令不该按两分钟预算等')
  await assert.rejects(() => buildOpArgv('show', {}), /提交号/)
})

test('buildOpArgv：stash 应用/删除只接受 stash@{n} 形态的编号', async () => {
  assert.deepEqual(await buildOpArgv('stashApply', { ref: 'stash@{0}' }), ['stash', 'apply', 'stash@{0}'])
  assert.deepEqual(await buildOpArgv('stashDrop', { ref: 'stash@{12}' }), ['stash', 'drop', 'stash@{12}'])
  // 编号会作为参数交给 git，形状不对必须当场拒绝（否则可能 drop 到别的东西上）。
  await assert.rejects(() => buildOpArgv('stashDrop', { ref: 'HEAD' }), /stash/)
  await assert.rejects(() => buildOpArgv('stashApply', { ref: '-x' }), /stash/)
  await assert.rejects(() => buildOpArgv('stashDrop', {}), /stash/)
})

test('buildOpArgv：分支改名与暂存列表', async () => {
  assert.deepEqual(await buildOpArgv('renameBranch', { name: 'main' }), ['branch', '-m', 'main'])
  await assert.rejects(() => buildOpArgv('renameBranch', { name: '-x' }), /分支名/)
  await assert.rejects(() => buildOpArgv('renameBranch', {}), /新分支名/)
  assert.deepEqual(await buildOpArgv('stashList', {}), ['stash', 'list'])
})

test('buildOpArgv：pull 的 rebase 开关来自请求体，默认不加', async () => {
  assert.deepEqual(await buildOpArgv('pull', {}), ['pull'])
  assert.deepEqual(await buildOpArgv('pull', { rebase: true }), ['pull', '--rebase'])
})

test('buildOpArgv：commit 的 amend 开关', async () => {
  assert.deepEqual(await buildOpArgv('commit', { message: 'x' }), ['commit', '-m', 'x'])
  assert.deepEqual(await buildOpArgv('commit', { message: 'x', amend: true }), ['commit', '--amend', '-m', 'x'])
})

test('opTimeoutMs：数据型/本地操作用 20 秒档，联网操作用 10 分钟档', () => {
  // 600000 = NETWORK_OP_TIMEOUT_MS（联网操作 10 分钟预算，见 ops.js）。
  for (const op of ['diff', 'branches', 'remoteBranches', 'compare', 'show', 'stashList']) {
    assert.equal(opTimeoutMs(OPS[op]), GIT_LOCAL_TIMEOUT_MS, op + ' 应该走本地档')
  }
  for (const op of ['pull', 'push', 'fetch', 'clone']) {
    assert.equal(opTimeoutMs(OPS[op]), 600000, op + ' 是联网操作，要给足预算')
  }
})

// ── 「两套历史互不相关」的两个选择必须带着远端分支名 ──────────────────────
//
// 回归：按钮原先只回 { mode }，adoptRemote 于是按「当前分支名」去拼 remoteRef。
// 而这两个按钮出现的典型场景恰恰是本地 master、远端 main —— 拼出来的
// origin/master 根本不存在，点下去只会得到「本地还没有 origin/master」。

test('unrelatedChoices：两个选择的参数里都带上真正的远端与分支', () => {
  const choices = unrelatedChoices('origin', 'main')
  assert.equal(choices.length, 2)
  for (const choice of choices) {
    assert.equal(choice.op, 'adoptRemote')
    assert.equal(choice.params.remote, 'origin')
    assert.equal(choice.params.branch, 'main')
  }
  assert.equal(choices[0].params.mode, 'branch')
  assert.equal(choices[1].params.mode, 'reset')
  // 文案要说清「动的是谁」：写错分支名比不写更糟。
  assert.match(choices[0].detail, /origin\/main/)
  assert.match(choices[1].confirm, /origin\/main/)
})

test('pullHint：remote-branch-missing 不能再只说「去推送」（那会推出多余的 master）', () => {
  const hint = pullHint('remote-branch-missing')
  assert.match(hint, /获取远程/, '要先让用户把远端分支信息拿下来')
  assert.match(hint, /管理/, '要指向能看到远端分支的地方')
  assert.doesNotMatch(hint, /^远端还没有这个分支：先点一次「推送」/)
})

// ── truncateText：超长输出截断（diff 面板防爆） ────────────────────────────

test('truncateText：短文本原样返回', () => {
  assert.equal(truncateText('hello', 100), 'hello')
  assert.equal(truncateText('刚好', 2), '刚好')
})

test('truncateText：超长按上限截断并保留截断提示', () => {
  const text = 'x'.repeat(500)
  const result = truncateText(text, 40)
  assert.ok(result.startsWith('x'.repeat(40)))
  assert.ok(result.includes('已截断'))
  assert.ok(result.length < text.length)
  assert.ok(result.length < 100)
})

// ── 帮助文档：escapeHtml / renderHelpHtml ────────────────────────────────

test('escapeHtml：转义 HTML 敏感字符', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
})

test('escapeHtml：null/undefined 当空串处理', () => {
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('renderHelpHtml：是完整文档且含全部分组与命令', () => {
  const html = renderHelpHtml()
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('<title>Git 帮助 · dsh-git-panel</title>'))
  assert.ok(html.includes('面板操作方式'))
  for (const title of ['👀 查看状态与更新', '✍️ 提交与推送', '🌿 分支', '📦 救场 stash', '⌛ 撤销', '🏷️ 标签与历史', '🔌 远程仓库']) {
    assert.ok(html.includes(title), title + ' 应出现在文档里')
  }
  // 命令既要显示成按钮，也要进 data-cmd（复制用的原文）
  assert.ok(html.includes('>git status -sb</button>'))
  assert.ok(html.includes('data-cmd="git status -sb"'))
  // 复制脚本与深浅色适配
  assert.ok(html.includes('navigator.clipboard'))
  assert.ok(html.includes('prefers-color-scheme'))
  assert.ok(html.trimEnd().endsWith('</html>'))
})

test('renderHelpHtml：命令里的引号被转义进属性，不会截断 HTML', () => {
  const html = renderHelpHtml()
  assert.ok(html.includes('data-cmd="git commit -m &quot;提交说明&quot;"'))
  assert.ok(html.includes('data-cmd="git tag -a v1.0 -m &quot;版本说明&quot;"'))
})

// ── 日志模块（临时目录，不碰用户真实主目录、也不写进仓库根） ────────────────
//
// 日志**默认**落在启动 dsh 时的工作区目录（process.cwd()），所以这里每个用例都
// 显式把 logFile 指到临时目录：否则用例之间、乃至并行运行的其它测试文件会一起
// 往工作区那个 git-panel.log 里写，行数断言立刻变成随机的。

let logHome = null

/** 本段用例共用的日志文件（临时目录里的那个）。 */
const logPath = () => join(logHome, 'git-panel.log')

/** 设置日志配置，并强制把文件钉在临时目录。 */
function useLog(options = {}) {
  setLogConfig(Object.assign({}, options, { file: logPath() }))
}

before(async () => {
  logHome = await mkdtemp(join(tmpdir(), 'git-panel-log-'))
  process.env.DSH_HOME = logHome
})

after(async () => {
  setLogConfig({})
  if (logHome !== null) await rm(logHome, { recursive: true, force: true })
})

test('日志：默认落在启动目录（工作区），不再写进 $DSH_HOME', () => {
  setLogConfig({})
  assert.equal(logFilePath(), join(process.cwd(), 'git-panel.log'))
})

test('日志：级别归一化 —— 非法/缺省落 info，off 是可用的合法值', () => {
  assert.equal(normalizeLogLevel('off'), 'off')
  assert.equal(normalizeLogLevel('error'), 'error')
  assert.equal(normalizeLogLevel('warn'), 'warn')
  assert.equal(normalizeLogLevel('info'), 'info')
  assert.equal(normalizeLogLevel('debug'), 'debug')
  assert.equal(normalizeLogLevel('INFO'), 'info')
  assert.equal(normalizeLogLevel(''), 'info')
  assert.equal(normalizeLogLevel(null), 'info')
  assert.equal(normalizeLogLevel(42), 'info')
})

test('日志：轮转上限归一化 —— 非正数落默认值', () => {
  assert.equal(normalizeLogMaxBytes(1024), 1024)
  assert.equal(normalizeLogMaxBytes(0), 2 * 1024 * 1024)
  assert.equal(normalizeLogMaxBytes(-5), 2 * 1024 * 1024)
  assert.equal(normalizeLogMaxBytes(NaN), 2 * 1024 * 1024)
  assert.equal(normalizeLogMaxBytes('x'), 2 * 1024 * 1024)
})

test('日志：shouldLog 按当前级别过滤', () => {
  useLog({ level: 'warn' })
  assert.equal(shouldLog('error'), true)
  assert.equal(shouldLog('warn'), true)
  assert.equal(shouldLog('info'), false)
  assert.equal(shouldLog('debug'), false)
  useLog({ level: 'off' })
  assert.equal(shouldLog('error'), false)
  useLog()
})

test('日志：appendLog 写 JSONL，字段齐全且可解析', async () => {
  useLog({ level: 'debug' })
  const path = logFilePath()
  assert.equal(path, logPath())
  await rm(path, { force: true })
  await appendLog('info', 'op', { op: 'push', dir: '/tmp/x', argv: ['push'], exit: 0, ms: 12 })
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text.trim())
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.event, 'op')
  assert.equal(parsed.op, 'push')
  assert.equal(parsed.exit, 0)
  assert.ok(typeof parsed.at === 'string' && parsed.at.length > 0, '要有时间戳')
  useLog()
})

test('日志：级别过滤生效 —— info 级别下 debug 事件不落盘', async () => {
  useLog({ level: 'info' })
  const path = logFilePath()
  await rm(path, { force: true })
  await appendLog('debug', 'git', { argv: ['status'] })
  await appendLog('warn', 'op', { op: 'push', exit: 128 })
  const text = await readFile(path, 'utf8')
  assert.ok(!text.includes('"event":"git"'), 'debug 事件不该出现在 info 日志里')
  assert.ok(text.includes('"event":"op"'), 'warn 事件应该落盘')
  useLog()
})

test('日志：超过上限自动轮转，只保留当前与 .1 两份', async () => {
  useLog({ level: 'debug', maxBytes: 200 })
  const path = logFilePath()
  await rm(path, { force: true })
  await rm(path + '.1', { force: true })
  // 每条约 90 字节，上限 200：写 6 条必然触发至少一次轮转。
  for (let index = 0; index < 6; index += 1) {
    await appendLog('info', 'op', { op: 'push', exit: 0, payload: 'x'.repeat(40) })
  }
  const current = await stat(path)
  assert.ok(current.size <= 200 + 200, '当前文件应被控制在轮转阈值附近（有一条是「跨过线」的那条）')
  const backup = await stat(path + '.1')
  assert.ok(backup.size > 0, '旧日志应被改名成 .1')
  useLog()
})

test('日志：readLogTail 只读尾部指定行数', async () => {
  useLog({ level: 'debug' })
  const path = logFilePath()
  await rm(path, { force: true })
  for (let index = 0; index < 10; index += 1) {
    await appendLog('info', 'op', { op: 'push', n: index })
  }
  const tail = await readLogTail(3)
  assert.equal(tail.length, 3)
  assert.ok(tail[0].includes('"n":7'), '尾部第一行应是第 8 条')
  assert.ok(tail[2].includes('"n":9'))
  const all = await readLogTail(200)
  assert.equal(all.length, 10, '行数上限内应全量返回')
  const fallback = await readLogTail(0)
  assert.equal(fallback.length, 10, '非正行数按默认值（取全部），但不该抛异常')
  assert.equal((await readLogTail(-3)).length, 10)
  useLog()
})

test('日志：readLogTail 文件不存在时返回空数组而不是抛异常', async () => {
  setLogConfig({ file: join(logHome, 'does-not-exist.log') })
  assert.deepEqual(await readLogTail(10), [])
  setLogConfig({})
})