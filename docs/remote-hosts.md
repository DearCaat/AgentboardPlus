# Remote hosts

Agentboard can show tmux sessions from other machines next to your local ones. It reaches each machine over SSH, so the remote machine needs no Agentboard install.

## Requirements

- `ssh` on the Agentboard host.
- Key-based SSH access to each remote host that works without a prompt. Agentboard runs `ssh` with `BatchMode=yes`, so a host that asks for a password or passphrase fails.
- `tmux` on each remote host.

## Enable remote hosts

1. Confirm that SSH works without a prompt:

   ```bash
   ssh -o BatchMode=yes mba tmux list-windows -a
   ```

2. Start Agentboard with the host list:

   ```bash
   AGENTBOARD_REMOTE_HOSTS=mba,carbon agentboard
   ```

Remote sessions appear in the session list with a host badge. Agentboard infers live activity from pane content over SSH. When session discovery fails, the last known sessions stay visible with an **Offline** badge, including after an Agentboard restart. The next successful discovery refreshes the list. Use the filter button to show or hide hosts.

`AGENTBOARD_REMOTE_HOSTS` accepts plain hostnames only. A value such as `user@host` or `host:2222` is dropped with a warning. To set a user or port, define a host alias in `~/.ssh/config` and list the alias.

With AGENTBOARD_REMOTE_ALLOW_ADD_HOSTS=true, open the **+** dialog and select **Add Server**. Enter an existing SSH alias or hostname. Agentboard checks that SSH can run tmux and stores the host in its database. Configure SSH users, ports and keys on the Agentboard machine.

## Choose what the UI can do

By default, remote sessions are listed with their status, but you cannot open their terminal. Two variables widen that.

| Setting | Listed with status | Open the terminal, type, resize | Create, kill, rename |
| --- | --- | --- | --- |
| Default | Yes | No | No |
| `AGENTBOARD_REMOTE_ALLOW_ATTACH=true` | Yes | Yes | No |
| `AGENTBOARD_REMOTE_ALLOW_CONTROL=true` | Yes | Yes | Yes |

Only the exact value `true` enables either variable. `AGENTBOARD_REMOTE_ALLOW_CONTROL=true` also enables attach, unless you set `AGENTBOARD_REMOTE_ALLOW_ATTACH` explicitly.

The **New Terminal** dialog can create a named tmux session with a shell on the local machine or on a host with attach access. With control enabled, the **Agent Session** dialog has a host picker. Agentboard creates remote sessions as windows in the remote tmux session named `TMUX_SESSION` (default `agentboard`). Kill and rename work only for windows in that session. Windows in other remote tmux sessions cannot be killed or renamed.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTBOARD_REMOTE_HOSTS` | unset | Comma-separated SSH hosts. Names that are not valid hostnames are dropped with a warning. |
| `AGENTBOARD_REMOTE_ALLOW_ATTACH` | follows `ALLOW_CONTROL` | Set `true` to allow terminal input, resize, and copy-mode on remote sessions. |
| `AGENTBOARD_REMOTE_ALLOW_CONTROL` | `false` | Set `true` to allow create, kill, and rename on remote hosts. |
| `AGENTBOARD_REMOTE_POLL_MS` | `2000` | Interval between polls of each host. |
| `AGENTBOARD_REMOTE_TIMEOUT_MS` | `4000` | Timeout for each SSH command of a status poll, and for the tmux commands that an open remote terminal runs. A poll runs two commands, one to list windows and one to read pane content, so a poll can take up to twice this value. Create, kill, and rename use a fixed 10 seconds. |
| `AGENTBOARD_REMOTE_STALE_MS` | 3 × poll interval, minimum `15000` | Maximum age of a host status before it is marked offline. The last known sessions stay visible until discovery succeeds again. |
| `AGENTBOARD_REMOTE_SSH_OPTS` | unset | Extra `ssh` options, space-separated. |
| `AGENTBOARD_HOST` | machine hostname | Label for the local host. |

Agentboard always passes `-o BatchMode=yes -o ConnectTimeout=3`. You do not need to add them to `AGENTBOARD_REMOTE_SSH_OPTS`.

## Share remote sessions

A shared token sees remote tmux sessions that it created or that the site administrator assigned to it. The token also needs access to the server. The site administrator sees all discovered sessions and can assign an existing independent remote tmux session to one token at a time in **Tokens → Session access**. All windows within that tmux session follow its assignment. Sessions without an assignment are visible to the administrator alone.

This scope applies to AgentBoard lists, terminals and close requests. An interactive shell runs with the permissions of the configured SSH account. Use separate OS accounts with separate SSH aliases when users need isolation from one another inside the shell.

## Save a remote workspace

Open **Presets → Save current workspace**, enter a name, and select the terminals to restore. AgentboardPlus saves the layout, host, tmux name, working directory, harness, and conversation ID. Enter the conversation ID for a remote agent if it is unavailable in the form.

**Save** and **Load** use the board’s existing session list and saved layout. Selecting a terminal opens its connection. To explicitly recreate unavailable terminals in the active workspace, select **Restore missing sessions**. A missing agent terminal starts the configured resume command on the saved SSH host when it has a supported harness and conversation ID. Remote Pi and OMP sessions need a transcript path when their resume command uses one, so they remain pending with the default configuration. A shell terminal reopens in the saved directory.

The workspace picker switches between open workspaces and preserves their layouts. The terminal currently open in the browser stays connected when you switch. If a host is unavailable, **Restore missing sessions** reports the failure and keeps the terminal in the preset for a later retry.

## Switch between remote hosts

With the terminal relay enabled, each browser terminal keeps a separate SSH channel and screen state for every remote tmux window it opens. Returning to an open window displays its current screen from the relay and resumes input over the existing channel. Background channels stop contributing to terminal sizing. The relay releases a channel when its window disappears or the browser's terminal lease expires.

## Reuse SSH connections

On Unix, AgentboardPlus uses OpenSSH multiplexing for polls, remote commands, and terminal channels. Requests for the same SSH host alias, user, and connection options reuse the same authenticated connection. The SSH master stays available for ten minutes after its last channel closes. This also applies to newly configured hosts and preserves their SSH proxy settings.

Set `AGENTBOARD_REMOTE_SSH_MULTIPLEX=0` to use your own SSH multiplexing settings. Extra options in `AGENTBOARD_REMOTE_SSH_OPTS` take precedence over the defaults.

With the terminal relay enabled, refreshing a browser tab can reclaim its terminal channels for up to 60 seconds after losing the WebSocket. A new tab opens its own terminal channels using the same SSH transport.

## Paste images into remote sessions

With interactive attach enabled, paste a PNG, JPEG, GIF, or WebP screenshot into the active remote terminal. AgentboardPlus writes it to a private temporary directory on the selected host and inserts the path into the prompt. Press Enter when you are ready to submit.

## Limits

Agentboard does not read agent transcripts on remote hosts. Remote sessions do not have these features:

- The last prompt, pull requests, the media rail, and subagent activity.
- Hibernate, Wake, and History.
- Session recovery. The recovery catalog covers local sessions only.
- Uploads of files other than supported images.
- Copy from the tmux paste buffer to the browser clipboard.
