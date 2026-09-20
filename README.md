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
| 安全拉取 | 工作区**有未提交改动（含未跟踪文件）**时也能拉取：先自动藏起改动（`git stash push -u`），拉取成功后再原样恢复（`git stash pop`）；**拉取失败会自动把改动还给你**，绝不会让改动留在 stash 里没人管（弹回时冲突也有明确的收尾提示；这次拉取撞出的合并冲突会自动撤销） |
| 远程 / 配置 | 查看或修改推送目标（`git remote add` / `set-url`） |
| 仓库页 ↗ | 远程地址能推导成网页地址（GitHub / GitLab / Gitee… 的 https / ssh / scp 风格）时，「远程」行出现该链接：点击**直接在新标签页打开仓库主页**，不用复制地址再去浏览器粘贴。本地路径等推导不出的地址不显示，绝不给死链 |
| 分支管理 | 打开后列出**本地分支**：点名字**切换**、输入名字**新建并切换**、按钮**安全删除**（未合并的分支会被拒绝，防误删历史）；同时列出**远端分支**（`git branch --remotes`，获取远程之后可见）：点「拿成新分支」把远端那一份取成本地新分支（当前分支一点不动），点「比较」看两边各差几个提交。点远端分支**不会**直接切过去——那会变成游离 HEAD。**远端默认分支**钉在远端分组的第一行（其余仍按字母序），分组顶部写明「远端默认分支：origin/main」，对应行带独立的「默认」徽章——本地没有 `origin/HEAD` 指针（旧版 git 的 init+远程、镜像远端）或指针过期时，面板会自动向服务器补问一次（`git ls-remote --symref`，只读、照常走镜像/代理），不会因此变成「找不到默认分支」。分支名被省略号截断时**悬停能看到全名**（tooltip 带完整 ref） |
| 改动点开看 diff | 改动清单里点任意条目，diff **就在这一行下面展开**（清单不会被顶掉、也不会被盖住），展开中的那一行带品牌色竖条；已暂存条目看的是暂存区版本，再点一次收起 |
| 单文件暂存 / 取消暂存 / 还原 | 每一行改动右侧带自己的小按钮：未暂存给「暂存」（未跟踪文件也能加进来）、已暂存给「取消暂存」（只动暂存区，工作区内容保留）；**工作区确实有改动**（porcelain 第二列 M/D）的条目才有「还原」，点了要先确认 —— 未跟踪文件不提供还原（那等于删文件） |
| 「安全切分支」 | 工作区有未提交改动时点分支名：git 的裸 switch 会拒绝（`Your local changes would be overwritten`）。面板确认一句就自动走 stash push -u → **switch** → stash pop：切换成功后改动原样恢复，**切换失败自动还给你**（仓库回到切换前）。与「安全拉取」同一套安全保证 |
| stash 备份 | 「安全拉取」「安全切分支」自动藏起来的改动收在一个可展开的列表里：能看到内容、一键**恢复**（`git stash apply`，不删备份）与**删除**（不可逆，要确认）。弹回冲突时面板会列出要处理的冲突文件，收尾不必回终端 |
| 提交详情 | 最近提交的**整行可点**：点开看这条提交的作者 / 日期 / 改动统计（`git show --stat --format=fuller`，宿主截断后回传），再点收起 —— 和「点改动看 diff」是同一套交互 |
| 提交并推送 | 提交表单第二个按钮：提交成功后立刻推一次，省掉「提交完再点推送」的第二下；推送失败的提示与补齐逻辑与「推送」按钮完全一致 |
| 补充上次（amend） | 提交表单里的勾选框：`git commit --amend`，适合「刚提交完发现漏了个文件」；提交成功会自动取消勾选 |
| 变基拉取 | 同步区「变基」勾选框：勾上后「拉取」走 `git pull --rebase`（本地提交挪到远端提交之上，历史更直） |
| 浅克隆 | 克隆表单里的勾选框：`git clone --depth 1`，只取最新一次提交（快、小；要完整历史就别勾） |
| 分支改名 | 分支管理器里**当前分支**那一行的「改名」（`git branch -m`）；名字由用户输入，面板不猜 |
| 复制远程地址 | 远程行上的「复制」：把这行显示的地址放进剪贴板（优先 Clipboard API，非安全上下文退回 `execCommand`），ssh 形式也能复制 |
| 自动刷新 | 窗口重新获得焦点 / 标签页重新可见时**静默**读一次状态（不点亮「同步中…」、失败不刷结果栏）；有未提交改动时每 20 秒轻量轮询一次，编辑器 / 终端里产生的改动也会自己出现在面板上 |
| 面板尺寸与折叠 | 左缘可以拖动改宽度（300–520px），宽度与折叠态都记在 `localStorage`，下次打开就是上次的样子 |
| 渲染错误边界 | 面板渲染抛异常时不再静默消失：画一个可读的失败态 + 原因 + 「重试」，并把原因写进宿主日志 |
| 帮助（?） | 头部「?」在**新标签页打开独立帮助文档**（同源路由 `GET /git-panel/help`）：面板操作方式 + 分组常用 git 命令；**每条命令点一下即复制到剪贴板**。文档是普通网页——原生滚动、Ctrl+F 查找、可打印、可收藏，适合开着边看边敲 |
| 切换 / 刷新 | 换一个目录操作 / 重新读取状态 |
| 跟随会话 | 手动切过目录后，一键回到当前会话的工作目录 |
| 网络加速（🌐） | 连不上 github.com（`Connection was reset` / 超时）时打开：克隆/获取/拉取可走第三方镜像，全部操作可走本机代理。见 [网络加速](#网络加速连不上-github) |

面板同时展示：当前分支、上游跟踪状态（领先/落后几个提交）、远程地址（能推导成网页地址时带「仓库页 ↗」入口，点击新标签页打开仓库主页）、
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

**改了没提交也能拉**：「安全拉取」（`stashPull`）解决「本地有改动、又想拉更新」的现场。
git 的裸 pull 在脏工作区上会直接拒绝（`Your local changes would be overwritten`），
于是这条路自动变成三步：`git stash push -u`（连未跟踪文件一起藏）→ `git pull`
（与「拉取」按钮**同一条路**：镜像/代理加速、失败自动补救全都有）→ 拉取成功后 `git stash pop`
原样恢复。安全保证写死在流程里：

| 环节 | 保证 |
| --- | --- |
| 藏改动失败 | 拉取根本不开始，你的改动原样没动 |
| 拉取失败 | 先把这次拉取撞出的合并冲突撤销（`merge --abort`），再把改动弹回工作区——仓库回到拉取前；极少数弹不回时改动仍安全存在 stash 里，提示给出恢复命令 |
| 恢复改动时冲突 | 拉取已完成；两边的改动都在冲突文件里（`<<<<<<<` 标记），你原来的改动还额外留着一份 stash 备份，提示给出收尾步骤 |

工作区本来就是干净的（或已经提交过）时，「安全拉取」不会多此一举制造 stash，行为与「拉取」完全一致。

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
│   ├── index.js          # 插件入口：apply() + 对外导出（0.10 起只剩一个入口加一张导出清单）
│   ├── routes.js         # HTTP 路由 /git-panel/* + op 流水线
│   ├── ops.js            # 操作注册表：每个操作的 argv / 超时 / 解析 / 补救 / 提示（唯一事实来源）
│   ├── tools.js          # 13 个 git 模型工具（argv 全部复用 ops.js）
│   ├── git.js            # git 执行（execFile + 参数数组）与 porcelain/branch/remote 解析、状态读取
│   ├── net.js            # 网络加速：镜像/代理配置、参数注入、线路实测
│   ├── failure.js        # 失败分类 + 「下一步点哪里」的中文提示（纯函数）
│   ├── log.js            # 统一操作日志（JSONL、级别、轮转、串行写入）
│   ├── help.js           # 帮助文档（独立 HTML 页面）
│   ├── util.js           # 无依赖小工具（打码、归一化、文本处理）
│   └── client.js         # Client half：面板 + 设置开关（手写 bundle，只能单文件）
└── test/                 # node --test，不随包发布（package.json 的 files 里没有它）
    ├── unit.test.mjs     # 宿主纯函数（含日志模块：级别过滤 / 轮转 / 尾读）
    ├── standalone.test.mjs # 零依赖加载 / 注册契约 / 操作注册表一致性
    ├── client.test.mjs   # 客户端 bundle（假 window + 假 React）
    └── network.test.mjs  # 网络加速整条链路（含假 git 离线复现「镜像挂、直连通」）
```

> 0.10 之前宿主半边是一个 2711 行的单文件：git 执行、解析、网络配置、日志、帮助文档、
> 路由、工具七种职责混在一起，同一个 git 操作的元数据散在 9 处。现在按职责分层，
> **每个操作只在 `ops.js` 里声明一次**，面板与模型工具指向同一组 argv 构造器。
> 客户端半边是手写 bundle（`factory(require)` 只能取平台种子模块），因此必须保持单文件，
> 拆分只能发生在文件内部（一个 reducer + 若干纯展示组件，见下）。

## 设计说明

- **零外部依赖**：Host 只用 Node 内置模块，Client 只 `require('react')`（种子模块），
  因此 link 到任何 profile 都能解析，DSH 升级也不会破坏它。
- **界面自带样式、不污染全局**：面板的基础外观写在内联样式里（局部样式表万一没生效，
  界面也只是少了悬停反馈，不会变成裸控件）；悬停 / 键盘焦点 / 过渡 / 细滚动条 /
  diff 与命令结果的分行着色由一个**随组件渲染的局部 `<style>`** 提供，组件卸载即回收，
  不写全局样式表、不动宿主 DOM。颜色一律走宿主的 `--dsw-alias-*` 主题 token，浅色/
  深色自动跟随；面板自己的类名全部带 `dgp-` 前缀，不会命中宿主的任何元素。
- **无注入面**：宿主用 `child_process.execFile` + **参数数组**执行 git，不经过 shell；
  提交信息、路径里的引号/空格/分号都只是普通数据。
- **同源校验**：执行类 POST 请求校验 `Origin`，拒绝跨站提交。
- **失败可见**：非零退出被归一化成 `{ code, stdout, stderr }` 回传面板，而不是抛异常，
  面板永远能渲染出原因。
- **统一操作日志**：面板操作、AI 工具调用、网络配置变更、客户端注册过程、内部错误
  全部写进启动目录下的 `git-panel.log`（JSONL，级别 `off/error/warn/info/debug` 可配），
  超过 `logMaxBytes` 自动轮转只留两份。命令参数经 `displayArgv` 打码后才落盘；写失败
  只记 console 不抛异常 —— 日志是观测工具，不是新的故障点。`GET /git-panel/log` 可
  直接读尾部。
- **目录跟随会话**：面板通过 `shell.overlay` 的标准 props `useSessions` 读取当前会话
  的工作目录，切换会话时自动跟随；也可在面板里手动切换到任意目录。
  注意「当前会话」的判据：`shell.overlay` 是 **root scope** 插槽，拿不到 `sessionId`，
  而 `useSessions` 的 state（`SessionListState`）里只有 `ids / byId / phase /
  subagentsByParent / jobsBySession` —— **没有 `current` 字段**。所以面板认的是列表里
  `retainedBy.mainView > 0` 的那一行，与宿主自己的 `publishMain`、`ui-workspace` 的
  `mainSessionId` 同一判据（见开发注记第 6 条）。
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
- **一个操作只有一处定义**（0.10 起）：`lib/ops.js` 的 `OPS` 注册表声明每个操作的
  argv 形状、超时、结果解析、失败补救与提示；面板的 `buildOpArgv` 与 13 个模型工具的
  `toArgv` 都指向同一组 `argv*` 构造器。此前它们是两套，而且已经分叉 —— 面板切分支用
  `git switch`（`checkout` 在「名字既像分支又像路径」时会误判成还原文件），工具却用
  `git checkout -b`。`test/standalone.test.mjs` 有一条断言钉住两条路径的 argv 一致。
- **面板状态收在一个 reducer 里**（0.10 起）：客户端原先用 28 个 `useState`，其中
  「属于某个仓库」的那批靠一个手写的 `forgetRepoDetails()` 逐个清 —— 漏一个就会把旧
  仓库的数据显示成新仓库的（上一版就漏了 `branchDraft` 与 `dirDraft`）。现在换工作区
  只有一个动作 `'reset-repo'`，`test/client.test.mjs` 用真状态重渲染验证它。
- **能省的状态读取就省**：面板每次操作都会带回最新状态，因此客户端不再在操作后额外
  `load()` 一次；数据型操作（列分支、查 diff、比领先落后）带 `noState:true`，宿主跳过
  那次状态回读（每次 4 条 git 进程）。分支管理器一次 `branches` 同时拿回本地与远端
  两份 —— 展开一次由原先的 10 条 git 进程降到 2 条。
- **截断必须说出来**：状态里 `changes` 最多 100 条、面板最多画 40 条，真实总数由
  `changesTotal` 回传，超出部分在列表末尾写明「还有 N 处未显示」，摘要胶囊也用真实总数。
- **宿主的诊断会显示出来**：`state.notice`（未装 git / 读取失败 / 还不是仓库）由面板
  渲染在空态里 —— 此前宿主认真算出来，客户端一次都没读过。
- **「不是工作区」的四种原因分开说**（0.10.1）：目录不存在 / 传进来的是个文件 / 普通目录
  但不是仓库 / 裸仓库或 `.git` 内部。Node 对「没有 git」和「cwd 不存在」给的错误对象
  一模一样（`code=ENOENT`、`path='git'`），早先一律当成前者 —— 面板里敲错一个路径会被
  要求「请先安装 git」。非仓库那句话（`NOT_REPO_NOTICE`）同时是客户端去重用的字符串，
  两边由 `test/standalone.test.mjs` 钉住一致（此前宿主发 git 的英文原文，去重分支是死代码；
  git 的「不是仓库」报错文案还会随系统语言走，中文环境下是 `不是 Git 仓库`，0.10.2 起
  两种语言都认；`cwd` 指向一个文件时 WSL 等平台报 `ENOTDIR`，同样归一成「这不是一个目录」）。
- **远端默认分支找不到 / 分支名看不全**（0.10.2）：默认标记原先写在分支名里
  （`origin/main（默认）`），名字被省略号一截断标记就跟着消失；而默认标记依赖本地的
  `origin/HEAD` 指针，它在旧版 git 的 `init + 远程` 或镜像远端下根本不存在。现在：
  默认分支是行内独立的「默认」徽章（截断不影响），并且**钉在远端分组的第一行**
  （字母序下 llama.cpp 的 master 会夹在几十条分支中间，看着像「没下载下来」）；
  分组顶部还有「远端默认分支：…」提示行；本地没有可用指针时面板自动向服务器补问
  一次（`git ls-remote --symref`，只读、走同一套镜像/代理，失败静默降级）；分支名
  截断后悬停（tooltip）能看到完整 ref。
- **失败分类按操作分开**（0.12）：`classifyPushFailure` 只回答「推送为什么失败」，
  拿它去问 commit 或 checkout 只会得到 `none`，用户看到的就是一句 git 英文原文。
  现在三类各自的分类器 + 中文下一步：HTTPS 认证失败（`Authentication failed` /
  `could not read Username` → 指向 Personal Access Token 与 `credential.helper`，
  与 SSH 的 `auth-failed` 分开）、提交身份没配置（`Please tell me who you are` →
  给出两条确切的 `git config` 命令）、切换撞上脏工作区（指向面板的「安全切分支」）。
  分类器挂在 `OPS` 注册表上（`spec.classify` / `spec.hint`），新增操作只要声明一次。
- **工具与面板共享同一条执行通道**（0.12）：`executeWithAcceleration` 从 routes.js
  下移到 ops.js，两侧都调它 —— 于是「镜像失败自动回退直连」对 AI 工具同样生效
  （此前只有面板会回退）；`git_pull` / `git_push` 工具还挂上了与面板同一套
  `recoverPull` / `recoverPush`（无上游自动补 `-u`、自动改按「远程 + 分支」拉），
  并把加速说明、补救说明（`⇢` 前缀）一并写进工具输出，模型能看到刚才为什么重试。
- **同源校验之外再加一次性令牌**（0.12）：`sameOrigin` 比的是客户端自己写的两个头，
  能伪造请求头的进程照样能过。现在 `GET /git-panel/state` 与 `GET /git-panel/net`
  各发放一枚随机令牌，`POST /op` 与 `POST /net` 必须带上（令牌是「最近 64 枚」的集合，
  多标签页不会互相踢掉）；**没有发放过令牌时不校验**，直接 curl 端口的自动化脚本
  与既有测试不受影响，而浏览器发起的跨站请求一定先经过 GET —— 它读不到响应体里的令牌。
- **状态短缓存与按目录串行**（0.12）：`readState` 一次要跑 4 条 git 进程，而「操作完
  立刻看结果」「回到窗口自动刷新」会让同一目录在几百毫秒内被读两遍 —— 800ms 内直接
  复用上一次结果；操作路径不读缓存（执行完必须回一份真实状态，并把结果写回缓存）。
  面板有 busy 锁，但 AI 工具与面板可以同时操作同一个仓库，于是宿主按**目录**用一个
  promise 链把写操作排成队（不同目录互不影响）。
- **日志落在工作区**（0.12）：默认写到 `process.cwd()/git-panel.log`（启动 dsh 时所在
  的目录），而不是 `$DSH_HOME` —— 排查时 `tail -f git-panel.log` 不用先 cd；已在
  `.gitignore` 里排除，不入库。`logFile` 配置仍然可以覆盖到任意路径。
- **数据型操作有独立的时间预算**（0.12）：`diff` / `branches` / `compare` / `show` /
  `stashList` 这类本地命令正常是毫秒级，原先也按 120 秒预算等 —— 真出故障要干等两分钟
  才见到提示。现在它们走 20 秒的本地档，联网操作（clone / fetch / pull / push）仍是
  10 分钟档。

## 0.10 / 0.10.1 的契约变更（升级须知）

这次重构修掉了若干「逻辑不一致」，其中有几条改了对外可见的行为：

| 位置 | 之前 | 现在 | 为什么 |
| --- | --- | --- | --- |
| 模型工具参数错误 | 返回一段普通文本 | **抛错**（消息带工具名） | harness 把抛出的异常标成失败的调用；返回文本会被模型读成「命令跑完了」，参数写错变成静默的假成功 |
| `git_checkout` | `git checkout [-b]` | `git switch [-c]` | 与面板一致；`checkout` 在「名字既像分支又像路径」时会误判成还原文件 |
| 面板「丢弃改动」 | `git checkout -- .` | `git restore -- .` | 与帮助文档里给用户的命令一致（都需要 git ≥ 2.23，面板早就在用 `git switch`） |
| `POST /git-panel/op {op:"branches"}` | 只回本地分支 | 同时回 `branches` 与 `remoteBranches` | 一次往返拿两份，省掉两次状态回读 |
| `POST /git-panel/op` | 没有跳过状态读取的方式 | 支持 `noState:true` → `state:null` | 数据型操作不必回读仓库状态 |
| `GET /git-panel/state` | 没有真实改动总数 | 多一个 `changesTotal` | 面板要能说明「还有 N 处未显示」 |
| 错误响应状态码 | 内部错误也回 200 | 参数错误 400 / 内部错误 500 / 跨站 403 | 状态码是给日志与排查的人看的（响应体形状不变，客户端只读 `ok`） |
| `git_pull` / `git_push` 补救函数 | 两套不同的参数顺序 | 统一成 `recover(ctx)` | 挂到同一张注册表上就不可能再记错参数 |
| `setRemote` 的查重目录 | 原始请求体里的 `dir` | 路由归一化后的目录 | 配置了 `defaultDir` 或传 `~/…` 时会误判成「远程不存在」→ `remote add` 撞上 `remote origin already exists` |
| `state.notice`（0.10.1） | 目录不存在时报「未检测到 git」；非仓库时报 git 的英文原文 | 目录不存在 → `目录不存在或无法进入：…`；非仓库 → `当前目录还不是 Git 仓库`；裸仓库 → 单独一句 | 前者把路径写错说成没装 git；后者让客户端的中文去重分支变成死代码（中英各显示一句） |
| `lib/git.js` 的导出（0.10.1） | — | 多出 `NOT_REPO_NOTICE` / `BARE_REPO_NOTICE` / `notRepoNotice` | 宿主与客户端共用的那句去重文案需要一个可断言的出处 |

## 0.12 的契约变更（升级须知）

| 位置 | 之前 | 现在 | 为什么 |
| --- | --- | --- | --- |
| `GET /git-panel/state` / `GET /git-panel/net` 响应 | 只有业务字段 | 多一个 `csrf` | 发放一次性会话令牌（客户端只读它，不参与渲染） |
| `POST /git-panel/op` / `POST /git-panel/net` | 只校验 `Origin` | 发放过令牌后还要带对令牌 | 跨站请求读不到响应体，拿不到令牌 —— 见「安全边界」 |
| 日志默认路径 | `$DSH_HOME/git-panel.log` | **启动目录**下的 `git-panel.log` | 日志就在工作区里，`tail -f` 不用先 cd；已在 `.gitignore` 排除 |
| 数据型操作的超时 | 一律 120 秒 | `diff`/`branches`/`compare`/`show`/`stashList` 走 20 秒本地档 | 本地命令正常是毫秒级，出故障不该干等两分钟 |
| `commit` / `checkout` 失败的 `reason` | 一律 `none`（用户看到 git 英文原文） | `identity-missing` / `nothing-to-commit` / `dirty-worktree` / `branch-missing` + 中文 `hint` | 这三类是新手最常撞的，必须给出下一步 |
| `pull` | 固定裸 `git pull` | 面板的「变基」勾选后走 `--rebase`（工具侧本来就有 `rebase`） | 能力面对齐 |
| 模型工具 `git_pull` / `git_push` | 失败就把 git 原文返回 | 与面板同一套补救（无上游自动补 `-u`、自动改按「远程 + 分支」拉）+ 镜像失败自动回退直连 + `⇢` 说明行 | 两侧共用 `executeWithAcceleration` 与 `recoverPull` / `recoverPush` |
| `OPS` 注册表 | 17 个操作 | 新增 `add` / `unstageFile` / `restoreFile` / `show` / `stashList` / `stashApply` / `stashDrop` / `renameBranch`（另有 `stashSwitch` 走 `SPECIAL_OPS`） | 面板新增入口都只在一处声明 |
| 日志尾读 | 每次读整个文件 | 从文件尾部回读（单次最多 4 MiB） | `GET /git-panel/log` 会被反复调用 |
| 面板前端 | 渲染异常即静默消失 | 加了渲染错误边界：失败态 + 原因 + 「重试」，原因写进日志 | 与宿主「故障可见」的原则对齐（测试替身下自动降级为直通） |

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
    logLevel: info                 # 日志级别：off | error | warn | info | debug
    logMaxBytes: 2097152           # 日志轮转上限，超出后旧文件改名 .1
    logFile: ''                    # 日志文件路径；留空 = 启动目录下的 git-panel.log
```

网络加速（镜像 / 代理）**不走这里**，而是 `$DSH_HOME/git-panel-net.json`，由面板的
🌐 按钮读写 —— 那个设置要能随时改，不该逼用户编辑 yml 再重启。删掉该文件即恢复默认
（不加速）。日志见[上一节](#日志维护排查用)。

## 安全边界（部署时注意）

面板路由 `/git-panel/*` **没有独立鉴权**，执行类请求校验两样东西：
`Origin` 同源，以及一枚**一次性会话令牌**（0.12 起）。

令牌的作用是挡住「能伪造 `Origin` 的跨站请求」：`GET /git-panel/state` 与
`GET /git-panel/net` 在响应体里各发一枚随机令牌（保留最近 64 枚，多标签页不会互相踢掉），
`POST /op` 与 `POST /net` 必须带上其中一枚才执行。浏览器发起的跨站请求虽然能发出
GET，却**读不到响应体**，因此拿不到令牌；带上假令牌一律 403。
注意两点：令牌只在浏览器同源页面里流转、不落盘；**服务端从未发放过令牌时不校验**，
这是为了不破坏 `curl` 之类的本地自动化（也正因如此，它不是「鉴权」，只是加固）。即便如此：

- 绑定 `127.0.0.1` 时，能访问到的只有本机进程；
- 若 `webserver.host` 配成 `0.0.0.0`（手机 / 局域网访问场景常见），同网段的主机
  只要能在 HTTP 头里伪造 `Origin`、**且能从别处拿到一枚令牌**，就能调用这些接口执行
  `git clone / pull / push / commit` 等操作。请把令牌理解为「把难度从伪造一个头
  提高到需要先读到同源响应」，而不是「已经安全」。

`/git-panel/net` 也在这个范围内，分两种情况：

- `GET` 读配置、`GET ?probe=1` 现场探测各线路。**代理地址一律打码**后才返回
  （`http://***@host:7890`），明文凭据不回显、不进浏览器；但「设过代理」这个事实、
  以及探测各线路通不通的结果，局域网内是可见的。
- `POST` 保存配置**带同源校验 + 令牌校验**，因为该接口决定 git 命令**怎么执行** ——
  被跨站改写就等于把仓库流量导向别处。

`GET /git-panel/log` 是**只读**的日志尾读接口，无同源校验。日志本身已经是保守视角：
命令参数打码、凭据不落盘；但它包含操作目录、仓库名与提交信息等**本机工作痕迹**，
对局域网开放 web 端口时这些内容同样可见，请按下面的结论一并考虑。

结论：**把 Git 面板和「对局域网开放 web 端口」分开考虑**；确实需要对局域网开放时，
请用 DSH 的配对 / 鉴权层限制访问，或让 `webserver.host` 保持回环。

## 开发注记（六个真踩过的坑）

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

6. **假 store 抄了不存在的字段，功能全废测试还是绿的。**
   「目录跟随会话」一直没生效，根因是面板读 `useSessions((state) => state.current)` ——
   而 `SessionListState` 上**根本没有 `current` 这个字段**（只有 `ids / byId / phase /
   subagentsByParent / jobsBySession`）。于是 `sessionCwd` 恒为 `undefined`，面板从不给
   宿主发 `dir`，宿主只能退回自己的缺省目录（`process.cwd()`，实测是
   `~/.dsh/profiles/web`，根本不是仓库）——「切了会话，面板还停在上一个仓库 / 显示不是
   仓库」，而**界面上不会有任何报错**。
   为什么测试没拦住：当时的假 store 写成了 `{ current: 's1', byId: { s1: { cwd } } }`，
   和真代码**抄了同一个错误假设**，选择器当然拿得到值。这类「mock 与真实契约不一致」
   是测试里最贵的假绿：它验证的是「我们俩想的一样」，不是「宿主真的是这样」。
   修法与教训：

   - 判据用宿主自己的：`shell.overlay` 是 root scope，没有 `sessionId`，当前会话要从
     列表里认 `retainedBy.mainView > 0` 的那一行（宿主 `publishMain` 与
     `ui-workspace.mainSessionId` 都是这个判据）。
   - 测试里的 store 必须**照真实契约造**：现在有 `sessionStore()` 这个 helper，
     它刻意**不提供 `current`** —— 谁再照着不存在的字段写，测试立刻红。另外补了三道
     回归：切到**另一个会话**（另一行）要跟着换目录；没有当前会话时退回宿主缺省目录、
     不瞎猜一行；手动切过目录后不被会话目录覆盖，「跟随会话」按钮才恢复。
     见 `test/client.test.mjs` 第 5 节。

7. **可滚动的 flex 子项会被压扁：`overflow:auto` 的自动最小尺寸是 0。**
   点改动条目展开 diff 时，看到的现象是「弹出来的 diff 框把改动文件展示框盖住了」。
   根因不在 diff，而在面板正文是一个**可滚动的 flex 列**：`overflow: auto` 的子项其
   自动最小尺寸（`min-height: auto`）会退化成 0，于是默认的 `flex-shrink: 1` 允许浏览器
   把「自带滚动的改动清单」压成一条缝 —— diff 越大清单被压得越扁，看起来就像被盖住了；
   同时 diff 自己还常常被挤到可视区之外。
   修法两层：① 自带滚动的列表一律 `flex: 0 0 auto`（它自己能滚，永远不需要被压缩，
   宁可让正文整体滚动）；② diff **内联展开在被点的那一行下面**，与文件行共用清单
   这一个滚动区，展开期间把清单的取景框放高（148 → 360px），并给展开中的那一行加
   品牌色竖条，标明「这块 diff 是谁的」。回归测试见 `test/client.test.mjs` 第 4b 节。

## 日志（维护排查用）

插件在本机上维护一份统一的操作日志，**默认就写在启动 dsh 时所在的工作区目录**：

```
<启动 dsh 时的目录>/git-panel.log     # JSONL：一行一条 { at, level, event, … }
<启动 dsh 时的目录>/git-panel.log.1   # 超过轮转上限后的旧文件（只保留这一份备份）
```

`git-panel.log` 已在 `.gitignore` 里排除（`/git-panel.log*`），不会被提交；想放到别处
就用行配置 `logFile` 覆盖（见下）。

**记什么**：面板每一次操作（op：操作名、目录、命令、退出码、耗时、失败原因、是否补救/
走哪条网络线路）、AI 工具每一次调用（tool）、网络加速配置变更（net）、客户端界面
注册过程（diag）、插件生命周期与内部错误（lifecycle / error）。`debug` 级别还会记
每一条 git 命令（含状态刷新那几条）——默认不落盘，排查深层问题时再开。

**级别**（`logLevel`，默认 `info`）：

| 级别 | 含义 | 默认 |
| --- | --- | --- |
| `off` | 完全不写 | |
| `error` | 只记不该发生的事（注册失败、内部异常） | |
| `warn` | + 操作/工具失败 | |
| `info` | + 每次操作/配置变更的结果 | ✅ |
| `debug` | + 每条 git 命令、每次状态刷新 | |

**查看**：`GET /git-panel/log?lines=200` 返回最近 200 行原文（最多 2000）；
也可以在浏览器里直接开这个地址。命令行查看：

```bash
tail -f git-panel.log                 # 实时看（日志默认就在启动 dsh 的目录里）
tail -50 git-panel.log | jq           # 按字段解析（每行是一个 JSON 对象）
```

**安全**：日志里的命令参数与网络加速配置**一律打码**（代理凭据 → `***@`，与面板回显
同规则）；文件只落在本机启动目录，可随时删除。**写日志失败不影响任何功能**。

**配置**：在 profile 的 `cordis.patch.yml` 里用同一个 id 覆盖
`logLevel` / `logMaxBytes`（默认 2 MiB，超过后轮转）/ `logFile`（默认
启动目录下的 `git-panel.log`）。

## 测试

宿主的解析/决策逻辑都是纯函数（porcelain 分支行、远程列表、推送失败分类、拉取失败分类、
远端分支列表、远端引用校验、`HEAD...<ref>` 比较结果、远端默认分支的挑法、远程配置决策、
clone 目标名、远程地址 → 仓库主页推导、目录归一化），用 Node 自带测试框架覆盖：

```bash
npm test        # node --test：199 个用例，秒级完成（假 git / 真 git 的 POSIX 专属用例会自动跳过）
npm run check   # 语法检查（lib/ 下全部模块 + 客户端 bundle）
```

> **换机器 / 换 DSH 版本时先跑这一条**。它里面有几道**真 git** 的端到端用例
> （`runGit` 的实际执行、注入的 `-c` 参数能否被 git 接受、`setRemote` 的查重目录），
> 0.10 的模块拆分里正是这类用例抓出了一个「常量被漏掉、`runGit` 全挂、
> 而其余用例仍然全绿」的问题 —— 只跑纯函数与 mock 用例是发现不了的。
>
> 在受限沙箱（例如 DSH 自己的文件沙箱）里 `node --test` 会因为要 spawn 子进程而
> `EPERM`；逐文件 `node test/xxx.test.mjs` 是等价的（node:test 在被直接执行时也会跑），
> 但那样会把真 git 用例跳过 —— 请优先在不受限的环境跑完整 runner。

其中三个文件专门验证「**独立运行**」，不需要 DSH、不需要装任何东西、也不联网：

| 文件 | 验证什么 |
| --- | --- |
| `test/standalone.test.mjs` | 用 mock ctx 把宿主半边跑一遍：`import` 不抛异常；`apply()` 在「服务就绪 / 稍后就绪 / 都缺 / ctx 被裁剪」四种情况下都不抛；卸载能清空路由与工具；13 个工具的 `parameters` 都落在 harness 支持的 JSON Schema 子集内（用了 `anyOf` / `$ref` / `format` 之类会让 `tools.register` 抛错、工具静默全丢）；**工具的参数错误必须抛错**（不能返回文本被模型读成成功）；**面板与工具对切换/新建/删除分支生成同一份 argv**（回归：曾分叉成 switch vs checkout）；**`OPS.network` 与 `NETWORK_OPS` 完全一致**（加了新操作却忘了让加速生效会变成静默直连）；**`setRemote` 的查重与执行用同一个目录**（回归：曾用原始 `body.dir` 查重，`~/…` 或 `defaultDir` 下会误判成远程不存在）；**「不是工作区」的四种诊断互不冒充**（目录不存在 / 传进来的是文件 / 普通目录 / 裸仓库，并且断言 `client.js` 里去重用的就是宿主发出的那个字符串 —— 回归：宿主发 git 英文原文，客户端去重分支成了死代码）；**`stashSwitch`（安全切分支）在真 git 里跑三遍**：有改动时藏起→切换→恢复且一件不少、目标分支不存在时改动原样还回工作区、干净工作区不制造 stash；**`runPanelOp` 真跑一遍新增的数据型操作**（`show` / `stashList` / 单文件暂存与取消暂存），断言解析出来的字段（回归：只断言 argv 发现不了「解析函数没挂上、面板永远读不到 show/stash」） |
| `test/unit.test.mjs` | 纯函数逐个断言：porcelain 分支行、`git remote -v`、推送/拉取的失败分类与中文提示、`git branch --remotes`（`origin/HEAD -> origin/main` 这类指针必须被排除）、`git ls-remote --symref` 的默认分支解析（哈希行/空输出一律 null，绝不瞎猜）、远端引用校验（`-x` / `a..b` / 含空白的一律拒绝）、`HEAD...<ref>` 的领先/落后、远端默认分支的挑法（拿不准就返回 null，绝不猜）、`unrelatedChoices` 必须带上真正的远端分支名、clone 目标名、**远程地址 → 仓库主页推导**（https / scp / git:// / ssh:// 都认，`.git` 去除；本地路径、盘符、`file://`、空地址一律 null）、目录归一化；日志模块：级别归一化与过滤、JSONL 落盘、轮转只留 `.1` 一份、尾部读取、默认路径落在启动目录；**新增的三类失败分类与提示**（HTTPS 认证 → 令牌与 `credential.helper`、提交身份没配置 → 两条 `git config` 命令、切换撞脏工作区 → 指向「安全切分支」）、`stash@{n}` 编号解析与校验、新操作的 argv（单文件暂存/还原带 `--`、`show` 带 `--stat`、pull 的 rebase、commit 的 amend）、**数据型操作的 20 秒超时档** |
| `test/client.test.mjs` | 用假 window + 假 React 把客户端 bundle 求值一遍：bundle 格式与 id 正确；**只 require `react` 这一个种子模块**（多 require 别的就说明依赖了构建产物）；导出 `apply` + `inject: ['slots']`；`slots` 缺失 / 直接注册成功 / 稍后声明三种时机都不抛；注册失败会把真实原因回报；组件在 props 缺失时也能渲染（slot 契约变化不白屏）；点改动看 diff 能走到终态（用**有状态**的假 React 真重渲染，不会停在「加载中…」）；**切换工作区后命令结果栏 / diff / 状态都属于新工作区**（旧仓库的瞬时结果被清掉，切走之后才回来的操作结果被丢弃）；**「目录跟随会话」用的是真实形状的 `SessionListState`**（当前会话 = `retainedBy.mainView > 0` 的那一行，假 store 刻意没有 `current` 字段）：切到另一个会话要跟着换目录、没有当前会话时退回宿主缺省目录、手动切过目录后不被覆盖；网络加速设置块能展开、能保存、检测结果能列出，且网络失败时会自动展开；**「管理」里能看到远端分支**，点「拿成新分支」POST 的是带 `remote`/`branch` 的 `adoptRemote`（不是按当前分支名去猜），点远端分支不会触发 checkout；**默认分支有独立徽章、名字截断后悬停出完整 ref、分组顶部有「远端默认分支：…」提示行**（defaultRef 缺失时用宿主的 defaults，回归：默认标记曾写在名字字符串里、一截断就消失，tooltip 也不带 ref）；**宿主的 `notice` 会显示出来**（回归：宿主算了却没人读）；**改动被截断时会写明「还有 N 处未显示」**，胶囊用 `changesTotal` 而不是列表长度；**数据型操作带 `noState`，`state:null` 不会抹掉面板状态**；**远程地址能推导成网页地址时，「远程」行出现「仓库页 ↗」外链**（`<a target=_blank>` 纯跳转、不发任何 op；本地路径推导不出、或老宿主没回 `pageUrl` 字段时，绝不渲染死链）；**换工作区会收起分支管理器、清掉远程地址草稿**（reducer 的 `'reset-repo'`，回归：曾漏掉 `branchDraft`/`dirDraft`）；**数组子节点都必须带 key**（遍历假 React 元素树断言，回归：真实 React 会对 `GitPanel` 的 children 打 key 警告，而假 React 不检查）；**新增交互都要把正确的 op 与参数交给宿主**：单文件「暂存 / 取消暂存 / 还原」（还原只出现在工作区确有改动的行上、且要确认）、点最近提交发 `show` 并渲染详情、stash 备份展开/恢复/删除（删除要确认、`ref` 原样回传）、脏工作区点分支名改发 `stashSwitch`（不再发会被 git 拒绝的裸 `checkout`）、「提交并推送」是提交成功后两步且 amend 要带进请求、变基与浅克隆两个开关进对应请求、宽度与折叠态从 localStorage 恢复（越界回退默认值）、窗口 focus 触发**静默**刷新（不点亮「同步中…」）|
| `test/network.test.mjs` | 网络加速整条链路：配置归一化（含「只打开开关就该生效」这个踩过的坑）、`insteadOf` 的 base 拼法、push 不走镜像、`noMirror` 回退参数、凭据打码（GET 视图 / 命令回显 / 工具输出三处都不能漏）、失败分类（用户那条真实报错要认出来，404 不能被当成网络问题）、配置落盘与合并、`/git-panel/net` 三种方法 + 跨站拒绝 + 打码串回传语义；最后用**假 git 放到 PATH 最前面**离线复现「镜像挂、直连通」，验证自动回退确实发生、且结果栏会说明这件事；`/git-panel/log` 路由返回最近日志行；**会话令牌**：GET 发放、没带/带错令牌的 POST 一律 403、带对才放行；**直连探测显式清掉全局代理**（`-c http.proxy=`） |

> 这几个文件是**换机器、换 DSH 版本时的第一道回归**：`npm test` 过了，说明插件
> 自身的加载与注册契约没变；剩下的只是 DSH 侧服务是否提供（缺了就优雅降级）。
> 网络加速那部分刻意全部做成**离线**验证：真的去连 github 会让测试结果随网络环境
> 变化，那种测试在有网和没网的机器上给出的信号完全不同。

### 装进 DSH 之后的验证层次

`npm test` 之外，还有两层只有在**真的跑起来**之后才存在的信号。0.10 的两次重构各靠一层
抓到了「本地全绿但实际不能用」的问题，所以这里明确写下来：

| 层次 | 怎么跑 | 能抓到什么（`npm test` 抓不到的） |
| --- | --- | --- |
| 真 git 端到端 | 直接调路由 handler / `tools.register` 注册出来的 `execute`，在**临时仓库**里跑真实 git（`git init` → 提交 → 分支 → 推送 → 克隆 → 拉取） | `runGit` 真的能不能执行（0.10 拆分时 `execFileAsync` 被漏掉、`runGit` 每次返回 `code:-1`，143 个用例仍全绿 —— 因为能覆盖它的用例在受限沙箱里被跳过了）；注入的 `-c` 参数 git 认不认；真实 porcelain 输出与解析器是否对得上 |
| 真 React 渲染 | 用 DSH 自带的那份 React + jsdom 把客户端 bundle 真渲染一遍 | 假 React 检查不出来的东西：list 的 `key` 警告、`useSyncExternalStore` 订阅是否真的会触发重渲染 |
| 运行中的宿主 HTTP 冒烟 | 对**已经在跑的** dsh 打真实请求（`/git-panel/state`、`/op`、`/net`、`/log`、`/help`，含 400/403/405 与危险参数被挡在 git 之外），并在启动目录的 `git-panel.log` 里核对留痕 | 「磁盘上是新代码、进程里跑的是旧代码」这件事本身；只有真实进程才有的响应形状（0.10.1 的两个文案缺陷就是这样发现的：敲错目录被报成「未检测到 git」、非仓库显示 git 英文原文） |

> 宿主半边**不会**热重载：改了 `lib/*.js` 要重启 dsh 才生效（客户端半边会随页面重载）。
> 重启前刷新页面会拿新客户端配旧宿主，`branches` 这类契约变更期间会看到空列表 ——
> 先重启、再刷新。

## License

MIT
