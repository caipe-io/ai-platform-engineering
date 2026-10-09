from deepeval_eval.datasets.base import BaseDatasetIngestor, DatasetBundle
from deepeval_eval.datasets.enterprise import EnterpriseDatasetIngestor
from deepeval_eval.datasets.hotpotqa import HotpotQADatasetIngestor
from deepeval_eval.datasets.loader import (
    BaseDataLoader,
    DatabaseDataLoader,
    FileDataLoader,
    InMemoryDataLoader,
    QuestionSetDataLoader,
)

DATASET_INGESTORS: dict[str, type[BaseDatasetIngestor]] = {
    "enterprise": EnterpriseDatasetIngestor,
    "enterprise_rag_bench": EnterpriseDatasetIngestor,
    "hotpotqa": HotpotQADatasetIngestor,
}


def get_dataset_ingestor(dataset_name: str) -> BaseDatasetIngestor:
    """Dynamically look up and instantiate dataset ingestor by name."""
    key = dataset_name.lower().strip()
    if key not in DATASET_INGESTORS:
        supported = ", ".join(sorted(set(DATASET_INGESTORS.keys())))
        raise ValueError(
            f"Unsupported dataset for ingestion: {dataset_name}. Supported datasets: {supported}"
        )
    return DATASET_INGESTORS[key]()


__all__ = [
    "BaseDataLoader",
    "BaseDatasetIngestor",
    "DATASET_INGESTORS",
    "DatabaseDataLoader",
    "DatasetBundle",
    "EnterpriseDatasetIngestor",
    "FileDataLoader",
    "HotpotQADatasetIngestor",
    "InMemoryDataLoader",
    "QuestionSetDataLoader",
    "get_dataset_ingestor",
]
