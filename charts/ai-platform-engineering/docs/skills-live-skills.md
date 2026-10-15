# Skills gateway instructions

- Gateway instructions live in the separate MongoDB `system_skills` collection as `live-skills` and `update-skills`.
- Startup creates or updates both system records from `data/skills/{live-skills,update-skills}.md` on new and existing installations. Repository changes shipped in a release control their content.
- UI skill APIs, app-config, and template imports cannot modify these system records. Ordinary skills with matching IDs cannot override them.
- Use `caipe-ui.appConfig.skills` for ordinary catalog skills in `agent_skills`. Startup applies YAML additions, updates, and removals; configured skills are read-only in the UI.
- Existing installations can use **Move packaged skill catalog into MongoDB** in the admin migration UI for ordinary catalog templates. System instructions initialize separately on startup.
- Fresh installations seed only the tool-free Hello World ordinary skill unless configured otherwise.
- System templates, the Python helper, and the shell hook ship in the UI image. Skill ConfigMaps are not rendered.
- Remove obsolete `skillsLiveSkills`, `skillsLiveSkillsName`, and skill ConfigMap mounts from deployment values.

See [the UI guide](../../../docs/docs/ui/skills-live-skills.md) for template rendering and configuration.
