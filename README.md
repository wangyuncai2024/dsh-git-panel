# dsh-git-panel

DSH（DeepSeek Harness）Git 面板插件：在界面右下角提供一个**纯点击**的 Git 图形面板，
不需要记任何 git 命令；并在「设置 → 通用」里提供一个开关，随时控制面板显示与否。

## 功能

**右下角 Git 面板**

| 按钮 | 作用 |
| --- | --- |
| 初始化仓库 | 当前目录还不是仓库时，一键 `git init` |
| 克隆仓库 | 填入仓库地址，一键 `git clone` |
| 全部暂存 | `git add -A` |
| 提交 | 输入框写提交信息，一键 `git commit` |
| 拉取 / 推送 / 获取远程 | `git pull` / `git push` / `git fetch --all --prune` |
| 切换 / 刷新 | 换一个目录操作 / 重新读取状态 |

面板同时展示：当前分支、改动清单（文件级）、最近 8 次提交、每条命令的执行结果。
右上角「—」可把面板收起成一个小胶囊。

**设置开关**：设置 → 通用 → 「Git 面板」，一键开启/关闭。状态记在浏览器
`localStorage`（key: `dsh-git-panel-enabled`），默认开启。

**AI 也能用**：插件同时注册了 13 个 git 模型工具（`git_status`、`git_add`、
`git_commit`、`git_log`、`git_diff`、`git_branch`、`git_checkout`、`git_pull`、
`git_push`、`git_clone`、`git_init`、`git_remote`、`git_run`），装好后直接对
AI 说「帮我提交」即可。

## 安装（link 方式，本地开发）

```bash
# 1) link 安装：dsh plugin 会把依赖写进 profile 的 package.json，
#    并自动把 "dsh-git-panel" 登记进 dsh.profile.bundles（实测无需手改）
dsh plugin --profile web add link:/home/wangyuncai/DSH-project/GitHub插件

# 2) 重启 dsh 使新 bundle 生效（bundles 在启动时读取）
#    在运行 dsh 的终端按 Ctrl+C，然后重新执行：dsh web
```

> 提示：DSH 里安装任何插件都需要重启一次（官方插件市场安装完同样提示「待重启生效」）。
> 重启后浏览器刷新页面即可，会话记录不会丢失。

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

## License

MIT
