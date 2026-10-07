"use client";

import { useCallback, useState } from "react";

import { useToast } from "@/components/ui/toast";
import {
  mergeSelectedUploadFiles,
  type FileUploadSelectionLimits,
} from "./file-upload-selection";

/**
 * Shared file-queue state and validation messaging for every upload surface
 * (initial ingest, re-upload, ...) so they all enforce and explain the same
 * platform limits identically.
 */
export function useFileUploadSelection(limits: FileUploadSelectionLimits) {
  const { toast } = useToast();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

  const addFiles = useCallback(
    (files: File[]) => {
      const result = mergeSelectedUploadFiles(selectedFiles, files, limits);
      if (result.unsupportedCount > 0) {
        toast(
          `${result.unsupportedCount} unsupported ${result.unsupportedCount === 1 ? "file was" : "files were"} skipped. Choose PDF, Markdown, or text files.`,
          "error",
        );
      }
      if (result.oversizedCount > 0) {
        toast(
          `${result.oversizedCount} ${result.oversizedCount === 1 ? "file exceeds" : "files exceed"} the ${limits.max_file_size_mb} MiB platform limit.`,
          "error",
        );
      }
      if (result.duplicateCount > 0) {
        toast(
          `${result.duplicateCount} ${result.duplicateCount === 1 ? "file was" : "files were"} already selected.`,
          "info",
        );
      }
      if (result.countRejectedCount > 0) {
        toast(
          `Only ${limits.max_files_per_upload} files may be ingested at once.`,
          "error",
        );
      }
      if (result.totalSizeRejectedCount > 0) {
        toast(
          `The selected files exceed the ${limits.max_total_upload_size_mb} MiB total upload limit.`,
          "error",
        );
      }
      setSelectedFiles(result.files);
    },
    [limits, selectedFiles, toast],
  );

  const removeFile = useCallback((index: number) => {
    setSelectedFiles((current) =>
      current.filter((_, itemIndex) => itemIndex !== index),
    );
  }, []);

  const reset = useCallback(() => setSelectedFiles([]), []);

  return { selectedFiles, setSelectedFiles, addFiles, removeFile, reset };
}
