import { useLocale } from "@/lib/locale";
import {
  Brain,
  CalendarCheck,
  Headphones,
  MessageCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Brand } from "./brand";
import type { Conversation } from "@/lib/api";

export type View = "chat" | "memory" | "plans";

type Props = {
  sidebar: boolean;
  setSidebar: (open: boolean) => void;
  view: View;
  nav: (view: View) => void;
  locked: boolean;
  conversations: Conversation[];
  selectedId: string | null;
  memoryCount: number;
  planCount: number;
  search: string;
  setSearch: (search: string) => void;
  newConversation: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
};

export function Sidebar({
  sidebar,
  setSidebar,
  view,
  nav,
  locked,
  conversations,
  selectedId,
  memoryCount,
  planCount,
  search,
  setSearch,
  newConversation,
  openConversation,
}: Props) {
  const { t } = useLocale();
  return (
    <aside
      className={`sidebar ${sidebar ? "is-open" : ""}`}
      aria-label={t("Main navigation")}
    >
      <div className="sidebar-brand">
        <Brand />
        <button
          className="icon-button mobile-only"
          aria-label={t("Close navigation")}
          onClick={() => setSidebar(false)}
        >
          <X size={20} />
        </button>
      </div>
      <button
        className="new-chat"
        aria-label={t("New conversation")}
        onClick={newConversation}
        disabled={locked}
      >
        <Plus size={18} />
        {t("New conversation")}
        <span>+</span>
      </button>
      <nav className="main-nav">
        <button
          className={view === "chat" ? "active" : ""}
          disabled={locked}
          onClick={() => nav("chat")}
        >
          <MessageCircle size={18} />
          {t("Conversation")}
        </button>
        <button
          className={view === "memory" ? "active" : ""}
          disabled={locked}
          onClick={() => nav("memory")}
        >
          <Brain size={18} />
          {t("Memory")}
          <span className="nav-count">{memoryCount}</span>
        </button>
        <button
          className={view === "plans" ? "active" : ""}
          disabled={locked}
          onClick={() => nav("plans")}
        >
          <CalendarCheck size={18} />
          {t("Saved plans")}
          {planCount > 0 && <span className="nav-count">{planCount}</span>}
        </button>
      </nav>
      <div className="history-heading">
        <h2>{t("Recent conversations")}</h2>
        <Search size={14} aria-hidden="true" />
      </div>
      {conversations.length > 4 && (
        <input
          className="history-search"
          aria-label={t("Search conversations")}
          placeholder={t("Find a conversation…")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <div className="history-list">
        {conversations
          .filter((item) =>
            item.title.toLowerCase().includes(search.toLowerCase()),
          )
          .map((item) => (
            <button
              key={item.id}
              className={
                selectedId === item.id && view === "chat" ? "selected" : ""
              }
              disabled={locked}
              onClick={() => openConversation(item.id)}
            >
              <MessageCircle size={14} />
              <span dir="auto">
                {item.title === "New conversation"
                  ? t("New conversation")
                  : item.title === "A new outing"
                    ? t("A new outing")
                    : item.title}
              </span>
            </button>
          ))}
      </div>
      <div className="sidebar-bottom">
        <div className="private-note">
          <span className="privacy-dot" />
          <span>{t("Just your space")}</span>
        </div>
        <p>
          {t("Conversations stay with this browser.")}
          <br />
          {t("Manage what Sarjy remembers.")}
        </p>
        <div className="profile">
          <span className="avatar">Y</span>
          <div>
            <strong>{t("Your workspace")}</strong>
            <span>{t("Personal assistant")}</span>
          </div>
          <Headphones size={17} />
        </div>
      </div>
    </aside>
  );
}
