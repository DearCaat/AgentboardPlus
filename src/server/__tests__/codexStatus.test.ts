import { describe, expect, test } from 'bun:test'
import { codexFooterSessionId, codexStatusSessionId } from '../codexStatus'

const session = '01234567-abcd-7890-9234-9876543210ab'
const otherSession = '01234568-abcd-7890-9234-9876543210ab'
const card = (id: string) => [
  '/status',
  '',
  '  >_ OpenAI Codex (v0.171.0)',
  '',
  '  Model:               gpt-5.4',
  '  Directory:           /app',
  '  Session:             ' + id,
  '',
  '  Token usage:         0 total (0 input + 0 output)',
  '› /status      show current session configuration and token usage',
].join('\n')

describe('Codex status session ID', () => {
  test('uses the last submitted card and returns the full UUID', () => {
    expect(codexStatusSessionId(card(otherSession) + '\n' + card(session))).toBe(session)
  })

  test('reads a status card from a version with a border', () => {
    const output = '› /status\n╭────────╮\n' + card(session).split('\n').slice(2, 7)
      .map((line) => '│' + line + '  │').join('\n') + '\n╰────────╯'
    expect(codexStatusSessionId(output)).toBe(session)
  })

  test('allows /status to remain in the composer after rendering the card', () => {
    expect(codexStatusSessionId(card(session) + '\n› /status')).toBe(session)
  })

  test('rejects transcript IDs, incomplete cards and ambiguous session rows', () => {
    expect(codexStatusSessionId('Session: ' + session)).toBeUndefined()
    expect(codexStatusSessionId(card(session.slice(0, -1)))).toBeUndefined()
    expect(codexStatusSessionId('› /status')).toBeUndefined()
    expect(codexStatusSessionId(card(session).replace('  Session:', '  Session: ' + otherSession + '\n  Session:'))).toBeUndefined()
  })
})

describe('Codex status line thread ID', () => {
  test('reads a full ID from the native footer below the composer', () => {
    expect(codexFooterSessionId('› Ask Codex to do anything\n\x20\x20gpt-5.4 · ' + session + '\n  ← for agents · ? for shortcuts\n')).toBe(session)
    expect(codexFooterSessionId('› Ask Codex to do anything\n  ' + session + '\n  ? for shortcuts')).toBe(session)
  })

  test('ignores IDs in conversation history, draft and ambiguous footers', () => {
    expect(codexFooterSessionId('  gpt-5.4 · ' + session + '\n› Draft\n  ? for shortcuts')).toBeUndefined()
    expect(codexFooterSessionId('› ' + session + '\n  ' + session + ' · ' + otherSession)).toBeUndefined()
    expect(codexFooterSessionId('› Draft\n  gpt-5.4 · ' + session.slice(0, -1))).toBeUndefined()
  })
})
