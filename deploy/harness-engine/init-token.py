"""Create an installation-owned credential without logging it or rotating on restart."""

import argparse
import os
import secrets
import tempfile
from pathlib import Path


def validate_token(token: str) -> None:
    if len(token) < 16 or token == "local-development-only" or any(c.isspace() for c in token):
        raise ValueError("Use a private service token of at least 16 non-whitespace characters")


def initialize_token(path: Path, configured: str = "", *, rotate: bool = False) -> None:
    if configured:
        validate_token(configured)
    if path.exists() and not rotate:
        current = path.read_text().strip()
        validate_token(current)
        if configured and not secrets.compare_digest(current, configured):
            raise ValueError("Token differs from persisted credential; drain both services and explicitly rotate")
        return
    token = configured or secrets.token_urlsafe(48)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(token + "\n")
            stream.flush()
            os.fsync(stream.fileno())
            # Only the two explicitly mounted consumers can access this volume.
            os.fchmod(stream.fileno(), 0o644)
        if rotate:
            os.replace(temporary, path)
        else:
            try:
                os.link(temporary, path)
            except FileExistsError:
                initialize_token(path, configured)
    finally:
        Path(temporary).unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rotate", action="store_true")
    args = parser.parse_args()
    initialize_token(Path("/workspace/token"), os.environ.get("HARNESS_ENGINE_INTERNAL_TOKEN", ""), rotate=args.rotate)
