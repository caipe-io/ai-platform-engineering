import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { compile } from "tailwindcss";

describe("compiled dark utilities", () => {
  let selector: string;

  beforeAll(async () => {
    const globals = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
    const variant = globals.split("\n").find((line) => line.startsWith("@variant dark "));
    expect(variant).toBeDefined();
    const compiler = await compile(`@theme { --color-white: #fff; } ${variant} @tailwind utilities;`);
    const rules: string[] = [];
    postcss.parse(compiler.build(["dark:bg-white"])).walkRules((rule) => {
      if (rule.selector.includes("dark\\:bg-white")) rules.push(rule.selector);
    });
    expect(rules).toHaveLength(1);
    selector = rules[0];
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("class");
    document.body.replaceChildren();
  });

  it.each(["dark", "midnight", "nord", "tokyo", "cyberpunk", "tron", "matrix"])(
    "applies to descendants of the %s theme",
    (theme) => {
      document.documentElement.dataset.theme = theme;
      const probe = document.createElement("div");
      probe.className = "dark:bg-white";
      document.body.append(probe);
      expect(probe.matches(selector)).toBe(true);
    },
  );

  it.each(["light", "legacy-light"])("does not activate for the %s theme", (theme) => {
    document.documentElement.dataset.theme = theme;
    const probe = document.createElement("div");
    probe.className = "dark:bg-white";
    document.body.append(probe);
    expect(probe.matches(selector)).toBe(false);
  });

  it("supports the dark class on an ancestor", () => {
    document.documentElement.className = "dark";
    const probe = document.createElement("div");
    probe.className = "dark:bg-white";
    document.body.append(probe);
    expect(probe.matches(selector)).toBe(true);
  });

  it("still supports a utility on the theme element itself", () => {
    document.documentElement.className = "dark dark:bg-white";
    expect(document.documentElement.matches(selector)).toBe(true);
  });
});
