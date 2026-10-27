"""Harness discovery, capability negotiation, and draft compilation."""

from __future__ import annotations

import hashlib
import json

from harness_engine.adapters.base import HarnessAdapter
from harness_engine.models import (
    AgentBlueprint,
    CapabilityLevel,
    CapabilityResult,
    HarnessDraftValidation,
    HarnessProfile,
    ValidationIssue,
)


class HarnessNotFoundError(KeyError):
    """A blueprint selected an unknown harness."""


class HarnessRegistry:
    def __init__(self, adapters: list[HarnessAdapter]) -> None:
        self._adapters = {adapter.descriptor.id: adapter for adapter in adapters}
        if len(self._adapters) != len(adapters):
            raise ValueError("Harness IDs must be unique")
        mismatched = [
            adapter.descriptor.id
            for adapter in adapters
            if adapter.session_manager.harness_id != adapter.descriptor.id
        ]
        if mismatched:
            raise ValueError(
                f"Provider session manager harness ID mismatch: {', '.join(mismatched)}"
            )

    @property
    def catalog_revision(self) -> str:
        payload = [
            descriptor.model_dump(mode="json")
            for descriptor in sorted(
                (adapter.descriptor for adapter in self._adapters.values()), key=lambda item: item.id
            )
        ]
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()

    def catalog(self) -> list[object]:
        return [self._adapters[key].descriptor for key in sorted(self._adapters)]

    def adapter(self, harness_id: str) -> HarnessAdapter:
        try:
            return self._adapters[harness_id]
        except KeyError as exc:
            raise HarnessNotFoundError(harness_id) from exc

    def profile(self, harness_id: str, profile_id: str) -> HarnessProfile | None:
        return next(
            (
                profile
                for profile in self.adapter(harness_id).descriptor.profiles
                if profile.id == profile_id
            ),
            None,
        )

    @staticmethod
    def _capability_issue(
        capability: str,
        path: str,
        required: bool,
        capabilities: dict[str, CapabilityResult],
    ) -> ValidationIssue | None:
        if not required:
            return None
        result = capabilities.get(capability)
        if result is None:
            return ValidationIssue(
                path=path,
                capability=capability,
                level=CapabilityLevel.UNAVAILABLE,
                severity="error",
                message=f"The harness does not declare {capability}",
            )
        if result.level not in {CapabilityLevel.UNSUPPORTED, CapabilityLevel.UNAVAILABLE}:
            return None
        return ValidationIssue(
            path=path,
            capability=capability,
            level=result.level,
            severity="error",
            message=result.explanation or f"{capability} is not available",
            constraints=result.constraints,
        )

    def validate(
        self, blueprint: AgentBlueprint, requested_catalog_revision: str | None = None
    ) -> HarnessDraftValidation:
        adapter = self.adapter(blueprint.harness.id)
        descriptor = adapter.descriptor
        issues: list[ValidationIssue] = []
        if requested_catalog_revision and requested_catalog_revision != self.catalog_revision:
            issues.append(
                ValidationIssue(
                    path="catalog_revision",
                    capability="catalog",
                    level=CapabilityLevel.UNAVAILABLE,
                    severity="error",
                    message="Harness catalog changed; refresh before saving",
                )
            )
        profile = self.profile(descriptor.id, blueprint.harness.profile_id)
        if profile is None or not profile.available:
            issues.append(
                ValidationIssue(
                    path="harness.profile_id",
                    capability="profile",
                    level=CapabilityLevel.UNAVAILABLE,
                    severity="error",
                    message="The selected operator profile is unavailable",
                )
            )

        evaluation = adapter.evaluate(blueprint)
        normalized = blueprint.model_copy(
            update={
                "harness": blueprint.harness.model_copy(
                    update={"options": evaluation.normalized_options}
                )
            }
        )
        issues.extend(evaluation.issues)
        requirements = (
            ("thread.persistence", "thread.persistence", normalized.thread.persistence == "durable"),
            ("memory.long_term", "memory", normalized.memory.enabled),
            ("tools.broker", "tools.bindings", bool(normalized.tools.bindings)),
            (
                "sandbox.workspace",
                "workspace.persistence",
                normalized.workspace.persistence != "none",
            ),
            (
                "multi_agent.delegation",
                "delegation.agents",
                bool(normalized.delegation.agents),
            ),
            ("stream.replay", "streaming.replay", normalized.streaming.replay == "required"),
        )
        for capability, path, required in requirements:
            issue = self._capability_issue(capability, path, required, descriptor.capabilities)
            if issue:
                issues.append(issue)

        encoded = json.dumps(
            normalized.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
        ).encode()
        return HarnessDraftValidation(
            valid=not any(issue.severity == "error" for issue in issues),
            catalog_revision=self.catalog_revision,
            config_fingerprint=hashlib.sha256(encoded).hexdigest(),
            normalized_blueprint=normalized,
            issues=issues,
            capabilities=descriptor.capabilities,
        )
