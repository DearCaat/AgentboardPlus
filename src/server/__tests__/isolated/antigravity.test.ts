// Regression cases for the CLI's SQLite catalog and off-transcript image store.
import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { antigravityDescendants, antigravityProjectPath, isAntigravityAuxiliaryFile } from '../../antigravityLogs'
import { materializeMedia, materializeMediaSync } from '../../antigravityMedia'
import { scanMediaFile } from '../../mediaIndexScan'
import { extractSessionMedia } from '../../mediaExtractor'
import { extractLastResponseTimestamp } from '../../logMatcher'

const root = fs.mkdtempSync(path.join(tmpdir(), 'agy-fixture-'))
process.env.AGENTBOARD_ANTIGRAVITY_HOME = root
const log = (id: string) => path.join(root, 'brain', id, '.system_generated/logs/transcript.jsonl')
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

test('follows committed child links, handles cycles and retains historical workspace evidence', () => {
  const db = new Database(path.join(root, 'conversation_summaries.db'))
  try {
    db.run('PRAGMA journal_mode=WAL')
    db.run('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, parent_conversation_id TEXT, agent_name TEXT)')
    const insert = db.query('INSERT INTO conversation_summaries VALUES(?, ?, ?, ?)')
    const parent = randomUUID(), child = randomUUID(), nested = randomUUID()
    const workspace = path.join(root, 'old project'), uris = JSON.stringify([pathToFileURL(workspace).href])
    insert.run(parent, uris, '', '')
    expect(antigravityProjectPath(parent)).toBe(workspace)
    expect(antigravityDescendants(log(parent), parent)).toEqual([])
    insert.run(child, uris, parent, 'research')
    insert.run(nested, uris, child, 'research')
    insert.run('../outside', uris, parent, '')
    expect(antigravityDescendants(log(parent), parent)).toEqual([log(child), log(nested)])
    expect(isAntigravityAuxiliaryFile(log(child))).toBe(true)
    expect(isAntigravityAuxiliaryFile(log(parent))).toBe(false)
    db.query('UPDATE conversation_summaries SET parent_conversation_id=? WHERE conversation_id=?').run(nested, parent)
    expect(antigravityDescendants(log(parent), parent)).toEqual([log(child), log(nested)])
  } finally { db.close() }
})

test('late image attachments are indexed and symlinks or foreign paths are ignored', async () => {
  const source = log(randomUUID()), dir = path.join(path.dirname(source), 'media')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  const image = path.join(dir, 'step_9_media_0.png')
  const record = (file: string) => JSON.stringify({ type: 'GENERIC', step_index: 9, source: 'MODEL', status: 'DONE',
    media: [{ mime_type: 'image/png', uri: pathToFileURL(file).href }] })
  const line = record(image)
  fs.writeFileSync(source, line + '\n')
  const state = scanMediaFile(source, undefined, () => {}, () => { throw Error('premature descriptor') })!
  fs.mkdirSync(dir)
  fs.writeFileSync(image, 'image fixture')
  const bytes: number[] = []
  scanMediaFile(source, state, () => {}, item => bytes.push(item.bytes!))
  expect(bytes).toEqual([13])
  const outside = path.join(root, 'unrelated.png')
  fs.writeFileSync(outside, 'private')
  fs.unlinkSync(image)
  fs.symlinkSync(outside, image)
  for (const text of [line, record(outside)]) {
    expect(await materializeMedia(source, text)).toBe(text)
    expect(materializeMediaSync(source, text)).toBe(text)
  }
})

test('only explicitly user-facing text artifacts become documents', () => {
  const record = (visible: boolean) => JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 2,
    tool_calls: [{ name: 'write_file', args: { ArtifactMetadata: JSON.stringify({ UserFacing: visible }),
      Content: JSON.stringify('# report'), Path: JSON.stringify('/workspace/report.md') } }] })
  expect(extractSessionMedia(record(false))).toEqual([])
  expect(extractSessionMedia(record(true))[0]).toMatchObject({ kind: 'document', bytes: 8, label: 'report.md' })
})

test('extractLastResponseTimestamp reads Antigravity MODEL PLANNER_RESPONSE created_at and skips tool-only/synthetic steps', () => {
  const source = log(randomUUID())
  fs.mkdirSync(path.dirname(source), { recursive: true })
  const replyAt = '2026-11-26T06:40:17Z'
  fs.writeFileSync(source, [
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-26T06:39:00Z', content: 'hello' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: replyAt, content: 'Here is the answer.' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-26T06:41:00Z', tool_calls: [{ name: 'read_file' }] },
    { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-26T06:42:00Z', synthetic_reason: 'auto', content: 'ignored' },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  expect(extractLastResponseTimestamp(source, 'antigravity')).toBe(replyAt)
})

test('antigravityProjectPath returns first file workspace URI when multiple workspaces exist', () => {
  const db = new Database(path.join(root, 'conversation_summaries.db'))
  try {
    const id = randomUUID()
    const ws1 = path.join(root, 'ws-one')
    const ws2 = path.join(root, 'ws-two')
    db.query('INSERT INTO conversation_summaries VALUES(?, ?, ?, ?)').run(
      id, JSON.stringify([pathToFileURL(ws1).href, pathToFileURL(ws2).href]), '', ''
    )
    expect(antigravityProjectPath(id)).toBe(ws1)
  } finally { db.close() }
})
