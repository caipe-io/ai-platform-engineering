// assisted-by Codex Codex-sonnet-4-6

const STEPS = [
  {
    title: "Choose the runtime",
    body: "Start with a separate process or container and expose health, API, and optional /embed fragment endpoints.",
  },
  {
    title: "Declare the manifest",
    body: "Define the app ID, /apps/* mount path, RBAC, token scopes, agents, data access, and health check.",
  },
  {
    title: "Pick the render mode",
    body: "Use a CAIPE-owned integrated page for native shell UX, then call proxied app APIs for data and AG-UI layout intent.",
  },
  {
    title: "Install as admin",
    body: "Enable the app from host configuration first; admin-installed catalog and policy editing can replace static config later.",
  },
];

export function AgenticAppCreateGuide() {
  return (
    <main className="flex-1 overflow-y-auto bg-slate-950 px-6 py-8 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <section className="rounded-3xl border border-violet-300/20 bg-gradient-to-br from-violet-500/15 via-cyan-400/10 to-slate-900 p-8 shadow-2xl shadow-violet-950/30">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-violet-200">
            Agentic app builder
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">
            Create or add your app
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300">
            Use this guide to turn a team-owned agentic UI into a trusted CAIPE app:
            separate runtime, explicit manifest, host-owned auth, and integrated
            rendering where the CAIPE shell stays visible.
          </p>
        </section>

        <section className="grid gap-5 md:grid-cols-2">
          {STEPS.map((step, index) => (
            <article
              key={step.title}
              className="rounded-3xl border border-white/10 bg-slate-900/75 p-6 shadow-xl shadow-slate-950/30"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan-200/20 bg-cyan-300/10 text-sm font-semibold text-cyan-100">
                {index + 1}
              </div>
              <h2 className="mt-5 text-xl font-semibold text-white">{step.title}</h2>
              <p className="mt-3 text-sm leading-6 text-slate-300">{step.body}</p>
            </article>
          ))}
        </section>

        <section className="rounded-3xl border border-white/10 bg-slate-900/75 p-6">
          <h2 className="text-xl font-semibold text-white">Starter contract</h2>
          <pre className="mt-5 overflow-auto rounded-2xl border border-cyan-300/20 bg-slate-950/80 p-4 text-xs leading-5 text-cyan-100">
{`{
  "id": "my-agentic-app",
  "runtime": {
    "kind": "proxied-next-zone",
    "origin": "http://localhost:3020",
    "mountPath": "/apps/my-agentic-app"
  },
  "access": {
    "roles": ["user"],
    "tokenScopes": ["agents:invoke"]
  },
  "health": { "endpoint": "/healthz" }
}`}
          </pre>
        </section>
      </div>
    </main>
  );
}
