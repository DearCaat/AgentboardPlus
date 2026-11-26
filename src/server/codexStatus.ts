const statusCommand = /^(?:[›❯>]\s*)?\/status$/
const codexTitle = /^(?:>_\s*)?OpenAI Codex(?: \([^)]+\))?$/
const sessionRow = /^Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export function codexStatusSessionId(pane: string) {
  const lines = pane.split('\n').map((line) => line.trim())
    .filter((line) => !/^[╭╰]─+[╮╯]$/.test(line))
    .map((line) => line.replace(/^│|│$/g, '').trim())
    .filter(Boolean)
  // Codex can leave /status in the composer after rendering the result.
  // Match the most recent command that starts a visible status card.
  const command = lines.findLastIndex((line, index) =>
    statusCommand.test(line) && codexTitle.test(lines[index + 1] ?? ''))
  if (command < 0) return
  const end = lines.findIndex((line, index) => index > command + 1 && /^[›❯]/.test(line))
  const card = lines.slice(command + 2, end < 0 ? lines.length : end)
  if (!card.some((line) => /^Model:\s+/.test(line)) ||
      !card.some((line) => /^Directory:\s+/.test(line))) return

  const sessionLines = card.filter((line) => line.startsWith('Session:'))
  if (sessionLines.length === 1) return sessionRow.exec(sessionLines[0])?.[1]
}

const threadUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function codexFooterSessionId(pane: string) {
  const lines = pane.split('\n').filter(line => line.trim())
  const composer = lines.findLastIndex(line => /^\s*[›❯](?:\s|$)/.test(line))
  if (composer < 0 || composer < lines.length - 8) return
  const footer = lines.slice(composer + 1).filter(line => /^\s{2,}\S/.test(line))
  const ids = footer.flatMap(line => line.trim().split(/\s+·\s+/).filter(part => threadUuid.test(part)))
  if (ids.length === 1) return ids[0]
}
