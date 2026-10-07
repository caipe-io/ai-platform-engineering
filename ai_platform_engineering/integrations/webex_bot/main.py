# Copyright 2025 CAIPE Contributors
# SPDX-License-Identifier: Apache-2.0
"""Webex bot process entrypoint (admin API bootstrap; no import-time side effects)."""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger("caipe.webex_bot")


def bootstrap_webex_bot_runtime() -> None:
    """Start optional background services when enabled via environment."""

    if os.environ.get("WEBEX_ADMIN_API_ENABLED", "false").lower() == "true":
        from .utils.webex_admin_api import load_webex_bot_config, start_webex_admin_api_server

        server = start_webex_admin_api_server(load_webex_bot_config())
        if server is None:
            logger.warning("WEBEX_ADMIN_API_ENABLED=true but admin API did not start")
        else:
            logger.info("Webex bot admin API bootstrap complete")

    from .webex_wdm import start_webex_wdm_listeners

    listeners = start_webex_wdm_listeners()
    if listeners:
        logger.info("Webex WDM transport bootstrap complete listeners=%d", len(listeners))


def run_until_stopped() -> None:
    """Keep the container's foreground process alive until it receives a signal."""

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        logger.info("Webex bot shutdown requested")


def main() -> None:
    """Run the Webex bot process."""

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    bootstrap_webex_bot_runtime()
    logger.info("Webex bot runtime ready")
    run_until_stopped()


if __name__ == "__main__":
    main()
