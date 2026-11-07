"use client";

import { EphemeralFilePreview } from "@/components/dynamic-agents/EphemeralFilePreview";
import { cn } from "@/lib/utils";
import { isPreviewableEphemeralFile } from "@/lib/ephemeral-files";
import { AnimatePresence,motion } from "framer-motion";
import { Download,Eye,FileText,Folder,Loader2,Trash2 } from "lucide-react";
import React,{ useCallback,useMemo,useState } from "react";

interface FileTreeProps {
  /** Stack previews below the tree in narrow workspace panels. */
  compact?: boolean;
  /** List of file paths from the agent's in-memory filesystem */
  files: string[];
  /** Fetch file text for inline preview (.md, .txt) */
  getFileContent?: (path: string) => Promise<string | null>;
  /** Callback when a non-previewable file is clicked, or download is requested */
  onFileClick?: (path: string) => void;
  /** Callback when delete is clicked */
  onFileDelete?: (path: string) => void;
  /** Whether a download is in progress */
  isDownloading?: boolean;
  /** Currently downloading file path */
  downloadingPath?: string;
  /** Whether a delete is in progress */
  isDeleting?: boolean;
  /** Currently deleting file path */
  deletingPath?: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
}

/**
 * FileTree component displays files from the agent's in-memory filesystem.
 * Files are shown in a tree structure with folders expanded.
 * .md and .txt files open an inline preview when getFileContent is provided.
 */
export function FileTree({
  compact = false,
  files,
  getFileContent,
  onFileClick,
  onFileDelete,
  isDownloading = false,
  downloadingPath,
  isDeleting = false,
  deletingPath,
}: FileTreeProps) {
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadPreview = useCallback(
    async (path: string) => {
      if (!getFileContent) return;
      setPreviewPath(path);
      setPreviewLoading(true);
      setPreviewError(null);
      setPreviewContent(null);
      try {
        const content = await getFileContent(path);
        if (content === null) {
          setPreviewError("Failed to load file preview.");
        } else {
          setPreviewContent(content);
        }
      } catch {
        setPreviewError("Failed to load file preview.");
      } finally {
        setPreviewLoading(false);
      }
    },
    [getFileContent],
  );

  const handleFileActivate = useCallback(
    async (path: string) => {
      if (getFileContent && isPreviewableEphemeralFile(path)) {
        if (previewPath === path) {
          setPreviewPath(null);
          setPreviewContent(null);
          setPreviewError(null);
          return;
        }
        await loadPreview(path);
        return;
      }
      onFileClick?.(path);
    },
    [getFileContent, loadPreview, onFileClick, previewPath],
  );

  const closePreview = useCallback(() => {
    setPreviewPath(null);
    setPreviewContent(null);
    setPreviewError(null);
  }, []);

  // Build tree structure from flat file paths
  const tree = useMemo(() => buildTree(files), [files]);

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-foreground">
        <FileText className="h-4 w-4 text-blue-400 shrink-0" />
        <span className="font-medium whitespace-nowrap">Files</span>
        <span className="text-muted-foreground">({files.length})</span>
      </div>
      <p className="text-[10px] text-muted-foreground/60 italic">Ephemeral — files may be deleted automatically.</p>

      <div
        className={cn(
          "flex gap-3 items-stretch min-h-[16rem]",
          previewPath && getFileContent && !compact ? "flex-row" : "flex-col",
        )}
      >
        <div
          className={cn(
            "rounded-lg border border-border/50 bg-muted/30 p-2 min-h-0",
            previewPath && getFileContent && !compact ? "w-[38%] max-w-xs shrink-0 overflow-y-auto" : "flex-1",
          )}
        >
          <AnimatePresence mode="popLayout">
            {tree.map((node, idx) => (
              <TreeNodeItem
                key={node.path}
                node={node}
                depth={0}
                index={idx}
                previewPath={previewPath}
                canPreview={!!getFileContent}
                onFileActivate={handleFileActivate}
                onFileDownload={onFileClick}
                onFileDelete={onFileDelete}
                isDownloading={isDownloading}
                downloadingPath={downloadingPath}
                isDeleting={isDeleting}
                deletingPath={deletingPath}
              />
            ))}
          </AnimatePresence>
        </div>

        {previewPath && getFileContent && (
          <EphemeralFilePreview
            path={previewPath}
            content={previewContent}
            isLoading={previewLoading}
            error={previewError}
            onClose={closePreview}
            onDownload={onFileClick}
            className="flex-1 min-w-0"
          />
        )}
      </div>
    </div>
  );
}

interface TreeNodeItemProps {
  node: TreeNode;
  depth: number;
  index: number;
  previewPath: string | null;
  canPreview: boolean;
  onFileActivate?: (path: string) => void;
  onFileDownload?: (path: string) => void;
  onFileDelete?: (path: string) => void;
  isDownloading?: boolean;
  downloadingPath?: string;
  isDeleting?: boolean;
  deletingPath?: string;
}

function TreeNodeItem({
  node,
  depth,
  index,
  previewPath,
  canPreview,
  onFileActivate,
  onFileDownload,
  onFileDelete,
  isDownloading,
  downloadingPath,
  isDeleting,
  deletingPath,
}: TreeNodeItemProps) {
  const isCurrentlyDownloading = isDownloading && downloadingPath === node.path;
  const isCurrentlyDeleting = isDeleting && deletingPath === node.path;
  const isPreviewable = canPreview && isPreviewableEphemeralFile(node.path);
  const isPreviewOpen = previewPath === node.path;

  const handleClick = useCallback(() => {
    if (!node.isDirectory && onFileActivate) {
      onFileActivate(node.path);
    }
  }, [node.isDirectory, node.path, onFileActivate]);

  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!node.isDirectory && onFileDownload) {
        onFileDownload(node.path);
      }
    },
    [node.isDirectory, node.path, onFileDownload],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // Don't trigger download
      if (!node.isDirectory && onFileDelete) {
        onFileDelete(node.path);
      }
    },
    [node.isDirectory, node.path, onFileDelete]
  );

  return (
    <motion.div
      initial={{ opacity: 0, x: -5 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.02 }}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 py-1 px-1 rounded text-xs",
          !node.isDirectory && "hover:bg-muted cursor-pointer group",
          !node.isDirectory && isCurrentlyDownloading && "bg-blue-500/10",
          !node.isDirectory && isCurrentlyDeleting && "bg-red-500/10",
          isPreviewOpen && "bg-primary/10 ring-1 ring-primary/20",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleClick}
        role={node.isDirectory ? undefined : "button"}
        tabIndex={node.isDirectory ? undefined : 0}
        onKeyDown={(e) => {
          if (!node.isDirectory && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        {node.isDirectory ? (
          <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        ) : isCurrentlyDownloading || isCurrentlyDeleting ? (
          <Loader2 className="h-3.5 w-3.5 text-blue-400 shrink-0 animate-spin" />
        ) : (
          <FileText className="h-3.5 w-3.5 text-blue-400 shrink-0" />
        )}
        <span
          className={cn(
            "truncate flex-1",
            node.isDirectory
              ? "font-medium text-foreground/80"
              : "text-foreground/70 group-hover:text-foreground"
          )}
          title={node.path}
        >
          {node.name}
        </span>
        {!node.isDirectory && !isCurrentlyDownloading && !isCurrentlyDeleting && (
          <>
            {isPreviewable ? (
              <Eye className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            ) : (
              <Download className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            )}
            {onFileDownload && isPreviewable && (
              <button
                type="button"
                onClick={handleDownload}
                className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition-all shrink-0"
                title="Download file"
              >
                <Download className="h-3 w-3" />
              </button>
            )}
            {onFileDelete && (
              <button
                onClick={handleDelete}
                className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all shrink-0"
                title="Delete file"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </>
        )}
      </div>

      {/* Render children for directories */}
      {node.isDirectory && node.children.length > 0 && (
        <div>
          {node.children.map((child, idx) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              index={idx}
              previewPath={previewPath}
              canPreview={canPreview}
              onFileActivate={onFileActivate}
              onFileDownload={onFileDownload}
              onFileDelete={onFileDelete}
              isDownloading={isDownloading}
              downloadingPath={downloadingPath}
              isDeleting={isDeleting}
              deletingPath={deletingPath}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}

/**
 * Internal node type with childMap for efficient tree construction.
 * For leaf nodes, `fullPath` stores the original path for API calls.
 */
interface TreeNodeWithMap {
  name: string;
  fullPath: string | null; // Original path for leaves, null for directories
  children: Map<string, TreeNodeWithMap>;
}

/**
 * Build a tree structure from flat file paths.
 *
 * Input: ["/src/index.ts", "/src/utils/helper.ts", "/README.md"]
 * Output: Tree with src/ folder containing index.ts and utils/helper.ts
 *
 * Leaf nodes store the original path directly - no reconstruction needed.
 */
function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNodeWithMap = { name: "", fullPath: null, children: new Map() };

  for (const originalPath of paths) {
    const parts = originalPath.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          fullPath: isLeaf ? originalPath : null,
          children: new Map(),
        });
      } else if (isLeaf) {
        // Update existing node to be a leaf with the full path
        current.children.get(part)!.fullPath = originalPath;
      }

      current = current.children.get(part)!;
    }
  }

  // Convert to TreeNode[], recursively
  function toTreeNodes(node: TreeNodeWithMap): TreeNode[] {
    return sortNodes(
      Array.from(node.children.values()).map((child) => ({
        name: child.name,
        path: child.fullPath ?? child.name, // fullPath for leaves, name for dirs (path unused for dirs)
        isDirectory: child.fullPath === null,
        children: toTreeNodes(child),
      }))
    );
  }

  return toTreeNodes(root);
}

/**
 * Sort nodes: directories first, then files, both alphabetically
 */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: sortNodes(node.children),
    }))
    .sort((a, b) => {
      // Directories before files
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      // Alphabetical within same type
      return a.name.localeCompare(b.name);
    });
}
