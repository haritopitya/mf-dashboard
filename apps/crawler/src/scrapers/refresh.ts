import type { RefreshResult } from "@mf-dashboard/db/types";
import { mfUrls } from "@mf-dashboard/meta/urls";
import type { Page } from "playwright";
import { debug, info, warn } from "../logger.js";

const DEFAULT_MAX_WAIT_MINUTES = 20;
const POLL_INTERVAL_MS = 30000; // 30 seconds
const NAVIGATION_RETRY_DELAY_MS = 1000;
const NAVIGATION_TIMEOUT_MS = 60000;

interface NavigationOptions {
  retryDelayMs?: number;
}

function isRetryableNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("net::ERR_ABORTED") || message.includes("Timeout");
}

export async function navigateToAccountsPage(
  page: Page,
  options: NavigationOptions = {},
): Promise<void> {
  const MAX_RETRIES = 1;
  const retryDelayMs = options.retryDelayMs ?? NAVIGATION_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.goto(mfUrls.accounts, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      return;
    } catch (err) {
      if (page.isClosed()) {
        throw err;
      }

      if (!isRetryableNavigationError(err) || attempt === MAX_RETRIES) {
        throw err;
      }

      // A crashed Playwright page can reject page.waitForTimeout() and mask the
      // original navigation error. Use a process timer between attempts instead.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

export async function getRefreshStatus(
  page: Page,
): Promise<{ incompleteAccounts: string[]; remainingCount: number }> {
  const rows = page.locator("#account-table tr:has(td.account-status)");
  const count = await rows.count();
  const refreshRows: RefreshStatusRow[] = [];

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const statuses = await row.locator("td.account-status").allInnerTexts();
    const nameLink = row.locator("td.service a").first();
    refreshRows.push({
      name: statuses.some((status) => status.trim() === "更新中")
        ? await ((await nameLink.count()) > 0 ? nameLink : row.locator("td").first()).textContent()
        : null,
      statuses,
    });
  }

  return summarizeRefreshRows(refreshRows);
}

export interface RefreshStatusRow {
  name: string | null;
  statuses: string[];
}

const TERMINAL_REFRESH_STATUSES = new Set(["取得を停止しています", "一時停止中"]);
const RETRYABLE_REFRESH_STATUSES = new Set(["正常", "一時停止中"]);

function isRefreshPending(statuses: readonly string[]): boolean {
  return (
    statuses.some((status) => status.trim() === "更新中") &&
    !statuses.some((status) => TERMINAL_REFRESH_STATUSES.has(status.trim()))
  );
}

export interface RefreshAccountSnapshot {
  lastUpdated: string;
  name: string | null;
  statuses: string[];
}

function parseLastUpdatedDate(value: string, referenceTime: Date): Date | null {
  const shortDateMatch = value.match(/\((\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  const fullDateMatch = value.match(
    /(?:^|\s)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/,
  );
  const standaloneShortDateMatch = value.match(/^(\d{1,2})\/(\d{1,2})/);
  if (!shortDateMatch && !fullDateMatch && !standaloneShortDateMatch) return null;

  const year =
    fullDateMatch && !shortDateMatch ? Number(fullDateMatch[1]) : referenceTime.getFullYear();
  const month = Number(shortDateMatch?.[1] ?? fullDateMatch?.[2] ?? standaloneShortDateMatch?.[1]);
  const day = Number(shortDateMatch?.[2] ?? fullDateMatch?.[3] ?? standaloneShortDateMatch?.[2]);
  const hour = Number(shortDateMatch?.[3] ?? fullDateMatch?.[4] ?? 0);
  const minute = Number(shortDateMatch?.[4] ?? fullDateMatch?.[5] ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));

  if (
    shortDateMatch &&
    Date.UTC(year, month - 1, day) >
      Date.UTC(referenceTime.getFullYear(), referenceTime.getMonth(), referenceTime.getDate())
  ) {
    date.setUTCFullYear(date.getUTCFullYear() - 1);
  }

  return Number.isNaN(date.getTime()) ? null : date;
}

export function shouldRefreshStaleAccount(
  account: RefreshAccountSnapshot,
  now = new Date(),
): boolean {
  if (
    account.statuses.some((status) => status.trim() === "更新中") ||
    !account.statuses.some((status) => RETRYABLE_REFRESH_STATUSES.has(status.trim()))
  ) {
    return false;
  }

  const lastUpdated = parseLastUpdatedDate(account.lastUpdated, now);
  if (!lastUpdated) return false;

  const referenceTime = Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
  );
  return lastUpdated.getTime() < referenceTime;
}

async function refreshStaleAccounts(page: Page, now = new Date()): Promise<string[]> {
  const rows = page.locator("#account-table tr:has(td.account-status)");
  const staleAccounts: string[] = [];
  const count = await rows.count();

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const statuses = await row.locator("td.account-status").allInnerTexts();
    const lastUpdated = await row
      .locator("td")
      .nth(2)
      .textContent()
      .catch(() => "");
    const name = await row
      .locator("td.service a")
      .first()
      .textContent()
      .catch(() =>
        row
          .locator("td")
          .first()
          .textContent()
          .catch(() => null),
      );

    if (!shouldRefreshStaleAccount({ lastUpdated: lastUpdated ?? "", name, statuses }, now)) {
      continue;
    }

    const refreshButton = row
      .locator('form input[type="submit"][name="commit"][value="更新"]')
      .first();
    if (
      !(await refreshButton.isVisible().catch(() => false)) ||
      !(await refreshButton.isEnabled().catch(() => false))
    ) {
      continue;
    }

    await refreshButton.click();
    const accountName = name?.trim();
    if (accountName) staleAccounts.push(accountName);
  }

  return staleAccounts;
}

export function summarizeRefreshRows(rows: readonly RefreshStatusRow[]): {
  incompleteAccounts: string[];
  remainingCount: number;
} {
  const incompleteAccounts: string[] = [];
  let remainingCount = 0;

  for (const row of rows) {
    if (!isRefreshPending(row.statuses)) {
      continue;
    }

    remainingCount++;
    const accountName = row.name?.trim();
    if (accountName) {
      incompleteAccounts.push(accountName);
    }
  }

  return { incompleteAccounts, remainingCount };
}

interface RefreshWaitProgress {
  elapsedSeconds: number;
  incompleteAccounts: string[];
  maxWaitMinutes: number;
  nextCheckSeconds: number;
  remainingCount: number;
}

interface RefreshOptions {
  maxWaitMinutes?: number;
  pollIntervalMs?: number;
  onWaiting?: (progress: RefreshWaitProgress) => Promise<void> | void;
}

export function getMaxWaitMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const configuredValue = Number(env.MAX_WAIT_MINUTES);
  return Number.isFinite(configuredValue) && configuredValue > 0
    ? configuredValue
    : DEFAULT_MAX_WAIT_MINUTES;
}

export async function clickRefreshButton(
  page: Page,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const maxWaitMinutes = options.maxWaitMinutes ?? getMaxWaitMinutes();
  const maxWaitTimeMs = maxWaitMinutes * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  let hasRetriedStaleAccounts = false;
  debug("Looking for refresh button...");

  // Navigate to home and click refresh button
  await page.goto(mfUrls.home);
  await page.waitForLoadState("networkidle");

  const refreshStartedAt = new Date();
  const refreshButton = page.locator('a:has-text("一括更新")').first();
  await refreshButton.click();

  info("Refreshing accounts...");

  // Wait for refresh to start
  await page.waitForTimeout(3000);

  // Navigate to accounts page to check update status
  await navigateToAccountsPage(page);

  info("Waiting for all updates to complete on /accounts page...");

  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTimeMs) {
    const { incompleteAccounts, remainingCount } = await getRefreshStatus(page);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    info(`[${elapsed}s] 残り: ${remainingCount}`);

    await options.onWaiting?.({
      elapsedSeconds: elapsed,
      incompleteAccounts,
      maxWaitMinutes,
      nextCheckSeconds: Math.round(pollIntervalMs / 1000),
      remainingCount,
    });

    if (remainingCount === 0) {
      const staleAccounts = hasRetriedStaleAccounts
        ? []
        : await refreshStaleAccounts(page, refreshStartedAt);
      if (staleAccounts.length > 0) {
        hasRetriedStaleAccounts = true;
        info(`Refreshing ${staleAccounts.length} stale accounts individually...`);
        await page.waitForTimeout(3000);
        await navigateToAccountsPage(page);
        continue;
      }

      info("All updates completed!");
      return { completed: true, incompleteAccounts: [] };
    }

    // Wait and navigate to accounts page again to get fresh status
    // Using goto instead of reload to avoid ERR_ABORTED when frame is detached
    await page.waitForTimeout(pollIntervalMs);
    await navigateToAccountsPage(page);
  }

  // Timeout: get list of accounts still updating
  const { incompleteAccounts, remainingCount } = await getRefreshStatus(page);

  warn(`Max wait time exceeded. ${incompleteAccounts.length} accounts still updating:`);
  for (const account of incompleteAccounts) {
    warn(`  - ${account}`);
  }

  return { completed: false, incompleteAccounts, remainingCount };
}
