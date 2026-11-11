/** @jest-environment node */
jest.mock("@/lib/mongodb", () => ({getCollection:jest.fn()}));
jest.mock("@/lib/skill-scan", () => ({scanHubSkillsAsync:jest.fn(async()=>{})}));
import {getCollection} from "@/lib/mongodb";
import {getHubSkills, type SkillHubDoc} from "../hub-crawl";

it("hides old cache generations and reconciles a complete empty refresh", async()=>{
  const hub: SkillHubDoc = {id:"a".repeat(24),type:"github",location:"example/skills",enabled:true,credentials_ref:null,
    cache_generation:"new",last_success_at:null,last_failure_at:null,last_failure_message:null};
  const remove=jest.fn(); const find=jest.fn(()=>({toArray:async()=>[]}));
  const cache={find,deleteMany:remove,updateOne:jest.fn()};
  (getCollection as jest.Mock).mockImplementation(async name=>name==="hub_skills"?cache:{findOne:async()=>hub,updateOne:jest.fn()});
  const previous=global.fetch;
  global.fetch=jest.fn(async()=>({ok:true,json:async()=>({tree:[]})})) as typeof fetch;
  try {
    expect(await getHubSkills(hub)).toEqual([]);
    expect(find.mock.calls[0][0]).toMatchObject({cache_generation:"new"});
    expect(remove).toHaveBeenCalledWith({hub_id:hub.id,skill_id:{$nin:[]}});
    remove.mockClear();
    await expect(getHubSkills({...hub,cache_generation:"old"},true)).rejects.toThrow("settings changed");
    expect(remove).not.toHaveBeenCalled();
  } finally {global.fetch=previous;}
});
