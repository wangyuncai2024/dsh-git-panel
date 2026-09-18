// dsh-git-panel —— 失败分类与「下一步点哪里」
// ============================================================================
// 全是纯文本函数：把 git 的英文报错归一化成原因，再翻译成可操作的中文提示。
// 分类必须区分「服务器答复了」（404/403，链路是通的）和「连不上」——
// 归错会把用户引到完全错误的排查方向。
// ============================================================================

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

export {
  classifyNetworkFailure, mirrorFallbackWorthwhile, networkHint,
  classifyPushFailure, pushHint, classifyPullFailure, pullFailureText, pullHint,
}
