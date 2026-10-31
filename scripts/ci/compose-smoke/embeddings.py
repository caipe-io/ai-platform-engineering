"""Deterministic Ollama-compatible embeddings for storage smoke tests only."""

import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def embedding(value: str) -> list[float]:
    return [(byte - 127.5) / 127.5 for byte in hashlib.sha512(value.encode()).digest()]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path == "/api/embed":
            inputs = body["input"]
            if isinstance(inputs, str):
                inputs = [inputs]
            result = {"model": body.get("model"), "embeddings": [embedding(value) for value in inputs]}
        elif self.path == "/api/embeddings":
            result = {"embedding": embedding(body["prompt"])}
        else:
            self.send_error(404)
            return
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 11434), Handler).serve_forever()
