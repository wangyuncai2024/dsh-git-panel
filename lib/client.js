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
// 仓库卡的「切换」弹目录选择小窗口：与 DSH「添加工作区」共用宿主的目录选择器
// （uiWorkspace.listDirectory / createDirectory —— 宿主那个对话框内部走的也是这
// 两个方法），浏览 / 手输路径 / 新建文件夹都在里面完成。
// 该服务缺失时退化成只能手输绝对路径，面板本体照常工作。
//
// 本文件自上而下：
//   开关状态 → 同源 HTTP 通信 → 视觉基线（内联样式 + 局部样式表）
//   → 面板状态（一个 reducer）→ useGitPanel（状态与动作）→ 展示组件 → 插槽注册
//
// 帮助不走浮层：头部的「?」是指向宿主文档路由 GET /git-panel/help 的普通链接，
// 在新标签页打开（原生滚动/查找/打印/收藏），内容由 lib/help.js 生成。
//
// 数据经同源 HTTP /git-panel/* 读写宿主（lib/routes.js）。
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
    /** 面板尺寸与折叠态：和开关一样是「界面的记忆」，刷新后保持原样。 */
    const WIDTH_KEY = 'dsh-git-panel-width'
    const MIN_KEY = 'dsh-git-panel-min'

    /**
     * 面板之外的改动只能靠定时读状态来发现（编辑器保存、终端命令、另一个会话、AI 工具
     * —— 它调的就是本插件的 git_* 工具）：宿主与浏览器之间只有「问一次答一次」的 HTTP，
     * 没有任何事件能把「git 变了」推给面板。
     *
     * 两档间隔：有未提交改动 → 20 秒（胶囊上的红点与改动数要跟得上编辑器的节奏）；
     * 干净仓库 → 60 秒。一次读状态 = 4 条本地 git（rev-parse + status + log + remote），
     * 代价很小，而**干净时恰恰是最需要轮询的时候**：切分支、拉取、别人替你提交，
     * 这些都发生在工作区干净的时候（见 useGitPanel 里的轮询 effect）。
     */
    const POLL_DIRTY_MS = 20000
    const POLL_CLEAN_MS = 60000

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

    // ── 面板尺寸 / 折叠态的记忆（都是 localStorage，失败即静默） ────────────

    const WIDTH_MIN = 300
    const WIDTH_MAX = 520

    /** 读回上次调好的宽度；越界或没有记录都返回 null（用默认 360px）。 */
    function readStoredWidth() {
      try {
        const raw = window.localStorage.getItem(WIDTH_KEY)
        if (raw === null) return null
        const value = Number.parseInt(raw, 10)
        if (!Number.isFinite(value) || value < WIDTH_MIN || value > WIDTH_MAX) return null
        return value
      } catch (error) {
        return null
      }
    }

    /** 读回折叠态：上次收起成胶囊的话，这次打开还是胶囊。 */
    function readStoredMinimized() {
      try {
        return window.localStorage.getItem(MIN_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    function writeStorage(key, value) {
      try {
        if (value === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(value))
      } catch (error) {
        /* 忽略 */
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

    /**
     * 会话令牌（CSRF 加固）：宿主在 GET /state 与 GET /net 的响应里发一枚，此后
     * 所有 POST 必须带上。存在模块级变量而不是 React 状态里 —— 它不参与渲染，
     * 面板与设置开关两个组件共用同一枚，放进组件状态反而要同步两份。
     *
     * 读不到就保持空串：旧版宿主（或测试里的假 fetch）不发令牌时，POST 不带这个
     * 字段，行为与加固前完全一致；宿主一旦发过令牌，就得带对才放行。
     */
    let csrfToken = ''

    /** 记下响应里带的令牌（没有就原样返回数据）。 */
    function rememberCsrf(data) {
      if (data !== null && typeof data === 'object' && typeof data.csrf === 'string' && data.csrf.length > 0) {
        csrfToken = data.csrf
      }
      return data
    }

    /** 把令牌放进 POST 请求体（没拿到就不放，保持旧宿主兼容）。 */
    function withCsrf(payload) {
      if (csrfToken.length === 0) return payload
      return Object.assign({}, payload, { csrf: csrfToken })
    }

    /** 读取仓库状态。 */
    async function fetchState(dir) {
      const query = typeof dir === 'string' && dir.length > 0 ? '?dir=' + encodeURIComponent(dir) : ''
      const response = await fetch('/git-panel/state' + query, { cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (data === null || typeof data !== 'object') throw new Error('HTTP ' + response.status)
      return rememberCsrf(data)
    }

    /** 执行一个 git 操作，返回 { ok, command, stdout, stderr, message, state, … }。 */
    async function postOp(payload) {
      const response = await fetch('/git-panel/op', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(withCsrf(payload)),
      })
      const data = await response.json().catch(() => null)
      if (data === null || typeof data !== 'object') throw new Error('HTTP ' + response.status)
      return rememberCsrf(data)
    }

    // ── 小谓词 ────────────────────────────────────────────────────────────
    //
    // 「有内容的字符串」和「宿主回的成功结果」在面板里出现了几十次，
    // 每次手写 `typeof x === 'string' && x.length > 0` / `data !== null && data.ok === true`
    // 既是噪音，也是漏判的来源（漏一次就是「明明成功了却报未知错误」）。

    /** 非空字符串。 */
    function hasText(value) {
      return typeof value === 'string' && value.length > 0
    }

    /** 宿主回的成功结果。 */
    function isOk(data) {
      return data !== null && data !== undefined && data.ok === true
    }

    /** 失败原因文本（宿主回 message，没有就退回 HTTP 状态）。 */
    function whyFailed(data, status) {
      return data !== null && data !== undefined && hasText(data.message) ? data.message : 'HTTP ' + status
    }

    const S = {
      panel: {
        position: 'fixed', right: '18px', bottom: '18px',
        width: '360px', maxWidth: 'calc(100vw - 36px)', maxHeight: '72vh',
        display: 'flex', flexDirection: 'column', pointerEvents: 'auto', zIndex: 90,
        background: 'var(--dsw-alias-bg-overlay, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        borderRadius: '14px',
        // 两层阴影：大范围柔和投影定「浮在内容之上」，近距小投影给边缘一点厚度。
        boxShadow: '0 18px 44px rgba(0,0,0,.24), 0 2px 8px rgba(0,0,0,.10)',
        fontSize: '12.5px', lineHeight: 1.55, overflow: 'hidden',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px 8px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #eeeeee)', fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2, #f7f7f7)', userSelect: 'none',
      },
      title: { display: 'flex', alignItems: 'center', gap: '6px' },
      /** 头部右侧的图标按钮组：彼此只隔 2px，与标题之间用分隔线断开。 */
      headActions: { display: 'flex', alignItems: 'center', gap: '2px' },
      spacer: { flex: '1 1 auto' },
      mini: {
        border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px',
        lineHeight: 1, padding: '3px 7px', borderRadius: '7px',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      body: {
        // flex-basis 0：正文区高度完全由容器剩余空间决定，不按内容高度参与
        // 布局——引擎差异下也能保证溢出时内部滚动可靠（basis:auto 会退化）。
        flex: '1 1 0%', minHeight: 0, padding: '10px 12px 12px',
        display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto',
        overscrollBehavior: 'contain',
      },
      /** 分组卡片：把「同一件事」的几行圈进一个浅底描边块，避免一长串同权重的行。 */
      card: {
        display: 'flex', flexDirection: 'column', gap: '7px', padding: '9px 10px',
        borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      /**
       * 区块小标题：一道品牌色短杠 + 一行小字 + 一条细分隔线，用来切分
       * 「改动 / 同步 / 最近提交」。颜色与字号跟宿主主题的 caption 层级走
       * （--dsw-alias-label-caption），面板因此和设置页、侧栏是同一套字色。
       */
      sectionTitle: {
        display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px',
        color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #999999))',
        fontSize: '11px', fontWeight: 600, letterSpacing: '.06em',
      },
      /** 标题前的那道短杠。纯装饰，但它是「这一段从哪儿开始」最省字的标记。 */
      sectionTick: {
        flex: '0 0 auto', width: '3px', height: '11px', borderRadius: '2px',
        background: 'var(--dsw-alias-brand-primary, #2563eb)', opacity: 0.8,
      },
      sectionRule: { flex: '1 1 auto', height: '1px', background: 'var(--dsw-alias-border-l1, #eeeeee)' },
      row: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      label: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)' },
      path: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // 分支名允许收缩：太长的分支（feature/xxx 这类）不能把「管理」按钮顶出面板，
      // 收缩后省略号截断，全名交给 tooltip（见仓库卡的 title）。
      branch: {
        flex: '0 1 auto', minWidth: 0, fontWeight: 600,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /**
       * 说明文字。textWrap 'pretty'：中文提示一行放不下换行时，避免末行只孤零零
       * 挂一个字符（浏览器支持时），配合提示文案自身的长度控制。
       */
      note: {
        flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)',
        textWrap: 'pretty',
      },
      /**
       * 就地告警（如「新分支名撞上了远端名」）：贴在输入框下面，不走命令结果栏 ——
       * 结果栏是「命令干完之后的回音」，而这条是「还没执行、先别点」。
       */
      warnText: {
        margin: '6px 0 0', fontSize: '11px', lineHeight: 1.5,
        color: 'var(--dsw-alias-state-warn-primary, #d97706)',
      },
      /** 状态小胶囊：把「3 处改动（1 已暂存）」这类摘要收成一个视觉单元。 */
      chip: {
        flex: '0 0 auto', padding: '1px 7px', borderRadius: '999px', fontSize: '11px',
        background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, #f5f5f5))',
        color: 'var(--dsw-alias-label-secondary, #666666)',
        border: '1px solid var(--dsw-alias-border-l1, #eeeeee)', whiteSpace: 'nowrap',
      },
      /**
       * 有未提交改动时的摘要胶囊：品牌色描边 + 一层极淡的品牌色底
       * （底色由 .dgp-chip-active 给，主题色换了它也跟着换），让「有东西要提交」一眼可见。
       */
      chipActive: {
        flex: '0 0 auto', padding: '1px 7px', borderRadius: '999px', fontSize: '11px',
        background: 'transparent', color: 'var(--dsw-alias-brand-primary, #2563eb)',
        border: '1px solid var(--dsw-alias-brand-primary, #2563eb)', whiteSpace: 'nowrap',
      },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      /** 提交表单：输入框一行、动作一行（见 CommitForm 的注释）。 */
      commitForm: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '0 0 auto' },
      commitActions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
      box: { display: 'flex', gap: '6px', alignItems: 'center' },
      input: {
        flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', padding: '5px 9px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
      },
      list: {
        display: 'flex', flexDirection: 'column', gap: '2px', padding: '5px',
        // flex 0 0 auto 不能省：面板正文是「可滚动的 flex 列」，而 overflow:auto 的
        // 子项自动最小尺寸是 0 —— 默认的 flex-shrink:1 会把列表压扁。早先展开 diff
        // 时改动清单被挤成一条缝，看着就像「diff 把清单盖住了」，根因就在这里。
        // 列表自己会滚，所以它永远不需要被压：宁可让正文整体滚动。
        flex: '0 0 auto', maxHeight: '148px', overflowY: 'auto', borderRadius: '9px',
        border: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      item: { display: 'flex', gap: '7px', minWidth: 0, alignItems: 'center' },
      /** 暂存状态标记：实心=已暂存、空心=未暂存。不靠颜色单独表意（色觉差异）。 */
      marker: { flex: '0 0 auto', fontSize: '9px', lineHeight: 1 },
      /**
       * 「默认」徽章：远端默认分支的角标。**独立于名字渲染**（flex 0 0 auto），
       * 名字被省略号截断时徽章仍然完整可见 —— 原先「（默认）」写在名字字符串后面，
       * 名字一截断标记就跟着消失，用户于是在一大串分支里找不到默认分支。
       */
      headBadge: {
        flex: '0 0 auto', padding: '0 6px', borderRadius: '999px', fontSize: '10px',
        lineHeight: '16px', fontWeight: 600, whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-state-success-primary, #15803d)',
        border: '1px solid rgba(22, 163, 74, .35)',
        background: 'rgba(22, 163, 74, .12)',
      },
      /**
       * 状态码（` M` / `M ` / `??`）。外面再套 .dgp-code 给它一个等宽小徽章的样子 ——
       * 徽章靠 CSS 给（字号、内边距、底色），这里只保留「已暂存 = 成功色」这一层语义。
       */
      code: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-state-warn-primary, #d97706)' },
      hash: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-label-tertiary, #999999)' },
      name: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chevron: { flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #999999)' },
      out: {
        margin: 0, padding: '9px', flex: '0 0 auto', maxHeight: '132px', overflow: 'auto', borderRadius: '9px',
        // 内嵌表面：优先用宿主主题的「嵌套层」底色，退化到代码块底色、再退化到中性灰。
        background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-markdown-code-block, rgba(0,0,0,.05)))',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px', lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      /**
       * 改动 diff：**内联展开在被点的那一行下面**，是改动清单的一部分。
       *
       * 这里刻意不给自己滚动条、也不设 maxHeight —— 它和文件行共用清单那一个滚动区。
       * 早先它是清单外面的独立框：面板正文本来就要滚动，展开后它既挤掉清单的高度、
       * 又常常落到可视区之外，用户看到的就是「diff 把改动清单盖住了」。
       */
      diff: {
        margin: '2px 0 4px', padding: '9px', flex: '0 0 auto', borderRadius: '9px',
        background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-markdown-code-block, rgba(0,0,0,.05)))',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px', lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      /**
       * diff / 提交详情上方的小标题条：写清「现在展开的是哪个文件（或哪条提交）」。
       * 展开的那一行可能已经被滚出视野，这一条就是那块内容的抬头，同时钉在它正上方。
       */
      diffTitle: {
        display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto',
        padding: '2px 1px 0', fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /** 小标题条里的路径：等宽、可省略，全名交给 tooltip。 */
      diffPath: {
        flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontFamily: 'ui-monospace, Menlo, monospace',
      },
      /** 帮助入口：头部那个「?」，是一个新标签页链接（帮助是独立 HTML 文档，
       *  不在浮层里画窗口——文档页有原生滚动/查找/打印，还能收藏）。 */
      miniLink: {
        border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '14px',
        lineHeight: 1, padding: '3px 7px', borderRadius: '7px', textDecoration: 'none',
        color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /** 网络加速折叠块：展开时才占地方，平时不打扰日常操作。 */
      netBox: {
        display: 'flex', flexDirection: 'column', gap: '7px', padding: '9px 10px',
        borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      netRow: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap' },
      /** 「需要你选一个结果」的选择区：标题 + 若干按钮（每个按钮下面写清后果）。 */
      choiceBox: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '9px 10px',
        borderRadius: '10px', border: '1px solid var(--dsw-alias-state-warn-primary, #d97706)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      },
      choiceItem: { display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-start' },
      netTitle: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 },
      select: {
        flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', padding: '5px 7px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
      },
      /** 勾选框不参与 flex 拉伸，否则会被压成一条线。 */
      check: { flex: '0 0 auto', margin: 0 },
      /** 安全提醒（镜像会把请求转给第三方）用警告色，不能混在普通说明里。 */
      warn: {
        fontSize: '11px', lineHeight: 1.5,
        color: 'var(--dsw-alias-state-warn-primary, #d97706)',
      },
      /** 警告行 + 行内动作按钮（如「两个远程指向同一地址」那一行）：允许换行，别把按钮挤出去。 */
      warnRow: {
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px',
        fontSize: '11px', lineHeight: 1.5,
        color: 'var(--dsw-alias-state-warn-primary, #d97706)',
      },
      good: { flex: '0 0 auto', color: 'var(--dsw-alias-state-success-primary, #16a34a)' },
      bad: { flex: '0 0 auto', color: 'var(--dsw-alias-state-error-primary, #dc2626)' },
      probeMs: { flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, #999999)' },
      pill: {
        position: 'fixed', right: '18px', bottom: '18px', pointerEvents: 'auto', zIndex: 90,
        display: 'flex', alignItems: 'center', gap: '6px',
        padding: '7px 13px', borderRadius: '999px', cursor: 'pointer', fontSize: '12.5px',
        background: 'var(--dsw-alias-bg-overlay, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #111111)',
        border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
        boxShadow: '0 6px 18px rgba(0,0,0,.18)',
      },
      /** 空态说明（还不是仓库 / 工作区干净）：虚线框 + 居中弱化文字。 */
      empty: {
        padding: '14px 10px', borderRadius: '10px', textAlign: 'center',
        border: '1px dashed var(--dsw-alias-border-l2, #dddddd)',
        color: 'var(--dsw-alias-label-tertiary, #999999)', fontSize: '12px',
      },
      /** 空态的大图标：给这块灰字一个视觉落点，也让「空」和「坏了」看起来不一样。 */
      emptyIcon: { fontSize: '22px', lineHeight: 1.4, opacity: 0.9 },
      /** 设置行：与官方设置项的版式保持一致（分隔线 + 左标题右控件）。 */
      settingRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
        padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2, #dddddd)',
      },
      /**
       * 面板左缘的拖拽条：拖它改宽度（300–520px，存在 localStorage 里），
       * 双击恢复默认宽度。
       * 只占 5px、平时完全透明，不会挡住面板内容；命中区域比视觉宽度略宽，
       * 拖起来不至于「抓不住」。
       */
      resizeHandle: {
        position: 'absolute', left: 0, top: 0, bottom: 0, width: '5px',
        cursor: 'col-resize', zIndex: 1, background: 'transparent',
      },
      settingText: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      settingTitle: { fontSize: '14px', fontWeight: 400, color: 'var(--dsw-alias-label-primary, #111111)' },
      settingHint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #999999)' },

      // ── 面板下半部分的固定区（都在正文滚动区之外） ──────────────────────
      //
      // 这三块不参与正文滚动：命令结果与「要你选一个结果」都是**刚刚那一下动作的
      // 回音**，滚到看不见就等于没回音；底部状态条则是「我一直在哪儿」的常驻信息。

      /** 固定区容器：本身不滚，内部各块自己滚。上方一条分隔线把它和滚动正文分开。 */
      footer: {
        display: 'flex', flexDirection: 'column', gap: '8px', flex: '0 0 auto',
        padding: '8px 12px 10px',
        borderTop: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
      },
      /** 结果区里的小动作条（「清空」这类）。 */
      outBar: {
        display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto',
      },
      /** 结果块：标题条 + 那块结果本身。 */
      outBlock: {
        display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 0 auto', minHeight: 0,
      },
      /** 底部状态条：分支 + 改动数 + 上一次操作的结果，点一下回到顶部。 */
      status: {
        display: 'flex', alignItems: 'center', gap: '7px', flex: '0 0 auto',
        padding: '6px 12px', cursor: 'pointer', userSelect: 'none',
        borderTop: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
        background: 'var(--dsw-alias-bg-layer-2, #f7f7f7)',
        fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #666666)',
      },
      /** 上一次操作的结果点：绿=成功、红=失败、灰=还没操作过。 */
      statusDot: { flex: '0 0 auto', fontSize: '9px', lineHeight: 1 },
      statusText: {
        flex: '1 1 auto', minWidth: 0, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      statusTail: {
        flex: '0 0 auto', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-tertiary, #999999)',
      },
      /**
       * 状态条上的「名称不一致」小标。颜色走产品主题变量，明暗主题都自适应；
       * 加粗只是为了让它在 11px 的一行里也能被一眼看到。
       */
      statusWarn: {
        flex: '0 0 auto', whiteSpace: 'nowrap', fontWeight: 600,
        color: 'var(--dsw-alias-state-warn-primary, #d97706)',
      },
      /**
       * 忙碌指示（头部那个小圈）：border 只给上边着色 + 旋转，就是最常见的转圈。
       * 旋转动画由 .dgp-spin 提供 —— 关掉动画（prefers-reduced-motion）时它退化成
       * 一个静止的小圈，仍然表示「正在忙」。
       */
      busyDot: {
        flex: '0 0 auto', width: '8px', height: '8px', borderRadius: '999px',
        border: '1.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.20))',
        borderTopColor: 'var(--dsw-alias-brand-primary, #2563eb)',
      },
    }

    // ── 面板局部样式表 ───────────────────────────────────────────────────
    //
    // 渲染成一个 <style> 元素随组件挂载，卸载即回收（不写全局样式表、不动宿主 DOM）。
    //
    // 为什么必须有它：内联 style 表达不了 :hover / :focus-visible / 过渡 / 滚动条
    // 外观，diff 与命令结果的分行着色也需要真实选择器。基础外观仍然留在 S 里
    // （见上），所以本样式表失效时界面依然可用 —— 这也是为什么这里的悬停覆盖
    // 必须带 !important：内联样式优先级高于样式表，这是有意为之，不是偷懒。
    const PANEL_CSS = [
      '.dgp-panel *{box-sizing:border-box}',
      // 面板出现时轻轻上浮一下：浮层「出现」比「弹出」少一点突兀。
      '@keyframes dgpIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '.dgp-panel{animation:dgpIn .16s ease-out}',
      // 头部顶端一道品牌色渐变横条：整个面板的「身份条」，换主题色它跟着换。
      '.dgp-head{position:relative}',
      '.dgp-head::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary,#2563eb),transparent 72%)}',
      // 细滚动条：默认滚动条在这个 360px 的小面板里太抢眼
      '.dgp-panel ::-webkit-scrollbar{width:8px;height:8px}',
      '.dgp-panel ::-webkit-scrollbar-track{background:transparent}',
      '.dgp-panel ::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:999px}',
      '.dgp-panel ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary,rgba(0,0,0,.3))}',
      // 按钮：统一高度（成排的按钮不再高低不齐）、悬停/按下/键盘焦点
      '.dgp-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:26px;transition:background-color .12s ease,border-color .12s ease,filter .12s ease,transform .08s ease}',
      '.dgp-btn-compact{min-height:20px}',
      '.dgp-btn:not(:disabled):hover{filter:brightness(.95)}',
      '.dgp-btn:not(:disabled):active{transform:translateY(1px)}',
      '.dgp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}',
      '.dgp-btn-ghost:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))!important}',
      // 主按钮：顶上压一层极淡的高光，实心色因此有点体积感；悬停用宿主的
      // 「主按钮悬停色」而不是整体调亮度（品牌色在深色主题里是白的，提亮等于没反应）。
      '.dgp-btn-primary{background-image:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0))}',
      '.dgp-btn-primary:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover,#3b82f6)!important;filter:none}',
      '.dgp-btn-danger:not(:disabled):hover{background:var(--dsw-alias-state-error-primary,#dc2626)!important;color:#fff!important;border-color:var(--dsw-alias-state-error-primary,#dc2626)!important}',
      // 危险按钮不要那层高光：它悬停时是实心错误色，再有高光会显得像主操作。
      '.dgp-btn-danger{background-image:none}',
      // 有未提交改动时的摘要胶囊：品牌色描边 + 一层极淡的品牌色底
      '.dgp-chip-active{background:rgba(37,99,235,.10)!important;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 12%,transparent)!important}',
      // 状态码 / 提交短哈希的小徽章：等宽、定宽、浅底，纵向对得齐
      '.dgp-code{display:inline-block;min-width:22px;padding:0 4px;border-radius:4px;text-align:center;font-size:10px;line-height:15px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.05))}',
      '.dgp-hash{min-width:0;text-align:left;background:transparent}',
      // 头部图标按钮 / 最小化后的胶囊
      '.dgp-mini{transition:background-color .12s ease,color .12s ease}',
      '.dgp-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))!important;color:var(--dsw-alias-label-primary,#111111)!important}',
      '.dgp-mini:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}',
      '.dgp-pill{transition:transform .12s ease,box-shadow .12s ease;animation:dgpIn .16s ease-out}',
      '.dgp-pill:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(0,0,0,.24)!important}',
      // 有改动时胶囊上那颗红点轻轻呼吸：余光里也能察觉「还有东西没提交」
      '@keyframes dgpPulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.dgp-pulse{animation:dgpPulse 1.6s ease-in-out infinite}',
      // 忙碌指示：转圈（关掉动画时退化成一个静止的小圈，仍然表示「正在忙」）
      '@keyframes dgpSpin{to{transform:rotate(360deg)}}',
      '.dgp-spin{animation:dgpSpin .9s linear infinite}',
      // 列表行：整行悬停，可点的行给出手型与焦点环
      '.dgp-rowitem{border-radius:6px;padding:2px 5px;margin:0 -3px;transition:background-color .12s ease}',
      '.dgp-rowitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      // 当前展开了 diff 的那一行：左侧一道品牌色短杠，和它下面那块 diff 对上号。
      // 用伪元素而不是 inset 阴影：行有 6px 圆角，阴影会被圆角剪成「［」形；短杠
      // 自己做圆角，和区块标题前的那道 tick 是同一个视觉语言。
      '.dgp-rowitem-active{position:relative;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dgp-rowitem-active::before{content:"";position:absolute;left:-1px;top:2px;bottom:2px;width:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#2563eb)}',
      '.dgp-clickable{cursor:pointer}',
      '.dgp-clickable:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}',
      // 输入框：聚焦时给一圈可见的焦点环（内联里没有 border-color 的悬停态）
      '.dgp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#2563eb)!important;box-shadow:0 0 0 3px rgba(37,99,235,.16)}',
      // 命令结果 / diff / 提交详情：同一套「内嵌代码块」外观（细边框 + 圆角）
      '.dgp-pre{border:1px solid var(--dsw-alias-border-l1,#eeeeee)}',
      // diff 逐行着色 + 行底纹：文件头/区块头/新增/删除各一色，新增与删除再给一层底色，
      // 一屏 diff 因此可以直接扫出「加了哪些、删了哪些」，而不是逐字读颜色。
      '.dgp-diff-line{display:block;padding:0 6px}',
      '.dgp-diff-meta{color:var(--dsw-alias-label-tertiary,#999999)}',
      '.dgp-diff-hunk{color:var(--dsw-alias-state-business-primary,#2563eb);font-weight:500;background:rgba(37,99,235,.08);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2563eb) 10%,transparent)}',
      '.dgp-diff-add{color:var(--dsw-alias-state-success-primary,#16a34a);background:rgba(22,163,74,.10);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 13%,transparent)}',
      '.dgp-diff-del{color:var(--dsw-alias-state-error-primary,#dc2626);background:rgba(220,38,38,.10);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 13%,transparent)}',
      // 命令结果栏分行着色：命令回显 / stderr / 加速说明 / 下一步提示
      '.dgp-out-cmd{color:var(--dsw-alias-label-secondary,#666666)}',
      '.dgp-out-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dgp-out-note{color:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.dgp-out-hint{color:var(--dsw-alias-state-business-primary,#2563eb)}',
      // 操作成功时结果栏闪一下：点「全部暂存」之类的按钮后，这一下短暂的描边
      // 告诉他「刚才那一下有回音」。
      '@keyframes dgpFlash{from{box-shadow:0 0 0 3px rgba(37,99,235,.35)}to{box-shadow:0 0 0 0 rgba(37,99,235,0)}}',
      '.dgp-out-flash{animation:dgpFlash .8s ease-out}',
      // 底部状态条与浮层里的「点一下」元素：悬停给底色，键盘焦点给焦点环
      '.dgp-status:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dgp-status:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:-2px}',
      // 目录选择小窗口：淡入 + 轻微上浮（与面板出现同一套动效语言）
      '@keyframes dgpFadeIn{from{opacity:0}to{opacity:1}}',
      '.dgp-pick-mask{animation:dgpFadeIn .12s ease-out}',
      '.dgp-pick-card{animation:dgpIn .16s ease-out}',
      // 目录行：整行可点（单击选中、双击进入），选中态沿用列表行那道品牌色短杠
      '.dgp-pick-row{display:flex;align-items:center;gap:7px;width:100%;padding:5px 9px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dgp-pick-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dgp-pick-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:-1px}',
      '.dgp-pick-row-selected{position:relative;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dgp-pick-row-selected::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#2563eb)}',
      // 面包屑与「显示隐藏文件」这类文字型小按钮
      '.dgp-pick-crumb{padding:2px 5px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#666666);font:inherit;white-space:nowrap;cursor:pointer}',
      '.dgp-pick-crumb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#111111)}',
      '.dgp-pick-crumb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:-1px}',
      // 尊重「减少动态效果」：所有装饰性动画一并关掉（转圈退化成静止小圈）
      '@media (prefers-reduced-motion: reduce){.dgp-panel,.dgp-pill{animation:none}.dgp-pulse,.dgp-spin{animation:none}.dgp-pick-mask,.dgp-pick-card{animation:none}}',
    ].join('')

    /** 局部样式表元素：跟着组件一起挂载/卸载，不产生全局副作用。 */
    function panelStyles() {
      return React.createElement('style', { key: 'dgp-css' }, PANEL_CSS)
    }

    /**
     * 把多行文本渲染成带分行的 <pre>：每行一个 <span>，按行首特征着色。
     * 文本内容一字不改（换行原样保留），所以「结果栏里有什么」仍然可以整段
     * 复制、搜索、被测试按纯文本断言。
     */
    function renderLines(text, style, classify, key, ref, ariaLive) {
      const lines = String(text).split('\n')
      return React.createElement('pre', {
        style: style,
        key: key,
        ref: ref,
        // 代码块的统一外观（细边框 + 圆角）由样式表给：内联只写文字与布局。
        className: 'dgp-pre',
        // 结果栏是异步写入的：让读屏软件把「刚才那条命令的结果」播报出来。
        'aria-live': ariaLive,
      },
        lines.map((line, index) => React.createElement('span', {
          key: 'l' + index,
          className: classify === undefined ? undefined : classify(line),
        }, index === lines.length - 1 ? line : line + '\n')))
    }

    /** diff 行着色：文件头/区块头/新增/删除各一色，其余保持默认前景色。 */
    function diffLineClass(line) {
      if (line.startsWith('@@')) return 'dgp-diff-line dgp-diff-hunk'
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')
        || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ')
        || line.startsWith('similarity index') || line.startsWith('old mode') || line.startsWith('new mode')) {
        return 'dgp-diff-line dgp-diff-meta'
      }
      if (line.startsWith('+')) return 'dgp-diff-line dgp-diff-add'
      if (line.startsWith('-')) return 'dgp-diff-line dgp-diff-del'
      return 'dgp-diff-line'
    }

    // ── 结果栏与按钮：小件 ────────────────────────────────────────────────

    /**
     * 命令结果行的前缀字符。**与 outputLineClass 是一对**：'⇢ ' 走 note 色、
     * '→ ' 走 hint 色，改一处必须改另一处，所以它们只在这里定义一次。
     */
    const OUT_CMD = '$ '
    const OUT_ERR = '[stderr] '
    const OUT_NOTE = '⇢ '
    const OUT_HINT = '→ '

    /** 命令结果行着色：命令回显、stderr、加速说明、下一步提示各一色。 */
    function outputLineClass(line) {
      if (line.startsWith(OUT_CMD)) return 'dgp-out-cmd'
      if (line.startsWith(OUT_ERR)) return 'dgp-out-err'
      if (line.startsWith(OUT_NOTE)) return 'dgp-out-note'
      if (line.startsWith(OUT_HINT)) return 'dgp-out-hint'
      return undefined
    }

    /**
     * 命令结果栏的文本行。文本一字不改，只是把「哪一行是什么」编码进前缀，
     * 再由 outputLineClass 还原成颜色 —— 整段结果因此仍可复制、搜索、被测试断言。
     */
    function opOutputLines(data) {
      const parts = []
      if (typeof data.command === 'string') parts.push(OUT_CMD + data.command)
      if (hasText(data.stdout)) parts.push(data.stdout.replace(/\s+$/, ''))
      if (hasText(data.stderr)) parts.push(OUT_ERR + data.stderr.replace(/\s+$/, ''))
      if (hasText(data.message)) parts.unshift(data.message)
      if (Array.isArray(data.notes)) {
        for (const note of data.notes) parts.push(OUT_NOTE + String(note))
      }
      if (hasText(data.hint)) parts.push(OUT_HINT + data.hint)
      return parts
    }

    /**
     * 按钮外观。primary = 主操作（实心品牌色）；danger = 破坏性操作（平时只用错误色
     * 文字，悬停才变实心，避免「丢弃改动」和普通按钮长得一样）；其余是次要按钮。
     *
     * 基础外观写在内联样式里（样式表没生效也不至于裸奔），悬停/按下/焦点环由
     * PANEL_CSS 提供 —— 内联优先级更高，所以那里的覆盖带 !important。
     */
    function buttonStyle(primary, disabled, danger, compact, hot) {
      const filled = primary === true
      const small = compact === true
      const accent = hot === true
      return {
        padding: small ? '2px 6px' : '4px 10px',
        borderRadius: small ? '6px' : '8px',
        fontSize: small ? '11px' : '12px',
        whiteSpace: 'nowrap',
        fontWeight: filled === true || accent === true ? 500 : 400,
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true ? 0.5 : 1,
        // hot：平时不动声色，只在「现在最该点它」时描一圈品牌色（例如脏工作区下的
        // 「安全拉取」）。它不改变按钮的主次关系，所以不抢「推送」的实心样式。
        border: filled === true || accent === true
          ? '1px solid var(--dsw-alias-brand-primary, #2563eb)'
          : '1px solid var(--dsw-alias-border-l2, #dddddd)',
        // 实心按钮的底色与文字色都必须走令牌：品牌色在浅色主题里接近黑、在深色主题里
        // 接近白，文字写死 #fff 在深色主题下就成了「白底白字」——按钮直接消失
        // （这正是空态里「初始化仓库 / 开始克隆」曾经的样子）。
        background: filled === true
          ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2563eb))'
          : 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
        color: filled === true
          ? 'var(--dsw-alias-label-primary-foreground, #ffffff)'
          : (danger === true
              ? 'var(--dsw-alias-state-error-primary, #dc2626)'
              : (accent === true ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-label-primary, #111111)')),
      }
    }

    /** 按钮的类名：实心/次要 + 危险色 + 悬停与焦点环（见 PANEL_CSS）。 */
    function buttonClass(primary, danger) {
      return 'dgp-btn'
        + (primary === true ? ' dgp-btn-primary' : ' dgp-btn-ghost')
        + (danger === true ? ' dgp-btn-danger' : '')
    }

    /**
     * 面板里的一个按钮。locked = 面板正忙（统一禁用，避免并发操作）。
     * compact 的按钮还要挂一个 .dgp-btn-compact —— 成排的小按钮（改动行里那三个）
     * 不能被样式表里「统一按钮高度」的规则撑高，否则一行改动会占掉两行的位置。
     */
    function panelButton(label, onClick, options) {
      const opts = options === null || options === undefined ? {} : options
      const primary = opts.primary === true
      const danger = opts.danger === true
      const locked = opts.locked === true
      const compact = opts.compact === true
      const hot = opts.hot === true
      return React.createElement('button', {
        key: opts.key === undefined ? label : opts.key,
        type: 'button',
        className: buttonClass(primary, danger) + (compact === true ? ' dgp-btn-compact' : ''),
        style: buttonStyle(primary, locked, danger, compact, hot),
        disabled: locked,
        title: typeof opts.title === 'string' && opts.title.length > 0 ? opts.title : undefined,
        onClick: onClick,
      }, label)
    }

    /**
     * 面板里的一个外链：外观与次要按钮一致，但语义是跳转而不是动作 ——
     * 「打开仓库页」这类入口必须用 <a>：浏览器会保留中键 / 长按 / 复制地址，
     * <button> 全都没有。新标签页打开（target=_blank），rel 带上 noopener。
     */
    function panelLink(label, href, title, key) {
      return React.createElement('a', {
        key: key,
        href: href,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: title,
        className: 'dgp-btn dgp-btn-ghost',
        style: buttonStyle(false, false, false),
      }, label)
    }

    // ── 派生小函数（纯计算，无状态） ──────────────────────────────────────

    /** 已暂存的条目数。 */
    function stagedCount(changes) {
      let staged = 0
      for (const item of changes) {
        if (item !== null && typeof item === 'object' && item.staged === true) staged += 1
      }
      return staged
    }

    /**
     * 改动摘要：**总数用宿主回的真实条数**（changesTotal），已暂存数只能按当前
     * 列表算（宿主最多回 100 条）。混用会让胶囊上的数字和「还有 N 处未显示」对不上。
     */
    function changesSummary(total, changes) {
      if (total === 0) return '没有改动'
      const staged = stagedCount(changes)
      return staged === 0 ? total + ' 处改动' : total + ' 处改动（' + staged + ' 已暂存）'
    }

    /**
     * 与上游的领先/落后摘要。
     * 没有上游时不显示「领先 N」——那种情况下推送失败的原因是没有目标，
     * 而不是有提交没推，提示成「领先」会误导用户。
     */
    function trackingSummary(snapshot) {
      if (snapshot === null || snapshot === undefined) return ''
      const ahead = typeof snapshot.ahead === 'number' ? snapshot.ahead : 0
      const behind = typeof snapshot.behind === 'number' ? snapshot.behind : 0
      if (ahead === 0 && behind === 0) return ''
      const parts = []
      if (ahead > 0) parts.push('领先 ' + ahead)
      if (behind > 0) parts.push('落后 ' + behind)
      return parts.join(' / ')
    }

    /** 已暂存的条目用成功色标出，和未暂存项一眼可分。 */
    function codeStyle(staged) {
      return staged === true
        ? Object.assign({}, S.code, { color: 'var(--dsw-alias-state-success-primary, #16a34a)' })
        : S.code
    }

    /**
     * 底部状态条上的那一句话：分支 + 改动数 + 领先/落后。
     *
     * 三样都拼进**同一个文本节点**（而不是并排的几个 span）：状态条是常驻信息，
     * 「main · 3 处改动未提交 · 领先 2」连起来读最省横向空间；也避免面板里多出一堆
     * 只含一个词的散节点 —— 那些节点会让「按文本找元素」（用户读屏、测试断言）变含糊。
     */
    /**
     * `origin/main` → `main`（上游短名）。远端名里含 `/` 时按**第一个**斜杠切 —— 与宿主
     * ops.js 的 upstreamRef 同一套切法：两边对「上游叫什么」的理解必须一致，否则面板
     * 会算出和宿主不一样的结论。
     */
    function upstreamShortName(upstream) {
      if (!hasText(upstream)) return null
      const text = String(upstream)
      const at = text.indexOf('/')
      return at > 0 && at < text.length - 1 ? text.slice(at + 1) : null
    }

    /**
     * 本地分支名和它跟踪的远端分支名是否不一致。
     *
     * 这不是「显示细节」：默认配置 `push.default=simple` 下裸 `git push` 会被 git
     * 直接拒绝（`fatal: The upstream branch … does not match …`），所以状态条要**提前**
     * 说一声 —— 而不是等用户点了推送，才看到一句没头没尾的英文。
     */
    function upstreamNameMismatch(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return false
      const branch = hasText(snapshot.branch) ? String(snapshot.branch) : ''
      const short = upstreamShortName(snapshot.upstream)
      return branch.length > 0 && short !== null && branch !== short
    }

    /**
     * 新建分支名是否撞上远端名（`origin/main` 这种）—— 与宿主 ops.js 的
     * branchNameRemoteConflict 同一判定。宿主那一侧会在建之前拒绝，这里在输入框旁边
     * 立刻说清楚（用户不用点一下才知道为什么不行）。
     */
    function branchNameRemoteConflict(name, remoteNames) {
      const draft = hasText(name) ? String(name).trim() : ''
      if (draft.length === 0) return null
      const list = Array.isArray(remoteNames) ? remoteNames : []
      for (const remote of list) {
        if (!hasText(remote)) continue
        if (draft.startsWith(String(remote) + '/')) return String(remote)
      }
      return null
    }

    function statusSummary(isRepo, snapshot, changesTotal) {
      if (isRepo !== true) return '还不是 Git 仓库 · 可以初始化或克隆一个'
      const branch = snapshot !== null && hasText(snapshot.branch) ? String(snapshot.branch) : '（尚无提交）'
      const parts = [branch, changesTotal > 0 ? changesTotal + ' 处改动未提交' : '工作区干净']
      const track = trackingSummary(snapshot)
      if (track.length > 0) parts.push(track)
      return parts.join(' · ')
    }

    /** 改动条目的稳定标识：同一个文件的「已暂存 / 未暂存」是两个不同的 diff。 */
    function changeKey(item) {
      return (item.staged === true ? 's:' : 'u:') + String(item.path)
    }

    // ── 目录选择小窗口：纯 helper ─────────────────────────────────────────
    //
    // 「切换目录」弹的小窗口跟 DSH「添加工作区」是同一个目录选择器（宿主
    // ctx.remote.directoryPicker 的 browse 能力：list / createDirectory）。
    // 宿主浏览器里那个对话框（DirectoryBrowser）是 ui-directory-picker-browse 包
    // 的内部组件，第三方插件 import 不到，所以面板里实现一个同交互的紧凑版：
    // 面包屑 + 目录列表 + 新建文件夹 + 直接输入路径，走的是同一条宿主通道。

    /**
     * 列表的路径分隔符：从宿主盖的 home 路径推断（不要从条目路径猜 —— POSIX 上
     * 反斜杠是合法的文件名字符）。
     */
    function pickSeparator(listing) {
      return listing !== null && typeof listing === 'object' && hasText(listing.home)
        ? (String(listing.home).includes('\\') ? '\\' : '/')
        : '/'
    }

    /**
     * 面包屑：home 子树内从「主目录」开始，子树外显示完整祖先链（根用它自己的
     * 路径作名字）。与宿主 DirectoryBrowser 的 displayCrumbs 同一套规则。
     */
    function pickCrumbs(listing) {
      if (listing === null || typeof listing !== 'object' || !Array.isArray(listing.crumbs)) return []
      const homeIndex = listing.crumbs.findIndex((crumb) => crumb !== null && typeof crumb === 'object' && crumb.path === listing.home)
      if (homeIndex === -1) return listing.crumbs
      return [{ name: '主目录', path: listing.home, hidden: false }].concat(listing.crumbs.slice(homeIndex + 1))
    }

    /** remote 调用的失败文本：优先取宿主业务消息（rpcError.message），没有就退回普通错误文本。 */
    function pickFailureText(error) {
      if (error !== null && typeof error === 'object' && 'rpcError' in error) {
        const rpcError = error.rpcError
        if (rpcError !== null && typeof rpcError === 'object' && hasText(rpcError.message)) return String(rpcError.message)
      }
      return error !== null && typeof error === 'object' && hasText(error.message) ? String(error.message) : String(error)
    }

    /**
     * 这次失败是不是「宿主的目录选择器只组合了系统对话框（native），网页里列不了目录」。
     *
     * 宿主把两种交互做成同一个 remote 命名空间的两个能力：list / createDirectory 要
     * browse，pick 要 native，一次启动只组合其中一种，另一种调用会被拒绝并回
     * `directory-picker/unavailable`（details.capability 是**实际组合出来**的那种）。
     * 以 127.0.0.1 启动的本机 DSH 组合的就是 native —— 这时小窗口不该把宿主的
     * 英文错误甩给用户，而该改走 pick（系统对话框）。
     */
    function isBrowseUnavailable(error) {
      const rpcError = error !== null && typeof error === 'object' && 'rpcError' in error ? error.rpcError : null
      if (rpcError === null || typeof rpcError !== 'object') return false
      if (rpcError.code !== 'directory-picker/unavailable') return false
      const details = rpcError.details
      if (details === null || details === undefined || typeof details !== 'object') return true
      // 组合出来的是 browse 却在 list 上失败，就不是这个场景（另走普通错误显示）。
      return details.capability === undefined || details.capability === 'native'
    }

    // ── 面板状态：一个 reducer 管全部 ─────────────────────────────────────
    //
    // 为什么不是一堆 useState：面板上有一批状态属于**某个具体仓库**（命令结果、
    // 展开的 diff、分支列表、提交草稿、远程地址草稿、待选选项…）。用独立 state 时，
    // 换工作区必须逐个手写清理，**漏一个就会把旧仓库的数据显示成新仓库的**——
    // 上一版就漏了 branchDraft（换工作区后「新建分支」的输入框里还留着上一个仓库的
    // 名字）。收进一个 reducer 后，清理只有一个动作（'reset-repo'），新增字段不可能再漏。
    // 注意：目录选择小窗口（pick* 字段）是**界面开关**，不属于任何仓库 —— 它由
    // openPicker / closePicker 自己成对清空，与 'reset-repo' 无关。

    const PANEL_INITIAL = {
      minimized: readStoredMinimized(),
      // 面板宽度：null = 用默认 360px；调过就记在 localStorage 里。
      width: readStoredWidth(),
      workdir: '',
      picked: false,
      // ── 目录选择小窗口（与 DSH「添加工作区」同一个目录选择器） ──────────
      // 点仓库卡的「切换」弹出：目录浏览 / 直接输入路径 / 新建文件夹。
      // 它只回答「面板接下来看哪个目录」，不注册 workspace、不开新会话。
      pickerOpen: false,
      // 宿主这次组合出来的目录选择器只提供系统对话框（browse 能力缺席）时为 true：
      // 网页里列不了目录，小窗口改成「打开系统对话框 / 手输绝对路径」两条路。
      pickNative: false,
      pickLevel: null,
      pickSelected: null,
      pickBusy: false,
      pickError: '',
      pickShowHidden: false,
      pickDraft: null,
      pickFolder: null,
      pickCreating: false,
      pickCreateError: '',
      snapshot: null,
      busy: false,
      message: '',
      output: '',
      // 上一次操作的结果（null = 还没操作过）：底部状态条上那个小点的颜色。
      lastOk: null,
      cloneUrl: '',
      showClone: false,
      cloneShallow: false,
      remoteUrl: '',
      remoteName: 'origin',
      showRemote: false,
      remoteDirty: false,
      remoteError: '',
      remoteCopied: false,
      showBranches: false,
      branches: null,
      remoteBranches: null,
      branchDraft: '',
      diffKey: '',
      diffText: '',
      choices: null,
      logRef: '',
      logText: '',
      showStash: false,
      stashList: [],
      commitAmend: false,
      pullRebase: false,
      net: null,
      showNet: false,
      netProxy: '',
      netProbe: null,
      netBusy: false,
    }

    /**
     * 属于「上一个仓库」的字段。界面开关（是否最小化、加速设置是否展开、网络配置）
     * 不属于任何一个仓库，因此不在这里清。
     */
    const REPO_RESET = {
      output: '',
      // 状态条上那个点表示「上一次操作成没成」——那是上一个仓库的操作，跟着一起清。
      lastOk: null,
      diffKey: '',
      diffText: '',
      branches: null,
      remoteBranches: null,
      showBranches: false,
      message: '',
      remoteError: '',
      remoteDirty: false,
      choices: null,
      branchDraft: '',
      // 提交详情、stash 列表与远程地址草稿同理：它们都是「上一个仓库的运行结果」，
      // 跟着仓库一起清（否则新仓库的面板里会挂着旧仓库的 commit 详情）。
      logRef: '',
      logText: '',
      showStash: false,
      stashList: [],
      remoteCopied: false,
    }

    function panelReducer(state, action) {
      if (action.type === 'patch') return Object.assign({}, state, action.patch)
      if (action.type === 'reset-repo') return Object.assign({}, state, REPO_RESET)
      return state
    }

    /** 一次最多渲染多少条改动（宿主最多回 100 条，超出部分在列表末尾明确说明）。 */
    const CHANGES_SHOWN = 40

    // ── useGitPanel：状态 + 动作 ──────────────────────────────────────────

    /**
     * 面板的全部状态与动作。GitPanel 只负责把结果画出来。
     *
     * 所有异步结果都要过两道归属校验：
     *   · 请求序号 —— 切工作区时上一条 state 请求可能还在飞，迟到的旧状态不能盖回去；
     *   · 目录归属 —— 拉取/推送/克隆在宿主侧的超时是 10 分钟，用户完全可能在结果
     *     回来之前就切到别的工作区去了；这时整条结果必须丢弃。
     */
    function useGitPanel(props) {
      const [state, dispatch] = React.useReducer(panelReducer, PANEL_INITIAL)
      const patch = React.useCallback((fields) => dispatch({ type: 'patch', patch: fields }), [])

      // 面板当前绑在哪个仓库目录上（宿主归一化后的绝对路径；null = 还不知道）。
      const shownDirRef = React.useRef(null)
      // 状态请求序号：同时只认最新一次请求的结果。
      const loadSeqRef = React.useRef(0)
      // 展开的 diff 元素：点开之后要把它滚进可视区（改动清单与面板正文都可能要滚）。
      const diffRef = React.useRef(null)
      // 命令结果栏：操作成功后把它滚进视口并闪一下（结果栏在最底部，容易被忽略）。
      const outRef = React.useRef(null)
      // 面板正文的滚动区：底部状态条被点一下时用它回到顶部。
      const bodyRef = React.useRef(null)
      // 「下一次 output 变化要闪一下」的标记：只有操作**成功**时才置位，
      // 所以「执行中…」和失败路径不会触发。
      const flashRef = React.useRef(false)

      // 目录选择小窗口的归属校验（与 loadSeqRef 同一套思路）：
      //   · 代（gen）—— 窗口每打开/关闭一次就换代，迟到的响应一律丢弃；
      //   · 序号（seq）—— 同一次打开里多次列出，只认最新那一次；
      //   · abort —— 在飞的列出请求直接掐断，不让宿主白扫（browse 的 list 支持
      //     调用方取消；老环境没有 AbortController 就退化成只丢弃结果）。
      const pickGenRef = React.useRef(0)
      const pickSeqRef = React.useRef(0)
      const pickAbortRef = React.useRef(null)

      // 当前会话的工作目录（shell.overlay 提供的标准 props）。
      //
      // 「当前会话」怎么认：`shell.overlay` 是 **root scope** 的插槽，拿不到 `sessionId`
      // （那是 session / session-maybe scope 才有的标准 props）。root scope 能用的只有
      // `useSessions` —— 一个对 SessionListState 取选择器的钩子，而那份 state 的字段只有
      // ids / byId / phase / subagentsByParent / jobsBySession。所以「当前会话」必须从列表里
      // 认「被主视图持有的那一行」（retainedBy.mainView > 0）：宿主自己的 publishMain
      // 与 ui-workspace 的 mainSessionId 用的就是这个判据。
      //
      // 早先这里读的是 `state.current` —— SessionListState 上**根本没有这个字段**，
      // 于是 sessionCwd 恒为 undefined：面板从不把 dir 发给宿主，宿主只能退回自己的缺省
      // 目录，"跟随会话"从来没生效过。当时测试里的假 store 也照抄了同一个不存在的字段，
      // 所以测试一直是绿的 —— 这里的形状必须与真实契约一致，见 test/client.test.mjs。
      const useSessions = props !== null && props !== undefined && typeof props.useSessions === 'function'
        ? props.useSessions
        : null
      const sessionCwd = useSessions === null ? undefined : useSessions((store) => {
        if (store === null || store === undefined) return undefined
        const rows = store.byId
        if (rows === undefined || rows === null) return undefined
        for (const row of Object.values(rows)) {
          if (row === null || row === undefined) continue
          const retained = row.retainedBy
          if (retained === null || retained === undefined || !((retained.mainView ?? 0) > 0)) continue
          return hasText(row.cwd) ? row.cwd : undefined
        }
        return undefined
      })

      /**
       * 读一次仓库状态。序号校验保证只有最新那次的结果会被采用。
       * @param silent - 后台刷新（窗口重新获得焦点、脏工作区轮询）用：不点亮
       *   「同步中…」也不在失败时把结果栏刷成错误 —— 这类刷新是顺手做的，
       *   失败了不该打扰正在操作的人。
       */
      const load = async (requested, silent) => {
        const seq = ++loadSeqRef.current
        if (silent !== true) patch({ busy: true })
        try {
          const data = await fetchState(typeof requested === 'string' ? requested : '')
          // 期间又切换过一次：这条响应已经过时，丢掉 —— 否则旧目录的状态会把刚切
          // 过去的面板盖回去。（过期的这一条不碰 busy：锁归最新那次请求收尾。）
          if (seq !== loadSeqRef.current) return
          const nextDir = hasText(data.dir) ? data.dir : null
          const previousDir = shownDirRef.current
          shownDirRef.current = nextDir
          const fields = { snapshot: data }
          // 「换目录」才清掉上一轮「需要你选一个结果」的选项；**同一个目录的刷新不清**：
          // 窗口失焦再回来会触发一次后台刷新，若照清不误，用户正盯着看的
          // 「两套历史无关」按钮会在眼皮底下消失。
          if (nextDir !== null && nextDir !== previousDir) fields.choices = null
          if (nextDir !== null) fields.workdir = nextDir
          patch(fields)
        } catch (error) {
          if (seq !== loadSeqRef.current) return
          if (silent !== true) {
            patch({ output: '读取状态失败：' + String(error && error.message ? error.message : error) })
          }
        }
        if (silent !== true) patch({ busy: false })
      }

      /**
       * 清掉「属于上一个工作区」的瞬时结果（见 REPO_RESET）。
       *
       * **不能把它挂在「目录变了」上**：克隆成功后也会换目录，但那时输出正是用户要看
       * 的克隆结果。所以只在真正由用户发起的切换入口调用（见 switchDir）。
       */
      const forgetRepoDetails = () => dispatch({ type: 'reset-repo' })

      /**
       * 切换工作区：先清掉上一个工作区的运行结果，再加载新目录。
       * 「换一个仓库看」的入口都必须走这里 —— 这是「命令结果栏跟着工作区走」的
       * 唯一保证点。
       */
      const switchDir = (target) => {
        forgetRepoDetails()
        load(target)
      }

      // ── 目录选择小窗口：动作 ─────────────────────────────────────────────
      //
      // 与 DSH「添加工作区」共享同一个目录选择器：宿主那个对话框内部也是调
      // `uiWorkspace.listDirectory` / `createDirectory`（见 ui-directory-picker-browse
      // 的注入面），这里用的是同一个服务、同一条 wire，所以权限与错误消息一致。
      //
      // 服务由 apply 通过 props.getPicker() 交给面板（live getter，取一次没用完
      // 就接着取）；拿不到就退化成「只能直接输入绝对路径」。

      /** 此刻的宿主目录选择器（list / createDirectory）；不可用返回 null。 */
      const resolvePicker = () => {
        const getter = props !== null && props !== undefined && typeof props.getPicker === 'function'
          ? props.getPicker
          : null
        if (getter === null) return null
        try {
          return getter()
        } catch (error) {
          return null
        }
      }

      /**
       * 打开小窗口：清掉上次的状态，从宿主主目录开始列。
       * 不动面板当前绑定的仓库 —— 选完并确认才切（见 pickConfirm）。
       */
      const openPicker = () => {
        pickGenRef.current += 1
        pickSeqRef.current = 0
        patch({
          pickerOpen: true, pickNative: false, pickLevel: null, pickSelected: null, pickBusy: false,
          pickError: '', pickShowHidden: false, pickDraft: null, pickFolder: null,
          pickCreating: false, pickCreateError: '',
        })
        pickList('')
      }

      /** 关掉小窗口：掐断在飞的列出，丢弃一切迟到结果。 */
      const closePicker = () => {
        pickGenRef.current += 1
        pickSeqRef.current = 0
        if (pickAbortRef.current !== null && pickAbortRef.current !== undefined) {
          pickAbortRef.current.abort()
          pickAbortRef.current = null
        }
        patch({
          pickerOpen: false, pickNative: false, pickLevel: null, pickSelected: null, pickBusy: false,
          pickError: '', pickShowHidden: false, pickDraft: null, pickFolder: null,
          pickCreating: false, pickCreateError: '',
        })
      }

      /** 列出目录，rawPath 为空串列宿主主目录。迟到/被取代的响应一律丢弃。 */
      const pickList = async (rawPath) => {
        const api = resolvePicker()
        if (api === null) {
          patch({ pickError: '宿主没有提供目录浏览服务：可以直接在上方输入绝对路径后回车，一步切换过去。' })
          return
        }
        const gen = pickGenRef.current
        const seq = ++pickSeqRef.current
        if (pickAbortRef.current !== null && pickAbortRef.current !== undefined) pickAbortRef.current.abort()
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        pickAbortRef.current = controller
        patch({ pickBusy: true, pickError: '' })
        try {
          const listing = await api.list(rawPath === '' || rawPath === undefined ? undefined : rawPath,
            controller === null ? undefined : controller.signal)
          if (gen !== pickGenRef.current || seq !== pickSeqRef.current) return
          patch({ pickLevel: listing, pickSelected: null, pickBusy: false })
        } catch (error) {
          if (gen !== pickGenRef.current || seq !== pickSeqRef.current) return
          if (isBrowseUnavailable(error)) {
            // 宿主组合的是系统对话框：不报错，换成「系统对话框 / 手输路径」那一版界面。
            patch({ pickBusy: false, pickError: '', pickNative: true })
            return
          }
          patch({ pickBusy: false, pickError: pickFailureText(error) })
        }
      }

      /** 选一行（单击）：记成「待选择的目录」，不导航。 */
      const pickSelect = (entry) => {
        if (entry === null || typeof entry !== 'object' || !hasText(entry.path)) return
        patch({ pickSelected: entry, pickDraft: null })
      }

      /** 进入一行（双击 / 回车）：把它列成当前目录。 */
      const pickEnter = (entry) => {
        if (entry === null || typeof entry !== 'object' || !hasText(entry.path)) return
        pickList(entry.path)
        patch({ pickDraft: null })
      }

      /** 点面包屑跳到某个祖先目录。 */
      const pickCrumb = (path) => {
        if (!hasText(path)) return
        pickList(path)
      }

      /** 打开路径输入：从「选中的目录 ?? 当前显示目录」接续，末尾补分隔符。 */
      const pickDraftStart = () => {
        const level = state.pickLevel
        const base = state.pickSelected !== null && state.pickSelected !== undefined && hasText(state.pickSelected.path)
          ? state.pickSelected.path
          : (level !== null && level !== undefined && hasText(level.path) ? level.path : '')
        if (base.length === 0) {
          patch({ pickDraft: '' })
          return
        }
        const sep = pickSeparator(level)
        patch({ pickDraft: base.endsWith('/') || base.endsWith('\\') ? base : base + sep })
      }

      /** 取消路径输入，回到面包屑。 */
      const pickDraftCancel = () => patch({ pickDraft: null })

      /** 提交路径：有浏览能力就列那个目录；没有（或宿主只给系统对话框）就直接切过去（一步到位）。 */
      const pickDraftSubmit = () => {
        const draft = state.pickDraft
        if (draft === null || typeof draft !== 'string') return
        const trimmed = draft.trim()
        if (trimmed.length === 0) return
        patch({ pickDraft: null })
        if (resolvePicker() === null || state.pickNative === true) {
          closePicker()
          patch({ picked: true })
          switchDir(trimmed)
          return
        }
        pickList(trimmed)
      }

      /**
       * 用宿主的系统对话框选目录 —— 宿主这次只组合了 native 能力时的正道。
       *
       * 选到就关窗切过去；用户取消（返回空）就留在小窗口里，不静默关窗；失败把
       * 宿主的消息显示出来，并提示手输路径这条保底路。
       */
      const pickSystem = async () => {
        const api = resolvePicker()
        if (api === null || typeof api.pick !== 'function') {
          patch({ pickError: '宿主没有提供目录选择服务：可以直接在上方输入绝对路径后回车，一步切换过去。' })
          return
        }
        const gen = pickGenRef.current
        patch({ pickBusy: true, pickError: '' })
        try {
          const chosen = await api.pick()
          if (gen !== pickGenRef.current) return
          patch({ pickBusy: false })
          if (!hasText(chosen)) return
          closePicker()
          patch({ picked: true })
          switchDir(String(chosen))
        } catch (error) {
          if (gen !== pickGenRef.current) return
          patch({ pickBusy: false, pickError: pickFailureText(error) })
        }
      }

      /** 确认选择：选中的目录 ?? 当前显示的目录，关窗并切过去。 */
      const pickConfirm = () => {
        const level = state.pickLevel
        const target = state.pickSelected !== null && state.pickSelected !== undefined && hasText(state.pickSelected.path)
          ? state.pickSelected.path
          : (level !== null && level !== undefined && hasText(level.path) ? level.path : '')
        if (target.length === 0) return
        closePicker()
        patch({ picked: true })
        switchDir(target)
      }

      /** 打开「新建文件夹」小窗口。 */
      const pickCreateStart = () => patch({ pickFolder: '', pickCreateError: '' })

      /** 收起「新建文件夹」小窗口。 */
      const pickCreateCancel = () => patch({ pickFolder: null, pickCreateError: '' })

      /** 确认新建：在「选中的目录 ?? 当前显示目录」里创建，成功后面板选中它。 */
      const pickCreate = async () => {
        const draft = state.pickFolder
        if (draft === null || typeof draft !== 'string') return
        if (draft.trim().length === 0) return
        const level = state.pickLevel
        const parentPath = state.pickSelected !== null && state.pickSelected !== undefined && hasText(state.pickSelected.path)
          ? state.pickSelected.path
          : (level !== null && level !== undefined && hasText(level.path) ? level.path : '')
        if (parentPath.length === 0) {
          patch({ pickCreateError: '还没有可创建目录的位置' })
          return
        }
        const api = resolvePicker()
        if (api === null || state.pickNative === true) {
          patch({ pickCreateError: '宿主没有提供目录浏览服务' })
          return
        }
        const gen = pickGenRef.current
        patch({ pickCreating: true, pickCreateError: '' })
        try {
          const created = await api.createDirectory(parentPath, draft)
          if (gen !== pickGenRef.current) return
          patch({ pickFolder: null, pickCreating: false })
          // 重新列出父目录并选中新建的文件夹（与宿主浏览器同一套落地姿态）。
          await pickList(parentPath)
          if (gen !== pickGenRef.current) return
          patch({ pickSelected: { name: draft, path: String(created), hidden: false } })
        } catch (error) {
          if (gen !== pickGenRef.current) return
          patch({ pickCreating: false, pickCreateError: pickFailureText(error) })
        }
      }

      // ── 网络加速：读写宿主配置 ──────────────────────────────────────────
      //
      // 这里不缓存任何「加速是否生效」的判断，一律以宿主返回的视图为准 —— 真正决定
      // git 怎么执行的是宿主，面板只是它的界面，两边各存一份状态迟早会对不上。

      /**
       * 读宿主配置。refreshProxy=true 时连输入框草稿一起刷新；用户正在打字时不能刷，
       * 否则一个无关的开关动作会把没保存的代理地址抹掉。
       */
      const loadNet = async (refreshProxy) => {
        try {
          const response = await fetch('/git-panel/net', { cache: 'no-store' })
          const data = rememberCsrf(await response.json().catch(() => null))
          if (isOk(data) !== true) return
          const fields = { net: data }
          if (refreshProxy === true) fields.netProxy = hasText(data.proxy) ? data.proxy : ''
          patch(fields)
        } catch (error) {
          // 网络加速只是为了修「连不上」，它自己读不到绝不能让面板跟着坏掉。
        }
      }

      /** 保存配置。changes 里只放要改的字段，其余保持不动。 */
      const saveNet = async (changes, refreshProxy) => {
        patch({ netBusy: true })
        try {
          const response = await fetch('/git-panel/net', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(withCsrf(changes)),
          })
          const data = rememberCsrf(await response.json().catch(() => null))
          if (isOk(data) !== true) {
            patch({ output: '保存网络加速设置失败：' + whyFailed(data, response.status) })
            return
          }
          const fields = { net: data }
          if (refreshProxy === true) fields.netProxy = hasText(data.proxy) ? data.proxy : ''
          patch(fields)
        } catch (error) {
          patch({ output: '保存网络加速设置失败：' + String(error && error.message ? error.message : error) })
        } finally {
          patch({ netBusy: false })
        }
      }

      /** 现场实测每条线路（直连 / 各镜像 / 代理），把结果原样列出来。 */
      const probeNet = async () => {
        patch({ netBusy: true, netProbe: null })
        try {
          const response = await fetch('/git-panel/net?probe=1', { cache: 'no-store' })
          const data = await response.json().catch(() => null)
          if (isOk(data) !== true) {
            patch({ output: '检测网络失败：HTTP ' + response.status })
            return
          }
          patch({ netProbe: Array.isArray(data.results) ? data.results : [] })
        } catch (error) {
          patch({ output: '检测网络失败：' + String(error && error.message ? error.message : error) })
        } finally {
          patch({ netBusy: false })
        }
      }

      /**
       * 执行一个操作。
       * @param options.quiet - 数据型操作（列分支、查 diff）不回显命令输出，避免把
       *   结果栏刷成一大段 git 原文；失败时仍回显，保证错误可见。
       * @param options.state - false 时请求带 noState，宿主跳过仓库状态回读（每次省
       *   4 条 git 进程）。这类操作只读、不写结果栏，因此不参与「归属校验」。
       */
      const runOp = async (op, extra, options) => {
        const opts = options === null || options === undefined ? {} : options
        const quiet = opts.quiet === true
        const wantState = opts.state !== false
        patch({ busy: true })
        if (quiet !== true) patch({ output: '执行中…' })
        // data 必须声明在 try **外面**：它在 try 里赋值、在 try 之后返回。
        // 若用 `const data` 声明在 try 里，后面的 `return data` 会抛 ReferenceError
        // （块级作用域），于是每次 runOp 都以 rejected promise 结束 —— 宿主侧 git
        // 明明执行成功了，调用方却永远拿不到返回值：diff 停在「加载中…」、
        // 分支管理器列不出分支、推送失败的自愈提示不再出现。
        let data
        try {
          const payload = { op: op }
          if (hasText(state.workdir)) payload.dir = state.workdir
          if (extra !== null && extra !== undefined) {
            for (const key of Object.keys(extra)) payload[key] = extra[key]
          }
          if (wantState !== true) payload.noState = true
          data = await postOp(payload)
          // 这条结果是哪个仓库的？宿主在 state.dir 里回了这次操作真正作用的目录。
          const resultDir = data.state !== null && typeof data.state === 'object' && hasText(data.state.dir)
            ? data.state.dir
            : null
          // 操作跑得比用户切换工作区慢时（拉取/推送/克隆的宿主超时是 10 分钟），结果
          // 回来时面板已经绑在另一个仓库上了。这时必须**整条丢弃**：既不能把旧仓库的
          // 输出写进命令结果栏，也不能用旧仓库的状态盖掉新仓库的面板。
          // 只有两边目录都确知、且确实不同才丢；信息不全（state/dir 缺失）一律照单
          // 接收 —— 宁可少拦一次，也不能把真实输出吞掉。
          const stale = resultDir !== null && shownDirRef.current !== null && resultDir !== shownDirRef.current
          // 判定是「网络连不上」时自动展开加速设置：提示里说了「点 🌐」，那就替用户点开，
          // 否则他还要自己找那个按钮在哪。
          if (data.network === true) patch({ showNet: true })
          if (stale !== true) {
            if (resultDir !== null) shownDirRef.current = resultDir
            const fields = {}
            if (quiet !== true || data.ok !== true) {
              const lines = opOutputLines(data)
              fields.output = lines.length > 0 ? lines.join('\n') : '完成'
              // 成功、且真的写了结果栏 → 下一次渲染把结果栏滚进视口并闪一下。
              if (data.ok === true) flashRef.current = true
            }
            if (data.state !== null && typeof data.state === 'object') fields.snapshot = data.state
            // 底部状态条上那个小点的颜色跟着「上一次操作成没成」走：成功绿、
            // 失败红。它回答的是「我刚才那一下到底行不行」，所以用 ok 而不是有无 stderr。
            fields.lastOk = data.ok === true
            // 宿主有时会回一组「需要你选一个结果」的选项（例如拉取撞上两套互不相关的
            // 历史）。渲染成按钮，用户点一下就把决定交给面板去执行。
            fields.choices = Array.isArray(data.choices) && data.choices.length > 0 ? data.choices : null
            patch(fields)
          }
        } catch (error) {
          const reason = String(error && error.message ? error.message : error)
          patch({ output: '操作失败：' + reason, lastOk: false })
          // 归一化成失败结果：调用方统一用 data.ok 判断，否则只会得到「未知错误」。
          data = { ok: false, message: reason }
        }
        patch({ busy: false })
        return data
      }

      /**
       * 执行宿主给出的一个「选择」。
       *
       * 这类按钮常常是不可逆的（例如「让当前分支直接变成远端那份」），所以：
       *   · 带 confirm 的必须先确认，用户取消就什么都不做；
       *   · 执行前先 forgetRepoDetails()：切换分支/覆盖工作区之后，旧的分支列表、
       *     diff、上一轮输出都属于「上一份内容」，留着就是谎报。
       */
      const runChoice = async (choice) => {
        const op = typeof choice.op === 'string' ? choice.op : ''
        if (op.length === 0) return
        if (hasText(choice.confirm) && window.confirm(choice.confirm) !== true) return
        forgetRepoDetails()
        await runOp(op, choice.params !== null && typeof choice.params === 'object' ? choice.params : null)
      }

      /**
       * 拉分支列表（本地 + 远端）。**一次 op 拿两份**：宿主对 branches 会把
       * remoteBranches 一起解析回来，且数据型操作不回读仓库状态（noState）——
       * 原先这里连发两次 op，每次都要额外跑 4 条 git，展开一次管理器就是 10 条进程。
       */
      const fetchBranches = async () => {
        const data = await runOp('branches', null, { quiet: true, state: false })
        if (isOk(data) !== true) return
        const fields = {}
        if (data.branches !== null && data.branches !== undefined) fields.branches = data.branches
        if (data.remoteBranches !== null && data.remoteBranches !== undefined) {
          fields.remoteBranches = data.remoteBranches
        }
        if (Object.keys(fields).length > 0) patch(fields)
      }

      /** 展开/收起分支管理器：展开时拉一次列表，保证和当前仓库一致。 */
      const toggleBranches = () => {
        const next = state.showBranches !== true
        patch({ showBranches: next })
        if (next === true) fetchBranches()
      }

      /**
       * stash 备份列表（数据型操作，不回读仓库状态）。
       * 「安全拉取」「安全切分支」留下的备份在这里能看到、能恢复、能删除 ——
       * 否则弹回冲突时用户只能被指去终端敲 git stash pop。
       */
      const fetchStashList = async () => {
        const data = await runOp('stashList', null, { quiet: true, state: false })
        if (isOk(data)) patch({ stashList: Array.isArray(data.stash) ? data.stash : [] })
      }

      /** 展开/收起 stash 备份区：展开时拉一次列表。 */
      const toggleStash = () => {
        const next = state.showStash !== true
        patch({ showStash: next })
        if (next === true) fetchStashList()
      }

      /** 恢复某份 stash（git stash apply，**不删除**备份，用户确认没问题再点删除）。 */
      const doStashApply = async (item) => {
        const data = await runOp('stashApply', { ref: item.ref })
        if (isOk(data)) await fetchStashList()
      }

      /** 删除某份 stash（不可逆，必须先确认）。 */
      const doStashDrop = async (item) => {
        const ok = window.confirm('确定删除 ' + item.ref + ' 吗？\n\n'
          + '· 这份备份里的改动会永久丢失（不可恢复）\n'
          + '· 如果它已经 apply 回工作区，删除它只是清掉备份，不影响工作区\n\n'
          + '内容：' + item.text)
        if (ok !== true) return
        const data = await runOp('stashDrop', { ref: item.ref })
        if (isOk(data)) await fetchStashList()
      }

      // 下面这些动作都**不再手动 load()**：宿主在 op 响应里已经带回了最新状态，
      // runOp 会把它写进 snapshot。手动再拉一次状态是纯浪费（每次 4 条 git 进程）。

      /**
       * 切换分支。工作区有未提交改动时走「安全切分支」（stashSwitch）：
       * git 的裸 switch 在脏工作区上会被拒绝，而「先自己 commit / stash 再切」
       * 正是安全拉取已经替用户铺好的那条路 —— 这里对称地铺一遍。
       */
      const doCheckout = async (name) => {
        const dirty = state.snapshot !== null && typeof state.snapshot.changesTotal === 'number'
          && state.snapshot.changesTotal > 0
        if (dirty) {
          const question = '工作区还有 ' + state.snapshot.changesTotal + ' 处未提交的改动，直接切换会被 git 拒绝。\n\n'
            + '用「安全切分支」：先把改动（含未跟踪文件）自动藏起来，切到 ' + name + ' 后原样恢复；\n'
            + '切换失败也会自动还给你。\n\n确定这样切换吗？'
          if (window.confirm(question) !== true) return
          const data = await runOp('stashSwitch', { branch: name })
          if (isOk(data)) await fetchBranches()
          return
        }
        const data = await runOp('checkout', { branch: name })
        if (isOk(data)) await fetchBranches()
      }

      /** 给当前分支改名（git branch -m）。名字必须由用户输入，不猜。 */
      const doRenameBranch = async () => {
        if (typeof window.prompt !== 'function') return
        const next = window.prompt('给当前分支换个名字：', '')
        if (next === null) return
        const name = String(next).trim()
        if (name.length === 0) return
        const data = await runOp('renameBranch', { name: name })
        if (isOk(data)) await fetchBranches()
      }

      /** 新建分支并切换（输入框回车或点按钮）。 */
      const doCreateBranch = async () => {
        const name = state.branchDraft.trim()
        if (name.length === 0) return
        // 输入框的回车**不经过按钮的 disabled**，所以这里必须再拦一次；宿主也会拒
        // （同一判定，见 ops.js 的 branchNameRemoteConflict）。所以不变量有三层：
        // 按钮锁住 / 这里挡住 / 宿主兜底。
        const remotes = state.snapshot !== null && Array.isArray(state.snapshot.remotes)
          ? state.snapshot.remotes
          : []
        const conflict = branchNameRemoteConflict(
          name,
          remotes.map((item) => (item !== null && typeof item === 'object' ? item.name : null)),
        )
        if (conflict !== null) {
          patch({
            output: '分支名 ' + name + ' 和远端名 ' + conflict + ' 撞了：' + conflict
              + '/… 是它的远端跟踪引用，本地再建一个同名分支会让两个引用产生歧义（git 会开始报 ambiguous）。'
              + '去掉前缀再建即可。',
          })
          return
        }
        const data = await runOp('createBranch', { branch: name })
        if (isOk(data)) patch({ branchDraft: '', showBranches: false })
      }

      /** 删除分支：只做安全删除（-d，未合并会被 git 拒绝）。 */
      const doDeleteBranch = async (name) => {
        if (window.confirm('确定删除分支 ' + name + '？\n（仅安全删除：含未合并提交的分支会被拒绝，避免误删历史。）')) {
          const data = await runOp('deleteBranch', { branch: name })
          if (isOk(data)) await fetchBranches()
        }
      }

      /**
       * 点远端分支的「拿成新分支」：把远端那一份开成一个本地新分支并切过去
       * （宿主执行 `git switch -c <remote>-<branch> <remote>/<branch>`）。
       * 当前分支一点都不动 —— 「本地 master、远端 main」时这是最安全的那条路。
       * 远端分支名**显式传给宿主**：这一条的正常场景恰恰是两边名字不一样。
       */
      const doAdoptRemoteBranch = async (item) => {
        const data = await runOp('adoptRemote', { mode: 'branch', remote: item.remote, branch: item.name })
        if (isOk(data)) await fetchBranches()
      }

      /**
       * 点远端分支的「比较」：宿主跑 `git rev-list --left-right --count HEAD...<ref>`，
       * 原始输出只是两列数字，所以由宿主翻成人话放进 notes 一起回显 ——
       * 这条**故意不 quiet**：notes 就是用户要看的结论。
       */
      const doCompareRemoteBranch = async (item) => {
        await runOp('compare', { ref: item.ref }, { state: false })
      }

      /**
       * 点改动条目查看 diff：再点同一条目收起。
       * untracked 文件没有 diff 内容，给一句中文说明而不是空白的输出框。
       */
      const showDiff = async (item) => {
        const key = changeKey(item)
        if (state.diffKey === key) {
          patch({ diffKey: '', diffText: '' })
          return
        }
        patch({ diffKey: key, diffText: '加载中…' })
        const data = await runOp(
          'diff',
          { path: String(item.path), cached: item.staged === true },
          { quiet: true, state: false },
        )
        if (isOk(data)) {
          const text = hasText(data.diff) ? data.diff : ''
          if (typeof item.code === 'string' && item.code.charAt(0) === '?' && text.trim().length === 0) {
            patch({ diffText: '未跟踪文件没有 diff（还没进入版本库）：先「全部暂存」，再点开看已暂存版本。' })
          } else {
            patch({ diffText: hasText(text) ? text : '（这个改动没有可显示的 diff 内容）' })
          }
        } else {
          patch({ diffText: '查看 diff 失败：' + whyFailed(data, '未知错误') })
        }
      }

      // ── 单个改动的三个按钮（暂存 / 取消暂存 / 还原） ────────────────────
      //
      // 面板原先只有「全部暂存」「丢弃改动」两个全量动作：只想提交其中一个文件时，
      // 只能去终端或找 AI。这三个动作正好补齐日常操作的最小闭环。

      /** 暂存这个文件（未跟踪文件也走这条，等价 git add -- <path>）。 */
      const doStageFile = async (item) => {
        await runOp('add', { path: String(item.path) }, { quiet: true })
      }

      /** 取消暂存这个文件：只动暂存区，工作区内容保留（git restore --staged）。 */
      const doUnstageFile = async (item) => {
        await runOp('unstageFile', { path: String(item.path) }, { quiet: true })
      }

      /** 还原这个文件的未提交改动（不可恢复，必须确认）。 */
      const doRestoreFile = async (item) => {
        const ok = window.confirm('确定还原 ' + item.path + ' 的未提交改动吗？\n\n'
          + '· 这个文件在工作区的改动会丢失（不可恢复）\n'
          + '· 已经暂存的部分不受影响')
        if (ok !== true) return
        await runOp('restoreFile', { path: String(item.path) }, { quiet: true })
      }

      /**
       * 点最近提交的一行看详情：再点同一行收起。
       * 详情来自 git show（作者 / 日期 / 改动统计），由宿主截断后回传。
       */
      const doShowCommit = async (hash) => {
        if (state.logRef === hash) {
          patch({ logRef: '', logText: '' })
          return
        }
        patch({ logRef: hash, logText: '加载中…' })
        const data = await runOp('show', { ref: hash }, { quiet: true, state: false })
        if (isOk(data)) {
          patch({ logText: hasText(data.show) ? data.show : '（这条提交没有可显示的详情）' })
        } else {
          patch({ logText: '查看提交详情失败：' + whyFailed(data, '未知错误') })
        }
      }

      /**
       * 推送失败后的面板侧补救：需要用户先填地址（没有远程 / 远程不存在）时，
       * 把地址输入框打开并给出提示，而不是只留一行 git 的英文报错。
       */
      const push = async () => {
        const data = await runOp('push')
        const reason = data !== null && data !== undefined && typeof data.reason === 'string' ? data.reason : 'none'
        if (isOk(data) !== true && (reason === 'no-remote' || reason === 'remote-not-found')) {
          patch({
            showRemote: true,
            remoteError: hasText(data.hint) ? data.hint : '需要先配置远程仓库地址',
          })
        }
      }

      /**
       * 清掉固定结果区里的那块结果。
       * 结果会一直挂在面板底部（不再随正文滚走），所以必须给用户一个「看完了，收起来」
       * 的动作 —— 否则它会一直占着面板的高度，直到下一次操作为止。
       */
      const clearOutput = () => {
        patch({ output: '' })
      }

      /**
       * 回到正文顶部。面板长了以后（分支管理 + stash + 提交历史全展开），
       * 从底部一路滑回「改动」要滚很久 —— 底部状态条点一下就是这条捷径。
       * 假节点（测试）没有 scrollTop，所以先判类型再动。
       */
      const scrollToTop = () => {
        const node = bodyRef.current
        if (node === null || node === undefined) return
        if (typeof node.scrollTo === 'function') node.scrollTo({ top: 0, behavior: 'smooth' })
        else node.scrollTop = 0
      }

      /** 保存远程地址；返回是否成功。 */
      const saveRemote = async () => {
        const url = state.remoteUrl.trim()
        if (url.length === 0) {
          patch({ remoteError: '请填写仓库地址' })
          return false
        }
        const name = state.remoteName.trim()
        const data = await runOp('setRemote', { name: name.length > 0 ? name : 'origin', url: url })
        if (isOk(data) === true) {
          // 保存成功：草稿已落盘，交回给 state 播种（新的 snapshot 里就是这条地址）。
          patch({ showRemote: false, remoteError: '', remoteDirty: false })
          return true
        }
        patch({ remoteError: whyFailed(data, '保存远程地址失败') })
        return false
      }

      /** 面板上的「保存并推送」：配好地址后直接推一次，省掉第二次点击。 */
      const saveRemoteAndPush = async () => {
        if (await saveRemote()) await push()
      }

      /**
       * 删掉一个多余的远程（两个远程指向同一地址时，提示行上的那个按钮）。
       *
       * 必须二次确认，而且确认文案要说清「只动本地」：服务器上的仓库与你的提交都不受影响，
       * 但它的远端跟踪引用（`refs/remotes/<名字>/*`）会一起消失，重新加回来就是一句
       * git remote add —— 这几件事不说清楚，用户不敢点，或者点了才后悔。
       */
      const removeRemote = async (name) => {
        if (!hasText(name)) return
        const ok = window.confirm('删掉远程 ' + name + ' 吗？\n\n'
          + '· 只删本地的配置与它的远端跟踪引用 refs/remotes/' + name + '/*\n'
          + '· 服务器上的仓库、以及你的提交都不受影响\n'
          + '· 需要时可以用 git remote add ' + name + ' <地址> 加回来')
        if (ok !== true) return
        const data = await runOp('removeRemote', { name: String(name) })
        if (isOk(data) !== true) return
        // 删掉的可能正是面板正在显示的那一个：让「远程」行跟着新状态重新播种。
        patch({ remoteDirty: false, remoteError: '' })
      }

      /** 复制远程地址到剪贴板（优先 Clipboard API，非安全上下文退回 execCommand）。 */
      const copyRemote = async () => {
        const remotes = state.snapshot !== null && Array.isArray(state.snapshot.remotes) ? state.snapshot.remotes : []
        const url = remotes.length > 0 && hasText(remotes[0].url) ? remotes[0].url : ''
        if (url.length === 0) return
        const done = () => {
          patch({ remoteCopied: true })
          window.setTimeout(() => patch({ remoteCopied: false }), 1500)
        }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined
            && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(url)
            done()
            return
          }
        } catch (error) {
          /* 落到下面的 execCommand 兜底 */
        }
        try {
          if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            const area = document.createElement('textarea')
            area.value = url
            document.body.appendChild(area)
            area.select()
            const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
            document.body.removeChild(area)
            if (copied === true) {
              done()
              return
            }
          }
        } catch (error) {
          /* 下面统一提示失败 */
        }
        patch({ output: '复制失败：请手动选中远程地址复制\n' + url })
      }

      /**
       * 提交。amend=true 时用 --amend 补充到上一次提交。
       * @returns 宿主返回的响应对象，调用方按 isOk 判断（「提交并推送」要靠它决定推不推）。
       */
      const doCommit = async (amend) => {
        const withAmend = amend === true
        const text = state.message
        patch({ message: '' })
        const data = await runOp('commit', { message: text, amend: withAmend })
        if (isOk(data)) {
          if (withAmend) patch({ commitAmend: false })
        } else {
          // 失败时把输入文本写回，方便修改后重试（空提交、钩子失败很常见）。
          patch({ message: text })
        }
        return data
      }

      /** 提交并推送：成功提交后直接推一次，省掉「提交完再点推送」的第二下。 */
      const doCommitAndPush = async (amend) => {
        const data = await doCommit(amend)
        if (isOk(data)) await push()
      }

      // 只读一次；失败就静默保持「未加载」，面板其余部分照常可用。
      React.useEffect(() => { loadNet(true) }, [])

      // 跟随当前会话目录刷新；用户手动切换过目录后不再覆盖。
      // 当前会话的 cwd 变了就是「换了工作区」，走 switchDir 连旧工作区的运行结果
      // 一起清掉。（首次运行时这些字段本来就是空的，多清一次是无操作。）
      React.useEffect(() => {
        if (state.picked === true) return
        switchDir(hasText(sessionCwd) ? sessionCwd : '')
      }, [sessionCwd])

      // diff 一展开就把它滚进可视区：它内联在改动清单里，清单本身和面板正文都可能
      // 需要滚动 —— 不滚的话用户点了一下可能什么都没看见（以为没反应）。
      // scrollIntoView 只在真实浏览器里有（测试里的假节点没有），所以先判类型。
      React.useEffect(() => {
        if (state.diffKey.length === 0) return
        const node = diffRef.current
        if (node === null || node === undefined || typeof node.scrollIntoView !== 'function') return
        node.scrollIntoView({ block: 'nearest' })
      }, [state.diffKey])

      /**
       * 从 state 同步远程地址草稿：**只在用户没动过草稿时播种**。
       *
       * 判定条件必须是「用户改没改过」，不能是「输入框有没有焦点」：点「保存」会
       * 让输入框先失焦，焦点判定在这一刻必然失效。顺带也修掉了另一个同源问题：
       * 用户填了地址还没保存时，任何一次状态刷新都会把草稿覆盖掉。
       */
      React.useEffect(() => {
        if (state.remoteDirty === true) return
        const remotes = state.snapshot !== null && Array.isArray(state.snapshot.remotes) ? state.snapshot.remotes : []
        patch({ remoteUrl: remotes.length > 0 ? remotes[0].url : '' })
      }, [state.snapshot, state.remoteDirty])

      // 界面的记忆：折叠态与宽度都存 localStorage（失败了只是下次用默认值）。
      React.useEffect(() => {
        writeStorage(MIN_KEY, state.minimized === true ? '1' : null)
      }, [state.minimized])

      React.useEffect(() => {
        // width 为 null = 用户双击拖拽条「恢复默认宽度」：这时要把存下来的宽度删掉，
        // 否则下次挂载又会读回旧值（表现就是「恢复默认」只在当次有效）。
        writeStorage(WIDTH_KEY, typeof state.width === 'number' ? state.width : null)
      }, [state.width])

      // 操作成功后的回音：把结果栏滚进视口并闪一下（结果栏在最底部，容易被漏看）。
      // classList / scrollIntoView 在测试的假节点里都没有，先判类型再动。
      React.useEffect(() => {
        if (flashRef.current !== true) return
        flashRef.current = false
        const node = outRef.current
        if (node === null || node === undefined) return
        if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
        if (node.classList !== undefined && node.classList !== null && typeof node.classList.add === 'function') {
          node.classList.remove('dgp-out-flash')
          // 读一次布局属性强制重排，让「同一个 class 再加一次」也能重放动画。
          void node.offsetWidth
          node.classList.add('dgp-out-flash')
        }
      }, [state.output])

      /**
       * 后台自动刷新：窗口重新获得焦点 / 标签页重新可见时静默读一次状态。
       *
       * 为什么需要：用户在终端里提交完回到浏览器，面板还停在上一次操作的结果上，
       * 得手动点「刷新」才会更新 —— 而那正是最容易被忘记的一步。
       * 只在已经绑定了仓库时刷新；静默 = 不点亮「同步中…」、失败不刷结果栏。
       */
      React.useEffect(() => {
        const isRepo = state.snapshot !== null && state.snapshot.isRepo === true
        if (isRepo !== true) return undefined
        if (typeof window.addEventListener !== 'function') return undefined
        const refresh = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load(hasText(state.workdir) ? state.workdir : '', true)
        }
        window.addEventListener('focus', refresh)
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', refresh)
        }
        return () => {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('focus', refresh)
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', refresh)
          }
        }
      }, [state.workdir, state.snapshot === null ? null : state.snapshot.isRepo])

      /**
       * 轻量轮询：面板之外的 git 改动没有任何事件可听，只能定时读一次状态。
       *   · 有未提交改动 → 20 秒：胶囊上的红点与改动数要跟得上编辑器 / 终端的节奏。
       *   · 工作区干净 → 60 秒：**干净时也必须轮询** —— 切分支、拉取、别人替你提交、
       *     AI 工具在同一个 DSH 里跑 git，这些都发生在工作区干净的时候。早先「干净就
       *     不轮询」会让面板一直停在旧分支 / 旧领先数上，只有用户碰巧切了一次标签页
       *     （focus / visibilitychange 那次静默刷新）或手动点「刷新」才会更新。
       * 只在标签页可见时跑，隐藏时靠 visibilitychange 那一次补上。
       */
      React.useEffect(() => {
        const snapshot = state.snapshot
        if (snapshot === null || snapshot.isRepo !== true) return undefined
        if (typeof window.setInterval !== 'function') return undefined
        const total = typeof snapshot.changesTotal === 'number' ? snapshot.changesTotal : 0
        const timer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load(hasText(state.workdir) ? state.workdir : '', true)
        }, total > 0 ? POLL_DIRTY_MS : POLL_CLEAN_MS)
        return () => {
          if (typeof window.clearInterval === 'function') window.clearInterval(timer)
        }
      }, [
        state.workdir,
        // 依赖只放三个**原始值**：state.snapshot 每次轮询都会换成新对象，放进依赖会让
        // 定时器每轮都被清掉重建 —— 那样它永远等不到 20 / 60 秒。
        state.snapshot === null ? null : state.snapshot.isRepo,
        state.snapshot === null || typeof state.snapshot.changesTotal !== 'number'
          ? 0
          : state.snapshot.changesTotal,
      ])

      /**
       * 分支管理开着时，仓库状态一变就重列一次分支：外部（终端 / AI 工具 / 另一个会话）
       * 切分支、新建、删除都不经过面板的按钮，列表不刷新就会停在旧分支上 —— 刚删掉的
       * 分支还挂在列表里、AI 刚建出来的分支看不见。与下面 stash 备份区那条 effect 同一套
       * 理由：只读、且只在展开状态下跑，不给日常操作加请求。
       */
      React.useEffect(() => {
        if (state.showBranches !== true) return
        fetchBranches()
      }, [state.snapshot])

      /**
       * stash 备份区开着时，仓库状态一变就把它刷新一次：操作之后（安全拉取、
       * 安全切分支、应用/删除备份）列表里的编号 stash@{n} 会整体前移一位，
       * 不刷新的话用户看到的编号是旧的 —— 而编号就是要交给 git 的参数。
       * 只读、且只在展开状态下跑，所以不会给日常操作增加任何请求。
       */
      React.useEffect(() => {
        if (state.showStash !== true) return
        fetchStashList()
      }, [state.snapshot])

      return {
        state,
        patch,
        diffRef,
        outRef,
        bodyRef,
        sessionCwd,
        actions: {
          load, switchDir, forgetRepoDetails, loadNet, saveNet, probeNet, runOp, runChoice,
          fetchBranches, toggleBranches, fetchStashList, toggleStash, doStashApply, doStashDrop,
          doCheckout, doCreateBranch, doDeleteBranch, doRenameBranch,
          doAdoptRemoteBranch, doCompareRemoteBranch, showDiff,
          doStageFile, doUnstageFile, doRestoreFile, doShowCommit,
          push, saveRemote, saveRemoteAndPush, copyRemote, removeRemote, doCommit, doCommitAndPush,
          clearOutput, scrollToTop,
          openPicker, closePicker, pickList, pickSelect, pickEnter, pickCrumb,
          pickDraftStart, pickDraftCancel, pickDraftSubmit,
          pickDraftChange: (value) => patch({ pickDraft: value }),
          pickToggleHidden: () => patch({ pickShowHidden: state.pickShowHidden !== true }),
          pickConfirm, pickSystem,
          pickCreateStart, pickCreateCancel, pickCreate,
          pickCreateDraft: (value) => patch({ pickFolder: value }),
        },
      }
    }

    // ── 展示组件（纯函数，不持有任何 hook） ───────────────────────────────
    //
    // 全部由 GitPanel 用 React.createElement(Component, props) 挂载。它们不调用
    // hook，因此 hook 顺序永远只由 useGitPanel / GitPanel 决定 —— 这是把上千行的
    // 组件拆开却不会踩「hook 顺序」坑的前提。

    /** 头部：标题 + 「同步中」提示 + 右侧图标按钮组。 */
    function HeadBar(props) {
      const h = React.createElement
      // 三个图标的**文本标签一个字都不改**（🌐 / ? / —）：用户和测试都按它找按钮。
      return h('div', { style: S.head, className: 'dgp-head', key: 'head' },
        h('span', { style: S.title }, '🐙 Git 面板'),
        // 忙碌提示 = 转圈 + 文字。转圈那个 span 里没有文字，所以面板的可见文本里
        // 仍然只有「同步中…」这三个字加省略号（用户和测试读到的都是它）。
        props.busy === true
          ? h('span', {
              style: Object.assign({}, S.note, { display: 'inline-flex', alignItems: 'center', gap: '5px' }),
              key: 'busy',
            },
              h('span', { style: S.busyDot, className: 'dgp-spin' }),
              h('span', null, '同步中…'))
          : null,
        h('span', { style: S.spacer }),
        h('div', { style: S.headActions },
          h('button', {
            style: S.mini,
            className: 'dgp-mini',
            key: 'net',
            type: 'button',
            'aria-label': '网络加速设置',
            title: '网络加速：连不上 github.com（Connection was reset / 超时）时打开，可走镜像或本机代理',
            onClick: () => props.onToggleNet(props.showNet !== true),
          }, '🌐'),
          h('a', {
            style: S.miniLink,
            className: 'dgp-mini',
            href: '/git-panel/help',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '打开 Git 帮助文档（新标签页）：面板操作方式 + 常用命令，命令点一下即复制',
          }, '?'),
          h('button', {
            style: S.mini,
            className: 'dgp-mini',
            key: 'min',
            type: 'button',
            'aria-label': '最小化 Git 面板',
            title: '最小化（收起成右下角的小胶囊）',
            onClick: () => props.onMinimize(),
          }, '—'),
        ),
      )
    }

    /** 最小化后的胶囊：仍然一眼看得见「有几处要提交」。 */
    function Pill(props) {
      const h = React.createElement
      const dirty = props.dirty === true
      return h(React.Fragment, null,
        panelStyles(),
        h('div', {
          style: S.pill,
          className: 'dgp-pill',
          title: '展开 Git 面板' + (dirty ? '（' + props.count + ' 处未提交改动）' : ''),
          onClick: () => props.onExpand(),
        },
          h('span', { key: 'label' }, '🐙 Git 面板'),
          dirty
            ? h('span', {
                key: 'dot',
                // 宿主主题里没有 state-danger-primary 这个 token（只有 state-error-primary），
                // 用错了就永远走兜底色 —— 这里跟着真实 token 名走。
                // 再让它慢慢呼吸（.dgp-pulse）：最小化之后这是唯一还在动的信号。
                className: 'dgp-pulse',
                style: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: '10px' },
                title: '有未提交的改动',
              }, '●')
            : null,
          dirty ? h('span', { key: 'count', style: S.chip, title: '未提交的改动数量' }, String(props.count)) : null,
        ))
    }

    /**
     * 面板底部常驻状态条：左边「上一次操作成没成 + 我在哪个分支、有多少改动」，
     * 右边「和远端是什么关系」。
     *
     * 为什么把它单独拎出来常驻：面板长了以后（分支管理 + stash + 提交历史全展开），
     * 分支与改动数早就滚出视野了 —— 而这两个正是「我现在该干什么」的依据。
     * 点它一下回到正文顶部（长面板里从底部滑回改动清单要滚很久）。
     */
    function StatusBar(props) {
      const h = React.createElement
      const ok = props.lastOk
      const dotColor = ok === true
        ? 'var(--dsw-alias-state-success-primary, #16a34a)'
        : (ok === false
            ? 'var(--dsw-alias-state-error-primary, #dc2626)'
            : 'var(--dsw-alias-label-tertiary, #999999)')
      const dotTitle = ok === true
        ? '上一次操作：成功'
        : (ok === false ? '上一次操作：失败（原因见命令结果）' : '还没有在这个仓库里执行过操作')
      const goTop = () => props.onTop()
      return h('div', {
        style: S.status,
        className: 'dgp-status dgp-clickable',
        key: 'status-bar',
        role: 'button',
        tabIndex: 0,
        title: dotTitle + ' · 点击回到面板顶部',
        onClick: goTop,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            goTop()
          }
        },
      },
        h('span', {
          style: Object.assign({}, S.statusDot, { color: dotColor }),
          title: dotTitle,
        }, '●'),
        h('span', { style: S.statusText, title: String(props.summary) }, String(props.summary)),
        hasText(props.tail) ? h('span', { style: S.statusTail }, String(props.tail)) : null,
        // 本地名 ≠ 上游名：提前把「点了推送会被 git 拒」这件事说出来，并指向那三条路。
        props.mismatch === true ? h('span', {
          style: S.statusWarn,
          className: 'dgp-status-warn',
          title: '本地分支名和上游的远端分支名不一样：默认配置（push.default=simple）下裸 push 会被 git 拒绝。'
            + '点「推送」，面板会给出三条可选的路（推到上游那条 / 另建同名远端分支 / 把本地名改成和上游一致）。',
        }, '名称不一致') : null,
      )
    }

    /** 网络加速设置块：放在最前面 —— 它解释「为什么刚才那条命令连不上」。 */
    function NetSection(props) {
      const h = React.createElement
      const net = props.net
      const netCfg = net !== null && typeof net === 'object' ? net : {}
      const candidates = Array.isArray(netCfg.candidates) ? netCfg.candidates : []
      // 这里刻意不用 panelButton：那个会被 busy 锁住，而用户在等待一次卡住的 fetch 时
      // 恰恰最需要能改设置。
      const netBtn = (label, onClick, primary) => h('button', {
        key: label,
        type: 'button',
        className: buttonClass(primary === true, false),
        style: buttonStyle(primary === true, props.netBusy === true),
        disabled: props.netBusy === true,
        onClick: onClick,
      }, label)

      const children = [
        h('div', { style: S.netTitle, key: 'title' },
          h('span', null, '🌐 网络加速'),
          h('span', { style: S.spacer }),
          h('span', { style: S.note }, props.ready !== true
            ? '不可用'
            : (netCfg.mirrorEnabled === true
                ? '镜像已开' + (netCfg.hasProxy === true ? ' + 代理' : '')
                : (netCfg.hasProxy === true ? '仅代理' : '仅直连'))),
        ),
      ]

      if (props.ready !== true) {
        // 配置读不到（典型是「客户端已热重载、宿主还没重启」）时**只显示说明**：
        // 控件照着渲染而没有宿主可写，比不显示更糟 —— 用户会点、会以为生效了。
        children.push(h('div', { style: S.warn, key: 'unavailable' },
          '读不到宿主配置：宿主半边还是旧版本，重启一次 dsh 后本设置即可用'
          + '（客户端界面会热重载，但宿主路由不会）。'))
      } else {
        children.push(
          h('div', { style: S.netRow, key: 'mirrorpick' },
            h('select', {
              style: S.select,
              className: 'dgp-input',
              value: hasText(netCfg.mirror) ? netCfg.mirror : '',
              onChange: (event) => props.onSave({ mirror: event.target.value, mirrorEnabled: true }, false),
            }, candidates.map((item) => h('option', {
              key: String(item.prefix),
              value: String(item.prefix),
            }, String(item.label)))),
          ),
          h('label', { style: S.netRow, key: 'mirrortoggle' },
            h('input', {
              style: S.check,
              type: 'checkbox',
              checked: netCfg.mirrorEnabled === true,
              onChange: (event) => props.onSave({ mirrorEnabled: event.target.checked }, false),
            }),
            h('span', null, '用镜像加速克隆 / 获取 / 拉取'),
          ),
          h('div', { style: S.warn, key: 'mirrorwarn' },
            '镜像会把请求转给第三方：公开仓库没问题，私有仓库请改用下面的代理；推送不走镜像。'),
          h('div', { style: S.netRow, key: 'proxy' },
            h('input', {
              style: S.input,
              className: 'dgp-input',
              value: props.netProxy,
              placeholder: '本机代理 http://127.0.0.1:7890（留空 = 不用）',
              onChange: (event) => props.onProxyChange(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  props.onSave({ proxy: props.netProxy }, true)
                }
              },
            }),
            netBtn('保存代理', () => props.onSave({ proxy: props.netProxy }, true), true),
          ),
          h('div', { style: S.netRow, key: 'probe' },
            netBtn(props.netBusy === true ? '检测中…' : '检测网络', () => props.onProbe()),
            h('span', { style: S.note }, '实测这台机器上哪条线路通'),
          ),
        )
      }

      if (Array.isArray(props.netProbe)) {
        children.push(h('div', { style: S.list, key: 'results' },
          props.netProbe.map((item, index) => h('div', {
            style: S.item, className: 'dgp-rowitem', key: 'p' + index,
          },
            h('span', { style: item.ok === true ? S.good : S.bad }, item.ok === true ? '✓' : '✗'),
            h('span', {
              style: S.name,
              title: String(item.error === undefined || item.error === null ? '' : item.error),
            }, String(item.label)),
            h('span', { style: S.probeMs }, item.ok === true
              ? (String(item.ms) + 'ms')
              : String(item.error === undefined || item.error === null ? '失败' : item.error)),
          )),
        ))
      }

      return h('div', { style: S.netBox, key: 'net' }, children)
    }

    /**
     * 仓库卡片：目录 / 分支 / 远程三行。
     * 这三行都是「这个仓库现在是什么样」的只读信息（各自带一个动作按钮），放进同一张
     * 卡里与下面的改动 / 提交 / 同步区分开，避免一长串同权重的行。
     */
    function RepoCard(props) {
      const h = React.createElement
      const s = props.state
      const locked = props.locked === true
      const isRepo = props.isRepo === true
      const remotes = props.remotes
      const rows = []

      rows.push(h('div', { style: S.row, key: 'dir' },
        h('span', { style: S.label }, '目录'),
        h('span', { style: S.path, title: s.workdir }, hasText(s.workdir) ? s.workdir : '（默认目录）'),
        // 「切换」弹目录选择小窗口 —— 与 DSH「添加工作区」同一个选择器
        // （见 PickDialog）：浏览目录 / 直接输入路径 / 新建文件夹，选完就切过去。
        panelButton('切换', () => props.onPickDir(), {
          locked: locked,
          title: '弹出目录选择小窗口（与「添加工作区」同一个选择器），选完面板就切到那个目录',
        }),
        panelButton('刷新', () => props.onRefresh(), { locked: locked }),
        s.picked === true && hasText(props.sessionCwd)
          ? panelButton('跟随会话', () => props.onFollowSession(props.sessionCwd), { locked: locked })
          : null,
      ))

      const upstream = isRepo && hasText(s.snapshot.upstream) ? s.snapshot.upstream : null
      rows.push(h('div', { style: S.row, key: 'branch' },
        h('span', { style: S.label }, '分支'),
        // 名字过长会被省略号截断：tooltip 里给全名兜底（见 S.branch 的注释）。
        h('span', {
          style: S.branch,
          title: isRepo && hasText(s.snapshot.branch) ? '当前分支：' + String(s.snapshot.branch) : undefined,
        }, isRepo
          ? (hasText(s.snapshot.branch) ? s.snapshot.branch : '（尚无提交）')
          : '—'),
        // 上游状态：`→ origin/master`；没有上游时明说，并在 tooltip 里指向按钮
        // （面板的「拉取」会自动补这一步，所以不要求用户去记 git 命令）。
        // 与分支名一样可收缩（省略号 + tooltip 全名），长分支下「管理」不被顶出面板。
        isRepo
          ? h('span', {
              style: Object.assign({}, S.note, {
                flex: '0 1 auto', minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }),
              title: upstream === null
                ? '未设上游：本地分支还不知道对应远端哪个分支。直接点「拉取」即可，面板会自动按「远程 + 当前分支」拉取并登记上游。'
                : '上游：本地 ' + String(s.snapshot.branch) + ' 对应远端 ' + upstream,
            }, upstream === null ? '未设上游' : '→ ' + upstream)
          : null,
        h('span', { style: S.spacer }),
        // 「领先/落后」留在这一行；改动摘要搬到了下面「改动」区块的标题上 ——
        // 那才是它描述的内容（点「全部暂存」后数字要跟着变）。
        isRepo
          ? (trackingSummary(s.snapshot).length > 0
              ? h('span', { style: S.note }, trackingSummary(s.snapshot))
              : null)
          : h('span', { style: S.note }, '还不是 Git 仓库'),
        isRepo
          ? panelButton(s.showBranches === true ? '收起' : '管理', () => props.onToggleBranches(), { locked: locked })
          : null,
      ))

      // 远程仓库：没有远程时这条是「未配置」，点了就展开地址输入框；
      // 推送失败需要地址时也会自动展开。展开的输入框和错误提示都留在同一张卡里
      // —— 它们改的就是上面那一行。
      if (isRepo) {
        const first = remotes.length > 0 ? remotes[0] : null
        // 仓库主页入口：宿主由远程地址推导（https / ssh / scp 风格都行），推导
        // 不出来（本地路径、没配远程…）就不显示 —— 宁可少一个按钮，不给死链。
        const pageUrl = hasText(props.pageUrl) ? props.pageUrl : null
        rows.push(h('div', { style: S.row, key: 'remote' },
          h('span', { style: S.label }, '远程'),
          h('span', { style: S.path, title: first === null ? '' : String(first.url) },
            first === null ? '未配置（推送到不了任何地方）' : first.name + ' → ' + first.url),
          pageUrl === null
            ? null
            : panelLink('仓库页 ↗', pageUrl, '打开仓库主页（新标签页）：' + pageUrl, 'repo-page'),
          // 复制地址：把 git 用的原始地址（可能是 ssh 形式，网页链接推导不出来）
          // 放进剪贴板，方便贴进终端或分享。
          first === null
            ? null
            : panelButton(s.remoteCopied === true ? '已复制' : '复制', () => props.onCopyRemote(),
              { locked: locked, compact: true, key: 'copy-remote', title: '复制远程地址到剪贴板：' + first.url }),
          panelButton(s.showRemote === true ? '收起' : (first === null ? '配置' : '改'),
            () => props.onToggleRemote(), { locked: locked }),
        ))

        if (s.showRemote === true) {
          rows.push(h('div', { style: S.box, key: 'remote-url' },
            h('input', {
              style: Object.assign({}, S.input, { flex: '0 0 64px' }),
              className: 'dgp-input',
              value: s.remoteName,
              placeholder: 'origin',
              title: '远程名，一般用 origin',
              onChange: (event) => props.onRemoteName(event.target.value),
            }),
            h('input', {
              style: S.input,
              className: 'dgp-input',
              value: s.remoteUrl,
              placeholder: '仓库地址 git@github.com:用户名/仓库.git',
              onChange: (event) => props.onRemoteUrl(event.target.value),
              // 回车即保存：提交框、代理框、新分支框都能回车，只有这里原先必须用
              // 鼠标点「保存」—— 习惯敲回车的人会以为"保存不了"。
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  props.onSaveRemote()
                }
              },
            }),
            panelButton('保存', () => props.onSaveRemote(), { locked: locked }),
            panelButton('保存并推送', () => props.onSaveRemoteAndPush(), { primary: true, locked: locked }),
          ))
          if (s.remoteError.length > 0) {
            rows.push(h('div', { style: S.warn, key: 'remote-err' }, '⚠ ' + s.remoteError))
          }
        }

        /**
         * 两个远程指向同一地址 —— 提示 + 一键删多余的那个。
         *
         * 判断由宿主给（`git.js` 的 duplicateRemotes，保留 origin）：客户端只负责显示，
         * 免得两半各写一套判定。为什么值得专门提一行：远程名重复不只是冗余，远程名还可能
         * 和本地分支名撞在一起（远程叫 main），之后 `git log main` 这类命令就开始报
         * `refname 'main' is ambiguous` —— 本次现场正是如此。
         */
        const duplicated = Array.isArray(s.snapshot.duplicateRemotes) ? s.snapshot.duplicateRemotes : []
        for (let index = 0; index < duplicated.length; index += 1) {
          const group = duplicated[index]
          const redundant = group !== null && typeof group === 'object' && Array.isArray(group.remove)
            ? group.remove.filter((item) => hasText(item))
            : []
          if (redundant.length === 0) continue
          rows.push(h('div', {
            style: S.warnRow, key: 'dup-remote-' + index, className: 'dgp-dup-remote',
          },
            h('span', null, '⚠ ' + (redundant.length + 1) + ' 个远程指向同一地址（保留 '
              + String(group.keep) + '）：' + redundant.join('、')
              + '。重复的远程名会让 git 命令行产生歧义（refname ambiguous），也可能和本地分支名撞车。'),
            h('span', { style: S.spacer }),
            redundant.map((name) => panelButton('删掉 ' + name, () => props.onRemoveRemote(name), {
              locked: locked,
              compact: true,
              danger: true,
              key: 'remove-remote-' + name,
              title: '只删本地配置与它的远端跟踪引用（refs/remotes/' + name + '/*）；'
                + '服务器上的仓库和你的提交都不受影响',
            })),
          ))
        }
      }

      return h('div', { style: S.card, key: 'repo' }, rows)
    }

    /**
     * 分支管理器：本地分支（点名字切换、点「删除」安全删除）+ 新建并切换 + 远端分支。
     * 本地/远端两段各带一个小标题 —— 两边的动作不一样（本地是切换/删除，
     * 远端是取回/比较），混在一起容易点错。
     */
    function BranchManager(props) {
      const h = React.createElement
      const s = props.state
      const locked = props.locked === true
      const branchItems = s.branches !== null && Array.isArray(s.branches.items) ? s.branches.items : []
      const remoteItems = s.remoteBranches !== null && Array.isArray(s.remoteBranches.items)
        ? s.remoteBranches.items
        : []
      // 远端分组把「默认分支」钉在第一行（其余仍按 ref 排序）。用户按「第一条就是
      // 默认」找人，而不是在一长串里翻（llama.cpp 这类仓库几十条分支，字母序下
      // master 会夹在中间，看着就像「没下载下来」）。head 标记既来自本地指针
      // （parseRemoteBranchOutput），也可能来自默认分支兜底补查（enhance），
      // 统一在这里排序，两条路径都生效。
      const remoteRows = [...remoteItems].sort((left, right) => {
        if (left.head !== right.head) return left.head === true ? -1 : 1
        return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0
      })
      /**
       * 新分支名撞上远端名（`origin/main` 这种）就地拦下。
       *
       * 本地分支 `origin/main` 会和 `refs/remotes/origin/main` 变成两个同名引用：
       * 从此 `git branch -a`、部分脚本乃至面板自己的命令都开始有歧义（git 会打
       * `warning: refname 'main' is ambiguous`），而且这个分支第一次推送还会在远端
       * 造出一个同样叫 `origin/main` 的分支。宿主也会拒（同一判定，见 ops.js 的
       * branchNameRemoteConflict）—— 这里拦是为了在输入框旁边立刻说清楚。
       */
      const remoteNames = (s.snapshot !== null && Array.isArray(s.snapshot.remotes) ? s.snapshot.remotes : [])
        .map((item) => (item !== null && typeof item === 'object' ? item.name : null))
      const draftConflict = branchNameRemoteConflict(s.branchDraft, remoteNames)
      const card = [
        h('div', { style: S.sectionTitle, key: 'localtitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, '本地分支'),
          h('span', { style: S.sectionRule }),
        ),
        h('div', { style: S.list, key: 'branches' },
          branchItems.length === 0
            ? h('div', { style: S.note }, '还没有分支：提交一次，或直接在下面新建一个。')
            : branchItems.map((item, index) => h('div', {
                style: S.item, className: 'dgp-rowitem', key: 'b' + index,
              },
                // 当前分支用实心点标出：颜色之外再给一个形状，色觉差异下也分得清。
                h('span', {
                  style: Object.assign({}, S.marker, {
                    color: item.current === true
                      ? 'var(--dsw-alias-state-success-primary, #16a34a)'
                      : 'var(--dsw-alias-label-tertiary, #999999)',
                  }),
                }, item.current === true ? '●' : '○'),
                h('span', {
                  style: item.current === true
                    ? Object.assign({}, S.name, {
                        fontWeight: 600,
                        color: 'var(--dsw-alias-state-success-primary, #16a34a)',
                      })
                    : Object.assign({}, S.name, { cursor: 'pointer' }),
                  // 名字可能被省略号截断：tooltip 里给全名兜底。
                  title: item.current === true
                    ? '当前分支：' + String(item.name)
                    : '点击切换到此分支：' + String(item.name),
                  onClick: item.current === true ? undefined : () => props.onCheckout(item.name),
                }, item.name),
                h('span', { style: S.spacer }),
                item.current === true
                  ? h('span', { style: S.note }, '当前')
                  : panelButton('删除', () => props.onDeleteBranch(item.name), { locked: locked }),
                // 改名只对当前分支开放：git branch -m 改的是 HEAD 指着的那个分支，
                // 给别的行放这个按钮会让用户以为改的是被点的那一条。
                item.current === true
                  ? panelButton('改名', () => props.onRenameBranch(), { locked: locked, compact: true })
                  : null,
              )),
        ),
        h('div', { style: S.box, key: 'newbranch' },
          h('input', {
            style: S.input,
            className: 'dgp-input',
            value: s.branchDraft,
            placeholder: '新分支名（新建并切换）',
            onChange: (event) => props.onBranchDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                props.onCreateBranch()
              }
            },
          }),
          // 撞上远端名时按钮直接锁住（输入框回车那条路由 onCreateBranch 自己再拦一次）。
          panelButton('新建', () => props.onCreateBranch(), {
            primary: true, locked: locked || draftConflict !== null,
          }),
          // 就地告警贴在输入框下面：说的不是「命令失败了」，而是「这个名字不能建」。
          draftConflict !== null ? h('div', {
            style: S.warnText,
            className: 'dgp-branchname-warn',
            key: 'branchname-warn',
            role: 'alert',
          }, '这个名字不能建：' + draftConflict + ' 是配置好的远程，' + draftConflict
            + '/… 已经是它的远端跟踪引用。去掉前缀、用「'
            + String(s.branchDraft).trim().slice(draftConflict.length + 1) + '」这样的本地名。') : null,
        ),
      ]

      // 远端分支。点它**不直接切换**（那会变成游离 HEAD，对不懂 git 的人是坑），
      // 只给两个安全动作：拿成新分支（当前分支一点不动）、和本地比一比差多少。
      card.push(h('div', { style: S.sectionTitle, key: 'remotetitle' },
        h('span', { style: S.sectionTick }),
        h('span', null, remoteItems.length === 0 ? '远端分支' : '远端分支（' + remoteItems.length + '）'),
        h('span', { style: S.sectionRule }),
      ))
      card.push(h('div', { style: S.note, key: 'remotehint' },
        remoteItems.length === 0
          ? '点一次「获取远程」就能在这里看到（只下载，不改你的代码）'
          // 文案刻意压在一行（23 个全角字符）以内：原先「…当前分支一点不动」超出
          // 一行容量，换行后第二行只剩下一个「动」，面板里显得很难看。
          : '「拿成新分支」把远端那份取回本地，当前分支不动'))

      // 「远端默认分支」提示行：本地有 origin/HEAD 指针时它就是指针的值；本地指针
      // 缺失（旧版 git / 镜像远端）时由宿主补查远程 HEAD 得到（defaults）。就算默认
      // 分支还没下载到本地，用户也能一眼知道该拿哪一份。
      const knownDefaults = s.remoteBranches !== null && Array.isArray(s.remoteBranches.defaults)
        ? s.remoteBranches.defaults
        : []
      const defaultLine = knownDefaults.length > 0
        ? knownDefaults.map((item) => item.remote + '/' + item.branch).join('、')
        : (s.remoteBranches !== null && typeof s.remoteBranches.defaultRef === 'string'
            && s.remoteBranches.defaultRef.length > 0
          ? s.remoteBranches.defaultRef
          : null)
      if (defaultLine !== null) {
        card.push(h('div', { style: S.note, key: 'defaultline' }, '远端默认分支：' + defaultLine))
      }

      for (let index = 0; index < remoteRows.length; index += 1) {
        const item = remoteRows[index]
        card.push(h('div', { style: S.item, className: 'dgp-rowitem', key: 'r' + index },
          // title 里带上完整 ref：名字可能被省略号截断（而且远端分支常常很长），
          // 悬停必须能看全；「默认」徽章独立于名字渲染，截断不影响它。
          h('span', {
            style: S.name,
            title: item.head === true
              ? item.ref + '（远端默认分支：拉取 / 获取远程会从它更新）'
              : item.ref + '（远端分支：获取远程时会下载到本地）',
          }, item.ref),
          item.head === true
            ? h('span', { style: S.headBadge, key: 'headbadge', title: '远端默认分支：' + item.ref }, '默认')
            : null,
          h('span', { style: S.spacer }),
          panelButton('拿成新分支', () => props.onAdopt(item), { locked: locked }),
          panelButton('比较', () => props.onCompare(item), { locked: locked }),
        ))
      }

      return h('div', { style: S.card, key: 'branch-card' }, card)
    }

    /**
     * 一条改动（整行可点、可键盘触达），右侧带这个文件自己的三个小动作。
     *
     * 行本身是「点开看 diff」，小按钮是「只对这个文件做点什么」——按钮的 onClick
     * 必须 stopPropagation，否则点「暂存」会顺手把 diff 也展开/收起。
     * 「还原」只对**工作区里确实有改动**的条目开放（porcelain 第二列 M/D）：
     * 已暂存未改工作区的条目没有可还原的内容，而未跟踪文件要「还原」等于删文件，
     * 那种破坏性动作不放进这个紧凑的按钮组。
     */
    function changeRow(item, open, locked, onToggle, onStage, onUnstage, onRestore) {
      const h = React.createElement
      const staged = item.staged === true
      const code = String(item.code === undefined || item.code === null ? '  ' : item.code)
      const actions = []
      if (staged) {
        actions.push(panelButton('取消暂存', (event) => { event.stopPropagation(); onUnstage(item) },
          { locked: locked, compact: true, key: 'unstage-' + changeKey(item) }))
      } else {
        actions.push(panelButton('暂存', (event) => { event.stopPropagation(); onStage(item) },
          { locked: locked, compact: true, key: 'stage-' + changeKey(item) }))
      }
      if (code.charAt(0) !== '?' && (code.charAt(1) === 'M' || code.charAt(1) === 'D')) {
        actions.push(panelButton('还原', (event) => { event.stopPropagation(); onRestore(item) },
          { locked: locked, compact: true, danger: true, key: 'restore-' + changeKey(item) }))
      }
      return h('div', {
        style: S.item,
        // 展开中的那一行带品牌色竖条（dgp-rowitem-active），和下面的 diff 对上号。
        className: 'dgp-rowitem dgp-clickable' + (open ? ' dgp-rowitem-active' : ''),
        key: 'c' + changeKey(item),
        title: (staged ? '已暂存' : '未暂存') + ' · 点击查看 diff（再点收起）',
        // 整行是一个动作，就得像按钮一样能被键盘触达（焦点环见 PANEL_CSS）。
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        onClick: () => onToggle(item),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle(item)
          }
        },
      },
        // 暂存状态：实心=已暂存、空心=未暂存。颜色之外再给一个形状。
        h('span', {
          style: Object.assign({}, S.marker, {
            color: staged
              ? 'var(--dsw-alias-state-success-primary, #16a34a)'
              : 'var(--dsw-alias-label-tertiary, #999999)',
          }),
        }, staged ? '●' : '○'),
        h('span', { style: codeStyle(staged), className: 'dgp-code' }, code),
        h('span', { style: S.name }, String(item.path)),
        h('span', { style: S.spacer }),
        actions,
        h('span', { style: S.chevron }, open ? '▲' : '▼'),
      )
    }

    /**
     * 展开的 diff / 提交详情上方那行抬头：写清「现在展开的是什么」。
     *
     * 为什么需要它：展开的那一行（改动清单里的文件行 / 提交列表里的一行）随时可能
     * 被滚出视野，抬头就是那块内容的落款；右侧的小胶囊顺带说明这是「已暂存」还是
     * 「工作区」的那一份 —— 同一个文件的两份 diff 内容完全不同。
     *
     * item：{ path, staged, chip, title }。chip 传 null 表示不画胶囊。
     */
    function diffTitleBar(item) {
      const h = React.createElement
      const staged = item.staged === true
      const path = String(item.path)
      const chip = item.chip === null
        ? null
        : (hasText(item.chip) ? String(item.chip) : (staged === true ? '已暂存' : '未暂存'))
      const title = hasText(item.title)
        ? String(item.title)
        : ((staged === true ? '已暂存' : '工作区') + '改动：' + path)
      return h('div', {
        style: S.diffTitle,
        className: 'dgp-difftitle',
        key: 'difftitle-' + path,
      },
        h('span', { style: S.sectionTick }),
        h('span', { style: S.diffPath, title: title }, path),
        chip === null ? null : h('span', { style: S.chip }, chip),
      )
    }

    /** 抬头条的兜底形态：清单刷新后 key 已经对不上任何一行，但仍要知道是哪个文件。 */
    function diffTitleBarForKey(key) {
      return diffTitleBar({ path: key.slice(2), staged: key.charAt(0) === 's' })
    }

    /**
     * 改动区块：标题（带改动摘要胶囊）+ 列表 + 点开的 diff。
     *
     * diff **内联展开在被点的那一行下面**，而不是列表外面的另一个框：面板正文是
     * 可滚动的 flex 列，清单也是；放在外面时它既挤掉清单的高度（见 S.list 的注释），
     * 又常常落到可视区之外 —— 用户看到的就是「diff 把改动清单盖住了」。放进清单里
     * 之后两者永远是同一个滚动区：点哪个文件，就在那个文件下面看它的 diff。
     */
    function ChangesSection(props) {
      const h = React.createElement
      const changes = props.changes
      const total = typeof props.changesTotal === 'number' ? props.changesTotal : changes.length
      const shown = changes.slice(0, CHANGES_SHOWN)
      const rows = []
      let diffInline = false
      for (const item of shown) {
        const open = props.diffKey === changeKey(item)
        rows.push(changeRow(
          item, open, props.locked === true, props.onToggle,
          props.onStage, props.onUnstage, props.onRestore,
        ))
        if (open) {
          rows.push(diffTitleBar(item))
          rows.push(renderLines(props.diffText, S.diff, diffLineClass, 'diff', props.diffRef))
          diffInline = true
        }
      }
      // 兜底：清单在 diff 打开之后被刷新掉了（典型是点了「全部暂存」，条目的已暂存
      // 状态翻转、key 对不上任何一行）—— diff 仍要有地方显示，不能凭空消失。
      // 同样放进清单内部：与文件行共用同一个滚动区。
      if (props.diffKey.length > 0 && diffInline !== true) {
        rows.push(diffTitleBarForKey(props.diffKey))
        rows.push(renderLines(props.diffText, S.diff, diffLineClass, 'diff-fallback', props.diffRef))
      }
      // 截断必须说出来：宿主最多回 100 条、这里最多画 40 条。静默截断会让用户
      // 以为「我的仓库只有 40 个改动」。
      const hidden = Math.max(0, total - shown.length)
      if (hidden > 0) {
        rows.push(h('div', { style: S.note, key: 'more' },
          '还有 ' + hidden + ' 处未显示（面板一次最多列 ' + CHANGES_SHOWN + ' 处）'))
      }

      const children = [
        h('div', { style: S.sectionTitle, key: 'changestitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, '改动'),
          h('span', { style: S.sectionRule }),
          h('span', {
            style: changes.length > 0 ? S.chipActive : S.chip,
            className: changes.length > 0 ? 'dgp-chip-active' : undefined,
            title: '工作区里的改动总数，以及其中已经暂存的数量',
          }, changesSummary(total, changes)),
        ),
      ]
      if (changes.length > 0) {
        children.push(h('div', {
          style: props.diffKey.length > 0 ? Object.assign({}, S.list, { maxHeight: '360px' }) : S.list,
          key: 'changes',
        }, rows))
      }
      return children
    }

    /** 「需要你选一个结果」：宿主判断出这不是命令写错、而是要用户做个决定时回传的选项。 */
    function ChoiceBox(props) {
      const h = React.createElement
      return h('div', { style: S.choiceBox, key: 'choices' },
        h('div', { style: S.netTitle, key: 'title' }, '🤔 面板需要你选一个结果'),
        props.choices.map((item, index) => {
          const choice = item !== null && typeof item === 'object' ? item : {}
          return h('div', { style: S.choiceItem, key: 'choice-' + index },
            h('button', {
              type: 'button',
              className: buttonClass(index === 0, false),
              style: buttonStyle(index === 0, props.locked === true),
              disabled: props.locked === true,
              onClick: () => props.onChoose(choice),
            }, hasText(choice.label) ? choice.label : '执行'),
            hasText(choice.detail) ? h('div', { style: S.note, key: 'detail' }, choice.detail) : null,
          )
        }),
      )
    }

    /** 命令结果栏：逐行着色（命令回显 / stderr / 加速说明 / 下一步提示），文本一字不改。 */
    function OutputPanel(props) {
      if (hasText(props.output) !== true) return null
      return renderLines(props.output, S.out, outputLineClass, 'out', props.outRef, 'polite')
    }

    /** 空态：还不是仓库 / 状态读取失败。**宿主给的 notice 才是「为什么」**。 */
    function EmptyState(props) {
      const h = React.createElement
      const notice = hasText(props.notice) ? props.notice : null
      // 「还不是仓库」这句和下面的通用说明重复，就不再叠一遍；其余（未装 git、
      // 读取失败、权限问题…）都要显示出来 —— 那是用户唯一能看到的诊断。
      const extra = notice !== null && notice !== '当前目录还不是 Git 仓库' ? notice : null
      return h('div', { style: S.empty, key: 'hint' },
        // 一个图标 + 一句「这是什么情况」：空态最怕的是一整块没有重点的灰字。
        h('div', { style: S.emptyIcon }, '📂'),
        h('div', null, '这个目录里还没有 Git 仓库：可以点下面的按钮初始化一个，或者克隆一个已有的仓库。'),
        extra === null ? null : h('div', { style: S.warn }, '⚠ ' + extra),
      )
    }

    /**
     * 提交表单：输入框单独占一行，按钮与勾选项排到下一行。
     *
     * 原先三者挤在同一行：360px 的面板里输入框只剩半行宽，「填写提交信息…（回车直接
     * 提交）」被截成「填写提交信息…（」——提示本身就没了。分两行之后输入框是整行宽，
     * 主操作（提交）和两个辅助项也有了清楚的主次。
     */
    function CommitForm(props) {
      const h = React.createElement
      return h('form', {
        style: S.commitForm, key: 'commit',
        onSubmit: (event) => { event.preventDefault(); props.onSubmit(props.amend === true) },
      },
        h('input', {
          // flex 0 0 auto：在纵向 flex 里 '1 1 auto' 会去撑高度，输入框会被拉高。
          style: Object.assign({}, S.input, { flex: '0 0 auto' }),
          className: 'dgp-input',
          value: props.message,
          placeholder: '填写提交信息…（回车直接提交）',
          onChange: (event) => props.onChange(event.target.value),
        }),
        h('div', { style: S.commitActions },
          h('button', {
            className: buttonClass(true, false),
            style: buttonStyle(true, props.locked === true),
            disabled: props.locked === true,
            type: 'submit',
          }, '提交'),
          h('button', {
            className: buttonClass(false, false),
            style: buttonStyle(false, props.locked === true),
            disabled: props.locked === true,
            type: 'button',
            title: '提交成功后立刻推送一次（远程没配好时推送的提示会照常给出）',
            onClick: () => props.onCommitAndPush(props.amend === true),
            key: 'commit-push',
          }, '提交并推送'),
          h('label', {
            style: Object.assign({}, S.note, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }),
            title: '把这次提交合并进上一次提交（git commit --amend）：适合「刚提交完发现漏了东西」',
            key: 'amend',
          },
            h('input', {
              style: S.check,
              type: 'checkbox',
              checked: props.amend === true,
              onChange: (event) => props.onAmendChange(event.target.checked),
            }),
            h('span', null, '补充上次'),
          ),
        ),
      )
    }

    /** 克隆表单（还不是仓库时才出现）：地址 + 可选浅克隆。 */
    function CloneForm(props) {
      const h = React.createElement
      return h('div', { style: S.box, key: 'clone' },
        h('input', {
          style: S.input,
          className: 'dgp-input',
          value: props.url,
          placeholder: '仓库地址 https://github.com/…',
          onChange: (event) => props.onChange(event.target.value),
        }),
        panelButton('开始克隆', () => props.onClone(), { primary: true, locked: props.locked === true }),
        h('label', {
          style: Object.assign({}, S.note, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }),
          title: '浅克隆（git clone --depth 1）：只取最新一次提交，快很多、体积小很多；需要完整历史时不要勾',
          key: 'shallow',
        },
          h('input', {
            style: S.check,
            type: 'checkbox',
            checked: props.shallow === true,
            onChange: (event) => props.onShallowChange(event.target.checked),
          }),
          h('span', null, '浅克隆'),
        ),
      )
    }

    /**
     * 最近提交列表。**整行可点**：点开看这条提交的详情（作者 / 日期 / 改动统计），
     * 再点同一行收起 —— 与改动清单「点开看 diff」是同一套交互。
     */
    function LogList(props) {
      const h = React.createElement
      return [
        h('div', { style: S.sectionTitle, key: 'logtitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, '最近提交'),
          h('span', { style: S.sectionRule }),
        ),
        h('div', { style: S.list, key: 'log' },
          props.commits.slice(0, 8).map((item, index) => {
            const hash = String(item.hash)
            const open = props.openRef === hash
            return h('div', {
              style: S.item,
              className: 'dgp-rowitem dgp-clickable' + (open ? ' dgp-rowitem-active' : ''),
              key: 'l' + index,
              title: String(item.subject) + '\n点击查看提交详情（再点收起）',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: () => props.onShow(hash),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  props.onShow(hash)
                }
              },
            },
              h('span', { style: S.hash }, hash),
              h('span', { style: S.name, title: String(item.subject) }, String(item.subject)),
            )
          }),
        ),
      ]
    }

    /**
     * stash 备份列表：应用 / 删除。
     * 「安全拉取」「安全切分支」留下的备份都在这里 —— 面板自己藏的东西，
     * 收尾也得能在面板里做完，而不是把用户指回终端。
     */
    function StashList(props) {
      const h = React.createElement
      const items = Array.isArray(props.items) ? props.items : []
      if (items.length === 0) {
        return h('div', { style: S.note, key: 'stash-empty' },
          '没有 stash 备份（「安全拉取」「安全切分支」自动藏起来的改动会出现在这里）')
      }
      return h('div', { style: S.list, key: 'stash-list' },
        items.map((item, index) => h('div', {
          style: S.item, className: 'dgp-rowitem', key: 'st' + index,
        },
          h('span', { style: S.name, title: item.ref + '：' + item.text }, String(item.text)),
          h('span', { style: S.spacer }),
          panelButton('恢复', () => props.onApply(item), { locked: props.locked, compact: true }),
          panelButton('删除', () => props.onDelete(item), { locked: props.locked, compact: true, danger: true }),
        )),
      )
    }

    // ── 目录选择小窗口（与 DSH「添加工作区」同一个目录选择器） ─────────────
    //
    // 点仓库卡的「切换」弹出：面包屑 + 目录列表 + 直接输入路径 + 新建文件夹，
    // 选完面板就切到那个目录。与 DSH「添加工作区」共用宿主的 browse 通道
    // （remote.directoryPicker 的 list / createDirectory），所以弹的是同一个
    // 目录选择器、同一套权限与错误。它不注册 workspace、不开新会话 —— 只回答
    // 「面板接下来看哪个目录」。

    /** 遮罩：盖住整页（含面板）。点遮罩空白处 = 取消。 */
    const PICK_MASK = {
      position: 'fixed', inset: '0', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      background: 'rgba(0,0,0,.45)',
    }
    /** 小窗口卡片：与面板同一套主题令牌、同一种圆角与阴影语言。 */
    const PICK_CARD = {
      width: '500px', maxWidth: '100%', maxHeight: '76vh',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: 'var(--dsw-alias-bg-overlay, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #111111)',
      border: '1px solid var(--dsw-alias-border-l2, #dddddd)',
      borderRadius: '14px',
      boxShadow: '0 24px 64px rgba(0,0,0,.35), 0 4px 12px rgba(0,0,0,.18)',
      fontSize: '12.5px', lineHeight: 1.55,
    }

    /** 「新建文件夹」的子窗口：主窗口之上再盖一层，只回答「建在哪、叫什么」。 */
    function PickCreateDialog(props) {
      const h = React.createElement
      const s = props.state
      const a = props.actions
      const level = s.pickLevel
      const targetName = s.pickSelected !== null && s.pickSelected !== undefined && hasText(s.pickSelected.name)
        ? String(s.pickSelected.name)
        : (level !== null && level !== undefined && Array.isArray(level.crumbs) && level.crumbs.length > 0
            ? String(level.crumbs[level.crumbs.length - 1].name)
            : '当前目录')
      const busy = s.pickCreating === true
      return h('div', {
        style: Object.assign({}, PICK_MASK, { zIndex: 210 }),
        className: 'dgp-pick-mask',
        onMouseDown: (event) => { if (event.target === event.currentTarget) a.pickCreateCancel() },
        onKeyDown: (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          event.preventDefault()
          a.pickCreateCancel()
        },
      },
        h('div', {
          style: Object.assign({}, PICK_CARD, { width: '340px' }),
          className: 'dgp-pick-card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '新建文件夹',
        },
          h('div', { style: { padding: '14px 14px 0', fontWeight: 600 } }, '新建文件夹'),
          h('div', { style: Object.assign({}, S.note, { padding: '4px 14px 0' }) }, '在 ' + targetName + ' 中创建'),
          h('input', {
            style: Object.assign({}, S.input, { margin: '10px 14px 0' }),
            className: 'dgp-input',
            value: s.pickFolder === null ? '' : s.pickFolder,
            placeholder: '文件夹名称',
            autoFocus: true,
            disabled: busy,
            onChange: (event) => a.pickCreateDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && busy !== true) {
                event.preventDefault()
                a.pickCreate()
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                event.preventDefault()
                a.pickCreateCancel()
              }
            },
          }),
          hasText(s.pickCreateError)
            ? h('div', { style: Object.assign({}, S.warn, { padding: '8px 14px 0' }) }, '⚠ ' + s.pickCreateError)
            : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '12px 14px' } },
            panelButton('取消', () => a.pickCreateCancel(), { locked: busy }),
            panelButton('创建', () => a.pickCreate(), { primary: true, locked: busy }),
          ),
        ),
      )
    }

    /** 目录选择小窗口本体。 */
    function PickDialog(props) {
      const h = React.createElement
      const s = props.state
      const a = props.actions
      const level = s.pickLevel
      const hasLevel = level !== null && typeof level === 'object'
      const entries = hasLevel && Array.isArray(level.entries) ? level.entries : []
      const visibleEntries = entries.filter((entry) => entry !== null && typeof entry === 'object'
        && (s.pickShowHidden === true || entry.hidden !== true))
      const crumbs = pickCrumbs(level)
      const selectedPath = s.pickSelected !== null && s.pickSelected !== undefined && hasText(s.pickSelected.path)
        ? s.pickSelected.path
        : null
      const canPick = hasLevel && (selectedPath !== null || hasText(level.path))
      const editing = s.pickDraft !== null
      const busy = s.pickBusy === true
      // 宿主只组合了系统对话框（native）：网页里列不了目录，这一版界面把「列出目录」
      // 换成「打开系统对话框」，手输绝对路径照旧可用。
      const native = s.pickNative === true

      return h('div', {
        style: PICK_MASK,
        className: 'dgp-pick-mask',
        key: 'pick-mask',
        onMouseDown: (event) => { if (event.target === event.currentTarget) a.closePicker() },
        onKeyDown: (event) => {
          if (event.key !== 'Escape') return
          // 新建文件夹的子窗口自己处理 Escape（它在更上面一层）。
          if (s.pickFolder !== null) return
          event.stopPropagation()
          a.closePicker()
        },
      },
        h('div', {
          style: PICK_CARD,
          className: 'dgp-pick-card',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '选择要查看的目录',
          tabIndex: -1,
          autoFocus: true,
        },
          // 头：标题 + 一句说明（和 DSH「添加工作区」同一个选择器）。
          h('div', { style: { padding: '14px 14px 0' } },
            h('div', { style: { fontWeight: 600 } }, '选择要查看的目录'),
            h('div', { style: Object.assign({}, S.note, { marginTop: '2px' }) },
              '与「添加工作区」同一个目录选择器；选中的目录将成为面板的新工作目录'),
          ),
          // 面包屑 / 路径输入（模式在 crumb ↔ input 之间切换）。
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 14px 0' } },
            editing
              ? h('input', {
                  style: S.input,
                  className: 'dgp-input',
                  value: s.pickDraft,
                  placeholder: native
                    ? '绝对路径（回车切换），如 C:\\Users\\me\\project'
                    : '绝对路径（回车进入），如 /home/me/project',
                  autoFocus: true,
                  onChange: (event) => a.pickDraftChange(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      a.pickDraftSubmit()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      a.pickDraftCancel()
                    }
                  },
                })
              : h(React.Fragment, null,
                  h('span', {
                    style: {
                      flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: '2px',
                      overflowX: 'auto', whiteSpace: 'nowrap',
                    },
                  },
                    crumbs.length === 0
                      ? h('span', { style: S.note }, native ? '（用系统对话框选择目录）' : '（还没有目录可列）')
                      : crumbs.map((crumb, index) => h('span', {
                          key: crumb.path, style: { display: 'inline-flex', alignItems: 'center' },
                        },
                          index > 0
                            ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #999999)', fontSize: '10px' } }, '›')
                            : null,
                          h('button', {
                            type: 'button',
                            className: 'dgp-pick-crumb',
                            title: crumb.path,
                            onClick: () => a.pickCrumb(crumb.path),
                          }, String(crumb.name)),
                        )),
                  ),
                  h('button', {
                    type: 'button',
                    className: 'dgp-mini dgp-pick-crumb',
                    'aria-label': '输入路径',
                    title: native ? '直接输入绝对路径（回车切换）' : '直接输入绝对路径（回车进入）',
                    onClick: () => a.pickDraftStart(),
                  }, '✎'),
                ),
          ),
          // 目录列表：单击选中、双击/回车进入。宿主只组合了系统对话框时（native）
          // 网页里列不了目录，这一块换成说明 + 「打开系统目录选择器」；手输路径照旧。
          native
            ? h('div', {
                style: {
                  flex: '1 1 0%', minHeight: '120px', maxHeight: '44vh', overflowY: 'auto',
                  margin: '10px 14px 0', padding: '18px 14px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', gap: '10px', textAlign: 'center',
                  border: '1px dashed var(--dsw-alias-border-l2, #dddddd)',
                  borderRadius: '10px',
                },
              },
                h('div', { style: S.emptyIcon }, '🗂'),
                h('div', { style: S.note },
                  '这次 DSH 组合的目录选择器是系统对话框（不在网页里列目录），这里没法浏览目录。'),
                panelButton('打开系统目录选择器…', () => a.pickSystem(), {
                  primary: true,
                  locked: busy,
                  title: '调用 DSH 自带的目录选择器（系统对话框）',
                }),
                h('div', { style: S.note }, '也可以点上面的 ✎ 直接输入绝对路径后回车。'),
              )
            : h('div', {
            style: {
              flex: '1 1 0%', minHeight: '120px', maxHeight: '44vh', overflowY: 'auto',
              margin: '10px 14px 0', padding: '4px',
              border: '1px solid var(--dsw-alias-border-l1, #eeeeee)',
              borderRadius: '10px',
              background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            },
          },
            visibleEntries.length === 0
              ? h('div', { style: Object.assign({}, S.empty, { border: 'none' }) },
                  h('div', { style: S.emptyIcon }, '📭'),
                  h('div', null, entries.length === 0
                    ? '此目录下没有子目录'
                    : '这里只有隐藏目录（点「显示隐藏文件」查看）'))
              : visibleEntries.map((entry) => {
                  const selected = entry.path === selectedPath
                  return h('button', {
                    type: 'button',
                    key: entry.path,
                    className: 'dgp-pick-row' + (selected ? ' dgp-pick-row-selected' : ''),
                    'aria-current': selected ? 'true' : undefined,
                    title: (selected ? '已选中' : '单击选中，双击进入') + '：' + entry.path,
                    onClick: () => a.pickSelect(entry),
                    onDoubleClick: () => a.pickEnter(entry),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        a.pickEnter(entry)
                      }
                    },
                  },
                    h('span', { 'aria-hidden': true, style: { flex: '0 0 auto', fontSize: '13px' } }, '📁'),
                    h('span', {
                      style: {
                        flex: '1 1 auto', minWidth: 0, textAlign: 'left',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      },
                    }, String(entry.name)),
                    h('span', {
                      'aria-hidden': true,
                      style: { flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #999999)' },
                    }, '›'),
                  )
                }),
          ),
          // 状态行：加载中 / 失败 / 条目被截断。
          busy
            ? h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px 0',
                  color: 'var(--dsw-alias-label-secondary, #666666)',
                },
              },
                h('span', { style: S.busyDot, className: 'dgp-spin' }),
                h('span', null, '加载中…'))
            : null,
          hasText(s.pickError)
            ? h('div', { style: Object.assign({}, S.warn, { padding: '8px 14px 0' }) }, '⚠ ' + s.pickError)
            : null,
          hasLevel && level.truncated === true
            ? h('div', { style: Object.assign({}, S.note, { padding: '8px 14px 0' }) }, '目录条目很多，列表只显示了前一部分')
            : null,
          // 底部操作：新建文件夹 / 显示隐藏文件 / 取消 / 选择此目录。
          // native 模式下浏览相关的两个按钮没有意义（宿主没有 browse 能力），隐藏它们。
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '12px 14px' } },
            native
              ? null
              : panelButton('新建文件夹', () => a.pickCreateStart(), {
                  locked: busy || canPick !== true,
                  title: '在选中的目录（没选就是当前目录）里新建一个文件夹',
                }),
            native
              ? null
              : h('button', {
                  type: 'button',
                  className: 'dgp-pick-crumb',
                  'aria-pressed': s.pickShowHidden === true,
                  title: '默认隐藏以 . 开头的目录（与宿主浏览器一致）',
                  onClick: () => a.pickToggleHidden(),
                }, s.pickShowHidden === true ? '隐藏文件 ✓' : '显示隐藏文件'),
            h('span', { style: S.spacer }),
            panelButton('取消', () => a.closePicker(), { locked: false }),
            native
              ? null
              : panelButton('选择此目录', () => a.pickConfirm(), {
                  primary: true,
                  locked: busy || canPick !== true,
                  title: hasLevel && selectedPath !== null
                    ? '面板切换到选中的目录：' + selectedPath
                    : (hasLevel ? '面板切换到当前显示的目录' : '还没有可选择的目录'),
                }),
          ),
        ),
        s.pickFolder !== null ? h(PickCreateDialog, { key: 'pick-create', state: s, actions: a }) : null,
      )
    }

    // ── 面板 ──────────────────────────────────────────────────────────────

    function GitPanel(props) {
      const h = React.createElement
      const [enabled] = useEnabled()
      const panel = useGitPanel(props)
      const s = panel.state
      const a = panel.actions

      if (enabled !== true) return null

      const isRepo = s.snapshot !== null && s.snapshot.isRepo === true
      const changes = isRepo && Array.isArray(s.snapshot.changes) ? s.snapshot.changes : []
      const changesTotal = isRepo && typeof s.snapshot.changesTotal === 'number'
        ? s.snapshot.changesTotal
        : changes.length
      const commits = isRepo && Array.isArray(s.snapshot.log) ? s.snapshot.log : []
      const remotes = s.snapshot !== null && Array.isArray(s.snapshot.remotes) ? s.snapshot.remotes : []
      const locked = s.busy === true

      if (s.minimized === true) {
        return h(Pill, {
          dirty: isRepo && changesTotal > 0,
          count: changesTotal,
          onExpand: () => panel.patch({ minimized: false }),
        })
      }

      const children = []

      // 网络加速设置块放在最前面（见 NetSection 注释）。
      // 注意：children 是数组，数组里的**每个元素都必须有 key**（真实 React 会警告，
      // 而且没有 key 时同一位置换组件会按索引复用，状态可能串味）。假 React 不检查
      // 这一点，所以这条约束由「真实 React + jsdom」那一轮验证兜住。
      if (s.showNet === true) {
        children.push(h(NetSection, {
          key: 'net-section',
          net: s.net,
          ready: s.net !== null && typeof s.net === 'object',
          netBusy: s.netBusy,
          netProxy: s.netProxy,
          netProbe: s.netProbe,
          onProxyChange: (value) => panel.patch({ netProxy: value }),
          onSave: a.saveNet,
          onProbe: a.probeNet,
        }))
      }

      children.push(h(RepoCard, {
        key: 'repo',
        state: s,
        locked: locked,
        isRepo: isRepo,
        remotes: remotes,
        // 仓库主页链接：宿主在 state.pageUrl 里推导好了（本地路径 / 无远程时为 null）。
        pageUrl: isRepo && s.snapshot !== null && hasText(s.snapshot.pageUrl) ? s.snapshot.pageUrl : null,
        sessionCwd: panel.sessionCwd,
        onPickDir: () => a.openPicker(),
        onRefresh: () => a.load(s.workdir),
        onFollowSession: (target) => {
          panel.patch({ picked: false })
          a.switchDir(target)
        },
        onToggleBranches: a.toggleBranches,
        onToggleRemote: () => panel.patch({ showRemote: s.showRemote !== true, remoteError: '' }),
        onRemoteName: (value) => panel.patch({ remoteName: value }),
        // 用户一改就置脏：此后只有保存成功或换仓库才会让 state 重新播种。
        onRemoteUrl: (value) => panel.patch({ remoteDirty: true, remoteUrl: value }),
        onSaveRemote: a.saveRemote,
        onSaveRemoteAndPush: a.saveRemoteAndPush,
        onCopyRemote: a.copyRemote,
        onRemoveRemote: a.removeRemote,
      }))

      if (isRepo === true && s.showBranches === true) {
        children.push(h(BranchManager, {
          key: 'branch-manager',
          state: s,
          locked: locked,
          onCheckout: a.doCheckout,
          onCreateBranch: a.doCreateBranch,
          onDeleteBranch: a.doDeleteBranch,
          onRenameBranch: a.doRenameBranch,
          onBranchDraft: (value) => panel.patch({ branchDraft: value }),
          onAdopt: a.doAdoptRemoteBranch,
          onCompare: a.doCompareRemoteBranch,
        }))
      }

      if (isRepo !== true) {
        children.push(h(EmptyState, { key: 'empty', notice: s.snapshot !== null ? s.snapshot.notice : null }))
      }

      if (isRepo === true) {
        children.push(h(ChangesSection, {
          key: 'changes-section',
          changes,
          changesTotal,
          diffKey: s.diffKey,
          diffText: s.diffText,
          diffRef: panel.diffRef,
          locked,
          onToggle: a.showDiff,
          onStage: a.doStageFile,
          onUnstage: a.doUnstageFile,
          onRestore: a.doRestoreFile,
        }))

        // 操作区按语义分成两段，提交夹在中间：
        //   改动（全部暂存 / 撤销暂存 / 丢弃改动）→ 提交 → 同步（拉取 / 推送 / 获取远程）
        // 这正好是日常的先后顺序；原先六个按钮挤在一行里，暂存和同步混在一起。
        children.push(h('div', { style: S.actions, key: 'change-actions' },
          panelButton('全部暂存', () => a.runOp('addAll'), { locked: locked }),
          stagedCount(changes) > 0 ? panelButton('撤销暂存', () => a.runOp('unstage'), { locked: locked }) : null,
          // 「丢弃改动」是唯一不可逆的动作：单独用危险色，别和普通按钮长得一样。
          changes.length > 0
            ? panelButton('丢弃改动', () => {
                if (window.confirm('确定丢弃所有未提交的工作区改动？此操作不可恢复。\n（不影响未跟踪文件；已暂存的内容请先「撤销暂存」。）')) {
                  a.runOp('discard')
                }
              }, { danger: true, locked: locked })
            : null,
        ))

        children.push(h(CommitForm, {
          key: 'commit-form',
          message: s.message,
          amend: s.commitAmend,
          locked: locked,
          onChange: (value) => panel.patch({ message: value }),
          onAmendChange: (value) => panel.patch({ commitAmend: value }),
          onSubmit: a.doCommit,
          onCommitAndPush: a.doCommitAndPush,
        }))

        children.push(h('div', { style: S.sectionTitle, key: 'synctitle' },
          h('span', { style: S.sectionTick }),
          h('span', null, '同步'),
          h('span', { style: S.sectionRule }),
        ))
        children.push(h('div', { style: S.actions, key: 'sync-actions' },
          panelButton('拉取', () => a.runOp('pull', s.pullRebase === true ? { rebase: true } : null), {
            locked: locked,
            title: s.pullRebase === true
              ? '以 git pull --rebase 方式拉取：把你本地的提交挪到远端提交之上（历史更直）'
              : 'git pull：拉取远端更新并合并到当前分支',
          }),
          // 工作区脏的时候「安全拉取」才是该点的那一个 —— 描一圈品牌色，别让用户在
          // 「拉取」和「安全拉取」之间靠读提示猜（两个按钮行为在干净时完全一样）。
          panelButton('安全拉取', () => a.runOp('stashPull'), {
            locked: locked,
            hot: changesTotal > 0,
            title: '本地有未提交改动（含未跟踪文件）时也能拉取：先自动藏起改动，拉取成功后再原样恢复；拉取失败也会自动还给你',
          }),
          panelButton('推送', () => a.push(), { locked: locked }),
          panelButton('获取远程', () => a.runOp('fetch'), { locked: locked }),
          h('label', {
            style: Object.assign({}, S.note, { display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }),
            title: '勾上之后「拉取」改用 --rebase（本地提交挪到远端之上）',
            key: 'rebase',
          },
            h('input', {
              style: S.check,
              type: 'checkbox',
              checked: s.pullRebase === true,
              onChange: (event) => panel.patch({ pullRebase: event.target.checked }),
            }),
            h('span', null, '变基'),
          ),
        ))

        // stash 备份：面板自己藏的改动，收尾也在面板里做完。
        children.push(h('div', { style: S.box, key: 'stash-row' },
          panelButton(
            s.showStash === true ? '收起 stash 备份' : ('stash 备份' + (s.stashList.length > 0 ? '（' + s.stashList.length + '）' : '')),
            () => a.toggleStash(),
            { locked: locked, title: '「安全拉取」「安全切分支」自动藏起来的改动会出现在这里，可以恢复或删除' },
          ),
        ))
        if (s.showStash === true) {
          children.push(h(StashList, {
            key: 'stash-list',
            items: s.stashList,
            locked,
            onApply: a.doStashApply,
            onDelete: a.doStashDrop,
          }))
        }
      } else {
        children.push(h('div', { style: S.actions, key: 'actions' },
          panelButton('初始化仓库', () => a.runOp('init'), { primary: true, locked: locked }),
          panelButton(s.showClone === true ? '收起克隆' : '克隆仓库',
            () => panel.patch({ showClone: s.showClone !== true }), { locked: locked }),
        ))
      }

      if (isRepo !== true && s.showClone === true) {
        children.push(h(CloneForm, {
          key: 'clone-form',
          url: s.cloneUrl,
          shallow: s.cloneShallow,
          locked: locked,
          onChange: (value) => panel.patch({ cloneUrl: value }),
          onShallowChange: (value) => panel.patch({ cloneShallow: value }),
          onClone: async () => {
            const data = await a.runOp('clone', s.cloneShallow === true
              ? { url: s.cloneUrl, depth: 1 }
              : { url: s.cloneUrl })
            // 克隆成功后宿主会回传新仓库的落点（clonedDir），直接切进去并刷新，
            // 省掉「再手动切一次目录」这一步。**这里不走 switchDir**：克隆的输出
            // 正是用户要看的克隆结果，清掉就白跑了。
            if (isOk(data) && hasText(data.clonedDir)) {
              panel.patch({ picked: true, workdir: data.clonedDir, showClone: false, cloneUrl: '' })
              a.load(data.clonedDir)
            }
          },
        }))
      }

      if (commits.length > 0) {
        children.push(h(LogList, {
          key: 'log-list',
          commits,
          openRef: s.logRef,
          onShow: a.doShowCommit,
        }))
      }
      // 提交详情：内联在提交列表下面（与「点改动看 diff」同一套交互），
      // 加载中与失败都写进 logText，所以这里一定有东西可画。
      if (s.logRef.length > 0) {
        // 提交详情用同一个抬头条：短哈希当主体，右侧挂着「提交详情」而不是暂存状态。
        children.push(diffTitleBar({
          path: s.logRef,
          chip: '提交详情',
          title: '这条提交的详情：' + s.logRef,
        }))
        children.push(renderLines(s.logText, S.diff, undefined, 'log-detail'))
      }

      /**
       * 面板下半部分的**固定区**：命令结果、以及「要你选一个结果」的选项都在
       * 正文滚动区之外。
       *
       * 为什么搬出来：这两块都是「刚刚那一下动作的回音」—— 结果栏原先挂在正文最末尾，
       * 点一次「全部暂存」它可能落在滚动区之外（所以才有那个闪一下的补偿）。固定之后
       * 正文怎么滚，回音与待决定的事都在视野里。
       */
      const footer = []
      if (Array.isArray(s.choices) && s.choices.length > 0) {
        footer.push(h(ChoiceBox, { key: 'choices', choices: s.choices, locked, onChoose: a.runChoice }))
      }
      if (hasText(s.output)) {
        footer.push(h('div', { key: 'outblock', style: S.outBlock },
          h('div', { style: S.outBar },
            h('span', { style: S.note }, '命令结果'),
            h('span', { style: S.spacer }),
            panelButton('清空', () => a.clearOutput(), {
              compact: true,
              key: 'clear-output',
              title: '收起这块结果（下一次操作会重新写进来）',
            }),
          ),
          h(OutputPanel, { output: s.output, outRef: panel.outRef }),
        ))
      }

      const upstream = isRepo && s.snapshot !== null && hasText(s.snapshot.upstream)
        ? String(s.snapshot.upstream)
        : null

      /**
       * 拖左缘改宽度（300–520px）。移动过程中只改状态，松手后由那个
       * 「宽度变化就写 localStorage」的 effect 落盘 —— 拖动期间不写盘。
       */
      const startResize = (event) => {
        if (event === null || event === undefined || typeof event.preventDefault !== 'function') return
        event.preventDefault()
        const startX = event.clientX
        const startWidth = typeof s.width === 'number' ? s.width : 360
        const onMove = (moveEvent) => {
          const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startWidth - (moveEvent.clientX - startX)))
          panel.patch({ width: next })
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      // 局部样式表随面板一起挂载/卸载（不写全局样式表，也不动宿主 DOM）。
      return h(React.Fragment, null,
        panelStyles(),
        h('div', {
          style: typeof s.width === 'number'
            ? Object.assign({}, S.panel, { width: s.width + 'px' })
            : S.panel,
          className: 'dgp-panel',
        },
          // 左缘的拖拽条：改宽度用的（见 S.resizeHandle）。双击恢复默认宽度 ——
          // 拖过之后没有别的路回到 360px（除非去清 localStorage）。
          h('div', {
            key: 'resize',
            style: S.resizeHandle,
            className: 'dgp-resize',
            title: '拖动调整面板宽度；双击恢复默认宽度',
            onMouseDown: startResize,
            onDoubleClick: () => panel.patch({ width: null }),
          }),
          h(HeadBar, {
            busy: s.busy,
            showNet: s.showNet,
            onToggleNet: (next) => panel.patch({ showNet: next }),
            onMinimize: () => panel.patch({ minimized: true }),
          }),
          // 正文的滚动区：底部状态条点一下要能把这里的 scrollTop 归零（见 scrollToTop）。
          h('div', { style: S.body, className: 'dgp-body', ref: panel.bodyRef }, children),
          // 固定区（命令结果 / 待选项）：不在滚动区里，所以永远看得见。
          footer.length > 0 ? h('div', { style: S.footer }, footer) : null,
          // 常驻状态条：我在哪个分支、有多少改动、上一次操作成没成。
          h(StatusBar, {
            key: 'status',
            summary: statusSummary(isRepo, s.snapshot, changesTotal),
            tail: isRepo === true ? (upstream === null ? '未设上游' : '→ ' + upstream) : '',
            mismatch: isRepo === true && upstreamNameMismatch(s.snapshot),
            lastOk: s.lastOk,
            onTop: a.scrollToTop,
          })),
        // 目录选择小窗口：与面板同级挂在最外层（fixed 定位，盖住整页），
        // 只在打开时渲染 —— 关掉即卸载，不残留任何浮层。
        s.pickerOpen === true ? h(PickDialog, { key: 'pick-dialog', state: s, actions: a }) : null)
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
          // 开关的实心色跟着**当前状态**走：开启时是高亮的品牌色，关闭时是普通
          // 次要按钮。反过来（关闭才高亮）会让「已关闭」看起来像一个动作按钮。
          className: buttonClass(enabled === true, false),
          style: buttonStyle(enabled === true, false),
          onClick: () => setEnabled(enabled !== true),
        }, enabled === true ? '已开启' : '已关闭'),
      )
    }

    // ── 渲染错误边界 ──────────────────────────────────────────────────────
    //
    // 宿主半边把「故障可见」做得很足（notice、归一化、永不抛异常），客户端却一直
    // 没有这一层：渲染里抛一次异常，整个面板就无声消失 —— 而浏览器控制台对用户不可见，
    // 与「出了问题要看得见」的原则相悖。加一层边界：出错时画一个可读的失败态、
    // 把原因写进宿主日志（diag），并给一个「重试」按钮。
    //
    // 但 React 的错误边界**只能是 class 组件**，而测试是拿假 React 求值 bundle 的
    // （没有 Component，也不支持 new 调用类组件）。所以这里做成「有 Component 才启用」：
    // 真实 React 下是一层真正的边界，假 React 下退化成直接渲染子节点 ——
    // 测试不必为了一个测试替身去实现整个 class 语义。

    function makeErrorBoundary(ComponentBase) {
      if (ComponentBase === null || ComponentBase === undefined) return null
      return class PanelErrorBoundary extends ComponentBase {
        constructor(props) {
          super(props)
          this.state = { error: null }
          this.retry = this.retry.bind(this)
        }
        static getDerivedStateFromError(error) {
          return { error: error }
        }
        componentDidCatch(error) {
          const detail = error !== null && error !== undefined && error.message ? error.message : String(error)
          diag('render-error', detail)
        }
        retry() {
          // 边界捕获后子树已被卸载，清掉 error 即重新挂载一个全新的面板。
          this.setState({ error: null })
        }
        render() {
          if (this.state.error !== null) {
            const detail = this.state.error !== null && this.state.error !== undefined && this.state.error.message
              ? this.state.error.message
              : String(this.state.error)
            return React.createElement('div', { style: S.panel, className: 'dgp-panel' },
              panelStyles(),
              React.createElement('div', { style: S.head },
                React.createElement('span', { style: S.title }, '🐙 Git 面板')),
              React.createElement('div', { style: S.body },
                React.createElement('div', { style: S.empty }, '面板界面出错（原因已写进宿主日志 git-panel.log）'),
                React.createElement('div', { style: S.warn }, '⚠ ' + detail),
                React.createElement('div', { style: S.actions },
                  React.createElement('button', {
                    type: 'button',
                    className: buttonClass(true, false),
                    style: buttonStyle(true, false),
                    onClick: this.retry,
                  }, '重试'))),
            )
          }
          return this.props.children
        }
      }
    }

    const PanelErrorBoundary = makeErrorBoundary(React.Component)

    /** 给组件包一层错误边界；没有可用的 Component 时原样返回。 */
    function withBoundary(component) {
      if (PanelErrorBoundary === null) return component
      return function BoundedPanel(props) {
        return React.createElement(PanelErrorBoundary, null, React.createElement(component, props))
      }
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

    /**
     * 需要的客户端服务（cordis fiber inject）：
     *   · slots       —— 注册界面（面板 + 设置开关行）。
     *   · uiWorkspace —— 目录选择小窗口用的目录服务（listDirectory / createDirectory /
     *     pickDirectory），与 DSH「添加工作区」用的是同一个服务、同一条 wire。
     *
     * 关于 uiWorkspace 为什么要 inject 而不是「读 ctx.remote.directoryPicker」：
     * 客户端服务是 cordis 懒注入的 —— **不声明的服务，在插件上下文里读不到**
     * （ctx.remote 会拿到 undefined）。实测过：那样写小窗口永远拿不到目录服务，
     * 只能手输路径。声明 inject 后 cordis 会等服务就绪再 apply，取到的是真身。
     */
    const inject = ['slots', 'uiWorkspace']

    function apply(ctx) {
      diag('apply:start', ctx !== undefined && ctx.slots !== undefined ? 'slots ready' : 'slots missing')
      // 清掉旧版浮动帮助窗口遗留的 localStorage 键（已无读取方）。
      cleanupLegacyKeys()

      /**
       * 目录选择器的 live getter：面板的「切换」小窗口与 DSH「添加工作区」共用
       * 同一个选择器（uiWorkspace 的 listDirectory / createDirectory / pickDirectory，
       * 宿主那个对话框内部走的也是这几个方法）。
       *
       * 每次打开小窗口时现取（而不是 apply 时抓一次）：服务可能被重载（HMR、
       * 插件重挂），拿最新的那个引用更稳。方法一个一个包成闭包，避免宿主服务
       * 依赖调用时的 this 绑在别处。
       *
       * 注意 list / pick 是**两个能力**：一次启动只组合其中一种（见
       * lib/client.js 顶部的 isBrowseUnavailable）。三条都交出去，让面板按宿主
       * 实际组合出来的那种交互走；缺哪条在调用处退化，不在取值处抛。
       */
      const getPicker = () => {
        try {
          const service = ctx !== null && ctx !== undefined ? ctx.uiWorkspace : undefined
          if (service !== null && service !== undefined) {
            return {
              list: (path, signal) => service.listDirectory(path, signal),
              createDirectory: (path, name) => service.createDirectory(path, name),
              pick: () => {
                if (typeof service.pickDirectory !== 'function') {
                  throw new Error('宿主目录服务没有提供系统对话框')
                }
                return service.pickDirectory()
              },
            }
          }
        } catch (error) {
          /* 取不到就退回手输路径 */
        }
        return null
      }

      // 把 live getter 交给面板（owner 自己传了 getPicker 时以 owner 为准，测试用得上）。
      const BoundPanel = (props) => React.createElement(GitPanel, Object.assign({}, props, {
        getPicker: props !== null && props !== undefined && typeof props.getPicker === 'function'
          ? props.getPicker
          : getPicker,
      }))

      // 右下角浮层面板（包一层渲染错误边界，见 makeErrorBoundary）。
      registerSlot(
        ctx,
        { name: 'shell.overlay', id: 'git-panel', order: 50, label: 'Git 面板' },
        withBoundary(BoundPanel),
        'overlay',
      )
      // 「设置 → 通用」里的开关行。
      registerSlot(
        ctx,
        { name: 'settings.general.item', id: 'git-panel-toggle', order: 30 },
        withBoundary(GitPanelToggle),
        'settings',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
