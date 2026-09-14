"use client";

import { FolderKanban, Rocket } from "lucide-react";

/**
 * Public Projects entry point.
 *
 * Project catalog providers and lifecycle operations can register here
 * without coupling the application shell to a specific provider.
 */
export function ProjectsHub() {
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <section className="w-full max-w-2xl rounded-2xl border border-border/60 bg-card/40 p-8 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <FolderKanban className="h-7 w-7" aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          A shared workspace for organizing projects, teams, and connected
          resources.
        </p>
        <div className="mt-8 rounded-xl border border-dashed border-border p-6 text-left">
          <div className="flex items-start gap-3">
            <Rocket className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <h2 className="font-medium">Project catalog coming soon</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Enable this surface to provide a neutral home for project
                providers and onboarding workflows.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
