{{/*
Expand the name of the chart.
*/}}
{{- define "rag-evaluator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "rag-evaluator.fullname" -}}
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
{{- define "rag-evaluator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "rag-evaluator.labels" -}}
helm.sh/chart: {{ include "rag-evaluator.chart" . }}
{{ include "rag-evaluator.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: rag-evaluator
{{- end }}

{{/*
Selector labels
*/}}
{{- define "rag-evaluator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rag-evaluator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "rag-evaluator.serviceAccountName" -}}
    {{- if .Values.serviceAccount.create }}
        {{- default (include "rag-evaluator.fullname" .) .Values.serviceAccount.name }}
    {{- else }}
        {{- default "default" .Values.serviceAccount.name }}
    {{- end }}
{{- end }}

{{/*
Get llmSecrets.secretName with global fallback
*/}}
{{- define "rag-evaluator.llmSecrets.secretName" -}}
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
Get RAG Server URL with UI BFF default and values override support
*/}}
{{- define "rag-evaluator.ragServerUrl" -}}
{{- if .Values.ragServerUrl }}
{{- .Values.ragServerUrl }}
{{- else if and (hasKey .Values "global") (hasKey .Values.global "rag") (hasKey .Values.global.rag "ragServerUrl") }}
{{- .Values.global.rag.ragServerUrl }}
{{- else }}
{{- printf "http://%s-caipe-ui:3000/api/rag" .Release.Name }}
{{- end }}
{{- end }}

{{/*
Get Dynamic Agents URL with UI BFF default and values override support
*/}}
{{- define "rag-evaluator.agentUrl" -}}
{{- if .Values.agentUrl }}
{{- .Values.agentUrl }}
{{- else if and (hasKey .Values "global") (hasKey .Values.global "dynamicAgents") (hasKey .Values.global.dynamicAgents "agentUrl") }}
{{- .Values.global.dynamicAgents.agentUrl }}
{{- else }}
{{- printf "http://%s-caipe-ui:3000" .Release.Name }}
{{- end }}
{{- end }}

{{/*
Get OpenFGA HTTP URL with global fallback
*/}}
{{- define "rag-evaluator.openfgaHttpUrl" -}}
{{- $url := "" -}}
{{- if .Values.openfga.httpUrl }}
    {{- $url = .Values.openfga.httpUrl -}}
{{- else if .Values.openfga.http }}
    {{- $url = .Values.openfga.http -}}
{{- else -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- with .openfga -}}
                {{- $url = (.httpUrl | default "" | trim) -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
{{- end -}}
{{- if $url -}}
    {{- $url -}}
{{- else -}}
    {{- printf "http://%s-openfga:8080" .Release.Name -}}
{{- end -}}
{{- end -}}

{{/*
Get OpenFGA Store Name with global fallback
*/}}
{{- define "rag-evaluator.openfgaStoreName" -}}
{{- if .Values.openfga.storeName }}
    {{- .Values.openfga.storeName }}
{{- else if and (hasKey .Values "global") (hasKey .Values.global "openfga") (hasKey .Values.global.openfga "storeName") }}
    {{- .Values.global.openfga.storeName }}
{{- else }}
    {{- "caipe-openfga" }}
{{- end }}
{{- end }}

{{/*
Get CAIPE Org Key with global fallback
*/}}
{{- define "rag-evaluator.orgKey" -}}
{{- if .Values.openfga.orgKey }}
    {{- .Values.openfga.orgKey }}
{{- else if and (hasKey .Values "global") (hasKey .Values.global "openfga") (hasKey .Values.global.openfga "orgKey") }}
    {{- .Values.global.openfga.orgKey }}
{{- else }}
    {{- "caipe" }}
{{- end }}
{{- end }}

{{/*
Get app version
*/}}
{{- define "rag-evaluator.appVersion" -}}
{{- $tag := "" -}}
{{- with .Values.global -}}
  {{- with .image -}}
    {{- $tag = .tag -}}
  {{- end -}}
{{- end -}}
{{- $tag | default .Chart.AppVersion -}}
{{- end -}}
