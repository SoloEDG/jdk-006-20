import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AutoRecovery,
  CaseSnapshot,
  HeardHistory,
  NoteDraft,
  SaveSlot,
  SceneId,
  EvidenceNote,
  Cue,
} from "../shared/types";
import {
  CASE_CONTENT,
  createInvestigation,
  enterScene,
  applyChoice,
  resolveEpisode,
} from "../features/story";
import { useTransport, recordPosition } from "../features/listening";
import {
  createEvidence,
  addNote,
  collectClue,
  editNote,
  deleteNote,
  togglePinned,
} from "../features/evidence";
import {
  readSlots,
  createSnapshot,
  createSlot,
  writeSlot,
  deleteSlot,
  parseImported,
  exportSlot,
  validateSnapshot,
} from "../features/profiles";
import {
  RecoveryAutoSaver,
  readRecovery,
  clearRecovery,
  clearQuarantine,
  quotaAdvice,
  type QuarantineEntry,
  type QuotaAdvice,
  type RecoverableBundle,
} from "../features/recovery";

const bootRecovery = readRecovery(CASE_CONTENT);

export function useCase() {
  const [boot] = useState(() => readSlots(CASE_CONTENT));
  const [story, setStory] = useState(createInvestigation),
    [evidence, setEvidence] = useState(createEvidence),
    [heard, setHeard] = useState<HeardHistory>({}),
    [slots, setSlots] = useState<SaveSlot[]>(boot.slots),
    [activeId, setActiveId] = useState<string | null>(null),
    [notice, setNotice] = useState(
      [boot.warning, bootRecovery.warning].filter(Boolean).join(" ") ||
        "戴上耳机，从第一通来电开始调查。",
    ),
    [dirty, setDirty] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null),
    [draftText, setDraftText] = useState(""),
    [drafts, setDrafts] = useState<NoteDraft[]>([]);
  const [recoveryPrompt, setRecoveryPrompt] = useState<AutoRecovery | null>(
    bootRecovery.recovery,
  );
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(
    bootRecovery.warning,
  );
  const [quarantine, setQuarantine] = useState<QuarantineEntry[]>(
    bootRecovery.quarantine,
  );
  const [advice, setAdvice] = useState<QuotaAdvice | null>(null);
  const [evidenceFocus, setEvidenceFocus] = useState(0);

  const episode = resolveEpisode(CASE_CONTENT, story.sceneId, evidence.clues);

  // 始终保存最新状态，供自动保存引擎和卸载前刷写读取
  const live = useRef({ story, evidence, heard, drafts });
  live.current = { story, evidence, heard, drafts };
  const audioRef = useRef<{ position: number; rate: number }>({
    position: 0,
    rate: 1,
  });

  const getBundle = useCallback((): RecoverableBundle | null => {
    const state = live.current;
    const snapshot = createSnapshot(
      CASE_CONTENT,
      state.story,
      state.evidence,
      state.heard,
      {
        sceneId: state.story.sceneId,
        position: audioRef.current.position,
        rate: audioRef.current.rate,
      },
    );
    return { snapshot, drafts: state.drafts };
  }, []);

  const saverRef = useRef<RecoveryAutoSaver | null>(null);
  if (!saverRef.current)
    saverRef.current = new RecoveryAutoSaver({
      content: CASE_CONTENT,
      getBundle,
    });
  const saver = saverRef.current;
  const autoSave = useSyncExternalStore(
    (onChange) => saver.subscribe(onChange),
    () => saver.getState(),
  );

  const markChanged = useCallback(() => {
    setDirty(true);
    saver.start();
    saver.notifyChange();
  }, [saver]);

  const onHeard = useCallback(
    (id: string, position: number) => {
      audioRef.current.position = position;
      setHeard((h) => recordPosition(h, id, position));
    },
    [],
  );
  const audio = useTransport(episode, onHeard);
  audioRef.current.rate = audio.view.rate;
  useEffect(() => {
    audioRef.current.position = audio.view.position;
  }, [audio.view.position]);
  useEffect(() => {
    if (audio.view.playing) {
      saver.start();
      saver.notifyChange();
    }
  }, [audio.view.playing, saver]);

  // 页面隐藏或卸载前尽量把当前路线落盘
  useEffect(() => {
    const flush = () => {
      void saver.flush(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      saver.stop();
    };
  }, [saver]);

  // 自动保存暂停后生成清理建议
  useEffect(() => {
    if (autoSave.status === "paused" && autoSave.quota) {
      const slotInfo = slots.map((slot) => ({
        name: slot.name,
        chars: JSON.stringify(slot).length,
      }));
      setAdvice(quotaAdvice(undefined, slotInfo));
    } else if (autoSave.status !== "paused") {
      setAdvice(null);
    }
  }, [autoSave.status, autoSave.quota, slots]);

  const run = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "操作未完成，请重试");
    }
  };

  const applySnapshot = useCallback(
    (snap: CaseSnapshot) => {
      const nextEpisode = resolveEpisode(
        CASE_CONTENT,
        snap.story.sceneId,
        snap.evidence.clues,
      );
      audio.pause();
      if (nextEpisode.id !== episode.id) {
        audio.queueSeek(snap.resume.position);
        audio.queueRate(snap.resume.rate);
      }
      setStory(snap.story);
      setEvidence(snap.evidence);
      setHeard(snap.heard);
      audioRef.current.position = snap.resume.position;
      audioRef.current.rate = snap.resume.rate;
      setDirty(false);
      if (nextEpisode.id === episode.id) {
        audio.seek(snap.resume.position);
        audio.setRate(snap.resume.rate);
      }
    },
    [audio, episode.id],
  );

  const go = (id: SceneId, position = 0) => {
    audio.pause();
    if (id === story.sceneId) {
      audio.seek(position);
    } else {
      audio.queueSeek(position);
    }
    if (id !== story.sceneId) setStory((s) => enterScene(CASE_CONTENT, s, id));
    markChanged();
  };
  const choose = (id: string) =>
    run(() => {
      const next = applyChoice(CASE_CONTENT, story, id, evidence.clues);
      audio.pause();
      audio.queueSeek(0);
      setStory(next);
      markChanged();
      setNotice(
        next.ending
          ? "你已还原案件。仍可回听录音、整理证据。"
          : "调查方向已更新，点击播放继续收听。",
      );
    });
  const note = () => {
    const anchor = audio.captureRange(story.sceneId, 5);
    if (!anchor) {
      setNotice("请等待录音载入后再标记");
      return;
    }
    setEvidence((s) => addNote(s, anchor, "在这里写下你的观察…", "声音标记"));
    markChanged();
    setNotice("已记录最近五秒，可在笔记中编辑或回听。");
  };
  const collect = (cue: Cue) => {
    const anchor = audio.captureRange(
      story.sceneId,
      Math.max(
        1,
        (cue.sound?.end || cue.end) - (cue.sound?.start || cue.start),
      ),
    );
    if (!anchor) return;
    const sound = cue.sound;
    const result = collectClue(evidence, episode, cue, heard, {
      ...anchor,
      start: sound?.start ?? cue.start,
      end: sound?.end ?? cue.end,
    });
    if (!result) {
      setNotice("请先听完这段声音，或检查是否已收集。");
      return;
    }
    audio.pause();
    setEvidence(result);
    markChanged();
    setNotice("声音线索已归档，对话可能因此发生变化。");
  };
  const jump = (n: EvidenceNote) => {
    go(n.anchor.sceneId, n.anchor.start);
    setNotice(`已定位到「${n.title}」对应声音，点击播放回听。`);
  };

  // —— 笔记草稿：未提交内容只存在于草稿区，不覆盖正式笔记 ——
  const startEdit = (id: string) => {
    const pending = drafts.find((draft) => draft.noteId === id)?.text;
    const committed = evidence.notes.find((note) => note.id === id)?.text ?? "";
    setEditingId(id);
    setDraftText(pending ?? committed);
  };
  const changeDraft = (id: string, text: string) => {
    setDraftText(text);
    setDrafts((list) => {
      const rest = list.filter((draft) => draft.noteId !== id);
      const committed =
        evidence.notes.find((note) => note.id === id)?.text ?? "";
      if (text === committed) return rest;
      return [...rest, { noteId: id, text }];
    });
    saver.start();
    saver.notifyChange();
  };
  const submitEdit = (id: string) => {
    if (!draftText.trim()) return;
    setEvidence((s) => editNote(s, id, draftText));
    setDrafts((list) => list.filter((draft) => draft.noteId !== id));
    setEditingId(null);
    setDraftText("");
    markChanged();
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraftText("");
  };

  const save = (name: string) =>
    run(() => {
      const snapshot = createSnapshot(CASE_CONTENT, story, evidence, heard, {
        sceneId: story.sceneId,
        position: audio.view.position,
        rate: audio.view.rate,
      });
      const old = slots.find((s) => s.id === activeId);
      const slot =
        old && name === old.name
          ? { ...old, updatedAt: Date.now(), snapshot }
          : createSlot(name, snapshot);
      const next = writeSlot(slots, slot);
      setSlots(next);
      setActiveId(slot.id);
      setDirty(false);
      setNotice(`调查进度「${slot.name}」已保存。`);
    });

  const beginRoute = useCallback(
    (nextDrafts: NoteDraft[]) => {
      setDrafts(nextDrafts);
      setEditingId(null);
      setDraftText("");
      saver.resetBaseline();
      saver.start();
      saver.notifyChange();
    },
    [saver],
  );

  const load = (id: string) =>
    run(() => {
      const slot = slots.find((s) => s.id === id);
      if (!slot) throw new Error("存档不存在");
      const snap = validateSnapshot(slot.snapshot, CASE_CONTENT);
      // 切换档案前完成当前路线的自动提交
      void saver.flush(true);
      applySnapshot(snap);
      setActiveId(id);
      beginRoute([]);
      setNotice(`已载入「${slot.name}」，点击播放继续调查。`);
    });
  const importText = (text: string) =>
    run(() => {
      const slot = parseImported(text, CASE_CONTENT);
      setSlots(writeSlot(slots, slot));
      setNotice("导入成功，已另存为独立调查进度。");
    });
  const download = (id: string) =>
    run(() => {
      const s = slots.find((s) => s.id === id);
      if (!s) throw new Error("存档不存在");
      const blob = new Blob([exportSlot(s)], { type: "application/json" }),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = `雾港来电-${s.name}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  // —— 启动时的恢复选择 ——
  const resumeRecovery = () =>
    run(() => {
      const record = recoveryPrompt;
      if (!record) return;
      applySnapshot(record.snapshot);
      const nextDrafts = record.drafts.filter((draft) =>
        record.snapshot.evidence.notes.some((note) => note.id === draft.noteId),
      );
      beginRoute(nextDrafts);
      const first = nextDrafts[0];
      if (first) {
        setEditingId(first.noteId);
        setDraftText(first.text);
        setEvidenceFocus((n) => n + 1);
      }
      setRecoveryPrompt(null);
      setQuarantine([]);
      setNotice(
        first
          ? "已恢复上次调查，并回到未提交的笔记编辑状态。"
          : "已恢复上次调查，点击播放继续。",
      );
    });
  const discardRecovery = () => {
    clearRecovery();
    clearQuarantine();
    saver.deactivate();
    setRecoveryPrompt(null);
    setRecoveryWarning(null);
    setQuarantine([]);
    setNotice("已丢弃未完成的自动恢复记录，命名存档保持不变。");
  };

  const retryAutoSave = () => {
    void saver.retry();
  };

  return {
    story,
    evidence,
    heard,
    slots,
    activeId,
    notice,
    dirty,
    episode,
    audio,
    autoSave,
    autoSaveAdvice: advice,
    recoveryPrompt,
    recoveryWarning,
    quarantine,
    editingId,
    draftText,
    draftIds: drafts.map((draft) => draft.noteId),
    evidenceFocus,
    go,
    choose,
    note,
    collect,
    jump,
    save,
    load,
    importText,
    download,
    resumeRecovery,
    discardRecovery,
    retryAutoSave,
    startEdit,
    changeDraft,
    submitEdit,
    cancelEdit,
    remove: (id: string) => {
      setEvidence((s) => deleteNote(s, id));
      setDrafts((list) => list.filter((draft) => draft.noteId !== id));
      if (editingId === id) {
        setEditingId(null);
        setDraftText("");
      }
      markChanged();
    },
    pin: (id: string) => {
      setEvidence((s) => togglePinned(s, id));
      markChanged();
    },
    removeSlot: (id: string) =>
      run(() => {
        setSlots(deleteSlot(slots, id));
        if (activeId === id) setActiveId(null);
      }),
    reset: () => {
      // 新调查前完成本路线提交
      void saver.flush(true);
      audio.pause();
      if (story.sceneId !== "arrival") audio.queueSeek(0);
      setStory(createInvestigation());
      setEvidence(createEvidence());
      setHeard({});
      setActiveId(null);
      setDrafts([]);
      setEditingId(null);
      setDraftText("");
      setDirty(false);
      audioRef.current.position = 0;
      audioRef.current.rate = 1;
      saver.deactivate();
      if (story.sceneId === "arrival") audio.seek(0);
      setNotice("已开始一条独立调查路线，已有存档保持不变。");
    },
  };
}
