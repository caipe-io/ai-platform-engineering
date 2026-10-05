# Skills gateway instructions

- Gateway instructions live in MongoDB `agent_skills` records `live-skills` and `update-skills`.
- Seed them once through `caipe-ui.appConfig.skills` using the complete packaged markdown bodies in `data/skills/{live-skills,update-skills}.md`.
- Existing installations can preview and apply **Move packaged skill catalog into MongoDB** in the admin migration UI.
- Fresh installations seed only the tool-free Hello World example unless configured otherwise.
- The Python helper and shell hook ship in the UI image. Skill ConfigMaps are not rendered.
- Remove obsolete `skillsLiveSkills`, `skillsLiveSkillsName`, and skill ConfigMap mounts from deployment values.

See [the UI guide](../../../docs/docs/ui/skills-live-skills.md) for template rendering and configuration.
