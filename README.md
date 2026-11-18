# dsh-plugin

DeepSeek Harness（DSH）插件集合。

## 插件列表

| 插件 | 说明 |
|------|------|
| [session-git-branch](session-git-branch/) | 新建会话时可选 Git 分支，会话中随时看到当前分支 |

------

## session-git-branch

在新建会话行选分支，在输入框旁看当前分支。选分支会把**会话的工作目录**切到该分支的检出目录：已有 worktree 就直接进，没有就在 `.agents/worktrees` 下新建 linked worktree。项目本身的 HEAD 与未提交改动不受影响。

徽章直接读 `.git/HEAD` 与 refs 文件，不执行命令、不写会话日志，所以显示分支不占对话历史和 token。

详见 [session-git-branch/README.md](session-git-branch/README.md)。

### 安装

装到当前 profile 时，`install_bundle` 的 target 指向包目录：

```
~/Project/dsh-plugin/session-git-branch
```

本地安装是符号链接，改完代码刷新页面即可生效，无需重新安装。

### 自检

两套检查都跑在临时 Git 仓库上，不碰真实项目：

```bash
cd session-git-branch
node docs/check.mjs         # Host：列举、创建 worktree、进入已有 worktree、拒绝未知分支
node docs/check-client.mjs  # Client：HEAD、packed/loose refs、渲染、命令参数契约
```
