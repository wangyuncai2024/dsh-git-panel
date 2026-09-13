// dsh-git-panel —— 纯函数回归测试（node --test test/）
// ============================================================================
// 覆盖宿主侧的关键纯函数：porcelain 分支行解析、远程列表解析、推送失败分类、
// 中文提示、远程配置决策（面板与 AI 工具共用）、clone 目标名推导、目录归一化。
// 这些函数不触网、不落盘，跑一次毫秒级完成。
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import {
  parseBranchLine,
  parseRemotes,
  classifyPushFailure,
  pushHint,
  remoteOpFor,
  cloneTargetName,
  normalizeDir,
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
  assert.equal(normalizeDir('~/work/repo'), homedir() + '/work/repo')
})