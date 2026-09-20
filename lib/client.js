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

    /** 执行一个 git 操作，返回 { ok, command, stdout, stderr, message, state, … }。 */
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
      /** 区块小标题：一行小字 + 一条细分隔线，用来切分「改动 / 同步 / 最近提交」。 */
      sectionTitle: {
        display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px',
        color: 'var(--dsw-alias-label-tertiary, #999999)', fontSize: '11px',
        letterSpacing: '.04em',
      },
      sectionRule: { flex: '1 1 auto', height: '1px', background: 'var(--dsw-alias-border-l1, #eeeeee)' },
      row: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      label: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)' },
      path: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      branch: { flex: '0 0 auto', fontWeight: 600 },
      note: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #666666)' },
      /** 状态小胶囊：把「3 处改动（1 已暂存）」这类摘要收成一个视觉单元。 */
      chip: {
        flex: '0 0 auto', padding: '1px 7px', borderRadius: '999px', fontSize: '11px',
        background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
        color: 'var(--dsw-alias-label-secondary, #666666)',
        border: '1px solid var(--dsw-alias-border-l1, #eeeeee)', whiteSpace: 'nowrap',
      },
      /** 有未提交改动时的摘要胶囊：用品牌色描边，让「有东西要提交」一眼可见。 */
      chipActive: {
        flex: '0 0 auto', padding: '1px 7px', borderRadius: '999px', fontSize: '11px',
        background: 'transparent', color: 'var(--dsw-alias-brand-primary, #2563eb)',
        border: '1px solid var(--dsw-alias-brand-primary, #2563eb)', whiteSpace: 'nowrap',
      },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
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
      code: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-state-warn-primary, #d97706)' },
      hash: { flex: '0 0 auto', fontFamily: 'ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-label-tertiary, #999999)' },
      name: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chevron: { flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #999999)' },
      out: {
        margin: 0, padding: '9px', flex: '0 0 auto', maxHeight: '132px', overflow: 'auto', borderRadius: '9px',
        background: 'var(--dsw-alias-markdown-code-block, rgba(0,0,0,.05))',
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
        background: 'var(--dsw-alias-markdown-code-block, rgba(0,0,0,.05))',
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px', lineHeight: 1.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
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
        padding: '10px', borderRadius: '10px', textAlign: 'center',
        border: '1px dashed var(--dsw-alias-border-l2, #dddddd)',
        color: 'var(--dsw-alias-label-tertiary, #999999)', fontSize: '12px',
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
      // 细滚动条：默认滚动条在这个 360px 的小面板里太抢眼
      '.dgp-panel ::-webkit-scrollbar{width:8px;height:8px}',
      '.dgp-panel ::-webkit-scrollbar-track{background:transparent}',
      '.dgp-panel ::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:999px}',
      '.dgp-panel ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary,rgba(0,0,0,.3))}',
      // 按钮：悬停/按下/键盘焦点
      '.dgp-btn{transition:background-color .12s ease,border-color .12s ease,filter .12s ease}',
      '.dgp-btn:not(:disabled):hover{filter:brightness(.95)}',
      '.dgp-btn:not(:disabled):active{transform:translateY(1px)}',
      '.dgp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}',
      '.dgp-btn-ghost:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))!important}',
      '.dgp-btn-danger:not(:disabled):hover{background:var(--dsw-alias-state-error-primary,#dc2626)!important;color:#fff!important;border-color:var(--dsw-alias-state-error-primary,#dc2626)!important}',
      // 头部图标按钮 / 最小化后的胶囊
      '.dgp-mini{transition:background-color .12s ease,color .12s ease}',
      '.dgp-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))!important;color:var(--dsw-alias-label-primary,#111111)!important}',
      '.dgp-mini:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}',
      '.dgp-pill{transition:transform .12s ease,box-shadow .12s ease}',
      '.dgp-pill:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(0,0,0,.24)!important}',
      // 列表行：整行悬停，可点的行给出手型与焦点环
      '.dgp-rowitem{border-radius:6px;padding:2px 5px;margin:0 -3px;transition:background-color .12s ease}',
      '.dgp-rowitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      // 当前展开了 diff 的那一行：左侧一道品牌色竖条，和它下面那块 diff 对上号
      '.dgp-rowitem-active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#2563eb)}',
      '.dgp-clickable{cursor:pointer}',
      '.dgp-clickable:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:1px}',
      // 输入框：聚焦时给一圈可见的焦点环（内联里没有 border-color 的悬停态）
      '.dgp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#2563eb)!important;box-shadow:0 0 0 3px rgba(37,99,235,.16)}',
      // diff 分行着色：文件头/区块头/新增/删除各一色
      '.dgp-diff-line{display:block}',
      '.dgp-diff-meta{color:var(--dsw-alias-label-tertiary,#999999)}',
      '.dgp-diff-hunk{color:var(--dsw-alias-state-business-primary,#2563eb)}',
      '.dgp-diff-add{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dgp-diff-del{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      // 命令结果栏分行着色：命令回显 / stderr / 加速说明 / 下一步提示
      '.dgp-out-cmd{color:var(--dsw-alias-label-secondary,#666666)}',
      '.dgp-out-err{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dgp-out-note{color:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.dgp-out-hint{color:var(--dsw-alias-state-business-primary,#2563eb)}',
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
    function renderLines(text, style, classify, key, ref) {
      const lines = String(text).split('\n')
      return React.createElement('pre', { style: style, key: key, ref: ref },
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
    function buttonStyle(primary, disabled, danger) {
      const filled = primary === true
      return {
        padding: '4px 10px', borderRadius: '8px', fontSize: '12px', whiteSpace: 'nowrap',
        fontWeight: filled === true ? 500 : 400,
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true ? 0.5 : 1,
        border: filled === true
          ? '1px solid var(--dsw-alias-brand-primary, #2563eb)'
          : '1px solid var(--dsw-alias-border-l2, #dddddd)',
        background: filled === true
          ? 'var(--dsw-alias-brand-primary, #2563eb)'
          : 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
        color: filled === true
          ? '#ffffff'
          : (danger === true ? 'var(--dsw-alias-state-error-primary, #dc2626)' : 'var(--dsw-alias-label-primary, #111111)'),
      }
    }

    /** 按钮的类名：实心/次要 + 危险色 + 悬停与焦点环（见 PANEL_CSS）。 */
    function buttonClass(primary, danger) {
      return 'dgp-btn'
        + (primary === true ? ' dgp-btn-primary' : ' dgp-btn-ghost')
        + (danger === true ? ' dgp-btn-danger' : '')
    }

    /** 面板里的一个按钮。locked = 面板正忙（统一禁用，避免并发操作）。 */
    function panelButton(label, onClick, options) {
      const opts = options === null || options === undefined ? {} : options
      const primary = opts.primary === true
      const danger = opts.danger === true
      const locked = opts.locked === true
      return React.createElement('button', {
        key: opts.key === undefined ? label : opts.key,
        type: 'button',
        className: buttonClass(primary, danger),
        style: buttonStyle(primary, locked, danger),
        disabled: locked,
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

    /** 改动条目的稳定标识：同一个文件的「已暂存 / 未暂存」是两个不同的 diff。 */
    function changeKey(item) {
      return (item.staged === true ? 's:' : 'u:') + String(item.path)
    }

    // ── 面板状态：一个 reducer 管全部 ─────────────────────────────────────
    //
    // 为什么不是一堆 useState：面板上有一批状态属于**某个具体仓库**（命令结果、
    // 展开的 diff、分支列表、提交草稿、远程地址草稿、待选选项…）。用独立 state 时，
    // 换工作区必须逐个手写清理，**漏一个就会把旧仓库的数据显示成新仓库的**——
    // 上一版就漏了 branchDraft 与 dirDraft（切换目录的输入框里还留着上一个仓库的路径）。
    // 收进一个 reducer 后，清理只有一个动作（'reset-repo'），新增字段不可能再漏。

    const PANEL_INITIAL = {
      minimized: false,
      workdir: '',
      dirDraft: '',
      editingDir: false,
      picked: false,
      snapshot: null,
      busy: false,
      message: '',
      output: '',
      cloneUrl: '',
      showClone: false,
      remoteUrl: '',
      remoteName: 'origin',
      showRemote: false,
      remoteDirty: false,
      remoteError: '',
      showBranches: false,
      branches: null,
      remoteBranches: null,
      branchDraft: '',
      diffKey: '',
      diffText: '',
      choices: null,
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
      dirDraft: '',
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

      /** 读一次仓库状态。序号校验保证只有最新那次的结果会被采用。 */
      const load = async (requested) => {
        const seq = ++loadSeqRef.current
        patch({ busy: true })
        try {
          const data = await fetchState(typeof requested === 'string' ? requested : '')
          // 期间又切换过一次：这条响应已经过时，丢掉 —— 否则旧目录的状态会把刚切
          // 过去的面板盖回去。（过期的这一条不碰 busy：锁归最新那次请求收尾。）
          if (seq !== loadSeqRef.current) return
          const nextDir = hasText(data.dir) ? data.dir : null
          shownDirRef.current = nextDir
          const fields = {
            snapshot: data,
            // 刷新/切仓库后，上一轮「需要你选一个结果」的选项就过期了（那时的远端状态
            // 可能已经变了）；要重新决策就再点一次「拉取」，宿主会重新给出选项。
            choices: null,
          }
          if (nextDir !== null) fields.workdir = nextDir
          patch(fields)
        } catch (error) {
          if (seq !== loadSeqRef.current) return
          patch({ output: '读取状态失败：' + String(error && error.message ? error.message : error) })
        }
        patch({ busy: false })
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
          const data = await response.json().catch(() => null)
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
            body: JSON.stringify(changes),
          })
          const data = await response.json().catch(() => null)
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
            }
            if (data.state !== null && typeof data.state === 'object') fields.snapshot = data.state
            // 宿主有时会回一组「需要你选一个结果」的选项（例如拉取撞上两套互不相关的
            // 历史）。渲染成按钮，用户点一下就把决定交给面板去执行。
            fields.choices = Array.isArray(data.choices) && data.choices.length > 0 ? data.choices : null
            patch(fields)
          }
        } catch (error) {
          const reason = String(error && error.message ? error.message : error)
          patch({ output: '操作失败：' + reason })
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

      // 下面这些动作都**不再手动 load()**：宿主在 op 响应里已经带回了最新状态，
      // runOp 会把它写进 snapshot。手动再拉一次状态是纯浪费（每次 4 条 git 进程）。

      /** 切换分支：成功后刷新分支列表（当前分支的标记变了）。 */
      const doCheckout = async (name) => {
        const data = await runOp('checkout', { branch: name })
        if (isOk(data)) await fetchBranches()
      }

      /** 新建分支并切换（输入框回车或点按钮）。 */
      const doCreateBranch = async () => {
        const name = state.branchDraft.trim()
        if (name.length === 0) return
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

      /** 提交：失败时把输入文本写回，方便修改后重试（空提交、钩子失败很常见）。 */
      const doCommit = async () => {
        const text = state.message
        patch({ message: '' })
        const data = await runOp('commit', { message: text })
        if (isOk(data) !== true) patch({ message: text })
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

      return {
        state,
        patch,
        diffRef,
        sessionCwd,
        actions: {
          load, switchDir, forgetRepoDetails, loadNet, saveNet, probeNet, runOp, runChoice,
          fetchBranches, toggleBranches, doCheckout, doCreateBranch, doDeleteBranch,
          doAdoptRemoteBranch, doCompareRemoteBranch, showDiff, push, saveRemote,
          saveRemoteAndPush, doCommit,
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
      return h('div', { style: S.head, key: 'head' },
        h('span', { style: S.title }, '🐙 Git 面板'),
        props.busy === true ? h('span', { style: S.note }, '同步中…') : null,
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
                style: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: '10px' },
                title: '有未提交的改动',
              }, '●')
            : null,
          dirty ? h('span', { key: 'count', style: S.chip, title: '未提交的改动数量' }, String(props.count)) : null,
        ))
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
        s.editingDir === true
          ? h('input', {
              style: S.input,
              className: 'dgp-input',
              value: s.dirDraft,
              placeholder: '绝对路径，如 /home/me/project',
              onChange: (event) => props.onDirDraft(event.target.value),
            })
          : h('span', { style: S.path, title: s.workdir }, hasText(s.workdir) ? s.workdir : '（默认目录）'),
        s.editingDir === true
          ? panelButton('确定', () => props.onConfirmDir(s.dirDraft), { locked: locked })
          : panelButton('切换', () => props.onStartEditDir(s.workdir), { locked: locked }),
        panelButton('刷新', () => props.onRefresh(), { locked: locked }),
        s.picked === true && hasText(props.sessionCwd)
          ? panelButton('跟随会话', () => props.onFollowSession(props.sessionCwd), { locked: locked })
          : null,
      ))

      const upstream = isRepo && hasText(s.snapshot.upstream) ? s.snapshot.upstream : null
      rows.push(h('div', { style: S.row, key: 'branch' },
        h('span', { style: S.label }, '分支'),
        h('span', { style: S.branch }, isRepo
          ? (hasText(s.snapshot.branch) ? s.snapshot.branch : '（尚无提交）')
          : '—'),
        // 上游状态：`→ origin/master`；没有上游时明说，并在 tooltip 里指向按钮
        // （面板的「拉取」会自动补这一步，所以不要求用户去记 git 命令）。
        isRepo
          ? h('span', {
              style: S.note,
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
      const card = [
        h('div', { style: S.sectionTitle, key: 'localtitle' },
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
                  title: item.current === true ? '当前分支' : '点击切换到此分支',
                  onClick: item.current === true ? undefined : () => props.onCheckout(item.name),
                }, item.name),
                h('span', { style: S.spacer }),
                item.current === true
                  ? h('span', { style: S.note }, '当前')
                  : panelButton('删除', () => props.onDeleteBranch(item.name), { locked: locked }),
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
          panelButton('新建', () => props.onCreateBranch(), { primary: true, locked: locked }),
        ),
      ]

      // 远端分支。点它**不直接切换**（那会变成游离 HEAD，对不懂 git 的人是坑），
      // 只给两个安全动作：拿成新分支（当前分支一点不动）、和本地比一比差多少。
      card.push(h('div', { style: S.sectionTitle, key: 'remotetitle' },
        h('span', null, remoteItems.length === 0 ? '远端分支' : '远端分支（' + remoteItems.length + '）'),
        h('span', { style: S.sectionRule }),
      ))
      card.push(h('div', { style: S.note, key: 'remotehint' },
        remoteItems.length === 0
          ? '点一次「获取远程」就能在这里看到（只下载，不改你的代码）'
          : '「拿成新分支」把远端那份取到本地，当前分支一点不动'))
      for (let index = 0; index < remoteItems.length; index += 1) {
        const item = remoteItems[index]
        card.push(h('div', { style: S.item, className: 'dgp-rowitem', key: 'r' + index },
          h('span', {
            style: S.name,
            title: item.head === true ? '远端默认分支' : '远端分支（获取远程时下载到本地）',
          }, item.ref + (item.head === true ? '（默认）' : '')),
          h('span', { style: S.spacer }),
          panelButton('拿成新分支', () => props.onAdopt(item), { locked: locked }),
          panelButton('比较', () => props.onCompare(item), { locked: locked }),
        ))
      }

      return h('div', { style: S.card, key: 'branch-card' }, card)
    }

    /** 一条改动（整行可点、可键盘触达）。 */
    function changeRow(item, open, onToggle) {
      return React.createElement('div', {
        style: S.item,
        // 展开中的那一行带品牌色竖条（dgp-rowitem-active），和下面的 diff 对上号。
        className: 'dgp-rowitem dgp-clickable' + (open ? ' dgp-rowitem-active' : ''),
        key: 'c' + changeKey(item),
        title: (item.staged === true ? '已暂存' : '未暂存') + ' · 点击查看 diff（再点收起）',
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
        React.createElement('span', {
          style: Object.assign({}, S.marker, {
            color: item.staged === true
              ? 'var(--dsw-alias-state-success-primary, #16a34a)'
              : 'var(--dsw-alias-label-tertiary, #999999)',
          }),
        }, item.staged === true ? '●' : '○'),
        React.createElement('span', { style: codeStyle(item.staged) }, String(item.code)),
        React.createElement('span', { style: S.name }, String(item.path)),
        React.createElement('span', { style: S.chevron }, open ? '▲' : '▼'),
      )
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
        rows.push(changeRow(item, open, props.onToggle))
        if (open) {
          rows.push(renderLines(props.diffText, S.diff, diffLineClass, 'diff', props.diffRef))
          diffInline = true
        }
      }
      // 兜底：清单在 diff 打开之后被刷新掉了（典型是点了「全部暂存」，条目的已暂存
      // 状态翻转、key 对不上任何一行）—— diff 仍要有地方显示，不能凭空消失。
      // 同样放进清单内部：与文件行共用同一个滚动区。
      if (props.diffKey.length > 0 && diffInline !== true) {
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
          h('span', null, '改动'),
          h('span', { style: S.sectionRule }),
          h('span', {
            style: changes.length > 0 ? S.chipActive : S.chip,
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
      return renderLines(props.output, S.out, outputLineClass, 'out')
    }

    /** 空态：还不是仓库 / 状态读取失败。**宿主给的 notice 才是「为什么」**。 */
    function EmptyState(props) {
      const h = React.createElement
      const notice = hasText(props.notice) ? props.notice : null
      // 「还不是仓库」这句和下面的通用说明重复，就不再叠一遍；其余（未装 git、
      // 读取失败、权限问题…）都要显示出来 —— 那是用户唯一能看到的诊断。
      const extra = notice !== null && notice !== '当前目录还不是 Git 仓库' ? notice : null
      return h('div', { style: S.empty, key: 'hint' },
        h('div', null, '这个目录里还没有 Git 仓库：可以点下面的按钮初始化一个，或者克隆一个已有的仓库。'),
        extra === null ? null : h('div', { style: S.warn }, '⚠ ' + extra),
      )
    }

    /** 提交表单（回车即提交）。 */
    function CommitForm(props) {
      const h = React.createElement
      return h('form', {
        style: S.box, key: 'commit',
        onSubmit: (event) => { event.preventDefault(); props.onSubmit() },
      },
        h('input', {
          style: S.input,
          className: 'dgp-input',
          value: props.message,
          placeholder: '填写提交信息…（回车直接提交）',
          onChange: (event) => props.onChange(event.target.value),
        }),
        h('button', {
          className: buttonClass(true, false),
          style: buttonStyle(true, props.locked === true),
          disabled: props.locked === true,
          type: 'submit',
        }, '提交'),
      )
    }

    /** 最近提交列表。 */
    function LogList(props) {
      const h = React.createElement
      return [
        h('div', { style: S.sectionTitle, key: 'logtitle' },
          h('span', null, '最近提交'),
          h('span', { style: S.sectionRule }),
        ),
        h('div', { style: S.list, key: 'log' },
          props.commits.slice(0, 8).map((item, index) => h('div', {
            style: S.item, className: 'dgp-rowitem', key: 'l' + index,
          },
            h('span', { style: S.hash }, String(item.hash)),
            h('span', { style: S.name, title: String(item.subject) }, String(item.subject)),
          )),
        ),
      ]
    }

    /** 克隆表单（还不是仓库时才出现）。 */
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
        onDirDraft: (value) => panel.patch({ dirDraft: value }),
        onStartEditDir: (current) => panel.patch({ dirDraft: current, editingDir: true }),
        onConfirmDir: (target) => {
          panel.patch({ picked: true, editingDir: false })
          a.switchDir(target)
        },
        onRefresh: () => a.load(s.workdir),
        onFollowSession: (target) => {
          panel.patch({ picked: false, editingDir: false })
          a.switchDir(target)
        },
        onToggleBranches: a.toggleBranches,
        onToggleRemote: () => panel.patch({ showRemote: s.showRemote !== true, remoteError: '' }),
        onRemoteName: (value) => panel.patch({ remoteName: value }),
        // 用户一改就置脏：此后只有保存成功或换仓库才会让 state 重新播种。
        onRemoteUrl: (value) => panel.patch({ remoteDirty: true, remoteUrl: value }),
        onSaveRemote: a.saveRemote,
        onSaveRemoteAndPush: a.saveRemoteAndPush,
      }))

      if (isRepo === true && s.showBranches === true) {
        children.push(h(BranchManager, {
          key: 'branch-manager',
          state: s,
          locked: locked,
          onCheckout: a.doCheckout,
          onCreateBranch: a.doCreateBranch,
          onDeleteBranch: a.doDeleteBranch,
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
          onToggle: a.showDiff,
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
          locked: locked,
          onChange: (value) => panel.patch({ message: value }),
          onSubmit: a.doCommit,
        }))

        children.push(h('div', { style: S.sectionTitle, key: 'synctitle' },
          h('span', null, '同步'),
          h('span', { style: S.sectionRule }),
        ))
        children.push(h('div', { style: S.actions, key: 'sync-actions' },
          panelButton('拉取', () => a.runOp('pull'), { locked: locked }),
          panelButton('推送', () => a.push(), { locked: locked }),
          panelButton('获取远程', () => a.runOp('fetch'), { locked: locked }),
        ))
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
          locked: locked,
          onChange: (value) => panel.patch({ cloneUrl: value }),
          onClone: async () => {
            const data = await a.runOp('clone', { url: s.cloneUrl })
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

      if (commits.length > 0) children.push(h(LogList, { key: 'log-list', commits }))
      children.push(h(OutputPanel, { key: 'output', output: s.output }))
      if (Array.isArray(s.choices) && s.choices.length > 0) {
        children.push(h(ChoiceBox, { key: 'choices', choices: s.choices, locked, onChoose: a.runChoice }))
      }

      // 局部样式表随面板一起挂载/卸载（不写全局样式表，也不动宿主 DOM）。
      return h(React.Fragment, null,
        panelStyles(),
        h('div', { style: S.panel, className: 'dgp-panel' },
          h(HeadBar, {
            busy: s.busy,
            showNet: s.showNet,
            onToggleNet: (next) => panel.patch({ showNet: next }),
            onMinimize: () => panel.patch({ minimized: true }),
          }),
          h('div', { style: S.body }, children)))
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
