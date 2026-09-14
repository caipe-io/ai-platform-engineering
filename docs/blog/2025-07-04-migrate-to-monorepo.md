---
slug: migrate-to-monorepo
title: Migrating Agent Repos to the Monorepo
authors: [sriaradhyula]
tags: [articles]
---

Instructions to migrate agent repos to mono repo

<!-- truncate -->

```bash
export AGENT_NAME=foo
```

1. Clone the Target Monorepo (ai-platform-engineering)

```
cd /tmp
git clone git@github.com:caipe-io/ai-platform-engineering.git
```

2. Clone agent-\$AGENT\_NAME to a temp location:

```
cd /tmp
git clone git@github.com:cnoe-io/agent-$AGENT_NAME.git agent-$AGENT_NAME-temp
cd agent-$AGENT_NAME-temp
```

3. Rewrite history to move everything into ai\_platform\_engineering/agents/\$AGENT\_NAME:

```
git filter-repo --to-subdirectory-filter ai_platform_engineering/agents/$AGENT_NAME
```

4. Now add this rewritten repo as a remote to your monorepo:

```
cd ../ai-platform-engineering    # Go back to your main repo
git remote add $AGENT_NAME-temp ../agent-$AGENT_NAME-temp
git fetch $AGENT_NAME-temp
```

5. Create a branch

```
git checkout -b migrate_agent_$AGENT_NAME
```

6. Merge the imported history (use --allow-unrelated-histories the first time):

```
git merge $AGENT_NAME-temp/main --allow-unrelated-histories
```

7. Clean Up (Optional)

```
git remote remove $AGENT_NAME-temp
read -p "Delete ../agent-$AGENT_NAME-temp and all contents? [y/N] " ans && [[ $ans =~ ^[Yy]$ ]] && rm -rf ../agent-$AGENT_NAME-temp
```

8. Upload branch and PR

```
git push origin migrate_agent_$AGENT_NAME
```
<!-- truncate -->
