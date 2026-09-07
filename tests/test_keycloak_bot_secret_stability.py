from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = (
    REPO_ROOT
    / "charts"
    / "ai-platform-engineering"
    / "charts"
    / "keycloak"
    / "templates"
)


def _assert_existing_secret_precedes_random_generation(
    template_name: str,
    secret_key: str,
) -> None:
    template = (TEMPLATE_DIR / template_name).read_text()
    lookup = 'lookup "v1" "Secret" .Release.Namespace $secretName'
    existing_value = f'index $existing.data "{secret_key}"'
    generated_value = "randAlphaNum 32"

    assert lookup in template
    assert existing_value in template
    assert template.index(lookup) < template.index(existing_value)
    assert template.index(existing_value) < template.index(generated_value)


def test_slack_bot_secret_is_reused_during_helm_upgrades() -> None:
    _assert_existing_secret_precedes_random_generation(
        "bot-secret.yaml",
        "KC_BOT_CLIENT_SECRET",
    )


def test_webex_bot_secret_is_reused_during_helm_upgrades() -> None:
    _assert_existing_secret_precedes_random_generation(
        "webex-bot-secret.yaml",
        "KC_WEBEX_BOT_CLIENT_SECRET",
    )
