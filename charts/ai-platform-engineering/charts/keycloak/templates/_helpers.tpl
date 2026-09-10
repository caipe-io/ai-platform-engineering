{{/*
Expand the name of the chart.
*/}}
{{- define "keycloak.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "keycloak.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "keycloak.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "keycloak.labels" -}}
helm.sh/chart: {{ include "keycloak.chart" . }}
{{ include "keycloak.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "keycloak.selectorLabels" -}}
app.kubernetes.io/name: {{ include "keycloak.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "keycloak.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "keycloak.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Admin secret name — uses secretRef if set, otherwise generates one.
*/}}
{{- define "keycloak.adminSecretName" -}}
{{- if .Values.admin.secretRef }}
{{- .Values.admin.secretRef }}
{{- else }}
{{- include "keycloak.fullname" . }}-admin
{{- end }}
{{- end }}

{{/*
CAIPE UI client-secret K8s Secret name.
- explicit user-provided existing Secret wins
- else if ESO is enabled for uiClient, the chart owns a Secret named
  <fullname>-ui-client
*/}}
{{- define "keycloak.uiClientSecretName" -}}
{{- if .Values.uiClient.secretRef }}
{{- .Values.uiClient.secretRef }}
{{- else }}
{{- include "keycloak.fullname" . }}-ui-client
{{- end }}
{{- end }}

{{/*
CAIPE platform client-secret K8s Secret name.
- explicit user-provided existing Secret wins
- else if ESO is enabled for platformClient, the chart owns a Secret named
  <fullname>-platform-client
The Secret is consumed by init-idp + auth-reconcile as
KEYCLOAK_PLATFORM_CLIENT_SECRET and PUT into Keycloak via the Admin API so
the realm ConfigMap never has to hold the production secret.
*/}}
{{- define "keycloak.platformClientSecretName" -}}
{{- if .Values.platformClient.secretRef }}
{{- .Values.platformClient.secretRef }}
{{- else }}
{{- include "keycloak.fullname" . }}-platform-client
{{- end }}
{{- end }}

{{/*
IdP client-secret K8s Secret name.
- explicit user-provided existing Secret wins
- else if ESO is enabled for IdP, the chart owns a Secret named <fullname>-idp
- else nothing (idp.enabled=false case is gated upstream)
*/}}
{{- define "keycloak.idpSecretName" -}}
{{- if .Values.idp.secretRef }}
{{- .Values.idp.secretRef }}
{{- else }}
{{- include "keycloak.fullname" . }}-idp
{{- end }}
{{- end }}

{{/*
Slack-bot client-secret K8s Secret name.
Same precedence: explicit secretRef > chart-owned <fullname>-bot.
This Secret is consumed by BOTH:
  - keycloak init-token-exchange Job (KC_BOT_CLIENT_SECRET) — to set the
    client_secret in Keycloak via PUT /clients/{id}
  - the slack-bot subchart deployment (SLACK_INTEGRATION_AUTH_CLIENT_SECRET)
    via cross-chart secretKeyRef.
*/}}
{{- define "keycloak.botSecretName" -}}
{{- if .Values.tokenExchange.secretRef }}
{{- .Values.tokenExchange.secretRef }}
{{- else }}
{{- include "keycloak.fullname" . }}-bot
{{- end }}
{{- end }}

{{/*
Keycloak login theme ConfigMap name.
- explicit existingConfigMap wins
- otherwise the chart owns a ConfigMap for the packaged theme
*/}}
{{- define "keycloak.themeConfigMapName" -}}
{{- if .Values.theme.existingConfigMap }}
{{- .Values.theme.existingConfigMap }}
{{- else }}
{{- printf "%s-%s-theme" (include "keycloak.fullname" .) .Values.theme.name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Whether the chart should *create* the IdP Secret (vs. trusting an external
Secret to already exist). True when:
  - idp.enabled  AND
  - admin did NOT set idp.secretRef  AND
  - either idp.externalSecret.enabled (ESO will populate it)
    OR a literal value is supplied via --set (handled in idp-secret.yaml).
*/}}
{{- define "keycloak.shouldCreateIdpSecret" -}}
{{- if and .Values.idp.enabled (not .Values.idp.secretRef) -}}
true
{{- end -}}
{{- end -}}

{{/*
Whether the chart should create the bot client Secret. Mirrors the IdP
logic. When tokenExchange.botClientSecret is empty AND no externalSecret
AND no secretRef, the chart auto-generates a 32-char random password.
*/}}
{{- define "keycloak.shouldCreateBotSecret" -}}
{{- if and .Values.tokenExchange.enabled (not .Values.tokenExchange.secretRef) -}}
true
{{- end -}}
{{- end -}}

{{/*
Webex-bot client-secret K8s Secret name (parallel to keycloak.botSecretName).
*/}}
{{- define "keycloak.webexBotSecretName" -}}
{{- if .Values.webexTokenExchange.secretRef }}
{{- .Values.webexTokenExchange.secretRef }}
{{- else }}
{{- include "keycloak.fullname" . }}-webex-bot
{{- end }}
{{- end }}

{{- define "keycloak.webexTokenExchangeEnabled" -}}
{{- if hasKey .Values.webexTokenExchange "enabled" -}}
{{- .Values.webexTokenExchange.enabled -}}
{{- else -}}
{{- .Values.tokenExchange.enabled -}}
{{- end -}}
{{- end -}}

{{- define "keycloak.shouldCreateWebexBotSecret" -}}
{{- if and (eq (include "keycloak.webexTokenExchangeEnabled" .) "true") (not .Values.webexTokenExchange.secretRef) -}}
true
{{- end -}}
{{- end -}}

{{/*
Scheduler-runner client-secret K8s Secret name (parallel to
keycloak.webexBotSecretName). Consumed by the keycloak init-token-exchange Job
(KC_SCHEDULER_CLIENT_SECRET) and by the caipe-ui BFF deployment
(KEYCLOAK_SCHEDULER_CLIENT_SECRET) via cross-chart secretKeyRef.
*/}}
{{- define "keycloak.schedulerRunnerSecretName" -}}
{{- if .Values.schedulerTokenExchange.secretRef }}
{{- .Values.schedulerTokenExchange.secretRef }}
{{- else }}
{{- $base := include "keycloak.fullname" . | trunc 46 | trimSuffix "-" -}}
{{- printf "%s-scheduler-runner" $base -}}
{{- end }}
{{- end }}

{{- define "keycloak.schedulerTokenExchangeEnabled" -}}
{{- $featureEnabled := dig "scheduler" "enabled" true (.Values.global | default dict) -}}
{{- if hasKey .Values.schedulerTokenExchange "enabled" -}}
{{- and $featureEnabled .Values.schedulerTokenExchange.enabled -}}
{{- else -}}
{{- and $featureEnabled .Values.tokenExchange.enabled -}}
{{- end -}}
{{- end -}}

{{- define "keycloak.shouldCreateSchedulerRunnerSecret" -}}
{{- if and (eq (include "keycloak.schedulerTokenExchangeEnabled" .) "true") (not .Values.schedulerTokenExchange.secretRef) -}}
true
{{- end -}}
{{- end -}}
