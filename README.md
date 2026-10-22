# pi-copilot-gpt-compact

Pi 的 GitHub Copilot GPT 提前压缩插件，**默认开启**，可以手动关闭，开关跨会话保存。

已在 Pi **1.4.0** 上测试。

## 安装

直接从 GitHub 安装，无需发布到 npm：

```bash
pi install git:github.com/elemount/pi-copilot-gpt-compact
```

正在运行的 Pi 执行 `/reload`，或重新启动。更新时执行：

```bash
pi update git:github.com/elemount/pi-copilot-gpt-compact
```

如需固定经过审查的版本，可在 git 地址后加 `@<完整 commit SHA>`；固定的 commit 不会随更新漂移。

Pi extension 在宿主进程内运行，拥有当前用户权限，请仅安装信任的代码。本插件没有外部运行时依赖或安装脚本，宿主提供的 Pi 模块仅声明为 peer dependencies，不会打包或复制宿主模块。`package.json` 中保留 `private: true`，防止误发布到 npm。

## 开关

```text
/copilot-compact           查看状态和实际压缩阈值
/copilot-compact status    查看状态和实际压缩阈值
/copilot-compact off       关闭提前压缩，恢复原始模型窗口
/copilot-compact on        开启提前压缩
/copilot-compact toggle    切换开关
```

开关保存在 `<agent-dir>/copilot-gpt-compact.json`，默认路径为
`~/.pi/agent/copilot-gpt-compact.json`。没有配置文件时默认开启；首次使用无需额外设置。
`PI_CODING_AGENT_DIR` 设置了其他 agent 目录时，配置跟随该目录。

关闭的是本插件的**提前压缩策略**，不是 Pi 原生自动压缩。窗口接近模型原始上限时，Pi 仍会按原来的配置压缩。

## 工作原理

- 仅针对 provider 为 `github-copilot`、ID 以 `gpt-` / `gpt` 加数字开头的聊天模型。
- 将有效上下文窗口限制为 `min(原窗口, 272000)` tokens，小窗口不会被扩大。
- **不自己调用 `ctx.compact()`**，而是让 Pi 原生的自动压缩在新输入前、工具调用之间和回合结束时进行检查。这样不会为了压缩而中断任务，压缩后仍按 Pi 的正常调度继续。
- 使用 Pi 的 `reserveTokens`，默认 `16384`。因此窗口为 `272000` 时，触发条件是 `contextTokens > 255616`，在 272k 之前留出余量。
- 自定义 `compaction.reserveTokens` 或模型级 reserve 会改变实际阈值，命令的 status 会显示当前阈值。
- 保留原 provider 的认证、OAuth、流式请求、模型发现和刷新逻辑；不写入 `auth.json`、`models.json`，也不修改全局压缩参数。
- 切换模型（包括 scoped-model 快照）后仍然生效；其他 provider、Copilot 的 Claude/Gemini、图片和分类模型不受影响。

### 注意

这是**有效窗口上限**策略，Pi 底部会按限制后的窗口计算使用率；原生输出预算也会受该窗口约束。

如果在 `/settings` 中关闭了 Pi 原生自动压缩，插件会尊重这个设置，不会强行开启。状态显示 `paused`。

显式 `models.json` 窗口覆盖或其他重新注册 Copilot provider 的插件可能优先于本插件；当前模型未应用上限时，启动会提示警告。避免让多个插件同时负责同一个 provider 的窗口设置。

压缩按 Pi 的安全检查边界进行，不是逐 token 的硬限制。一次巨大的输入或工具结果仍可能越过预留区间，压缩本身也可能因 provider 错误失败。`reserveTokens: 0` 会取消原生预留量，不建议用于此策略。

## 本地开发与测试

```bash
mkdir -p ~/repos
git clone https://github.com/elemount/pi-copilot-gpt-compact.git ~/repos/pi-copilot-gpt-compact
cd ~/repos/pi-copilot-gpt-compact
pi -e ./index.ts
```

如果已经从 git 安装，调试时可用 `pi --no-extensions -e ./index.ts` 避免重复加载。也可以用 `pi install ~/repos/pi-copilot-gpt-compact` 安装本地源码；不要同时保留 git 和本地两种安装来源。

开发环境需要能解析 peer dependencies（与宿主 Pi 相同版本的 `@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent`）。

```bash
PI_OFFLINE=1 npm test
```

测试不需要真实凭据，不发送模型请求，包括默认开启、开关持久化、模型范围、原窗口恢复、动态模型刷新，以及真实 Pi SDK 中的工具调用 → 原生压缩 → 自动继续。
