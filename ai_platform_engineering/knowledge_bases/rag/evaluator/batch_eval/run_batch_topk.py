from deepeval_eval.engine.eval_engine import EvalConfig, run_evaluation

configs = [
    {"name": "topk3", "top_k": 3, "max_context_chars": 8000},
    {"name": "topk5", "top_k": 5, "max_context_chars": 8000},
    {"name": "topk7", "top_k": 7, "max_context_chars": 8000},
]

for cfg in configs:
    print(f"\n=== Running config: {cfg['name']} ===")
    eval_config = EvalConfig(
        dataset_name="hotpotqa",
        max_items=50,
        top_k=cfg["top_k"],
        max_context_chars=cfg["max_context_chars"],
    )
    run_evaluation(eval_config)
