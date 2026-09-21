{{/*
Expand the name of the chart.
*/}}
{{- define "skill-scanner.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "skill-scanner.fullname" -}}
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
{{- define "skill-scanner.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "skill-scanner.labels" -}}
helm.sh/chart: {{ include "skill-scanner.chart" . }}
{{ include "skill-scanner.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: skill-scanner
{{- end }}

{{/*
Selector labels
*/}}
{{- define "skill-scanner.selectorLabels" -}}
app.kubernetes.io/name: {{ include "skill-scanner.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "skill-scanner.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "skill-scanner.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolve image tag — fall back to parent chart's global tag, then this
subchart's appVersion, so a single global override flows everywhere.
*/}}
{{- define "skill-scanner.appVersion" -}}
{{- if .Values.image.tag -}}
{{- .Values.image.tag -}}
{{- else if and .Values.global .Values.global.image .Values.global.image.tag -}}
{{- .Values.global.image.tag -}}
{{- else -}}
{{- .Chart.AppVersion -}}
{{- end -}}
{{- end -}}

