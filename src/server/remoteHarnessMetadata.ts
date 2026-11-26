import { shellQuote } from './shellQuote'
import type { Session } from '../shared/types'

const harnessProbe = String.raw`
import datetime
import json
import os
import re
import signal
import sqlite3
import stat
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

# The terminal catalog still works if optional identity collection times out.
signal.alarm(2)
uuid = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
pane_key = re.compile(r"[0-9]+:@[0-9]+:[0-9]+")
linux = sys.platform.startswith("linux")
machine_id = ""
if linux:
    for candidate in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            machine_id = Path(candidate).read_text().strip()
        except OSError:
            continue
        if machine_id:
            break

def processes():
    rows = subprocess.check_output(
        ["ps", "-axo", "pid=,ppid=,lstart=,comm="],
        env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
        text=True, errors="replace", timeout=1,
    )
    snapshot = {}
    children = defaultdict(list)
    for row in rows.splitlines():
        fields = row.split(None, 7)
        if len(fields) != 8:
            continue
        pid, parent = map(int, fields[:2])
        snapshot[pid] = (parent, " ".join(fields[2:7]), os.path.basename(fields[7]))
        children[parent].append(pid)
    return snapshot, children

def latest_response(config, cwd, session_id):
    if not isinstance(cwd, str) or not cwd.startswith("/"):
        return None
    slug = re.sub(r"[^A-Za-z0-9-]", "-", cwd)
    path = Path(config) / "projects" / slug / (session_id + ".jsonl")
    return response_from_transcript(path, session_id)

def response_from_transcript(path, session_id):
    try:
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                return None
            offset = max(0, info.st_size - 2 * 1024 * 1024)
            stream.seek(offset)
            lines = stream.read(2 * 1024 * 1024).split(b"\n")
            if offset:
                lines = lines[1:]
        for line in reversed(lines):
            try:
                entry = json.loads(line)
                if entry.get("type") == "response_item":
                    message = entry["payload"]
                    if (message.get("type") != "message" or message.get("role") != "assistant"
                        or message.get("phase") == "commentary"):
                        continue
                    text_type = "output_text"
                elif (entry.get("type") == "assistant" and entry.get("sessionId") == session_id
                      and not entry.get("isSidechain")):
                    message = entry["message"]
                    text_type = "text"
                else:
                    continue
                if not any(isinstance(block, dict) and block.get("type") == text_type
                           and isinstance(block.get("text"), str) and block["text"].strip()
                           for block in message["content"]):
                    continue
                timestamp = entry["timestamp"]
                if datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).tzinfo:
                    return timestamp
            except (TypeError, ValueError, AttributeError, KeyError):
                continue
    except OSError:
        pass
    return None

def codex_response(pid, session_id):
    base = os.environ.get("CODEX_SQLITE_HOME") or os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    try:
        if linux:
            proc = Path("/proc") / str(pid)
            with (proc / "environ").open("rb") as stream:
                codex_vars = (b"CODEX_SQLITE_HOME=", b"CODEX_HOME=")
                values = dict(item.split(b"=", 1) for item in stream.read(1024 * 1024).split(b"\0")
                              if item.startswith(codex_vars))
            configured = values.get(b"CODEX_SQLITE_HOME") or values.get(b"CODEX_HOME")
            if configured:
                base = os.fsdecode(configured)
                if not Path(base).is_absolute():
                    base = Path(os.readlink(proc / "cwd")) / base
        database = Path(base) / "state_5.sqlite"
        con = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.05)
        try:
            row = con.execute("SELECT rollout_path FROM threads WHERE id = ?", (session_id,)).fetchone()
        finally:
            con.close()
        if row:
            path = Path(row[0])
            if path.is_absolute() and path.name.endswith("-" + session_id + ".jsonl"):
                return response_from_transcript(path, session_id)
    except (OSError, TypeError, ValueError, sqlite3.Error):
        pass
    return None

def process_registry(pid, started):
    config = os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")
    proc = Path("/proc") / str(pid)
    try:
        if linux:
            # Use the process's own configuration, including custom homes.
            with (proc / "environ").open("rb") as stream:
                env = stream.read(1024 * 1024).split(b"\0")
            for item in env:
                if item.startswith(b"CLAUDE_CONFIG_DIR=") and item[18:]:
                    config = os.fsdecode(item[18:])
                    break
            if not Path(config).is_absolute():
                config = Path(os.readlink(proc / "cwd")) / config
        registry = Path(config) / "sessions" / (str(pid) + ".json")
        with os.fdopen(os.open(registry, os.O_RDONLY | os.O_NONBLOCK), "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return None
            record = json.loads(stream.read(65536))
        if linux:
            # Linux records starttime in clock ticks within the PID namespace.
            started = (proc / "stat").read_text().rsplit(")", 1)[1].split()[19]
            domain = "linux:" + machine_id + ":" + os.readlink(proc / "ns/pid")
        else:
            domain = "darwin"
        if (record.get("pid") != pid or record.get("kind") != "interactive"
            or record.get("entrypoint") != "cli" or record.get("pidDomain") != domain
            or not isinstance(record.get("version"), str) or not record["version"].startswith("2.")
            or " ".join(str(record.get("procStart", "")).split()) != started):
            return None
        session_id = record.get("sessionId")
        if record.get("parkedJobId") or not isinstance(session_id, str) or not uuid.fullmatch(session_id):
            session_id = None
        return (session_id, config, record.get("cwd"))
    except (OSError, ValueError, IndexError, AttributeError):
        return None

def claude_root(pane_pid, snapshot, records):
    rows, children = snapshot
    pending = [pane_pid]
    registered = []
    named = []
    while pending:
        pid = pending.pop()
        row = rows.get(pid)
        if not row:
            continue
        if pid not in records:
            records[pid] = process_registry(pid, row[1])
        record = records[pid]
        if record is not None:
            # Native records identify versioned binaries and renamed launchers.
            registered.append((pid, *record))
        else:
            if row[2] in ("claude", "claude-rp"):
                named.append((pid, None, None, None))
            pending.extend(children.get(pid, ()))
    roots = registered or named
    return roots[0] if len(roots) == 1 else None

expected_panes = set(json.loads(sys.argv[1]))
panes = {line.strip() for line in sys.stdin if line.strip() in expected_panes and pane_key.fullmatch(line.strip())}
if not panes:
    sys.exit()
before = processes()
records = {}
selected = {}
for pane in panes:
    pane_pid = int(pane.rsplit(":", 1)[1])
    root = claude_root(pane_pid, before, records)
    if root:
        selected[pane] = (pane_pid, *root)
codex_panes = json.loads(sys.argv[2])
if not selected and not codex_panes:
    sys.exit()
after = processes()
final_records = {}
identities = {}
for pane, (pane_pid, pid, session_id, config, cwd) in selected.items():
    if (before[0][pane_pid] == after[0].get(pane_pid)
        and before[0][pid] == after[0].get(pid)):
        current = claude_root(pane_pid, after, final_records)
        if current and current[0] == pid:
            if (session_id, config, cwd) != current[1:]:
                session_id = None
            response = latest_response(config, cwd, session_id) if session_id else None
            identities[pane] = {"pid": pid, "sessionId": session_id, "lastResponseAt": response}

# If unrelated Claude roots claim the same ID, keep only the harness label.
owners = defaultdict(set)
for item in identities.values():
    if item["sessionId"]:
        owners[item["sessionId"]].add(item["pid"])
for pane, item in identities.items():
    if len(owners[item["sessionId"]]) > 1:
        item["sessionId"] = None
        item["lastResponseAt"] = None
result = {pane: {"sessionId": item["sessionId"], "lastResponseAt": item["lastResponseAt"]}
          for pane, item in identities.items()}
for pane, session_id in codex_panes.items():
    if pane not in panes or not isinstance(session_id, str) or not uuid.fullmatch(session_id):
        continue
    pane_pid = int(pane.rsplit(":", 1)[1])
    root = before[0].get(pane_pid)
    if not root or root != after[0].get(pane_pid):
        continue
    pending = [pane_pid]
    roots = []
    while pending:
        pid = pending.pop()
        process = before[0].get(pid)
        if not process:
            continue
        if process[2] == "codex":
            if process == after[0].get(pid):
                roots.append(pid)
        else:
            pending.extend(before[1].get(pid, ()))
    if len(roots) == 1:
        result[pane] = {"sessionId": session_id, "lastResponseAt": codex_response(roots[0], session_id)}
print(json.dumps(result))
`

/** Run the optional read-only probe after the existing batched captures. */
export function remoteHarnessProbeCommand(marker: string, paneKeys: Iterable<string>, codexIds: Record<string, string> = {}): string {
  const keys = shellQuote(JSON.stringify([...new Set(paneKeys)]))
  return `if command -v python3 >/dev/null 2>&1; then printf '%s\\n' ${shellQuote(marker)}; ` +
    `tmux -u list-windows -a -F '#{pid}:#{window_id}:#{pane_pid}' | python3 -c ${shellQuote(harnessProbe)} ${keys} ${shellQuote(JSON.stringify(codexIds))} 2>/dev/null || true; fi`
}

export function applyRemoteHarnessMetadata(sessions: Session[], paneKeys: Map<string, string>, payload: string): void {
  let identities: Record<string, unknown>
  try {
    identities = JSON.parse(payload)
  } catch {
    return
  }
  if (!identities || typeof identities !== 'object') return
  for (const session of sessions) {
    const pane = paneKeys.get(session.id)
    if (!pane || !Object.hasOwn(identities, pane) ||
        (session.agentType && !['claude', 'claude-rp', 'codex'].includes(session.agentType))) continue
    const entry = identities[pane]
    if (entry !== null && typeof entry !== 'object') continue
    const { sessionId, lastResponseAt } = (entry ?? {}) as { sessionId?: unknown; lastResponseAt?: unknown }
    session.agentType ??= 'claude'
    if (session.agentType === 'codex' && session.agentSessionId !== sessionId) continue
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) continue
    session.agentSessionId = sessionId
    if (typeof lastResponseAt === 'string' && Number.isFinite(Date.parse(lastResponseAt))) {
      session.lastResponseAt = lastResponseAt
    }
  }
}
