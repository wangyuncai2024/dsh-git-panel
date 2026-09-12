// dsh-git-panel —— Client half（浏览器侧）
// ============================================================================
// 纯手写 bundle，格式与官方 dsh-client-ui-* 一致：
//   window.__ModuleLoader__.load({ id, factory })，factory 的 require 只能取种子模块
//   （react / react-dom / @deepseek-ai/dsh-client-store / …）。
// 本插件只 require('react')，因此不依赖任何构建产物。
//
// 职责（全部走公开扩展点）：
//   1. shell.overlay   —— 右下角的 Git 图形面板（状态 / 暂存 / 提交 / 拉取 / 推送 / 初始化 / 克隆）。
//   2. settings.general.item —— 「设置 → 通用」里的开关行，控制面板是否显示。
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
      body: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto' },
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

    /**
     * 改动摘要：总数，以及其中已暂存的数量。
     * 点「全部暂存」后数字会跟着变（否则用户会以为按钮没生效）。
     */
    function changesSummary(changes) {
      if (changes.length === 0) return '没有改动'
      let staged = 0
      for (const item of changes) {
        if (item !== null && typeof item === 'object' && item.staged === true) staged += 1
      }
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

      const runOp = async (op, extra) => {
        setBusy(true)
        setOutput('执行中…')
        try {
          const payload = { op: op }
          if (workdir.length > 0) payload.dir = workdir
          if (extra !== null && extra !== undefined) {
            for (const key of Object.keys(extra)) payload[key] = extra[key]
          }
          const data = await postOp(payload)
          const parts = []
          if (typeof data.command === 'string') parts.push('$ ' + data.command)
          if (typeof data.stdout === 'string' && data.stdout.length > 0) parts.push(data.stdout.replace(/\s+$/, ''))
          if (typeof data.stderr === 'string' && data.stderr.length > 0) parts.push('[stderr] ' + data.stderr.replace(/\s+$/, ''))
          if (typeof data.message === 'string' && data.message.length > 0) parts.unshift(data.message)
          setOutput(parts.length > 0 ? parts.join('\n') : '完成')
          if (data.state !== null && typeof data.state === 'object') setSnapshot(data.state)
        } catch (error) {
          setOutput('操作失败：' + String(error && error.message ? error.message : error))
        }
        setBusy(false)
      }

      if (enabled !== true) return null

      if (minimized === true) {
        return h('div', {
          style: S.pill,
          title: '展开 Git 面板',
          onClick: () => setMinimized(false),
        }, '🐙 Git 面板')
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
      ))

      children.push(h('div', { style: S.row, key: 'branch' },
        h('span', { style: S.label }, '分支'),
        h('span', { style: S.branch }, isRepo
          ? (typeof snapshot.branch === 'string' && snapshot.branch.length > 0 ? snapshot.branch : '（尚无提交）')
          : '—'),
        h('span', { style: S.spacer }),
        h('span', { style: S.note }, isRepo ? changesSummary(changes) : '还不是 Git 仓库'),
      ))

      if (isRepo !== true) {
        children.push(h('div', { style: S.note, key: 'hint' },
          '这个目录里还没有 Git 仓库：可以点下面的按钮初始化一个，或者克隆一个已有的仓库。'))
      }

      if (changes.length > 0) {
        children.push(h('div', { style: S.list, key: 'changes' },
          changes.slice(0, 40).map((item, index) => h('div', { style: S.item, key: 'c' + index },
            h('span', { style: codeStyle(item.staged) }, String(item.code)),
            h('span', { style: S.name, title: String(item.path) }, String(item.path)),
          )),
        ))
      }

      children.push(h('div', { style: S.actions, key: 'actions' }, isRepo === true
        ? [
            btn('全部暂存', () => runOp('addAll')),
            btn('拉取', () => runOp('pull')),
            btn('推送', () => runOp('push')),
            btn('获取远程', () => runOp('fetch')),
          ]
        : [
            btn('初始化仓库', () => runOp('init'), true),
            btn(showClone === true ? '收起克隆' : '克隆仓库', () => setShowClone(showClone !== true)),
          ]))

      if (isRepo === true) {
        children.push(h('div', { style: S.box, key: 'commit' },
          h('input', {
            style: S.input,
            value: message,
            placeholder: '填写提交信息…',
            onChange: (event) => setMessage(event.target.value),
          }),
          btn('提交', () => {
            const text = message
            setMessage('')
            runOp('commit', { message: text })
          }, true),
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
          btn('开始克隆', () => runOp('clone', { url: cloneUrl }), true),
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
     * 要点：`ctx.slots.inject(name, cb)` 只在**未来的声明事件**上回调 —— 它底层的
     * `subscribeDeclaration` 只挂监听器，并不检查该 slot 当前是否已经声明。因此对
     * 一个「插件加载时就已经存在」的 slot（例如 ui-settings-general 早已声明好的
     * settings.general.item），只写 inject 会永远等不到回调，界面条目就静默消失。
     *
     * 所以：先直接 register；只有抛错（slot 尚未声明）才退回 inject 等待声明。
     * 异步声明时，cordis 会在回调返回的 disposer 上负责回收。
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
      ctx.slots.inject(options.name, () => {
        diag(label + ':declared-later')
        return ctx.slots.register(options, component)
      })
      return undefined
    }

    /** 需要客户端 slots 服务来注册界面。 */
    const inject = ['slots']

    function apply(ctx) {
      diag('apply:start', ctx !== undefined && ctx.slots !== undefined ? 'slots ready' : 'slots missing')
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
