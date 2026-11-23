{{/* Validate deployment-managed OAuth connector definitions. */}}
{{- define "caipe-ui.validate.oauthConnectors" -}}
{{- $oauthConnectors := .Values.oauthConnectors | default list -}}
{{- $oauthProviders := dict -}}
{{- range $index, $connector := $oauthConnectors -}}
{{- if not (kindIs "map" $connector) -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d] must be an object" $index) -}}
{{- end -}}
{{- if hasKey $connector "clientSecret" -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d].clientSecret is not allowed; use clientSecretEnv with existingSecret or externalSecrets" $index) -}}
{{- end -}}
{{- $provider := required (printf "caipe-ui.oauthConnectors[%d].provider is required" $index) $connector.provider -}}
{{- if hasKey $oauthProviders $provider -}}
{{- fail (printf "caipe-ui.oauthConnectors provider %q is configured more than once" $provider) -}}
{{- end -}}
{{- $_ := set $oauthProviders $provider true -}}
{{- $_ := required (printf "caipe-ui.oauthConnectors[%d].name is required" $index) $connector.name -}}
{{- $_ := required (printf "caipe-ui.oauthConnectors[%d].authorizationUrl is required" $index) $connector.authorizationUrl -}}
{{- $_ := required (printf "caipe-ui.oauthConnectors[%d].tokenUrl is required" $index) $connector.tokenUrl -}}
{{- if not (hasKey $connector "scopes") -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d].scopes is required" $index) -}}
{{- end -}}
{{- if not (kindIs "slice" $connector.scopes) -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d].scopes must be a list" $index) -}}
{{- end -}}
{{- if and (hasKey $connector "pkce") (not (kindIs "bool" $connector.pkce)) -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d].pkce must be a boolean" $index) -}}
{{- end -}}
{{- if and (hasKey $connector "tokenEndpointAuthMethod") (not (has $connector.tokenEndpointAuthMethod (list "client_secret_post" "client_secret_basic"))) -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d].tokenEndpointAuthMethod must be client_secret_post or client_secret_basic" $index) -}}
{{- end -}}
{{- $pkce := $connector.pkce | default false -}}
{{- if and (not $connector.clientId) (not $connector.clientIdEnv) -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d] requires clientId or clientIdEnv" $index) -}}
{{- end -}}
{{- if and $connector.clientId $connector.clientIdEnv -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d] must set only one of clientId or clientIdEnv" $index) -}}
{{- end -}}
{{- if and (not $pkce) (not $connector.clientSecretEnv) -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d].clientSecretEnv is required unless pkce is true" $index) -}}
{{- end -}}
{{- range $field := list "clientIdEnv" "clientSecretEnv" -}}
{{- $envName := index $connector $field | default "" -}}
{{- if and $envName (not (regexMatch "^[A-Za-z_][A-Za-z0-9_]*$" $envName)) -}}
{{- fail (printf "caipe-ui.oauthConnectors[%d].%s must be a valid environment variable name" $index $field) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Validate declarative credential secret references without exposing values. */}}
{{- define "caipe-ui.validate.credentialSecretRefs" -}}
{{- $credentialSecretRefs := .Values.credentialSecretRefs | default list -}}
{{- $credentialSecretIds := dict -}}
{{- range $index, $secret := $credentialSecretRefs -}}
{{- if not (kindIs "map" $secret) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d] must be an object" $index) -}}
{{- end -}}
{{- if or (hasKey $secret "value") (hasKey $secret "plaintext") -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d] cannot contain an inline secret; use valueEnv with existingSecret or externalSecrets" $index) -}}
{{- end -}}
{{- $secretId := required (printf "caipe-ui.credentialSecretRefs[%d].id is required" $index) $secret.id -}}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$" $secretId) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d].id is invalid" $index) -}}
{{- end -}}
{{- if hasKey $credentialSecretIds $secretId -}}
{{- fail (printf "caipe-ui.credentialSecretRefs id %q is configured more than once" $secretId) -}}
{{- end -}}
{{- $_ := set $credentialSecretIds $secretId true -}}
{{- $_ := required (printf "caipe-ui.credentialSecretRefs[%d].name is required" $index) $secret.name -}}
{{- $secretType := required (printf "caipe-ui.credentialSecretRefs[%d].type is required" $index) $secret.type -}}
{{- if not (has $secretType (list "api_key" "basic_auth" "bearer_token" "custom")) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d].type is invalid" $index) -}}
{{- end -}}
{{- $valueEnv := required (printf "caipe-ui.credentialSecretRefs[%d].valueEnv is required" $index) $secret.valueEnv -}}
{{- if not (regexMatch "^[A-Za-z_][A-Za-z0-9_]*$" $valueEnv) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d].valueEnv must be a valid environment variable name" $index) -}}
{{- end -}}
{{- if not (kindIs "map" $secret.owner) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d].owner must be an object" $index) -}}
{{- end -}}
{{- $ownerType := required (printf "caipe-ui.credentialSecretRefs[%d].owner.type is required" $index) $secret.owner.type -}}
{{- if not (has $ownerType (list "team" "user")) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d].owner.type must be team or user" $index) -}}
{{- end -}}
{{- $ownerId := required (printf "caipe-ui.credentialSecretRefs[%d].owner.id is required" $index) $secret.owner.id -}}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$" $ownerId) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d].owner.id is invalid" $index) -}}
{{- end -}}
{{- if and (hasKey $secret "sharedWithTeams") (not (kindIs "slice" $secret.sharedWithTeams)) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d].sharedWithTeams must be a list" $index) -}}
{{- end -}}
{{- range $teamIndex, $teamId := $secret.sharedWithTeams | default list -}}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$" $teamId) -}}
{{- fail (printf "caipe-ui.credentialSecretRefs[%d].sharedWithTeams[%d] is invalid" $index $teamIndex) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Run all validation needed by the bootstrap ConfigMap. */}}
{{- define "caipe-ui.validate.bootstrapConfig" -}}
{{- $_ := include "caipe-ui.validate.oauthConnectors" . -}}
{{- $_ := include "caipe-ui.validate.credentialSecretRefs" . -}}
{{- end -}}
