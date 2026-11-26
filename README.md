# AgentboardPlus

[简体中文](README.zh-CN.md)

AgentboardPlus is a browser dashboard for managing tmux sessions running coding agents such as Codex and Claude Code across local and SSH hosts.

**Upstream baseline** [Agentboard v0.48.2](https://github.com/gbasin/agentboard/releases/tag/v0.48.2). [Original upstream README](https://github.com/gbasin/agentboard/blob/v0.48.2/README.md) · [Upstream releases](https://github.com/gbasin/agentboard/releases)

## What AgentboardPlus adds

- **Workspaces and presets.** Name and color session groups, reorder groups and sessions, and switch saved layouts. Presets can restore eligible missing sessions.
- **Scoped sharing.** Give each access token its own set of remote tmux sessions, even when those sessions run on the same host.
- **Remote terminals.** Reuse SSH connections across polling, commands, and terminal tabs. Refresh a tab to reclaim its terminal channel within 60 seconds of disconnecting. Paste screenshots into SSH-backed sessions.
- **Session details.** See the harness and full session ID, copy the ID from the session menu, and see when the harness last responded when that timestamp is available.

## Run from source

Install Bun (see [.bun-version](.bun-version)) and tmux. On Linux, install a C++ toolchain and `make` if a native dependency needs to be built.

```sh
git clone https://github.com/DearCaat/AgentboardPlus.git
cd AgentboardPlus
bun install --frozen-lockfile
bun run build
HOSTNAME=localhost bun run start
```

Open [http://localhost:4040](http://localhost:4040).

[Configuration](docs/configuration.md) · [Remote hosts](docs/remote-hosts.md) · [MIT License](LICENSE)

Install [Gitleaks](https://github.com/gitleaks/gitleaks#installing) to enable the local pre-push scan.
