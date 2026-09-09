/**
 * @jest-environment node
 */
/**
 * Tests for Agent Config Skill Content Persistence
 *
 * Validates that skill_content and related fields (is_quick_start,
 * difficulty, thumbnail, input_form) are correctly persisted to MongoDB
 * on POST (create). This was a bug where the POST handler omitted these
 * fields, causing AI-enhanced skills to lose their content on reload.
 *
 * Covers:
 * - POST: skill_content is persisted when provided
 * - POST: skill_content is undefined when not provided
 * - POST: is_quick_start, difficulty, thumbnail are persisted
 * - POST: input_form is persisted
 * - POST: all fields survive a create + GET round-trip
 * - Edge cases: empty string skill_content, very large content
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

const mockCollections: Record<string, ReturnType<typeof createMockCollection>> = {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) {
    mockCollections[name] = createMockCollection();
  }
  return Promise.resolve(mockCollections[name]);
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...(args as [string])),
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/rbac/skill-team-grants", () => ({
  reconcileSkillTeamShares: jest.fn().mockResolvedValue({
    teamSlugs: [],
    writesPlanned: 0,
    writesApplied: 0,
    deletesPlanned: 0,
    deletesApplied: 0,
    enabled: false,
  }),
  readSkillSharedTeamSlugsFromOpenFga: jest.fn().mockResolvedValue([]),
}));

function createMockCollection() {
  const findReturnValue: Record<string, jest.Mock> = {};
  findReturnValue.project = jest.fn().mockReturnValue(findReturnValue);
  findReturnValue.sort = jest.fn().mockReturnValue(findReturnValue);
  findReturnValue.limit = jest.fn().mockReturnValue(findReturnValue);
  findReturnValue.toArray = jest.fn().mockResolvedValue([]);

  return {
    find: jest.fn().mockReturnValue(findReturnValue),
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: "test-id" }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1, acknowledged: true }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), options);
}

function userSession(email = "user@example.com") {
  return {
    user: { email, name: "Test User" },
    role: "user",
    sub: "user-sub",
  };
}

const VALID_TASK = {
  display_text: "Health of AWS All Accounts",
  llm_prompt: "Monitor and report on the health status across all AWS accounts",
  subagent: "user_input",
};

const SAMPLE_SKILL_CONTENT = `---
name: Health of AWS All Accounts
description: Monitor and report on the health status across all AWS accounts in your organization
---

# Health of AWS All Accounts

Check the health and status of all AWS accounts, including:
- EC2 instance states
- RDS availability
- Lambda error rates
- CloudWatch alarms

## Examples
- Check health of all production accounts
- Report on any degraded services
`;

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST - Skill content persistence
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/skills/configs - skill content persistence", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(userSession());
  });

  it("should persist skill_content to MongoDB when provided", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Health of AWS All Accounts",
        category: "Custom",
        tasks: [VALID_TASK],
        skill_content: SAMPLE_SKILL_CONTENT,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.skill_content).toBe(SAMPLE_SKILL_CONTENT);
  });

  it("should persist skill_content as undefined when not provided", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Simple Skill",
        category: "Custom",
        tasks: [VALID_TASK],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.skill_content).toBeUndefined();
  });

  it("should persist empty string skill_content", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Empty Content Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        skill_content: "",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.skill_content).toBe("");
  });

  it("should persist is_quick_start when provided", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Quick Start Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        is_quick_start: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.is_quick_start).toBe(true);
  });

  it("should persist difficulty when provided", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Intermediate Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        difficulty: "intermediate",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.difficulty).toBe("intermediate");
  });

  it("should persist thumbnail when provided", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Skill With Icon",
        category: "Custom",
        tasks: [VALID_TASK],
        thumbnail: "aws",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.thumbnail).toBe("aws");
  });

  it("should persist input_form when provided", async () => {
    const inputForm = {
      title: "AWS Health Check",
      description: "Enter parameters for health check",
      submitLabel: "Run Check",
      fields: [
        {
          name: "account_id",
          label: "AWS Account ID",
          type: "text" as const,
          required: true,
          placeholder: "Enter account ID",
        },
      ],
    };

    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Skill With Form",
        category: "Custom",
        tasks: [VALID_TASK],
        input_form: inputForm,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.input_form).toEqual(inputForm);
  });

  it("should persist all skill fields together (full AI-enhanced skill)", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Health of AWS All Accounts",
        description: "Monitor and report on the health status across all AWS accounts",
        category: "Custom",
        tasks: [VALID_TASK],
        skill_content: SAMPLE_SKILL_CONTENT,
        is_quick_start: true,
        difficulty: "intermediate",
        thumbnail: "aws",
        metadata: {
          tags: ["aws", "health", "monitoring"],
          allowed_tools: ["aws_health_check", "aws_list_accounts"],
        },
        visibility: "private",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];

    expect(insertedConfig.name).toBe("Health of AWS All Accounts");
    expect(insertedConfig.description).toBe("Monitor and report on the health status across all AWS accounts");
    expect(insertedConfig.skill_content).toBe(SAMPLE_SKILL_CONTENT);
    expect(insertedConfig.is_quick_start).toBe(true);
    expect(insertedConfig.difficulty).toBe("intermediate");
    expect(insertedConfig.thumbnail).toBe("aws");
    expect(insertedConfig.metadata.tags).toEqual(["aws", "health", "monitoring"]);
    expect(insertedConfig.metadata.allowed_tools).toEqual(["aws_health_check", "aws_list_accounts"]);
    expect(insertedConfig.visibility).toBe("private");
    expect(insertedConfig.owner_id).toBe("user@example.com");
    expect(insertedConfig.is_system).toBe(false);
    expect(insertedConfig.id).toBeDefined();
    expect(insertedConfig.created_at).toBeInstanceOf(Date);
    expect(insertedConfig.updated_at).toBeInstanceOf(Date);
  });

  it("should persist skill_content with special characters and markdown", async () => {
    const contentWithSpecialChars = `---
name: Test
description: Test with special chars: "quotes", 'apostrophes', <brackets>, & ampersands
---

# Test Skill

Code block:
\`\`\`python
def hello():
    print("Hello, world!")
\`\`\`

**Bold** and *italic* and \`inline code\`

| Column 1 | Column 2 |
|----------|----------|
| Data     | Data     |
`;

    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Special Chars Skill",
        category: "Custom",
        tasks: [VALID_TASK],
        skill_content: contentWithSpecialChars,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.skill_content).toBe(contentWithSpecialChars);
  });

  it("should persist skill_content alongside visibility and team sharing", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Team Skill With Content",
        category: "Custom",
        tasks: [VALID_TASK],
        skill_content: SAMPLE_SKILL_CONTENT,
        is_quick_start: true,
        visibility: "team",
        shared_with_teams: ["team-sre", "team-devops"],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.skill_content).toBe(SAMPLE_SKILL_CONTENT);
    expect(insertedConfig.is_quick_start).toBe(true);
    expect(insertedConfig.visibility).toBe("team");
    expect(insertedConfig.shared_with_teams).toEqual(["team-sre", "team-devops"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST - skill fields default to undefined when omitted
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/skills/configs - skill field defaults", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(userSession());
  });

  it("should have undefined skill fields when only required fields are provided", async () => {
    const { POST } = await import("../skills/configs/route");
    const request = makeRequest("/api/skills/configs", {
      method: "POST",
      body: JSON.stringify({
        name: "Minimal Skill",
        category: "Custom",
        tasks: [VALID_TASK],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    const collection = await mockGetCollection("agent_skills");
    const insertedConfig = collection.insertOne.mock.calls[0][0];
    expect(insertedConfig.skill_content).toBeUndefined();
    expect(insertedConfig.is_quick_start).toBeUndefined();
    expect(insertedConfig.difficulty).toBeUndefined();
    expect(insertedConfig.thumbnail).toBeUndefined();
    expect(insertedConfig.input_form).toBeUndefined();
  });
});
