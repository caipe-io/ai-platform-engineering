"use client";

import { AlertCircle,CheckCircle2,Clock3,Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { getConfig } from "@/lib/config";
import { Button } from "@/components/ui/button";
import {
Dialog,
DialogContent,
DialogDescription,
DialogFooter,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import type { ReleaseMarkdown,ReleaseNote } from "@/hooks/use-release-upgrade-prompt";

interface ReleaseUpgradeDialogProps {
  open: boolean;
  isAdmin: boolean;
  releaseVersion: string;
  release: ReleaseNote | null;
  releaseMarkdown?: ReleaseMarkdown | null;
  onSkipUntilNextLogin: () => void;
  onDismissPermanently: () => void | Promise<void>;
  isDismissing?: boolean;
}

const CHANGELOG_URL = "https://github.com/caipe-io/ai-platform-engineering/blob/main/CHANGELOG.md";

function userVisibleSections(sections: ReleaseNote["sections"], isAdmin: boolean): ReleaseNote["sections"] {
  if (isAdmin) return sections;

  const adminOnlyPattern = /\b(admin|migration|migrations|schema|rbac|rebac|openfga)\b/i;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !adminOnlyPattern.test(`${item.scope ?? ""} ${item.text}`)),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * The curated release blog posts end with an admin-oriented "Upgrade Guide"
 * (runbook, Helm values diff, data migrations). Non-admins only see the
 * user-facing portion above it.
 */
function userVisibleMarkdownBody(body: string, isAdmin: boolean): string {
  if (isAdmin) return body;
  const lines = body.split("\n");
  const cutIndex = lines.findIndex((line) => /^#{1,6}\s+upgrade guide\b/i.test(line.trim()));
  const visible = cutIndex >= 0 ? lines.slice(0, cutIndex) : lines;
  return visible.join("\n").replace(/\n*-{3,}\s*$/g, "").trim();
}

/** Rich-markdown renderer for the full curated release notes body. */
function ReleaseNotesMarkdown({ body }: { body: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h2 className="mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h2>,
        h2: ({ children }) => <h3 className="mt-4 text-sm font-semibold text-foreground first:mt-0">{children}</h3>,
        h3: ({ children }) => (
          <h4 className="mt-3 text-sm font-semibold text-muted-foreground first:mt-0">{children}</h4>
        ),
        p: ({ children }) => <p className="my-2 text-sm leading-relaxed text-muted-foreground">{children}</p>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {children}
          </a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
            {children}
          </blockquote>
        ),
        code: ({ className, children }) => {
          const isBlock = (className ?? "").includes("language-");
          if (isBlock) {
            return <code className="font-mono text-xs">{children}</code>;
          }
          return (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground">{children}</pre>
        ),
        hr: () => <hr className="my-3 border-border" />,
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
      }}
    >
      {body}
    </ReactMarkdown>
  );
}

function ReleaseNoteItemMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <>{children}</>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function ReleaseUpgradeDialog({
  open,
  isAdmin,
  releaseVersion,
  release,
  releaseMarkdown = null,
  onSkipUntilNextLogin,
  onDismissPermanently,
  isDismissing = false,
}: ReleaseUpgradeDialogProps) {
  const markdownBody = releaseMarkdown?.body
    ? userVisibleMarkdownBody(releaseMarkdown.body, isAdmin)
    : null;
  const visibleSections = userVisibleSections(release?.sections ?? [], isAdmin);
  // We only have real notes when there's a curated markdown body or at least one
  // changelog-derived section to show. Otherwise the dialog renders an error.
  const hasNotes = Boolean(markdownBody) || visibleSections.length > 0;
  const appName = getConfig("appName");
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) return;
    if (isAdmin) {
      onSkipUntilNextLogin();
      return;
    }
    void onDismissPermanently();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" />
          </div>
          <DialogTitle>What&apos;s new in {releaseVersion}</DialogTitle>
          <DialogDescription>
            This deployment includes {appName} updates from the active release. Review the notes when you are ready.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[420px] overflow-y-auto rounded-lg border bg-muted/20 p-4">
          {markdownBody ? (
            <div className="min-w-0">
              <ReleaseNotesMarkdown body={markdownBody} />
            </div>
          ) : !hasNotes ? (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span className="min-w-0">
                Couldn&apos;t load the release notes for {releaseVersion}. View the full
                changelog below for the latest updates.
              </span>
            </div>
          ) : (
            <div className="space-y-4">
              {visibleSections.map((section) => (
                <section key={section.type} className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">{section.type}</h3>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    {section.items.map((item, index) => (
                      <li key={`${section.type}-${index}`} className="flex gap-2">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                        <span className="min-w-0">
                          <ReleaseNoteItemMarkdown text={item.text} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          <a
            href={CHANGELOG_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            View full changelog
          </a>
        </div>

        <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
          {isAdmin ? (
            <>
              <Button variant="ghost" onClick={onSkipUntilNextLogin} className="gap-2">
                <Clock3 className="h-4 w-4" />
                Skip until next login
              </Button>
              <Button variant="outline" onClick={onDismissPermanently} disabled={isDismissing}>
                Do not show again
              </Button>
            </>
          ) : (
            <Button onClick={onDismissPermanently} disabled={isDismissing}>
              Do not show again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
