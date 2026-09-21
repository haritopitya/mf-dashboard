import type { Page } from "playwright";
import { describe, expect, test, vi } from "vitest";
import {
  getMaxWaitMinutes,
  getRefreshStatus,
  navigateToAccountsPage,
  shouldRefreshStaleAccount,
  summarizeRefreshRows,
  type RefreshAccountSnapshot,
  type RefreshStatusRow,
} from "./refresh.js";

describe("shouldRefreshStaleAccount", () => {
  const now = new Date(2026, 8, 21, 12, 0, 30);

  test.each<{
    account: RefreshAccountSnapshot;
    expected: boolean;
    name: string;
  }>([
    {
      name: "正常で最終取得日が前日なら更新する",
      account: { name: "Institution A", statuses: ["正常"], lastUpdated: "09/20 06:32" },
      expected: true,
    },
    {
      name: "正常で一括更新時刻より前なら当日でも更新する",
      account: { name: "Institution A", statuses: ["正常"], lastUpdated: "09/21 06:32" },
      expected: true,
    },
    {
      name: "括弧内の最終取得日が一括更新と同じ分なら更新しない",
      account: {
        name: "Institution A",
        statuses: ["正常"],
        lastUpdated: "2025/04/06 (09/21 12:00)",
      },
      expected: false,
    },
    {
      name: "括弧内の最終取得日が一括更新より後なら更新しない",
      account: {
        name: "Institution A",
        statuses: ["正常"],
        lastUpdated: "2025/04/06 (09/21 12:01)",
      },
      expected: false,
    },
    {
      name: "更新中は更新しない",
      account: { name: "Institution A", statuses: ["更新中", "正常"], lastUpdated: "09/20" },
      expected: false,
    },
    {
      name: "取得停止中は最終取得日が古くても更新しない",
      account: {
        name: "Institution A",
        statuses: ["取得を停止しています"],
        lastUpdated: "09/20",
      },
      expected: false,
    },
    {
      name: "一時停止中で最終取得日が古ければ更新する",
      account: { name: "Institution A", statuses: ["一時停止中"], lastUpdated: "09/20" },
      expected: true,
    },
    {
      name: "状態が正常でなければ更新しない",
      account: { name: "Institution A", statuses: ["停止中"], lastUpdated: "09/20" },
      expected: false,
    },
    {
      name: "解釈できない日付は更新しない",
      account: { name: "Institution A", statuses: ["正常"], lastUpdated: "未取得" },
      expected: false,
    },
  ])("$name", ({ account, expected }) => {
    expect(shouldRefreshStaleAccount(account, now)).toBe(expected);
  });
});

describe("getMaxWaitMinutes", () => {
  test.each([undefined, "", "0", "-1", "Infinity", "NaN"])(
    "invalid MAX_WAIT_MINUTES=%s は default 値を返す",
    (value) => {
      expect(getMaxWaitMinutes({ MAX_WAIT_MINUTES: value })).toBe(20);
    },
  );

  test("有限の正数を返す", () => {
    expect(getMaxWaitMinutes({ MAX_WAIT_MINUTES: "12.5" })).toBe(12.5);
  });
});

describe("summarizeRefreshRows", () => {
  test.each<{
    expected: { incompleteAccounts: string[]; remainingCount: number };
    name: string;
    rows: RefreshStatusRow[];
  }>([
    {
      name: "更新中のアカウント名と件数を返す",
      rows: [
        { name: "Institution A", statuses: ["更新中"] },
        { name: "Institution B", statuses: ["正常"] },
        { name: "Institution C", statuses: ["更新中"] },
      ],
      expected: {
        incompleteAccounts: ["Institution A", "Institution C"],
        remainingCount: 2,
      },
    },
    {
      name: "複数の状態セルに更新中があれば1件として数える",
      rows: [{ name: "Institution A", statuses: ["更新中", "正常"] }],
      expected: { incompleteAccounts: ["Institution A"], remainingCount: 1 },
    },
    {
      name: "完全一致しない状態は更新中として数えない",
      rows: [
        { name: "Institution A", statuses: ["更新中 → 一時停止中"] },
        { name: "Institution B", statuses: ["再更新中"] },
      ],
      expected: { incompleteAccounts: [], remainingCount: 0 },
    },
    {
      name: "停止状態へ遷移した行は待機対象から除外する",
      rows: [
        { name: "Institution A", statuses: ["更新中", "取得を停止しています"] },
        { name: "Institution B", statuses: ["更新中", "一時停止中"] },
      ],
      expected: { incompleteAccounts: [], remainingCount: 0 },
    },
    {
      name: "空の行一覧は0件を返す",
      rows: [],
      expected: { incompleteAccounts: [], remainingCount: 0 },
    },
    {
      name: "名称がない更新中行も件数には含める",
      rows: [{ name: null, statuses: [" 更新中 "] }],
      expected: { incompleteAccounts: [], remainingCount: 1 },
    },
    {
      name: "空白のみの名称は除外し更新中行を件数には含める",
      rows: [{ name: " \t ", statuses: ["更新中"] }],
      expected: { incompleteAccounts: [], remainingCount: 1 },
    },
  ])("$name", ({ rows, expected }) => {
    expect(summarizeRefreshRows(rows)).toEqual(expected);
  });
});

describe("getRefreshStatus", () => {
  test("service linkがない更新中行は先頭セルの名称を使う", async () => {
    const statusCells = {
      allInnerTexts: vi.fn<() => Promise<string[]>>().mockResolvedValue(["更新中"]),
    };
    const nameLink = {
      count: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    };
    const firstCell = {
      textContent: vi.fn<() => Promise<string | null>>().mockResolvedValue(" Institution A "),
    };
    const allCells = {
      first: vi.fn<() => typeof firstCell>().mockReturnValue(firstCell),
    };
    const nameLinkLocator = {
      first: vi.fn<() => typeof nameLink>().mockReturnValue(nameLink),
    };
    const row = {
      locator: vi.fn<
        (selector: string) => typeof statusCells | typeof nameLinkLocator | typeof allCells
      >((selector) => {
        if (selector === "td.account-status") return statusCells;
        if (selector === "td.service a") return nameLinkLocator;
        return allCells;
      }),
    };
    const rows = {
      count: vi.fn<() => Promise<number>>().mockResolvedValue(1),
      nth: vi.fn<() => typeof row>().mockReturnValue(row),
    };
    const page = {
      locator: vi.fn<() => typeof rows>().mockReturnValue(rows),
    } as unknown as Page;

    await expect(getRefreshStatus(page)).resolves.toEqual({
      incompleteAccounts: ["Institution A"],
      remainingCount: 1,
    });
    expect(firstCell.textContent).toHaveBeenCalledOnce();
  });
});

describe("navigateToAccountsPage", () => {
  test.each([
    "page.goto: net::ERR_ABORTED at https://moneyforward.com/accounts",
    "page.goto: Timeout 30000ms exceeded.",
  ])("一時的な遷移エラーを1回だけ再試行する: %s", async (message) => {
    const goto = vi
      .fn<(...args: any[]) => any>()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce(null);
    const isClosed = vi.fn<(...args: any[]) => any>().mockReturnValue(false);
    const retryPage = { goto, isClosed } as unknown as Page;

    await navigateToAccountsPage(retryPage, { retryDelayMs: 0 });

    expect(goto).toHaveBeenCalledTimes(2);
    expect(goto).toHaveBeenCalledWith(
      "https://moneyforward.com/accounts",
      expect.objectContaining({ timeout: 60000, waitUntil: "domcontentloaded" }),
    );
  });

  test("Page crashedは再試行せず元のエラーを返す", async () => {
    const error = new Error("page.goto: Page crashed");
    const goto = vi.fn<(...args: any[]) => any>().mockRejectedValue(error);
    const page = {
      goto,
      isClosed: vi.fn<(...args: any[]) => any>().mockReturnValue(false),
    } as unknown as Page;

    await expect(navigateToAccountsPage(page, { retryDelayMs: 0 })).rejects.toBe(error);
    expect(goto).toHaveBeenCalledOnce();
  });
});
