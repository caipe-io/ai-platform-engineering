"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileUploadDropzone } from "./FileUploadDropzone";
import type { FileUploadSelectionLimits } from "./file-upload-selection";
import { useFileUploadSelection } from "./useFileUploadSelection";

interface ReuploadFileModalProps {
  open: boolean;
  limits: FileUploadSelectionLimits;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (files: File[]) => void | Promise<void>;
}

export function ReuploadFileModal({
  open,
  limits,
  isSubmitting,
  onClose,
  onSubmit,
}: ReuploadFileModalProps) {
  const {
    selectedFiles,
    addFiles,
    removeFile,
    reset: resetSelectedFiles,
  } = useFileUploadSelection(limits);

  const handleClose = () => {
    if (isSubmitting) return;
    resetSelectedFiles();
    onClose();
  };

  const handleSubmit = async () => {
    if (selectedFiles.length === 0) return;
    await onSubmit(selectedFiles);
    resetSelectedFiles();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Re-upload File</DialogTitle>
          <DialogDescription>
            Replace this data source&apos;s content with a new file. Existing
            documents will be removed once the new content finishes
            processing.
          </DialogDescription>
        </DialogHeader>

        <FileUploadDropzone
          selectedFiles={selectedFiles}
          limits={limits}
          onFilesSelected={addFiles}
          onRemoveFile={removeFile}
        />

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || selectedFiles.length === 0}
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {isSubmitting ? "Uploading..." : "Re-upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
