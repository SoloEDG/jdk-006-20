import type {
  AutoRecovery,
  CaseContent,
  CaseSnapshot,
  NoteDraft,
} from "../../../shared/types";
import { createRecovery } from "../model/recovery";
import {
  isQuotaError,
  writeRecovery,
  type StoragePort,
} from "./storage";

export interface RecoverableBundle {
  snapshot: CaseSnapshot;
  drafts: NoteDraft[];
}

export interface AutoSaverOptions {
  content: CaseContent;
  interval?: number;
  mergeWindow?: number;
  storage?: StoragePort;
  now?: () => number;
  getBundle?: () => RecoverableBundle | null;
}

export type AutoSaveStatus = "idle" | "active" | "paused";

/** Node 环境下定时器持有 unref，浏览器中不存在，用鸭子类型安全调用。 */
function unrefTimer(handle: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>) {
  const nodeHandle = handle as unknown as { unref?: () => void };
  nodeHandle.unref?.();
}

export interface AutoSaveState {
  status: AutoSaveStatus;
  savedAt: number | null;
  quota: boolean;
  error: string | null;
}

export class RecoveryAutoSaver {
  private readonly content: CaseContent;
  private readonly interval: number;
  private readonly mergeWindow: number;
  private readonly storage: StoragePort | undefined;
  private readonly now: () => number;
  private readonly getBundle: (() => RecoverableBundle | null) | undefined;
  private bundle: RecoverableBundle | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private mergeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWritten: string | null = null;
  private engaged = false;
  private state: AutoSaveState = {
    status: "idle",
    savedAt: null,
    quota: false,
    error: null,
  };
  private listeners = new Set<(state: AutoSaveState) => void>();

  constructor(options: AutoSaverOptions) {
    this.content = options.content;
    this.interval = options.interval ?? 5000;
    this.mergeWindow = options.mergeWindow ?? 1500;
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
    this.getBundle = options.getBundle;
  }

  subscribe(listener: (state: AutoSaveState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 返回缓存的状态对象（仅在 emit 时整体替换），满足 useSyncExternalStore 的引用稳定要求。 */
  getState(): AutoSaveState {
    return this.state;
  }

  private emit(patch: Partial<AutoSaveState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** 用户开始或切换调查路线后启用定时写入。 */
  start(bundle?: RecoverableBundle) {
    if (bundle !== undefined) this.bundle = bundle;
    this.engaged = true;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush(false);
    }, this.interval);
    unrefTimer(this.timer);
    if (this.state.status === "idle")
      this.emit({ status: "active", error: null });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    this.timer = null;
    this.mergeTimer = null;
  }

  /** 丢弃路线后停用，直到下一次交互再启用。 */
  deactivate() {
    this.stop();
    this.engaged = false;
    this.lastWritten = null;
    this.bundle = null;
    this.emit({ status: "idle", savedAt: null, quota: false, error: null });
  }

  /** 内容变化：连续编辑在合并窗口内合并为一次写入。 */
  notifyChange(bundle?: RecoverableBundle) {
    if (bundle !== undefined) this.bundle = bundle;
    if (!this.engaged || this.state.status === "paused") return;
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = null;
      void this.flush(false);
    }, this.mergeWindow);
    unrefTimer(this.mergeTimer);
    if (this.state.status === "idle") this.emit({ status: "active" });
  }

  private resolveBundle(): RecoverableBundle | null {
    return this.getBundle ? this.getBundle() : this.bundle;
  }

  private buildRecord(): AutoRecovery | null {
    const bundle = this.resolveBundle();
    if (!bundle) return null;
    return createRecovery(
      this.content,
      bundle.snapshot,
      bundle.drafts,
      this.now(),
    );
  }

  /** 立即写入。force 用于切换路线、页面隐藏等必须落盘的时刻。 */
  async flush(force: boolean): Promise<boolean> {
    if (!this.engaged) return false;
    if (!force && this.state.status === "paused") return false;
    if (this.mergeTimer) {
      clearTimeout(this.mergeTimer);
      this.mergeTimer = null;
    }
    const record = this.buildRecord();
    if (!record) return false;
    const text = JSON.stringify(record);
    if (!force && text === this.lastWritten) return true;
    try {
      if (this.storage) writeRecovery(record, this.storage);
      else writeRecovery(record);
      this.lastWritten = text;
      this.emit({
        status: "active",
        savedAt: record.savedAt,
        quota: false,
        error: null,
      });
      return true;
    } catch (error) {
      const quota = isQuotaError(error);
      this.stop();
      this.emit({
        status: "paused",
        quota,
        error: error instanceof Error ? error.message : "自动保存失败",
      });
      return false;
    }
  }

  /** 清理后重试：恢复定时器并强制写入一次。 */
  async retry(bundle?: RecoverableBundle): Promise<boolean> {
    if (bundle !== undefined) this.bundle = bundle;
    this.engaged = true;
    this.stop();
    this.timer = setInterval(() => {
      void this.flush(false);
    }, this.interval);
    unrefTimer(this.timer);
    this.emit({ status: "active", quota: false, error: null });
    return this.flush(true);
  }

  /** 重置基线：丢弃“内容未变化”的记忆，切换路线后下次一定重新写入。 */
  resetBaseline() {
    this.lastWritten = null;
  }
}
