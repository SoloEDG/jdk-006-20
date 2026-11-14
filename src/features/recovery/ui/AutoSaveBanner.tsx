import { AlertTriangle, CheckCircle2, PauseCircle, RotateCcw } from "lucide-react";
import type { AutoSaveState } from "../lib/RecoveryAutoSaver";
import type { QuotaAdvice } from "../lib/storage";

interface Props {
  state: AutoSaveState;
  advice: QuotaAdvice | null;
  onRetry: () => void;
}

export function AutoSaveBanner({ state, advice, onRetry }: Props) {
  if (state.status === "idle") return null;
  if (state.status === "paused") {
    return (
      <div className="autosave-banner paused" role="alert">
        <AlertTriangle size={14} />
        <div>
          <p>{state.quota && advice ? advice.message : state.error}</p>
          {state.quota && advice && advice.details.length > 0 && (
            <ul>
              {advice.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
        <button onClick={onRetry}>
          <RotateCcw size={13} /> 重试自动保存
        </button>
      </div>
    );
  }
  return (
    <div className="autosave-banner active">
      {state.savedAt ? <CheckCircle2 size={13} /> : <PauseCircle size={13} />}
      <span>
        {state.savedAt
          ? `自动保存于 ${new Date(state.savedAt).toLocaleTimeString("zh-CN", { hour12: false })}，不占用命名存档档位`
          : "调查变化将自动保存"}
      </span>
    </div>
  );
}
