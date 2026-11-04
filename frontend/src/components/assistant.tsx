"use client";

import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Brain,
  CalendarCheck,
  ChevronRight,
  Menu,
  Plus,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Sidebar, type View } from "./sidebar";
import { ConversationView } from "./conversation-view";
import { MemoryView } from "./memory-view";
import { PlansView } from "./plans-view";
import { WorkflowPanel } from "./workflow-panel";
import { api, Conversation, Detail, Memory, Plan, Session } from "@/lib/api";
import { useLocale } from "@/lib/locale";
import { friendlyError } from "@/lib/errors";
import { useAudio } from "@/hooks/use-audio";
import { useVoiceSession } from "@/hooks/use-voice-session";

export function Assistant() {
  const { locale, setLocale, t } = useLocale();
  const [session, setSession] = useState<Session | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [view, setView] = useState<View>("chat");
  const [draft, setDraft] = useState("");
  const [memoryDraft, setMemoryDraft] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [showPlanner, setShowPlanner] = useState(false);
  // Voice is the default response; text remains an accessible fallback.
  const [autoSpeak, setAutoSpeak] = useState(true);
  const selected = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const init = useRef(false);
  const pendingSend = useRef<{
    conversationId: string;
    content: string;
    requestId: string;
  } | null>(null);
  const audio = useAudio();
  const voice = useVoiceSession(audio, async (text) => {
    const reply = await send(text, true);
    if (!reply)
      throw new Error(
        "The conversation isn't ready. Try starting voice chat again.",
      );
    return reply;
  });
  const locked =
    busy ||
    loading ||
    voice.active ||
    audio.recording ||
    audio.transcribing ||
    audio.requesting;

  // Refresh all persisted views after a successful mutation.
  async function refresh(id = selected.current) {
    const [list, memoryList, planList, current] = await Promise.all([
      api<Conversation[]>("/conversations"),
      api<Memory[]>("/memories"),
      api<Plan[]>("/plans"),
      id ? api<Detail>(`/conversations/${id}`) : Promise.resolve(null),
    ]);
    setConversations(list);
    setMemories(memoryList);
    setPlans(planList);
    if (id === selected.current) setDetail(current);
  }

  async function openConversation(id: string) {
    voice.end();
    selected.current = id;
    setView("chat");
    setSidebar(false);
    setLoading(true);
    setError(null);
    setDraft("");
    window.speechSynthesis?.cancel();
    try {
      const current = await api<Detail>(`/conversations/${id}`);
      if (selected.current === id) setDetail(current);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      if (selected.current === id) setLoading(false);
    }
  }

  async function newConversation() {
    setBusy(true);
    setError(null);
    try {
      const conversation = await api<Conversation>("/conversations", {
        method: "POST",
      });
      setConversations((current) => [conversation, ...current]);
      await openConversation(conversation.id);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (init.current) return;
    init.current = true;
    async function initialize() {
      try {
        // Bootstrap the HttpOnly identity cookie before issuing parallel requests.
        const info = await api<Session>("/session");
        setSession(info);
        const list = await api<Conversation[]>("/conversations");
        const conversation =
          list[0] ||
          (await api<Conversation>("/conversations", { method: "POST" }));
        selected.current = conversation.id;
        await refresh(conversation.id);
      } catch (cause) {
        setError(friendlyError(cause));
      } finally {
        setLoading(false);
      }
    }
    void initialize();
    // The identity bootstrap runs once; subsequent refreshes use the active ID ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages.length, busy]);

  async function send(text = draft, voiceTurn = false, retryId?: string) {
    if (!text.trim() || !detail || busy || loading || (!voiceTurn && locked))
      return;
    if (!voiceTurn && autoSpeak) audio.unlock();
    const content = text.trim();
    // Keep the same ID on retry: a lost refresh must not create a second turn.
    const previous = pendingSend.current;
    const requestId =
      retryId ||
      (previous?.conversationId === detail.id && previous.content === content
        ? previous.requestId
        : crypto.randomUUID());
    pendingSend.current = { conversationId: detail.id, content, requestId };
    setBusy(true);
    setError(null);
    if (!voiceTurn) setDraft("");
    try {
      const reply = await api<Detail["messages"][number]>(
        `/conversations/${detail.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content,
            request_id: requestId,
            language: "auto",
          }),
        },
      );
      await refresh();
      if (reply.kind !== "error") pendingSend.current = null;
      if (!voiceTurn && autoSpeak && reply.kind !== "error")
        void audio.speak(reply.id, reply.content);
      return reply;
    } catch (cause) {
      setError(friendlyError(cause));
      setDraft(text);
      if (voiceTurn) throw cause;
    } finally {
      setBusy(false);
      composer.current?.focus();
    }
  }

  async function startPlanner() {
    if (!detail || locked) return;
    setShowPlanner(true);
    setError(null);
    if (detail.workflow) return;
    // Give every starter-card click a visible, persisted result.
    await send(locale === "ar" ? "خطط لنزهة" : t("Plan an outing"));
  }

  async function addMemory(event: React.FormEvent) {
    event.preventDefault();
    if (!memoryDraft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("/memories", {
        method: "POST",
        body: JSON.stringify({ content: memoryDraft.trim() }),
      });
      setMemoryDraft("");
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeMemory(id: string) {
    setBusy(true);
    try {
      await api(`/memories/${id}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function removeConversation() {
    if (
      !detail ||
      !window.confirm(
        t(
          "Delete this conversation, its outing, and any saved plan from it? Your separate memories will be kept.",
        ),
      )
    )
      return;
    setBusy(true);
    try {
      await api(`/conversations/${detail.id}`, { method: "DELETE" });
      const remaining = conversations.filter((item) => item.id !== detail.id);
      if (remaining[0]) await openConversation(remaining[0].id);
      else {
        const next = await api<Conversation>("/conversations", {
          method: "POST",
        });
        await openConversation(next.id);
      }
      await refresh();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  }

  const today = session
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: session.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date())
    : new Date().toISOString().slice(0, 10);
  const nav = (target: View) => {
    voice.end();
    setView(target);
    setSidebar(false);
    setError(null);
  };

  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="mobile-scrim"
          aria-label={t("Close navigation")}
          onClick={() => setSidebar(false)}
        />
      )}
      <Sidebar
        sidebar={sidebar}
        setSidebar={setSidebar}
        view={view}
        nav={nav}
        locked={locked}
        conversations={conversations}
        selectedId={selected.current}
        memoryCount={memories.length}
        planCount={plans.length}
        search={search}
        setSearch={setSearch}
        newConversation={newConversation}
        openConversation={openConversation}
      />

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-only"
              aria-label={t("Open navigation")}
              onClick={() => setSidebar(true)}
            >
              <Menu size={21} />
            </button>
            <span>
              {view === "chat"
                ? t("Your assistant")
                : view === "memory"
                  ? t("Your memory")
                  : t("Your saved plans")}
            </span>
            <ChevronRight size={13} />
            <span className="topbar-subtitle">
              {t("A little help, out loud")}
            </span>
          </div>
          <div className="topbar-actions">
            <button
              className="language-toggle"
              aria-label={
                locale === "en" ? "Switch to Arabic" : "Switch to English"
              }
              onClick={() => setLocale(locale === "en" ? "ar" : "en")}
            >
              {locale === "en" ? "العربية" : "English"}
            </button>
            <button
              className={`voice-toggle ${autoSpeak ? "enabled" : ""}`}
              role="switch"
              aria-checked={autoSpeak}
              aria-label={t("Spoken replies")}
              disabled={voice.active}
              onClick={() => {
                setAutoSpeak(!autoSpeak);
                if (autoSpeak) window.speechSynthesis?.cancel();
                if (autoSpeak) audio.cancel();
              }}
            >
              {autoSpeak ? <Volume2 size={16} /> : <VolumeX size={16} />}
              <span>{t("Spoken replies")}</span>
              <i />
            </button>
          </div>
        </header>

        <div className="content-layout">
          <main
            className={`main-content ${view === "chat" ? "chat-view" : ""}`}
          >
            {(error || audio.error) && (
              <div
                role="alert"
                aria-label={t("Assistant error")}
                className="error-banner"
              >
                <span>{t(friendlyError(error || audio.error))}</span>
                <button
                  className="icon-button"
                  aria-label={t("Dismiss error")}
                  onClick={() => {
                    setError(null);
                    audio.setError(null);
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {loading ? (
              <div className="loading-state" role="status">
                <span className="loader" />
                {t("Opening your workspace…")}
              </div>
            ) : !session || !detail ? (
              <div className="empty-collection">
                <h1>{t("Let's reconnect.")}</h1>
                <p>
                  {t(
                    "We couldn’t open your conversations. Check your connection and try again.",
                  )}
                </p>
                <button
                  className="primary"
                  onClick={() => window.location.reload()}
                >
                  {t("Try again")}
                </button>
              </div>
            ) : view === "chat" ? (
              <ConversationView
                detail={detail}
                session={session}
                audio={audio}
                voice={voice}
                busy={busy}
                locked={locked}
                draft={draft}
                setDraft={setDraft}
                bottom={bottom}
                composer={composer}
                onSend={send}
                onRetry={(index) => {
                  const failed = detail.messages[index];
                  const original = detail.messages[index - 1];
                  if (original?.role === "user")
                    void send(original.content, false, failed.request_id);
                }}
                onDelete={removeConversation}
                onOpenMemory={() => nav("memory")}
                onOpenPlanner={() => void startPlanner()}
              />
            ) : view === "memory" ? (
              <MemoryView
                memories={memories}
                memoryDraft={memoryDraft}
                setMemoryDraft={setMemoryDraft}
                busy={busy}
                addMemory={addMemory}
                removeMemory={removeMemory}
              />
            ) : (
              <PlansView
                plans={plans}
                onOpenPlanner={() => {
                  nav("chat");
                  setShowPlanner(true);
                }}
              />
            )}
          </main>
          {view === "chat" && detail && session && (
            <aside
              id="planner"
              className={`context-panel ${showPlanner ? "planner-open" : ""}`}
            >
              <button
                className="icon-button close-planner"
                aria-label={t("Close outing planner")}
                onClick={() => setShowPlanner(false)}
              >
                <X size={18} />
              </button>
              <WorkflowPanel
                conversationId={detail.id}
                workflow={detail.workflow}
                changed={() => refresh()}
                fail={setError}
                today={today}
              />
              <div className="memory-preview">
                <div>
                  <Brain size={17} />
                  <h2>{t("A little about you")}</h2>
                  <button className="text-button" onClick={() => nav("memory")}>
                    {t("Manage")}
                  </button>
                </div>
                {memories.length ? (
                  <ul>
                    {memories.slice(0, 3).map((item) => (
                      <li key={item.id} dir="auto">
                        {item.content}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    {t("Your preferences, remembered.")}
                    <br />
                    {t("Useful details are remembered as we talk.")}
                  </p>
                )}
                <button className="memory-add" onClick={() => nav("memory")}>
                  <Plus size={14} />
                  {t("Add a memory")}
                </button>
              </div>
              <div className="context-footer">
                <AudioLines size={16} />
                <p>
                  {t("A conversation that picks up")}
                  <br />
                  {t("right where you left off.")}
                </p>
              </div>
            </aside>
          )}
        </div>
        {view === "chat" && (
          <button
            className="mobile-planner-button"
            onClick={() => setShowPlanner(!showPlanner)}
          >
            <CalendarCheck size={17} />
            {showPlanner ? t("Back to chat") : t("Outing planner")}
          </button>
        )}
      </div>
    </div>
  );
}
