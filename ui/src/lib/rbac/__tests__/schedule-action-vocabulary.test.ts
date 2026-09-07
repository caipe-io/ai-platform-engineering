import { openFgaCheckRelation, openFgaRelation } from "@/lib/rbac/tuple-builders";

describe("Autonomous entitlement action vocabulary", () => {
  it("maps automate -> can_automate for checks", () => {
    expect(openFgaCheckRelation("automate")).toBe("can_automate");
  });
  it("maps automate -> automation_eligible for writes", () => {
    expect(openFgaRelation("automate")).toBe("automation_eligible");
  });
});
