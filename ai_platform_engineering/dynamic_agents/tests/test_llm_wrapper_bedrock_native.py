"""Exercise native Bedrock clients and response formats without AWS network calls."""

from __future__ import annotations

from io import BytesIO
from typing import Any

import boto3
import pytest
from botocore.stub import Stubber
from langchain_core.messages import HumanMessage
from llm_wrapper.build import LLMConfigError, build_chat_model

PROFILE_ARN = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/example"
BASE_MODEL = "anthropic.claude-3-7-sonnet-20250219-v1:0"


@pytest.fixture(autouse=True)
def isolated_aws(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AWS_BEDROCK_BASE_MODEL_ID", "AWS_BEDROCK_CLIENT", "AWS_SESSION_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "example")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "example")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")


def _stub_reply(stub: Stubber, converse: bool) -> None:
    if converse:
        stub.add_response("converse", {
            "output": {"message": {"role": "assistant", "content": [{"text": "example reply"}]}},
            "stopReason": "end_turn",
            "usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3},
            "metrics": {"latencyMs": 1},
        })
    else:
        stub.add_response("invoke_model", {
            "body": BytesIO(b'{"content":[{"type":"text","text":"example reply"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}'),
            "contentType": "application/json",
        })


@pytest.mark.parametrize("converse", [False, True], ids=["legacy", "converse"])
@pytest.mark.parametrize("override", [None, "base_model_id", "base_model", "environment"])
@pytest.mark.parametrize("profile_kind", ["application-inference-profile", "inference-profile"])
def test_profile_can_invoke_with_native_provider(
    converse: bool, override: str | None, profile_kind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_arn = PROFILE_ARN.replace("application-inference-profile", profile_kind)
    runtime = boto3.client("bedrock-runtime")
    control = boto3.client("bedrock")
    kwargs: dict[str, Any] = {}
    if override == "environment":
        monkeypatch.setenv("AWS_BEDROCK_BASE_MODEL_ID", BASE_MODEL)
    elif override:
        kwargs[override] = BASE_MODEL
    with Stubber(control) as cs, Stubber(runtime) as rs:
        if not override:
            cs.add_response("get_inference_profile", {
                "inferenceProfileName": "example", "inferenceProfileArn": profile_arn,
                "inferenceProfileId": "example", "status": "ACTIVE", "type": "APPLICATION",
                "models": [{"modelArn": f"arn:aws:bedrock:us-east-1::foundation-model/{BASE_MODEL}"}],
            }, {"inferenceProfileIdentifier": profile_arn})
        model = build_chat_model("aws-bedrock", profile_arn, enable_cache=converse,
                                 client=runtime, bedrock_client=control, **kwargs)
        assert model.model_id == profile_arn
        assert model.base_model_id == BASE_MODEL
        assert model.provider == "anthropic"
        _stub_reply(rs, converse)
        assert model.invoke([HumanMessage(content="example prompt")]).content == "example reply"
        cs.assert_no_pending_responses()
        rs.assert_no_pending_responses()


@pytest.mark.parametrize("converse", [False, True])
def test_denied_profile_without_base_model_is_actionable(converse: bool) -> None:
    runtime = boto3.client("bedrock-runtime")
    control = boto3.client("bedrock")
    with Stubber(control) as cs, Stubber(runtime):
        cs.add_client_error("get_inference_profile", service_error_code="AccessDeniedException",
                            expected_params={"inferenceProfileIdentifier": PROFILE_ARN})
        with pytest.raises(LLMConfigError, match="AWS_BEDROCK_BASE_MODEL_ID"):
            build_chat_model("aws-bedrock", PROFILE_ARN, enable_cache=converse,
                             client=runtime, bedrock_client=control)
        cs.assert_no_pending_responses()


@pytest.mark.parametrize("family", ["legacy", "converse"])
def test_plain_model_invoke_is_unchanged(family: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_BEDROCK_CLIENT", family)
    runtime = boto3.client("bedrock-runtime")
    control = boto3.client("bedrock")
    with Stubber(control), Stubber(runtime) as rs:
        model = build_chat_model("aws-bedrock", BASE_MODEL, client=runtime, bedrock_client=control)
        _stub_reply(rs, family == "converse")
        assert model.invoke([HumanMessage(content="example prompt")]).content == "example reply"
