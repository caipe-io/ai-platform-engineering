"use client";

import { useRef } from "react";
import { FileText, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  formatUploadFileSize,
  type FileUploadSelectionLimits,
} from "./file-upload-selection";

interface FileUploadDropzoneProps {
  selectedFiles: File[];
  limits: FileUploadSelectionLimits;
  onFilesSelected: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
}

/**
 * The drag-and-drop file picker + selected-file list, shared by every upload
 * surface (initial ingest, re-upload, ...) so they look and behave
 * identically.
 */
export function FileUploadDropzone({
  selectedFiles,
  limits,
  onFilesSelected,
  onRemoveFile,
}: FileUploadDropzoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-muted-foreground mb-2">
        Files
      </label>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown,.pdf,.txt,text/markdown,text/plain,application/pdf"
        multiple
        className="sr-only"
        aria-label="Choose files to ingest"
        onChange={(event) => {
          onFilesSelected(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <div
        className="rounded-lg border-2 border-dashed border-border bg-muted/20 px-4 py-5 transition-colors hover:border-primary/50 hover:bg-muted/30"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onFilesSelected(Array.from(event.dataTransfer.files));
        }}
      >
        <div className="flex flex-col items-center justify-center gap-3 text-center sm:flex-row sm:text-left">
          <div className="rounded-full bg-primary/10 p-2.5 text-primary">
            <Upload className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-foreground">
              Drop files here or choose them from your computer
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              PDF, Markdown, and plain text. Up to{" "}
              {limits.max_files_per_upload} files,{" "}
              {limits.max_file_size_mb} MiB each, and{" "}
              {limits.max_total_upload_size_mb} MiB total.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 gap-2"
          >
            <Upload className="h-4 w-4" />
            Choose files
          </Button>
        </div>
      </div>

      {selectedFiles.length > 0 && (
        <div className="mt-3 space-y-2" aria-live="polite">
          <p className="text-xs font-medium text-muted-foreground">
            {selectedFiles.length}{" "}
            {selectedFiles.length === 1 ? "file" : "files"} selected
          </p>
          <div className="max-h-36 space-y-1.5 overflow-y-auto">
            {selectedFiles.map((file, index) => (
              <div
                key={`${file.name}-${file.lastModified}-${index}`}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2"
              >
                <FileText className="h-4 w-4 shrink-0 text-primary" />
                <span
                  className="min-w-0 flex-1 truncate text-sm"
                  title={file.name}
                >
                  {file.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatUploadFileSize(file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(index)}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
