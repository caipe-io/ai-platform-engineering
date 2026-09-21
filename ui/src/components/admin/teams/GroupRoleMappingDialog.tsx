"use client";

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
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Loader2 } from "lucide-react";
import React,{ useEffect,useState } from "react";

interface IdpAlias {
  alias: string;
  displayName?: string;
  providerId: string;
}

interface Role {
  name: string;
}

interface GroupRoleMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  idpAliases: IdpAlias[];
  roles: Role[];
}

export function GroupRoleMappingDialog({
  open,
  onOpenChange,
  onSuccess,
  idpAliases,
  roles,
}: GroupRoleMappingDialogProps) {
  const [selectedIdp, setSelectedIdp] = useState("");
  const [groupName, setGroupName] = useState("");
  const [selectedRole, setSelectedRole] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && idpAliases.length > 0 && !selectedIdp) {
      setSelectedIdp(idpAliases[0].alias);
    }
    if (open && roles.length > 0 && !selectedRole) {
      setSelectedRole(roles[0].name);
    }
  }, [open, idpAliases, roles, selectedIdp, selectedRole]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/role-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idpAlias: selectedIdp,
          groupName: groupName.trim(),
          roleName: selectedRole,
        }),
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || "Failed to create mapping");
      }

      setGroupName("");
      onOpenChange(false);
      onSuccess();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create mapping";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setGroupName("");
      setError(null);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Map Group to Role</DialogTitle>
          <DialogDescription>
            Create a mapping so that users in the specified IdP group
            automatically receive the selected Keycloak role on login.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="idpAlias">
                Identity Provider <span className="text-destructive">*</span>
              </Label>
              <SearchablePicker
                id="idpAlias"
                options={idpAliases}
                selected={idpAliases.find((idp) => idp.alias === selectedIdp)}
                onSelect={(idp) => setSelectedIdp(idp.alias)}
                getOptionKey={(idp) => idp.alias}
                getOptionLabel={(idp) =>
                  `${idp.displayName || idp.alias} (${idp.providerId})`
                }
                getSearchText={(idp) => [
                  idp.alias,
                  idp.displayName ?? "",
                  idp.providerId,
                ]}
                placeholder="Select an identity provider"
                searchPlaceholder="Search identity providers..."
                emptyLabel="No identity providers configured"
                ariaLabel="Identity Provider"
                required
                disabled={loading || idpAliases.length === 0}
                triggerClassName="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="groupName">
                Group Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="groupName"
                placeholder="e.g., caipe-admins"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                disabled={loading}
                required
              />
              <p className="text-xs text-muted-foreground">
                The AD/IdP group name (from the &quot;groups&quot; claim) that
                should receive this role
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="targetRole">
                Target Role <span className="text-destructive">*</span>
              </Label>
              <SearchablePicker
                id="targetRole"
                options={roles}
                selected={roles.find((role) => role.name === selectedRole)}
                onSelect={(role) => setSelectedRole(role.name)}
                getOptionKey={(role) => role.name}
                getOptionLabel={(role) => role.name}
                placeholder="Select a target role"
                searchPlaceholder="Search roles..."
                emptyLabel="No roles available"
                ariaLabel="Target Role"
                required
                disabled={loading || roles.length === 0}
                triggerClassName="h-10"
              />
            </div>

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
            <Button
              type="submit"
              disabled={
                loading ||
                !selectedIdp ||
                !groupName.trim() ||
                !selectedRole
              }
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Mapping"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
