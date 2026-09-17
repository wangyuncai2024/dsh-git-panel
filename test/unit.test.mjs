// dsh-git-panel —— 纯函数回归测试（node --test test/）
// ============================================================================
// 覆盖宿主侧的关键纯函数：porcelain 分支行解析、远程列表解析、推送失败分类、
// 中文提示、远程配置决策（面板与 AI 工具共用）、clone 目标名推导、目录归一化。
// 这些函数不触网、不落盘，跑一次毫秒级完成。
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  parseBranchLine,
  parseRemotes,
  classifyPushFailure,
  pushHint,
  remoteOpFor,
  cloneTargetName,
  normalizeDir,
  parseBranchOutput,
  parseRemoteBranchOutput,
  isSafeRemoteRef,
  parseCompareOutput,
  pickRemoteDefaultBranch,
  buildOpArgv,
  unrelatedChoices,
  pullHint,
  truncateText,
  renderHelpHtml,
  escapeHtml,
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
  for (const reason of ['no-remote', 'no-upstream', 'remote-not-found', 'auth-failed', 'rejected']) {
    assert.equal(typeof pushHint(reason), 'string', reason + ' 应有提示')
    assert.ok(pushHint(reason).length > 0, reason + ' 提示非空')
  }
  assert.equal(pushHint('none'), null)
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