// dsh-git-panel —— Client half（浏览器侧）
// ============================================================================
// 纯手写 bundle，格式与官方 dsh-client-ui-* 一致：
//   window.__ModuleLoader__.load({ id, factory })，factory 的 require 只能取种子模块
//   （react / react-dom / @deepseek-ai/dsh-client-store / …）。
// 本插件只 require('react')，因此不依赖任何构建产物。
//
// 职责（全部走公开扩展点）：
//   1. shell.overlay   —— 右下角的 Git 图形面板（状态 / 暂存 / 提交 / 分支管理 /
//      改动点开看 diff / 最近提交 / 拉取 / 推送 / 初始化 / 克隆）。
//   2. settings.general.item —— 「设置 → 通用」里的开关行，控制面板是否显示。
//
// 帮助不走浮层：头部的「?」是指向宿主文档路由 GET /git-panel/help 的普通链接，
// 在新标签页打开（原生滚动/查找/打印/收藏），内容由 lib/index.js 生成。
//
// 数据经同源 HTTP /git-panel/* 读写宿主（lib/index.js）。
// 开关的持久化用浏览器 localStorage（key: dsh-git-panel-enabled），
// 同页切换用自定义事件同步两个组件，跨标签页由 storage 事件兜底。
// ============================================================================

window.__ModuleLoader__.load({
  id: 'dsh-git-panel',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // ── 开关状态：localStorage + 事件同步 ─────────────────────────────────

    const STORAGE_KEY = 'dsh-git-panel-enabled'
    const CHANGE_EVENT = 'dsh-git-panel:change'

    /**
     * 旧版本遗留的 localStorage 键：0.5–0.6 的浮动帮助窗口把窗口位置/尺寸存在
     * 这两个键里；现在帮助是宿主提供的独立文档页（GET /git-panel/help），
     * 两个键已没有任何读取方，插件加载时直接删掉，不留垃圾。
     */
    const LEGACY_STORAGE_KEYS = ['dsh-git-panel-help-pos', 'dsh-git-panel-help-size']

    /** 清理旧键；隐私模式等 localStorage 不可用时静默跳过。 */
    function cleanupLegacyKeys() {
      try {
        for (const key of LEGACY_STORAGE_KEYS) window.localStorage.removeItem(key)
      } catch (error) {
        /* 忽略 */
      }
    }

    /** 读取开关；默认开启（首次安装即见面板）。 */
    function readEnabled() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        return raw === null ? true : raw === '1'
      } catch (error) {
        return true
      }
    }

    /** 写入开关（localStorage 失败也不影响当前会话内的显示）。 */
    function writeEnabled(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value === true ? '1' : '0')
      } catch (error) {
        /* 隐私模式等场景忽略 */
      }
    }

    /**
     * 订阅开关状态：返回 [enabled, setEnabled]。
     * 同页用自定义事件即时同步（设置行 ↔ 面板），跨标签页由 storage 事件兜底。
     */
    function useEnabled() {
      const [enabled, setEnabled] = React.useState(readEnabled)
      React.useEffect(() => {
        const sync = () => setEnabled(readEnabled())
        window.addEventListener(CHANGE_EVENT, sync)
        window.addEventListener('storage', sync)
        return () => {
          window.removeEventListener(CHANGE_EVENT, sync)
          window.removeEventListener('storage', sync)
        }
      }, [])
      const update = (next) => {
        const value = next === true
        writeEnabled(value)
        setEnabled(value)
        try {
          window.dispatchEvent(new Event(CHANGE_EVENT))
        } catch (error) {
          /* 忽略 */
        }
      }
      return [enabled, update]
    }

    // ── 与宿主通信（同源 HTTP） ───────────────────────────────────────────

    /** 读取仓库状态。 */
    async function fetchState(dir) {
      const query = typeof dir === 'string' && dir.length > 0 ? '?dir=' + encodeURIComponent(dir) : ''
      const response = await fetch('/git-panel/state' + query, { cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (data === null || typeof data !== 'object') throw new Error('HTTP ' + response.status)
      return data
    }

    /** 执行一个 git 操作，返回 { ok, command, stdout, stderr, message, state }。 */
    async function postOp(payload) {
      const response = await fetch('/git-panel/op', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => null)
      if (data === null || typeof data !== 'object') throw new Error('HTTP ' + response.status)
      return data
    }

    // ── 内联样式（面板自成一体，不污染全局样式表） ───────────────────────

    const S = {
      panel: {
        position: 'fixed', right: '18px', bottom: '18px', width: '352px', maxHeight: '70vh',
        display: 'flex', flexDirection: 'column', pointerEvents: 'auto', zIndex: 90,
        background: 'var(--dsw-alias-bg-overlay, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        borderRadius: '12px', boxShadow: '0 12px 32px rgba(0,0,0,.22)',
        fontSize: '12px', lineHeight: 1.5, overflow: 'hidden',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #eeeeee)', fontWeight: 600,
      },
      spacer: { flex: '1 1 auto' },
      mini: {
        border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px',
        lineHeight: 1, padding: '2px 7px', borderRadius: '6px',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      body: {
        // flex-basis 0：正文区高度完全由容器剩余空间决定，不按内容高度参与
        // 布局——引擎差异下也能保证溢出时内部滚动可靠（basis:auto 会退化）。
        flex: '1 1 0%', minHeight: 0, padding: '10px',
        display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto',
        overscrollBehavior: 'contain',
      },
      row: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      label: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)' },
      path: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      branch: { flex: '0 0 auto', fontWeight: 600 },
      note: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)' },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      box: { display: 'flex', gap: '6px', alignItems: 'center' },
      input: {
        flex: '1 1 auto', minWidth: 0, fontSize: '12px', padding: '4px 8px', borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
      },
      list: {
        display: 'flex', flexDirection: 'column', gap: '3px', padding: '6px',
        maxHeight: '132px', overflowY: 'auto', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      item: { display: 'flex', gap: '6px', minWidth: 0 },
      code: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-state-warn-primary, #d97706)' },
      hash: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-label-tertiary, #999999)' },
      name: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      out: {
        margin: 0, padding: '8px', maxHeight: '120px', overflow: 'auto', borderRadius: '8px',
        background: 'var(--dsw-alias-markdown-code-block, rgba(0,0,0,.05))',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      /** 改动 diff 的展示区（比命令输出框高一点，diff 通常更长）。 */
      diff: {
        margin: 0, padding: '8px', maxHeight: '210px', overflow: 'auto', borderRadius: '8px',
        background: 'var(--dsw-alias-markdown-code-block, rgba(0,0,0,.05))',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      /** 帮助入口：头部那个「?」，是一个新标签页链接（帮助是独立 HTML 文档，
       *  不在浮层里画窗口——文档页有原生滚动/查找/打印，还能收藏）。 */
      miniLink: {
        border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px',
        lineHeight: 1, padding: '2px 7px', borderRadius: '6px', textDecoration: 'none',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      pill: {
        position: 'fixed', right: '18px', bottom: '18px', pointerEvents: 'auto', zIndex: 90,
        padding: '6px 12px', borderRadius: '999px', cursor: 'pointer', fontSize: '12px',
        background: 'var(--dsw-alias-bg-overlay, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        boxShadow: '0 6px 18px rgba(0,0,0,.18)',
      },
      /** 设置行：与官方设置项的版式保持一致（分隔线 + 左标题右控件）。 */
      settingRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
        padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2, #dddddd)',
      },
      settingText: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      settingTitle: { fontSize: '14px', fontWeight: 400, color: 'var(--dsw-alias-label-primary, #111111)' },
      settingHint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #999999)' },
    }

    /** 主按钮 / 次按钮的统一外观。 */
    function buttonStyle(primary, disabled) {
      return {
        padding: '4px 9px', borderRadius: '7px', fontSize: '12px', whiteSpace: 'nowrap',
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true ? 0.5 : 1,
        border: primary === true
          ? '1px solid var(--dsw-alias-brand-primary, #2563eb)'
          : '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: primary === true
          ? 'var(--dsw-alias-brand-primary, #2563eb)'
          : 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
        color: primary === true ? '#ffffff' : 'var(--dsw-alias-label-primary, #111111)',
      }
    }

    // ── 面板组件 ──────────────────────────────────────────────────────────

    /** 已暂存的条目数。 */
    function stagedCount(changes) {
      let staged = 0
      for (const item of changes) {
        if (item !== null && typeof item === 'object' && item.staged === true) staged += 1
      }
      return staged
    }

    /**
     * 改动摘要：总数，以及其中已暂存的数量。
     * 点「全部暂存」后数字会跟着变（否则用户会以为按钮没生效）。
     */
    function changesSummary(changes) {
      if (changes.length === 0) return '没有改动'
      const staged = stagedCount(changes)
      return staged === 0
        ? changes.length + ' 处改动'
        : changes.length + ' 处改动（' + staged + ' 已暂存）'
    }

    /** 已暂存的条目用成功色标出，和未暂存项一眼可分。 */
    function codeStyle(staged) {
      return staged === true
        ? Object.assign({}, S.code, { color: 'var(--dsw-alias-state-success-primary, #16a34a)' })
        : S.code
    }

    /**
     * 与上游的领先/落后摘要。
     * 没有上游时不显示「领先 N」——那种情况下推送失败的原因是没有目标，
     * 而不是有提交没推，提示成「领先」会误导用户。
     */
    function trackingSummary(state) {
      if (state === null || state === undefined) return ''
      const ahead = typeof state.ahead === 'number' ? state.ahead : 0
      const behind = typeof state.behind === 'number' ? state.behind : 0
      if (ahead === 0 && behind === 0) return ''
      const parts = []
      if (ahead > 0) parts.push('领先 ' + ahead)
      if (behind > 0) parts.push('落后 ' + behind)
      return parts.join(' / ')
    }

    function GitPanel(props) {
      const h = React.createElement
      const [enabled] = useEnabled()
      const [minimized, setMinimized] = React.useState(false)
      const [workdir, setWorkdir] = React.useState('')
      const [dirDraft, setDirDraft] = React.useState('')
      const [editingDir, setEditingDir] = React.useState(false)
      const [picked, setPicked] = React.useState(false)
      const [snapshot, setSnapshot] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const [output, setOutput] = React.useState('')
      const [cloneUrl, setCloneUrl] = React.useState('')
      const [showClone, setShowClone] = React.useState(false)
      const [remoteUrl, setRemoteUrl] = React.useState('')
      const [remoteName, setRemoteName] = React.useState('origin')
      const [showRemote, setShowRemote] = React.useState(false)
      const [editingRemote, setEditingRemote] = React.useState(false)
      const [remoteError, setRemoteError] = React.useState('')
      const [showBranches, setShowBranches] = React.useState(false)
      const [branches, setBranches] = React.useState(null)
      const [branchDraft, setBranchDraft] = React.useState('')
      const [diffKey, setDiffKey] = React.useState('')
      const [diffText, setDiffText] = React.useState('')

      // 当前会话的工作目录（shell.overlay 提供的标准 props）。
      const useSessions = props !== null && props !== undefined && typeof props.useSessions === 'function'
        ? props.useSessions
        : null
      const sessionCwd = useSessions === null ? undefined : useSessions((state) => {
        if (state === null || state === undefined) return undefined
        const current = state.current
        if (current === undefined || current === null) return undefined
        const rows = state.byId
        if (rows === undefined || rows === null) return undefined
        const row = rows[current]
        if (row === undefined || row === null) return undefined
        return typeof row.cwd === 'string' ? row.cwd : undefined
      })

      const load = async (requested) => {
        setBusy(true)
        try {
          const data = await fetchState(typeof requested === 'string' ? requested : '')
          setSnapshot(data)
          if (typeof data.dir === 'string' && data.dir.length > 0) setWorkdir(data.dir)
        } catch (error) {
          setOutput('读取状态失败：' + String(error && error.message ? error.message : error))
        }
        setBusy(false)
      }

      // 跟随当前会话目录刷新；用户手动切换过目录后不再覆盖。
      React.useEffect(() => {
        if (picked === true) return
        load(typeof sessionCwd === 'string' && sessionCwd.length > 0 ? sessionCwd : '')
      }, [sessionCwd])

      const remotes = snapshot !== null && Array.isArray(snapshot.remotes) ? snapshot.remotes : []

      /** 从 state 同步远程地址草稿：用户没在编辑时，自动填上已有的远程地址。 */
      React.useEffect(() => {
        if (editingRemote === true) return
        setRemoteUrl(remotes.length > 0 ? remotes[0].url : '')
      }, [snapshot, editingRemote])

      const runOp = async (op, extra, quiet) => {
        setBusy(true)
        if (quiet !== true) setOutput('执行中…')
        // data 必须声明在 try **外面**：它在 try 里赋值、在 try 之后返回。
        // 若用 `const data` 声明在 try 里，第 365 行的 `return data` 会抛
        // ReferenceError（块级作用域），于是每次 runOp 都以 rejected promise 结束。
        // 后果很隐蔽：git 操作其实已在宿主侧执行成功、状态条也刷新了（那两步在
        // try 内），但调用方一律拿不到返回值 —— 「点改动看 diff」永远停在
        // 「加载中…」，分支管理器列不出分支，推送失败的自愈提示也不再出现。
        let data
        try {
          const payload = { op: op }
          if (workdir.length > 0) payload.dir = workdir
          if (extra !== null && extra !== undefined) {
            for (const key of Object.keys(extra)) payload[key] = extra[key]
          }
          data = await postOp(payload)
          // quiet：数据型操作（列分支、查 diff）不回显命令输出，避免把 output 框
          // 刷成一大段 git 原文；失败时仍回显，保证错误可见。
          if (quiet !== true || data.ok !== true) {
            const parts = []
            if (typeof data.command === 'string') parts.push('$ ' + data.command)
            if (typeof data.stdout === 'string' && data.stdout.length > 0) parts.push(data.stdout.replace(/\s+$/, ''))
            if (typeof data.stderr === 'string' && data.stderr.length > 0) parts.push('[stderr] ' + data.stderr.replace(/\s+$/, ''))
            if (typeof data.message === 'string' && data.message.length > 0) parts.unshift(data.message)
            if (typeof data.hint === 'string' && data.hint.length > 0) parts.push('→ ' + data.hint)
            setOutput(parts.length > 0 ? parts.join('\n') : '完成')
          }
          if (data.state !== null && typeof data.state === 'object') setSnapshot(data.state)
        } catch (error) {
          const reason = String(error && error.message ? error.message : error)
          setOutput('操作失败：' + reason)
          // 归一化成失败结果：调用方统一用 data.ok 判断，否则只会得到「未知错误」。
          data = { ok: false, message: reason }
        }
        setBusy(false)
        return data
      }

      /** 拉取本地分支列表（分支管理器打开时调用；branch -d/-D 后也会重新拉）。 */
      const fetchBranches = async () => {
        const data = await runOp('branches', null, true)
        if (data !== null && data !== undefined && data.ok === true
          && data.branches !== null && data.branches !== undefined) {
          setBranches(data.branches)
        }
      }

      /** 展开/收起分支管理器：展开时拉一次列表，保证和当前仓库一致。 */
      const toggleBranches = () => {
        const next = showBranches !== true
        setShowBranches(next)
        if (next === true) fetchBranches()
      }

      /** 切换分支：成功后整面板状态与分支列表一起刷新。 */
      const doCheckout = async (name) => {
        const data = await runOp('checkout', { branch: name })
        if (data !== null && data !== undefined && data.ok === true) {
          load(workdir)
          fetchBranches()
        }
      }

      /** 新建分支并切换（输入框回车或点按钮）。 */
      const doCreateBranch = async () => {
        const name = branchDraft.trim()
        if (name.length === 0) return
        const data = await runOp('createBranch', { branch: name })
        if (data !== null && data !== undefined && data.ok === true) {
          setBranchDraft('')
          setShowBranches(false)
          load(workdir)
        }
      }

      /** 删除分支：只做安全删除（-d，未合并会被 git 拒绝）。 */
      const doDeleteBranch = async (name) => {
        if (window.confirm('确定删除分支 ' + name + '？\n（仅安全删除：含未合并提交的分支会被拒绝，避免误删历史。）')) {
          const data = await runOp('deleteBranch', { branch: name })
          if (data !== null && data !== undefined && data.ok === true) fetchBranches()
        }
      }

      /**
       * 点改动条目查看 diff：再点同一条目收起。
       * untracked 文件没有 diff 内容，给一句中文说明而不是空白的输出框。
       */
      const showDiff = async (item) => {
        const path = String(item.path)
        const key = (item.staged === true ? 's:' : 'u:') + path
        if (diffKey === key) {
          setDiffKey('')
          setDiffText('')
          return
        }
        setDiffKey(key)
        setDiffText('加载中…')
        const data = await runOp('diff', { path: path, cached: item.staged === true }, true)
        if (data !== null && data !== undefined && data.ok === true) {
          const text = typeof data.diff === 'string' ? data.diff : ''
          if (typeof item.code === 'string' && item.code.charAt(0) === '?' && text.trim().length === 0) {
            setDiffText('未跟踪文件没有 diff（还没进入版本库）：先「全部暂存」，再点开看已暂存版本。')
          } else {
            setDiffText(text.length > 0 ? text : '（这个改动没有可显示的 diff 内容）')
          }
        } else {
          const why = data !== null && data !== undefined && typeof data.message === 'string' ? data.message : '未知错误'
          setDiffText('查看 diff 失败：' + why)
        }
      }

      /**
       * 推送失败后的面板侧补救：需要用户先填地址（没有远程 / 远程不存在）时，
       * 把地址输入框打开并给出提示，而不是只留一行 git 的英文报错。
       */
      const push = async () => {
        const data = await runOp('push')
        const reason = data !== null && data !== undefined && typeof data.reason === 'string' ? data.reason : 'none'
        if (data !== null && data !== undefined && data.ok !== true && (reason === 'no-remote' || reason === 'remote-not-found')) {
          setShowRemote(true)
          setRemoteError(typeof data.hint === 'string' ? data.hint : '需要先配置远程仓库地址')
        }
      }

      /** 保存远程地址；返回是否成功。 */
      const saveRemote = async () => {
        const url = remoteUrl.trim()
        if (url.length === 0) {
          setRemoteError('请填写仓库地址')
          return false
        }
        const data = await runOp('setRemote', { name: remoteName.trim().length > 0 ? remoteName.trim() : 'origin', url: url })
        const ok = data !== null && data !== undefined && data.ok === true
        if (ok) {
          setShowRemote(false)
          setRemoteError('')
        } else {
          setRemoteError(data !== null && data !== undefined && typeof data.message === 'string' && data.message.length > 0
            ? data.message
            : '保存远程地址失败')
        }
        return ok
      }

      /** 面板上的「保存并推送」：配好地址后直接推一次，省掉第二次点击。 */
      const saveRemoteAndPush = async () => {
        if (await saveRemote()) await push()
      }

      /** 提交：失败时把输入文本写回，方便修改后重试（空提交、钩子失败很常见）。 */
      const doCommit = async () => {
        const text = message
        setMessage('')
        const data = await runOp('commit', { message: text })
        if (data === null || data === undefined || data.ok !== true) setMessage(text)
      }

      if (enabled !== true) return null

      if (minimized === true) {
        const dirty = snapshot !== null && snapshot.isRepo === true
          && Array.isArray(snapshot.changes) && snapshot.changes.length > 0
        const pillChildren = ['🐙 Git 面板']
        if (dirty) {
          pillChildren.push(h('span', {
            key: 'dot',
            style: { color: 'var(--dsw-alias-state-danger-primary, #dc2626)', marginLeft: '4px' },
            title: '有未提交的改动',
          }, '●'))
        }
        return h('div', {
          style: S.pill,
          title: '展开 Git 面板' + (dirty ? '（有未提交改动）' : ''),
          onClick: () => setMinimized(false),
        }, pillChildren)
      }

      const isRepo = snapshot !== null && snapshot.isRepo === true
      const changes = isRepo && Array.isArray(snapshot.changes) ? snapshot.changes : []
      const commits = isRepo && Array.isArray(snapshot.log) ? snapshot.log : []
      const locked = busy === true

      const btn = (label, onClick, primary) => h('button', {
        key: label,
        style: buttonStyle(primary === true, locked),
        disabled: locked,
        onClick: onClick,
      }, label)

      const head = h('div', { style: S.head, key: 'head' },
        h('span', null, '🐙 Git 面板'),
        h('span', { style: S.spacer }),
        h('a', {
          style: S.miniLink,
          href: '/git-panel/help',
          target: '_blank',
          rel: 'noopener noreferrer',
          title: '打开 Git 帮助文档（新标签页）：面板操作方式 + 常用命令，命令点一下即复制',
        }, '?'),
        h('button', {
          style: S.mini,
          title: '最小化',
          onClick: () => setMinimized(true),
        }, '—'),
      )

      const children = []

      children.push(h('div', { style: S.row, key: 'dir' },
        h('span', { style: S.label }, '目录'),
        editingDir === true
          ? h('input', {
              style: S.input,
              value: dirDraft,
              placeholder: '绝对路径，如 /home/me/project',
              onChange: (event) => setDirDraft(event.target.value),
            })
          : h('span', { style: S.path, title: workdir }, workdir.length > 0 ? workdir : '（默认目录）'),
        editingDir === true
          ? btn('确定', () => { setPicked(true); setEditingDir(false); load(dirDraft) })
          : btn('切换', () => { setDirDraft(workdir); setEditingDir(true) }),
        btn('刷新', () => load(workdir)),
        picked === true && typeof sessionCwd === 'string' && sessionCwd.length > 0
          ? btn('跟随会话', () => { setPicked(false); setEditingDir(false); load(sessionCwd) })
          : null,
      ))

      children.push(h('div', { style: S.row, key: 'branch' },
        h('span', { style: S.label }, '分支'),
        h('span', { style: S.branch }, isRepo
          ? (typeof snapshot.branch === 'string' && snapshot.branch.length > 0 ? snapshot.branch : '（尚无提交）')
          : '—'),
        h('span', { style: S.spacer }),
        h('span', { style: S.note }, isRepo
          ? [changesSummary(changes), trackingSummary(snapshot)].filter((text) => text.length > 0).join(' · ')
          : '还不是 Git 仓库'),
        isRepo === true ? btn(showBranches === true ? '收起' : '管理', toggleBranches) : null,
      ))

      // 分支管理器：本地分支列表（点名字切换、点「删除」安全删除）+ 新建并切换。
      if (isRepo === true && showBranches === true) {
        const branchItems = branches !== null && Array.isArray(branches.items) ? branches.items : []
        children.push(h('div', { style: S.list, key: 'branches' },
          branchItems.length === 0
            ? h('div', { style: S.note }, '还没有分支：提交一次，或直接在下面新建一个。')
            : branchItems.map((item, index) => h('div', { style: S.item, key: 'b' + index },
                h('span', {
                  style: item.current === true
                    ? Object.assign({}, S.name, { fontWeight: 700, color: 'var(--dsw-alias-state-success-primary, #16a34a)' })
                    : Object.assign({}, S.name, { cursor: 'pointer' }),
                  title: item.current === true ? '当前分支' : '点击切换到此分支',
                  onClick: item.current === true ? undefined : () => doCheckout(item.name),
                }, item.current === true ? '✔ ' + item.name : item.name),
                h('span', { style: S.spacer }),
                item.current === true
                  ? h('span', { style: S.note }, '当前')
                  : btn('删除', () => doDeleteBranch(item.name)),
              )),
        ))
        children.push(h('div', { style: S.box, key: 'newbranch' },
          h('input', {
            style: S.input,
            value: branchDraft,
            placeholder: '新分支名（新建并切换）',
            onChange: (event) => setBranchDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                doCreateBranch()
              }
            },
          }),
          btn('新建', doCreateBranch, true),
        ))
      }

      // 远程仓库：没有远程时这条是「未配置」，点了就展开地址输入框；
      // 推送失败需要地址时也会自动展开（见 push()）。
      if (isRepo === true) {
        const first = remotes.length > 0 ? remotes[0] : null
        children.push(h('div', { style: S.row, key: 'remote' },
          h('span', { style: S.label }, '远程'),
          h('span', { style: S.path, title: first === null ? '' : String(first.url) },
            first === null ? '未配置（推送到不了任何地方）' : first.name + ' → ' + first.url),
          btn(showRemote === true ? '收起' : (first === null ? '配置' : '改'), () => {
            setShowRemote(showRemote !== true)
            setRemoteError('')
          }),
        ))
      }

      if (isRepo === true && showRemote === true) {
        children.push(h('div', { style: S.box, key: 'remote-url' },
          h('input', {
            style: Object.assign({}, S.input, { flex: '0 0 64px' }),
            value: remoteName,
            placeholder: 'origin',
            title: '远程名，一般用 origin',
            onChange: (event) => setRemoteName(event.target.value),
          }),
          h('input', {
            style: S.input,
            value: remoteUrl,
            placeholder: '仓库地址 git@github.com:用户名/仓库.git',
            onFocus: () => setEditingRemote(true),
            onBlur: () => setEditingRemote(false),
            onChange: (event) => setRemoteUrl(event.target.value),
          }),
          btn('保存', saveRemote),
          btn('保存并推送', saveRemoteAndPush, true),
        ))
        if (remoteError.length > 0) {
          children.push(h('div', { style: Object.assign({}, S.note, { color: 'var(--dsw-alias-state-warn-primary, #d97706)' }), key: 'remote-err' },
            '⚠ ' + remoteError))
        }
      }

      if (isRepo !== true) {
        children.push(h('div', { style: S.note, key: 'hint' },
          '这个目录里还没有 Git 仓库：可以点下面的按钮初始化一个，或者克隆一个已有的仓库。'))
      }

      if (changes.length > 0) {
        children.push(h('div', { style: S.list, key: 'changes' },
          changes.slice(0, 40).map((item, index) => {
            const key = (item.staged === true ? 's:' : 'u:') + String(item.path)
            return h('div', { style: S.item, key: 'c' + index },
              h('span', { style: codeStyle(item.staged) }, String(item.code)),
              h('span', {
                style: Object.assign({}, S.name, { cursor: 'pointer' }),
                title: (item.staged === true ? '已暂存' : '未暂存') + ' · 点击查看 diff（再点收起）',
                onClick: () => showDiff(item),
              }, String(item.path)),
              h('span', { style: S.note }, diffKey === key ? '▲' : '▼'),
            )
          }),
        ))
        // 点开的改动 diff 紧跟在列表下方，收起时消失。
        if (diffKey.length > 0) {
          children.push(h('pre', { style: S.diff, key: 'diff' }, diffText))
        }
      }

      children.push(h('div', { style: S.actions, key: 'actions' }, isRepo === true
        ? [
            btn('全部暂存', () => runOp('addAll')),
            stagedCount(changes) > 0 ? btn('撤销暂存', () => runOp('unstage')) : null,
            changes.length > 0 ? btn('丢弃改动', () => {
              if (window.confirm('确定丢弃所有未提交的工作区改动？此操作不可恢复。\n（不影响未跟踪文件；已暂存的内容请先「撤销暂存」。）')) {
                runOp('discard')
              }
            }) : null,
            btn('拉取', () => runOp('pull')),
            btn('推送', push),
            btn('获取远程', () => runOp('fetch')),
          ]
        : [
            btn('初始化仓库', () => runOp('init'), true),
            btn(showClone === true ? '收起克隆' : '克隆仓库', () => setShowClone(showClone !== true)),
          ]))

      if (isRepo === true) {
        children.push(h('form', {
          style: S.box, key: 'commit',
          onSubmit: (event) => { event.preventDefault(); doCommit() },
        },
          h('input', {
            style: S.input,
            value: message,
            placeholder: '填写提交信息…（回车直接提交）',
            onChange: (event) => setMessage(event.target.value),
          }),
          h('button', { style: buttonStyle(true, locked), disabled: locked, type: 'submit' }, '提交'),
        ))
      }

      if (isRepo !== true && showClone === true) {
        children.push(h('div', { style: S.box, key: 'clone' },
          h('input', {
            style: S.input,
            value: cloneUrl,
            placeholder: '仓库地址 https://github.com/…',
            onChange: (event) => setCloneUrl(event.target.value),
          }),
          btn('开始克隆', async () => {
            const data = await runOp('clone', { url: cloneUrl })
            // 克隆成功后宿主会回传新仓库的落点（clonedDir），直接切进去并刷新，
            // 省掉「再手动切一次目录」这一步。
            if (data !== null && data !== undefined && data.ok === true
              && typeof data.clonedDir === 'string' && data.clonedDir.length > 0) {
              setPicked(true)
              setWorkdir(data.clonedDir)
              setShowClone(false)
              setCloneUrl('')
              load(data.clonedDir)
            }
          }, true),
        ))
      }

      if (commits.length > 0) {
        children.push(h('div', { style: S.label, key: 'logtitle' }, '最近提交'))
        children.push(h('div', { style: S.list, key: 'log' },
          commits.slice(0, 8).map((item, index) => h('div', { style: S.item, key: 'l' + index },
            h('span', { style: S.hash }, String(item.hash)),
            h('span', { style: S.name, title: String(item.subject) }, String(item.subject)),
          )),
        ))
      }

      if (output.length > 0) {
        children.push(h('pre', { style: S.out, key: 'out' }, output))
      }

      return h('div', { style: S.panel }, head, h('div', { style: S.body }, children))
    }

    // ── 设置行组件（设置 → 通用） ─────────────────────────────────────────

    function GitPanelToggle() {
      const h = React.createElement
      const [enabled, setEnabled] = useEnabled()
      return h('div', { style: S.settingRow },
        h('div', { style: S.settingText },
          h('div', { style: S.settingTitle }, 'Git 面板'),
          h('div', { style: S.settingHint },
            enabled === true
              ? '已开启：界面右下角显示 Git 图形面板，可点击完成暂存、提交、拉取、推送等操作。'
              : '已关闭：不显示 Git 面板。随时可以在这里重新开启。'),
        ),
        h('button', {
          type: 'button',
          'aria-pressed': enabled === true,
          style: buttonStyle(enabled !== true, false),
          onClick: () => setEnabled(enabled !== true),
        }, enabled === true ? '已开启' : '已关闭'),
      )
    }

    // ── cordis 客户端插件 ─────────────────────────────────────────────────

    /** 诊断上报：把注册过程写回宿主日志（浏览器控制台对用户不可见时的观测通道）。 */
    function diag(stage, detail) {
      try {
        fetch('/git-panel/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage: stage, detail: detail === undefined ? null : String(detail) }),
        }).catch(() => {})
      } catch (error) {
        /* 诊断失败不影响功能 */
      }
    }

    /**
     * 注册一个 slot 条目，两种"声明时机"都覆盖。
     *
     * 要点：`ctx.slots.inject(name, cb)` 只在**声明事件**上回调（当前实现订阅后会
     * 立刻 reconcile 一次，但这一点不保证跨版本稳定）。因此对一个「插件加载时
     * 就已经存在」的 slot（例如 ui-settings-general 早已声明好的
     * `settings.general.item`），只写 inject 有等不到回调的风险，界面条目会静默消失。
     *
     * 所以：先直接 register；只有抛错（slot 尚未声明）才退回 inject 等待声明。
     * 异步声明时，cordis 会在回调返回的 disposer 上负责回收。
     *
     * 关键：**不能用"有一处失败"就判断"没声明"**。注册失败也可能是别的原因
     * （同 priority 已有占用、options 结构变化等），把它当成"还没声明"会让组件
     * 永远不出现，而真实原因只在控制台里一闪而过。因此只有回调里真的注册成功了
     * 才记 `declared-later`，否则把真实原因照原样回报诊断通道。
     */
    function registerSlot(ctx, options, component, label) {
      if (ctx.slots === undefined || ctx.slots === null) {
        diag(label + ':no-slots-service')
        return undefined
      }
      try {
        const dispose = ctx.slots.register(options, component)
        diag(label + ':registered-direct')
        return dispose
      } catch (error) {
        diag(label + ':direct-failed', error !== null && error !== undefined && error.message ? error.message : String(error))
      }
      try {
        ctx.slots.inject(options.name, () => {
          try {
            const dispose = ctx.slots.register(options, component)
            diag(label + ':declared-later')
            return dispose
          } catch (error) {
            // 声明已经到来却仍注册失败：这是真问题（选项结构变化、priority 占用…），
            // 报出来而不是让界面无声消失。
            diag(label + ':register-failed-after-declaration', error !== null && error !== undefined && error.message ? error.message : String(error))
            return undefined
          }
        })
      } catch (error) {
        diag(label + ':inject-failed', error !== null && error !== undefined && error.message ? error.message : String(error))
      }
      return undefined
    }

    /** 需要客户端 slots 服务来注册界面。 */
    const inject = ['slots']

    function apply(ctx) {
      diag('apply:start', ctx !== undefined && ctx.slots !== undefined ? 'slots ready' : 'slots missing')
      // 清掉旧版浮动帮助窗口遗留的 localStorage 键（已无读取方）。
      cleanupLegacyKeys()
      // 右下角浮层面板。
      registerSlot(
        ctx,
        { name: 'shell.overlay', id: 'git-panel', order: 50, label: 'Git 面板' },
        GitPanel,
        'overlay',
      )
      // 「设置 → 通用」里的开关行。
      registerSlot(
        ctx,
        { name: 'settings.general.item', id: 'git-panel-toggle', order: 30 },
        GitPanelToggle,
        'settings',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
