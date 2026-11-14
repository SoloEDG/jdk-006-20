import type {
  AutoRecovery,
  CaseContent,
  CaseSnapshot,
  NoteDraft,
} from "../../../shared/types";
import { validateSnapshot } from "../../profiles/lib/codec";

export interface LegacyRecovery {
  caseId?: unknown;
  savedAt?: unknown;
  snapshot?: unknown;
  drafts?: unknown;
}

function drafts(input: unknown, noteIds: Set<string>): NoteDraft[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("草稿必须是列表");
  const out: NoteDraft[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object")
      throw new Error("草稿格式无效");
    const d = item as Record<string, unknown>;
    if (typeof d.noteId !== "string" || !d.noteId)
      throw new Error("草稿缺少笔记编号");
    if (typeof d.text !== "string") throw new Error("草稿必须是文字");
    if (!noteIds.has(d.noteId)) throw new Error("草稿对应的笔记不存在");
    if (seen.has(d.noteId)) throw new Error("同一篇笔记存在多份草稿");
    seen.add(d.noteId);
    out.push({ noteId: d.noteId, text: d.text });
  }
  return out;
}

function finish(
  caseId: string,
  savedAt: number,
  snapshot: CaseSnapshot,
  rawDrafts: unknown,
): AutoRecovery {
  if (!Number.isFinite(savedAt) || savedAt < 0)
    throw new Error("恢复记录时间无效");
  const noteIds = new Set(snapshot.evidence.notes.map((note) => note.id));
  return {
    version: 1,
    caseId,
    savedAt,
    snapshot,
    drafts: drafts(rawDrafts, noteIds),
  };
}

export function createRecovery(
  content: CaseContent,
  snapshot: CaseSnapshot,
  draftList: NoteDraft[],
  now: number = Date.now(),
): AutoRecovery {
  const checked = validateSnapshot(snapshot, content);
  const noteIds = new Set(checked.evidence.notes.map((note) => note.id));
  const cleaned = draftList
    .filter((draft) => {
      if (!noteIds.has(draft.noteId) || !draft.text.trim()) return false;
      const committed =
        checked.evidence.notes.find((note) => note.id === draft.noteId)?.text ??
        "";
      return draft.text !== committed;
    })
    .map((draft) => ({ noteId: draft.noteId, text: draft.text }));
  if (new Set(cleaned.map((draft) => draft.noteId)).size !== cleaned.length)
    throw new Error("同一篇笔记存在多份草稿");
  return finish(content.id, now, checked, cleaned);
}

export function validateRecovery(
  input: unknown,
  content: CaseContent,
): AutoRecovery {
  const root =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  if (!root) throw new Error("恢复记录格式无效");
  if (root.version !== 1) throw new Error("不支持的恢复记录版本");
  if (root.caseId !== content.id) throw new Error("恢复记录不属于当前案件");
  const snapshot = validateSnapshot(root.snapshot, content);
  return finish(
    content.id,
    typeof root.savedAt === "number" ? root.savedAt : Date.now(),
    snapshot,
    root.drafts,
  );
}

/** 迁移旧版恢复记录：直接以旧快照为已提交状态，草稿字段可选。 */
export function migrateLegacyRecovery(
  input: unknown,
  content: CaseContent,
): AutoRecovery {
  const root =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as LegacyRecovery)
      : null;
  if (!root || !root.snapshot) throw new Error("旧恢复记录缺少调查快照");
  const snapshot = validateSnapshot(root.snapshot, content);
  const savedAt =
    typeof root.savedAt === "number" && Number.isFinite(root.savedAt)
      ? root.savedAt
      : Date.now();
  let rawDrafts: unknown = root.drafts;
  const legacy = root as Record<string, unknown>;
  if (rawDrafts === undefined && legacy.noteDrafts !== undefined)
    rawDrafts = legacy.noteDrafts;
  if (rawDrafts !== undefined && !Array.isArray(rawDrafts))
    throw new Error("旧恢复记录的草稿格式无效");
  const migrated: unknown[] = (rawDrafts as unknown[] | undefined)?.map(
    (item) => {
      if (!item || typeof item !== "object")
        throw new Error("旧恢复记录的草稿格式无效");
      const d = item as Record<string, unknown>;
      const noteId = d.noteId ?? d.id;
      const text = d.text ?? d.draft ?? "";
      return { noteId, text: typeof text === "string" ? text : "" };
    },
  ) ?? [];
  return finish(content.id, savedAt, snapshot, migrated);
}
