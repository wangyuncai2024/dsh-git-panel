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

    // ── 视觉基线（内联样式） ─────────────────────────────────────────────
    //
    // 分三层，各管一件事：
    //   1. S.*        —— 内联样式：布局与基础外观。它必须能**独立撑住**界面 ——
    //                    即使下面的样式表因为任何原因没生效，面板也只是少了悬停
    //                    反馈和 diff 着色，不会退化成一堆裸控件。
    //   2. PANEL_CSS  —— 内联 style 表达不了的部分：:hover / :focus-visible /
    //                    过渡 / 滚动条外观 / diff 与结果栏的分行着色。
    //   3. 主题 token —— 所有颜色一律走 --dsw-alias-*，浅色/深色自动跟随宿主；
    //                    括号里只是 token 缺失时（老宿主、独立调试）的兜底值。
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

    /** 命令结果行着色：命令回显、stderr、加速说明、下一步提示各一色。 */
    function outputLineClass(line) {
      if (line.startsWith('$ ')) return 'dgp-out-cmd'
      if (line.startsWith('[stderr]')) return 'dgp-out-err'
      if (line.startsWith('⇢ ')) return 'dgp-out-note'
      if (line.startsWith('→ ')) return 'dgp-out-hint'
      return undefined
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
      // 草稿是否被用户改过。**不能用「输入框有没有焦点」判定在不在编辑**：
      // 点「保存」会让输入框先失焦，React 在 mousedown 与 click 之间把播种草稿的
      // effect 刷掉，草稿被覆盖回旧值（没有远程时是空串），saveRemote 于是读到
      // 空值 —— 表现就是填了地址点保存却提示「请填写仓库地址」，命令根本没发出去。
      const [remoteDirty, setRemoteDirty] = React.useState(false)
      const [remoteError, setRemoteError] = React.useState('')
      const [showBranches, setShowBranches] = React.useState(false)
      const [branches, setBranches] = React.useState(null)
      // 远端分支（`git branch --remotes` 的结果）。获取远程之后 refs/remotes/<remote>/*
      // 就已经在本地了，这里只是把它显示出来 —— 本地初始化出来的分支叫 master、
      // 远端默认分支叫 main 时，面板原先根本没有任何地方能看到 origin/main。
      const [remoteBranches, setRemoteBranches] = React.useState(null)
      const [branchDraft, setBranchDraft] = React.useState('')
      const [diffKey, setDiffKey] = React.useState('')
      const [diffText, setDiffText] = React.useState('')
      // 宿主回传的「需要你选一个结果」的选项（例如拉取撞上两套互不相关的历史）。
      // 面板把它们渲染成按钮 —— 用户只需要选结果，不需要懂 git 命令。
      const [choices, setChoices] = React.useState(null)
      // ── 网络加速（宿主侧的一份配置，面板只是它的界面） ──
      // net：宿主回的配置视图（proxy 已打码）；netProxy 是输入框草稿 —— 不直接绑
      // net.proxy，否则打码串会被写回宿主，把真凭据覆盖掉。
      const [net, setNet] = React.useState(null)
      const [showNet, setShowNet] = React.useState(false)
      const [netProxy, setNetProxy] = React.useState('')
      const [netProbe, setNetProbe] = React.useState(null)
      const [netBusy, setNetBusy] = React.useState(false)

      // 面板当前绑在哪个仓库目录上（宿主归一化后的绝对路径；null = 还不知道）。
      // 判断一条**迟到**的异步结果还算不算数全靠它：拉取/推送/克隆这些操作在宿主
      // 侧的超时是 10 分钟，用户完全可能在结果回来之前就切到别的工作区去了。
      const shownDirRef = React.useRef(null)
      // 状态请求序号：同时只认最新一次请求的结果（切工作时上一条 state 请求可能还在飞）。
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
      // 目录（宿主进程的 cwd，实测是 ~/.dsh/profiles/web），"跟随会话"从来没生效过。
      // 当时测试里的假 store 也照抄了同一个不存在的字段，所以测试一直是绿的 ——
      // 这里的形状必须与真实契约一致，见 test/client.test.mjs 的 sessionStore。
      const useSessions = props !== null && props !== undefined && typeof props.useSessions === 'function'
        ? props.useSessions
        : null
      const sessionCwd = useSessions === null ? undefined : useSessions((state) => {
        if (state === null || state === undefined) return undefined
        const rows = state.byId
        if (rows === undefined || rows === null) return undefined
        for (const row of Object.values(rows)) {
          if (row === null || row === undefined) continue
          const retained = row.retainedBy
          if (retained === null || retained === undefined || !((retained.mainView ?? 0) > 0)) continue
          return typeof row.cwd === 'string' && row.cwd.length > 0 ? row.cwd : undefined
        }
        return undefined
      })

      const load = async (requested) => {
        const seq = ++loadSeqRef.current
        setBusy(true)
        try {
          const data = await fetchState(typeof requested === 'string' ? requested : '')
          // 期间又切换过一次：这条响应已经过时，丢掉 —— 否则旧目录的状态会把刚切
          // 过去的面板盖回去。（过期的这一条不碰 busy：锁归最新那次请求收尾。）
          if (seq !== loadSeqRef.current) return
          const nextDir = typeof data.dir === 'string' && data.dir.length > 0 ? data.dir : null
          shownDirRef.current = nextDir
          setSnapshot(data)
          // 刷新/切仓库后，上一轮「需要你选一个结果」的选项就过期了（那时的远端状态
          // 可能已经变了）；要重新决策就再点一次「拉取」，宿主会重新给出选项。
          setChoices(null)
          if (nextDir !== null) setWorkdir(nextDir)
        } catch (error) {
          if (seq !== loadSeqRef.current) return
          setOutput('读取状态失败：' + String(error && error.message ? error.message : error))
        }
        setBusy(false)
      }

      /**
       * 清掉「属于上一个工作区」的瞬时结果。
       *
       * 面板上有一批状态是**某个具体仓库的运行结果**，不是全局界面状态：命令结果栏、
       * 展开的 diff、分支列表、提交信息草稿、远程地址错误。这些字段原先没人管，
       * 换工作区时只有 snapshot 被替换，于是面板已经显示新仓库了，最下面的命令结果栏
       * 还挂着旧仓库上一次 git 操作的输出（用户看到的正是这个）。
       *
       * 注意：**不能把它挂在「目录变了」上**。克隆成功后也会换目录，但那时输出正是
       * 用户要看的克隆结果。所以只在真正由用户发起的切换入口调用（见 switchDir）。
       */
      const forgetRepoDetails = () => {
        setOutput('')
        setDiffKey('')
        setDiffText('')
        // 分支列表属于旧仓库，收起管理器（再打开会重新拉一次）。留着展开会让
        // branches 变成 null，界面显示成「还没有分支」，那是对新仓库的谎报。
        setBranches(null)
        setRemoteBranches(null)
        setShowBranches(false)
        setMessage('')
        setRemoteError('')
        // 草稿属于旧仓库：切走后必须重新播种，否则用户在上一个仓库填了一半的
        // 地址会被带到新仓库，还可能被当成新仓库的地址保存下去。
        setRemoteDirty(false)
        // 「需要你选一个结果」的按钮同理属于旧仓库。
        setChoices(null)
      }

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
          if (data === null || typeof data !== 'object' || data.ok !== true) return
          setNet(data)
          if (refreshProxy === true) setNetProxy(typeof data.proxy === 'string' ? data.proxy : '')
        } catch (error) {
          // 网络加速只是为了修「连不上」，它自己读不到绝不能让面板跟着坏掉。
        }
      }

      /** 保存配置。patch 里只放要改的字段，其余保持不动。 */
      const saveNet = async (patch, refreshProxy) => {
        setNetBusy(true)
        try {
          const response = await fetch('/git-panel/net', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const data = await response.json().catch(() => null)
          if (data === null || typeof data !== 'object' || data.ok !== true) {
            const why = data !== null && typeof data.message === 'string' ? data.message : 'HTTP ' + response.status
            setOutput('保存网络加速设置失败：' + why)
            return
          }
          setNet(data)
          if (refreshProxy === true) setNetProxy(typeof data.proxy === 'string' ? data.proxy : '')
        } catch (error) {
          setOutput('保存网络加速设置失败：' + String(error && error.message ? error.message : error))
        } finally {
          setNetBusy(false)
        }
      }

      /** 现场实测每条线路（直连 / 各镜像 / 代理），把结果原样列出来。 */
      const probeNet = async () => {
        setNetBusy(true)
        setNetProbe(null)
        try {
          const response = await fetch('/git-panel/net?probe=1', { cache: 'no-store' })
          const data = await response.json().catch(() => null)
          if (data === null || typeof data !== 'object' || data.ok !== true) {
            setOutput('检测网络失败：HTTP ' + response.status)
            return
          }
          setNetProbe(Array.isArray(data.results) ? data.results : [])
        } catch (error) {
          setOutput('检测网络失败：' + String(error && error.message ? error.message : error))
        } finally {
          setNetBusy(false)
        }
      }

      // 只读一次；失败就静默保持「未加载」，面板其余部分照常可用。
      React.useEffect(() => { loadNet(true) }, [])

      // 跟随当前会话目录刷新；用户手动切换过目录后不再覆盖。
      // 当前会话的 cwd 变了就是「换了工作区」，走 switchDir 连旧工作区的运行结果
      // 一起清掉。（首次运行时这些字段本来就是空的，多清一次是无操作。）
      React.useEffect(() => {
        if (picked === true) return
        switchDir(typeof sessionCwd === 'string' && sessionCwd.length > 0 ? sessionCwd : '')
      }, [sessionCwd])

      // diff 一展开就把它滚进可视区：它内联在改动清单里，清单本身和面板正文都可能
      // 需要滚动 —— 不滚的话用户点了一下可能什么都没看见（以为没反应）。
      // scrollIntoView 只在真实浏览器里有（测试里的假节点没有），所以先判类型。
      React.useEffect(() => {
        if (diffKey.length === 0) return
        const node = diffRef.current
        if (node === null || node === undefined || typeof node.scrollIntoView !== 'function') return
        node.scrollIntoView({ block: 'nearest' })
      }, [diffKey])

      const remotes = snapshot !== null && Array.isArray(snapshot.remotes) ? snapshot.remotes : []

      /**
       * 从 state 同步远程地址草稿：**只在用户没动过草稿时播种**。
       *
       * 判定条件必须是「用户改没改过」，不能是「输入框有没有焦点」：点「保存」会
       * 让输入框先失焦，焦点判定在这一刻必然失效（见 remoteDirty 的注释）。
       * 顺带也修掉了另一个同源问题：用户填了地址还没保存时，任何一次状态刷新
       * （提交、暂存、拉取……）都会把草稿覆盖掉。
       */
      React.useEffect(() => {
        if (remoteDirty === true) return
        setRemoteUrl(remotes.length > 0 ? remotes[0].url : '')
      }, [snapshot, remoteDirty])

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
          // 这条结果是哪个仓库的？宿主在 state.dir 里回了这次操作真正作用的目录。
          const resultDir = data.state !== null && typeof data.state === 'object' && typeof data.state.dir === 'string'
            ? data.state.dir
            : null
          // 操作跑得比用户切换工作区慢时（拉取/推送/克隆的宿主超时是 10 分钟），结果
          // 回来时面板已经绑在另一个仓库上了。这时必须**整条丢弃**：既不能把旧仓库的
          // 输出写进命令结果栏，也不能用旧仓库的状态盖掉新仓库的面板。
          // 只有两边目录都确知、且确实不同才丢；信息不全（state/dir 缺失）一律照单
          // 接收 —— 宁可少拦一次，也不能把真实输出吞掉。
          const stale = resultDir !== null && shownDirRef.current !== null && resultDir !== shownDirRef.current
          // quiet：数据型操作（列分支、查 diff）不回显命令输出，避免把 output 框
          // 刷成一大段 git 原文；失败时仍回显，保证错误可见。
          const parts = []
          if (typeof data.command === 'string') parts.push('$ ' + data.command)
          if (typeof data.stdout === 'string' && data.stdout.length > 0) parts.push(data.stdout.replace(/\s+$/, ''))
          if (typeof data.stderr === 'string' && data.stderr.length > 0) parts.push('[stderr] ' + data.stderr.replace(/\s+$/, ''))
          if (typeof data.message === 'string' && data.message.length > 0) parts.unshift(data.message)
          // 加速说明：告诉用户这条命令刚才走了镜像/代理。**不能只在界面上默默生效** ——
          // 走镜像意味着请求经过了第三方，用户必须能看见这件事。
          if (Array.isArray(data.notes)) {
            for (const note of data.notes) parts.push('⇢ ' + String(note))
          }
          if (typeof data.hint === 'string' && data.hint.length > 0) parts.push('→ ' + data.hint)
          // 判定是「网络连不上」时自动展开加速设置：提示里说了「点 🌐」，那就替用户点开，
          // 否则他还要自己找那个按钮在哪。
          if (data.network === true) setShowNet(true)
          if (stale !== true) {
            if (resultDir !== null) shownDirRef.current = resultDir
            if (quiet !== true || data.ok !== true) setOutput(parts.length > 0 ? parts.join('\n') : '完成')
            if (data.state !== null && typeof data.state === 'object') setSnapshot(data.state)
            // 宿主有时会回一组「需要你选一个结果」的选项（例如拉取撞上两套互不相关的
            // 历史）。渲染成按钮，用户点一下就把决定交给面板去执行。
            setChoices(Array.isArray(data.choices) && data.choices.length > 0 ? data.choices : null)
          }
        } catch (error) {
          const reason = String(error && error.message ? error.message : error)
          setOutput('操作失败：' + reason)
          // 归一化成失败结果：调用方统一用 data.ok 判断，否则只会得到「未知错误」。
          data = { ok: false, message: reason }
        }
        setBusy(false)
        return data
      }

      /**
       * 执行宿主给出的一个「选择」（见上面的 choices 与渲染处）。
       *
       * 这类按钮常常是不可逆的（例如「让当前分支直接变成远端那份」），所以：
       *   · 带 confirm 的必须先确认，用户取消就什么都不做；
       *   · 执行前先 forgetRepoDetails()：切换分支/覆盖工作区之后，旧的分支列表、
       *     diff、上一轮输出都属于「上一份内容」，留着就是谎报（结果栏随后会写上本次结果）。
       */
      const runChoice = async (choice) => {
        const op = typeof choice.op === 'string' ? choice.op : ''
        if (op.length === 0) return
        if (typeof choice.confirm === 'string' && choice.confirm.length > 0) {
          if (window.confirm(choice.confirm) !== true) return
        }
        forgetRepoDetails()
        await runOp(op, choice.params !== null && typeof choice.params === 'object' ? choice.params : null)
      }

      /**
       * 拉取分支列表（分支管理器打开时调用；branch -d/-D 后也会重新拉）。
       * 本地、远端各查一次：两者都是本地命令、不联网，但远端那份必须先「获取远程」
       * 过（那是把 refs/remotes/<remote>/* 下载下来的唯一入口）。
       */
      const fetchBranches = async () => {
        const keep = (data, field, setter) => {
          if (data !== null && data !== undefined && data.ok === true
            && data[field] !== null && data[field] !== undefined) {
            setter(data[field])
          }
        }
        keep(await runOp('branches', null, true), 'branches', setBranches)
        keep(await runOp('remoteBranches', null, true), 'remoteBranches', setRemoteBranches)
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
       * 点远端分支的「拿成新分支」：把远端那一份开成一个本地新分支并切过去
       * （宿主执行 `git switch -c <remote>-<branch> <remote>/<branch>`）。
       * 当前分支一点都不动 —— 「本地 master、远端 main」时这是最安全的那条路。
       * 远端分支名**显式传给宿主**：这一条的正常场景恰恰是两边名字不一样。
       */
      const doAdoptRemoteBranch = async (item) => {
        const data = await runOp('adoptRemote', { mode: 'branch', remote: item.remote, branch: item.name })
        if (data !== null && data !== undefined && data.ok === true) {
          load(workdir)
          fetchBranches()
        }
      }

      /**
       * 点远端分支的「比较」：宿主跑 `git rev-list --left-right --count HEAD...<ref>`，
       * 原始输出只是两列数字，所以由宿主翻成人话放进 notes 一起回显。
       */
      const doCompareRemoteBranch = async (item) => {
        await runOp('compare', { ref: item.ref })
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
          // 保存成功：草稿已落盘，交回给 state 播种（新的 snapshot 里就是这条地址）。
          setRemoteDirty(false)
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
        const dirtyCount = dirty ? snapshot.changes.length : 0
        // 胶囊里带上改动数量：最小化之后「有几处要提交」仍然是一眼可见的，
        // 不必为了看个数字把面板再展开一次。
        const pillChildren = [
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
          dirty
            ? h('span', { key: 'count', style: S.chip, title: '未提交的改动数量' }, String(dirtyCount))
            : null,
        ]
        return h(React.Fragment, null,
          panelStyles(),
          h('div', {
            style: S.pill,
            className: 'dgp-pill',
            title: '展开 Git 面板' + (dirty ? '（' + dirtyCount + ' 处未提交改动）' : ''),
            onClick: () => setMinimized(false),
          }, pillChildren))
      }

      const isRepo = snapshot !== null && snapshot.isRepo === true
      const changes = isRepo && Array.isArray(snapshot.changes) ? snapshot.changes : []
      const commits = isRepo && Array.isArray(snapshot.log) ? snapshot.log : []
      // 上游：本地分支对应远端的哪个分支（宿主从 `git status -sb` 的分支行解析而来）。
      // 必须显示出来 —— 没有上游时裸 `git pull` 必然失败，而面板原先只显示「领先/落后」，
      // 没上游时那个数字本来就是 0，用户除了撞一次报错没有任何办法知道缺了这一步。
      const upstream = isRepo && typeof snapshot.upstream === 'string' && snapshot.upstream.length > 0
        ? snapshot.upstream
        : null
      const locked = busy === true

      const btn = (label, onClick, primary, danger) => h('button', {
        key: label,
        type: 'button',
        className: buttonClass(primary === true, danger === true),
        style: buttonStyle(primary === true, locked, danger === true),
        disabled: locked,
        onClick: onClick,
      }, label)

      // 头部：标题 + 「同步中」提示 + 右侧图标按钮组。
      // 三个图标的**文本标签一个字都不改**（🌐 / ? / —）：用户和测试都按它找按钮。
      const head = h('div', { style: S.head, key: 'head' },
        h('span', { style: S.title }, '🐙 Git 面板'),
        busy === true ? h('span', { style: S.note }, '同步中…') : null,
        h('span', { style: S.spacer }),
        h('div', { style: S.headActions },
          h('button', {
            style: S.mini,
            className: 'dgp-mini',
            key: 'net',
            type: 'button',
            'aria-label': '网络加速设置',
            title: '网络加速：连不上 github.com（Connection was reset / 超时）时打开，可走镜像或本机代理',
            onClick: () => setShowNet(showNet !== true),
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
            onClick: () => setMinimized(true),
          }, '—'),
        ),
      )

      const children = []

      // 网络加速设置块：放在最前面 —— 它解释「为什么刚才那条命令连不上」，
      // 用户点开时最该先看到它。
      if (showNet === true) {
        const netCfg = net !== null && typeof net === 'object' ? net : {}
        const netCandidates = Array.isArray(netCfg.candidates) ? netCfg.candidates : []
        // 这里刻意不用 btn()：那个会被 busy 锁住，而用户在等待一次卡住的 fetch 时
        // 恰恰最需要能改设置。
        const netBtn = (label, onClick, primary) => h('button', {
          key: label,
          type: 'button',
          className: buttonClass(primary === true, false),
          style: buttonStyle(primary === true, netBusy === true),
          disabled: netBusy === true,
          onClick: onClick,
        }, label)

        // 配置读不到（典型是「客户端已热重载、宿主还没重启」）时**只显示说明**：
        // 控件照着渲染而没有宿主可写，比不显示更糟 —— 用户会点、会以为生效了。
        const netReady = net !== null && typeof net === 'object'
        const netChildren = [
          h('div', { style: S.netTitle, key: 'title' },
            h('span', null, '🌐 网络加速'),
            h('span', { style: S.spacer }),
            h('span', { style: S.note }, netReady !== true
              ? '不可用'
              : (netCfg.mirrorEnabled === true
                  ? '镜像已开' + (netCfg.hasProxy === true ? ' + 代理' : '')
                  : (netCfg.hasProxy === true ? '仅代理' : '仅直连'))),
          ),
        ]

        if (netReady !== true) {
          netChildren.push(h('div', { style: S.warn, key: 'unavailable' },
            '读不到宿主配置：宿主半边还是旧版本，重启一次 dsh 后本设置即可用'
            + '（客户端界面会热重载，但宿主路由不会）。'))
        } else {
          netChildren.push(
            h('div', { style: S.netRow, key: 'mirrorpick' },
              h('select', {
                style: S.select,
                className: 'dgp-input',
                value: typeof netCfg.mirror === 'string' && netCfg.mirror.length > 0 ? netCfg.mirror : '',
                onChange: (event) => saveNet({ mirror: event.target.value, mirrorEnabled: true }, false),
              }, netCandidates.map((item) => h('option', {
                key: String(item.prefix),
                value: String(item.prefix),
              }, String(item.label)))),
            ),
            h('label', { style: S.netRow, key: 'mirrortoggle' },
              h('input', {
                style: S.check,
                type: 'checkbox',
                checked: netCfg.mirrorEnabled === true,
                onChange: (event) => saveNet({ mirrorEnabled: event.target.checked }, false),
              }),
              h('span', null, '用镜像加速克隆 / 获取 / 拉取'),
            ),
            h('div', { style: S.warn, key: 'mirrorwarn' },
              '镜像会把请求转给第三方：公开仓库没问题，私有仓库请改用下面的代理；推送不走镜像。'),
            h('div', { style: S.netRow, key: 'proxy' },
              h('input', {
                style: S.input,
                className: 'dgp-input',
                value: netProxy,
                placeholder: '本机代理 http://127.0.0.1:7890（留空 = 不用）',
                onChange: (event) => setNetProxy(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveNet({ proxy: netProxy }, true)
                  }
                },
              }),
              netBtn('保存代理', () => saveNet({ proxy: netProxy }, true), true),
            ),
            h('div', { style: S.netRow, key: 'probe' },
              netBtn(netBusy === true ? '检测中…' : '检测网络', () => probeNet()),
              h('span', { style: S.note }, '实测这台机器上哪条线路通'),
            ),
          )
        }

        if (Array.isArray(netProbe)) {
          netChildren.push(h('div', { style: S.list, key: 'results' },
            netProbe.map((item, index) => h('div', {
              style: S.item, className: 'dgp-rowitem', key: 'p' + index,
            },
              h('span', { style: item.ok === true ? S.good : S.bad }, item.ok === true ? '✓' : '✗'),
              h('span', { style: S.name, title: String(item.error === undefined || item.error === null ? '' : item.error) }, String(item.label)),
              h('span', { style: S.probeMs }, item.ok === true
                ? (String(item.ms) + 'ms')
                : String(item.error === undefined || item.error === null ? '失败' : item.error)),
            )),
          ))
        }

        children.push(h('div', { style: S.netBox, key: 'net' }, netChildren))
      }

      // ── 仓库卡片：目录 / 分支 / 远程三行圈进同一张卡 ──────────────────────
      //
      // 这三行都是「这个仓库现在是什么样」的只读信息（各自带一个动作按钮），放进
      // 同一张卡里与下面的改动 / 提交 / 同步区分开，避免一长串同权重的行。
      const repoRows = []

      repoRows.push(h('div', { style: S.row, key: 'dir' },
        h('span', { style: S.label }, '目录'),
        editingDir === true
          ? h('input', {
              style: S.input,
              className: 'dgp-input',
              value: dirDraft,
              placeholder: '绝对路径，如 /home/me/project',
              onChange: (event) => setDirDraft(event.target.value),
            })
          : h('span', { style: S.path, title: workdir }, workdir.length > 0 ? workdir : '（默认目录）'),
        editingDir === true
          ? btn('确定', () => { setPicked(true); setEditingDir(false); switchDir(dirDraft) })
          : btn('切换', () => { setDirDraft(workdir); setEditingDir(true) }),
        btn('刷新', () => load(workdir)),
        picked === true && typeof sessionCwd === 'string' && sessionCwd.length > 0
          ? btn('跟随会话', () => { setPicked(false); setEditingDir(false); switchDir(sessionCwd) })
          : null,
      ))

      repoRows.push(h('div', { style: S.row, key: 'branch' },
        h('span', { style: S.label }, '分支'),
        h('span', { style: S.branch }, isRepo
          ? (typeof snapshot.branch === 'string' && snapshot.branch.length > 0 ? snapshot.branch : '（尚无提交）')
          : '—'),
        // 上游状态：`→ origin/master`；没有上游时明说，并在 tooltip 里指向按钮
        // （面板的「拉取」会自动补这一步，所以不要求用户去记 git 命令）。
        isRepo === true
          ? h('span', {
              style: S.note,
              title: upstream === null
                ? '未设上游：本地分支还不知道对应远端哪个分支。直接点「拉取」即可，面板会自动按「远程 + 当前分支」拉取并登记上游。'
                : '上游：本地 ' + String(snapshot.branch) + ' 对应远端 ' + upstream,
            }, upstream === null ? '未设上游' : '→ ' + upstream)
          : null,
        h('span', { style: S.spacer }),
        // 「领先/落后」留在这一行；改动摘要搬到了下面「改动」区块的标题上 ——
        // 那才是它描述的内容（点「全部暂存」后数字要跟着变）。
        isRepo === true
          ? (trackingSummary(snapshot).length > 0
              ? h('span', { style: S.note }, trackingSummary(snapshot))
              : null)
          : h('span', { style: S.note }, '还不是 Git 仓库'),
        isRepo === true ? btn(showBranches === true ? '收起' : '管理', toggleBranches) : null,
      ))

      // 远程仓库：没有远程时这条是「未配置」，点了就展开地址输入框；
      // 推送失败需要地址时也会自动展开（见 push()）。展开的输入框和错误提示
      // 都留在同一张卡里 —— 它们改的就是上面那一行。
      if (isRepo === true) {
        const first = remotes.length > 0 ? remotes[0] : null
        repoRows.push(h('div', { style: S.row, key: 'remote' },
          h('span', { style: S.label }, '远程'),
          h('span', { style: S.path, title: first === null ? '' : String(first.url) },
            first === null ? '未配置（推送到不了任何地方）' : first.name + ' → ' + first.url),
          btn(showRemote === true ? '收起' : (first === null ? '配置' : '改'), () => {
            setShowRemote(showRemote !== true)
            setRemoteError('')
          }),
        ))

        if (showRemote === true) {
          repoRows.push(h('div', { style: S.box, key: 'remote-url' },
            h('input', {
              style: Object.assign({}, S.input, { flex: '0 0 64px' }),
              className: 'dgp-input',
              value: remoteName,
              placeholder: 'origin',
              title: '远程名，一般用 origin',
              onChange: (event) => setRemoteName(event.target.value),
            }),
            h('input', {
              style: S.input,
              className: 'dgp-input',
              value: remoteUrl,
              placeholder: '仓库地址 git@github.com:用户名/仓库.git',
              onChange: (event) => {
                // 用户一改就置脏：此后只有保存成功或换仓库才会让 state 重新播种。
                setRemoteDirty(true)
                setRemoteUrl(event.target.value)
              },
              // 回车即保存：提交框、代理框、新分支框都能回车，只有这里原先必须用
              // 鼠标点「保存」—— 习惯敲回车的人会以为"保存不了"。
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  saveRemote()
                }
              },
            }),
            btn('保存', saveRemote),
            btn('保存并推送', saveRemoteAndPush, true),
          ))
          if (remoteError.length > 0) {
            repoRows.push(h('div', { style: S.warn, key: 'remote-err' }, '⚠ ' + remoteError))
          }
        }
      }

      children.push(h('div', { style: S.card, key: 'repo' }, repoRows))

      // 分支管理器：本地分支列表（点名字切换、点「删除」安全删除）+ 新建并切换。
      // 整块收进一张卡，本地/远端两段各带一个小标题 —— 两边的动作不一样
      // （本地是切换/删除，远端是取回/比较），混在一起容易点错。
      if (isRepo === true && showBranches === true) {
        const branchItems = branches !== null && Array.isArray(branches.items) ? branches.items : []
        const branchCard = [
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
                      ? Object.assign({}, S.name, { fontWeight: 600, color: 'var(--dsw-alias-state-success-primary, #16a34a)' })
                      : Object.assign({}, S.name, { cursor: 'pointer' }),
                    title: item.current === true ? '当前分支' : '点击切换到此分支',
                    onClick: item.current === true ? undefined : () => doCheckout(item.name),
                  }, item.name),
                  h('span', { style: S.spacer }),
                  item.current === true
                    ? h('span', { style: S.note }, '当前')
                    : btn('删除', () => doDeleteBranch(item.name)),
                )),
          ),
          h('div', { style: S.box, key: 'newbranch' },
            h('input', {
              style: S.input,
              className: 'dgp-input',
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
          ),
        ]

        // 远端分支。点它**不直接切换**（那会变成游离 HEAD，对不懂 git 的人是坑），
        // 只给两个安全动作：拿成新分支（当前分支一点不动）、和本地比一比差多少。
        const remoteItems = remoteBranches !== null && Array.isArray(remoteBranches.items)
          ? remoteBranches.items
          : []
        branchCard.push(h('div', { style: S.sectionTitle, key: 'remotetitle' },
          h('span', null, remoteItems.length === 0 ? '远端分支' : '远端分支（' + remoteItems.length + '）'),
          h('span', { style: S.sectionRule }),
        ))
        branchCard.push(h('div', { style: S.note, key: 'remotehint' },
          remoteItems.length === 0
            ? '点一次「获取远程」就能在这里看到（只下载，不改你的代码）'
            : '「拿成新分支」把远端那份取到本地，当前分支一点不动'))
        for (let index = 0; index < remoteItems.length; index += 1) {
          const item = remoteItems[index]
          branchCard.push(h('div', { style: S.item, className: 'dgp-rowitem', key: 'r' + index },
            h('span', {
              style: S.name,
              title: item.head === true ? '远端默认分支' : '远端分支（获取远程时下载到本地）',
            }, item.ref + (item.head === true ? '（默认）' : '')),
            h('span', { style: S.spacer }),
            btn('拿成新分支', () => doAdoptRemoteBranch(item)),
            btn('比较', () => doCompareRemoteBranch(item)),
          ))
        }

        children.push(h('div', { style: S.card, key: 'branch-card' }, branchCard))
      }

      // 远程行、地址输入框与它的错误提示都在上面的仓库卡片里（见 repoRows）。

      if (isRepo !== true) {
        // 空态：给一块虚线占位，别让「还不是仓库」只缩成一行小字混在按钮里。
        children.push(h('div', { style: S.empty, key: 'hint' },
          '这个目录里还没有 Git 仓库：可以点下面的按钮初始化一个，或者克隆一个已有的仓库。'))
      }

      // ── 改动区块：标题（带改动摘要胶囊）+ 列表 + 点开的 diff ──────────────
      //
      // 改动摘要从「分支」行搬到这里 —— 它描述的正是这一块内容，而且点
      // 「全部暂存」后数字要跟着变（否则用户会以为按钮没生效）。
      if (isRepo === true) {
        children.push(h('div', { style: S.sectionTitle, key: 'changestitle' },
          h('span', null, '改动'),
          h('span', { style: S.sectionRule }),
          h('span', {
            style: changes.length > 0 ? S.chipActive : S.chip,
            title: '工作区里的改动总数，以及其中已经暂存的数量',
          }, changesSummary(changes)),
        ))
      }

      if (changes.length > 0) {
        // diff **内联展开在被点的那一行下面**，而不是列表外面的另一个框。
        //
        // 面板正文是可滚动的 flex 列，清单也是；把 diff 放在清单外面时，它既挤掉
        // 清单的高度（见 S.list 的注释），又常常落到可视区之外 —— 用户看到的就是
        // 「diff 把改动清单盖住了」。放进清单里之后两者永远是同一个滚动区：点哪个
        // 文件，就在那个文件下面看它的 diff，清单一行都不会被挡。
        const shownChanges = changes.slice(0, 40)
        const changeRows = []
        let diffInline = false
        for (let index = 0; index < shownChanges.length; index += 1) {
          const item = shownChanges[index]
          const key = (item.staged === true ? 's:' : 'u:') + String(item.path)
          const open = diffKey === key
          changeRows.push(h('div', {
            style: S.item,
            // 展开中的那一行带品牌色竖条（dgp-rowitem-active），和下面的 diff 对上号。
            className: 'dgp-rowitem dgp-clickable' + (open ? ' dgp-rowitem-active' : ''),
            key: 'c' + index,
            title: (item.staged === true ? '已暂存' : '未暂存') + ' · 点击查看 diff（再点收起）',
            // 整行是一个动作，就得像按钮一样能被键盘触达（焦点环见 PANEL_CSS）。
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            onClick: () => showDiff(item),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                showDiff(item)
              }
            },
          },
            // 暂存状态：实心=已暂存、空心=未暂存。颜色之外再给一个形状。
            h('span', {
              style: Object.assign({}, S.marker, {
                color: item.staged === true
                  ? 'var(--dsw-alias-state-success-primary, #16a34a)'
                  : 'var(--dsw-alias-label-tertiary, #999999)',
              }),
            }, item.staged === true ? '●' : '○'),
            h('span', { style: codeStyle(item.staged) }, String(item.code)),
            h('span', { style: S.name }, String(item.path)),
            h('span', { style: S.chevron }, open ? '▲' : '▼'),
          ))
          if (open) {
            changeRows.push(renderLines(diffText, S.diff, diffLineClass, 'diff', diffRef))
            diffInline = true
          }
        }
        // 展开 diff 时把清单的取景框放高一些：这一块现在同时装文件行和 diff，
        // 还按 148px 算的话 diff 只能露出一两行。
        children.push(h('div', {
          style: diffKey.length > 0 ? Object.assign({}, S.list, { maxHeight: '360px' }) : S.list,
          key: 'changes',
        }, changeRows))
        // 兜底：清单在 diff 打开之后被刷新掉了（典型是点了「全部暂存」，条目从未暂存
        // 变成已暂存，key 对不上任何一行）—— 这时 diff 仍要有地方显示，不能凭空消失。
        if (diffKey.length > 0 && diffInline !== true) {
          children.push(renderLines(diffText, S.diff, diffLineClass, 'diff', diffRef))
        }
      }

      // 操作区按语义分成两段，提交夹在中间：
      //   改动（全部暂存 / 撤销暂存 / 丢弃改动）→ 提交 → 同步（拉取 / 推送 / 获取远程）
      // 这正好是日常的先后顺序；原先六个按钮挤在一行里，暂存和同步混在一起。
      if (isRepo === true) {
        children.push(h('div', { style: S.actions, key: 'change-actions' },
          btn('全部暂存', () => runOp('addAll')),
          stagedCount(changes) > 0 ? btn('撤销暂存', () => runOp('unstage')) : null,
          // 「丢弃改动」是唯一不可逆的动作：单独用危险色，别和普通按钮长得一样。
          changes.length > 0 ? btn('丢弃改动', () => {
            if (window.confirm('确定丢弃所有未提交的工作区改动？此操作不可恢复。\n（不影响未跟踪文件；已暂存的内容请先「撤销暂存」。）')) {
              runOp('discard')
            }
          }, false, true) : null,
        ))

        children.push(h('form', {
          style: S.box, key: 'commit',
          onSubmit: (event) => { event.preventDefault(); doCommit() },
        },
          h('input', {
            style: S.input,
            className: 'dgp-input',
            value: message,
            placeholder: '填写提交信息…（回车直接提交）',
            onChange: (event) => setMessage(event.target.value),
          }),
          h('button', {
            className: buttonClass(true, false),
            style: buttonStyle(true, locked),
            disabled: locked,
            type: 'submit',
          }, '提交'),
        ))

        children.push(h('div', { style: S.sectionTitle, key: 'synctitle' },
          h('span', null, '同步'),
          h('span', { style: S.sectionRule }),
        ))
        children.push(h('div', { style: S.actions, key: 'sync-actions' },
          btn('拉取', () => runOp('pull')),
          btn('推送', push),
          btn('获取远程', () => runOp('fetch')),
        ))
      } else {
        children.push(h('div', { style: S.actions, key: 'actions' },
          btn('初始化仓库', () => runOp('init'), true),
          btn(showClone === true ? '收起克隆' : '克隆仓库', () => setShowClone(showClone !== true)),
        ))
      }

      if (isRepo !== true && showClone === true) {
        children.push(h('div', { style: S.box, key: 'clone' },
          h('input', {
            style: S.input,
            className: 'dgp-input',
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
        children.push(h('div', { style: S.sectionTitle, key: 'logtitle' },
          h('span', null, '最近提交'),
          h('span', { style: S.sectionRule }),
        ))
        children.push(h('div', { style: S.list, key: 'log' },
          commits.slice(0, 8).map((item, index) => h('div', {
            style: S.item, className: 'dgp-rowitem', key: 'l' + index,
          },
            h('span', { style: S.hash }, String(item.hash)),
            h('span', { style: S.name, title: String(item.subject) }, String(item.subject)),
          )),
        ))
      }

      if (output.length > 0) {
        // 逐行着色（命令回显 / stderr / 加速说明 / 下一步提示），文本一字不改：
        // 结果栏里有什么仍然可以整段复制、搜索、被测试按纯文本断言。
        children.push(renderLines(output, S.out, outputLineClass, 'out'))
      }

      // 「需要你选一个结果」：宿主判断出这不是命令写错、而是要用户做个决定时回传的
      // 选项（典型：本地和远端是两套互不相关的历史）。渲染成按钮，点一下就执行 ——
      // 用户不需要懂 git，只需要选"要哪个结果"。
      if (Array.isArray(choices) && choices.length > 0) {
        children.push(h('div', { style: S.choiceBox, key: 'choices' },
          h('div', { style: S.netTitle, key: 'title' }, '🤔 面板需要你选一个结果'),
          choices.map((item, index) => {
            const choice = item !== null && typeof item === 'object' ? item : {}
            return h('div', { style: S.choiceItem, key: 'choice-' + index },
              h('button', {
                type: 'button',
                className: buttonClass(index === 0, false),
                style: buttonStyle(index === 0, locked),
                disabled: locked,
                onClick: () => runChoice(choice),
              }, typeof choice.label === 'string' && choice.label.length > 0 ? choice.label : '执行'),
              typeof choice.detail === 'string' && choice.detail.length > 0
                ? h('div', { style: S.note, key: 'detail' }, choice.detail)
                : null,
            )
          }),
        ))
      }

      // 局部样式表随面板一起挂载/卸载（不写全局样式表，也不动宿主 DOM）。
      return h(React.Fragment, null,
        panelStyles(),
        h('div', { style: S.panel, className: 'dgp-panel' },
          head,
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
