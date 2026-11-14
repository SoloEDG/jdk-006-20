import test from "node:test";
import assert from "node:assert/strict";
import {
  createEvidence,
  addNote,
} from "../src/features/evidence/index";
import { createSnapshot } from "../src/features/profiles/index";
import {
  createRecovery,
  validateRecovery,
  migrateLegacyRecovery,
  readRecovery,
  writeRecovery,
  clearRecovery,
  clearQuarantine,
  isQuotaError,
  quotaAdvice,
  RECOVERY_KEY,
  RecoveryAutoSaver,
  type RecoverableBundle,
} from "../src/features/recovery/index";
import type { CaseContent, Investigation } from "../src/shared/types";
import { MemoryStorage } from "./helpers";

const content: CaseContent = {
  id: "test",
  title: "test",
  scenes: [
    {
      id: "arrival",
      title: "A",
      location: "x",
      chapter: "1",
      description: "",
      choices: [],
    },
  ],
  episodes: [
    {
      id: "arrival-main",
      sceneId: "arrival",
      title: "A",
      version: "main",
      description: "",
      audio: "a",
      duration: 20,
      wave: [],
      cues: [],
    },
  ],
  clues: [{ id: "bell", title: "Bell", kind: "sound", description: "" }],
};
const story: Investigation = {
  sceneId: "arrival",
  visited: ["arrival"],
  decisions: [],
  ending: null,
};
const anchor = { sceneId: "arrival" as const, start: 5, end: 7 };

function bundle(drafts: RecoverableBundle["drafts"] = []): RecoverableBundle {
  return {
    snapshot: createSnapshot(
      content,
      story,
      addNote(createEvidence(), anchor, "正式内容"),
      { "arrival-main": 7 },
      { sceneId: "arrival", position: 6, rate: 1 },
    ),
    drafts,
  };
}

test("recovery keeps drafts separate and strips drafts that match or lose their note", () => {
  const base = bundle();
  const noteId = base.snapshot.evidence.notes[0].id;
  const record = createRecovery(
    content,
    base.snapshot,
    [
      { noteId, text: "未提交的观察" },
      { noteId, text: "正式内容" }, // 与正式笔记相同，应被剔除
      { noteId: "missing", text: "孤儿草稿" }, // 笔记不存在，应被剔除
    ],
    1000,
  );
  assert.equal(record.drafts.length, 1);
  assert.equal(record.drafts[0].text, "未提交的观察");
  // 正式笔记不被草稿覆盖
  assert.equal(record.snapshot.evidence.notes[0].text, "正式内容");
  assert.equal(record.snapshot.evidence.clues.length, 0);
  assert.equal(record.savedAt, 1000);
  assert.throws(
    () =>
      validateRecovery(
        { ...record, drafts: [{ noteId: "ghost", text: "x" }] },
        content,
      ),
    /笔记不存在/,
  );
});

test("atomic write: pending slot is adopted after interruption and current slot is never corrupted", () => {
  const storage = new MemoryStorage();
  const first = createRecovery(content, bundle().snapshot, [], 1);
  writeRecovery(first, storage);
  const before = storage.getItem(RECOVERY_KEY);
  assert.ok(before);

  // 第二次写入：待提交槽写入成功，但替换当前槽时配额失败
  storage.failAfterWrites(1);
  const second = createRecovery(content, bundle().snapshot, [], 2);
  assert.throws(() => writeRecovery(second, storage), /quota/);
  assert.ok(isQuotaError(Object.assign(new Error("q"), { name: "QuotaExceededError" })));

  // 解除故障后读取：待提交记录完整则被采纳，否则保留上一份当前记录
  storage.failAfterWrites(Number.POSITIVE_INFINITY);
  const result = readRecovery(content, storage);
  assert.ok(result.recovery);
  // 待提交槽内容本身完整，应提升为当前记录
  assert.equal(result.recovery.savedAt, 2);
  assert.equal(result.pendingAdopted, true);
  assert.ok(result.warning);
  // 读取后待提交槽被清理
  assert.ok(!storage.keys().some((key) => key.includes("pending")));

  // 当前槽损坏时隔离并移除，命名档案键完全不受影响
  storage.corrupt(RECOVERY_KEY);
  const fallback = readRecovery(content, storage);
  assert.equal(fallback.recovery, null);
  assert.equal(fallback.quarantine.length, 1);
  assert.ok(fallback.warning?.includes("隔离"));
  assert.equal(storage.getItem(RECOVERY_KEY), null);
});

test("quota failure while writing pending keeps the previous recovery point usable", () => {
  const storage = new MemoryStorage();
  writeRecovery(createRecovery(content, bundle().snapshot, [], 10), storage);
  // 第一次写入（待提交槽）就失败：当前槽必须原样保留
  storage.failAllWrites();
  assert.throws(
    () => writeRecovery(createRecovery(content, bundle().snapshot, [], 20), storage),
    /quota/,
  );
  const result = readRecovery(content, storage);
  assert.equal(result.recovery?.savedAt, 10);
  assert.equal(result.quarantine.length, 0);
});

test("legacy recovery format migrates including drafts and unknown draft shapes", () => {
  const b = bundle();
  const noteId = b.snapshot.evidence.notes[0].id;
  const legacy = {
    caseId: "test",
    savedAt: 555,
    snapshot: b.snapshot,
    noteDrafts: [{ id: noteId, draft: "旧版草稿" }],
  };
  const migrated = migrateLegacyRecovery(legacy, content);
  assert.equal(migrated.version, 1);
  assert.equal(migrated.savedAt, 555);
  assert.deepEqual(migrated.drafts, [{ noteId, text: "旧版草稿" }]);

  const storage = new MemoryStorage();
  storage.setItem("midnight-frequency:auto-recovery:v0", JSON.stringify(legacy));
  const read = readRecovery(content, storage);
  assert.equal(read.recovery?.drafts[0].text, "旧版草稿");
  assert.ok(read.warning?.includes("迁移"));
  // 迁移后旧键清除、新键存在
  assert.equal(storage.getItem("midnight-frequency:auto-recovery:v0"), null);
  assert.ok(storage.getItem(RECOVERY_KEY));
});

test("corrupt legacy record is quarantined and manual slots remain readable", () => {
  const storage = new MemoryStorage();
  storage.setItem("midnight-frequency:auto-recovery:v0", "corrupt");
  const read = readRecovery(content, storage);
  assert.equal(read.recovery, null);
  assert.equal(read.quarantine.length, 1);
  assert.ok(read.warning?.includes("隔离"));
  clearQuarantine(storage);
  assert.equal(readRecovery(content, storage).quarantine.length, 0);
  clearRecovery(storage);
});

test("quota advice lists quarantine, recovery and named slots, never auto-deletes", () => {
  const storage = new MemoryStorage();
  writeRecovery(createRecovery(content, bundle().snapshot, [], 1), storage);
  storage.setItem(
    "midnight-frequency:recovery:quarantine:v1",
    JSON.stringify([{ savedAt: 1, reason: "bad", excerpt: "x" }]),
  );
  const advice = quotaAdvice(storage, [
    { name: "钟声之后", chars: 400 },
  ]);
  assert.equal(advice.isQuota, true);
  assert.ok(advice.details.some((d) => d.includes("隔离")));
  assert.ok(advice.details.some((d) => d.includes("钟声之后")));
  assert.ok(advice.message.includes("不会被自动删除"));
});

test("auto saver merges continuous edits, pauses on quota and resumes after retry", async () => {
  const storage = new MemoryStorage();
  let now = 1000;
  const b = bundle();
  const saver = new RecoveryAutoSaver({
    content,
    storage,
    interval: 30,
    mergeWindow: 20,
    now: () => now,
    getBundle: () => b,
  });
  saver.start();
  // 连续三次变更在合并窗口内只产生一次写入
  saver.notifyChange();
  saver.notifyChange();
  saver.notifyChange();
  await new Promise((resolve) => setTimeout(resolve, 45));
  const writesAfterBurst = storage.keys().filter((k) => k === RECOVERY_KEY).length;
  assert.equal(writesAfterBurst, 1);
  assert.equal(saver.getState().status, "active");
  assert.equal(saver.getState().savedAt, 1000);

  // 定时刷写：内容未变化不重复写
  now = 2000;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    storage.keys().filter((k) => k === RECOVERY_KEY).length,
    1,
  );

  // 配额故障：暂停自动保存，旧恢复点保留
  storage.failAllWrites();
  b.drafts = [{ noteId: b.snapshot.evidence.notes[0].id, text: "新草稿" }];
  const flushed = await saver.flush(true);
  assert.equal(flushed, false);
  assert.equal(saver.getState().status, "paused");
  assert.equal(saver.getState().quota, true);
  // 暂停期间 notifyChange 不会尝试写入
  saver.notifyChange();
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 清理后重试成功
  const fresh = new MemoryStorage();
  const retrySaver = new RecoveryAutoSaver({
    content,
    storage: fresh,
    interval: 30,
    mergeWindow: 20,
    now: () => now,
    getBundle: () => b,
  });
  retrySaver.start();
  const ok = await retrySaver.retry();
  assert.equal(ok, true);
  assert.equal(retrySaver.getState().status, "active");
  const saved = readRecovery(content, fresh);
  assert.equal(saved.recovery?.drafts[0].text, "新草稿");
});

test("auto saver stays idle before engagement and deactivate clears the route", async () => {
  const storage = new MemoryStorage();
  const b = bundle();
  const saver = new RecoveryAutoSaver({
    content,
    storage,
    interval: 20,
    mergeWindow: 10,
    getBundle: () => b,
  });
  // 未启用时 notifyChange / flush 都不写入
  saver.notifyChange();
  assert.equal(await saver.flush(true), false);
  assert.equal(saver.getState().status, "idle");
  saver.start();
  assert.equal(await saver.flush(true), true);
  saver.deactivate();
  assert.equal(saver.getState().status, "idle");
  assert.equal(await saver.flush(true), false);
});
