"""Regression tests for smoke-test failure detection and the local fixture."""

import unittest
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from embeddings import Handler, embedding
from run import Smoke, eventually


def container(status: str = "running", health: str = "healthy", exit_code: int = 0) -> dict:
    return {"State": {"Status": status, "Health": {"Status": health}, "ExitCode": exit_code}}


class ReadinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.smoke = Smoke("docker-compose.yaml", "platform")
        self.smoke.services = ["caipe-mongodb", "openfga-init"]
        self.states = {"caipe-mongodb": container(), "openfga-init": container("exited")}

    def ready(self) -> bool:
        with patch.object(self.smoke, "states", return_value=self.states):
            return self.smoke.healthy()

    def test_successful_init_is_not_mistaken_for_a_crash(self) -> None:
        self.assertTrue(self.ready())

    def test_missing_service_fails(self) -> None:
        del self.states["caipe-mongodb"]
        self.assertFalse(self.ready())

    def test_failed_or_unfinished_init_fails(self) -> None:
        for state in [container("exited", exit_code=1), container()]:
            self.states["openfga-init"] = state
            self.assertFalse(self.ready())

    def test_unhealthy_or_exited_dependency_fails(self) -> None:
        for state in [container(health="unhealthy"), container("exited"), container("restarting")]:
            self.states["dependency"] = state
            self.assertFalse(self.ready())

    def test_oom_is_reported(self) -> None:
        self.states["caipe-mongodb"]["State"]["OOMKilled"] = True
        with self.assertRaisesRegex(RuntimeError, "OOM-killed"):
            self.ready()

    def test_recreation_reads_data_without_reseeding_it(self) -> None:
        for state in self.states.values():
            state["RestartCount"] = 0
        with patch.object(self.smoke, "configure"), patch.object(self.smoke, "compose", return_value=""), \
                patch.object(self.smoke, "states", return_value=self.states), \
                patch.object(self.smoke, "probes") as probes, patch("run.time.sleep"):
            self.smoke.run()
        self.assertEqual(probes.call_args_list[0].kwargs, {})
        self.assertEqual(probes.call_args_list[1].kwargs, {"persisted": True})


class EventuallyTests(unittest.TestCase):
    def test_retries_non_json_and_partial_responses(self) -> None:
        responses = iter([json.JSONDecodeError("Expecting value", "<html>", 0), KeyError("stores"), True])

        def check() -> bool:
            response = next(responses)
            if isinstance(response, Exception):
                raise response
            return response

        with patch("run.time.sleep"):
            self.assertTrue(eventually(check, "startup"))


class EmbeddingTests(unittest.TestCase):
    def test_fixed_dimension_and_repeatability(self) -> None:
        self.assertEqual(len(embedding("example")), 64)
        self.assertEqual(embedding("example"), embedding("example"))
        self.assertNotEqual(embedding("example"), embedding("secondary"))

    def test_ollama_batch_and_query_wire_format(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for value in ["example", ["example", "secondary"]]:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/api/embed",
                    data=json.dumps({"model": "example-embedding", "input": value}).encode(),
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    body = json.load(response)
                expected = [value] if isinstance(value, str) else value
                self.assertEqual(body["embeddings"], [embedding(item) for item in expected])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
