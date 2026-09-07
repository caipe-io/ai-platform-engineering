"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { FolderKanban,Loader2,Plus } from "lucide-react";
import { useCallback,useEffect,useState } from "react";

interface Project {
  id: string;
  name: string;
}

/**
 * User-owned Project catalog and create-only lifecycle surface.
 */
export function ProjectsHub() {
  const [projects,setProjects] = useState<Project[]>([]);
  const [name,setName] = useState("");
  const [loading,setLoading] = useState(true);
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState<string | null>(null);
  const { toast } = useToast();

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/user/projects",{ cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || "Could not load Projects");
      }
      setProjects(Array.isArray(payload.data?.items) ? payload.data.items : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const createProject = async () => {
    const projectName = name.trim();
    if (!projectName || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/user/projects",{
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        const detail = payload.detail;
        throw new Error(
          typeof detail === "string"
            ? detail
            : detail?.message || payload.error || "Could not create Project",
        );
      }
      const project = payload.data?.project as Project | undefined;
      if (!project?.id || !project.name) throw new Error("Project response was invalid");
      setProjects((current) => [...current,project].sort((left,right) => left.name.localeCompare(right.name)));
      setName("");
      toast(`Created Project “${project.name}”`,"success");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Could not create Project","error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-4xl p-6">
      <section className="rounded-2xl border border-border/60 bg-card/40 p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FolderKanban className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Shared workspaces for chat history, files, and Project memory.
            </p>
          </div>
        </div>

        <div className="mt-6 flex max-w-xl gap-2">
          <Input
            aria-label="Project name"
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createProject();
            }}
            placeholder="Project name"
            value={name}
          />
          <Button disabled={!name.trim() || saving} onClick={() => void createProject()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create
          </Button>
        </div>

        <div className="mt-6">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading Projects…
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          ) : projects.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
              No Projects yet. Create one to share chat history, files, and memory across conversations.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2" aria-label="Projects">
              {projects.map((project) => (
                <article key={project.id} className="rounded-xl border border-border/70 bg-background/60 p-4">
                  <div className="flex items-center gap-2 font-medium">
                    <FolderKanban className="h-4 w-4 text-primary" />
                    <span>{project.name}</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    ID: <code>{project.id}</code>
                  </p>
                </article>
              ))}
            </div>
          )}
          </div>
      </section>
    </main>
  );
}
