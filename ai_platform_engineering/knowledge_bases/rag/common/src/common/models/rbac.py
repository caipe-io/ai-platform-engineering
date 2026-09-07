"""Shared RBAC models for the RAG system."""
from typing import List, Literal, Optional
from pydantic import BaseModel


class Role:
  """
  Role definitions with hierarchical permissions.

  Hierarchy (higher level inherits lower level permissions):
  1. READONLY - Read-only access (GET, query, explore)
  2. INGESTONLY - Read + ingest data (POST ingest, manage jobs)
  3. ADMIN - Full access including deletions and bulk operations
  """

  READONLY = "readonly"
  INGESTONLY = "ingestonly"
  ADMIN = "admin"


class UserContext(BaseModel):
  """Authenticated identity context.

  Human resource authorization is resolved through OpenFGA using ``subject``.
  Static IdP groups, AD groups, and Keycloak realm roles are intentionally not
  carried in this model.
  """

  subject: Optional[str] = None
  subject_type: Literal["user", "service_account"] = "user"
  client_id: Optional[str] = None
  email: str
  role: str
  is_authenticated: bool

  class Config:
    frozen = True  # Immutable for security


class UserInfoResponse(BaseModel):
  """Response model for user info endpoint"""

  email: str
  role: str
  is_authenticated: bool
  permissions: List[str]  # List of permissions: ["read", "ingest", "delete"]
