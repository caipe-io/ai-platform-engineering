from __future__ import annotations

import inspect
import math
import re
import string
from typing import Any

import deepeval.metrics
from deepeval.metrics import (
    AnswerRelevancyMetric,
    BaseMetric,
    ContextualPrecisionMetric,
    ContextualRecallMetric,
    ContextualRelevancyMetric,
    FaithfulnessMetric,
    GEval,
)
from deepeval.test_case import LLMTestCase, SingleTurnParams
from pydantic.alias_generators import to_snake


def get_metric_column_name(metric_name: str) -> str:
    """Dynamically convert a metric class name or key into its snake_case column header."""
    s = metric_name.removesuffix("Metric")
    return to_snake(s)


# Keep metric construction in one place so both benchmark pipelines are judged
# with the same DeepEval settings.
def build_metrics(judge_model: Any) -> list[Any]:
    if judge_model is None:
        raise ValueError("judge_model must not be None")

    common = {
        "threshold": 0.5,
        "model": judge_model,
        "include_reason": True,
        "async_mode": False,
    }

    return [
        AnswerRelevancyMetric(**common),
        FaithfulnessMetric(**common),
        AnswerCorrectnessMetric(**common),
        ContextualRelevancyMetric(**common),
        ContextualPrecisionMetric(**common),
        ContextualRecallMetric(**common),
        MRRMetric(**common),
        NDCGAtKMetric(**common),
        RetrievalRecallMetric(**common),
        RetrievalPrecisionMetric(**common),
        NormalizedExactMatchMetric(**common),
        ContainsReferenceMetric(**common),
    ]


def doc_id_scores(
    retrieved: list[dict[str, Any]], expected_doc_ids: list[str]
) -> tuple[float, float]:
    retrieved_ids = {
        str(item.get("document_id"))
        for item in retrieved
        if item.get("document_id") is not None
    }
    expected = {str(doc_id) for doc_id in expected_doc_ids}
    if not expected:
        return 0.0, 0.0
    hits = retrieved_ids & expected
    recall = len(hits) / len(expected)
    precision = len(hits) / len(retrieved_ids) if retrieved_ids else 0.0
    return recall, precision


def normalize_answer(text: str) -> str:
    lowered = text.lower()
    no_punc = "".join(ch for ch in lowered if ch not in string.punctuation)
    no_articles = re.sub(r"\b(a|an|the)\b", " ", no_punc)
    return " ".join(no_articles.split())


def answer_scores(answer: str, reference: str) -> tuple[float, float]:
    answer_norm = normalize_answer(answer)
    ref_norm = normalize_answer(reference)
    if not ref_norm:
        return 0.0, 0.0
    return (
        1.0 if answer_norm == ref_norm else 0.0,
        1.0 if ref_norm in answer_norm else 0.0,
    )


class NormalizedExactMatchMetric(BaseMetric):
    """
    Normalized Exact Match Metric for DeepEval.
    Evaluates whether normalized actual output matches normalized expected output.
    """

    def __init__(
        self, name: str = "NormalizedExactMatchMetric", threshold: float = 0.5, **kwargs
    ):
        self.name = name
        self.threshold = threshold
        self.score: float | None = 0.0
        self.reason: str | None = None
        self.success: bool | None = None

    def measure(self, test_case: LLMTestCase, *args: Any, **kwargs: Any) -> float:
        actual = test_case.actual_output or ""
        expected = test_case.expected_output or ""
        exact, _ = answer_scores(actual, expected)
        self.score = exact
        self.reason = f"Exact match score: {self.score:.4f}"
        self.success = self.score >= self.threshold
        return self.score

    def get_reason(self) -> str:
        return self.reason or f"Exact match score: {(self.score or 0.0):.4f}"

    def is_successful(self) -> bool:
        return bool(
            self.success
            if self.success is not None
            else (self.score is not None and self.score >= self.threshold)
        )


class ContainsReferenceMetric(BaseMetric):
    """
    Contains Reference Metric for DeepEval.
    Evaluates whether normalized expected output (reference) is contained within actual output.
    """

    def __init__(
        self, name: str = "ContainsReferenceMetric", threshold: float = 0.5, **kwargs
    ):
        self.name = name
        self.threshold = threshold
        self.score: float | None = 0.0
        self.reason: str | None = None
        self.success: bool | None = None

    def measure(self, test_case: LLMTestCase, *args: Any, **kwargs: Any) -> float:
        actual = test_case.actual_output or ""
        expected = test_case.expected_output or ""
        _, contains = answer_scores(actual, expected)
        self.score = contains
        self.reason = f"Contains reference score: {self.score:.4f}"
        self.success = self.score >= self.threshold
        return self.score

    def get_reason(self) -> str:
        return self.reason or f"Contains reference score: {(self.score or 0.0):.4f}"

    def is_successful(self) -> bool:
        return bool(
            self.success
            if self.success is not None
            else (self.score is not None and self.score >= self.threshold)
        )


class AnswerCorrectnessMetric(BaseMetric):
    """
    Answer Correctness Metric wrapping DeepEval's GEval framework.
    Evaluates generated output factual alignment against the ground truth reference.
    """

    def __init__(
        self,
        name: str = "AnswerCorrectnessMetric",
        model: Any = None,
        threshold: float = 0.5,
        **kwargs,
    ):
        self.name = name
        self.threshold = threshold

        self.geval_judge = GEval(
            name=name,
            model=model,
            threshold=threshold,
            verbose_mode=kwargs.get("verbose_mode", False),
            async_mode=kwargs.get("async_mode", False),
            evaluation_params=[
                SingleTurnParams.ACTUAL_OUTPUT,
                SingleTurnParams.EXPECTED_OUTPUT,
            ],
            evaluation_steps=[
                "Compare the actual output directly with the expected output to verify factual accuracy.",
                "Check if all elements mentioned in the expected output are present and correctly represented in the actual output.",
                "Assess if there are any discrepancies in details, values, or information between the actual and expected outputs.",
            ],
        )
        self.score: float | None = 0.0
        self.reason: str | None = ""
        self.success: bool | None = False

    def measure(self, test_case: LLMTestCase, *args: Any, **kwargs: Any) -> float:
        self.score = self.geval_judge.measure(test_case)
        self.success = self.geval_judge.is_successful()
        self.reason = self.geval_judge.reason
        return self.score

    def get_reason(self) -> str:
        return self.reason or ""

    def is_successful(self) -> bool:
        return bool(self.success)


class MRRMetric(BaseMetric):
    """
    Mean Reciprocal Rank (MRR) for DeepEval retrieval evaluation.
    Calculates 1.0 / rank of the first matching ground-truth document ID.
    """

    def __init__(self, name: str = "MRR", threshold: float = 0.5, **kwargs):
        self.name = name
        self.threshold = threshold
        self.score: float | None = 0.0
        self.reason: str | None = None
        self.success: bool | None = None

    def measure(self, test_case: LLMTestCase, *args: Any, **kwargs: Any) -> float:
        metadata = test_case.metadata or {}
        retrieved_ids = [str(d) for d in metadata.get("retrieved_doc_ids", [])]
        expected_ids = set(str(d) for d in metadata.get("expected_doc_ids", []))

        if not expected_ids or not retrieved_ids:
            self.score = 0.0
            self.reason = f"Deterministic MRR ranking quality score: {self.score:.4f}"
            self.success = self.score >= self.threshold
            return self.score

        for rank, doc_id in enumerate(retrieved_ids, start=1):
            if doc_id in expected_ids:
                self.score = 1.0 / rank
                self.reason = (
                    f"Deterministic MRR ranking quality score: {self.score:.4f}"
                )
                self.success = self.score >= self.threshold
                return self.score

        self.score = 0.0
        self.reason = f"Deterministic MRR ranking quality score: {self.score:.4f}"
        self.success = self.score >= self.threshold
        return self.score

    def get_reason(self) -> str:
        return (
            self.reason
            or f"Deterministic MRR ranking quality score: {(self.score or 0.0):.4f}"
        )

    def is_successful(self) -> bool:
        return bool(
            self.success
            if self.success is not None
            else (self.score is not None and self.score >= self.threshold)
        )


class NDCGAtKMetric(BaseMetric):
    """
    Normalized Discounted Cumulative Gain at k (nDCG@k) for DeepEval.
    Evaluates positional weighting distributions for multi-document retrieval.
    """

    def __init__(
        self, name: str = "nDCG@k", k: int = 5, threshold: float = 0.5, **kwargs
    ):
        self.name = name
        self.k = k
        self.threshold = threshold
        self.score: float | None = 0.0
        self.reason: str | None = None
        self.success: bool | None = None

    def measure(self, test_case: LLMTestCase, *args: Any, **kwargs: Any) -> float:
        metadata = test_case.metadata or {}
        retrieved_ids = [str(d) for d in metadata.get("retrieved_doc_ids", [])]
        expected_ids = set(str(d) for d in metadata.get("expected_doc_ids", []))

        if not expected_ids or not retrieved_ids:
            self.score = 0.0
            self.reason = (
                f"Deterministic nDCG@{self.k} ranking quality score: {self.score:.4f}"
            )
            self.success = self.score >= self.threshold
            return self.score

        top_k = metadata.get("top_k") or metadata.get("k") or self.k
        effective_k = max(len(retrieved_ids), top_k)
        retrieved_k = retrieved_ids[:effective_k]
        dcg = sum(
            (1.0 / math.log2(i + 2))
            for i, doc_id in enumerate(retrieved_k)
            if doc_id in expected_ids
        )
        if math.isclose(dcg, 0.0):
            self.score = 0.0
            self.reason = f"Deterministic nDCG@{effective_k} ranking quality score: {self.score:.4f}"
            self.success = self.score >= self.threshold
            return self.score

        ideal_hits = min(len(expected_ids), effective_k)
        idcg = sum((1.0 / math.log2(i + 2)) for i in range(ideal_hits))
        self.score = dcg / idcg if idcg > 0.0 else 0.0
        self.reason = (
            f"Deterministic nDCG@{effective_k} ranking quality score: {self.score:.4f}"
        )
        self.success = self.score >= self.threshold
        return self.score

    def get_reason(self) -> str:
        return (
            self.reason
            or f"Deterministic nDCG@{self.k} ranking quality score: {(self.score or 0.0):.4f}"
        )

    def is_successful(self) -> bool:
        return bool(
            self.success
            if self.success is not None
            else (self.score is not None and self.score >= self.threshold)
        )


class RetrievalRecallMetric(BaseMetric):
    """
    Deterministic Document ID Recall metric for DeepEval retrieval evaluation.
    Calculates proportion of ground-truth document IDs found in retrieved documents.
    """

    def __init__(
        self, name: str = "RetrievalRecallMetric", threshold: float = 0.5, **kwargs
    ):
        self.name = name
        self.threshold = threshold
        self.score: float | None = 0.0
        self.reason: str | None = None
        self.success: bool | None = None

    def measure(self, test_case: LLMTestCase, *args: Any, **kwargs: Any) -> float:
        metadata = test_case.metadata or {}
        retrieved_ids = {str(d) for d in metadata.get("retrieved_doc_ids", [])}
        expected_ids = {str(d) for d in metadata.get("expected_doc_ids", [])}

        if not expected_ids:
            self.score = 0.0
        else:
            hits = retrieved_ids & expected_ids
            self.score = len(hits) / len(expected_ids)

        self.reason = f"Deterministic document recall score: {self.score:.4f}"
        self.success = self.score >= self.threshold
        return self.score

    def get_reason(self) -> str:
        return (
            self.reason
            or f"Deterministic document recall score: {(self.score or 0.0):.4f}"
        )

    def is_successful(self) -> bool:
        return bool(
            self.success
            if self.success is not None
            else (self.score is not None and self.score >= self.threshold)
        )


class RetrievalPrecisionMetric(BaseMetric):
    """
    Deterministic Document ID Precision metric for DeepEval retrieval evaluation.
    Calculates proportion of retrieved documents that match ground-truth document IDs.
    """

    def __init__(
        self, name: str = "RetrievalPrecisionMetric", threshold: float = 0.5, **kwargs
    ):
        self.name = name
        self.threshold = threshold
        self.score: float | None = 0.0
        self.reason: str | None = None
        self.success: bool | None = None

    def measure(self, test_case: LLMTestCase, *args: Any, **kwargs: Any) -> float:
        metadata = test_case.metadata or {}
        retrieved_ids = {str(d) for d in metadata.get("retrieved_doc_ids", [])}
        expected_ids = {str(d) for d in metadata.get("expected_doc_ids", [])}

        if not retrieved_ids or not expected_ids:
            self.score = 0.0
        else:
            hits = retrieved_ids & expected_ids
            self.score = len(hits) / len(retrieved_ids)

        self.reason = f"Deterministic document precision score: {self.score:.4f}"
        self.success = self.score >= self.threshold
        return self.score

    def get_reason(self) -> str:
        return (
            self.reason
            or f"Deterministic document precision score: {(self.score or 0.0):.4f}"
        )

    def is_successful(self) -> bool:
        return bool(
            self.success
            if self.success is not None
            else (self.score is not None and self.score >= self.threshold)
        )


# ---------------------------------------------------------------------------
# Central Metric Registries & Metadata Catalog
# ---------------------------------------------------------------------------

# Base static registry containing repo-level custom code metrics and core mappings
BUILTIN_METRICS_REGISTRY: dict[str, type[BaseMetric]] = {
    "answer_relevancy": AnswerRelevancyMetric,
    "faithfulness": FaithfulnessMetric,
    "contextual_precision": ContextualPrecisionMetric,
    "contextual_recall": ContextualRecallMetric,
    "contextual_relevancy": ContextualRelevancyMetric,
    "answer_correctness": AnswerCorrectnessMetric,
    "mrr": MRRMetric,
    "ndcg_at_k": NDCGAtKMetric,
    "retrieval_recall": RetrievalRecallMetric,
    "retrieval_precision": RetrievalPrecisionMetric,
    "normalized_exact_match": NormalizedExactMatchMetric,
    "contains_reference": ContainsReferenceMetric,
}

# Dynamically populate all BaseMetric subclasses from deepeval.metrics
for _member_name, _member_obj in inspect.getmembers(deepeval.metrics):
    if (
        inspect.isclass(_member_obj)
        and issubclass(_member_obj, BaseMetric)
        and _member_obj is not BaseMetric
    ):
        _slug = to_snake(_member_name.removesuffix("Metric"))
        # Prefer existing registration if already present (e.g. custom wrapper or canonical name)
        if _slug not in BUILTIN_METRICS_REGISTRY:
            BUILTIN_METRICS_REGISTRY[_slug] = _member_obj

PARAM_NAME_TO_SINGLE_TURN_PARAM = {
    "input": SingleTurnParams.INPUT,
    "actual_output": SingleTurnParams.ACTUAL_OUTPUT,
    "expected_output": SingleTurnParams.EXPECTED_OUTPUT,
    "context": SingleTurnParams.CONTEXT,
    "retrieval_context": SingleTurnParams.RETRIEVAL_CONTEXT,
}


def list_builtin_metric_metadata() -> list[dict[str, Any]]:
    """Return catalog metadata for all registered built-in and custom code metrics."""
    catalog: list[dict[str, Any]] = []

    # Custom descriptions/display names for key metrics
    descriptions = {
        "answer_relevancy": "Evaluates how relevant the generated answer is to the user question.",
        "faithfulness": "Evaluates whether the actual output is strictly grounded in retrieved contexts without hallucinations.",
        "contextual_precision": "Evaluates if relevant retrieval chunks are ranked higher in the retrieved context.",
        "contextual_recall": "Evaluates if the retrieved context covers all ground truth expected information.",
        "contextual_relevancy": "Evaluates whether all retrieved context passages are relevant to the question.",
        "answer_correctness": "Evaluates generated answer factual accuracy directly against the golden reference.",
        "mrr": "Calculates the reciprocal rank of the first relevant retrieved document.",
        "ndcg_at_k": "Measures ranking quality penalized logarithmically by hit position.",
        "retrieval_recall": "Proportion of expected document IDs retrieved.",
        "retrieval_precision": "Proportion of retrieved document IDs that match expected ground truth.",
        "normalized_exact_match": "Deterministic string match after normalizing punctuation and case.",
        "contains_reference": "Evaluates whether normalized reference is contained within actual output.",
    }

    custom_code_slugs = {
        "mrr",
        "ndcg_at_k",
        "retrieval_recall",
        "retrieval_precision",
        "normalized_exact_match",
        "contains_reference",
    }

    for slug, cls in BUILTIN_METRICS_REGISTRY.items():
        cls_name = cls.__name__
        display_name = re.sub(
            r"([a-z])([A-Z])", r"\1 \2", cls_name.removesuffix("Metric")
        ).strip()
        if slug in custom_code_slugs:
            metric_type = "custom_code"
        elif slug == "answer_correctness":
            metric_type = "g_eval"
        else:
            metric_type = "builtin"

        sig = inspect.signature(cls.__init__)
        has_judge = "model" in sig.parameters

        default_threshold = 0.5
        if (
            "threshold" in sig.parameters
            and sig.parameters["threshold"].default is not inspect.Parameter.empty
        ):
            try:
                default_threshold = float(sig.parameters["threshold"].default)
            except Exception:
                default_threshold = 0.5

        doc = ""
        if cls.__doc__:
            doc = cls.__doc__.strip().splitlines()[0].strip()

        desc = descriptions.get(slug) or doc or f"Evaluates {display_name} quality."

        catalog.append(
            {
                "name": slug,
                "display_name": display_name,
                "description": desc,
                "metric_type": metric_type,
                "metric_class": cls_name,
                "default_threshold": default_threshold,
                "requires_llm_judge": has_judge,
            }
        )

    return catalog


def build_metric_instance(metric_cfg: dict[str, Any], judge_model: Any) -> BaseMetric:
    """Instantiate a metric object dynamically from its configuration dictionary."""
    metric_type = metric_cfg.get("metric_type", "builtin")
    name = metric_cfg.get("name", "unknown_metric")
    threshold = float(metric_cfg.get("threshold", 0.5))
    parameters = dict(metric_cfg.get("parameters") or {})

    if metric_type in ("builtin", "custom_code"):
        cls = BUILTIN_METRICS_REGISTRY.get(name)
        if not cls:
            metric_class_name = metric_cfg.get("metric_class")
            if metric_class_name:
                for reg_cls in BUILTIN_METRICS_REGISTRY.values():
                    if reg_cls.__name__ == metric_class_name:
                        cls = reg_cls
                        break
        if not cls:
            raise ValueError(f"Unknown code-backed metric '{name}'.")

        # Check constructor parameters and pass matching kwargs
        sig = inspect.signature(cls.__init__)
        has_varkw = any(
            p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
        )

        kwargs: dict[str, Any] = {
            "threshold": threshold,
            **parameters,
        }
        if "include_reason" in sig.parameters or has_varkw:
            kwargs["include_reason"] = parameters.get("include_reason", True)
        if "async_mode" in sig.parameters or has_varkw:
            kwargs["async_mode"] = parameters.get("async_mode", False)
        if "model" in sig.parameters or has_varkw:
            kwargs["model"] = judge_model

        if not has_varkw:
            # Filter kwargs strictly to accepted parameters
            kwargs = {k: v for k, v in kwargs.items() if k in sig.parameters}

        return cls(**kwargs)

    elif metric_type == "g_eval":
        eval_params_raw = metric_cfg.get("evaluation_params") or [
            "input",
            "actual_output",
        ]
        eval_params = [
            PARAM_NAME_TO_SINGLE_TURN_PARAM[p.lower()]
            for p in eval_params_raw
            if p.lower() in PARAM_NAME_TO_SINGLE_TURN_PARAM
        ]
        if not eval_params:
            eval_params = [
                SingleTurnParams.INPUT,
                SingleTurnParams.ACTUAL_OUTPUT,
            ]

        criteria = metric_cfg.get("criteria")
        evaluation_steps = metric_cfg.get("evaluation_steps") or None

        return GEval(
            name=name,
            criteria=criteria,
            evaluation_steps=evaluation_steps,
            evaluation_params=eval_params,
            threshold=threshold,
            model=judge_model,
            async_mode=parameters.get("async_mode", False),
            verbose_mode=parameters.get("verbose_mode", False),
        )

    raise ValueError(f"Unsupported metric type '{metric_type}' for metric '{name}'.")


def build_metrics_from_config(
    metric_names: list[str] | None = None,
    metric_set_name: str | None = None,
    judge_model: Any = None,
    db: Any = None,
) -> list[Any]:
    """Build evaluation metrics dynamically from metric names, metric sets, or defaults."""
    if judge_model is None:
        raise ValueError("judge_model must not be None")

    if not metric_names and not metric_set_name:
        return build_metrics(judge_model)

    configs_to_build: list[dict[str, Any]] = []

    # If metric set is specified, resolve its metrics from database
    if metric_set_name:
        if db is not None and hasattr(db, "metrics") and db.is_postgres():
            set_rec = db.metrics.get_metric_set_with_metrics(metric_set_name)
            if set_rec and set_rec.get("metrics"):
                for m_item in set_rec["metrics"]:
                    configs_to_build.append(m_item)
        if not configs_to_build:
            # Fallback for common default sets if DB is not reachable
            if metric_set_name == "retrieval_fast":
                metric_names = [
                    "mrr",
                    "ndcg_at_k",
                    "retrieval_recall",
                    "retrieval_precision",
                    "normalized_exact_match",
                ]
            elif metric_set_name == "rag_core":
                metric_names = [
                    "faithfulness",
                    "answer_relevancy",
                    "answer_correctness",
                    "contextual_precision",
                    "contextual_recall",
                ]
            else:
                metric_names = metric_names or []

    if metric_names:
        for m_name in metric_names:
            clean_name = m_name.strip().lower()
            if db is not None and hasattr(db, "metrics") and db.is_postgres():
                rec = db.metrics.get_metric(clean_name)
                if rec:
                    configs_to_build.append(rec)
                    continue

            # Fallback to catalog defaults
            if clean_name in BUILTIN_METRICS_REGISTRY:
                meta = next(
                    (
                        m
                        for m in list_builtin_metric_metadata()
                        if m["name"] == clean_name
                    ),
                    None,
                )
                configs_to_build.append(
                    {
                        "name": clean_name,
                        "metric_type": meta["metric_type"] if meta else "builtin",
                        "threshold": meta["default_threshold"] if meta else 0.5,
                        "parameters": {},
                    }
                )

    instances: list[Any] = []
    for cfg in configs_to_build:
        try:
            instances.append(build_metric_instance(cfg, judge_model))
        except Exception:
            continue

    return instances if instances else build_metrics(judge_model)
