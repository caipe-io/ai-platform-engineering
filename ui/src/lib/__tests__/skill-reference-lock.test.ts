/** @jest-environment node */
jest.mock("@/lib/mongodb", () => ({getCollection:jest.fn()}));
import {getCollection} from "@/lib/mongodb";
import {assertSavedSkillsExist, withSkillReferenceLock} from "../skill-reference-lock";

it("serializes attachment with retirement and releases the fence after failed validation", async () => {
  let held = false;
  const locks = {insertOne: jest.fn(async () => {if (held) throw {code:11000}; held=true;}),
    deleteOne:jest.fn(async () => {held=false;})};
  let exists = true;
  (getCollection as jest.Mock).mockImplementation(async name => name === "agent_mutation_locks" ? locks : {findOne:async()=>exists?{id:"skill-example"}:null});
  let release!: () => void;
  const first = withSkillReferenceLock(["skill-example"], async()=>{await assertSavedSkillsExist(["skill-example"]);await new Promise<void>(done=>{release=done;});});
  while (!release) await Promise.resolve();
  const retire=jest.fn();
  await expect(withSkillReferenceLock(["skill-example"], retire)).rejects.toThrow("Another agent save is in progress");
  expect(retire).not.toHaveBeenCalled();
  release(); await first;
  exists=false;
  await expect(withSkillReferenceLock(["skill-example"], ()=>assertSavedSkillsExist(["skill-example"]))).rejects.toThrow("Skill is unavailable");
  expect(held).toBe(false);
});

it("rejects a Hub cache from an obsolete generation before attaching it", async()=>{
  (getCollection as jest.Mock).mockImplementation(async name=>({findOne:async()=>name==="skill_hubs"?{enabled:true,cache_generation:"new"}:{cache_generation:"old"}}));
  await expect(assertSavedSkillsExist([`hub-${"a".repeat(24)}-review`])).rejects.toThrow("configuration changed");
});
