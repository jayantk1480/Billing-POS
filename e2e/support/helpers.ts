import { expect, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { MAILPIT_URL, REDIS_URL } from './env.js';

export async function signIn(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Sign-in is limited to ten attempts a minute per address; the suite signs in more often than a person would. */
export async function clearRateLimits(): Promise<void> {
  const redis = new Redis(REDIS_URL);
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
}

interface MailSummary {
  ID: string;
  To: { Address: string }[];
}

/** Messages sent to the test domain. The mailbox is shared with the development stack. */
async function testMail(): Promise<MailSummary[]> {
  const body = (await (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`)).json()) as { messages: MailSummary[] };
  return body.messages.filter((message) => message.To.some((to) => to.Address.endsWith('@e2e.local')));
}

/** Waits for an email to arrive in Mailpit and returns its text. */
export async function latestMailTo(address: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = (await testMail()).find((message) => message.To.some((to) => to.Address === address));
    if (found) {
      const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${found.ID}`)).json()) as { Text: string };
      return full.Text;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No email arrived for ${address}`);
}

/** Deletes this suite's emails, so no dead reset links are left for a person to click. */
export async function deleteTestMail(): Promise<void> {
  const ids = (await testMail()).map((message) => message.ID);
  if (ids.length === 0) return;
  await fetch(`${MAILPIT_URL}/api/v1/messages`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ IDs: ids }),
  });
}
