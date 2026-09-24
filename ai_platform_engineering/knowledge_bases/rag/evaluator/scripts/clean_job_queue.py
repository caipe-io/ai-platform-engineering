#!/usr/bin/env python3
"""Cleanup script for eval_job_queue in PostgreSQL database."""

import argparse
import logging
import sys

from deepeval_eval.db import DatabaseManager

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("clean_job_queue")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Clean up pending, running, or target dataset jobs from PostgreSQL eval_job_queue."
    )
    parser.add_argument(
        "--dataset",
        type=str,
        default=None,
        help="Filter jobs by dataset_name in config_json (e.g. e2e_custom_upload)",
    )
    parser.add_argument(
        "--status",
        type=str,
        default="pending,running,queued",
        help="Comma-separated status values to clean up (default: pending,running,queued)",
    )
    parser.add_argument(
        "--action",
        choices=["delete", "mark_failed"],
        default="delete",
        help="Action to perform on matching jobs: delete or mark_failed (default: delete)",
    )
    parser.add_argument(
        "--all-pending",
        action="store_true",
        help="Purge all pending/running/queued jobs regardless of dataset name",
    )

    args = parser.parse_args()

    db_manager = DatabaseManager()
    if not db_manager.is_postgres():
        logger.warning(
            "PostgreSQL is not configured or available. Nothing to clean in DB."
        )
        sys.exit(0)

    statuses = [s.strip() for s in args.status.split(",") if s.strip()]
    if not statuses:
        logger.error("No valid statuses specified.")
        sys.exit(1)

    status_placeholders = ",".join(["%s"] * len(statuses))

    if args.all_pending:
        logger.info(f"Targeting ALL jobs with status in {statuses}")
        if args.action == "delete":
            sql = f"DELETE FROM eval_job_queue WHERE status IN ({status_placeholders})"
            db_manager.execute_write(sql, tuple(statuses))
            logger.info(f"Successfully deleted all jobs with status in {statuses}")
        else:
            sql = f"UPDATE eval_job_queue SET status='failed', error='Cancelled via clean_job_queue' WHERE status IN ({status_placeholders})"
            db_manager.execute_write(sql, tuple(statuses))
            logger.info(f"Successfully marked jobs as failed with status in {statuses}")
        return

    dataset_filter = args.dataset or "e2e_custom_upload"
    logger.info(
        f"Targeting jobs with dataset '{dataset_filter}' and status in {statuses}"
    )

    # Query matching jobs
    query_sql = f"SELECT job_id, config_json, status FROM eval_job_queue WHERE status IN ({status_placeholders})"
    rows = db_manager.query_all(query_sql, tuple(statuses))

    matching_ids = []
    for r in rows:
        cfg_str = r.get("config_json") or "{}"
        if (
            f'"dataset_name": "{dataset_filter}"' in cfg_str
            or f'"dataset": "{dataset_filter}"' in cfg_str
        ):
            matching_ids.append(r["job_id"])

    if not matching_ids:
        logger.info(
            f"No matching jobs found for dataset '{dataset_filter}' with status in {statuses}."
        )
        return

    logger.info(
        f"Found {len(matching_ids)} matching jobs for dataset '{dataset_filter}': {matching_ids[:5]}..."
    )

    id_placeholders = ",".join(["%s"] * len(matching_ids))
    if args.action == "delete":
        del_sql = f"DELETE FROM eval_job_queue WHERE job_id IN ({id_placeholders})"
        db_manager.execute_write(del_sql, tuple(matching_ids))
        logger.info(f"Successfully deleted {len(matching_ids)} jobs.")
    else:
        update_sql = f"UPDATE eval_job_queue SET status='failed', error='Cancelled via clean_job_queue' WHERE job_id IN ({id_placeholders})"
        db_manager.execute_write(update_sql, tuple(matching_ids))
        logger.info(f"Successfully updated {len(matching_ids)} jobs to failed.")


if __name__ == "__main__":
    main()
