"use client";

import { Badge } from "@/components/ui/badge";
import {
Dialog,
DialogContent,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
ChevronRight,
ExternalLink,
Eye,
FileCode,
FileText,
Folder,
FolderOpen,
Image as ImageIcon,
Loader2,
Pencil,
X,
} from "lucide-react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import React,{ useCallback,useEffect,useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// NOTE: this dialog used to host the full CodeMirror-based `RichCodeEditor`
// for in-place editing of any text file (with Save / Cancel / Delete /
// New file affordances). That UI duplicated — and lagged behind — the
// authoritative editor in the Skill Workspace (auto-save semantics,
// dirty-tracking, AI assist, scan triggers, validation, …), and made
// this dialog do double duty as both a "quick peek" surface and a
// secondary editor.
//
// We removed the editor entirely from the dialog. It is now a strict
// read-only previewer (markdown rendered, code rendered as syntax-free
// `<pre>` so the dialog stays light and CodeMirror only has to mount in
// one place). Editable skills get a prominent "Open in editor" link in
// the header that routes to the Skill Workspace, where editing,
// uploading, and creating new files is already supported.

// ---------------------------------------------------------------------------
// Types & adapter
// ---------------------------------------------------------------------------

export interface FolderEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface FolderFileContent {
  path: string;
  content?: string;
  image_base64?: string;
  image_mime?: string;
  size: number;
  truncated: boolean;
  type: "text" | "image" | "binary";
}

export interface FolderAdapter {
  /** Display label, e.g. "owner/repo" or "skill name". */
  label: string;
  /** Optional permalink to upstream source for the whole skill folder. */
  externalUrl?: string;
  /**
   * True if the underlying skill is editable by the current user. The
   * dialog itself is now read-only regardless — this flag only controls
   * whether the header surfaces an "Open in editor" link to the
   * Workspace and whether the "Read-only" badge is shown.
   *
   * `write` / `remove` on the adapter are no longer used by the dialog
   * (kept on the type for back-compat with any callers that still
   * implement them, but they will not be invoked).
   */
  editable: boolean;
  list: (path: string) => Promise<FolderEntry[]>;
  read: (path: string) => Promise<FolderFileContent>;
  /** @deprecated dialog no longer writes — edit in the Skill Workspace instead. */
  write?: (path: string, content: string) => Promise<void>;
  /** @deprecated dialog no longer deletes — edit in the Skill Workspace instead. */
  remove?: (path: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Optional subtitle (description, source, etc.). */
  subtitle?: React.ReactNode;
  adapter: FolderAdapter;
  /** Initial file to open. Defaults to "SKILL.md" if present. */
  initialFile?: string;
  /**
   * If provided AND `adapter.editable` is true, the header surfaces an
   * "Open in editor" link to this href so the user can jump into the
   * Skill Workspace from the previewer. Typically the gallery wires
   * this to `/skills/workspace/<id>`.
   */
  editHref?: string;
}

export function SkillFolderViewer({
  open,
  onOpenChange,
  title,
  subtitle,
  adapter,
  initialFile,
  editHref,
}: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileData, setFileData] = useState<FolderFileContent | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Source-vs-rendered toggle is the one piece of editor state we keep —
  // it is purely a presentation choice for markdown files (rendered
  // `prose` vs. raw markdown text), neither mutates the file.
  const [showSource, setShowSource] = useState(false);

  // Initial load — fetch root + the initial file.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoadingTree(true);
      setTreeError(null);
      try {
        const root = await adapter.list("");
        if (cancelled) return;
        setTree({
          name: "",
          path: "",
          type: "dir",
          loaded: true,
          open: true,
          children: root.map(entryToNode),
        });
        const target =
          initialFile ?? root.find((e) => /^skill\.md$/i.test(e.name))?.path;
        if (target) {
          void openFile(target);
        }
      } catch (err) {
        if (cancelled) return;
        setTreeError(err instanceof Error ? err.message : "Failed to load files");
      } finally {
        if (!cancelled) setLoadingTree(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, adapter]);

  // Reset transient state when dialog closes.
  useEffect(() => {
    if (open) return;
    setActiveFile(null);
    setFileData(null);
    setShowSource(false);
  }, [open]);

  const openFile = useCallback(
    async (path: string) => {
      setActiveFile(path);
      setLoadingFile(true);
      setFileError(null);
      setFileData(null);
      setShowSource(false);
      try {
        const data = await adapter.read(path);
        setFileData(data);
      } catch (err) {
        setFileError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        setLoadingFile(false);
      }
    },
    [adapter],
  );

  const expandDir = useCallback(
    async (node: TreeNode) => {
      if (node.loaded) {
        node.open = !node.open;
        setTree((t) => (t ? { ...t } : t));
        return;
      }
      try {
        const children = await adapter.list(node.path);
        node.children = children.map(entryToNode);
        node.loaded = true;
        node.open = true;
        setTree((t) => (t ? { ...t } : t));
      } catch (err) {
        // Best-effort surface — this dialog is read-only and a folder
        // listing failure is rarely actionable. Log to console and
        // leave the row collapsed.
         
        console.warn("SkillFolderViewer: failed to list folder", err);
      }
    },
    [adapter],
  );

  const isMarkdown = activeFile?.toLowerCase().endsWith(".md") ?? false;
  // Show "Open in editor" when the underlying skill is editable AND the
  // caller wired up a destination href (typically the Workspace route).
  const showEditLink = adapter.editable && Boolean(editHref);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[92vw] h-[85vh] flex flex-col p-0 gap-0 overflow-hidden border-border/60">
        {/* ---- Header ---- */}
        {/* `pr-12` reserves space on the right edge for the dialog's
            built-in close `X` (positioned `top-3 right-3` below) so
            the prominent "Open in editor" CTA never overlaps it. */}
        <DialogHeader className="px-5 pr-12 py-3.5 border-b border-border/60 shrink-0 bg-gradient-to-b from-muted/40 to-transparent">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2.5 text-base font-semibold text-foreground">
                <Folder className="h-4 w-4 text-primary/80 shrink-0" />
                <span className="truncate">{title}</span>
                {!adapter.editable && (
                  <Badge
                    variant="outline"
                    className="font-medium text-[10px] gap-1 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  >
                    <Eye className="h-3 w-3" />
                    Read-only
                  </Badge>
                )}
              </DialogTitle>
              {subtitle && (
                <div className="text-xs text-muted-foreground/90 mt-1 truncate">{subtitle}</div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Secondary "Open source" — icon-only ghost button so it
                  doesn't compete with the primary CTA below. Tooltip
                  carries the full label on hover. */}
              {adapter.externalUrl && (
                <a
                  href={adapter.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  title="Open on source"
                  aria-label="Open on source"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
              {/* Primary CTA — solid pill so it's the obvious next step
                  for editable skills, and visually distinct from the
                  read-only previewer chrome. */}
              {showEditLink && editHref && (
                <NavigationProgressLink
                  href={editHref}
                  onClick={() => onOpenChange(false)}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-semibold bg-primary text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary/90 transition-colors"
                  title="Edit this skill in the Skill Workspace"
                  data-testid="skill-folder-viewer-open-editor"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Open in editor
                </NavigationProgressLink>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* ---- Body ---- */}
        <div className="flex-1 grid grid-cols-[240px_1fr] min-h-0 overflow-hidden">
          {/* File tree */}
          <aside className="border-r border-border/60 overflow-hidden flex flex-col bg-muted/30">
            <div className="px-3 py-2 border-b border-border/60 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 flex items-center gap-1.5 shrink-0">
              <FolderOpen className="h-3 w-3" />
              Files
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {loadingTree ? (
                <div className="p-4 text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading…
                </div>
              ) : treeError ? (
                <div className="p-4 text-xs text-red-600 dark:text-red-400">{treeError}</div>
              ) : tree ? (
                <TreeList
                  node={tree}
                  depth={0}
                  activePath={activeFile}
                  onOpenFile={openFile}
                  onToggleDir={expandDir}
                />
              ) : null}
            </div>
          </aside>

          {/* File pane */}
          <section className="flex flex-col min-w-0 overflow-hidden bg-background">
            {!activeFile ? (
              <EmptyPane />
            ) : (
              <>
                {/* File tab strip */}
                <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60 shrink-0 bg-muted/20">
                  <div className="flex items-center gap-2 min-w-0 text-xs">
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-background border border-border/60 shadow-sm">
                      <FileIcon name={activeFile} />
                      <span className="font-mono text-foreground/90 truncate" title={activeFile}>
                        {activeFile}
                      </span>
                    </div>
                    {fileData && fileData.size > 0 && (
                      <span className="text-[10px] text-muted-foreground/70 font-mono">
                        {formatBytes(fileData.size)}
                      </span>
                    )}
                    {fileData?.truncated && (
                      <Badge
                        variant="outline"
                        className="text-[10px] font-medium border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      >
                        Truncated
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isMarkdown && fileData?.type === "text" && (
                      <div className="inline-flex items-center rounded-md border border-border/60 p-0.5 bg-background">
                        <button
                          type="button"
                          onClick={() => setShowSource(false)}
                          className={cn(
                            "px-2.5 py-1 text-[11px] font-medium rounded-sm transition-colors",
                            !showSource
                              ? "bg-primary/15 text-primary"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowSource(true)}
                          className={cn(
                            "px-2.5 py-1 text-[11px] font-medium rounded-sm transition-colors",
                            showSource
                              ? "bg-primary/15 text-primary"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          Source
                        </button>
                      </div>
                    )}
                    {/* Editing affordances (Edit / Save / Cancel /
                        Delete) and the bottom "New file" bar were
                        removed when this dialog became read-only.
                        Use "Open in editor" in the header to launch
                        the Skill Workspace, where editing, deletion,
                        and creating new files (with full path
                        support) are first-class. */}
                  </div>
                </div>

                {/* File body — read-only previewer. Markdown renders
                    via `react-markdown`; everything else (code, json,
                    yaml, plaintext) renders as a plain `<pre>` so
                    this dialog stays light and CodeMirror only has
                    to mount in the Skill Workspace. */}
                <div className="flex-1 min-h-0 flex flex-col">
                  {loadingFile ? (
                    <div className="flex-1 min-h-0 overflow-auto p-4 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1.5" />
                      Loading…
                    </div>
                  ) : fileError ? (
                    <div className="flex-1 min-h-0 overflow-auto p-4 text-xs text-red-600 dark:text-red-400">{fileError}</div>
                  ) : fileData ? (
                    <FileBody
                      file={fileData}
                      isMarkdown={isMarkdown}
                      showSource={showSource}
                    />
                  ) : null}
                </div>
              </>
            )}
          </section>
        </div>

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground p-1"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub components
// ---------------------------------------------------------------------------

interface TreeNode extends FolderEntry {
  loaded?: boolean;
  open?: boolean;
  children?: TreeNode[];
}

function entryToNode(e: FolderEntry): TreeNode {
  return e.type === "dir" ? { ...e, loaded: false, open: false, children: [] } : { ...e };
}

function TreeList({
  node,
  depth,
  activePath,
  onOpenFile,
  onToggleDir,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onToggleDir: (node: TreeNode) => void;
}) {
  if (node.path === "") {
    return (
      <ul className="py-1">
        {node.children?.map((child) => (
          <TreeList
            key={child.path}
            node={child}
            depth={0}
            activePath={activePath}
            onOpenFile={onOpenFile}
            onToggleDir={onToggleDir}
          />
        ))}
      </ul>
    );
  }
  if (node.type === "dir") {
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggleDir(node)}
          className="group w-full flex items-center gap-1.5 px-2 py-[5px] text-xs font-medium text-foreground/90 hover:bg-foreground/5 rounded-sm mx-1"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/60 transition-transform shrink-0",
              node.open && "rotate-90 text-foreground/70",
            )}
          />
          {node.open ? (
            <FolderOpen className="h-3.5 w-3.5 text-amber-500/90 shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-amber-500/70 shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {node.open && (
          <ul>
            {node.children?.map((child) => (
              <TreeList
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onOpenFile={onOpenFile}
                onToggleDir={onToggleDir}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenFile(node.path)}
        className={cn(
          "w-full flex items-center gap-1.5 px-2 py-[5px] text-xs rounded-sm mx-1 transition-colors",
          activePath === node.path
            ? "bg-primary/15 text-primary font-medium ring-1 ring-primary/25"
            : "text-foreground/75 hover:bg-foreground/5 hover:text-foreground",
        )}
        style={{ paddingLeft: 8 + depth * 12 + 12 }}
      >
        <FileIcon name={node.name} />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}

function FileBody({
  file,
  isMarkdown,
  showSource,
}: {
  file: FolderFileContent;
  isMarkdown: boolean;
  showSource: boolean;
}) {
  // Read-only previewer. Markdown renders via `react-markdown`;
  // everything else (code, json, yaml, plaintext, raw markdown source)
  // renders as a plain `<pre>` so the dialog stays light and CodeMirror
  // is mounted only in the Skill Workspace. For richer editing — syntax
  // highlighting, search/replace, multi-cursor — open the skill in the
  // Workspace via the "Open in editor" link in the dialog header.

  if (file.type === "image" && file.image_base64) {
    return (
      <div className="flex-1 min-h-0 overflow-auto p-4 flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:${file.image_mime ?? "image/*"};base64,${file.image_base64}`}
          alt={file.path}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    );
  }
  if (file.type === "binary" || file.truncated) {
    return (
      <div className="flex-1 min-h-0 overflow-auto p-4 text-xs text-muted-foreground">
        {file.truncated
          ? "File too large to display inline."
          : "Binary file — preview not supported."}
        <div className="mt-1 font-mono">{file.size.toLocaleString()} bytes</div>
      </div>
    );
  }

  // Plain `<pre>` for non-markdown text files (and for "Source" view of
  // markdown). Monospace font, soft wrap off so long lines scroll
  // horizontally instead of cramming, line numbers omitted to keep
  // the dialog visually distinct from the full Workspace editor.
  if (!isMarkdown || showSource) {
    return (
      <div className="flex-1 min-h-0 overflow-auto bg-muted/20">
        <pre
          className="px-4 py-3 text-[12px] leading-relaxed font-mono text-foreground/90 whitespace-pre"
          data-testid="skill-folder-viewer-source"
        >
          {file.content || ""}
        </pre>
      </div>
    );
  }

  // Markdown preview is the only remaining branch: the `image`/`binary`/
  // `truncated` and `!isMarkdown || showSource` cases above already
  // return, so we know `isMarkdown && !showSource` holds here.
  return (
    <div
      className={cn(
        // Markdown preview is a `prose` block with no intrinsic
        // scroll — give it the flex slot + its own scrollbar so long
        // SKILL.md files don't push the dialog past the viewport.
        "flex-1 min-h-0 overflow-y-auto",
        "prose prose-sm dark:prose-invert max-w-none px-6 py-5",
        // Tighten + boost contrast: default `prose-invert` washes everything
        // to ~60% opacity which looked grey-on-grey in the dialog.
        "prose-headings:text-foreground prose-headings:font-semibold",
        "prose-h1:text-2xl prose-h1:mt-0 prose-h1:mb-4 prose-h1:pb-2 prose-h1:border-b prose-h1:border-border/60",
        "prose-h2:text-lg prose-h2:mt-6 prose-h2:mb-3",
        "prose-h3:text-base prose-h3:mt-5 prose-h3:mb-2",
        "prose-p:text-foreground/85 prose-p:leading-relaxed",
        "prose-li:text-foreground/85 prose-li:my-0.5",
        "prose-strong:text-foreground prose-strong:font-semibold",
        "prose-a:text-primary prose-a:font-medium prose-a:no-underline hover:prose-a:underline",
        "prose-code:text-pink-600 dark:prose-code:text-pink-300 prose-code:bg-muted/60",
        "prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:text-[0.85em]",
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:bg-muted/80 prose-pre:border prose-pre:border-border/60 prose-pre:text-foreground/90",
        "prose-blockquote:border-l-primary/40 prose-blockquote:text-foreground/75",
        "prose-hr:border-border/60",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{file.content || ""}</ReactMarkdown>
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <div className="p-3 rounded-full bg-muted/50">
        <FileText className="h-8 w-8 text-muted-foreground/60" />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground/80">No file selected</div>
        <div className="text-xs text-muted-foreground max-w-xs">
          Pick a file from the tree on the left to view its contents.
        </div>
      </div>
    </div>
  );
}


function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) {
    return <ImageIcon className="h-3.5 w-3.5 text-fuchsia-500/80 shrink-0" />;
  }
  if (["md", "mdx", "txt"].includes(ext)) {
    return <FileText className="h-3.5 w-3.5 text-sky-500/80 shrink-0" />;
  }
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "py",
      "go",
      "rs",
      "java",
      "rb",
      "json",
      "yaml",
      "yml",
      "sh",
      "bash",
    ].includes(ext)
  ) {
    return <FileCode className="h-3.5 w-3.5 text-emerald-500/80 shrink-0" />;
  }
  return <FileText className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />;
}
