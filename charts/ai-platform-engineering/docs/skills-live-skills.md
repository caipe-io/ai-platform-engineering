# Skills gateway instructions

- Gateway instructions live in MongoDB `agent_skills` records `live-skills` and `update-skills`.
- Manage them through `caipe-ui.appConfig.skills` using the complete packaged markdown bodies in `data/skills/{live-skills,update-skills}.md`. Startup applies YAML additions, updates, and removals; configured skills are read-only in the UI.
- Explicit packaged-template imports create ordinary database records that can be edited or deleted through the UI.
- Existing installations can preview and apply **Move packaged skill catalog into MongoDB** in the admin migration UI.
- Fresh installations seed only the tool-free Hello World example unless configured otherwise.
- The Python helper and shell hook ship in the UI image. Skill ConfigMaps are not rendered.
- Remove obsolete `skillsLiveSkills`, `skillsLiveSkillsName`, and skill ConfigMap mounts from deployment values.

See [the UI guide](../../../docs/docs/ui/skills-live-skills.md) for template rendering and configuration.
