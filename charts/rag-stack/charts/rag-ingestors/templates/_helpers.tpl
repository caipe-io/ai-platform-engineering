{{/*
Expand the name of the chart.
*/}}
{{- define "rag-ingestors.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "rag-ingestors.fullname" -}}
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
{{- define "rag-ingestors.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "rag-ingestors.labels" -}}
helm.sh/chart: {{ include "rag-ingestors.chart" . }}
{{ include "rag-ingestors.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels for a specific ingestor
*/}}
{{- define "rag-ingestors.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rag-ingestors.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "rag-ingestors.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "rag-ingestors.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Get RAG Server URL with per-ingestor override support
*/}}
{{- define "rag-ingestors.ragServerUrl" -}}
{{- $ingestor := index . 0 -}}
{{- $root := index . 1 -}}
{{- if $ingestor.ragServerUrl }}
{{- $ingestor.ragServerUrl }}
{{- else if $root.Values.ragServerUrl }}
{{- $root.Values.ragServerUrl }}
{{- else }}
{{- printf "http://rag-server:9446" }}
{{- end }}
{{- end }}

{{/* Shared RAG MongoDB persistence settings. */}}

{{- define "rag-ingestors.mongodbEnv" -}}
{{- $global := .Values.global | default dict -}}
{{- $rag := $global.rag | default dict -}}
{{- $mongo := $rag.mongodb | default dict -}}
- name: RAG_WRITES_PAUSED
  value: {{ $rag.writesPaused | default false | quote }}
- name: MONGODB_URI
  valueFrom:
    secretKeyRef:
      name: {{ tpl (required "global.rag.mongodb.existingSecret must identify the application MongoDB URI Secret" $mongo.existingSecret) . | quote }}
      key: {{ $mongo.uriKey | default "MONGODB_URI" | quote }}
- name: MONGODB_DATABASE
  value: {{ $mongo.database | default "caipe" | quote }}
{{- if $mongo.caConfigMap }}
- name: MONGODB_TLS_CA_FILE
  value: /etc/rag-mongodb-ca/ca.pem
{{- end }}
{{- end -}}

{{- define "rag-ingestors.mongodbMount" -}}
{{- $mongo := ((.Values.global | default dict).rag | default dict).mongodb | default dict -}}
{{- if $mongo.caConfigMap }}
- name: rag-mongodb-ca
  mountPath: /etc/rag-mongodb-ca
  readOnly: true
{{- end }}
{{- end -}}

{{- define "rag-ingestors.mongodbVolume" -}}
{{- $mongo := ((.Values.global | default dict).rag | default dict).mongodb | default dict -}}
{{- if $mongo.caConfigMap }}
- name: rag-mongodb-ca
  configMap:
    name: {{ tpl $mongo.caConfigMap . | quote }}
    items:
      - key: {{ $mongo.caKey | default "global-bundle.pem" | quote }}
        path: ca.pem
{{- end }}
{{- end -}}

{{- define "rag-ingestors.appVersion" -}}
{{- .Values.global.image.tag | default .Chart.AppVersion -}}
{{- end -}}
