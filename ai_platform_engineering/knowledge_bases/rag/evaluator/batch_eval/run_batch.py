import json
from pathlib import Path

from deepeval_eval.engine.eval_engine import EvalConfig, run_evaluation

CONFIGS_FILE = Path(__file__).resolve().parent / "batch_configs.json"

with open(CONFIGS_FILE) as f:
    configs = json.load(f)

for cfg in configs:
    print(f"\n=== Running config: {cfg['name']} ===")
    eval_config = EvalConfig(
        dataset_name="hotpotqa",
        oracle_testing=True,
        max_items=14,
        max_context_chars=int(cfg["max_context_chars"]),
        answer_mode=cfg["answer_mode"],
    )
    run_evaluation(eval_config)
