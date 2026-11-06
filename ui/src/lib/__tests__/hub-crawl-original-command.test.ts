jest.mock("@/lib/mongodb", () => ({getCollection:jest.fn(), isMongoDBConfigured:false}));
jest.mock("@/lib/api-middleware", () => ({validateCredentialsRef:jest.fn()}));
import { crawlGitHubRepo } from "../hub-crawl";
it("fetches an original command and all supporting files at the same immutable ref without rewriting", async () => {
  const revision = "a".repeat(40);
  const original = "---\ndescription: Original command\nallowed-tools: Read\n---\nOriginal Unicode 🟠 instructions.\n";
  const reference = "Original supporting reference.\n";
  const previous = global.fetch;
  const calls: string[] = [];
  global.fetch = jest.fn(async input => {
    const url = String(input); calls.push(url);
    const files: Record<string,string> = {"plugins/review/commands/review.md":original,"plugins/review/commands/references/check.md":reference};
    if (url.includes("/git/trees/")) return {ok:true,json:async()=>({tree:Object.keys(files).map(path=>({type:"blob",path,size:Buffer.byteLength(files[path])}))})} as Response;
    const path = new URL(url).pathname.split("/contents/")[1];
    return {ok:true,json:async()=>({content:Buffer.from(files[path]).toString("base64"),encoding:"base64"})} as Response;
  }) as typeof fetch;
  try {
    const result = await crawlGitHubRepo("example","skills",undefined,undefined,undefined,{revision,entry_paths:["plugins/review/commands/review.md"]});
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].content).toBe(original);
    expect(result.skills[0].ancillary_files).toEqual({"references/check.md":reference});
    expect(result.skills[0].name).toBe("review");
    expect(calls[0]).toContain(`/git/trees/${revision}?recursive=1`);
    expect(calls.slice(1).every(url=>new URL(url).searchParams.get("ref")===revision)).toBe(true);
  } finally { global.fetch = previous; }
});

it("gives equally named original entries stable distinct path identities and rejects missing assets", async () => {
  const previous = global.fetch;
  const files: Record<string,string> = {"a/SKILL.md":"---\nname: review\n---\nA", "b/SKILL.md":"---\nname: review\n---\nB"};
  global.fetch = jest.fn(async input => {
    const url = String(input);
    if (url.includes("/git/trees/")) return {ok:true,json:async()=>({tree:Object.keys(files).map(path=>({type:"blob",path,size:files[path].length}))})} as Response;
    const path = new URL(url).pathname.split("/contents/")[1];
    return {ok:true,json:async()=>({content:Buffer.from(files[path]).toString("base64"),encoding:"base64"})} as Response;
  }) as typeof fetch;
  try {
    const options = {revision:"a".repeat(40)};
    const first = await crawlGitHubRepo("example","skills",undefined,undefined,undefined,options);
    const second = await crawlGitHubRepo("example","skills",undefined,undefined,undefined,options);
    expect(new Set(first.skills.map(s=>s.id)).size).toBe(2);
    expect(first.skills.map(s=>s.id)).toEqual(second.skills.map(s=>s.id));
    files["a/required.bin"] = "Binary";
    await expect(crawlGitHubRepo("example","skills",undefined,undefined,undefined,options)).rejects.toThrow("incomplete");
  } finally { global.fetch = previous; }
});
