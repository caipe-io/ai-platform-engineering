import { isPrivateResourcesEnabled } from "../private-resources";

describe("isPrivateResourcesEnabled", () => {
  const original = process.env.PRIVATE_RESOURCES_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.PRIVATE_RESOURCES_ENABLED;
    else process.env.PRIVATE_RESOURCES_ENABLED = original;
  });

  it("defaults to disabled", () => {
    delete process.env.PRIVATE_RESOURCES_ENABLED;
    expect(isPrivateResourcesEnabled()).toBe(false);
  });

  it.each(["true", "TRUE", "1", "yes", "on"])("accepts %s as enabled", (value) => {
    process.env.PRIVATE_RESOURCES_ENABLED = value;
    expect(isPrivateResourcesEnabled()).toBe(true);
  });

  it.each(["false", "0", "off", "unexpected"])("treats %s as disabled", (value) => {
    process.env.PRIVATE_RESOURCES_ENABLED = value;
    expect(isPrivateResourcesEnabled()).toBe(false);
  });
});
