import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("final markdown list styles", () => {
  beforeEach(() => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(process.cwd(), "src/components/shared/timeline/streaming-markdown.css"), "utf8");
    document.head.append(style);
    document.body.innerHTML = `<article class="streaming-markdown md-final">
      <ul id="first"><li><p id="paragraph">Example</p>
        <ul id="second"><li>Nested<ul id="third"><li>Deep</li></ul></li></ul>
        <ol id="ordered"><li>Ordered</li></ol>
        <p id="last">Last paragraph</p>
      </li><li><input id="task" type="checkbox" disabled>Task</li></ul>
    </article>`;
  });

  afterEach(() => {
    document.head.querySelectorAll("style").forEach((style) => style.remove());
    document.body.replaceChildren();
  });

  const styles = (id: string): CSSStyleDeclaration => getComputedStyle(document.getElementById(id)!);

  it("preserves distinct unordered list markers across nesting levels", () => {
    expect(styles("first").listStyleType).toBe("disc");
    expect(styles("second").listStyleType).toBe("circle");
    expect(styles("third").listStyleType).toBe("square");
  });

  it("keeps mixed ordered lists numbered and compact", () => {
    expect(styles("ordered").listStyleType).toBe("decimal");
    expect(styles("ordered").marginTop).toBe("0.25rem");
    expect(styles("ordered").marginBottom).toBe("0.25rem");
  });

  it("keeps paragraph spacing inside list items compact", () => {
    expect(styles("paragraph").marginBottom).toBe("0.25rem");
    expect(styles("last").marginBottom).toBe("0px");
  });

  it("aligns task checkboxes with their labels", () => {
    expect(styles("task").marginRight).toBe("0.4rem");
    expect(styles("task").verticalAlign).toBe("middle");
  });

  it("does not apply finalized-list spacing to streaming fragments", () => {
    document.querySelector("article")!.classList.remove("md-final");
    expect(styles("ordered").marginTop).not.toBe("0.25rem");
    expect(styles("task").verticalAlign).not.toBe("middle");
  });
});
