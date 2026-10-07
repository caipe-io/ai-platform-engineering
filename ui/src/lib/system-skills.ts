import fs from "fs";
import path from "path";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";

export type SystemSkillId = "live-skills" | "update-skills";

export interface SystemSkill {
  _id: SystemSkillId;
  name: string;
  content: string;
  created_at: Date;
}

const SYSTEM_SKILLS: Record<SystemSkillId, string> = {
  "live-skills": "Live Skills",
  "update-skills": "Update Skills",
};

/** System instructions come from release assets, independently of operator skill configuration. */
export function readPackagedSystemSkill(id: SystemSkillId): string {
  const candidates = [
    path.join("/app/data/skills", `${id}.md`),
    path.resolve(process.cwd(), "..", "charts/ai-platform-engineering/data/skills", `${id}.md`),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) {
      throw new Error(`Invalid packaged system skill: ${id}`);
    }
    const content = fs.readFileSync(file, "utf-8");
    if (!content.trim()) throw new Error(`Empty packaged system skill: ${id}`);
    return content;
  }
  throw new Error(`Packaged system skill unavailable: ${id}`);
}

/** Only startup writes system_skills; no user or app-config mutation path targets this collection. */
export async function seedSystemSkills(): Promise<number> {
  if (!isMongoDBConfigured) return 0;
  const documents = (Object.entries(SYSTEM_SKILLS) as Array<[SystemSkillId, string]>)
    .map(([id, name]) => ({ _id: id, name, content: readPackagedSystemSkill(id) }));
  const collection = await getCollection<SystemSkill>("system_skills");
  for (const document of documents) {
    await collection.updateOne(
      { _id: document._id },
      { $set: { name: document.name, content: document.content }, $setOnInsert: { created_at: new Date() } },
      { upsert: true },
    );
  }
  return documents.length;
}

export async function getSystemSkill(id: SystemSkillId): Promise<SystemSkill | null> {
  const collection = await getCollection<SystemSkill>("system_skills");
  return collection.findOne({ _id: id });
}
