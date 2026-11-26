# AgentboardPlus

[English](README.md)

AgentboardPlus 是一个浏览器面板，用于管理本机和远程 SSH 主机上运行 Codex、Claude Code 等编程代理的 tmux 会话。

**当前上游基线** [Agentboard v0.48.2](https://github.com/gbasin/agentboard/releases/tag/v0.48.2)。[上游 README 原文](https://github.com/gbasin/agentboard/blob/v0.48.2/README.md) · [上游发布记录](https://github.com/gbasin/agentboard/releases)

## 相比上游增加的功能

- **工作区和预设。** 为会话组命名和设色，自由调整组与组内会话的顺序，保存并切换布局。预设可恢复符合条件的缺失会话。
- **按令牌共享。** 为不同访问令牌分别授权远程 tmux 会话，同一台主机上的会话也可以分别授权。
- **远程终端。** 轮询、远程命令和终端通道复用 SSH 连接。同一标签页在断线后 60 秒内刷新可接回原终端通道，也支持向 SSH 会话粘贴截图。
- **会话详情。** 查看 harness 和完整会话 ID，从会话菜单复制 ID，并在有记录时查看 harness 的最后响应时间。

## 从源码启动

安装 Bun（版本见 [.bun-version](.bun-version)）和 tmux。Linux 上如果需要编译原生依赖，请安装 C++ 工具链和 `make`。

```sh
git clone https://github.com/DearCaat/AgentboardPlus.git
cd AgentboardPlus
bun install --frozen-lockfile
bun run build
HOSTNAME=localhost bun run start
```

打开 [http://localhost:4040](http://localhost:4040)。

[配置说明](docs/configuration.md) · [远程主机](docs/remote-hosts.md) · [MIT 许可证](LICENSE)

安装 [Gitleaks](https://github.com/gitleaks/gitleaks#installing) 可启用本地推送前扫描。
