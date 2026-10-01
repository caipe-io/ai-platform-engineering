{{/*
Expand the name of the chart.
*/}}
{{- define "dynamic-agents.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "dynamic-agents.fullname" -}}
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
{{- define "dynamic-agents.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "dynamic-agents.labels" -}}
helm.sh/chart: {{ include "dynamic-agents.chart" . }}
{{ include "dynamic-agents.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "dynamic-agents.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dynamic-agents.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "dynamic-agents.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "dynamic-agents.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Determine if ingress is enabled - global takes precedence
*/}}
{{- define "dynamic-agents.ingress.enabled" -}}
    {{- $global := (default dict .Values.global) -}}
    {{- if hasKey $global "ingress" -}}
        {{- $globalIngress := (default dict $global.ingress) -}}
        {{- if hasKey $globalIngress "enabled" -}}
            {{- $globalIngress.enabled -}}
        {{- else -}}
            {{- .Values.ingress.enabled | default false -}}
        {{- end -}}
    {{- else -}}
        {{- .Values.ingress.enabled | default false -}}
    {{- end -}}
{{- end }}

{{- define "dynamic-agents.appVersion" -}}
{{- .Values.global.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{/*
Effective metrics port. 0 (default) means metrics are served on the main
service port, so this resolves to service.port in that case.
*/}}
{{- define "dynamic-agents.metricsPort" -}}
{{- if and .Values.service.metricsPort (ne (int .Values.service.metricsPort) 0) -}}
{{- .Values.service.metricsPort -}}
{{- else -}}
{{- .Values.service.port -}}
{{- end -}}
{{- end -}}

{{/*
True when metrics run on a port different from the main service port.
*/}}
{{- define "dynamic-agents.metricsPortSeparate" -}}
{{- and .Values.service.metricsPort (ne (int .Values.service.metricsPort) (int .Values.service.port)) -}}
{{- end -}}

{{/*
Resolve the multimodal attachment blob store config and emit it as ConfigMap
data lines. An explicit ATTACHMENT_* value in .Values.config always wins; when
absent, bucket/region/endpoint fall back to the shared global.storage.s3 block
so a CAIPE sysadmin can set the bucket once for the whole platform.

ATTACHMENT_BACKEND defaults to "auto": it resolves to "s3" when a bucket is
available (config or global) and "local" otherwise. "local"/"s3" are honored
explicitly. The app rejects "auto", so this only ever emits "local" or "s3".
Emitted after the plain config range in configmap.yaml (include ... | nindent 2).
*/}}
{{- define "dynamic-agents.attachmentConfig" -}}
{{- $config := .Values.config | default dict -}}
{{- $globalS3 := dict -}}
{{- if and .Values.global .Values.global.storage .Values.global.storage.s3 -}}
{{- $globalS3 = .Values.global.storage.s3 -}}
{{- end -}}
{{- $bucket := trim ((get $config "ATTACHMENT_S3_BUCKET") | default "" | toString) -}}
{{- if not $bucket -}}{{- $bucket = trim ((get $globalS3 "bucket") | default "" | toString) -}}{{- end -}}
{{- $region := trim ((get $config "ATTACHMENT_S3_REGION") | default "" | toString) -}}
{{- if not $region -}}{{- $region = trim ((get $globalS3 "region") | default "" | toString) -}}{{- end -}}
{{- if not $region -}}{{- $region = "us-west-2" -}}{{- end -}}
{{- $endpoint := trim ((get $config "ATTACHMENT_S3_ENDPOINT_URL") | default "" | toString) -}}
{{- if not $endpoint -}}{{- $endpoint = trim ((get $globalS3 "endpointUrl") | default "" | toString) -}}{{- end -}}
{{- $prefix := trim ((get $config "ATTACHMENT_S3_PREFIX") | default "" | toString) -}}
{{- if not $prefix -}}{{- $prefix = "attachments" -}}{{- end -}}
{{- $requestedBackend := lower ((get $config "ATTACHMENT_BACKEND") | default "auto" | toString) -}}
{{- if not (has $requestedBackend (list "auto" "local" "s3")) -}}
{{- fail "dynamic-agents config.ATTACHMENT_BACKEND must be one of: auto, local, s3" -}}
{{- end -}}
{{- $backend := "local" -}}
{{- if eq $requestedBackend "s3" -}}
{{- $backend = "s3" -}}
{{- else if and (eq $requestedBackend "auto") $bucket -}}
{{- $backend = "s3" -}}
{{- end -}}
ATTACHMENT_BACKEND: {{ $backend | quote }}
{{- if eq $backend "s3" }}
ATTACHMENT_S3_BUCKET: {{ $bucket | quote }}
ATTACHMENT_S3_PREFIX: {{ $prefix | quote }}
ATTACHMENT_S3_REGION: {{ $region | quote }}
{{- if $endpoint }}
ATTACHMENT_S3_ENDPOINT_URL: {{ $endpoint | quote }}
{{- end }}
{{- end }}
{{- end -}}

