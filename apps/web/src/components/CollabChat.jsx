// Floating live-chat panel for a collaboration session, pinned to the bottom
// left of the screen. It's a thin view over the transcript exposed by
// useCollaboration: the messages, who we are (to align our own bubbles), and
// sendChat. The panel only appears once we're actually collaborating — for the
// host that's a live session; for a guest that's after the host has admitted
// them (signalled by a non-empty participant roster).
//
// The transcript itself is ephemeral and lives in the collab hook; here we only
// keep view state: whether the panel is open, the in-progress draft, the
// scroll-to-newest anchor, and an unread count for while it's collapsed.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageCircleIcon, XIcon, SendIcon } from "lucide-react";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";
import { Avatar, AvatarImage, AvatarFallback } from "./ui/avatar.jsx";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip.jsx";
import { cn } from "../lib/utils.js";
import { colorForId } from "../lib/presence.js";

function initials(entry) {
  const src = entry.name || entry.email || "?";
  return src.trim().charAt(0).toUpperCase() || "?";
}

// Short clock label (e.g. "14:05") for a message timestamp.
function formatTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function CollabChat({ collab }) {
  const { t } = useTranslation("collab");
  const { status, role, participants, messages, myId, sendChat } = collab;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // How many messages we'd already shown when the panel was last open, so we can
  // badge the launcher with the number that have arrived since it was collapsed.
  const [seenCount, setSeenCount] = useState(0);
  const endRef = useRef(null);

  // We're in the chat-eligible state when collaborating: hosting a live session,
  // or a guest the host has added (a non-empty roster is our "admitted" signal).
  const admitted = role === "guest" && participants.length > 0;
  const eligible = status === "hosting" || (status === "joined" && admitted);

  // Keep the list scrolled to the newest message whenever it changes while open.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, open]);

  // While open, everything is considered read. (Also runs as new messages land.)
  useEffect(() => {
    if (open) setSeenCount(messages.length);
  }, [open, messages.length]);

  // When the session ends, fold the panel and reset its view state so a fresh
  // session starts clean.
  useEffect(() => {
    if (!eligible) {
      setOpen(false);
      setDraft("");
      setSeenCount(0);
    }
  }, [eligible]);

  if (!eligible) return null;

  const unread = Math.max(0, messages.length - seenCount);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    sendChat(text);
    setDraft("");
  };

  // Collapsed: a small launcher FAB with an unread badge. z-40 matches
  // AppHeader's sticky bar and FirstLessonWizard's fixed corner panel — this
  // floats alongside page content rather than as a modal overlay, so it only
  // needs to clear the header, not Dialog/Popover/DropdownMenu's z-50.
  if (!open) {
    return (
      <div className="fixed bottom-4 left-4 z-40">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-lg"
              className="relative rounded-full shadow-[var(--shadow-panel)]"
              onClick={() => setOpen(true)}
              aria-label={t("chat.openChat")}
            >
              <MessageCircleIcon />
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground ring-2 ring-background">
                  {unread > 99 ? t("chat.unreadOverflow") : unread}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("chat.openChat")}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-40 flex h-[420px] max-h-[calc(100vh-32px)] w-[calc(100vw-32px)] max-w-[360px] flex-col overflow-hidden rounded-panel border border-border bg-card text-card-foreground shadow-[var(--shadow-panel),0_0_0_1px_var(--glass-border-outer)] backdrop-blur-(--glass-blur) backdrop-saturate-[1.4] sm:w-80">
      {/* Header */}
      <div className="flex items-center gap-2 bg-primary px-3 py-2 text-primary-foreground">
        <MessageCircleIcon className="size-4" />
        <p className="flex-1 text-sm font-medium">{t("chat.title")}</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(false)}
              className="text-primary-foreground hover:bg-primary-foreground/10"
            >
              <XIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("chat.closeChat")}</TooltipContent>
        </Tooltip>
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto bg-muted p-3">
        {messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("chat.noMessages")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m) => {
              const mine = m.uid === myId;
              return (
                <div
                  key={m.id}
                  className={cn("flex gap-2", mine && "flex-row-reverse")}
                >
                  <Avatar
                    size="sm"
                    className={cn("size-7 shrink-0", mine && "bg-primary")}
                    style={
                      !mine ? { backgroundColor: colorForId(m.uid) } : undefined
                    }
                  >
                    <AvatarImage
                      src={m.avatarUrl}
                      alt={m.name || t("chat.collaboratorFallback")}
                    />
                    <AvatarFallback
                      className={cn("text-xs text-white", mine && "bg-primary")}
                      style={
                        !mine
                          ? { backgroundColor: colorForId(m.uid) }
                          : undefined
                      }
                    >
                      {initials(m)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 max-w-[75%]">
                    <p
                      className={cn(
                        "text-xs text-muted-foreground",
                        mine ? "text-right" : "text-left",
                      )}
                    >
                      {mine
                        ? t("chat.you")
                        : m.name || t("chat.collaboratorFallback")}{" "}
                      · {formatTime(m.ts)}
                    </p>
                    <div
                      className={cn(
                        "rounded-xl px-3 py-1.5 text-sm break-words whitespace-pre-wrap",
                        mine
                          ? "bg-primary text-primary-foreground"
                          : "border border-border bg-card text-card-foreground",
                      )}
                    >
                      {m.text}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex items-start gap-2 border-t border-border p-2">
        <Input
          autoFocus
          placeholder={t("chat.messagePlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={2000}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={submit}
                disabled={!draft.trim()}
                className="text-primary"
              >
                <SendIcon className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("chat.send")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
