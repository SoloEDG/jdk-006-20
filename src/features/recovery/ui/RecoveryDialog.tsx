import { History, RotateCcw, Trash2, AlertTriangle } from "lucide-react";
import type { AutoRecovery } from "../../../shared/types";
import type { QuarantineEntry } from "../lib/storage";

interface Props {
  recovery: AutoRecovery;
  warning: string | null;
  quarantine: QuarantineEntry[];
  onResume: () => void;
  onDiscard: () => void;
}

const stamp = (time: number) =>
  new Date(time).toLocaleString("zh-CN", { hour12: false });

export function RecoveryDialog({
  recovery,
  warning,
  quarantine,
  onResume,
  onDiscard,
}: Props) {
  const draftCount = recovery.drafts.length;
  return (
    <div className="modal-backdrop">
      <section
        className="profiles-dialog recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">UNFINISHED INVESTIGATION</span>
            <h2 id="recovery-title">
              <History size={20} /> 恢复上次调查
            </h2>
          </div>
        </header>
        <p className="panel-description">
          浏览器上次关闭时，这条调查路线还在进行中。自动恢复记录独立于命名存档，不会占用八个存档档位。
        </p>
        <article className="profile-card active recovery-summary">
          <h3>未命名的调查路线</h3>
          <p>
            自动保存于 {stamp(recovery.savedAt)} ·{" "}
            {recovery.snapshot.evidence.clues.length} 条线索 ·{" "}
            {recovery.snapshot.evidence.notes.length} 篇笔记
            {draftCount > 0 && ` · ${draftCount} 篇笔记含未提交草稿`}
          </p>
          {draftCount > 0 && (
            <p className="recovery-draft-note">
              恢复后会回到原篇笔记的编辑状态，草稿不会覆盖正式笔记，也不会提前授予证据。
            </p>
          )}
        </article>
        {warning && (
          <p className="inline-error recovery-warning" role="alert">
            <AlertTriangle size={13} /> {warning}
          </p>
        )}
        {quarantine.length > 0 && (
          <ul className="quarantine-list">
            {quarantine.map((entry, index) => (
              <li key={index}>
                {stamp(entry.savedAt)} 隔离：{entry.reason}
              </li>
            ))}
          </ul>
        )}
        <div className="recovery-actions">
          <button className="primary-button" onClick={onResume}>
            <RotateCcw size={15} /> 恢复这条路线
          </button>
          <button className="secondary-button" onClick={onDiscard}>
            <Trash2 size={15} /> 丢弃，开始新调查
          </button>
        </div>
      </section>
    </div>
  );
}
