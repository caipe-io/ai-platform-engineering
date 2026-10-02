"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent } from "@/components/ui/card";
import {
Calendar,Clock,
ExternalLink,
Globe,
Hash,
Loader2,
Mail,
MessageSquare,
Shield,
ThumbsDown,
ThumbsUp,
User,
X,
} from "lucide-react";
import React,{ useEffect,useRef,useState } from "react";

interface UserProfile {
  email: string;
  name: string;
  avatar_url: string | null;
  role: string;
  source: string;
  slack_user_id: string | null;
  created_at: string;
  last_login: string;
}

interface UserStats {
  total_conversations: number;
  visible_conversations: number;
  feedback_given: number;
  feedback_positive: number;
  feedback_negative: number;
}

interface UserConversation {
  id: string;
  title: string;
  source: string;
  channel_id: string | null;
  channel_name: string | null;
  slack_permalink: string | null;
  webex_permalink: string | null;
  created_at: string;
  updated_at: string;
}

interface UserFeedback {
  source: string;
  rating: string;
  value: string;
  comment: string | null;
  channel_name: string | null;
  conversation_id: string | null;
  slack_permalink: string | null;
  created_at: string;
}

interface UserDetailData {
  can_view_conversations: boolean;
  profile: UserProfile;
  stats: UserStats;
  recent_conversations: UserConversation[];
  recent_feedback: UserFeedback[];
}

interface UserDetailPanelProps {
  email: string | null;
  onClose: () => void;
}

const VALUE_LABELS: Record<string, string> = {
  thumbs_up: "Thumbs up",
  thumbs_down: "Thumbs down",
  wrong_answer: "Wrong answer",
  needs_detail: "Needs detail",
  too_verbose: "Too verbose",
  retry: "Retry",
  other: "Other",
};

/**
 * Prefer the integration's server-validated deep link. Legacy integration
 * records without enough native metadata still open through the saved-chat
 * route, whose API repeats the conversation RBAC check.
 */
function getConvLink(conv: UserConversation): string {
  if (conv.source === "slack" && conv.slack_permalink) {
    return conv.slack_permalink;
  }
  if (conv.source === "webex" && conv.webex_permalink) {
    return conv.webex_permalink;
  }
  return `/chat/${conv.id}?from=admin`;
}

export function UserDetailPanel({
  email,
  onClose,
}: UserDetailPanelProps) {
  const [data, setData] = useState<UserDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "conversations" | "feedback">("overview");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!email) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: reset state when email prop becomes falsy
      setData(null);
      return;
    }

    setLoading(true);
    setError(null);
    setActiveTab("overview");
    fetch(`/api/admin/users/activity/${encodeURIComponent(email)}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success) {
          setData(json.data);
        } else {
          setError(json.error || "Failed to load user");
        }
      })
      .catch(() => setError("Failed to load user"))
      .finally(() => setLoading(false));
  }, [email]);

  // Close on escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!email) return null;

  const visibleTabs = data?.can_view_conversations
    ? (["overview", "conversations", "feedback"] as const)
    : (["overview", "feedback"] as const);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed right-0 top-0 h-full w-full max-w-xl bg-background border-l border-border shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
              <User className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold truncate">
                {data?.profile.name || email}
              </h2>
              <p className="text-xs text-muted-foreground truncate">{email}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0">
          {visibleTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "overview" ? "Overview" : tab === "conversations" ? `Conversations${data ? ` (${data.stats.visible_conversations})` : ""}` : `Feedback${data ? ` (${data.stats.feedback_given})` : ""}`}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          ) : data ? (
            <>
              {activeTab === "overview" && (
                <OverviewTab
                  data={data}
                  canViewConversations={data.can_view_conversations}
                />
              )}
              {activeTab === "conversations" && data.can_view_conversations && (
                <ConversationsTab conversations={data.recent_conversations} />
              )}
              {activeTab === "feedback" && (
                <FeedbackTab
                  feedback={data.recent_feedback}
                  canViewConversations={data.can_view_conversations}
                />
              )}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

function OverviewTab({
  data,
  canViewConversations,
}: {
  data: UserDetailData;
  canViewConversations: boolean;
}) {
  const { profile, stats } = data;
  return (
    <div className="space-y-4">
      {/* Profile info */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              <span className="truncate">{profile.email}</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Shield className="h-3.5 w-3.5" />
              <Badge variant={profile.role === "admin" ? "default" : "secondary"} className="text-[10px]">
                {profile.role}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              <Badge variant="outline" className="text-[10px]">
                {profile.source === "slack"
                  ? "Slack"
                  : profile.source === "webex"
                    ? "Webex"
                    : "Web"}
              </Badge>
              {profile.slack_user_id && (
                <span className="text-[10px] text-muted-foreground">{profile.slack_user_id}</span>
              )}
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              <span>Joined {formatDate(profile.created_at)}</span>
            </div>
            {profile.last_login && (
              <div className="flex items-center gap-2 text-muted-foreground col-span-2">
                <Clock className="h-3.5 w-3.5" />
                <span>Last seen {formatDate(profile.last_login)}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Stats cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<MessageSquare className="h-4 w-4 text-blue-500" />}
          label="Conversations"
          value={stats.total_conversations}
        />
        <StatCard
          icon={<ThumbsUp className="h-4 w-4 text-green-500" />}
          label="Feedback Given"
          value={stats.feedback_given}
        />
        <StatCard
          icon={<ThumbsUp className="h-4 w-4 text-green-500" />}
          label="Positive"
          value={stats.feedback_positive}
        />
        <StatCard
          icon={<ThumbsDown className="h-4 w-4 text-red-500" />}
          label="Negative"
          value={stats.feedback_negative}
        />
      </div>

      {/* Recent activity */}
      {canViewConversations && data.recent_conversations.length > 0 && (
        <div>
          <h3 className="text-xs font-medium mb-2">Recent Conversations</h3>
          <div className="space-y-1">
            {data.recent_conversations.slice(0, 5).map((conv) => (
              <div key={conv.id} className="flex items-center justify-between py-1.5 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  {conv.source === "slack" ? (
                    <Hash className="h-3 w-3 text-purple-500 shrink-0" />
                  ) : conv.source === "webex" ? (
                    <Globe className="h-3 w-3 text-cyan-500 shrink-0" />
                  ) : (
                    <MessageSquare className="h-3 w-3 text-blue-500 shrink-0" />
                  )}
                  {(() => {
                    const link = getConvLink(conv);
                    return link ? (
                      <a
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-primary hover:underline"
                      >
                        {conv.title}
                      </a>
                    ) : (
                      <span className="truncate">{conv.title}</span>
                    );
                  })()}
                </div>
                <span className="text-muted-foreground shrink-0 ml-2">
                  {formatDate(conv.updated_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationsTab({ conversations }: { conversations: UserConversation[] }) {
  if (conversations.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        No conversations found
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {conversations.map((conv) => (
        <div
          key={conv.id}
          className="flex items-center justify-between py-2 px-2 rounded hover:bg-muted/50 text-xs"
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {conv.source === "slack" ? (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                Slack
              </Badge>
            ) : conv.source === "webex" ? (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                Webex
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                Web
              </Badge>
            )}
            {(() => {
              const link = getConvLink(conv);
              return link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-primary hover:underline"
                >
                  {conv.title}
                </a>
              ) : (
                <span className="truncate">{conv.title}</span>
              );
            })()}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <span className="text-muted-foreground">{formatDate(conv.updated_at)}</span>
            {(() => {
              const link = getConvLink(conv);
              return link ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null;
            })()}
          </div>
        </div>
      ))}
    </div>
  );
}

function FeedbackTab({
  feedback,
  canViewConversations,
}: {
  feedback: UserFeedback[];
  canViewConversations: boolean;
}) {
  if (feedback.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        No feedback submitted
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {feedback.map((fb, i) => (
        <div
          key={i}
          className="p-3 rounded-lg border border-border text-xs space-y-1.5"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${
                fb.rating === "positive"
                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                  : "bg-red-500/10 text-red-600 dark:text-red-400"
              }`}>
                {fb.rating === "positive" ? (
                  <ThumbsUp className="h-2.5 w-2.5" />
                ) : (
                  <ThumbsDown className="h-2.5 w-2.5" />
                )}
                {VALUE_LABELS[fb.value] || fb.value}
              </span>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {fb.source === "slack"
                  ? "Slack"
                  : fb.source === "webex"
                    ? "Webex"
                    : "Web"}
              </Badge>
            </div>
            <span className="text-muted-foreground">{formatDate(fb.created_at)}</span>
          </div>
          {fb.comment && (
            <p className="text-muted-foreground">{fb.comment}</p>
          )}
          {canViewConversations && <div className="flex items-center gap-2">
            {fb.source === "slack" && fb.slack_permalink && (
              <a
                href={fb.slack_permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="h-2.5 w-2.5" />
                Slack thread
              </a>
            )}
            {fb.source !== "slack" && fb.conversation_id && (
              <a
                href={`/chat/${fb.conversation_id}?from=admin`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="h-2.5 w-2.5" />
                View chat
              </a>
            )}
          </div>}
        </div>
      ))}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <p className="text-lg font-bold">{value.toLocaleString()}</p>
            <p className="text-[10px] text-muted-foreground">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}
