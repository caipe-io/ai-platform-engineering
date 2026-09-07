from kubernetes import client

from caipe_scheduler.config import Settings
from caipe_scheduler.k8s import CronJobOps


def test_cronjob_uses_configured_scheduler_token_secret():
  settings = Settings(
    service_token="test-token",
    service_token_secret_name="custom-scheduler-token",
    service_token_secret_key="scheduler-token",
  )
  ops = CronJobOps.__new__(CronJobOps)
  ops._settings = settings

  body = ops._build_body(
    name="caipe-sched-test",
    schedule_id="sched_test",
    cron="0 9 * * MON",
    tz="UTC",
  )

  pod_spec = body["spec"]["jobTemplate"]["spec"]["template"]["spec"]
  token_env = next(item for item in pod_spec["containers"][0]["env"] if item["name"] == "SCHEDULER_SERVICE_TOKEN")

  assert pod_spec["automountServiceAccountToken"] is False
  assert token_env["valueFrom"]["secretKeyRef"] == {
    "name": "custom-scheduler-token",
    "key": "scheduler-token",
  }


def _ops() -> CronJobOps:
  ops = CronJobOps.__new__(CronJobOps)
  ops._settings = Settings(service_token="test-token")
  return ops


def _runner_env_from_body(body: dict) -> list[dict]:
  return body["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0]["env"]


def _cronjob_with_env(env: list[client.V1EnvVar]) -> client.V1CronJob:
  return client.V1CronJob(
    spec=client.V1CronJobSpec(
      schedule="0 9 * * *",
      job_template=client.V1JobTemplateSpec(
        spec=client.V1JobSpec(
          template=client.V1PodTemplateSpec(
            spec=client.V1PodSpec(
              containers=[client.V1Container(name="runner", env=env)]
            )
          )
        )
      ),
    )
  )


class _FakeBatch:
  def __init__(self, cronjob: client.V1CronJob):
    self.cronjob = cronjob
    self.patches: list[dict] = []

  def read_namespaced_cron_job(self, *, name, namespace):
    return self.cronjob

  def patch_namespaced_cron_job(self, *, name, namespace, body, **kwargs):
    self.patches.append({"body": body, "kwargs": kwargs})


def test_build_body_uses_default_timeout_and_single_retry():
  body = _ops()._build_body(
    name="caipe-sched-test",
    schedule_id="sched_test",
    cron="0 9 * * *",
    tz="UTC",
  )

  assert {"name": "HTTP_TIMEOUT", "value": "300"} in _runner_env_from_body(body)
  assert body["spec"]["jobTemplate"]["spec"]["backoffLimit"] == 1


def test_build_body_uses_custom_http_timeout():
  body = _ops()._build_body(
    name="caipe-sched-test",
    schedule_id="sched_test",
    cron="0 9 * * *",
    tz="UTC",
    http_timeout_seconds=900,
  )

  assert {"name": "HTTP_TIMEOUT", "value": "900"} in _runner_env_from_body(body)


def test_patch_http_timeout_preserves_secret_env():
  cronjob = _cronjob_with_env(
    [
      client.V1EnvVar(name="SCHEDULE_ID", value="sched_test"),
      client.V1EnvVar(name="HTTP_TIMEOUT", value="300"),
      client.V1EnvVar(
        name="SCHEDULER_SERVICE_TOKEN",
        value_from=client.V1EnvVarSource(
          secret_key_ref=client.V1SecretKeySelector(
            name="custom-scheduler-token",
            key="scheduler-token",
          )
        ),
      ),
    ]
  )
  batch = _FakeBatch(cronjob)
  ops = _ops()
  ops._batch = batch

  ops.patch(cronjob_name="caipe-sched-test", http_timeout_seconds=900)

  patch = batch.patches[0]
  env = patch["body"][0]["value"]
  secret_env = next(item for item in env if item["name"] == "SCHEDULER_SERVICE_TOKEN")

  assert patch["kwargs"] == {"_content_type": "application/json-patch+json"}
  assert [item for item in env if item["name"] == "HTTP_TIMEOUT"] == [
    {"name": "HTTP_TIMEOUT", "value": "900"}
  ]
  assert secret_env["valueFrom"]["secretKeyRef"] == {
    "name": "custom-scheduler-token",
    "key": "scheduler-token",
  }
