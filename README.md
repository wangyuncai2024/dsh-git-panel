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
| 分支管理 | 打开后列出**本地分支**：点名字**切换**、输入名字**新建并切换**、按钮**安全删除**（未合并的分支会被拒绝，防误删历史）；同时列出**远端分支**（`git branch --remotes`，获取远程之后可见）：点「拿成新分支」把远端那一份取成本地新分支（当前分支一点不动），点「比较」看两边各差几个提交。点远端分支**不会**直接切过去——那会变成游离 HEAD |
| 改动点开看 diff | 改动清单里点任意条目，直接在面板里看它的 diff；已暂存条目看的是暂存区版本，再点一次收起 |
| 帮助（?） | 头部「?」在**新标签页打开独立帮助文档**（同源路由 `GET /git-panel/help`）：面板操作方式 + 分组常用 git 命令；**每条命令点一下即复制到剪贴板**。文档是普通网页——原生滚动、Ctrl+F 查找、可打印、可收藏，适合开着边看边敲 |
| 切换 / 刷新 | 换一个目录操作 / 重新读取状态 |
| 跟随会话 | 手动切过目录后，一键回到当前会话的工作目录 |
| 网络加速（🌐） | 连不上 github.com（`Connection was reset` / 超时）时打开：克隆/获取/拉取可走第三方镜像，全部操作可走本机代理。见 [网络加速](#网络加速连不上-github) |

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

**网络类失败单独一条路**：连接被重置 / 超时不属于上面任何一类（`classifyPushFailure`
对它们只会返回 `none`——它的判断依据是「服务器答复了什么」，而链路根本没通）。
所以 `classifyNetworkFailure` 先兜这一类，命中的话面板会**自动展开网络加速设置**
并给出下一步。判断时刻意排除了 `The requested URL returned error: 404` 这类
「服务器答复了」的报错——那是仓库不存在，把用户引去开加速只会更迷惑。

**拉取同样有补救**（`classifyPullFailure` / `recoverPull`，判断全在宿主侧）：

| 失败原因 | 面板行为 |
| --- | --- |
| 本地分支还没有上游 | 自动改成 `git pull <远程> <当前分支>`（这条不要求上游），成功后顺手登记上游 |
| 远端没有和当前分支同名的分支 | 改看远端的默认分支（`refs/remotes/<远程>/HEAD`）：**历史相关**就按它拉一次并说明用的是哪个分支；**两套历史无关**就直接给下面那两个按钮——动作指向真正的 `origin/main`，而不是去推一个多余的 `master` |
| 两套历史互不相关（本地新 `git init` 的仓库撞上远端已有历史） | 给两个按钮：把远端那份**拿成新分支**（安全，当前分支一点不动）、让当前分支**直接变成远端那份**（有前置检查，并告诉你怎么找回旧提交） |
| 合并冲突 / 上一次合并没收尾 | 给「撤销这次合并」按钮（等价 `git merge --abort`）。**「解决冲突」不做按钮**——那要用户对每个文件判断留哪边 |

最常见的现场是「本地 `git init` 出来的分支叫 `master`、远端默认分支叫 `main`」：
裸 `git pull` 报没有上游 → 自动重试 `git pull origin master` → `fatal: couldn't find remote ref master`。
早先面板只提示「先点一次推送把它推上去」，照做会在 GitHub 上多出一个 master 分支，
而真正的出路一个字都没提。现在它会先看远端的默认分支，两套历史无关时把
「拿成新分支 / 覆盖当前分支」两个按钮亮出来，并且这些按钮**显式带着 `origin/main`**——
不再按当前分支名去猜。同时「管理」里会列出远端分支（`git branch --remotes`，本地命令、
不联网；能看到什么取决于之前有没有点过「获取远程」），在那里也能一键把远端那份拿成新分支，
或点「比较」看两边各差几个提交。

## 网络加速（连不上 GitHub）

国内直连 `github.com` 经常连不上，典型报错：

```
fatal: unable to access 'https://github.com/<owner>/<repo>.git/':
Recv failure: Connection was reset
```

或干脆一直挂到超时。面板右上角的 **🌐** 提供两级加速，**可叠加**：

| 方式 | 作用于 | 默认 | 说明 |
| --- | --- | --- | --- |
| 镜像 | `clone` / `fetch` / `pull`（只读） | **关闭** | 请求转给第三方镜像（`gh-proxy.com` / `ghproxy.net` / `ghfast.top`，可换） |
| 代理 | 全部联网操作，**含 `push`** | 关闭 | 填本机代理，如 `http://127.0.0.1:7890`（Clash / V2Ray 等） |

「检测网络」按钮会在这台机器上**现场实测**每条线路（直连 + 各镜像 + 你填的代理），
把通不通、耗时多少直接列出来——所以文档里不写「哪个镜像快」，以你机器上的实测为准。

### 三个关键实现细节

1. **不改你的任何 git 配置。** 加速通过 `git -c …` 注入到**单条命令**上，既不写
   `~/.gitconfig` 也不写仓库 `.git/config`。关掉开关就等于什么都没发生过；终端里
   自己敲的 git 完全不受影响（想给终端也加速，用帮助文档里给的
   `git config --global http.proxy …`）。
2. **镜像走 `insteadOf`，不会污染仓库。** 命令形如：

   ```
   git -c url.https://gh-proxy.com/https://github.com/.insteadOf=https://github.com/ fetch --all --prune
   ```

   实测 `git clone` 之后 `origin` 里存的**仍然是原始 github URL**——git 只在传输层
   重写地址。注意 base 必须是「镜像 + 原前缀」这种拼法：`insteadOf` 做的是**前缀
   替换**，写成 `url.<镜像>.insteadOf=<原前缀>` 会拼出 `https://gh-proxy.com/owner/repo`
   这种并不存在的地址，而且不报错、直接挂到超时。
3. **镜像失败自动回退直连。** 镜像不是官方线路，随时可能失效；「开了加速反而连不上」
   是最糟的体验。所以镜像那一次失败（非零退出）就立刻用**不带镜像的原命令**再跑一遍，
   并把这件事写进结果栏。只会回退一次，不会来回折腾。

   镜像那次额外带 `http.lowSpeedLimit=1000` / `http.lowSpeedTime=60`：60 秒内几乎
   没有数据就主动中断，不至于让用户干等满 10 分钟才回退；**回退的直连那次不带**，
   免得误杀一个只是慢、但确实在下载的大仓库。

### 安全取舍（重要）

**镜像默认关闭，这是有意的。** 走镜像意味着你的请求经过第三方：私有仓库的内容、
以及需要认证时携带的凭据，对镜像运营方都是可见的。所以插件不替你默认打开。

- 公开仓库 → 开镜像最省事。
- **私有仓库 / 需要 `push`** → 用代理，别用镜像。`push` 永远不走镜像（`insteadOf`
  会连认证主体一起改写，必然失败），这是代码里写死的。
- 面板回显与 `GET /git-panel/net` 返回的代理地址**一律打码**（`http://***@host:7890`），
  明文凭据不回显、不进浏览器、不进命令回显、不进模型工具输出。面板把打码串原样回传时，
  宿主理解为「不变」，不会用 `***` 覆盖掉真凭据。

配置落在 `$DSH_HOME/git-panel-net.json`（纯 JSON，删掉即恢复默认）：

```json
{
  "mirrorEnabled": false,
  "mirror": "https://gh-proxy.com/",
  "proxy": ""
}
```

写这个接口的 `POST /git-panel/net` 带同源校验——它决定 git 命令**怎么执行**，
能被跨站改写就等于把仓库流量导向别处。

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

`link:` 让 profile 直接指向插件源码目录：改完代码按下表生效，不用重装。
（裸写目录路径 pnpm 也会规范成 `link:`，两种写法等价；显式写 `link:` 只是把语义钉死。）

**Linux / macOS**

```bash
# 1) link 安装：dsh plugin 会把依赖写进 profile 的 package.json，
#    并自动把 "dsh-git-panel" 登记进 dsh.profile.bundles（实测无需手改）
cd /path/to/dsh-git-panel                     # 换成你的插件根目录
dsh plugin --profile web add "link:$PWD"      # 等价于 link:/该目录的绝对路径

# 2) 重启 dsh 使新 bundle 生效（首次安装：bundles 在启动时读取）
#    在运行 dsh 的终端按 Ctrl+C，然后重新执行：dsh web
```

**Windows（PowerShell / cmd 通用）**

```powershell
# 路径用正斜杠 /，不要用反斜杠 \：
# cmd.exe 把 \ 当转义符，写成 link:C:\Users\... 会被吞字符
# 路径加引号，防空格与 shell 元字符
dsh plugin --profile web add "link:C:/path/to/dsh-git-panel"   # 换成你的插件根目录

# 然后 Ctrl+C 停掉 dsh，重新执行：dsh web
```

判断装成功了没有，两个都满足才算：

- 输出是 `+ dsh-git-panel link:...`，**不是** `+ @deepseek-ai/dsh-root link:...`；
- 没有 `declares no dsh.bundle` 这句警告。

Windows 上最容易踩的坑：**先 `cd` 进插件根目录再执行**（或像上面直接用绝对路径）。
`dsh plugin` 只对 `.`、`..` 这类相对路径做锚定，锚定依据是**你执行 dsh 时所在的目录**——
在 DSH 部署根目录里跑 `dsh plugin add .`，pnpm 链接的是部署根本身（包名
`@deepseek-ai/dsh-root`，没有 `dsh.bundle`），结果只是警告一句然后什么都不生效。

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
dsh-git-panel/            # 插件包本体（link 安装指向这里）
├── package.json          # dsh.bundle.patch / dsh.client 声明
├── cordis.patch.yml      # bundle patch：把本插件插入 profile 配置树
├── lib/
│   ├── index.js          # Host half：HTTP 路由 /git-panel/state|op|net|diag|help + 13 个 git 模型工具
│   └── client.js         # Client half：shell.overlay 面板 + settings.general.item 开关
└── test/                 # node --test，不随包发布（package.json 的 files 里没有它）
    ├── unit.test.mjs     # 宿主纯函数
    ├── standalone.test.mjs # 零依赖加载 / 注册契约
    ├── client.test.mjs   # 客户端 bundle（假 window + 假 React）
    └── network.test.mjs  # 网络加速整条链路（含假 git 离线复现「镜像挂、直连通」）
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

## 依赖与兼容性（换机器 / 换 DSH 版本）

这一节是「拷到别的机器、装到别的 DSH 版本」时的核对清单，全部按当前实测的
DSH 契约（`dsh.bundle.patch` / `dsh.client` / `exports["./client"]` / `ctx.webServer` /
`ctx.tools` / `ctx.slots`）写成，**没有任何 npm 依赖需要解析**。

| 面向 | 依赖 | 说明 |
| --- | --- | --- |
| 宿主半边 | `node:child_process` `node:fs/promises` `node:os` `node:path` `node:util` | 全是 Node 内置；`dependencies` 为空，`npm ls --all` 输出 `(empty)` |
| 宿主服务 | `webServer.register(route)`、`tools.register(definition)` | 两者都是**惰性服务**：先 `ctx.get()`，取不到就 `ctx.inject([...])` 等服务就绪，**两者都缺也照常加载**（只是没有路由/工具） |
| 客户端半边 | `require('react')` | react 是 DSH web shell 的**平台种子模块**（`getStaticModules()`），不需要本插件声明、也不必随包分发 |
| 客户端服务 | `ctx.slots.register / inject` | 客户端 `inject: ['slots']` 声明；服务缺失时静默降级，不抛异常 |
| 界面插槽 | `shell.overlay`、`settings.general.item` | 由 `ui-layout` / `ui-settings-general` 声明；两者都不存在时只是界面不出现，宿主功能不受影响 |
| Node | `engines.node: ^22.19.0 \|\| >=24.0.0` | 与 DSH 本体一致。`execFile` 的 `signal` 选项需要 Node ≥ 15.4；更老的版本会自动不传 `signal`（只是失去取消传播，功能仍在） |

**插件包的挂载契约**（升级 DSH 时最该核对的三个字段，`test/standalone.test.mjs`
会把它们锁住）：

```jsonc
"exports": { "./client": "./lib/client.js" },   // 客户端 bundle 必须从这里导出
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },  // 宿主 profile 层的挂载声明
  "client": { "platform": "web", "inject": [], "immediately": true }
}
```

- `platform` 必须是 `web`（宿主扫描 `dsh.client` 时只认这一种）。
- `inject` 留空是对的：插件不 `require` 别的客户端包；对 `slots` 服务的依赖由
  客户端 `inject: ['slots']` 在 Cordis 服务层等待 —— 服务永远不出现也只是
  **等待**，不会被判成加载失败。
- 客户端 bundle 必须是普通脚本（`window.__ModuleLoader__.load({id, factory})`），
  **不能有 ESM / JSX / TS 语法** —— 它不经过任何构建工具。

## 配置

在 profile 的 `cordis.patch.yml` 里用同一个 id 覆盖行配置：

```yaml
- id: git-panel
  config:
    defaultDir: /home/me/project   # 缺省操作目录；留空 = 跟随当前会话工作目录
```

网络加速（镜像 / 代理）**不走这里**，而是 `$DSH_HOME/git-panel-net.json`，由面板的
🌐 按钮读写 —— 那个设置要能随时改，不该逼用户编辑 yml 再重启。删掉该文件即恢复默认
（不加速）。

## 安全边界（部署时注意）

面板路由 `/git-panel/*` **没有独立鉴权**，执行类请求只校验 `Origin` 同源。
因此：

- 绑定 `127.0.0.1` 时，能访问到的只有本机进程；
- 若 `webserver.host` 配成 `0.0.0.0`（手机 / 局域网访问场景常见），同网段的主机
  只要能在 HTTP 头里伪造 `Origin`，就能调用这些接口执行
  `git clone / pull / push / commit` 等操作。

`/git-panel/net` 也在这个范围内，分两种情况：

- `GET` 读配置、`GET ?probe=1` 现场探测各线路。**代理地址一律打码**后才返回
  （`http://***@host:7890`），明文凭据不回显、不进浏览器；但「设过代理」这个事实、
  以及探测各线路通不通的结果，局域网内是可见的。
- `POST` 保存配置**带同源校验**，因为该接口决定 git 命令**怎么执行** —— 被跨站
  改写就等于把仓库流量导向别处。这里的 `Origin` 校验和上面一样，是可伪造的，
  别把它当鉴权。

结论：**把 Git 面板和「对局域网开放 web 端口」分开考虑**；确实需要对局域网开放时，
请用 DSH 的配对 / 鉴权层限制访问，或让 `webserver.host` 保持回环。

## 开发注记（五个真踩过的坑）

写这类界面插件时，下面这些坑都会让功能**静默失败或半成功、且不报任何错**，值得记下来：

1. **不能只靠 `ctx.slots.inject(name, cb)` 注册界面。**
   它的语义是「声明事件上回调」；当前实现订阅后确实会立刻 reconcile 一次，但这个
   行为不保证跨版本稳定。当插件加载时插槽**早就声明好**（例如设置模块在启动早期
   就声明的 `settings.general.item`），只写 inject 就有等不到回调的风险，注册会静默丢失。
   本插件的做法是 `registerSlot()`：**先直接 register，抛错（尚未声明）才退回
   inject 等待**，两种时机都覆盖；并且**只有真的注册成功才记 `declared-later`** ——
   声明已到却仍注册失败（priority 占用、options 结构变化等）会把真实原因回报到诊断，
   不会被误当成「还没声明」。

2. **`tools` / `webServer` 是惰性服务。**
   `apply()` 执行时 `ctx.get('tools')` 常常还是 `undefined`；只读一次就永远错过，
   13 个 git 工具会全部不注册。本插件对两者都做「现有实例优先、取不到就
   `ctx.inject([...], cb)` 等服务就绪」，两者都缺时也只是降级、不影响加载。

3. **`try` 块里声明的变量，别在 `try` 外面返回。**
   面板的 `runOp()` 是「所有 git 操作的唯一出口」，它必须先 `await` 拿结果、
   再统一回显与刷新状态，所以结构上是 `try { const data = await postOp(...) }
   catch { ... }` + `return data`。而 `const` 是块级作用域，`return data` 在
   `try` 之外根本看不到它 —— **每次调用都以 `ReferenceError` 结束**。
   这个 bug 的形态特别值得记住，因为它**看起来像功能正常**：`setOutput()` /
   `setSnapshot()` 都在 `try` 内部，所以 git 操作确实执行了、状态条也确实刷新了，
   只有「需要拿到返回值的调用方」坏掉 —— 点改动看 diff 永远停在「加载中…」、
   分支管理器列不出分支、推送失败的自愈提示不出现，控制台里只有一个没人看的
   unhandled rejection。
   修法是 `let data` 声明在 `try` 外、`try` 里赋值；顺便在 `catch` 里把它归一化成
   `{ ok: false, message }`，这样调用方统一按 `data.ok` 判断，失败原因是真实错误
   而不是一句「未知错误」。回归测试见 `test/client.test.mjs` 第 4 节。

4. **属于某个仓库的状态，必须跟着仓库一起切。**
   面板里有一批状态是「某个具体仓库的运行结果」——命令结果栏、展开的 diff、分支列表、
   提交信息草稿、远程地址错误。它们原先和 `snapshot` 放在同一个组件里，而换工作区时
   只有 `snapshot` 被替换，于是界面已经显示新仓库了，最下面的命令结果栏还挂着旧仓库
   上一次 git 操作的输出。这一条**看起来像是「刷新没生效」**，其实只是没人负责清。
   还有一条更隐蔽的来路是**迟到的异步结果**：`pull` / `push` / `clone` 在宿主侧的
   超时是 10 分钟，用户完全可能在结果回来之前就切走；那条响应回来时会同时写
   `setOutput()` 和 `setSnapshot()`，把新工作区整个盖回旧工作区。
   本插件的做法是两条一起上：① `switchDir()` 是**唯一的切换入口**（跟随会话目录、
   手动切目录、跟随会话按钮都走它），切换时先清掉属于旧仓库的瞬时结果；② 拿宿主回传的
   `state.dir` 给每条异步结果做归属校验，与当前绑定的目录不一致就整条丢弃 ——
   两边信息不全时**不拦**，宁可少拦一次也不能把真实输出吞掉。
   注意**不能把清理挂在「目录变了」上**：克隆成功后也会换目录，但那时输出正是用户要看
   的克隆结果。回归测试见 `test/client.test.mjs` 第 5 节。

5. **给 git 注入配置参数时，`-c` 必须和 `key=value` 一起生成。**
   网络加速要把一组配置只作用于单条命令，于是有了 `networkExtraArgs()`。最初它返回的是
   裸的 `['url.…insteadOf=…', 'http.proxy=…']`，指望各个调用点自己拼上 `-c` —— 结果是
   **每个调用点都忘了拼**。git 收到 `git url.…insteadOf=… fetch …` 时会把第一个参数当成
   **子命令**，报一句「'url.…' 不是一个 git 命令」，然后整个加速静默失效、每次都退回直连。
   这个坑的教训有两层：

   - 代码上：**把 `-c` 收进生成函数内部**，返回可直接展开的完整片段，调用方就没有拼错的
     机会。比「约定调用方记得加」可靠得多。
   - 测试上：原来的断言只查**内容**（「参数里有没有 `insteadOf`」），查不出**形状**错误。
     现在补了两道：一道断言片段必须成对的 `-c key=value`，一道直接**拿真 git 跑一遍**
     （`git <片段> config --get http.lowSpeedTime` 必须回 `60`，而不是「不是一个 git 命令」）。
     缺 git 的机器会自动跳过这一道。

   顺带一提，这个 bug 是**把 `apply()` 真跑起来、对着真 GitHub 发一次 fetch** 才暴露的：
   假 git 只管把参数记下来，不看 git 认不认。而且它当时有**两个入口**——「检测网络」里的
   代理那条也是手写的裸 `key=value`，症状是代理永远显示成一句看不懂的失败。所以修法不只是
   补 `-c`，而是让探测**复用同一个生成函数**（`probeJobs` 调 `networkExtraArgs`），
   把「能写错的地方」从两处减到零处。回归测试见 `test/network.test.mjs`。

### 客户端诊断日志

界面注册类问题在浏览器控制台里对用户不可见，因此客户端会把注册过程回报到宿主：

```
~/.dsh/git-panel-diag.log
```

内容包括 `apply:start`、`overlay:registered-direct`、`overlay:direct-failed`、
`settings:register-failed-after-declaration` 这类阶段标记，排查「面板出现了但设置行
没出现」时直接看这个文件即可。该文件可以随时删除。

## 测试

宿主的解析/决策逻辑都是纯函数（porcelain 分支行、远程列表、推送失败分类、拉取失败分类、
远端分支列表、远端引用校验、`HEAD...<ref>` 比较结果、远端默认分支的挑法、远程配置决策、
clone 目标名、目录归一化），用 Node 自带测试框架覆盖：

```bash
npm test        # node --test：122 个用例，毫秒级完成（需要 git / POSIX 的那几道会自行跳过）
npm run check   # 语法检查（index.js + client.js）
```

其中三个文件专门验证「**独立运行**」，不需要 DSH、不需要装任何东西、也不联网：

| 文件 | 验证什么 |
| --- | --- |
| `test/standalone.test.mjs` | 用 mock ctx 把宿主半边跑一遍：`import` 不抛异常；`apply()` 在「服务就绪 / 稍后就绪 / 都缺 / ctx 被裁剪」四种情况下都不抛；卸载能清空路由与工具；13 个工具的 `parameters` 都落在 harness 支持的 JSON Schema 子集内（用了 `anyOf` / `$ref` / `format` 之类会让 `tools.register` 抛错、工具静默全丢） |
| `test/unit.test.mjs` | 纯函数逐个断言：porcelain 分支行、`git remote -v`、推送/拉取的失败分类与中文提示、`git branch --remotes`（`origin/HEAD -> origin/main` 这类指针必须被排除）、远端引用校验（`-x` / `a..b` / 含空白的一律拒绝）、`HEAD...<ref>` 的领先/落后、远端默认分支的挑法（拿不准就返回 null，绝不猜）、`unrelatedChoices` 必须带上真正的远端分支名、clone 目标名、目录归一化 |
| `test/client.test.mjs` | 用假 window + 假 React 把客户端 bundle 求值一遍：bundle 格式与 id 正确；**只 require `react` 这一个种子模块**（多 require 别的就说明依赖了构建产物）；导出 `apply` + `inject: ['slots']`；`slots` 缺失 / 直接注册成功 / 稍后声明三种时机都不抛；注册失败会把真实原因回报；组件在 props 缺失时也能渲染（slot 契约变化不白屏）；点改动看 diff 能走到终态（用**有状态**的假 React 真重渲染，不会停在「加载中…」）；**切换工作区后命令结果栏 / diff / 状态都属于新工作区**（旧仓库的瞬时结果被清掉，切走之后才回来的操作结果被丢弃）；网络加速设置块能展开、能保存、检测结果能列出，且网络失败时会自动展开；**「管理」里能看到远端分支**，点「拿成新分支」POST 的是带 `remote`/`branch` 的 `adoptRemote`（不是按当前分支名去猜），点远端分支不会触发 checkout |
| `test/network.test.mjs` | 网络加速整条链路：配置归一化（含「只打开开关就该生效」这个踩过的坑）、`insteadOf` 的 base 拼法、push 不走镜像、`noMirror` 回退参数、凭据打码（GET 视图 / 命令回显 / 工具输出三处都不能漏）、失败分类（用户那条真实报错要认出来，404 不能被当成网络问题）、配置落盘与合并、`/git-panel/net` 三种方法 + 跨站拒绝 + 打码串回传语义；最后用**假 git 放到 PATH 最前面**离线复现「镜像挂、直连通」，验证自动回退确实发生、且结果栏会说明这件事 |

> 这几个文件是**换机器、换 DSH 版本时的第一道回归**：`npm test` 过了，说明插件
> 自身的加载与注册契约没变；剩下的只是 DSH 侧服务是否提供（缺了就优雅降级）。
> 网络加速那部分刻意全部做成**离线**验证：真的去连 github 会让测试结果随网络环境
> 变化，那种测试在有网和没网的机器上给出的信号完全不同。

## License

MIT
