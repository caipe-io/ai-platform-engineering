{{/* Keep every service, volume and UI reference identical for long release names. */}}
{{- define "ai-platform-engineering.harnessName" -}}
{{- $name := printf "%s-harness-%s" .root.Release.Name .component -}}
{{- if gt (len $name) 63 -}}
{{- printf "%s-%s" ($name | trunc 54 | trimSuffix "-") ($name | sha256sum | trunc 8) -}}
{{- else -}}{{ $name }}{{- end -}}
{{- end -}}

{{- define "ai-platform-engineering.harnessWorkload" -}}
{{- $root := .root -}}
{{- $h := $root.Values.harnessEngine -}}
{{- $w := .settings -}}
{{- $reservedEnv := list "HARNESS_ENGINE_INTERNAL_TOKEN" "HARNESS_ENGINE_MONGODB_URI" "HARNESS_ENGINE_STORAGE_BACKEND" "HARNESS_ENGINE_MONGODB_DATABASE" -}}
{{- $name := include "ai-platform-engineering.harnessName" . -}}
{{- $claim := $w.persistence.existingClaim | default $name -}}
{{- $image := printf "%s:%s" $w.image.repository ($w.image.tag | default (include "ai-platform-engineering.appVersion" $root)) -}}
{{- if $w.image.digest -}}{{- $image = printf "%s@%s" $w.image.repository $w.image.digest -}}{{- end -}}
{{- $tokenSecret := required (printf "%s tokenSecret.name is required" .component) $w.tokenSecret.name -}}
{{- $tokenKey := required (printf "%s tokenSecret.key is required" .component) $w.tokenSecret.key -}}
{{- if and (not $w.persistence.existingClaim) (not $w.persistence.enabled) -}}
{{- fail (printf "%s needs persistent workspace storage" .component) -}}
{{- end -}}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels:
    {{- include "ai-platform-engineering.labels" $root | nindent 4 }}
    app.kubernetes.io/component: harness-{{ .component }}
  annotations:
    reloader.stakater.com/auto: "true"
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/instance: {{ $root.Release.Name }}
      app.kubernetes.io/component: harness-{{ .component }}
  template:
    metadata:
      labels:
        {{- range $key, $value := $w.podLabels }}
        {{- if has $key (list "app.kubernetes.io/instance" "app.kubernetes.io/component" "caipe.io/harness-worker") }}{{ fail "Runtime routing labels cannot be overridden" }}{{ end }}
        {{ $key }}: {{ $value | quote }}
        {{- end }}
        app.kubernetes.io/instance: {{ $root.Release.Name }}
        app.kubernetes.io/component: harness-{{ .component }}
        caipe.io/harness-worker: {{ ne .component "engine" | quote }}
      annotations:
        checksum/config: {{ toJson (list $h.commonEnv $w.env $w.secretEnv $w.envFromSecrets $tokenSecret $tokenKey $root.Values.global.harnessEngine.configurationRevision) | sha256sum }}
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: {{ $h.terminationGracePeriodSeconds }}
      {{- with $w.serviceAccountName }}
      serviceAccountName: {{ . }}
      {{- end }}
      {{- with $h.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      {{- with $h.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $h.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $w.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: runtime
          image: {{ $image | quote }}
          imagePullPolicy: {{ $w.image.pullPolicy }}
          args: {{ toJson $w.args }}
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
          ports:
            - name: http
              containerPort: 8010
          env:
            - name: HOME
              value: /workspace
            - name: PYTHONDONTWRITEBYTECODE
              value: "1"
            - name: HARNESS_ENGINE_STORAGE_BACKEND
              value: mongodb
            - name: HARNESS_ENGINE_MONGODB_URI
              valueFrom:
                secretKeyRef:
                  name: {{ required "harnessEngine.mongodbSecret.name is required" $h.mongodbSecret.name }}
                  key: {{ required "harnessEngine.mongodbSecret.key is required" $h.mongodbSecret.key }}
            - name: HARNESS_ENGINE_MONGODB_DATABASE
              value: {{ $w.database | quote }}
            - name: HARNESS_ENGINE_INTERNAL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ $tokenSecret }}
                  key: {{ $tokenKey }}
            {{- range $key, $value := mergeOverwrite (dict) $h.commonEnv $w.env }}
            {{- if has $key $reservedEnv }}
            {{- fail (printf "%s must use its dedicated setting" $key) }}
            {{- end }}
            - name: {{ $key }}
              value: {{ $value | quote }}
            {{- end }}
            {{- range $key, $ref := $w.secretEnv }}
            {{- if has $key $reservedEnv }}
            {{- fail (printf "%s must use its dedicated setting" $key) }}
            {{- end }}
            - name: {{ $key }}
              valueFrom:
                secretKeyRef:
                  name: {{ required (printf "%s Secret name is required" $key) $ref.name }}
                  key: {{ required (printf "%s Secret key is required" $key) $ref.key }}
            {{- end }}
          {{- with $w.envFromSecrets }}
          envFrom:
            {{- range . }}
            - secretRef:
                name: {{ . }}
            {{- end }}
          {{- end }}
          resources:
            {{- toYaml $w.resources | nindent 12 }}
          startupProbe:
            httpGet: {path: /healthz, port: http}
            failureThreshold: 30
            periodSeconds: 5
          readinessProbe:
            httpGet: {path: /healthz, port: http}
          livenessProbe:
            httpGet: {path: /healthz, port: http}
          volumeMounts:
            - {name: workspace, mountPath: /workspace}
            - {name: tmp, mountPath: /tmp}
            {{- if and (eq .component "engine") $root.Values.global.harnessEngine.deepAgentsEnabled }}
            - {name: attachments, mountPath: /var/lib/caipe-attachments}
            {{- end }}
            {{- with $h.extraVolumeMounts }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
        {{- with $w.sidecars }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      volumes:
        - name: workspace
          persistentVolumeClaim: {claimName: {{ $claim }}}
        - name: tmp
          emptyDir: {medium: Memory, sizeLimit: {{ $h.tmpSizeLimit }}}
        {{- if and (eq .component "engine") $root.Values.global.harnessEngine.deepAgentsEnabled }}
        - name: attachments
          persistentVolumeClaim:
            claimName: {{ required "Deep Agents requires harnessEngine.attachmentsClaimName shared with Dynamic Agents" $h.attachmentsClaimName }}
        {{- end }}
        {{- with $h.extraVolumes }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/instance: {{ $root.Release.Name }}
    app.kubernetes.io/component: harness-{{ .component }}
  ports:
    - {name: http, port: 8010, targetPort: http}
{{- if not $w.persistence.existingClaim }}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $claim }}
  annotations:
    helm.sh/resource-policy: keep
spec:
  accessModes: [ReadWriteOnce]
  {{- with $w.persistence.storageClass }}
  storageClassName: {{ . | quote }}
  {{- end }}
  resources:
    requests: {storage: {{ $w.persistence.size }}}
{{- end }}
{{- end -}}
