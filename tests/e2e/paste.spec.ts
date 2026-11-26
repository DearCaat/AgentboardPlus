// E2E: pasted multi-line text must be delivered as ONE bracketed paste (held
// for editing), never auto-submitted line-by-line. Regression test for the
// no-flicker/fullscreen auto-send bug: the REPL fixture enables bracketed
// paste BEFORE the browser attaches, so the browser xterm never sees ?2004h
// and the server-side tmux paste-buffer path is the only thing bracketing.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import type { ClientMessage } from '../../src/shared/types'

test.use({ viewport: { width: 1440, height: 900 } })

const WINDOW_NAME = 'paste-repl'
const REPL_PATH = fileURLToPath(new URL('./fixtures/paste-repl.py', import.meta.url))
const UNICODE_INPUT = 'áéíñü-你好-🚀'
const UNICODE_HEX =
  'c3a1c3a9c3adc3b1c3bc2de4bda0e5a5bd2df09f9a80'

function tmux(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout ?? '' }
}

function capturePane(target: string): string {
  return tmux(['capture-pane', '-t', target, '-p']).stdout
}

async function waitForPaneText(
  target: string,
  needle: string,
  timeoutMs = 10000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    content = capturePane(target)
    if (content.includes(needle)) return content
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)} in pane ${target}. Last content:\n${content}`
  )
}

test('multi-line text paste is held for editing, not auto-submitted', async ({ page }) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const target = `${session}:${WINDOW_NAME}`

  // Start the bracketed-paste REPL in a fresh window of the e2e session.
  // It enables ?2004h now — before the browser attaches — which is the exact
  // scenario where client-side bracketing (xterm terminal.paste) fails.
  const created = tmux([
    'new-window',
    '-t',
    session!,
    '-n',
    WINDOW_NAME,
    `python3 ${REPL_PATH}`,
  ])
  expect(created.status).toBe(0)

  try {
    await waitForPaneText(target, 'PASTE-REPL READY')

    // Attach to the REPL window through the real UI.
    await page.goto('/')
    const card = page.getByTestId('session-card').filter({ hasText: WINDOW_NAME }).first()
    await expect(card).toBeVisible({ timeout: 20000 })
    await card.click()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(card).toHaveClass(/selected/)
    await expect(page.getByTestId('terminal-recovery-status')).toHaveCount(0)
    await expect(page.locator('button[aria-label="Paste"]')).toBeEnabled()

    // Synthesize a real paste: modifier+V keydown on the xterm helper
    // textarea, then a ClipboardEvent carrying multi-line text/plain (the
    // capture-phase listener reads clipboardData synchronously).
    await page.evaluate(() => {
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      const isMac = /Mac/.test(navigator.platform)
      textarea.focus()
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'v',
          code: 'KeyV',
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true,
        })
      )
      const dt = new DataTransfer()
      dt.setData('text/plain', 'e2e_alpha\ne2e_beta')
      textarea.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      )
    })

    // The paste must arrive as ONE held bracketed paste (newlines rendered
    // as '|' by the fixture) with nothing submitted.
    const afterPaste = await waitForPaneText(target, 'HELD:e2e_alpha|e2e_beta')
    expect(afterPaste).not.toContain('SUBMITTED:')

    // An explicit Enter still submits the held buffer.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Enter')
    await waitForPaneText(target, 'SUBMITTED:e2e_alpha|e2e_beta')

    // IME and predictive keyboards commit characters through the browser's
    // text-input path. Verify they reach the pane as exact UTF-8 bytes.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.insertText(UNICODE_INPUT)
    await page.keyboard.press('Enter')
    await waitForPaneText(target, `INPUT_HEX:${UNICODE_HEX}`)
  } finally {
    tmux(['kill-window', '-t', target])
  }
})

test('Windows IME commits Chinese after pasting with prior text in the input field', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Uses Chromium IME events')
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const name = 'paste-windows-ime'
  const target = `${session}:${name}`
  const inputs: string[] = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    const message = JSON.parse(String(frame.payload)) as ClientMessage
    if (message.type === 'terminal-input') inputs.push(message.data)
  }))
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }))
  expect(tmux(['new-window', '-t', session!, '-n', name, `python3 ${REPL_PATH}`]).status).toBe(0)
  try {
    await waitForPaneText(target, 'PASTE-REPL READY')
    await page.goto('/')
    const card = page.getByTestId('session-card').filter({ hasText: name }).first()
    await card.click()
    await expect(card).toHaveClass(/selected/)
    await expect(page.locator('button[aria-label="Paste"]')).toBeEnabled()
    const input = page.locator('.xterm-helper-textarea')
    await input.focus()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '之前', selectionStart: 2, selectionEnd: 2 })
    await cdp.send('Input.insertText', { text: '之前' })
    await expect.poll(() => inputs.join('')).toBe('之前')
    await expect(input).toHaveValue('之前')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(() => navigator.clipboard.writeText('paste '))
    await page.keyboard.press('Control+V')
    await waitForPaneText(target, 'HELD:paste')
    await expect(input).toBeFocused()
    await input.evaluate(element => {
      const field = element as HTMLTextAreaElement
      // Replay Microsoft Pinyin's whole-field replacement while composing.
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      field.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你好', bubbles: true }))
      field.value = '你好'
      field.dispatchEvent(new InputEvent('input', { data: '你好', inputType: 'insertCompositionText', isComposing: true, bubbles: true }))
      field.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }))
    })
    await expect.poll(() => inputs.join('')).toBe('之前你好')
    await expect(input).toHaveValue('你好')
    await input.evaluate(element => {
      const field = element as HTMLTextAreaElement
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true, bubbles: true, cancelable: true,
      }))
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', ' followup ')
      field.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
      field.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }))
    })
    await waitForPaneText(target, 'HELD: followup')
    await expect(input).toHaveValue('')
    await input.evaluate(element => {
      const field = element as HTMLTextAreaElement
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      field.dispatchEvent(new CompositionEvent('compositionupdate', { data: '继续', bubbles: true }))
      field.value = '继续'
      field.dispatchEvent(new InputEvent('input', { data: '继续', inputType: 'insertCompositionText', isComposing: true, bubbles: true }))
      field.dispatchEvent(new CompositionEvent('compositionend', { data: '继续', bubbles: true }))
    })
    await expect.poll(() => inputs.join('')).toBe('之前你好继续')
    await page.keyboard.press('Enter')
    await waitForPaneText(target, 'SUBMITTED:之前paste 你好 followup 继续')
    await cdp.detach()
  } finally {
    tmux(['kill-window', '-t', target])
  }
})
