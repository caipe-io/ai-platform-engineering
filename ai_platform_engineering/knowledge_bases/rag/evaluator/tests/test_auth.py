from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from deepeval_eval.api.auth import (
    AuthManager,
    OIDCProvider,
    ResourceType,
    ResourceVisibility,
    Role,
    UserContext,
    _has_unrestricted_eval_access,
    _openfga_user,
    authorize_agent_access,
    authorize_datasource_access,
    authorize_evaluate,
    authorize_evaluation_access,
    authorize_question_set_access,
    extract_client_id_from_claims,
    get_allowed_resource_ids,
    has_permission,
    is_client_credentials_token,
    update_resource_visibility,
    write_evaluation_ownership,
)

# ---------------------------------------------------------------------------
# UserContext & Basic Contracts
# ---------------------------------------------------------------------------


def test_user_context_valid_attributes_returns_expected_values():
    """Verify UserContext attributes are assigned properly."""
    user = UserContext(
        subject="sub_123",
        email="test@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
        client_id="client_1",
    )
    assert user.subject == "sub_123"
    assert user.email == "test@example.com"
    assert user.role == Role.ADMIN
    assert user.is_authenticated is True
    assert user.client_id == "client_1"


def test_user_context_field_mutation_raises_exception():
    """Verify UserContext is frozen and rejects field mutation."""
    user = UserContext(email="test@example.com", is_authenticated=True)
    with pytest.raises(Exception):
        user.email = "other@example.com"  # type: ignore[misc]


def test_has_permission_admin_role_returns_true():
    """Verify Role.ADMIN satisfies Role.READONLY requirement."""
    assert has_permission(Role.ADMIN, Role.READONLY) is True


def test_has_permission_evaluator_role_returns_true():
    """Verify Role.EVALUATOR satisfies Role.READONLY requirement."""
    assert has_permission(Role.EVALUATOR, Role.READONLY) is True


def test_has_permission_readonly_role_returns_false_for_higher_roles():
    """Verify Role.READONLY does not satisfy higher required roles."""
    assert has_permission(Role.READONLY, Role.EVALUATOR) is False
    assert has_permission(Role.READONLY, Role.ADMIN) is False


# ---------------------------------------------------------------------------
# Client Credentials Machine Detection
# ---------------------------------------------------------------------------


def test_is_client_credentials_token_gty_claim_returns_true():
    """Verify gty client-credentials claim resolves to True."""
    assert is_client_credentials_token({"gty": "client-credentials"}) is True


def test_is_client_credentials_token_grant_type_claim_returns_true():
    """Verify grant_type client-credentials claim resolves to True."""
    assert is_client_credentials_token({"grant_type": "client-credentials"}) is True


def test_is_client_credentials_token_sub_matching_client_id_returns_true():
    """Verify sub matching client_id resolves to True."""
    assert (
        is_client_credentials_token(
            {"sub": "my-service-account", "client_id": "my-service-account"}
        )
        is True
    )


def test_is_client_credentials_token_service_account_username_returns_true():
    """Verify preferred_username service-account prefix resolves to True."""
    assert (
        is_client_credentials_token({"preferred_username": "service-account-ci-runner"})
        is True
    )


def test_is_client_credentials_token_human_user_claims_returns_false():
    """Verify human OIDC user claims resolve to False."""
    claims = {
        "sub": "user_12345",
        "email": "user@example.com",
        "preferred_username": "john_doe",
    }
    assert is_client_credentials_token(claims) is False


def test_extract_client_id_from_claims_client_id_claim_returns_client_id():
    """Verify extraction when client_id claim exists."""
    assert extract_client_id_from_claims({"client_id": "app_1"}) == "app_1"


def test_extract_client_id_from_claims_azp_claim_returns_azp():
    """Verify extraction when azp claim exists."""
    assert extract_client_id_from_claims({"azp": "app_2"}) == "app_2"


def test_extract_client_id_from_claims_service_account_username_returns_slug():
    """Verify extraction from preferred_username service-account prefix."""
    assert (
        extract_client_id_from_claims({"preferred_username": "service-account-runner"})
        == "runner"
    )


def test_extract_client_id_from_claims_empty_claims_returns_unknown_client():
    """Verify fallback string when claims dictionary is empty."""
    assert extract_client_id_from_claims({}) == "unknown-client"


# ---------------------------------------------------------------------------
# OIDCProvider & AuthManager
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_get_jwks_unexpired_cache_returns_cached_keys():
    """Verify OIDCProvider returns cached JWKS if not expired."""
    provider = OIDCProvider(
        issuer="https://issuer.com",
        audience="aud",
        jwks_url="https://issuer.com/jwks",
    )
    provider.jwks_cache = {"keys": [{"kid": "k1"}]}
    provider.jwks_cache_time = 9999999999.0

    jwks = await provider.get_jwks()
    assert jwks == {"keys": [{"kid": "k1"}]}


@pytest.mark.anyio
async def test_validate_token_matching_static_key_returns_admin_context():
    """Verify static API key matches and returns ADMIN UserContext."""
    from pydantic import SecretStr

    from deepeval_eval.core.config import AuthSettings

    settings = AuthSettings(api_key=SecretStr("secret_key"))
    auth_mgr = AuthManager(settings=settings)

    user = await auth_mgr.validate_token("secret_key")
    assert user.role == Role.ADMIN
    assert user.email == "service-account@deepeval"


@pytest.mark.anyio
async def test_validate_token_client_credentials_assigns_evaluator_role():
    """Verify machine client-credentials tokens get Role.EVALUATOR."""
    auth_mgr = AuthManager()
    provider = OIDCProvider(issuer="https://issuer.com", audience="aud")
    auth_mgr.providers["default"] = provider

    mock_claims = {
        "sub": "evaluator-ci-client",
        "client_id": "evaluator-ci-client",
        "gty": "client-credentials",
    }

    with patch.object(provider, "validate_token", new_callable=AsyncMock) as mock_val:
        mock_val.return_value = mock_claims
        user = await auth_mgr.validate_token("valid_token")
        assert user.role == Role.EVALUATOR
        assert user.email == "client:evaluator-ci-client"
        assert user.client_id == "evaluator-ci-client"


# ---------------------------------------------------------------------------
# OpenFGA Authorization Functions
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_authorize_evaluate_bypass_mode_succeeds():
    """Verify emergency bypass mode allows evaluation submission."""
    user = UserContext(subject="user-1", email="user-1@example.com", role=Role.READONLY)
    with patch(
        "deepeval_eval.api.auth.is_unsafe_rbac_bypass_enabled", return_value=True
    ):
        await authorize_evaluate(user)


@pytest.mark.anyio
async def test_authorize_evaluate_allowed_relation_succeeds():
    """Verify user with org can_evaluate relation is authorized."""
    user = UserContext(subject="user-123", email="user@example.com", role=Role.READONLY)
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=True,
        ),
    ):
        await authorize_evaluate(user)


@pytest.mark.anyio
async def test_authorize_evaluate_denied_relation_raises_http_403():
    """Verify user without org can_evaluate relation raises HTTP 403."""
    user = UserContext(subject="user-123", email="user@example.com", role=Role.READONLY)
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=False,
        ),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await authorize_evaluate(user)
        assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_authorize_datasource_access_allowed_relation_succeeds():
    """Verify data source read access succeeds when OpenFGA allows."""
    user = UserContext(subject="user-123", email="user@example.com", role=Role.READONLY)
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=True,
        ),
    ):
        await authorize_datasource_access(user, "ds-enterprise", "read")


@pytest.mark.anyio
async def test_authorize_datasource_access_denied_relation_raises_http_403():
    """Verify data source access raises HTTP 403 when OpenFGA denies access."""
    user = UserContext(subject="user-123", email="user@example.com", role=Role.READONLY)
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=False,
        ),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await authorize_datasource_access(user, "ds-restricted", "read")
        assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_authorize_agent_access_allowed_relation_succeeds():
    """Verify agent access succeeds when OpenFGA allows."""
    user = UserContext(subject="user-123", email="user@example.com", role=Role.READONLY)
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=True,
        ),
    ):
        await authorize_agent_access(user, "hello-world", "read")


@pytest.mark.anyio
async def test_authorize_agent_access_denied_relation_raises_http_403():
    """Verify agent access raises HTTP 403 when OpenFGA denies access."""
    user = UserContext(subject="user-123", email="user@example.com", role=Role.READONLY)
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=False,
        ),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await authorize_agent_access(user, "restricted-agent", "read")
        assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_authorize_evaluation_access_allowed_relation_succeeds():
    """Verify evaluation read access succeeds when OpenFGA allows."""
    user = UserContext(subject="user-123", email="user@example.com", role=Role.READONLY)
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=True,
        ),
    ):
        await authorize_evaluation_access(user, "job-100", "read")


@pytest.mark.anyio
async def test_authorize_question_set_access_denied_relation_raises_http_403():
    """Verify question set manage access raises HTTP 403 when OpenFGA denies."""
    user = UserContext(subject="user-123", email="user@example.com", role=Role.READONLY)
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=False,
        ),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await authorize_question_set_access(user, "1", "manage")
        assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_write_evaluation_ownership_team_specified_writes_team_tuples():
    """Verify OpenFGA tuple structure when creating a team-owned evaluation."""
    user = UserContext(
        subject="user-456", email="owner@example.com", role=Role.READONLY
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples", new_callable=AsyncMock
        ) as mock_write,
    ):
        await write_evaluation_ownership("job-999", "dev-team", "team", user)
        mock_write.assert_called_once()
        written_tuples = mock_write.call_args[0][0]
        assert any(t["relation"] == "creator" for t in written_tuples)
        assert any(t["user"] == "team:dev-team#member" for t in written_tuples)


# ---------------------------------------------------------------------------
# OpenFGA User Resolution & Allowed Resource IDs
# ---------------------------------------------------------------------------


def test_openfga_user_user_subject_returns_user_prefix():
    """Verify _openfga_user formats human user subject with user: prefix."""
    u = UserContext(subject="usr_123", email="u@example.com")
    assert _openfga_user(u) == "user:usr_123"


def test_openfga_user_client_id_returns_service_account_prefix():
    """Verify _openfga_user formats machine client_id with service_account: prefix."""
    u = UserContext(client_id="sa-builder", email="client:sa-builder")
    assert _openfga_user(u) == "service_account:sa-builder"


def test_openfga_user_invalid_characters_returns_none():
    """Verify _openfga_user returns None for subjects containing disallowed characters."""
    u = UserContext(subject="user:123; DROP TABLE", email="bad@example.com")
    assert _openfga_user(u) is None


def test_openfga_user_missing_subject_and_client_id_returns_none():
    """Verify _openfga_user returns None when both subject and client_id are missing."""
    u = UserContext(subject=None, client_id=None, email="anon@example.com")
    assert _openfga_user(u) is None


def test_has_unrestricted_eval_access_client_credentials_returns_false():
    """Verify _has_unrestricted_eval_access returns False for M2M tokens."""
    m2m_user = UserContext(
        client_id="my-runner", email="client:my-runner", role=Role.EVALUATOR
    )
    assert _has_unrestricted_eval_access(m2m_user) is False


@pytest.mark.anyio
async def test_get_allowed_resource_ids_openfga_unconfigured_returns_none():
    """Verify get_allowed_resource_ids returns None when OPENFGA_HTTP is unset."""
    user = UserContext(subject="usr_1", email="usr_1@example.com")
    with patch("deepeval_eval.api.auth._openfga_http_url", return_value=None):
        res = await get_allowed_resource_ids(user, "question_set", "can_read")
        assert res is None


@pytest.mark.anyio
async def test_get_allowed_resource_ids_openfga_error_returns_empty_list():
    """Verify get_allowed_resource_ids returns empty list when OpenFGA call raises exception."""
    user = UserContext(subject="usr_1", email="usr_1@example.com")
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_list_objects",
            new_callable=AsyncMock,
            side_effect=RuntimeError("OpenFGA down"),
        ),
    ):
        res = await get_allowed_resource_ids(user, "question_set", "can_read")
        assert res == []


@pytest.mark.anyio
async def test_get_allowed_resource_ids_openfga_objects_returns_stripped_ids():
    """Verify get_allowed_resource_ids extracts resource ID strings from OpenFGA object names."""
    user = UserContext(subject="usr_1", email="usr_1@example.com")
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_list_objects",
            new_callable=AsyncMock,
            return_value=["question_set:101", "question_set:102"],
        ),
    ):
        res = await get_allowed_resource_ids(user, "question_set", "can_read")
        assert res == ["101", "102"]


@pytest.mark.anyio
async def test_oidc_provider_validate_token_with_valid_jwks_returns_decoded_claims():
    """Verify OIDCProvider fetches JWKS, parses PyJWK, and decodes valid JWT claims."""
    provider = OIDCProvider(
        name="keycloak",
        issuer="http://keycloak/realms/caipe",
        audience="caipe-app",
        jwks_url="http://keycloak/realms/caipe/protocol/openid-connect/certs",
    )
    fake_header = {"kid": "key_1"}
    fake_jwks = {"keys": [{"kid": "key_1", "kty": "RSA"}]}
    fake_claims = {"sub": "user_123", "email": "test@example.com"}

    mock_pyjwk = MagicMock()
    mock_pyjwk.key = "public_key"
    mock_pyjwk.algorithm_name = "RS256"

    with (
        patch.object(
            provider, "get_jwks", new_callable=AsyncMock, return_value=fake_jwks
        ),
        patch("jwt.get_unverified_header", return_value=fake_header),
        patch("jwt.PyJWK.from_dict", return_value=mock_pyjwk),
        patch("jwt.decode", return_value=fake_claims),
    ):
        claims = await provider.validate_token("valid.jwt.token")
        assert claims == fake_claims


@pytest.mark.anyio
async def test_oidc_provider_validate_token_missing_kid_raises_jwt_error():
    """Verify OIDCProvider raises JWTError when token header is missing kid."""
    provider = OIDCProvider(
        name="test",
        issuer="http://keycloak/realms/caipe",
        audience="caipe-app",
    )
    with (
        patch.object(provider, "get_jwks", new_callable=AsyncMock, return_value={}),
        patch("jwt.get_unverified_header", return_value={}),
    ):
        from deepeval_eval.api.auth import JWTError

        with pytest.raises(JWTError, match="Token header missing 'kid'"):
            await provider.validate_token("token.without.kid")


@pytest.mark.anyio
async def test_oidc_provider_validate_token_unmatched_kid_raises_jwt_error():
    """Verify OIDCProvider raises JWTError when kid is not found in fetched JWKS keys."""
    provider = OIDCProvider(
        name="test",
        issuer="http://keycloak/realms/caipe",
        audience="caipe-app",
    )
    with (
        patch.object(
            provider, "get_jwks", new_callable=AsyncMock, return_value={"keys": []}
        ),
        patch("jwt.get_unverified_header", return_value={"kid": "missing"}),
    ):
        from deepeval_eval.api.auth import JWTError

        with pytest.raises(JWTError, match="Key ID 'missing' not found in JWKS"):
            await provider.validate_token("token.with.missing.kid")


@pytest.mark.anyio
async def test_auth_manager_authenticate_request_with_evaluator_role_returns_evaluator_context():
    """Verify AuthManager maps evaluator realm roles to Role.EVALUATOR."""
    auth_mgr = AuthManager()
    provider = OIDCProvider(
        name="keycloak",
        issuer="http://keycloak/realms/caipe",
        audience="caipe-app",
    )
    provider.get_jwks = AsyncMock(return_value={"keys": [{"kid": "k1"}]})  # type: ignore[assignment]

    fake_claims = {
        "sub": "user_eval",
        "email": "evaluator@example.com",
        "realm_access": {"roles": ["evaluator"]},
    }
    auth_mgr.providers = {"keycloak": provider}
    with patch.object(
        provider, "validate_token", new_callable=AsyncMock, return_value=fake_claims
    ):
        user = await auth_mgr.validate_token("valid_token")
        assert user.is_authenticated is True
        assert user.role == Role.EVALUATOR


@pytest.mark.anyio
async def test_get_allowed_resource_ids_evaluator_role_returns_none():
    """Verify get_allowed_resource_ids returns None (unrestricted) for EVALUATOR role."""
    user = UserContext(
        subject="usr_eval", email="eval@example.com", role=Role.EVALUATOR
    )
    res = await get_allowed_resource_ids(user, "question_set", "can_read")
    assert res is None


@pytest.mark.anyio
async def test_require_authenticated_user_header_token_success():
    """Verify require_authenticated_user extracts Bearer token and validates via AuthManager."""
    from fastapi import Request

    from deepeval_eval.api.auth import require_authenticated_user

    mock_request = MagicMock(spec=Request)
    mock_request.headers = {"Authorization": "Bearer valid_token"}

    mock_auth = MagicMock()
    user_expected = UserContext(
        subject="u1", email="u1@example.com", is_authenticated=True
    )
    mock_auth.validate_token = AsyncMock(return_value=user_expected)

    user_res = await require_authenticated_user(mock_request, auth_manager=mock_auth)
    assert user_res == user_expected


@pytest.mark.anyio
async def test_authorize_evaluate_admin_role_returns_early():
    """Verify authorize_evaluate bypasses checks for Role.ADMIN users."""
    from deepeval_eval.api.auth import authorize_evaluate

    user = UserContext(
        subject="admin",
        email="admin@example.com",
        role=Role.ADMIN,
        is_authenticated=True,
    )
    # Should not raise
    await authorize_evaluate(user)


@pytest.mark.anyio
async def test_authorize_evaluation_access_allowed_object_returns_early():
    """Verify authorize_evaluation_access permits access when OpenFGA returns true."""
    from deepeval_eval.api.auth import authorize_evaluation_access

    user = UserContext(
        subject="u1", email="u1@example.com", role=Role.READONLY, is_authenticated=True
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=True,
        ),
    ):
        await authorize_evaluation_access(user, "eval_1")


@pytest.mark.anyio
async def test_authorize_question_set_access_denied_raises_403():
    """Verify authorize_question_set_access raises 403 when OpenFGA returns false."""
    from deepeval_eval.api.auth import authorize_question_set_access

    user = UserContext(
        subject="u1", email="u1@example.com", role=Role.READONLY, is_authenticated=True
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=False,
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await authorize_question_set_access(user, "qs_1")
        assert exc.value.status_code == 403


@pytest.mark.anyio
async def test_require_role_evaluator_with_openfga_org_evaluator_perm_grants_access():
    """Verify require_role(Role.EVALUATOR) succeeds when OpenFGA gives can_evaluate org permission."""
    from deepeval_eval.api.auth import require_role

    user = UserContext(
        subject="user_1",
        email="user_1@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )
    dependency = require_role(Role.EVALUATOR)

    with patch(
        "deepeval_eval.api.auth._openfga_check_object",
        new_callable=AsyncMock,
        return_value=True,
    ):
        granted_user = await dependency(user)
        assert granted_user.role == Role.EVALUATOR


# ---------------------------------------------------------------------------
# Tests for update_resource_visibility & Visibility Enums
# ---------------------------------------------------------------------------


def test_resource_visibility_and_type_enum_values():
    """Verify ResourceVisibility and ResourceType enum constants match OpenFGA model expectations."""
    assert ResourceVisibility.PRIVATE.value == "private"
    assert ResourceVisibility.TEAM.value == "team"
    assert ResourceVisibility.PUBLIC.value == "public"

    assert ResourceType.EVALUATION.value == "evaluation"
    assert ResourceType.QUESTION_SET.value == "question_set"


@pytest.mark.anyio
async def test_update_resource_visibility_openfga_disabled_noop():
    """Verify update_resource_visibility returns immediately without calling write when OpenFGA URL is None."""
    user = UserContext(
        subject="user_1", email="user1@example.com", is_authenticated=True
    )
    with (
        patch("deepeval_eval.api.auth._openfga_http_url", return_value=None),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples", new_callable=AsyncMock
        ) as mock_write,
    ):
        await update_resource_visibility(
            ResourceType.EVALUATION, "eval_123", ResourceVisibility.PUBLIC, None, user
        )
        mock_write.assert_not_called()


@pytest.mark.anyio
async def test_update_resource_visibility_public_with_owner_team_writes_tuples():
    """Verify update_resource_visibility writes public and team reader/manager tuples."""
    user = UserContext(
        subject="user_1",
        email="user1@example.com",
        groups=["team_fallback"],
        is_authenticated=True,
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples", new_callable=AsyncMock
        ) as mock_write,
    ):
        await update_resource_visibility(
            ResourceType.EVALUATION,
            "eval_123",
            ResourceVisibility.PUBLIC,
            "mlops-team",
            user,
        )
        mock_write.assert_called_once()
        _, kwargs = mock_write.call_args
        writes = kwargs["writes"]
        deletes = kwargs["deletes"]

        assert {
            "user": "team:mlops-team#member",
            "relation": "reader",
            "object": "evaluation:eval_123",
        } in writes
        assert {
            "user": "team:mlops-team#admin",
            "relation": "manager",
            "object": "evaluation:eval_123",
        } in writes
        assert {
            "user": "user:*",
            "relation": "reader",
            "object": "evaluation:eval_123",
        } in writes
        assert deletes == []


@pytest.mark.anyio
async def test_update_resource_visibility_private_with_user_groups_fallback_deletes_public():
    """Verify update_resource_visibility in private mode deletes user:* reader and falls back to user group."""
    user = UserContext(
        subject="user_1",
        email="user1@example.com",
        groups=["dev-team"],
        is_authenticated=True,
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples", new_callable=AsyncMock
        ) as mock_write,
    ):
        await update_resource_visibility(
            ResourceType.QUESTION_SET,
            42,
            ResourceVisibility.PRIVATE,
            None,
            user,
        )
        mock_write.assert_called_once()
        _, kwargs = mock_write.call_args
        writes = kwargs["writes"]
        deletes = kwargs["deletes"]

        assert {
            "user": "team:dev-team#member",
            "relation": "reader",
            "object": "question_set:42",
        } in writes
        assert {
            "user": "team:dev-team#admin",
            "relation": "manager",
            "object": "question_set:42",
        } in writes
        assert {
            "user": "user:*",
            "relation": "reader",
            "object": "question_set:42",
        } in deletes


@pytest.mark.anyio
async def test_update_resource_visibility_openfga_exception_logged_gracefully():
    """Verify update_resource_visibility logs warning and does not raise when OpenFGA call fails."""
    user = UserContext(
        subject="user_1", email="user1@example.com", is_authenticated=True
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples",
            new_callable=AsyncMock,
            side_effect=RuntimeError("OpenFGA down"),
        ),
    ):
        # Should not raise exception
        await update_resource_visibility(
            "evaluation",
            "eval_bad\nnewline",
            "public",
            "team\rbad",
            user,
        )


def test_load_monorepo_auth_returns_default_tuple():
    """Verify _load_monorepo_auth returns expected stub tuple."""
    from deepeval_eval.api.auth import _load_monorepo_auth

    assert _load_monorepo_auth() == (False, None, None)


def test_is_client_credentials_token_no_email_with_client_id():
    """Verify is_client_credentials_token returns True when client_id is present without email or preferred_username."""
    claims = {"client_id": "service-worker-client"}
    assert is_client_credentials_token(claims) is True


def test_extract_client_id_from_claims_various_formats():
    """Verify extract_client_id_from_claims extracts client IDs from client- prefix, sub, or fallback."""
    # preferred_username with client- prefix
    assert (
        extract_client_id_from_claims({"preferred_username": "client-eval-tool"})
        == "eval-tool"
    )
    # fallback to sub
    assert extract_client_id_from_claims({"sub": "sub-12345"}) == "sub-12345"
    # fallback to unknown-client
    assert extract_client_id_from_claims({}) == "unknown-client"


def test_allow_unauthenticated_access_unsafe_bypass_enabled(
    monkeypatch: pytest.MonkeyPatch,
):
    """Verify allow_unauthenticated_access returns True when CAIPE_UNSAFE_RBAC_BYPASS is set."""
    from deepeval_eval.api.auth import allow_unauthenticated_access

    monkeypatch.setenv("CAIPE_UNSAFE_RBAC_BYPASS", "true")
    assert allow_unauthenticated_access() is True


@pytest.mark.anyio
async def test_oidc_provider_get_jwks_discovery_and_cache():
    """Verify OIDCProvider.get_jwks fetches via discovery and caches result within TTL."""
    provider = OIDCProvider(issuer="http://keycloak.example.com", audience="caipe-app")

    mock_resp_disc = MagicMock()
    mock_resp_disc.json.return_value = {
        "jwks_uri": "http://keycloak.example.com/protocol/openid-connect/certs"
    }
    mock_resp_disc.raise_for_status = MagicMock()

    mock_resp_jwks = MagicMock()
    mock_resp_jwks.json.return_value = {"keys": [{"kid": "k1", "kty": "RSA"}]}
    mock_resp_jwks.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.get.side_effect = [mock_resp_disc, mock_resp_jwks]
    mock_client.__aenter__.return_value = mock_client

    with patch.object(provider, "_http_client", return_value=mock_client):
        jwks = await provider.get_jwks()
        assert jwks == {"keys": [{"kid": "k1", "kty": "RSA"}]}

        # Second call should hit cache without calling client.get
        jwks_cached = await provider.get_jwks()
        assert jwks_cached == jwks
        assert mock_client.get.call_count == 2


@pytest.mark.anyio
async def test_oidc_provider_get_jwks_missing_jwks_uri_raises_value_error():
    """Verify OIDCProvider.get_jwks raises ValueError if discovery does not yield jwks_uri."""
    provider = OIDCProvider(issuer="http://bad-idp.example.com", audience="caipe-app")

    mock_resp_disc = MagicMock()
    mock_resp_disc.json.return_value = {}  # missing jwks_uri
    mock_resp_disc.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.get.return_value = mock_resp_disc
    mock_client.__aenter__.return_value = mock_client

    with patch.object(provider, "_http_client", return_value=mock_client):
        with pytest.raises(ValueError, match="Could not determine JWKS URI"):
            await provider.get_jwks()


@pytest.mark.anyio
async def test_oidc_provider_validate_token_missing_or_invalid_kid():
    """Verify OIDCProvider.validate_token raises JWTError on missing or unknown kid."""
    from jwt.exceptions import PyJWTError as JWTError

    provider = OIDCProvider(issuer="http://idp.example.com", audience="caipe-app")

    with (
        patch.object(
            provider, "get_jwks", return_value={"keys": [{"kid": "known_key"}]}
        ),
        patch("jwt.get_unverified_header", return_value={}),
    ):
        with pytest.raises(JWTError, match="Token header missing 'kid'"):
            await provider.validate_token("token.without.kid")

    with (
        patch.object(
            provider, "get_jwks", return_value={"keys": [{"kid": "known_key"}]}
        ),
        patch("jwt.get_unverified_header", return_value={"kid": "unknown_key"}),
    ):
        with pytest.raises(JWTError, match="Key ID 'unknown_key' not found in JWKS"):
            await provider.validate_token("token.with.unknown.kid")


@pytest.mark.anyio
async def test_auth_manager_validate_token_string_group_and_evaluator_role():
    """Verify AuthManager.validate_token parses string groups and assigns Role.EVALUATOR."""
    from deepeval_eval.core.config import AuthSettings

    settings = AuthSettings(
        oidc_issuer_url="http://keycloak.example.com", oidc_audience="caipe"
    )
    mgr = AuthManager(settings=settings)

    mock_provider = AsyncMock()
    mock_provider.validate_token.return_value = {
        "sub": "user_456",
        "preferred_username": "evaluator_user",
        "groups": "evaluators",  # single string
    }
    mgr.providers["default"] = mock_provider

    user = await mgr.validate_token("valid.evaluator.token")
    assert user.role == Role.EVALUATOR
    assert user.groups == ["evaluators"]


@pytest.mark.anyio
async def test_auth_manager_validate_token_invalid_across_all_providers():
    """Verify AuthManager.validate_token aggregates errors and raises JWTError."""
    from jwt.exceptions import PyJWTError as JWTError

    from deepeval_eval.core.config import AuthSettings

    settings = AuthSettings(oidc_issuer_url="http://keycloak.example.com")
    mgr = AuthManager(settings=settings)

    mock_provider = AsyncMock()
    mock_provider.validate_token.side_effect = RuntimeError("Signature mismatch")
    mgr.providers["default"] = mock_provider

    with pytest.raises(JWTError, match="Token validation failed: Signature mismatch"):
        await mgr.validate_token("invalid.token.signature")


@pytest.mark.anyio
async def test_require_authenticated_user_auth_header_formats_and_api_key():
    """Verify require_authenticated_user handles plain tokens, X-API-Key, and missing auth with 401."""
    from deepeval_eval.api.auth import require_authenticated_user
    from deepeval_eval.core.config import AuthSettings

    auth_mgr = AuthManager(settings=AuthSettings(allow_unauthenticated_access=False))
    auth_mgr.validate_token = AsyncMock(
        return_value=UserContext(email="test@user.com", is_authenticated=True)
    )

    # Plain Authorization token (no Bearer prefix)
    mock_req_plain = MagicMock()
    mock_req_plain.headers = {"Authorization": "raw_token_xyz"}
    user_plain = await require_authenticated_user(mock_req_plain, auth_manager=auth_mgr)
    assert user_plain.email == "test@user.com"

    # X-API-Key header
    mock_req_api_key = MagicMock()
    mock_req_api_key.headers = {"X-API-Key": "api_key_123"}
    user_key = await require_authenticated_user(mock_req_api_key, auth_manager=auth_mgr)
    assert user_key.email == "test@user.com"

    # Missing credentials without unauthenticated access
    mock_req_empty = MagicMock()
    mock_req_empty.headers = {}
    with pytest.raises(HTTPException) as exc_info:
        await require_authenticated_user(mock_req_empty, auth_manager=auth_mgr)
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_require_role_openfga_dynamic_upgrades():
    """Verify require_role dynamically upgrades user context if OpenFGA confirms permissions."""
    from deepeval_eval.api.auth import require_role

    user_readonly = UserContext(
        email="user@example.com", role=Role.READONLY, is_authenticated=True
    )

    # Upgrade to ADMIN via _openfga_check_org_admin
    with patch(
        "deepeval_eval.api.auth._openfga_check_org_admin",
        new_callable=AsyncMock,
        return_value=True,
    ):
        admin_guard = require_role(Role.ADMIN)
        upgraded_admin = await admin_guard(user_readonly)
        assert upgraded_admin.role == Role.ADMIN

    # Upgrade to EVALUATOR via _openfga_check_object
    with (
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=True,
        ),
    ):
        evaluator_guard = require_role(Role.EVALUATOR)
        upgraded_evaluator = await evaluator_guard(user_readonly)
        assert upgraded_evaluator.role == Role.EVALUATOR

    # Insufficient permission raises 403
    with (
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=False,
        ),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await evaluator_guard(user_readonly)
        assert exc_info.value.status_code == 403


def test_openfga_helper_functions_and_caching(monkeypatch: pytest.MonkeyPatch):
    """Verify _caipe_org_key, _openfga_user, and _openfga_headers formatting."""
    from deepeval_eval.api.auth import _caipe_org_key, _openfga_headers, _openfga_user

    # Valid vs invalid CAIPE_ORG_KEY
    monkeypatch.setenv("CAIPE_ORG_KEY", "custom-org-123")
    assert _caipe_org_key() == "custom-org-123"

    monkeypatch.setenv("CAIPE_ORG_KEY", "invalid key with spaces!")
    assert _caipe_org_key() == "caipe"

    # _openfga_user client_id vs subject vs invalid
    sa_user = UserContext(
        client_id="m2m-agent-client", email="client@local", is_authenticated=True
    )
    assert _openfga_user(sa_user) == "service_account:m2m-agent-client"

    human_user = UserContext(
        subject="user_uuid_123", email="human@local", is_authenticated=True
    )
    assert _openfga_user(human_user) == "user:user_uuid_123"

    invalid_user = UserContext(
        subject="invalid subject with spaces",
        email="human@local",
        is_authenticated=True,
    )
    assert _openfga_user(invalid_user) is None

    # _openfga_headers with custom host
    monkeypatch.setenv("OPENFGA_HOST_HEADER", "openfga.internal:8080")
    headers = _openfga_headers()
    assert headers["Host"] == "openfga.internal:8080"


@pytest.mark.anyio
async def test_get_openfga_store_id_explicit_and_cache(monkeypatch: pytest.MonkeyPatch):
    """Verify _get_openfga_store_id returns explicit env var or cached store id."""
    from deepeval_eval.api.auth import _OPENFGA_STORE_ID_CACHE, _get_openfga_store_id

    # Explicit env var
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-explicit-99")
    mock_client = AsyncMock()
    store_id = await _get_openfga_store_id(mock_client, "http://openfga:8080")
    assert store_id == "store-explicit-99"

    monkeypatch.delenv("OPENFGA_STORE_ID", raising=False)
    _OPENFGA_STORE_ID_CACHE["http://cached:8080"] = "store-cached-100"
    cached_id = await _get_openfga_store_id(mock_client, "http://cached:8080")
    assert cached_id == "store-cached-100"


@pytest.mark.anyio
async def test_authorize_resources_openfga_error_and_forbidden_cases():
    """Verify authorize_evaluate, authorize_evaluation_access, authorize_question_set_access, authorize_datasource_access, authorize_agent_access."""
    user = UserContext(
        subject="test_sub",
        email="u@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )

    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            return_value=False,
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_object",
            new_callable=AsyncMock,
            return_value=False,
        ),
    ):
        with pytest.raises(HTTPException) as exc1:
            await authorize_evaluate(user)
        assert exc1.value.status_code == 403

        with pytest.raises(HTTPException) as exc2:
            await authorize_evaluation_access(user, "eval-1", scope="manage")
        assert exc2.value.status_code == 403

        with pytest.raises(HTTPException) as exc3:
            await authorize_question_set_access(user, "1", scope="manage")
        assert exc3.value.status_code == 403

        with pytest.raises(HTTPException) as exc4:
            await authorize_datasource_access(user, "ds-1", scope="read")
        assert exc4.value.status_code == 403

        with pytest.raises(HTTPException) as exc5:
            await authorize_agent_access(user, "agent-1", scope="use")
        assert exc5.value.status_code == 403


@pytest.mark.anyio
async def test_authorize_resources_openfga_503_service_unavailable():
    """Verify authorization functions raise 503 when OpenFGA throws unexpected errors."""
    user = UserContext(
        subject="test_sub",
        email="u@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )

    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            side_effect=RuntimeError("OpenFGA down"),
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await authorize_evaluate(user)
        assert exc.value.status_code == 503


@pytest.mark.anyio
async def test_get_allowed_resource_ids_evaluator_role_and_exceptions():
    """Verify get_allowed_resource_ids returns None for evaluator and empty list on exception."""
    evaluator_user = UserContext(
        subject="eval_sub",
        email="eval@example.com",
        role=Role.EVALUATOR,
        is_authenticated=True,
    )
    assert await get_allowed_resource_ids(evaluator_user, "evaluation") is None

    readonly_user = UserContext(
        subject="ro_sub",
        email="ro@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            new_callable=AsyncMock,
            side_effect=RuntimeError("FGA error"),
        ),
    ):
        res = await get_allowed_resource_ids(readonly_user, "evaluation")
        assert res == []


@pytest.mark.anyio
async def test_write_question_set_ownership_success_and_exception():
    """Verify write_question_set_ownership handles writing and exception logging."""
    from deepeval_eval.api.auth import write_question_set_ownership

    user = UserContext(
        subject="creator_sub",
        email="creator@example.com",
        groups=["team-a"],
        is_authenticated=True,
    )

    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples", new_callable=AsyncMock
        ) as mock_write,
    ):
        await write_question_set_ownership(10, "team-a", "public", user)
        mock_write.assert_called_once()

    # Exception path
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples",
            new_callable=AsyncMock,
            side_effect=RuntimeError("Write fail"),
        ),
    ):
        await write_question_set_ownership(10, "team-a", "public", user)


def test_require_permission_guard():
    """Verify RequirePermission dependency allows matching permissions and rejects non-admin."""
    from deepeval_eval.api.auth import RequirePermission

    admin_guard = RequirePermission("admin")
    admin_user = UserContext(
        email="admin@test.com", role=Role.ADMIN, is_authenticated=True
    )
    ro_user = UserContext(
        email="ro@test.com", role=Role.READONLY, is_authenticated=True
    )

    assert admin_guard(admin_user) == admin_user

    with pytest.raises(HTTPException) as exc_info:
        admin_guard(ro_user)
    assert exc_info.value.status_code == 403


def test_authorize_prompt_style_access_scenarios():
    """Verify authorize_prompt_style_access checks visibility and system prompt style protection."""
    from deepeval_eval.api.auth import authorize_prompt_style_access

    admin_user = UserContext(
        email="admin@example.com", role=Role.ADMIN, is_authenticated=True
    )
    ro_user = UserContext(
        subject="user_123",
        email="ro@example.com",
        groups=["ml-team"],
        role=Role.READONLY,
        is_authenticated=True,
    )

    system_style = {"name": "generation", "is_system": True, "visibility": "public"}
    custom_private = {
        "name": "my_private",
        "is_system": False,
        "visibility": "private",
        "owner_id": "user_123",
    }
    custom_team = {
        "name": "my_team",
        "is_system": False,
        "visibility": "team",
        "owner_team": "ml-team",
    }
    forbidden_style = {
        "name": "other_private",
        "is_system": False,
        "visibility": "private",
        "owner_id": "other_999",
    }

    # Admin access allowed on all
    authorize_prompt_style_access(admin_user, forbidden_style, scope="manage")

    # Read system style allowed
    authorize_prompt_style_access(ro_user, system_style, scope="read")

    # Manage system style raises 403
    with pytest.raises(HTTPException) as exc1:
        authorize_prompt_style_access(ro_user, system_style, scope="manage")
    assert exc1.value.status_code == 403

    # Private style matching owner allowed
    authorize_prompt_style_access(ro_user, custom_private, scope="manage")

    # Team style matching user group allowed
    authorize_prompt_style_access(ro_user, custom_team, scope="manage")

    # Forbidden style raises 403
    with pytest.raises(HTTPException) as exc2:
        authorize_prompt_style_access(ro_user, forbidden_style, scope="read")
    assert exc2.value.status_code == 403

    # Bypass enabled
    with patch(
        "deepeval_eval.api.auth.is_unsafe_rbac_bypass_enabled", return_value=True
    ):
        authorize_prompt_style_access(ro_user, forbidden_style, scope="manage")


def test_get_auth_manager_singleton_instance():
    """Verify get_auth_manager initializes and returns singleton AuthManager instance."""
    import deepeval_eval.api.auth as auth_mod
    from deepeval_eval.api.auth import get_auth_manager

    auth_mod._auth_manager = None
    mgr = get_auth_manager()
    assert mgr is not None
    assert get_auth_manager() is mgr


@pytest.mark.anyio
async def test_auth_manager_validate_token_admin_role_and_static_key_mismatch():
    """Verify AuthManager assigns Role.ADMIN when admin role is in realm_roles or user_groups, and raises error on static key mismatch."""
    from jwt.exceptions import PyJWTError as JWTError
    from pydantic import SecretStr

    from deepeval_eval.core.config import AuthSettings

    settings = AuthSettings(
        api_key=SecretStr("valid-secret-api-key"), oidc_issuer_url=""
    )
    mgr = AuthManager(settings=settings)
    mgr.providers.clear()

    with pytest.raises(JWTError, match="Invalid API key"):
        await mgr.validate_token("wrong-key")

    # Admin role mapping via realm_access roles
    settings_oidc = AuthSettings(oidc_issuer_url="http://keycloak.example.com")
    mgr_oidc = AuthManager(settings=settings_oidc)
    mock_provider = AsyncMock()
    mock_provider.validate_token.return_value = {
        "sub": "admin_sub",
        "realm_access": {"roles": ["caipe-admin"]},
    }
    mgr_oidc.providers["default"] = mock_provider
    user = await mgr_oidc.validate_token("admin.token")
    assert user.role == Role.ADMIN


@pytest.mark.anyio
async def test_require_authenticated_user_invalid_token_and_anonymous_dev():
    """Verify require_authenticated_user raises 401 on invalid token and returns anonymous dev user when allowed."""
    from deepeval_eval.api.auth import require_authenticated_user
    from deepeval_eval.core.config import AuthSettings

    auth_mgr = AuthManager(settings=AuthSettings(allow_unauthenticated_access=True))
    auth_mgr.validate_token = AsyncMock(side_effect=RuntimeError("Token expired"))

    # Invalid token provided -> 401
    mock_req_invalid = MagicMock()
    mock_req_invalid.headers = {"Authorization": "Bearer expired_token"}
    with pytest.raises(HTTPException) as exc_info:
        await require_authenticated_user(mock_req_invalid, auth_manager=auth_mgr)
    assert exc_info.value.status_code == 401

    # No token provided with allow_unauthenticated_access -> anonymous local dev
    mock_req_none = MagicMock()
    mock_req_none.headers = {}
    anon_user = await require_authenticated_user(mock_req_none, auth_manager=auth_mgr)
    assert anon_user.subject == "anonymous-local-dev"
    assert anon_user.role == Role.ADMIN


@pytest.mark.anyio
async def test_openfga_network_calls_and_store_lookup(monkeypatch: pytest.MonkeyPatch):
    """Verify _get_openfga_store_id fetches stores from OpenFGA, and _openfga_check_object / _openfga_write_tuples / _openfga_list_objects make HTTP calls."""
    from deepeval_eval.api.auth import (
        _OPENFGA_STORE_ID_CACHE,
        _get_openfga_store_id,
        _openfga_check_object,
        _openfga_list_objects,
        _openfga_write_tuples,
    )

    monkeypatch.delenv("OPENFGA_STORE_ID", raising=False)
    _OPENFGA_STORE_ID_CACHE.clear()

    # 1. _get_openfga_store_id store found vs not found
    mock_client = AsyncMock()
    mock_resp_stores = MagicMock()
    mock_resp_stores.json.return_value = {
        "stores": [{"id": "fga-store-123", "name": "caipe-openfga"}]
    }
    mock_resp_stores.raise_for_status = MagicMock()
    mock_client.get.return_value = mock_resp_stores

    store_id = await _get_openfga_store_id(mock_client, "http://openfga.local:8080")
    assert store_id == "fga-store-123"

    # Store not found
    mock_resp_empty = MagicMock()
    mock_resp_empty.json.return_value = {"stores": []}
    mock_resp_empty.raise_for_status = MagicMock()
    mock_client.get.return_value = mock_resp_empty
    _OPENFGA_STORE_ID_CACHE.clear()
    with pytest.raises(RuntimeError, match="OpenFGA store caipe-openfga was not found"):
        await _get_openfga_store_id(mock_client, "http://openfga.local:8080")

    # 2. _openfga_check_object, _openfga_write_tuples, _openfga_list_objects
    user = UserContext(
        subject="user_123", email="user@example.com", is_authenticated=True
    )
    monkeypatch.setenv("OPENFGA_HTTP", "http://openfga.local:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "fga-store-123")

    mock_check_resp = MagicMock()
    mock_check_resp.json.return_value = {"allowed": True}
    mock_check_resp.raise_for_status = MagicMock()

    mock_list_resp = MagicMock()
    mock_list_resp.json.return_value = {
        "objects": ["evaluation:eval-10", "evaluation:eval-20"]
    }
    mock_list_resp.raise_for_status = MagicMock()

    mock_http_client = AsyncMock()
    mock_http_client.post.side_effect = [mock_check_resp, MagicMock(), mock_list_resp]
    mock_http_client.__aenter__.return_value = mock_http_client

    with patch("httpx.AsyncClient", return_value=mock_http_client):
        # Check
        allowed = await _openfga_check_object(user, "can_read", "evaluation", "eval-10")
        assert allowed is True

        # Write
        await _openfga_write_tuples(
            writes=[{"user": "user:1", "relation": "reader", "object": "evaluation:1"}],
            deletes=[
                {"user": "user:2", "relation": "reader", "object": "evaluation:1"}
            ],
        )

        # List objects
        objects = await _openfga_list_objects(user, "can_read", "evaluation")
        assert objects == ["evaluation:eval-10", "evaluation:eval-20"]


@pytest.mark.anyio
async def test_write_ownership_tuples_without_owner_team():
    """Verify write_evaluation_ownership and write_question_set_ownership set user as owner when no owner_team is provided."""
    from deepeval_eval.api.auth import (
        write_evaluation_ownership,
        write_question_set_ownership,
    )

    user_no_groups = UserContext(
        subject="solo_user", email="solo@example.com", groups=[], is_authenticated=True
    )

    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples", new_callable=AsyncMock
        ) as mock_write,
    ):
        await write_evaluation_ownership("job-solo-1", None, "private", user_no_groups)
        written_tuples = mock_write.call_args[0][0]
        assert {
            "user": "user:solo_user",
            "relation": "owner",
            "object": "evaluation:job-solo-1",
        } in written_tuples

        mock_write.reset_mock()
        await write_question_set_ownership(99, None, "private", user_no_groups)
        written_qs = mock_write.call_args[0][0]
        assert {
            "user": "user:solo_user",
            "relation": "owner",
            "object": "question_set:99",
        } in written_qs


@pytest.mark.anyio
async def test_authorize_resources_admin_and_unrestricted_early_returns():
    """Verify authorize_evaluation_access, authorize_question_set_access, authorize_datasource_access, authorize_agent_access return immediately for admin/unrestricted."""
    admin_user = UserContext(
        email="admin@example.com", role=Role.ADMIN, is_authenticated=True
    )
    ro_user = UserContext(
        email="ro@example.com", role=Role.READONLY, is_authenticated=True
    )

    # Admin user -> no OpenFGA call needed
    await authorize_evaluation_access(admin_user, "eval-1")
    await authorize_question_set_access(admin_user, "1")
    await authorize_datasource_access(admin_user, "ds-1")
    await authorize_agent_access(admin_user, "agent-1")

    # Unrestricted bypass
    with patch(
        "deepeval_eval.api.auth.is_unsafe_rbac_bypass_enabled", return_value=True
    ):
        await authorize_evaluation_access(ro_user, "eval-1")
        await authorize_question_set_access(ro_user, "1")
        await authorize_datasource_access(ro_user, "ds-1")
        await authorize_agent_access(ro_user, "agent-1")


@pytest.mark.anyio
async def test_authorize_endpoints_when_openfga_fails_raises_503() -> None:
    ro_user = UserContext(
        subject="user-1",
        email="ro@example.com",
        role=Role.READONLY,
        is_authenticated=True,
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_check_org_admin",
            side_effect=RuntimeError("OpenFGA unreachable"),
        ),
    ):
        # 1. authorize_evaluate
        with pytest.raises(HTTPException) as exc1:
            await authorize_evaluate(ro_user)
        assert exc1.value.status_code == 503

        # 2. authorize_evaluation_access
        with pytest.raises(HTTPException) as exc2:
            await authorize_evaluation_access(ro_user, "eval-1")
        assert exc2.value.status_code == 503

        # 3. authorize_question_set_access
        with pytest.raises(HTTPException) as exc3:
            await authorize_question_set_access(ro_user, "1")
        assert exc3.value.status_code == 503

        # 4. authorize_datasource_access
        with pytest.raises(HTTPException) as exc4:
            await authorize_datasource_access(ro_user, "ds-1")
        assert exc4.value.status_code == 503

        # 5. authorize_agent_access
        with pytest.raises(HTTPException) as exc5:
            await authorize_agent_access(ro_user, "agent-1")
        assert exc5.value.status_code == 503


@pytest.mark.anyio
async def test_write_ownership_and_visibility_when_openfga_fails_logs_warning() -> None:
    from deepeval_eval.api.auth import (
        ResourceType,
        ResourceVisibility,
        update_resource_visibility,
        write_evaluation_ownership,
        write_question_set_ownership,
    )

    user = UserContext(
        subject="u1", email="u@example.com", groups=["team1"], is_authenticated=True
    )
    with (
        patch(
            "deepeval_eval.api.auth._openfga_http_url",
            return_value="http://openfga:8080",
        ),
        patch(
            "deepeval_eval.api.auth._openfga_write_tuples",
            side_effect=RuntimeError("OpenFGA write failed"),
        ),
    ):
        # All should handle exception gracefully without raising
        await write_evaluation_ownership("job-1", "team1", "private", user)
        await write_question_set_ownership(1, "team1", "private", user)
        await update_resource_visibility(
            ResourceType.EVALUATION, "job-1", ResourceVisibility.PUBLIC, "team1", user
        )


@pytest.mark.anyio
async def test_oidc_provider_validate_token_jwt_error_wrapping() -> None:
    import jwt

    from deepeval_eval.api.auth import JWTError

    provider = OIDCProvider(
        name="test",
        issuer="http://keycloak/realms/caipe",
        audience="caipe-app",
        jwks_url="http://keycloak/certs",
    )
    fake_header = {"kid": "key_1"}
    fake_jwks = {"keys": [{"kid": "key_1", "kty": "RSA"}]}

    mock_pyjwk = MagicMock()
    mock_pyjwk.key = "public_key"
    mock_pyjwk.algorithm_name = "RS256"

    with (
        patch.object(
            provider, "get_jwks", new_callable=AsyncMock, return_value=fake_jwks
        ),
        patch("jwt.get_unverified_header", return_value=fake_header),
        patch("jwt.PyJWK.from_dict", return_value=mock_pyjwk),
        patch(
            "jwt.decode", side_effect=jwt.DecodeError("Signature verification failed")
        ),
    ):
        with pytest.raises(JWTError, match="JWT validation failed"):
            await provider.validate_token("invalid.token")


def test_sync_authorize_evaluate_subject_admin_role_returns_true() -> None:
    """Verify sync_authorize_evaluate_subject returns True when role is ADMIN."""
    from deepeval_eval.api.auth import Role, sync_authorize_evaluate_subject

    assert sync_authorize_evaluate_subject("admin-user-sub", role=Role.ADMIN) is True


def test_sync_authorize_evaluate_subject_bypass_enabled_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_evaluate_subject returns True when bypass flag is active."""
    from deepeval_eval.api.auth import sync_authorize_evaluate_subject

    monkeypatch.setenv("CAIPE_UNSAFE_RBAC_BYPASS", "true")
    assert sync_authorize_evaluate_subject("user-sub-123") is True


def test_sync_authorize_evaluate_subject_openfga_allowed_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_evaluate_subject returns True when OpenFGA check passes."""
    from deepeval_eval.api.auth import sync_authorize_evaluate_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch("deepeval_eval.api.auth.sync_openfga_check_object", return_value=True):
        assert sync_authorize_evaluate_subject("alice-sub") is True


def test_sync_authorize_evaluate_subject_openfga_denied_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_evaluate_subject returns False when OpenFGA check fails."""
    from deepeval_eval.api.auth import sync_authorize_evaluate_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch("deepeval_eval.api.auth.sync_openfga_check_object", return_value=False):
        assert sync_authorize_evaluate_subject("alice-sub") is False


def test_sync_authorize_agent_subject_when_admin_role_returns_true() -> None:
    """Verify sync_authorize_agent_subject returns True when role is ADMIN."""
    from deepeval_eval.api.auth import Role, sync_authorize_agent_subject

    assert (
        sync_authorize_agent_subject("admin-user-sub", "agent-123", role=Role.ADMIN)
        is True
    )


def test_sync_authorize_agent_subject_when_bypass_enabled_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_agent_subject returns True when bypass flag is active."""
    from deepeval_eval.api.auth import sync_authorize_agent_subject

    monkeypatch.setenv("CAIPE_UNSAFE_RBAC_BYPASS", "true")
    assert sync_authorize_agent_subject("user-sub-123", "agent-123") is True


def test_sync_authorize_agent_subject_when_openfga_allowed_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_agent_subject returns True when OpenFGA check passes."""
    from deepeval_eval.api.auth import sync_authorize_agent_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch("deepeval_eval.api.auth.sync_openfga_check_object", return_value=True):
        assert sync_authorize_agent_subject("alice-sub", "agent-123") is True


def test_sync_authorize_agent_subject_when_openfga_denied_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_agent_subject returns False when OpenFGA check denies."""
    from deepeval_eval.api.auth import sync_authorize_agent_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch("deepeval_eval.api.auth.sync_openfga_check_object", return_value=False):
        assert sync_authorize_agent_subject("alice-sub", "agent-123") is False


def test_sync_authorize_agent_subject_when_openfga_fails_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_agent_subject returns False when OpenFGA throws error."""
    from deepeval_eval.api.auth import sync_authorize_agent_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch(
        "deepeval_eval.api.auth.sync_openfga_check_object",
        side_effect=RuntimeError("connection error"),
    ):
        assert sync_authorize_agent_subject("alice-sub", "agent-123") is False


def test_sync_authorize_datasource_subject_when_admin_role_returns_true() -> None:
    """Verify sync_authorize_datasource_subject returns True when role is ADMIN."""
    from deepeval_eval.api.auth import Role, sync_authorize_datasource_subject

    assert (
        sync_authorize_datasource_subject("admin-user-sub", "ds-123", role=Role.ADMIN)
        is True
    )


def test_sync_authorize_datasource_subject_when_bypass_enabled_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_datasource_subject returns True when bypass flag is active."""
    from deepeval_eval.api.auth import sync_authorize_datasource_subject

    monkeypatch.setenv("CAIPE_UNSAFE_RBAC_BYPASS", "true")
    assert sync_authorize_datasource_subject("user-sub-123", "ds-123") is True


def test_sync_authorize_datasource_subject_when_openfga_allowed_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_datasource_subject returns True when OpenFGA check passes."""
    from deepeval_eval.api.auth import sync_authorize_datasource_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch("deepeval_eval.api.auth.sync_openfga_check_object", return_value=True):
        assert sync_authorize_datasource_subject("alice-sub", "ds-123") is True


def test_sync_authorize_datasource_subject_when_openfga_denied_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_datasource_subject returns False when OpenFGA check denies."""
    from deepeval_eval.api.auth import sync_authorize_datasource_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch("deepeval_eval.api.auth.sync_openfga_check_object", return_value=False):
        assert sync_authorize_datasource_subject("alice-sub", "ds-123") is False


def test_sync_authorize_datasource_subject_when_openfga_fails_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_datasource_subject returns False when OpenFGA throws error."""
    from deepeval_eval.api.auth import sync_authorize_datasource_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch(
        "deepeval_eval.api.auth.sync_openfga_check_object",
        side_effect=RuntimeError("connection error"),
    ):
        assert sync_authorize_datasource_subject("alice-sub", "ds-123") is False


def test_sync_authorize_question_set_subject_when_admin_role_returns_true() -> None:
    """Verify sync_authorize_question_set_subject returns True when role is ADMIN."""
    from deepeval_eval.api.auth import Role, sync_authorize_question_set_subject

    assert (
        sync_authorize_question_set_subject("admin-user-sub", 101, role=Role.ADMIN)
        is True
    )


def test_sync_authorize_question_set_subject_when_bypass_enabled_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_question_set_subject returns True when bypass flag is active."""
    from deepeval_eval.api.auth import sync_authorize_question_set_subject

    monkeypatch.setenv("CAIPE_UNSAFE_RBAC_BYPASS", "true")
    assert sync_authorize_question_set_subject("user-sub-123", 101) is True


def test_sync_authorize_question_set_subject_when_openfga_allowed_returns_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_question_set_subject returns True when OpenFGA check passes."""
    from deepeval_eval.api.auth import sync_authorize_question_set_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch("deepeval_eval.api.auth.sync_openfga_check_object", return_value=True):
        assert sync_authorize_question_set_subject("alice-sub", 101) is True


def test_sync_authorize_question_set_subject_when_openfga_denied_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_question_set_subject returns False when OpenFGA check denies."""
    from deepeval_eval.api.auth import sync_authorize_question_set_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch("deepeval_eval.api.auth.sync_openfga_check_object", return_value=False):
        assert sync_authorize_question_set_subject("alice-sub", 101) is False


def test_sync_authorize_question_set_subject_when_openfga_fails_returns_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify sync_authorize_question_set_subject returns False when OpenFGA throws error."""
    from deepeval_eval.api.auth import sync_authorize_question_set_subject

    monkeypatch.setenv("OPENFGA_HTTP_URL", "http://localhost:8080")
    monkeypatch.setenv("OPENFGA_STORE_ID", "store-123")

    with patch(
        "deepeval_eval.api.auth.sync_openfga_check_object",
        side_effect=RuntimeError("connection error"),
    ):
        assert sync_authorize_question_set_subject("alice-sub", 101) is False
