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
  await page.getByRole('searchbox', { name: '搜索设置' }).fill('字体')
  await expect(page.getByText('终端字体，默认为 JetBrains Mono。')).toBeVisible()

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(sidebar.locator('button[aria-label="新建会话"]')).toBeVisible()
  await sidebar.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('语言', { exact: true }).selectOption('en')

  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})
