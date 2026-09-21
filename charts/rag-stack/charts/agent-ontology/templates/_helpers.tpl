{{/*
Expand the name of the chart.
*/}}
{{- define "agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "agent.fullname" -}}
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
{{- define "agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agent.labels" -}}
helm.sh/chart: {{ include "agent.chart" . }}
{{ include "agent.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: agent-ontology
{{- end }}

{{/*
Selector labels
*/}}
{{- define "agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agent.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Determine if ingress is enabled - global takes precedence
*/}}
{{- define "agent.ingress.enabled" -}}
{{- if hasKey .Values.global "ingress" }}
{{- if hasKey .Values.global.ingress "enabled" }}
{{- .Values.global.ingress.enabled }}
{{- else }}
{{- .Values.ingress.enabled | default false }}
{{- end }}
{{- else }}
{{- .Values.ingress.enabled | default false }}
{{- end }}
{{- end }}

{{/*
Determine if external secrets are enabled for llmSecrets - prioritize global
*/}}
{{- define "agent.llmSecrets.externalSecrets.enabled" -}}
    {{- $enabled := (default false .Values.llmSecrets.externalSecrets.enabled) -}}
    {{- with .Values.global -}}
        {{- with .externalSecrets -}}
            {{- if and (hasKey . "enabled") .enabled -}}
                {{- $enabled = true -}}
            {{- end -}}
        {{- end -}}
        {{- with .llmSecrets -}}
            {{- with .externalSecrets -}}
                {{- if hasKey . "enabled" -}}
                    {{- $enabled = .enabled -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $enabled -}}
{{- end }}

{{/*
Get llmSecrets.secretName with global fallback
*/}}
{{- define "agent.llmSecrets.secretName" -}}
    {{- $name := .Values.llmSecrets.secretName -}}
    {{- with .Values.global -}}
        {{- with .llmSecrets -}}
            {{- if hasKey . "secretName" -}}
                {{- $name = .secretName -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $name -}}
{{- end -}}

{{/*
Compute Milvus URI with values override, fallback to http://<release name>-milvus:19530
*/}}
{{- define "agent.milvusUri" -}}
    {{- $val := (default "" .Values.milvusUri) | trim -}}
    {{- if $val -}}
        {{- $val -}}
    {{- else -}}
        {{- printf "http://%s-milvus:19530" .Release.Name -}}
    {{- end -}}
{{- end -}}

{{/*
Get llmSecrets.create with global fallback
*/}}
{{- define "agent.llmSecrets.create" -}}
    {{- $create := .Values.llmSecrets.create -}}
    {{- with .Values.global -}}
        {{- with .llmSecrets -}}
            {{- if hasKey . "create" -}}
                {{- $create = .create -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $create -}}
{{- end -}}

{{/*
Get llmSecrets.externalSecrets.secretStoreRef with global fallback
*/}}
{{- define "agent.llmSecrets.externalSecrets.secretStoreRef" -}}
    {{- $ref := .Values.llmSecrets.externalSecrets.secretStoreRef -}}
    {{- with .Values.global -}}
        {{- with .externalSecrets -}}
            {{- if hasKey . "secretStoreRef" -}}
                {{- $ref = .secretStoreRef -}}
            {{- end -}}
        {{- end -}}
        {{- with .llmSecrets -}}
            {{- with .externalSecrets -}}
                {{- if hasKey . "secretStoreRef" -}}
                    {{- $ref = .secretStoreRef -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $ref -}}
{{- end -}}

{{/*
Get Redis URL combining host and port
*/}}
{{- define "agent.redisUrl" -}}
    {{- $host := "redis" -}}
    {{- $port := "6379" -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- with .redis -}}
                {{- if hasKey . "host" -}}
                    {{- $host = .host -}}
                {{- end -}}
                {{- if hasKey . "port" -}}
                    {{- $port = .port -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- printf "redis://%s:%s/0" $host ($port | toString) -}}
{{- end -}}

{{/*
Get Neo4j address combining host and port
*/}}
{{- define "agent.neo4jAddr" -}}
    {{- $host := "neo4j" -}}
    {{- $port := "7687" -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- with .neo4j -}}
                {{- if hasKey . "host" -}}
                    {{- $host = .host -}}
                {{- end -}}
                {{- if hasKey . "port" -}}
                    {{- $port = .port -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- printf "neo4j://%s:%s" $host ($port | toString) -}}
{{- end -}}

{{/*
Get Neo4j username
*/}}
{{- define "agent.neo4jUsername" -}}
    {{- $username := "neo4j" -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- with .neo4j -}}
                {{- if hasKey . "username" -}}
                    {{- $username = .username -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $username -}}
{{- end -}}

{{/*
Get Neo4j password
*/}}
{{- define "agent.neo4jPassword" -}}
    {{- $password := "dummy_password" -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- with .neo4j -}}
                {{- if hasKey . "password" -}}
                    {{- $password = .password -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $password -}}
{{- end -}}

{{- define "agent.appVersion" -}}
{{- .Values.global.image.tag | default .Chart.AppVersion -}}
{{- end -}}

