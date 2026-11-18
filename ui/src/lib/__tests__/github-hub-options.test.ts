import { githubHubOptions } from "../github-hub-options";
it("accepts immutable GitHub revisions and exact original command entries", () => {
  expect(githubHubOptions({revision: "a".repeat(40), entry_paths: ["plugins/review/commands/review.md"]})).toEqual({revision: "a".repeat(40), entry_paths:["plugins/review/commands/review.md"]});
});
it.each([{revision:"main"}, {revision:"a?ref=other"}, {entry_paths:["../escape.md"]},
  {entry_paths:["/absolute.md"]}, {entry_paths:["file.md"]}, {entry_paths:["commands/code.sh"]}])("rejects mutable refs and unsafe entry paths %p", body => {
  expect(() => githubHubOptions(body)).toThrow();
});
