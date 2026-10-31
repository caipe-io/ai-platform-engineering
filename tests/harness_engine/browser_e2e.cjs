/* Live Chromium test: real OIDC login, BFF, Engine, tools and MongoDB. */
const { chromium, expect } = require('@playwright/test');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');

(async () => {
  const fixture = JSON.parse(readFileSync(process.env.PHASE2_FIXTURE, 'utf8'));
  const base = process.env.CAIPE_UI_BASE_URL;
  const output = process.env.PHASE2_REPORT_DIR;
  if (!base || !output) throw new Error('CAIPE_UI_BASE_URL and PHASE2_REPORT_DIR are required');
  mkdirSync(output, { recursive: true });
  writeFileSync(output + '/browser-result.json', JSON.stringify({ status: 'running' }));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  let agent, thread;
  try {
    await page.goto(base + '/login');
    const sso = page.getByRole('button', { name: /sign in with sso/i });
    await sso.click({ timeout: 30000 });
    await page.locator('input[name="username"]').fill('test-admin');
    await page.locator('input[name="password"]').fill(fixture.password);
    await Promise.all([
      page.waitForURL(url => url.origin === new URL(base).origin && !url.pathname.startsWith('/login'), { timeout: 60000 }),
      page.locator('#kc-login').click(),
    ]);
    console.log('PASS browser OIDC login');
    async function post(path, data, expected = 200) {
      const response = await context.request.post(base + path, { data, headers: { Origin: new URL(base).origin } });
      if (response.status() !== expected) throw new Error(`${path} returned ${response.status()}: ${await response.text()}`);
      return response.json();
    }
    agent = (await post('/api/dynamic-agents', { name: 'Example browser ' + randomUUID().slice(0, 8), system_prompt: 'Use the requested tool and return its result.', model: { provider: 'openai-compatible', id: 'example-model' }, visibility: 'global', allowed_tools: {}, builtin_tools: { request_user_input: { enabled: true }, wait: { enabled: true } } }, 201)).data;
    thread = (await post('/api/chat/conversations', { agent_id: agent._id, title: 'Example browser session', client_type: 'webui' }, 201)).data.conversation._id;
    await page.goto(base + '/chat/' + thread);
    await page.getByRole('button', { name: 'Do not show again', exact: true }).click({ timeout: 5000 }).catch(() => {});
    const composer = page.locator('textarea:visible').last();
    await expect(composer).toBeVisible({ timeout: 30000 });
    const start = page.waitForResponse(response => response.url().includes('/api/v1/chat/stream/start'));
    await composer.fill('browser-example');
    await composer.press('Enter');
    const stream = await start;
    expect(stream.headers()['x-harness-run-id']).toBeTruthy();
    await expect(page.getByText('Example response: browser-example', { exact: true })).toBeVisible({ timeout: 30000 });
    console.log('PASS browser streamed through Engine');
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.getByText('Example response: browser-example', { exact: true })).toBeVisible({ timeout: 30000 });
    console.log('PASS browser persisted transcript');
    await page.locator('textarea:visible').last().fill('pause-example');
    await page.locator('textarea:visible').last().press('Enter');
    await expect(page.getByText('Choose a value', { exact: true }).last()).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.getByText('Choose a value', { exact: true }).last()).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: output + '/paused-after-refresh.png', fullPage: true });
    console.log('PASS browser restored persisted input form after refresh');
    const formInput = page.getByPlaceholder('Enter value...', { exact: true });
    await formInput.fill('browser-selected');
    await page.getByRole('button', { name: /submit/i }).click();
    await expect(page.getByText(/Tool completed/).last()).toBeVisible({ timeout: 30000 });
    console.log('PASS browser resumed exact pending interrupt');
    await page.waitForTimeout(1200);
    let reattached = false;
    page.on('request', request => { if (request.url().includes('/api/harness-engine/runs/') && request.url().includes('/events/stream')) reattached = true; });
    const running = page.waitForResponse(response => response.url().includes('/api/v1/chat/stream/start'));
    await page.locator('textarea:visible').last().fill('slow-example');
    await page.locator('textarea:visible').last().press('Enter');
    await running;
    await page.waitForTimeout(800);
    await page.reload();
    await expect.poll(() => reattached, { timeout: 10000 }).toBe(true);
    await expect(page.getByText(/Tool completed\. Waited for 4(?:\.0)? seconds/).last()).toBeVisible({ timeout: 30000 });
    await expect.poll(async () => (await post('/api/v1/chat/stream/status', { agent_id: agent._id, conversation_id: thread })).data.status, { timeout: 10000 }).toBe('idle');
    await page.screenshot({ path: output + '/recovered-after-refresh.png', fullPage: true });
    console.log('PASS active run survives page refresh and rejoins the turn');
    writeFileSync(output + '/browser-result.json', JSON.stringify({ agent_id: agent._id, conversation_id: thread, checks: 6, status: 'passed' }, null, 2));
  } catch (error) {
    await page.screenshot({ path: output + '/failure.png', fullPage: true });
    writeFileSync(output + '/failure-context.txt', (await page.locator('body').innerText()).slice(-18000));
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
