"""Kubernetes CronJob lifecycle.

Owns the full podTemplate spec - callers can only fill the schedule, timezone,
SCHEDULE_ID env var, and HTTP_TIMEOUT env var. Image, command, RBAC, mounts,
and resource limits are baked in here so dynamic-agents (or any other caller)
cannot escalate privileges via this path.
"""

from __future__ import annotations

import copy
import json
import logging
import re
from typing import Any

from kubernetes import client, config
from kubernetes.client.exceptions import ApiException

from caipe_scheduler.config import Settings
from caipe_scheduler.models import DEFAULT_HTTP_TIMEOUT_SECONDS

log = logging.getLogger(__name__)


_NAME_RE = re.compile(r"[^a-z0-9-]+")
_UNSET = object()


def _sanitize_name(s: str) -> str:
  """Squeeze a string into a valid k8s resource name fragment."""
  s = s.lower().replace("_", "-")
  s = _NAME_RE.sub("", s)
  s = s.strip("-")
  return s[:40] or "x"


def cronjob_name_for(schedule_id: str) -> str:
  """k8s resource names: <= 52 chars, RFC 1123, deterministic from schedule_id."""
  suffix = _sanitize_name(schedule_id)
  return f"caipe-sched-{suffix}"


class CronJobOps:
  def __init__(self, settings: Settings):
    self._settings = settings
    try:
      config.load_incluster_config()
    except config.ConfigException:
      try:
        config.load_kube_config()
      except Exception:
        log.warning("No kube config found; CronJobOps will fail on real calls. OK for unit tests with mocked client.")
    self._batch = client.BatchV1Api()

  # - public -
  def create(
    self,
    *,
    schedule_id: str,
    cron: str,
    tz: str,
    http_timeout_seconds: int = DEFAULT_HTTP_TIMEOUT_SECONDS,
  ) -> str:
    """Create the CronJob for the given schedule. Returns its name."""
    name = cronjob_name_for(schedule_id)
    body = self._build_body(
      name=name,
      schedule_id=schedule_id,
      cron=cron,
      tz=tz,
      http_timeout_seconds=http_timeout_seconds,
    )
    try:
      self._batch.create_namespaced_cron_job(namespace=self._settings.namespace, body=body)
    except ApiException as e:
      log.error(
        "CronJob create failed: name=%s status=%s body=%s",
        name,
        e.status,
        e.body,
      )
      raise
    return name

  def patch(
    self,
    *,
    cronjob_name: str,
    cron: str | None = None,
    tz: str | None = None,
    suspend: bool | None = None,
    http_timeout_seconds: Any = _UNSET,
  ) -> None:
    body: dict = {"spec": {}}
    if cron is not None:
      body["spec"]["schedule"] = cron
    if tz is not None:
      body["spec"]["timeZone"] = tz
    if suspend is not None:
      body["spec"]["suspend"] = suspend
    if body["spec"]:
      self._batch.patch_namespaced_cron_job(name=cronjob_name, namespace=self._settings.namespace, body=body)
    if http_timeout_seconds is not _UNSET:
      self._patch_runner_env(
        cronjob_name,
        {"HTTP_TIMEOUT": str(http_timeout_seconds)},
      )

  def delete(self, cronjob_name: str) -> None:
    try:
      self._batch.delete_namespaced_cron_job(
        name=cronjob_name,
        namespace=self._settings.namespace,
        propagation_policy="Foreground",
      )
    except ApiException as e:
      if e.status == 404:
        log.info("CronJob %s already gone, ignoring delete", cronjob_name)
        return
      raise

  def reconcile_runner_template(self, *, cronjob_name: str, dry_run: bool = True) -> dict[str, Any]:
    """Optionally patch an existing CronJob to the current runner image."""
    s = self._settings
    cronjob = self._batch.read_namespaced_cron_job(
      name=cronjob_name,
      namespace=s.namespace,
    )

    containers = cronjob.spec.job_template.spec.template.spec.containers or []
    if not containers:
      raise ValueError(f"CronJob {cronjob_name} has no containers.")

    runner = next((c for c in containers if c.name == "runner"), containers[0])
    current_image = runner.image
    current_pull_policy = runner.image_pull_policy
    desired_image = s.cron_runner_image
    desired_pull_policy = s.cron_runner_image_pull_policy
    changed = current_image != desired_image or current_pull_policy != desired_pull_policy

    if changed and not dry_run:
      body = {
        "spec": {
          "jobTemplate": {
            "spec": {
              "template": {
                "spec": {
                  "containers": [
                    {
                      "name": runner.name,
                      "image": desired_image,
                      "imagePullPolicy": desired_pull_policy,
                    }
                  ]
                }
              }
            }
          }
        }
      }
      self._batch.patch_namespaced_cron_job(
        name=cronjob_name,
        namespace=s.namespace,
        body=body,
      )

    return {
      "current_image": current_image,
      "desired_image": desired_image,
      "current_image_pull_policy": current_pull_policy,
      "desired_image_pull_policy": desired_pull_policy,
      "changed": changed,
    }

  def create_one_off_job_from_cronjob(
    self,
    *,
    cronjob_name: str,
    one_off_run_id: str,
    retry_num: int | None = None,
    retry_limit: int | None = None,
    retry_reason: str | None = None,
    metadata: dict[str, Any] | None = None,
    message_template_override: str | None = None,
  ) -> str:
    """Create a normal Job by copying an existing CronJob's jobTemplate."""
    job_name = f"caipe-oneoff-{_sanitize_name(one_off_run_id)}"
    cronjob = self._batch.read_namespaced_cron_job(
      name=cronjob_name,
      namespace=self._settings.namespace,
    )
    job_spec = copy.deepcopy(cronjob.spec.job_template.spec)

    labels = {
      "app.kubernetes.io/name": "caipe-cron-runner",
      "app.kubernetes.io/managed-by": "caipe-scheduler",
      "caipe.cisco.com/cronjob-name": _sanitize_name(cronjob_name),
      "caipe.cisco.com/one-off-run-id": _sanitize_name(one_off_run_id),
    }
    template_meta = job_spec.template.metadata or client.V1ObjectMeta()
    template_meta.labels = {**(template_meta.labels or {}), **labels}
    job_spec.template.metadata = template_meta

    containers = job_spec.template.spec.containers or []
    runner = next((c for c in containers if c.name == "runner"), containers[0])
    runner.image = self._settings.cron_runner_image
    runner.image_pull_policy = self._settings.cron_runner_image_pull_policy
    self._set_env(runner, "ONE_OFF_RUN_ID", one_off_run_id)
    if retry_num is not None:
      self._set_env(runner, "RETRY_NUM", str(retry_num))
    if retry_limit is not None:
      self._set_env(runner, "RETRY_LIMIT", str(retry_limit))
    if retry_reason:
      self._set_env(runner, "RETRY_REASON", retry_reason)
    if metadata:
      self._set_env(
        runner,
        "ONE_OFF_METADATA_JSON",
        json.dumps(metadata, sort_keys=True, separators=(",", ":")),
      )
    if message_template_override:
      self._set_env(
        runner,
        "MESSAGE_TEMPLATE_OVERRIDE",
        message_template_override,
      )

    body = client.V1Job(
      api_version="batch/v1",
      kind="Job",
      metadata=client.V1ObjectMeta(
        name=job_name,
        namespace=self._settings.namespace,
        labels=labels,
      ),
      spec=job_spec,
    )
    try:
      self._batch.create_namespaced_job(
        namespace=self._settings.namespace,
        body=body,
      )
    except ApiException as e:
      if e.status == 409:
        log.info("One-off Job %s already exists, treating as fired", job_name)
        return job_name
      log.error(
        "One-off Job create failed: name=%s cronjob=%s status=%s body=%s",
        job_name,
        cronjob_name,
        e.status,
        e.body,
      )
      raise
    return job_name

  # - body builder -
  def _build_body(
    self,
    *,
    name: str,
    schedule_id: str,
    cron: str,
    tz: str,
    http_timeout_seconds: int = DEFAULT_HTTP_TIMEOUT_SECONDS,
  ) -> dict:
    s = self._settings
    labels = {
      "app.kubernetes.io/name": "caipe-cron-runner",
      "app.kubernetes.io/managed-by": "caipe-scheduler",
      "caipe.cisco.com/schedule-id": _sanitize_name(schedule_id),
    }
    body: dict = {
      "apiVersion": "batch/v1",
      "kind": "CronJob",
      "metadata": {
        "name": name,
        "namespace": s.namespace,
        "labels": labels,
      },
      "spec": {
        "schedule": cron,
        "timeZone": tz,
        "concurrencyPolicy": "Forbid",
        "successfulJobsHistoryLimit": 3,
        "failedJobsHistoryLimit": 3,
        "startingDeadlineSeconds": 600,
        "jobTemplate": {
          "metadata": {"labels": labels},
          "spec": {
            "backoffLimit": 1,
            "ttlSecondsAfterFinished": 86400,
            "template": {
              "metadata": {"labels": labels},
              "spec": {
                "serviceAccountName": s.cron_runner_service_account,
                "restartPolicy": "OnFailure",
                "automountServiceAccountToken": False,
                "containers": [
                  {
                    "name": "runner",
                    "image": s.cron_runner_image,
                    "imagePullPolicy": s.cron_runner_image_pull_policy,
                    # The runner authenticates to the BFF
                    # with the shared scheduler token only;
                    # the BFF mints the owner bearer. No
                    # chat-API token is mounted (Approach 2).
                    "env": [
                      {"name": "SCHEDULE_ID", "value": schedule_id},
                      {"name": "SCHEDULER_INTERNAL_URL", "value": s.scheduler_internal_url},
                      {"name": "CAIPE_API_URL", "value": s.caipe_api_url},
                      {"name": "CAIPE_CHAT_PATH", "value": s.caipe_chat_path},
                      {"name": "HTTP_TIMEOUT", "value": str(http_timeout_seconds)},
                      {
                        "name": "SCHEDULER_SERVICE_TOKEN",
                        "valueFrom": {
                          "secretKeyRef": {
                            "name": s.service_token_secret_name,
                            "key": s.service_token_secret_key,
                          }
                        },
                      },
                    ],
                    "resources": {
                      "requests": {"cpu": "20m", "memory": "64Mi"},
                      "limits": {"cpu": "100m", "memory": "128Mi"},
                    },
                    "securityContext": {
                      "allowPrivilegeEscalation": False,
                      "readOnlyRootFilesystem": True,
                      "runAsNonRoot": True,
                      "runAsUser": 1001,
                      "runAsGroup": 1001,
                      "capabilities": {"drop": ["ALL"]},
                      "seccompProfile": {"type": "RuntimeDefault"},
                    },
                  }
                ],
              },
            },
          },
        },
      },
    }
    return body

  def _patch_runner_env(self, cronjob_name: str, updates: dict[str, str]) -> None:
    s = self._settings
    cronjob = self._batch.read_namespaced_cron_job(
      name=cronjob_name,
      namespace=s.namespace,
    )

    containers = cronjob.spec.job_template.spec.template.spec.containers or []
    if not containers:
      raise ValueError(f"CronJob {cronjob_name} has no containers.")

    runner_index, runner = next(
      (
        (index, container)
        for index, container in enumerate(containers)
        if container.name == "runner"
      ),
      (0, containers[0]),
    )
    api_client = client.ApiClient()
    update_names = set(updates)
    env = [
      api_client.sanitize_for_serialization(item)
      for item in (runner.env or [])
      if item.name not in update_names
    ]
    for name, value in updates.items():
      env.append({"name": name, "value": value})

    body = [
      {
        "op": "replace" if runner.env is not None else "add",
        "path": (
          "/spec/jobTemplate/spec/template/spec/containers/"
          f"{runner_index}/env"
        ),
        "value": env,
      }
    ]
    self._batch.patch_namespaced_cron_job(
      name=cronjob_name,
      namespace=s.namespace,
      body=body,
      _content_type="application/json-patch+json",
    )

  @staticmethod
  def _set_env(container: client.V1Container, name: str, value: str) -> None:
    env = [item for item in (container.env or []) if item.name != name]
    env.append(client.V1EnvVar(name=name, value=value))
    container.env = env
