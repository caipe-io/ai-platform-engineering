#!/bin/bash

# Usage:
#   ./deploy.sh              - Deploy based on .env settings (detached mode)
#   ./deploy.sh --no-detach  - Deploy in foreground mode
#   ./deploy.sh stop         - Stop all services

if [ "$1" = "stop" ]; then
    echo "Stopping all services..."
    ALL_PROFILES=$(grep -A1 "profiles:" docker-compose.yaml | grep -v "profiles:" | grep -v "^--$" | tr -d ' -' | sort -u | tr '\n' ',' | sed 's/,$//')
    if [ -n "$ALL_PROFILES" ]; then
        PROFILE_FLAGS=$(echo "$ALL_PROFILES" | sed 's/,/ --profile /g' | sed 's/^/--profile /')
        docker compose $PROFILE_FLAGS down --remove-orphans -v
    else
        docker compose down --remove-orphans -v
    fi
    # Cleanup any remaining containers from this project
    REMAINING=$(docker ps -aq --filter "label=com.docker.compose.project=ai-platform-engineering")
    [ -n "$REMAINING" ] && docker rm -f $REMAINING
    exit 0
fi

if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Each ENABLE_<AGENT> selects that agent's MCP server profile. The CAIPE UI
# (BFF) + dynamic agents are the runtime; MCP servers are reached via
# agentgateway / direct connections.
PROFILES=""
[ "$ENABLE_AWS" = "true" ] && PROFILES="$PROFILES,aws"
[ "$ENABLE_GITHUB" = "true" ] && PROFILES="$PROFILES,github"
[ "$ENABLE_BACKSTAGE" = "true" ] && PROFILES="$PROFILES,backstage"
[ "$ENABLE_ARGOCD" = "true" ] && PROFILES="$PROFILES,argocd"
[ "$ENABLE_CONFLUENCE" = "true" ] && PROFILES="$PROFILES,confluence"
[ "$ENABLE_JIRA" = "true" ] && PROFILES="$PROFILES,jira"
[ "$ENABLE_KOMODOR" = "true" ] && PROFILES="$PROFILES,komodor"
[ "$ENABLE_PAGERDUTY" = "true" ] && PROFILES="$PROFILES,pagerduty"
[ "$ENABLE_SLACK" = "true" ] && PROFILES="$PROFILES,slack"
[ "$ENABLE_SPLUNK" = "true" ] && PROFILES="$PROFILES,splunk"
[ "$ENABLE_WEBEX" = "true" ] && PROFILES="$PROFILES,webex"
[ "$ENABLE_CAIPE_UI" = "true" ] && PROFILES="$PROFILES,caipe-ui,dynamic-agents"
[ "$ENABLE_RAG" = "true" ] && PROFILES="$PROFILES,rag"
[ "$ENABLE_GRAPH_RAG" = "true" ] && PROFILES="$PROFILES,rag"
[ "$ENABLE_TRACING" = "true" ] && PROFILES="$PROFILES,tracing"
[ "$ENABLE_DIRECTORY" = "true" ] && PROFILES="$PROFILES,directory"

PROFILES=$(echo "$PROFILES" | sed 's/^,//')

echo "Starting services with profiles: ${PROFILES:-<none>}"
if [ "$1" = "--no-detach" ] || [ "$1" = "-f" ]; then
    COMPOSE_PROFILES="$PROFILES" docker compose up
else
    COMPOSE_PROFILES="$PROFILES" docker compose up -d
fi
