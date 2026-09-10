"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { Check,Pencil,X } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { useCallback,useState } from "react";

interface ToolApprovalCardProps {
  toolName: string;
  toolArgs: Record<string, unknown>;
  allowedDecisions: string[];
  onApprove: () => void;
  onReject: () => void;
  onEdit: (editedArgs: Record<string, unknown>) => void;
  disabled?: boolean;
  /** Total number of approvals in this batch (omitted or 1 = no count shown) */
  totalCount?: number;
}

export function ToolApprovalCard({
  toolName,
  toolArgs,
  allowedDecisions,
  onApprove,
  onReject,
  onEdit,
  disabled = false,
  totalCount,
}: ToolApprovalCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedJson, setEditedJson] = useState(() => JSON.stringify(toolArgs, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const canApprove = allowedDecisions.includes("approve");
  const canReject = allowedDecisions.includes("reject");
  const canEdit = allowedDecisions.includes("edit");

  const handleEditSubmit = useCallback(() => {
    try {
      const parsed = JSON.parse(editedJson);
      setJsonError(null);
      onEdit(parsed);
    } catch {
      setJsonError("Invalid JSON");
    }
  }, [editedJson, onEdit]);

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-medium">{totalCount && totalCount > 1 ? `${totalCount} Approvals required` : "Approval required"}</span>
        <Badge variant="outline" className="text-xs font-mono">
          {toolName}
        </Badge>
      </div>

      {/* Args display / editor */}
      <div className="rounded-md border overflow-hidden">
        <CodeMirror
          value={isEditing ? editedJson : JSON.stringify(toolArgs, null, 2)}
          extensions={[json()]}
          theme={isDark ? oneDark : "light"}
          editable={isEditing}
          readOnly={!isEditing}
          onChange={(value) => {
            setEditedJson(value);
            setJsonError(null);
          }}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: isEditing,
          }}
          className={cn(
            "text-xs",
            !isEditing && "opacity-80",
          )}
          maxHeight="200px"
        />
      </div>

      {/* JSON error */}
      {jsonError && (
        <p className="text-xs text-destructive">{jsonError}</p>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        {isEditing ? (
          <>
            <Button
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={handleEditSubmit}
              disabled={disabled}
            >
              <Check className="h-3 w-3" />
              Submit edited args
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                setIsEditing(false);
                setEditedJson(JSON.stringify(toolArgs, null, 2));
                setJsonError(null);
              }}
              disabled={disabled}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            {canApprove && (
              <Button
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={onApprove}
                disabled={disabled}
              >
                <Check className="h-3 w-3" />
                Approve
              </Button>
            )}
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                onClick={() => setIsEditing(true)}
                disabled={disabled}
              >
                <Pencil className="h-3 w-3" />
                Edit
              </Button>
            )}
            {canReject && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive"
                onClick={onReject}
                disabled={disabled}
              >
                <X className="h-3 w-3" />
                Reject
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
