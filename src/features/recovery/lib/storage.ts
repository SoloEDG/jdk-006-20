import type { AutoRecovery, CaseContent } from "../../../shared/types";
import {
  migrateLegacyRecovery,
  validateRecovery,
} from "../model/recovery";

export const RECOVERY_KEY = "midnight-frequency:recovery:v1";
const PENDING_PREFIX = "midnight-frequency:recovery:pending:";
const QUARANTINE_KEY = "midnight-frequency:recovery:quarantine:v1";
const LEGACY_KEY = "midnight-frequency:auto-recovery:v0";
const MAX_QUARANTINE = 2;

export interface QuarantineEntry {
  savedAt: number;
  reason: string;
  excerpt: string;
}

export interface RecoveryReadResult {
  recovery: AutoRecovery | null;
  warning: string | null;
  quarantine: QuarantineEntry[];
  pendingAdopted: boolean;
}

export interface QuotaAdvice {
  isQuota: boolean;
  message: string;
  details: string[];
}

export interface StoragePort {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function port(): StoragePort {
  return localStorage as Storage;
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

function readQuarantine(storage: StoragePort): QuarantineEntry[] {
  try {
    const text = storage.getItem(QUARANTINE_KEY);
    if (!text) return [];
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (item): item is QuarantineEntry =>
          !!item &&
          typeof item === "object" &&
          typeof (item as QuarantineEntry).reason === "string" &&
          typeof (item as QuarantineEntry).savedAt === "number",
      )
      .slice(0, MAX_QUARANTINE);
  } catch {
    return [];
  }
}

function writeQuarantine(storage: StoragePort, list: QuarantineEntry[]) {
  try {
    storage.setItem(QUARANTINE_KEY, JSON.stringify(list.slice(0, MAX_QUARANTINE)));
  } catch {
    // 隔离区自身写不下时不影响主流程
  }
}

function quarantine(
  storage: StoragePort,
  reason: string,
  raw: string,
): QuarantineEntry[] {
  const entry: QuarantineEntry = {
    savedAt: Date.now(),
    reason,
    excerpt: raw.slice(0, 200),
  };
  const next = [entry, ...readQuarantine(storage)].slice(0, MAX_QUARANTINE);
  writeQuarantine(storage, next);
  return next;
}

function tryValidate(
  text: string,
  content: CaseContent,
  migrated: boolean,
): AutoRecovery {
  const raw: unknown = JSON.parse(text);
  return migrated
    ? migrateLegacyRecovery(raw, content)
    : validateRecovery(raw, content);
}

export function readRecovery(
  content: CaseContent,
  storage?: StoragePort,
): RecoveryReadResult {
  const store: StoragePort | null =
    storage ?? (typeof localStorage === "undefined" ? null : port());
  if (!store)
    return { recovery: null, warning: null, quarantine: [], pendingAdopted: false };
  const warnings: string[] = [];
  const currentText = store.getItem(RECOVERY_KEY);
  const pendingKeys: string[] = [];
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key?.(i);
    if (key?.startsWith(PENDING_PREFIX)) pendingKeys.push(key);
  }
  // 键名含时间戳，按从旧到新处理；全部校验后采用最新的完整待提交记录
  pendingKeys.sort();
  let pendingAdopted = false;
  let latestPending: { key: string; text: string; record: AutoRecovery } | null =
    null;
  for (const key of pendingKeys) {
    const text = store.getItem(key);
    if (!text) {
      store.removeItem(key);
      continue;
    }
    try {
      const candidate = tryValidate(text, content, false);
      latestPending = { key, text, record: candidate };
    } catch (error) {
      quarantine(
        store,
        error instanceof Error ? error.message : "待提交记录无法读取",
        text,
      );
      store.removeItem(key);
      warnings.push("一份未完成的恢复记录已隔离，未影响之前的恢复点。");
    }
  }
  if (latestPending) {
    store.setItem(RECOVERY_KEY, latestPending.text);
    for (const key of pendingKeys) store.removeItem(key);
    pendingAdopted = true;
    warnings.push("上次写入中断，已采用最近一次完整的恢复记录。");
    return finishRead(store, latestPending.record, warnings, true);
  }
  if (currentText) {
    try {
      const recovery = tryValidate(currentText, content, pendingAdopted);
      return finishRead(store, recovery, warnings, pendingAdopted);
    } catch (error) {
      quarantine(
        store,
        error instanceof Error ? error.message : "恢复记录无法读取",
        currentText,
      );
      store.removeItem(RECOVERY_KEY);
      warnings.push("损坏的恢复记录已隔离，命名存档不受影响。");
    }
  }
  // 旧格式迁移
  const legacyText = store.getItem(LEGACY_KEY);
  if (legacyText) {
    try {
      const recovery = tryValidate(legacyText, content, true);
      try {
        store.setItem(RECOVERY_KEY, JSON.stringify(recovery));
        store.removeItem(LEGACY_KEY);
        warnings.push("已迁移上一版自动恢复格式。");
      } catch {
        // 迁移写入失败时本次会话仍可使用内存中的记录
      }
      return finishRead(store, recovery, warnings, false);
    } catch (error) {
      quarantine(
        store,
        error instanceof Error ? error.message : "旧恢复记录无法迁移",
        legacyText,
      );
      store.removeItem(LEGACY_KEY);
      warnings.push("一份旧格式恢复记录无法迁移，已隔离。");
    }
  }
  return {
    recovery: null,
    warning: warnings.length ? warnings.join(" ") : null,
    quarantine: readQuarantine(store),
    pendingAdopted,
  };
}

function finishRead(
  storage: StoragePort,
  recovery: AutoRecovery,
  warnings: string[],
  pendingAdopted: boolean,
): RecoveryReadResult {
  const quarantined = readQuarantine(storage);
  if (quarantined.length)
    warnings.push(`另有 ${quarantined.length} 份损坏记录已隔离。`);
  return {
    recovery,
    warning: warnings.length ? warnings.join(" ") : null,
    quarantine: quarantined,
    pendingAdopted,
  };
}

/**
 * 双槽原子写入：先写待提交槽并回读校验，成功后才替换当前槽。
 * 任何一步抛错（含配额不足）都不会破坏上一份可用恢复点。
 */
export function writeRecovery(
  recovery: AutoRecovery,
  storage?: StoragePort,
): void {
  const store = storage ?? port();
  const pendingKey = `${PENDING_PREFIX}${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const text = JSON.stringify(recovery);
  store.setItem(pendingKey, text);
  const echoed = store.getItem(pendingKey);
  if (echoed !== text) {
    store.removeItem(pendingKey);
    throw new Error("恢复记录写入后校验失败，已保留上一份记录");
  }
  store.setItem(RECOVERY_KEY, text);
  store.removeItem(pendingKey);
}

export function clearRecovery(storage: StoragePort = port()): void {
  storage.removeItem(RECOVERY_KEY);
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key?.(i);
    if (key?.startsWith(PENDING_PREFIX)) storage.removeItem(key);
  }
}

export function clearQuarantine(storage: StoragePort = port()): void {
  storage.removeItem(QUARANTINE_KEY);
}

export function storageUsage(storage?: StoragePort): {
  used: number;
  items: { key: string; chars: number }[];
} {
  const store = storage ?? port();
  const items: { key: string; chars: number }[] = [];
  let used = 0;
  for (let i = 0; i < store.length; i++) {
    const key = store.key?.(i);
    if (!key) continue;
    const chars = (store.getItem(key) ?? "").length;
    used += chars + key.length;
    items.push({ key, chars });
  }
  items.sort((a, b) => b.chars - a.chars);
  return { used, items };
}

export function quotaAdvice(
  storage?: StoragePort,
  slots: { name: string; chars: number }[] = [],
): QuotaAdvice {
  const { items } = storageUsage(storage);
  const details: string[] = [];
  const quarantineSize =
    items.find((item) => item.key === QUARANTINE_KEY)?.chars ?? 0;
  if (quarantineSize > 0) details.push("清理已隔离的损坏恢复记录");
  const recoverySize =
    items.find((item) => item.key === RECOVERY_KEY)?.chars ?? 0;
  if (recoverySize > 0)
    details.push("导出当前恢复内容后丢弃自动恢复记录");
  for (const slot of slots.slice(0, 3))
    details.push(`导出并删除命名档案「${slot.name}」（约 ${slot.chars} 字）`);
  if (details.length === 0) details.push("导出不需要的本地数据后重试");
  return {
    isQuota: true,
    message:
      "浏览器本地空间不足，自动保存已暂停。请先导出重要调查，或按下方建议清理后重试，命名档案不会被自动删除。",
    details,
  };
}
