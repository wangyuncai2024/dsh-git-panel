# dsh-git-panel

DSH（DeepSeek Harness）Git 面板插件：在界面右下角提供一个**纯点击**的 Git 图形面板，
不需要记任何 git 命令；并在「设置 → 通用」里提供一个开关，随时控制面板显示与否。

## 功能

**右下角 Git 面板**

| 按钮 | 作用 |
| --- | --- |
| 初始化仓库 | 当前目录还不是仓库时，一键 `git init` |
| 克隆仓库 | 填入仓库地址，一键 `git clone`；**成功后自动切进新仓库目录** |
| 全部暂存 | `git add -A` |
| 撤销暂存 | 误点「全部暂存」后一键 `git reset`（不动工作区） |
| 丢弃改动 | 丢弃所有未提交的工作区改动（`git checkout -- .`，需确认，不影响未跟踪文件） |
| 提交 | 输入框写提交信息，一键 `git commit`（**回车直接提交**；失败时输入会保留） |
| 拉取 / 推送 / 获取远程 | `git pull` / `git push` / `git fetch --all --prune` |
| 远程 / 配置 | 查看或修改推送目标（`git remote add` / `set-url`） |
| 分支管理 | 打开后列出本地分支：点名字**切换**、输入名字**新建并切换**、按钮**安全删除**（未合并的分支会被拒绝，防误删历史） |
| 改动点开看 diff | 改动清单里点任意条目，直接在面板里看它的 diff；已暂存条目看的是暂存区版本，再点一次收起 |
| 帮助（?） | 弹出一个**可移动、可拉伸、可滚动的独立窗口**：面板操作方式 + 分组常用 git 命令；**每条命令点一下即复制到剪贴板**；拖标题栏移动、拖右下角手柄调整大小，内容超出时窗口内鼠标滚轮滚动，位置与尺寸都会被记住，打开后也可随时关闭 |
| 切换 / 刷新 | 换一个目录操作 / 重新读取状态 |
| 跟随会话 | 手动切过目录后，一键回到当前会话的工作目录 |

面板同时展示：当前分支、上游跟踪状态（领先/落后几个提交）、远程地址、
改动清单（文件级，可点开看 diff）、最近 8 次提交、每条命令的执行结果。
右上角「—」可把面板收起成一个小胶囊；**有未提交改动时胶囊上会亮一个红点**。
目录输入框支持 `~`（自动展开为主目录）。

**推送不会「点了没反应」**：推送失败时面板不再只丢一行 git 英文报错，而是
先按 git 的反馈替用户做一步，再给出下一步该点哪里：

| 失败原因 | 面板行为 |
| --- | --- |
| 本地分支还没有上游（新仓库第一次推） | 自动改用 `git push --set-upstream <远程> HEAD` 重推，成功后建立跟踪 |
| 仓库没有配置远程 | 自动展开地址输入框 + 提示，填好点「保存并推送」一步完成 |
| 远程仓库不存在 / 没权限 | 提示检查地址是否写对、GitHub 上是否已建该仓库 |
| SSH 认证失败 | 提示检查公钥是否已加到 GitHub，或改用 HTTPS 地址 |
| 非快进（远程有你没有的提交） | 提示先点「拉取」合并再推送，不擅自强推 |

这些判断都在宿主侧完成（`classifyPushFailure` / `recoverPush`），面板只负责显示，
因此 AI 工具走同一条逻辑。

**设置开关**：设置 → 通用 → 「Git 面板」，一键开启/关闭。状态记在浏览器
`localStorage`（key: `dsh-git-panel-enabled`），默认开启。

**AI 也能用**：插件同时注册了 13 个 **git 模型工具**（`git_status`、`git_add`、
`git_commit`、`git_log`、`git_diff`、`git_branch`、`git_checkout`、`git_pull`、
`git_push`、`git_clone`、`git_init`、`git_remote`、`git_run`），装好后直接对
AI 说「帮我提交」即可。其中 `git_remote` 的 `action=set` 就是「配置推送目标」：
同名远程已存在则改地址，否则新增。

> **面板和 13 个工具是两个面**：工具是注册给 AI 调用的（会话里替你干活），
> 面板是人手高频操作的界面。能力大致对齐——面板覆盖了状态/暂存/提交/拉取/推送/
> 克隆/初始化/远程配置/分支管理/日志/diff 查看，另有 `git_log`（最近提交列表）、
> `git_diff`（点改动看 diff）的等价入口，面板上没有的只剩 `git_run`
> （stash/tag 等通用子命令，留命令行或 AI）；分支切换/新建/删除和改动 diff
> 为两侧共有的高频操作。

## 安装（link 方式，本地开发）

```bash
# 1) link 安装：dsh plugin 会把依赖写进 profile 的 package.json，
#    并自动把 "dsh-git-panel" 登记进 dsh.profile.bundles（实测无需手改）
dsh plugin --profile web add link:/home/wangyuncai/DSH-project/GitHub插件

# 2) 重启 dsh 使新 bundle 生效（首次安装：bundles 在启动时读取）
#    在运行 dsh 的终端按 Ctrl+C，然后重新执行：dsh web
```

> 提示：**首次安装/卸载**确实要重启一次（`dsh.profile.bundles` 与 patch 在启动时读取），
> 官方插件市场装完同样提示「待重启生效」。重启后浏览器刷新页面即可，会话记录不会丢失。

### 改代码后怎么生效（link 开发）

| 改了哪里 | 生效方式 |
| --- | --- |
| `lib/client.js`（面板界面与交互） | **不用重启 dsh**：客户端 bundle 按文件内容重算版本（`/plugins/<id>/client.js?rev=<hash>`），HMR watch 在跑时页面自动重载，否则刷新一次页面即可 |
| `lib/index.js`（宿主：`/git-panel/*` 路由、13 个模型工具） | **需要重启 dsh**：宿主插件是 Node 进程启动时 `import` 的，没有热加载 |
| `package.json` 的 `dsh.bundle` / `cordis.patch.yml`（挂载声明） | **需要重启 dsh**：bundles 与 patch 在启动时读取 |

卸载：

```bash
dsh plugin --profile web remove dsh-git-panel
# 并重启 dsh
```

## 结构

```
GitHub插件/               # 本工作区根目录 = 插件包本体（link 安装指向这里）
├── package.json          # dsh.bundle.patch / dsh.client 声明
├── cordis.patch.yml      # bundle patch：把本插件插入 profile 配置树
└── lib/
    ├── index.js          # Host half：HTTP 路由 /git-panel/* + 13 个 git 模型工具
    └── client.js         # Client half：shell.overlay 面板 + settings.general.item 开关
```

## 设计说明

- **零外部依赖**：Host 只用 Node 内置模块，Client 只 `require('react')`（种子模块），
  因此 link 到任何 profile 都能解析，DSH 升级也不会破坏它。
- **无注入面**：宿主用 `child_process.execFile` + **参数数组**执行 git，不经过 shell；
  提交信息、路径里的引号/空格/分号都只是普通数据。
- **同源校验**：执行类 POST 请求校验 `Origin`，拒绝跨站提交。
- **失败可见**：非零退出被归一化成 `{ code, stdout, stderr }` 回传面板，而不是抛异常，
  面板永远能渲染出原因。
- **目录跟随会话**：面板通过 `shell.overlay` 的标准 props `useSessions` 读取当前会话
  的工作目录，切换会话时自动跟随；也可在面板里手动切换到任意目录。
- **推送失败先补救再报错**：`POST /git-panel/op {op:"push"}` 的响应带
  `reason`（`no-remote` / `no-upstream` / `remote-not-found` / `auth-failed` /
  `rejected`）与 `hint`（中文下一步提示），面板据此自动展开地址输入框或提示先拉取。
  自动动作只做一件：无上游时补 `--set-upstream <远程> HEAD`（`retried:true` 表示
  命令被替换过）。认证失败与强推绝不动手 —— 前者需要用户给凭证，后者会改写历史。
- **远程地址一行搞定**：`op:"setRemote"` 会先查 `git remote`，再决定用 `add` 还是
  `set-url`，所以同一个「保存并推送」按钮同时覆盖首次配置和改地址。
  这个查重决策抽成了纯函数 `remoteOpFor`，AI 工具的 `git_remote action=set` 走同一条
  逻辑 —— 两条路径行为一致。
- **克隆完直接进新仓库**：clone 成功后宿主回传 `clonedDir`（推导结果与
  `git clone` 的默认目标名一致：地址最后一段去掉 `.git`），面板自动切过去并刷新。

## 配置

在 profile 的 `cordis.patch.yml` 里用同一个 id 覆盖行配置：

```yaml
- id: git-panel
  config:
    defaultDir: /home/me/project   # 缺省操作目录；留空 = 跟随当前会话工作目录
```

## 开发注记（两个真踩过的坑）

写这类界面插件时，下面两点都会让功能**静默消失、且不报任何错**，值得记下来：

1. **`ctx.slots.inject(name, cb)` 只在「将来的声明事件」上回调。**
   它底层是 `subscribeDeclaration`，只挂监听器、**不检查该插槽当前是否已存在**。
   于是：插件加载时插槽还没建 → 能等到回调；插件加载时插槽**早就建好了**
   （例如设置模块在启动早期就声明好的 `settings.general.item`）→ 监听器永远等不到事件，
   注册静默丢失。
   本插件的做法是 `registerSlot()`：**先直接 register，抛错（尚未声明）才退回 inject 等待**，
   两种时机都覆盖。

2. **`tools` / `webServer` 是惰性服务。**
   `apply()` 执行时 `ctx.get('tools')` 常常还是 `undefined`；只读一次就永远错过，
   13 个 git 工具会全部不注册。本插件对两者都做「现有实例优先、取不到就
   `ctx.inject([...], cb)` 等服务就绪」。

### 客户端诊断日志

界面注册类问题在浏览器控制台里对用户不可见，因此客户端会把注册过程回报到宿主：

```
~/.dsh/git-panel-diag.log
```

内容包括 `apply:start`、`overlay:registered-direct`、`settings:direct-failed` 这类阶段标记，
排查「面板出现了但设置行没出现」时直接看这个文件即可。该文件可以随时删除。

## 测试

宿主的解析/决策逻辑都是纯函数（porcelain 分支行、远程列表、推送失败分类、远程配置
决策、clone 目标名、目录归一化），用 Node 自带测试框架覆盖：

```bash
npm test    # node --test，自动发现 test/ 目录，30 个用例，毫秒级完成
npm run check   # 语法检查（index.js + client.js）
```

## License

MIT
