"""Server-side task-id generation.

Pure and I/O-free so the collision-retry policy stays in the route.
"""

import re
import secrets

MAX_SLUG_LENGTH = 40
FALLBACK_SLUG = "task"

_NON_SLUG_CHARS = re.compile(r"[^a-z0-9]+")


def slugify_task_name(name: str) -> str:
    """Reduce ``name`` to a URL-safe slug.

    Lowercases, replaces every run of non-alphanumeric characters with a
    single hyphen, trims hyphens from both ends, and caps the length. A
    name that survives as nothing (CJK, emoji, punctuation) falls back to
    ``"task"`` so the generated id is always well-formed.
    """
    slug = _NON_SLUG_CHARS.sub("-", name.lower()).strip("-")
    if len(slug) > MAX_SLUG_LENGTH:
        # Re-strip: truncation can leave a trailing hyphen.
        slug = slug[:MAX_SLUG_LENGTH].strip("-")
    return slug or FALLBACK_SLUG


def generate_task_id(name: str) -> str:
    """Build a globally-unique task id from ``name``.

    The 4-hex suffix gives 65_536 values per slug prefix. Collisions are
    rare but possible, and the caller is responsible for
    retrying with a fresh id -- never for surfacing a duplicate error.
    """
    return f"{slugify_task_name(name)}-{secrets.token_hex(2)}"
