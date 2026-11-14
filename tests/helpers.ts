import type { StoragePort } from "../src/features/recovery";

function quotaError(): Error {
  const error = new Error("quota");
  error.name = "QuotaExceededError";
  return error;
}

export class MemoryStorage implements StoragePort {
  private map = new Map<string, string>();
  private failing = false;
  private writesBeforeFail: number | null = null;
  private writeCount = 0;
  private readonly failKeyContains: string[];

  constructor(failKeyContains: string[] = []) {
    this.failKeyContains = failKeyContains;
  }

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.writeCount++;
    if (
      this.failing ||
      this.failKeyContains.some((part) => key.includes(part)) ||
      (this.writesBeforeFail !== null &&
        this.writeCount > this.writesBeforeFail)
    )
      throw quotaError();
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  /** 此后所有写入都抛配额错误。 */
  failAllWrites() {
    this.failing = true;
  }

  /** 此后前 n 次写入正常，之后抛配额错误，用于模拟写到一半中断。 */
  failAfterWrites(n: number) {
    this.writeCount = 0;
    this.writesBeforeFail = n;
  }

  corrupt(key: string) {
    this.map.set(key, "not-json{");
  }
}
