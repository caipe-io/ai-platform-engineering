export type ProductTourId =
  | "workspace"
  | "add-model"
  | "add-mcp"
  | "add-agent"
  | "chat"
  | "credentials";
export type TourIcon =
  | "compass"
  | "sparkles"
  | "chat"
  | "settings"
  | "model"
  | "server"
  | "agent"
  | "credentials";

export interface TourStep {
  description: string;
  eyebrow: string;
  icon: TourIcon;
  points: string[];
  title: string;
  target: string;
  href?: string;
  action?: string;
  expected?: string;
}

export interface ProductTourDefinition {
  title: string;
  description: string;
  icon: TourIcon;
  agentWorkspace?: boolean;
  steps: TourStep[];
}

export const PRODUCT_TOURS: Record<ProductTourId, ProductTourDefinition> = {
  workspace: {
    title: "Workspace tour",
    description: "Find your way around the workspace.",
    icon: "compass",
    steps: [
      {
        eyebrow: "Welcome",
        target: '[aria-label="Application navigation"]',
        title: "Your workspace is ready",
        description:
          "This quick tour shows the five places you will use most. It takes about a minute and is saved to your account.",
        icon: "sparkles",
        points: [
          "Start work from Home",
          "Collaborate with agents in Chat",
          "Reuse skills and trusted knowledge",
        ],
      },
      {
        eyebrow: "Home",
        target: '[aria-label="Application navigation"] a[href="/"]',
        href: "/",
        action: "Explore Home",
        title: "Pick up where you left off",
        description:
          "Home is your personal launchpad for recent conversations, suggested actions, and the work that matters now.",
        icon: "compass",
        points: [
          "Resume recent conversations",
          "Launch common workflows",
          "Customize the widgets you see",
        ],
      },
      {
        eyebrow: "Chat",
        target: '[aria-label="Application navigation"] a[href^="/chat"]',
        href: "/chat",
        action: "Open Chat",
        title: "Work with the right agent",
        description:
          "Start a conversation, choose an available agent, and keep follow-up questions in the same thread so context carries forward.",
        icon: "chat",
        points: [
          "Choose an agent for the task",
          "Attach files and invoke tools",
          "Review evidence before acting",
        ],
      },
      {
        eyebrow: "Skills & knowledge",
        target: '[aria-label="Application navigation"] a[href="/skills"]',
        href: "/skills",
        action: "Browse skills",
        title: "Reuse trusted building blocks",
        description:
          "Skills capture repeatable playbooks. Knowledge bases ground answers in sources you are allowed to access.",
        icon: "sparkles",
        points: [
          "Browse reusable skills",
          "Search approved knowledge",
          "Access remains permission-aware",
        ],
      },
      {
        eyebrow: "You are all set",
        target: 'button[aria-label^="User menu"]',
        href: "/settings/chat",
        action: "Personalize your workspace",
        title: "Make the workspace yours",
        description:
          "Use Settings to choose default agents, tune conversation behavior, and replay this tour whenever you need it.",
        icon: "settings",
        points: [
          "Set your preferred agents",
          "Adjust appearance and notifications",
          "Start with a real question in Chat",
        ],
      },
    ],
  },
  "add-model": {
    title: "Add a model",
    description: "Connect a provider and register its model.",
    icon: "model",
    agentWorkspace: true,
    steps: [
      {
        eyebrow: "Provider access",
        icon: "credentials",
        title: "Connect the model provider",
        target: '[data-tour="model-providers"]',
        href: "/dynamic-agents?tab=model-providers",
        action: "Open Model Providers",
        description:
          "Choose the provider your model uses and configure its connection.",
        points: [
          "Use the endpoint and authentication supplied by your administrator.",
          "A registered model still needs a reachable provider.",
        ],
        expected: "The provider connection is saved.",
      },
      {
        eyebrow: "Model catalog",
        icon: "model",
        title: "Register an available model",
        target: '[data-tour="add-model"]',
        href: "/dynamic-agents?tab=llm-models",
        action: "Open LLM Models",
        description:
          "Choose Add Model to make a provider model available to agent builders.",
        points: [
          "Check the list first to avoid a duplicate.",
          "Registration requires permission to manage models.",
        ],
        expected: "The model form opens.",
      },
      {
        eyebrow: "Model details",
        icon: "model",
        title: "Match the provider identifiers",
        target: "#model-id",
        description:
          "Enter the provider’s exact Model ID, a display name, and its configured Provider name.",
        points: [
          "Use the identifier your provider actually serves.",
          "Choose Add Model to save the entry.",
        ],
        expected: "The new model appears in LLM Models.",
      },
      {
        eyebrow: "Try it",
        icon: "chat",
        title: "Verify with a conversation",
        target: '[aria-label^="Choose agent"]',
        href: "/chat",
        action: "Open Chat",
        description:
          "Select an agent that uses this model and send a short prompt.",
        points: [
          "Confirm that you selected the intended agent and model.",
          "If it fails, check provider access and the model identifier.",
        ],
        expected: "The agent returns a response using the configured model.",
      },
    ],
  },
  "add-mcp": {
    title: "Add an MCP server",
    description: "Connect tools, then test one call.",
    icon: "server",
    agentWorkspace: true,
    steps: [
      {
        eyebrow: "Tool connection",
        icon: "server",
        title: "Start a server connection",
        target: '[data-tour="add-mcp"]',
        href: "/dynamic-agents?tab=mcp-servers",
        action: "Open MCP Servers",
        description:
          "Choose Add Server, then select a catalog entry or Custom / Blank form.",
        points: [
          "Use a service reachable from this deployment.",
          "You need permission to create the connection.",
        ],
        expected: "The server configuration form opens.",
      },
      {
        eyebrow: "Endpoint",
        icon: "server",
        title: "Check the server address",
        target: "#endpoint",
        description:
          "Give the server a display name, choose its transport, and enter the endpoint supplied by its operator.",
        points: [
          "For an HTTP endpoint, choose Check URL.",
          "Resolve connection errors before creating the server.",
        ],
        expected: "The endpoint check reports a response.",
      },
      {
        eyebrow: "Authentication",
        icon: "credentials",
        title: "Choose the required credentials",
        target: '[data-tour="mcp-auth"]',
        description:
          "Configure the authentication this server requires, or leave it unauthenticated only if the service supports that.",
        points: [
          "Use a connected account or saved secret when required.",
          "Choose Create Server after reviewing the connection.",
        ],
        expected: "The server appears in the list.",
      },
      {
        eyebrow: "Test a tool",
        icon: "server",
        title: "Try a tool before using an agent",
        target: '[data-tour="mcp-servers"]',
        description:
          "On the server row, open Test MCP tools, select a tool, supply its required inputs, and run it.",
        points: [
          "Start with a read-only tool and inspect the returned data.",
          "Assign the server to an agent when you are ready.",
        ],
        expected: "The tool test returns a successful result.",
      },
    ],
  },
  "add-agent": {
    title: "Add an agent",
    description: "Give a model a purpose and useful tools.",
    icon: "agent",
    agentWorkspace: true,
    steps: [
      {
        eyebrow: "New agent",
        icon: "agent",
        title: "Create an agent for one purpose",
        target: '[data-tour="add-agent"]',
        href: "/dynamic-agents?tab=agents",
        action: "Open Agents",
        description: "Choose New Agent to open the creation wizard.",
        points: [
          "Have a working model ready.",
          "Tools are optional for a basic conversation.",
        ],
        expected: "The Basic Info step opens.",
      },
      {
        eyebrow: "Basic Info",
        icon: "model",
        title: "Choose its model and audience",
        target: "#name",
        description:
          "Name the agent and select its LLM Model. Set the owner team and visibility for the people who should use it.",
        points: [
          "Keep the default execution harness unless your task needs another.",
          "Choose Next to continue to Instructions.",
        ],
        expected: "The agent has a name, model, and appropriate access.",
      },
      {
        eyebrow: "Instructions",
        icon: "sparkles",
        title: "Describe the job clearly",
        target: 'label[for="systemPrompt"]',
        description:
          "Write a System Prompt explaining what the agent should do and what a useful answer looks like.",
        points: [
          "Tell it to explain missing evidence rather than guess.",
          "Choose Next to configure Tools.",
        ],
        expected: "The prompt describes the agent’s purpose and limits.",
      },
      {
        eyebrow: "Tools",
        icon: "server",
        title: "Select only the tools it needs",
        target: '[data-tour="agent-tools"]',
        description:
          "Under MCP Tool Access, select the servers needed for the job, then choose Create Agent.",
        points: [
          "A model-only agent can start without extra tools.",
          "Review the configuration before saving.",
        ],
        expected: "The agent appears in the Agents list.",
      },
      {
        eyebrow: "First conversation",
        icon: "chat",
        title: "Test the agent you created",
        target: '[aria-label^="Choose agent"]',
        href: "/chat",
        action: "Open Chat",
        description:
          "Select your new agent and ask a question that matches its purpose.",
        points: [
          "Inspect any tool calls behind its response.",
          "Ask a follow-up in the same conversation.",
        ],
        expected:
          "The agent answers with the configured instructions and tools.",
      },
    ],
  },
  chat: {
    title: "Chat with an agent",
    description: "Ask, inspect the answer, and follow up.",
    icon: "chat",
    steps: [
      {
        eyebrow: "Pick an agent",
        icon: "agent",
        title: "Choose who you want to work with",
        target: '[aria-label^="Choose agent"]',
        href: "/chat",
        action: "Open Chat",
        description:
          "Open the agent picker and select an agent suited to your task.",
        points: [
          "You only see agents you can access.",
          "Check the active agent before sending a message.",
        ],
        expected: "The conversation identifies your selected agent.",
      },
      {
        eyebrow: "Your question",
        icon: "chat",
        title: "Give it a clear starting point",
        target: '[aria-label="Message"]',
        description:
          "Write the question, include the context it needs, and choose Send message.",
        points: [
          "Explain the result you want.",
          "Attach a relevant file when your task needs it.",
        ],
        expected: "The agent starts responding in this conversation.",
      },
      {
        eyebrow: "Check the evidence",
        icon: "sparkles",
        title: "Look behind the answer",
        target: '[data-tour="chat-response"]',
        description:
          "Read the response and inspect any tool results or source references it provides.",
        points: [
          "Check that the retrieved data supports the answer.",
          "Ask for clarification when information is missing.",
        ],
        expected:
          "You can distinguish source data from the agent’s interpretation.",
      },
      {
        eyebrow: "Follow up",
        icon: "chat",
        title: "Keep the conversation going",
        target: '[aria-label="Message"]',
        description:
          "Ask a follow-up in the same chat so the agent can use the earlier context.",
        points: [
          "Refine the question or request a different format.",
          "Return to this conversation from your chat history.",
        ],
        expected: "The next response builds on your earlier question.",
      },
    ],
  },
  credentials: {
    title: "Connect credentials",
    description: "Connect an account and check its access.",
    icon: "credentials",
    steps: [
      {
        eyebrow: "Connected Apps",
        icon: "credentials",
        title: "Connect an account for your tools",
        target: '[data-tour="connected-apps"]',
        href: "/credentials/connections",
        action: "Open Connected Apps",
        description:
          "Choose the app you want to connect from the providers configured for this deployment.",
        points: [
          "Ask an admin to enable an app if it is missing.",
          "Your connection belongs to your signed-in account.",
        ],
        expected: "The app you need is listed.",
      },
      {
        eyebrow: "Authorize",
        icon: "credentials",
        title: "Review the requested access",
        target: '[data-tour="connection-actions"]',
        description:
          "Review the available scopes, choose Connect, and complete the provider’s sign-in and consent flow.",
        points: [
          "Grant the access your task requires.",
          "Return here after the provider redirects you back.",
        ],
        expected: "The app shows a connected status.",
      },
      {
        eyebrow: "Connection health",
        icon: "credentials",
        title: "Check that the connection works",
        target: '[data-tour="connection-health"]',
        description:
          "Review connection health and use the test action when the provider supports it.",
        points: [
          "Reconnect if access has expired or the provider requires it.",
          "A connected account still needs permission to use the target service.",
        ],
        expected: "The connection is ready for the tools that use it.",
      },
      {
        eyebrow: "Saved Secrets",
        icon: "credentials",
        title: "Use a saved secret when needed",
        target: '[data-tour="saved-secrets"]',
        href: "/credentials/secrets",
        action: "Open Saved Secrets",
        description:
          "For an API key or token instead of an account connection, use Saved Secrets and reference it from the relevant configuration.",
        points: [
          "Choose the appropriate owner and sharing scope.",
          "Keep credential values out of prompts and agent instructions.",
        ],
        expected:
          "The required credential is saved or your connected account is ready.",
      },
    ],
  },
};

export function isProductTourId(value: unknown): value is ProductTourId {
  return typeof value === "string" && Object.hasOwn(PRODUCT_TOURS, value);
}
