import { getErrorMessage } from "@/lib/error-utils";
import { Button } from "@/components/ui/button";
import {
Dialog,
DialogContent,
DialogDescription,
DialogFooter,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import React,{ useEffect,useState } from "react";

interface CreateTeamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function CreateTeamDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateTeamDialogProps) {
  const [teamName, setTeamName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [userEmails, setUserEmails] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberSearchResults, setMemberSearchResults] = useState<string[]>([]);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [memberSearchFailed, setMemberSearchFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // /api/admin/users returns Keycloak realm users in the shape
    // { users: [{ email, ... }], total, page, pageSize } (no success/data envelope).
    // This is only the first page, used as the default browse list before
    // the user types a search query.
    fetch("/api/admin/users?pageSize=100")
      .then((r) => r.json())
      .then((res) => {
        const users = Array.isArray(res?.users) ? res.users : res?.data?.users;
        if (Array.isArray(users)) {
          setUserEmails(
            users
              .map((u: { email?: string }) => u.email)
              .filter(Boolean)
          );
        }
      })
      .catch(() => {});
  }, [open]);

  // Searching should look up all Keycloak users, not just the first page
  // loaded above, so it's a debounced server-side query.
  useEffect(() => {
    if (!open) return;
    const query = memberSearch.trim();
    if (query.length < 2) {
      setMemberSearchResults([]);
      setMemberSearchLoading(false);
      setMemberSearchFailed(false);
      return;
    }
    const ctrl = new AbortController();
    // Clear the prior query's results and error state immediately — since
    // MultiSelect doesn't filter `options` itself in this mode, a stale
    // match from the last query would otherwise stay selectable while this
    // one is still debouncing/in flight.
    setMemberSearchResults([]);
    setMemberSearchFailed(false);
    setMemberSearchLoading(true);
    const handle = setTimeout(() => {
      const params = new URLSearchParams({ search: query, pageSize: "50" });
      fetch(`/api/admin/users?${params.toString()}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((res) => {
          const users = Array.isArray(res?.users) ? res.users : res?.data?.users;
          setMemberSearchResults(
            Array.isArray(users)
              ? users.map((u: { email?: string }) => u.email).filter(Boolean)
              : []
          );
        })
        .catch((err) => {
          // An aborted request was superseded by a newer query, whose own
          // effect run already reset the loading/error state above — leave
          // it alone. A real failure is distinct from "no matches": surface
          // it as an error rather than silently reporting zero results.
          if (err?.name === "AbortError") return;
          console.error("[CreateTeamDialog] Member search failed:", err);
          setMemberSearchResults([]);
          setMemberSearchFailed(true);
        })
        .finally(() => {
          // A newer keystroke may have already aborted this request and
          // started its own — don't let this stale request's `finally`
          // clear the loading flag the newer one just set to true.
          if (!ctrl.signal.aborted) setMemberSearchLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [open, memberSearch]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/teams", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: teamName,
          description: description || undefined,
          members: selectedMembers.length > 0 ? selectedMembers : undefined,
        }),
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Failed to create team");
      }

      // Reset form
      setTeamName("");
      setDescription("");
      setSelectedMembers([]);
      setMemberSearch("");

      // Close dialog and trigger refresh
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      console.error("[CreateTeamDialog] Failed to create team:", err);
      setError(getErrorMessage(err, "") || "Failed to create team");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setTeamName("");
      setDescription("");
      setSelectedMembers([]);
      setMemberSearch("");
      setError(null);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Team</DialogTitle>
          <DialogDescription>
            Create a team to enable collaboration and conversation sharing among members.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* Team Name */}
            <div className="space-y-2">
              <Label htmlFor="teamName">
                Team Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="teamName"
                placeholder="e.g., Platform Engineering Team"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                disabled={loading}
                required
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="What is this team for?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={loading}
                rows={3}
              />
            </div>

            {/* Members */}
            <div className="space-y-2">
              <Label>
                Members (Optional)
              </Label>
              <MultiSelect
                options={memberSearch.trim().length >= 2 ? memberSearchResults : userEmails}
                selected={selectedMembers}
                onChange={setSelectedMembers}
                onSearchChange={setMemberSearch}
                searchLoading={memberSearchLoading}
                placeholder="Search and select members..."
                searchPlaceholder="Search by name or email..."
                emptyLabel={memberSearchFailed ? "Search failed — try again" : "No users found"}
                badgeLabel="members"
                className="w-full max-w-full"
              />
              <p className="text-xs text-muted-foreground">
                You will be added as the team owner automatically
              </p>
            </div>

            {/* Error Message */}
            {error && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !teamName.trim()}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Team"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
