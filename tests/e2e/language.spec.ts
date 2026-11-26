import { expect, test } from '@playwright/test'

test('switches the web interface language and remembers it after reload', async ({ page }) => {
  await page.goto('/')
  const sidebar = page.locator('aside:not(.session-drawer aside)')
  const settings = sidebar.getByRole('button', { name: 'Settings', exact: true })
  await settings.click()
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN')

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '外观', exact: true })).toBeVisible()

  // Verify settings rows in Session list and Terminal tabs are localized
  await page.getByRole('tab', { name: '会话列表', exact: true }).click()
  await expect(
    page.getByText('显示最近 N 小时（1–168）的历史会话，最多保留最近 100 条。默认 24 小时。')
  ).toBeVisible()

  await page.getByRole('tab', { name: '终端', exact: true }).click()
  await expect(page.getByRole('radio', { name: '自动', exact: true })).toBeVisible()
  for (const label of [
    '上一个会话',
    '下一个会话',
    '选择会话 1–9',
    '新建会话',
    '终止当前会话',
    '设置',
  ]) {
    await expect(page.locator('dt', { hasText: label }).first()).toBeVisible()
  }

  await page.getByRole('searchbox', { name: '搜索设置' }).fill('字体')
  await expect(page.getByText('终端字体，默认为 JetBrains Mono。')).toBeVisible()

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(sidebar.locator('button[aria-label="新建会话"]')).toBeVisible()
  await expect(sidebar.getByRole('button', { name: /^筛选/ })).toBeVisible()

  // Verify Kill confirmation modal is localized when a live session card is available
  const firstCard = sidebar.getByTestId('session-card').first()
  if ((await firstCard.count()) > 0) {
    await firstCard.click()
    await page.getByRole('button', { name: '会话操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '终止会话', exact: true }).click()
    await expect(
      page.getByText(/确定要终止“.*”吗？进程将被结束，对话历史会保留在日志中。/)
    ).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
  }

  await sidebar.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '外观', exact: true }).click()
  await page.getByLabel('语言', { exact: true }).selectOption('en')

  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})
