export const formatUploadFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export interface FileUploadSelectionLimits {
  max_file_size_mb: number;
  max_files_per_upload: number;
  max_total_upload_size_mb: number;
}

export interface FileUploadSelectionResult {
  files: File[];
  duplicateCount: number;
  unsupportedCount: number;
  oversizedCount: number;
  countRejectedCount: number;
  totalSizeRejectedCount: number;
}

const isSupportedUploadFile = (file: File): boolean =>
  ["application/pdf", "text/markdown", "text/plain"].includes(file.type) ||
  /\.(md|markdown|pdf|txt)$/i.test(file.name);

const fileIdentity = (file: File): string =>
  [file.name, file.size, file.lastModified, file.type].join(":");

/**
 * Add newly chosen files to the current upload queue while preserving its
 * order and enforcing platform limits across the complete selection.
 */
export function mergeSelectedUploadFiles(
  currentFiles: File[],
  incomingFiles: File[],
  limits: FileUploadSelectionLimits,
): FileUploadSelectionResult {
  const supportedIncoming = incomingFiles.filter(isSupportedUploadFile);
  const unsupportedCount = incomingFiles.length - supportedIncoming.length;
  const perFileLimitBytes = limits.max_file_size_mb * 1024 * 1024;
  const withinPerFileLimit = supportedIncoming.filter(
    (file) => file.size <= perFileLimitBytes,
  );
  const oversizedCount = supportedIncoming.length - withinPerFileLimit.length;

  const seen = new Set(currentFiles.map(fileIdentity));
  const uniqueIncoming: File[] = [];
  let duplicateCount = 0;
  for (const file of withinPerFileLimit) {
    const identity = fileIdentity(file);
    if (seen.has(identity)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(identity);
    uniqueIncoming.push(file);
  }

  const combinedFiles = [...currentFiles, ...uniqueIncoming];
  const countLimitedFiles = combinedFiles.slice(0, limits.max_files_per_upload);
  const countRejectedCount = combinedFiles.length - countLimitedFiles.length;

  const totalLimitBytes = limits.max_total_upload_size_mb * 1024 * 1024;
  const files: File[] = [];
  let totalBytes = 0;
  let totalSizeRejectedCount = 0;
  for (const file of countLimitedFiles) {
    if (totalBytes + file.size > totalLimitBytes) {
      totalSizeRejectedCount += 1;
      continue;
    }
    files.push(file);
    totalBytes += file.size;
  }

  return {
    files,
    duplicateCount,
    unsupportedCount,
    oversizedCount,
    countRejectedCount,
    totalSizeRejectedCount,
  };
}
