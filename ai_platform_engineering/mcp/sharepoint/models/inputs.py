# Copyright 2026 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Pydantic inputs exposed by SharePoint MCP tools."""

from __future__ import annotations

import re
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator

IDENTIFIER_PATTERN = r"^[A-Za-z0-9!._~-]+$"
FIELD_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class ToolInput(BaseModel):
    """Strict base model for tool arguments."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class PageInput(ToolInput):
    """Cursor-based Graph collection input."""

    limit: Annotated[int, Field(default=20, ge=1, le=100, description="Maximum results to return.")] = 20
    cursor: Annotated[
        str | None,
        Field(default=None, min_length=1, max_length=4096, description="Opaque cursor from a previous response."),
    ] = None


class DriveItemInput(ToolInput):
    """Identify one item within one configured-site document library."""

    drive_id: Annotated[
        str,
        Field(min_length=1, max_length=512, pattern=IDENTIFIER_PATTERN, description="Document library drive ID."),
    ]
    item_id: Annotated[
        str,
        Field(min_length=1, max_length=512, pattern=IDENTIFIER_PATTERN, description="SharePoint drive item ID."),
    ]


class ListDriveItemsInput(PageInput):
    """List children under a document library root or folder."""

    drive_id: Annotated[
        str,
        Field(min_length=1, max_length=512, pattern=IDENTIFIER_PATTERN, description="Document library drive ID."),
    ]
    folder_item_id: Annotated[
        str | None,
        Field(
            default=None,
            min_length=1,
            max_length=512,
            pattern=IDENTIFIER_PATTERN,
            description="Folder item ID. Omit to list the drive root.",
        ),
    ] = None


class SearchDriveItemsInput(PageInput):
    """Search file and folder names/content in one document library."""

    drive_id: Annotated[
        str,
        Field(min_length=1, max_length=512, pattern=IDENTIFIER_PATTERN, description="Document library drive ID."),
    ]
    query: Annotated[
        str,
        Field(min_length=1, max_length=200, description="SharePoint drive search query."),
    ]


class ReadFileInput(DriveItemInput):
    """Read a bounded text file from a document library."""

    max_characters: Annotated[
        int,
        Field(default=50_000, ge=1_000, le=200_000, description="Maximum decoded characters to return."),
    ] = 50_000


class ListItemsInput(PageInput):
    """List rows and selected fields from a SharePoint list."""

    list_id: Annotated[
        str,
        Field(min_length=1, max_length=512, pattern=IDENTIFIER_PATTERN, description="SharePoint list ID."),
    ]
    field_names: Annotated[
        list[str] | None,
        Field(default=None, max_length=20, description="Optional internal column names to include."),
    ] = None

    @field_validator("field_names")
    @classmethod
    def validate_field_names(cls, value: list[str] | None) -> list[str] | None:
        """Reject OData expressions disguised as field names."""
        if value is None:
            return None
        invalid = [name for name in value if not FIELD_NAME_PATTERN.fullmatch(name)]
        if invalid:
            raise ValueError("field_names must contain only SharePoint internal column names")
        return list(dict.fromkeys(value))
