"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, FolderPlus } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { useChatHistoryOrganization } from "@/hooks/use-chat-history-organization";

type Organization = ReturnType<typeof useChatHistoryOrganization>;
export type OrganizationDialog = { kind: "create" } | { kind: "rename"; id: string; name: string }
  | { kind: "move"; id: string; title: string };

export function ChatHistoryOrganizationControls({ state, dialog, onDialog, sources, source, onSourceChange, allowFolders = true, allowGrouping = true }: {
  state: Organization; dialog: OrganizationDialog | null; onDialog: (value: OrganizationDialog | null) => void;
  sources: ReadonlyArray<{ value: string; label: string; content: ReactNode }>;
  source: string; onSourceChange: (value: string) => void; allowFolders?: boolean; allowGrouping?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const selectedSource = sources.find(option => option.value === source) ?? sources[0];
  return <>
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen} className="min-w-0 flex-1">
        <PopoverTrigger asChild>
          <button type="button" aria-label="Filter chat history" aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-menu`}
            className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {selectedSource?.content}<ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[280px] max-w-[calc(100vw-16px)] p-2">
          <div id={`${id}-menu`} role="dialog" aria-label="Chat history options">
            <fieldset>
              <legend className="px-2 py-1 text-xs font-medium text-muted-foreground">Chat source</legend>
              {sources.map(option => <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-accent focus-within:bg-accent">
                <input type="radio" name={`${id}-source`} value={option.value} aria-label={option.label}
                  checked={option.value === source} autoFocus={option.value === source}
                  className="h-3.5 w-3.5 shrink-0 accent-primary" onChange={() => onSourceChange(option.value)} />
                {option.content}
              </label>)}
            </fieldset>
            {allowGrouping && <fieldset className="mt-2 border-t border-border pt-2" disabled={!state.ready || state.saving}>
              <legend className="px-2 text-xs font-medium text-muted-foreground">Group by</legend>
              {([{ value: "ungrouped", label: "Ungrouped" }, { value: "agents", label: "Agent" }, { value: "folders", label: "Folders" }] as const).filter(option => allowFolders || option.value !== "folders").map(option =>
                <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-accent focus-within:bg-accent has-[:disabled]:cursor-default has-[:disabled]:opacity-50">
                  <input type="radio" name={`${id}-group`} value={option.value} checked={state.value.view === option.value}
                    className="h-3.5 w-3.5 shrink-0 accent-primary" onChange={() => void state.update(value => ({ ...value, view: option.value }))} />
                  {option.label}
                </label>)}
            </fieldset>}
          </div>
        </PopoverContent>
      </Popover>
      {allowFolders && <Button size="icon" variant="ghost" aria-label="New chat folder" title="New chat folder" className="h-8 w-8 shrink-0"
        disabled={!state.ready || state.saving || state.value.folders.length >= 100} onClick={() => onDialog({ kind: "create" })}>
        <FolderPlus className="h-4 w-4" />
      </Button>}
    </div>
    {state.error && <p role="alert" className="pt-1 text-xs text-destructive">{state.error} {!state.ready && <button type="button" className="underline" onClick={state.retry}>Retry</button>}</p>}
    <Dialog open={allowFolders && !!dialog} onOpenChange={open => { if (!open && !state.saving) onDialog(null); }}>
      {allowFolders && dialog && <OrganizationForm key={JSON.stringify(dialog)} state={state} dialog={dialog} close={() => onDialog(null)} />}
    </Dialog>
  </>;
}

function OrganizationForm({ state, dialog, close }: { state: Organization; dialog: OrganizationDialog; close: () => void }) {
  const [name, setName] = useState(dialog.kind === "rename" ? dialog.name : "");
  const [folder, setFolder] = useState(dialog.kind === "move" ? state.value.assignments[dialog.id] ?? "" : "");
  const folderRanks = new Map((state.value.groupOrder ?? []).map((key, index) => [key, index]));
  const options = [{ id: "", name: "Unfiled" }, ...state.value.folders].sort((a, b) =>
    (folderRanks.get(`folder:${a.id || "unfiled"}`) ?? Infinity) - (folderRanks.get(`folder:${b.id || "unfiled"}`) ?? Infinity));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const saved = await state.update(v => {
      if (dialog.kind === "move") {
        const assignments = { ...v.assignments }; if (folder) assignments[dialog.id] = folder; else delete assignments[dialog.id];
        return { ...v, assignments };
      }
      return { ...v, view: "folders", folders: dialog.kind === "create" ? [...v.folders, { id: uuidv4(), name }]
        : v.folders.map(f => f.id === dialog.id ? { ...f, name } : f) };
    });
    if (saved) close();
  };
  return <DialogContent>
    <DialogHeader><DialogTitle>{dialog.kind === "move" ? "Move chat to folder" : dialog.kind === "rename" ? "Rename folder" : "New chat folder"}</DialogTitle>
      <DialogDescription>{dialog.kind === "move" ? dialog.title : "Folders organize your history and are visible only to you."}</DialogDescription></DialogHeader>
    <form onSubmit={e => void submit(e)} className="space-y-4">
      {dialog.kind === "move" ? <SearchablePicker options={options} selected={options.find(o => o.id === folder)}
        onSelect={o => setFolder(o.id)} getOptionKey={o => o.id || "unfiled"} getOptionLabel={o => o.name}
        ariaLabel="Destination folder" placeholder="Choose a folder" searchPlaceholder="Find a folder…" emptyLabel="No folders match" required disabled={state.saving} />
        : <label className="block text-sm">Folder name<input autoFocus required maxLength={80} value={name} disabled={state.saving}
          onChange={e => setName(e.target.value)} className="mt-2 h-10 w-full rounded-md border bg-background px-3" /></label>}
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={state.saving} onClick={close}>Cancel</Button>
        <Button type="submit" disabled={state.saving || (dialog.kind !== "move" && !name.trim())}>{state.saving ? "Saving…" : "Save"}</Button></div>
    </form>
  </DialogContent>;
}
