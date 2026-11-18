import { render, screen } from "@testing-library/react";
import fs from "fs";
import path from "path";

import { BrandLogo, isGridLogo, shouldTheme } from "../BrandLogo";

const THEMED = { src: "/grid-neon-logo.svg", themed: true } as const;

describe("BrandLogo", () => {
  it("draws the grid as inline SVG with accent-token gradient stops", () => {
    const { container } = render(<BrandLogo size={48} {...THEMED} />);
    const svg = screen.getByTestId("brand-logo");

    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(container.querySelectorAll("rect")).toHaveLength(11);
    expect(container.querySelectorAll("circle")).toHaveLength(8);

    const stops = Array.from(container.querySelectorAll("stop")).map((s) => s.getAttribute("style"));
    expect(stops.join(" ")).toContain("var(--brand-a)");
    expect(stops.join(" ")).toContain("var(--brand-b)");
    expect(stops.join(" ")).toContain("var(--brand-c)");
    expect(svg).toHaveClass("brand-logo", "brand-logo-glow");
  });

  it("gives each instance its own gradient ids", () => {
    const { container } = render(
      <>
        <BrandLogo size={36} {...THEMED} />
        <BrandLogo size={48} {...THEMED} />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("linearGradient")).map((g) => g.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => !id.includes(":"))).toBe(true);
  });

  it("is hidden from assistive tech without alt and named with alt", () => {
    const { rerender } = render(<BrandLogo size={48} {...THEMED} />);
    expect(screen.getByTestId("brand-logo")).toHaveAttribute("aria-hidden", "true");

    rerender(<BrandLogo alt="Grid" size={48} {...THEMED} />);
    expect(screen.getByRole("img", { name: "Grid" })).toBeInTheDocument();
  });

  it.each([
    ["on-accent variant", { variant: "on-accent" as const }],
    ["white logo style", { logoStyle: "white" as const }],
  ])("draws solid white with %s", (_label, props) => {
    const { container } = render(<BrandLogo size={48} {...THEMED} {...props} />);

    expect(container.querySelector("linearGradient")).toBeNull();
    expect(screen.getByTestId("brand-logo")).not.toHaveClass("brand-logo-glow");
    expect(container.querySelector("rect")).toHaveAttribute("stroke", "#fff");
  });

  it.each(["/grid-neon-logo.svg"])(
    "treats %p as the grid logo",
    (src) => {
      expect(isGridLogo(src)).toBe(true);
      render(<BrandLogo size={48} src={src} {...THEMED} />);
      expect(screen.getByTestId("brand-logo")).toBeInTheDocument();
    },
  );

  it("shows a configured custom logo as an image and keeps the white filter", () => {
    render(<BrandLogo alt="Acme" logoStyle="white" size={48} {...THEMED} src="https://cdn.example.com/acme.svg" />);
    const img = screen.getByRole("img", { name: "Acme" });

    expect(img.tagName.toLowerCase()).toBe("img");
    expect(img).toHaveAttribute("src", expect.stringContaining("acme.svg"));
    expect(img).toHaveClass("brightness-0", "invert");
    expect(screen.queryByTestId("brand-logo")).toBeNull();
  });
});

describe("BrandLogo with LOGO_THEMED off", () => {
  it.each(["/logo.svg", "/grid-neon-logo.svg"])(
    "renders %p as the configured image, not the inline mark",
    (src) => {
      render(<BrandLogo alt="App" className="h-12 w-auto" size={48} src={src} themed={false} />);
      const img = screen.getByRole("img", { name: "App" });

      expect(img.tagName.toLowerCase()).toBe("img");
      expect(img).toHaveAttribute("src", expect.stringContaining(src.slice(1)));
      expect(img).toHaveClass("h-12", "w-auto");
      expect(screen.queryByTestId("brand-logo")).toBeNull();
    },
  );

  it("keeps the white filter on the image", () => {
    render(<BrandLogo alt="App" logoStyle="white" size={48} src="/logo.svg" themed={false} />);

    expect(screen.getByRole("img", { name: "App" })).toHaveClass("brightness-0", "invert");
  });

  it("keeps the default CAIPE logo as an image when the caller does not pass themed", () => {
    render(<BrandLogo alt="App" size={48} src="/logo.svg" />);

    expect(screen.queryByTestId("brand-logo")).toBeNull();
  });
});

describe("BrandLogo with LOGO_THEMED unset (auto)", () => {
  it.each(["/grid-neon-logo.svg"])("themes the grid logo %p", (src) => {
    render(<BrandLogo size={48} src={src} themed={null} />);

    expect(screen.getByTestId("brand-logo")).toBeInTheDocument();
  });

  it.each(["", "/logo.svg", "https://cdn.example.com/acme.svg"])("leaves %p unchanged", (src) => {
    render(<BrandLogo alt="App" size={48} src={src || "/logo.svg"} themed={null} />);

    expect(screen.queryByTestId("brand-logo")).toBeNull();
  });

  it("never redraws the default CAIPE logo or a custom logo, even with LOGO_THEMED=true", () => {
    for (const themed of [null, false, true]) {
      expect(shouldTheme("/logo.svg", themed)).toBe(false);
      expect(shouldTheme("", themed)).toBe(false);
      expect(shouldTheme("https://cdn.example.com/acme.svg", themed)).toBe(false);
    }
    expect(shouldTheme("/grid-neon-logo.svg", null)).toBe(true);
    expect(shouldTheme("/grid-neon-logo.svg", true)).toBe(true);
    expect(shouldTheme("/grid-neon-logo.svg", false)).toBe(false);
  });
});

describe("brand logo theme tokens", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../../app/globals.css"), "utf8");

  it("derives the brand colors from the accent gradient", () => {
    expect(css).toMatch(/\.brand-logo\s*\{[^}]*--brand-a: color-mix\(in srgb, var\(--gradient-from\) 82%, white\)/);
    expect(css).toMatch(/\.brand-logo\s*\{[^}]*--brand-c: color-mix\(in srgb, var\(--gradient-to\) 82%, white\)/);
  });

  it("deepens the colors and drops the glow in both light themes", () => {
    expect(css).toMatch(
      /:root:is\(\[data-theme="light"\], \[data-theme="legacy-light"\]\) \.brand-logo\s*\{[^}]*var\(--gradient-from\) 80%, black/,
    );
    expect(css).toMatch(
      /:root:is\(\[data-theme="light"\], \[data-theme="legacy-light"\]\) \.brand-logo-glow\s*\{\s*filter: none/,
    );
  });
});
