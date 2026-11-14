import { test, expect, type Page } from "@playwright/test";

const RECOVERY_KEY = "midnight-frequency:recovery:v1";
const PENDING_PREFIX = "midnight-frequency:recovery:pending:";
const PROFILES_KEY = "midnight-frequency:profiles:v1";

async function clearAll(page: Page) {
  // 仅在每次测试的第一次文档加载时清空；reload 等后续导航必须保留数据
  await page.addInitScript(() => {
    if (sessionStorage.getItem("__cleared__")) return;
    sessionStorage.setItem("__cleared__", "1");
    const keys: string[] = [];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  });
}

test.beforeEach(async ({ page }) => {
  await clearAll(page);
});

test("未提交的笔记草稿随自动恢复保存，恢复后回到原篇编辑状态且不覆盖正式笔记", async ({
  page,
}) => {
  await page.goto("/");
  // 等首集载入后标记一条笔记
  await expect(page.getByRole("button", { name: "播放录音" })).toBeVisible();
  await page.getByRole("button", { name: /记一笔/ }).first().click();
  await page.getByText("已记录最近五秒").waitFor();

  // 进入编辑，输入未提交草稿（不点保存）
  await page.getByRole("button", { name: "编辑笔记" }).first().click();
  const editor = page.getByRole("textbox", { name: "编辑笔记" });
  await editor.fill("这是还没提交的观察");
  await expect(page.locator(".draft-tag")).toHaveText(/未提交草稿/);

  // 自动保存为合并写入：等待草稿真正落盘（而非仅恢复键存在）
  await expect
    .poll(
      async () =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").drafts?.[0]
            ?.text ?? null,
          RECOVERY_KEY,
        ),
      { timeout: 8000 },
    )
    .toBe("这是还没提交的观察");
  const stored = await page.evaluate(
    ([recoveryKey, profilesKey]) => {
      const record = JSON.parse(localStorage.getItem(recoveryKey)!);
      return {
        draft: record.drafts[0]?.text,
        committed: record.snapshot.evidence.notes[0]?.text,
        clues: record.snapshot.evidence.clues.length,
        slotCount: JSON.parse(
          localStorage.getItem(profilesKey) ?? "[]",
        ).length,
      };
    },
    [RECOVERY_KEY, PROFILES_KEY],
  );
  expect(stored.draft).toBe("这是还没提交的观察");
  expect(stored.committed).not.toBe("这是还没提交的观察");
  expect(stored.clues).toBe(0);
  expect(stored.slotCount).toBe(0);

  // 重新打开：应出现恢复选择
  await page.reload();
  await expect(page.getByRole("heading", { name: /恢复上次调查/ })).toBeVisible();
  await page.getByRole("button", { name: /恢复这条路线/ }).click();

  // 回到原篇编辑状态，草稿还在；正式笔记未被覆盖
  await expect(page.getByRole("textbox", { name: "编辑笔记" })).toHaveValue(
    "这是还没提交的观察",
  );
  await expect(page.locator(".draft-tag")).toHaveText(/未提交草稿/);

  // 提交后草稿消失、正式笔记更新（自动保存为合并写入，需等待落盘）
  await page.getByRole("button", { name: /^保存$/ }).click();
  await expect(page.locator(".draft-tag")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").drafts?.length ?? -1,
          RECOVERY_KEY,
        ),
      { timeout: 8000 },
    )
    .toBe(0);
  const afterCommit = await page.evaluate((key) => {
    const record = JSON.parse(localStorage.getItem(key)!);
    return {
      drafts: record.drafts.length,
      committed: record.snapshot.evidence.notes[0]?.text,
    };
  }, RECOVERY_KEY);
  expect(afterCommit.drafts).toBe(0);
  expect(afterCommit.committed).toBe("这是还没提交的观察");
});

test("丢弃恢复记录不影响命名存档，且自动记录不占八个档位", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /记一笔/ }).first().click();
  await expect
    .poll(
      () =>
        page.evaluate(
          (key) => localStorage.getItem(key) !== null,
          RECOVERY_KEY,
        ),
      { timeout: 8000 },
    )
    .toBe(true);

  // 手动命名保存一份
  await page.getByRole("button", { name: /调查存档/ }).click();
  await page.getByLabel("新档案名称").fill("路线甲");
  await page.getByRole("button", { name: /保存当前进度/ }).click();
  await page.getByRole("button", { name: "关闭档案" }).click();

  await page.reload();
  await expect(page.getByRole("heading", { name: /恢复上次调查/ })).toBeVisible();
  await page.getByRole("button", { name: /丢弃，开始新调查/ }).click();

  // 恢复键与待提交槽清空，命名档案保留
  const state = await page.evaluate(
    ([recoveryKey, pendingPrefix, profilesKey]) => ({
      recovery: localStorage.getItem(recoveryKey),
      pending: Object.keys(localStorage).filter((k) =>
        k.startsWith(pendingPrefix),
      ).length,
      slots: JSON.parse(localStorage.getItem(profilesKey) ?? "[]").length,
    }),
    [RECOVERY_KEY, PENDING_PREFIX, PROFILES_KEY],
  );
  expect(state.recovery).toBeNull();
  expect(state.pending).toBe(0);
  expect(state.slots).toBe(1);
});

test("写入中断后待提交记录被采纳或隔离，唯一恢复点不被破坏", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /记一笔/ }).first().click();
  await expect
    .poll(
      () =>
        page.evaluate(
          (key) => localStorage.getItem(key) !== null,
          RECOVERY_KEY,
        ),
      { timeout: 8000 },
    )
    .toBe(true);

  // 注入一份完整的待提交记录（模拟第二次写入在替换当前槽前崩溃）
  const pendingKey = await page.evaluate(
    ([key, prefix]) => {
      const current = localStorage.getItem(key)!;
      const pending = `${prefix}${Date.now()}-abcd1234`;
      const record = JSON.parse(current);
      record.savedAt += 5000;
      localStorage.setItem(pending, JSON.stringify(record));
      return pending;
    },
    [RECOVERY_KEY, PENDING_PREFIX],
  );

  await page.reload();
  await expect(page.getByRole("heading", { name: /恢复上次调查/ })).toBeVisible();
  const adopted = await page.evaluate(
    ([key, pending]) => ({
      currentExists: localStorage.getItem(key) !== null,
      pendingGone: localStorage.getItem(pending) === null,
    }),
    [RECOVERY_KEY, pendingKey],
  );
  expect(adopted.pendingGone).toBe(true);
  expect(adopted.currentExists).toBe(true);

  // 损坏的当前记录被隔离，应用仍能正常打开且不弹恢复框
  await page.evaluate((key) => localStorage.setItem(key, "corrupt{"), RECOVERY_KEY);
  await page.reload();
  await expect(page.getByRole("heading", { name: /恢复上次调查/ })).toHaveCount(0);
  await expect(page.locator(".notice")).toContainText(/已隔离/);
  // 命名存档与主界面仍可用
  await expect(page.getByRole("button", { name: /记一笔/ }).first()).toBeVisible();
});

test("配额不足时暂停自动保存并给出清理建议，重试后恢复", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /记一笔/ }).first().click();

  // 模拟 localStorage 配额耗尽
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    // @ts-expect-error 测试中暂存原始方法
    window.__originalSetItem = original;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("midnight-frequency:recovery")) {
        const err = new Error("quota");
        err.name = "QuotaExceededError";
        throw err;
      }
      original.call(this, key, value);
    };
  });

  // 触发一次变化并强制刷写（等待合并窗口）
  await page.getByRole("button", { name: "编辑笔记" }).first().click();
  await page
    .getByRole("textbox", { name: "编辑笔记" })
    .fill("配额测试草稿");
  await expect(page.locator(".autosave-banner.paused")).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByText(/本地空间不足/)).toBeVisible();
  await expect(page.getByText(/不会被自动删除/)).toBeVisible();

  // 解除配额后点击重试
  await page.evaluate(() => {
    // @ts-expect-error 恢复测试前暂存的原始方法
    Storage.prototype.setItem = window.__originalSetItem;
  });
  await page.getByRole("button", { name: /重试自动保存/ }).click();
  await expect(page.locator(".autosave-banner.active")).toBeVisible({
    timeout: 5000,
  });
});
