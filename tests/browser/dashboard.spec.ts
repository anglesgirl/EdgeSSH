import { test, expect, type Page } from '@playwright/test';

const host = {
  id: 'alpha', name: 'Tokyo production', host: '192.0.2.10', port: 2222, username: 'deploy',
  group: '生产环境', authMethod: 'publickey', initialCommand: 'tmux attach', termType: 'xterm-256color',
  encoding: 'utf-8', fingerprint: `SHA256:${'A'.repeat(43)}`, location: null, system: null,
  hasCredential: true, updatedAt: Date.now(),
};
const dummyPrivateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nDUMMY TEST KEY\n-----END OPENSSH PRIVATE KEY-----';

async function dashboardFixture(page: Page) {
  const credentialRequests: Record<string, unknown>[] = [];
  const hostUpdates: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    }
    if (path === '/api/hosts') return route.fulfill({ json: { hosts: [host] } });
    if (path === `/api/hosts/${host.id}` && route.request().method() === 'PUT') {
      hostUpdates.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ json: { host } });
    }
    if (path.endsWith('/credentials')) {
      credentialRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ json: { privateKey: dummyPrivateKey } });
    }
    if (path === '/api/session') return route.fulfill({ status: 500, json: { error: 'test-only stop before WebSocket' } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  return { credentialRequests, hostUpdates };
}

test('主机列表编辑打开正确弹窗并回填资料', async ({ page }) => {
  await dashboardFixture(page);

  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();

  const editor = page.getByRole('dialog', { name: '编辑主机' });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('名称')).toHaveValue(host.name);
  await expect(editor.getByLabel('主机地址')).toHaveValue(host.host);
  await expect(editor.getByLabel('SSH 用户名')).toHaveValue(host.username);
  await expect(editor.getByLabel('端口')).toHaveValue(String(host.port));
  await expect(editor.locator('select[name="authMethod"]')).toHaveValue(host.authMethod);
  await expect(editor.locator('textarea[name="privateKey"]')).toHaveValue('');
  await expect(editor.locator('#cloud-key-field .credential-help')).toContainText('已保存私钥（隐藏）');
  await expect(page.locator('dialog[aria-labelledby="forward-key-heading"]')).not.toHaveAttribute('open', '');

  await editor.getByRole('button', { name: '取消' }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
  await expect(editor).toBeVisible();
});

test('编辑主机时留空私钥不会提交覆盖字段', async ({ page }) => {
  const { hostUpdates } = await dashboardFixture(page);
  await page.getByRole('button', { name: '编辑 Tokyo production' }).click();
  await page.getByRole('button', { name: '加密保存' }).click();
  await expect.poll(() => hostUpdates.length).toBe(1);
  expect(hostUpdates[0]).not.toHaveProperty('privateKey');
});

test('保存的私钥只在显式连接时读取，且不会写入普通文本框', async ({ page }) => {
  const { credentialRequests } = await dashboardFixture(page);

  await page.locator('.connect-host').click();
  await expect.poll(() => credentialRequests.length).toBe(1);
  expect(credentialRequests[0]).toEqual({ purpose: 'connect' });
  await expect(page.locator('#private-key')).toHaveValue('');
  await expect(page.locator('#private-key-status')).toContainText('已保存私钥');
  await expect(page.locator('#form-error')).toContainText('test-only stop before WebSocket');
  await expect(page.locator('#private-key')).toHaveValue('');
});
