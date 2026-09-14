{{/*
Expand the name of the chart.
*/}}
{{- define "rag-server.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "rag-server.fullname" -}}
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
{{- define "rag-server.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "rag-server.labels" -}}
helm.sh/chart: {{ include "rag-server.chart" . }}
{{ include "rag-server.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: rag-server
{{- end }}

{{/*
Selector labels
*/}}
{{- define "rag-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rag-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "rag-server.serviceAccountName" -}}
    {{- if .Values.serviceAccount.create }}
        {{- default (include "rag-server.fullname" .) .Values.serviceAccount.name }}
    {{- else }}
        {{- default "default" .Values.serviceAccount.name }}
    {{- end }}
{{- end }}

{{/*
Get llmSecrets.secretName with global fallback
*/}}
{{- define "rag-server.llmSecrets.secretName" -}}
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
Get enableGraphRag with global fallback
*/}}
{{- define "rag-server.enableGraphRag" -}}
    {{- $enableGraphRag := .Values.enableGraphRag -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- if hasKey . "enableGraphRag" -}}
                {{- $enableGraphRag = .enableGraphRag -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- $enableGraphRag -}}
{{- end -}}

{{/*
Get Redis URL combining host, port and db index
*/}}
{{- define "rag-server.redisUrl" -}}
    {{- $host := "redis" -}}
    {{- $port := "6379" -}}
    {{- $db := 0 -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- with .redis -}}
                {{- if hasKey . "host" -}}
                    {{- $host = .host -}}
                {{- end -}}
                {{- if hasKey . "port" -}}
                    {{- $port = .port -}}
                {{- end -}}
                {{- if hasKey . "db" -}}
                    {{- $db = .db -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- printf "redis://%s:%s/%v" $host ($port | toString) $db -}}
{{- end -}}

{{/*
Get Neo4j address combining host and port
*/}}
{{- define "rag-server.neo4jAddr" -}}
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
{{- define "rag-server.neo4jUsername" -}}
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
{{- define "rag-server.neo4jPassword" -}}
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

{{/*
Compute Milvus URI with values override, fallback to http://<release name>-milvus:19530
*/}}
{{- define "rag-server.milvusUri" -}}
    {{- $val := (default "" .Values.milvusUri) | trim -}}
    {{- if $val -}}
        {{- $val -}}
    {{- else -}}
        {{- printf "http://%s-milvus:19530" .Release.Name -}}
    {{- end -}}
{{- end -}}

{{/*
Get Ontology Agent REST API address
*/}}
{{- define "rag-server.ontologyAgentRestapiAddr" -}}
    {{- $host := "agent-ontology" -}}
    {{- $port := "8098" -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- with .ontologyAgentRestapi -}}
                {{- if hasKey . "host" -}}
                    {{- $host = .host -}}
                {{- end -}}
                {{- if hasKey . "port" -}}
                    {{- $port = .port -}}
                {{- end -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
    {{- printf "http://%s:%s" $host ($port | toString) -}}
{{- end -}}

{{- define "rag-server.openfgaHttpUrl" -}}
{{- $url := "" -}}
{{- $explicit := index (.Values.env | default dict) "OPENFGA_HTTP" | default "" | trim -}}
{{- if $explicit -}}
    {{- $url = $explicit -}}
{{- else -}}
    {{- with .Values.global -}}
        {{- with .rag -}}
            {{- with .openfga -}}
                {{- $url = (.httpUrl | default "" | trim) -}}
            {{- end -}}
        {{- end -}}
    {{- end -}}
{{- end -}}
{{- $url -}}
{{- end -}}

{{- define "rag-server.appVersion" -}}
{{- .Values.global.image.tag | default .Chart.AppVersion -}}
{{- end -}}
