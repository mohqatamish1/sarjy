import { useLocale } from "@/lib/locale";
import type { FormEvent } from "react";
import { Brain, Check, Plus, Trash2 } from "lucide-react";
import type { Memory } from "@/lib/api";

type Props = {
  memories: Memory[];
  memoryDraft: string;
  setMemoryDraft: (draft: string) => void;
  busy: boolean;
  addMemory: (event: FormEvent) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;
};

export function MemoryView({
  memories,
  memoryDraft,
  setMemoryDraft,
  busy,
  addMemory,
  removeMemory,
}: Props) {
  const { t } = useLocale();
  return (
    <div className="collection-view">
      <span className="page-symbol">
        <Brain size={25} />
      </span>
      <h1>{t("A little more you.")}</h1>
      <p className="collection-intro">
        {t(
          "Sarjy remembers useful details as you talk, like your name and preferences. You can add or remove anything here.",
        )}
      </p>
      <form className="memory-form" onSubmit={addMemory}>
        <label htmlFor="memory">{t("Something to remember")}</label>
        <textarea
          id="memory"
          value={memoryDraft}
          onChange={(e) => setMemoryDraft(e.target.value)}
          placeholder={t("I enjoy quiet cafés and long walks…")}
          maxLength={500}
          required
          rows={3}
        />
        <div>
          <span>{memoryDraft.length}/500</span>
          <button className="primary" disabled={busy || !memoryDraft.trim()}>
            <Plus size={16} />
            {t("Save memory")}
          </button>
        </div>
      </form>
      <div className="memory-list">
        {memories.length ? (
          memories.map((item) => (
            <article key={item.id}>
              <span className="memory-check">
                <Check size={16} />
              </span>
              <p dir="auto">{item.content}</p>
              <button
                className="icon-button"
                aria-label={`${t("Forget")}: ${item.content}`}
                disabled={busy}
                onClick={() => removeMemory(item.id)}
              >
                <Trash2 size={16} />
              </button>
            </article>
          ))
        ) : (
          <p className="empty-hint">
            {t("Tell Sarjy a little about yourself, or add a memory here.")}
          </p>
        )}
      </div>
      <p className="small muted">
        {t(
          "Memory is shared across conversations in this browser. Removing a memory stops its use in future replies; past conversation messages are kept until you delete them.",
        )}
      </p>
    </div>
  );
}
