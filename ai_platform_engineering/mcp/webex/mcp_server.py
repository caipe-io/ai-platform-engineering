# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

# assisted-by claude code claude-sonnet-4-6

import functools
import logging
from enum import Enum
from typing import Annotated, Optional

import httpx
from mcp.shared.exceptions import McpError
from mcp.types import INTERNAL_ERROR, INVALID_PARAMS, ErrorData, TextContent
from pydantic import BaseModel, Field, model_validator
from mcp_agent_auth.token import get_request_token

WEBEX_API_BASE = "https://webexapis.com/v1"


def get_provider_header_token() -> Optional[str]:
    """Read a per-user Webex OAuth token forwarded by agentgateway on X-CAIPE-Provider-Token."""
    try:
        from fastmcp.server.dependencies import get_http_request

        req = get_http_request()
        token = req.headers.get("x-caipe-provider-token", "").strip()
        return token or None
    except RuntimeError:
        return None


class PostMessage(BaseModel):
    text: Annotated[
        str | None, Field(description="Text message to send")
    ] = None
    to_person_email: Annotated[
        str | None,
        Field(description="Email of the person to send the message to"),
    ] = None
    markdown: Annotated[
        str | None, Field(description="Markdown message to send")
    ] = None
    room_id: Annotated[
        str | None,
        Field(description="Room that will receive the message"),
    ] = None
    parent_id: Annotated[
        str | None,
        Field(
            description="If specified, this message is a reply in a thread (parentId)"
        ),
    ] = None

    class Config:
        description = """Send a message to a Webex room or user.
            You can specify text, markdown, and optionally reply in a thread.
            Requires either 'room_id' or 'to_person_email'.
            At least one of 'text' or 'markdown' must be provided.
        """

    @model_validator(mode="after")
    def validate_message_content(self):
        if not (self.text or self.markdown):
            raise ValueError("Either 'text' or 'markdown' must be provided")

        if not (self.room_id or self.to_person_email):
            raise ValueError("Either 'room_id' or 'to_person_email' must be provided")

        return self


class CreateRoom(BaseModel):
    title: str = Field(description="Title of the Webex room to create")

    class Config:
        description = """
            Create a new Webex room.
            Use this tool when you need to create a new Webex room for a
            conversation or project.
        """


class AddUsersToRoom(BaseModel):
    room_id: str = Field(description="ID of the Webex room to add users to")
    user_emails: list[str] = Field(
        description="List of email addresses of users to add to the room"
    )

    class Config:
        description = """
            Add multiple users to an existing Webex room.
            Use this tool when you need to add several users to a room at
            once.
        """
        json_schema_extra = {
            "required": ["room_id", "user_emails"],
        }


class ListDirectMessages(BaseModel):
    person_email: str = Field(
        description="Email address of the person whose messages to retrieve"
    )
    max_results: int | None = Field(
        default=50, description="Maximum number of messages " "to return"
    )

    class Config:
        description = """
            Add multiple users to an existing Webex room.
            Use this tool when you need to add several users to a room at
            once.
        """


class ListMessagesInRoom(BaseModel):
    room_id: str = Field(description="ID of the Webex room whose messages to retrieve")
    max: int | None = Field(
        default=None, description="Maximum number of messages to return"
    )
    parent_id: str | None = Field(
        default=None,
        description="If specified, only list messages with this parentId (" "thread)",
    )

    class Config:
        description = "List messages in a Webex room"


class ListRooms(BaseModel):
    max: int | None = Field(
        default=None, description="Maximum number of rooms to return"
    )
    team_id: str | None = Field(
        default=None, description="If specified, only list rooms " "for this team"
    )

    class Config:
        description = "List Webex rooms"


class ListUsersInRoom(BaseModel):
    room_id: str = Field(description="ID of the Webex room whose users to list")
    max: int | None = Field(
        default=None, description="Maximum number of users to return"
    )

    class Config:
        description = "List users in a Webex room"


class ListThreadMessages(BaseModel):
    room_id: str = Field(description="ID of the Webex room containing the thread")
    parent_id: str = Field(description="ID of the parent message (thread)")
    max: int | None = Field(
        default=None, description="Maximum number of messages to return"
    )

    class Config:
        description = "List messages in a thread in a Webex room"


class WebexTools(str, Enum):
    POST_MESSAGE = "post_message"
    CREATE_ROOM = "create_room"
    ADD_USERS_TO_ROOM = "add_users_to_room"
    LIST_DIRECT_MESSAGES = "list_direct_messages"
    LIST_MESSAGES_IN_ROOM = "list_messages_in_room"
    LIST_ROOMS = "list_rooms"
    LIST_USERS_IN_ROOM = "list_users_in_room"
    LIST_THREAD_MESSAGES = "list_thread_messages"


# FastMCP tool registration
def register_tools(server, auth_token: Optional[str] = None) -> None:
    logger = logging.getLogger(__name__)
    logger.info("🔧 Initializing Webex MCP tools registration")
    logger.info(f"🌐 Webex API Base URL: {WEBEX_API_BASE}")
    http_client = httpx.AsyncClient(base_url=WEBEX_API_BASE)

    def _get_token() -> str:
        """Resolve bearer token: provider header (per-user OAuth) → MCP auth token → startup env token."""
        return get_provider_header_token() or get_request_token("WEBEX_TOKEN") or auth_token or ""

    def handle_mcp_errors(func):
        @functools.wraps(func)
        async def wrapper(args):
            logger = logging.getLogger(__name__)
            try:
                return await func(args)
            except httpx.TimeoutException as e:
                logger.error(f"TimeoutException: {e}")
                raise McpError(
                    ErrorData(code=INTERNAL_ERROR, message="Request timed out.")
                )
            except httpx.HTTPStatusError as e:
                logger.error(f"HTTPStatusError: {e}")
                raise McpError(
                    ErrorData(
                        code=INTERNAL_ERROR,
                        message=f"HTTP error: {e.response.status_code} "
                        f"{e.response.text}",
                    )
                )
            except httpx.RequestError as e:
                logger.error(f"RequestError: {e}")
                raise McpError(
                    ErrorData(code=INTERNAL_ERROR, message="Request error occurred.")
                )
            except ValueError as e:
                logger.error(e)
                raise McpError(ErrorData(code=INVALID_PARAMS, message=str(e)))
            except Exception as e:
                logger.error(f"Unhandled Exception: {e}")
                raise McpError(
                    ErrorData(
                        code=INTERNAL_ERROR, message="An internal error occurred."
                    )
                )

        return wrapper

    @server.tool(
        name=WebexTools.POST_MESSAGE, description=PostMessage.Config.description
    )
    @handle_mcp_errors
    async def post_message_tool(args: PostMessage):
        payload = {
            "text": args.text,
            "markdown": args.markdown,
            "roomId": args.room_id,
            "toPersonEmail": args.to_person_email,
            "parentId": args.parent_id,
        }
        response = await http_client.post(
            "/messages",
            headers={"Authorization": f"Bearer {_get_token()}"},
            json={k: v for k, v in payload.items() if v is not None},
        )
        response.raise_for_status()
        # Surface the Webex-side ``id`` (a.k.a. messageId), ``roomId``,
        # and ``parentId`` in the tool response. The autonomous-agents
        # service scans completed-run events for these fields so it can
        # build a Webex thread -> task_id/run_id map; without them, the
        # bot can never tell which task a later in-thread reply belongs
        # to. Falls back to a plain success line if Webex returns an
        # unexpected (non-JSON / partial) body so the agent loop is
        # never broken by upstream changes.
        try:
            sent = response.json()
        except (ValueError, TypeError):
            sent = {}
        message_id = sent.get("id")
        room_id = sent.get("roomId")
        parent_id = sent.get("parentId")
        if message_id:
            descriptor = f"messageId={message_id}"
            if room_id:
                descriptor += f", roomId={room_id}"
            if parent_id:
                descriptor += f", parentId={parent_id}"
            return [
                TextContent(
                    type="text",
                    text=f"Message sent successfully ({descriptor}).",
                )
            ]
        return [TextContent(type="text", text="Message sent successfully")]

    @server.tool(name=WebexTools.CREATE_ROOM, description=CreateRoom.Config.description)
    @handle_mcp_errors
    async def create_room_tool(args: CreateRoom):
        payload = {"title": args.title}
        response = await http_client.post(
            "/rooms",
            headers={"Authorization": f"Bearer {_get_token()}"},
            json=payload,
        )
        response.raise_for_status()
        room = response.json()
        return [
            TextContent(
                type="text",
                text=f"Room created successfully: "
                f"{room.get('title')} (ID: {room.get('id')})",
            )
        ]

    @server.tool(
        name=WebexTools.ADD_USERS_TO_ROOM, description=AddUsersToRoom.Config.description
    )
    @handle_mcp_errors
    async def add_users_to_room_tool(args: AddUsersToRoom):
        if not (args.room_id and args.user_emails):
            return [
                TextContent(
                    type="text",
                    text="Error: 'room_id' and 'user_emails' must " "not be " "empty.",
                )
            ]
        results = []
        for email in args.user_emails:
            membership_payload = {"roomId": args.room_id, "personEmail": email}
            try:
                response = await http_client.post(
                    "/memberships",
                    headers={"Authorization": f"Bearer {_get_token()}"},
                    json=membership_payload,
                )
                response.raise_for_status()
                results.append(f"Added {email} successfully")
            except httpx.HTTPStatusError as e:
                error_message = f"Failed to add {email}: {e.response.text}"
                logger.error(error_message)
                results.append(error_message)
        return [TextContent(type="text", text="Results:\n" + "\n".join(results))]

    @server.tool(
        name=WebexTools.LIST_DIRECT_MESSAGES,
        description=ListDirectMessages.Config.description,
    )
    @handle_mcp_errors
    async def list_direct_messages_tool(args: ListDirectMessages):
        if not args.person_email:
            return [
                TextContent(
                    type="text", text="Error: 'person_email' must not be " "empty."
                )
            ]
        query_params = {"personEmail": args.person_email, "max": args.max_results}
        response = await http_client.get(
            "/messages",
            headers={"Authorization": f"Bearer {_get_token()}"},
            params=query_params,
        )
        response.raise_for_status()
        messages_data = response.json()
        messages = messages_data.get("items", [])
        if not messages:
            return [TextContent(type="text", text="No messages found with this person")]
        results = []
        for message in messages:
            sender = message.get("personEmail", "Unknown")
            created = message.get("created", "Unknown time")
            text = message.get("text", "(No text content)")
            results.append(f"From: {sender}\nTime: {created}\nMessage: {text}\n")
        return [
            TextContent(
                type="text",
                text=f"Found {len(messages)} messages "
                f"with {args.person_email}:\n\n" + "\n".join(results),
            )
        ]

    @server.tool(
        name=WebexTools.LIST_MESSAGES_IN_ROOM,
        description=ListMessagesInRoom.Config.description,
    )
    @handle_mcp_errors
    async def list_messages_in_room_tool(args: ListMessagesInRoom):
        params = {"roomId": args.room_id, "mentionedPeople": "me"}
        if args.max is not None:
            params["max"] = str(args.max)
        if args.parent_id is not None:
            params["parentId"] = args.parent_id
        response = await http_client.get(
            "/messages",
            headers={"Authorization": f"Bearer {_get_token()}"},
            params=params,
        )
        response.raise_for_status()
        messages = response.json().get("items", [])
        formatted = "\n".join(
            [
                f"[{m.get('created')}] {m.get('personEmail')}: {m.get('text',
                                                                      '')}"
                for m in messages
            ]
        )
        return [TextContent(type="text", text=formatted or "No messages found.")]

    @server.tool(name=WebexTools.LIST_ROOMS, description=ListRooms.Config.description)
    @handle_mcp_errors
    async def list_rooms_tool(args: ListRooms):
        params = {}
        if args.max is not None:
            params["max"] = args.max
        if args.team_id is not None:
            params["teamId"] = args.team_id
        response = await http_client.get(
            "/rooms",
            headers={"Authorization": f"Bearer {_get_token()}"},
            params=params,
        )
        response.raise_for_status()
        rooms = response.json().get("items", [])
        formatted = "\n".join([f"{r.get('title')} (ID: {r.get('id')})" for r in rooms])
        return [TextContent(type="text", text=formatted or "No rooms found.")]

    @server.tool(
        name=WebexTools.LIST_USERS_IN_ROOM,
        description=ListUsersInRoom.Config.description,
    )
    @handle_mcp_errors
    async def list_users_in_room_tool(args: ListUsersInRoom):
        params = {"roomId": args.room_id}
        if args.max is not None:
            params["max"] = str(args.max)
        response = await http_client.get(
            "/memberships",
            headers={"Authorization": f"Bearer {_get_token()}"},
            params=params,
        )
        response.raise_for_status()
        memberships = response.json().get("items", [])
        if not memberships:
            return [TextContent(type="text", text="No users found in this room.")]
        formatted = "\n".join(
            [
                f"{m.get('personEmail', 'Unknown')} (ID: {m.get('id', 'N/A')})"
                for m in memberships
            ]
        )
        return [TextContent(type="text", text=formatted)]

    @server.tool(
        name=WebexTools.LIST_THREAD_MESSAGES,
        description=ListThreadMessages.Config.description,
    )
    @handle_mcp_errors
    async def list_thread_messages_tool(args: ListThreadMessages):
        params = {"roomId": args.room_id, "parentId": args.parent_id}
        if args.max is not None:
            params["max"] = str(args.max)
        response = await http_client.get(
            "/messages",
            headers={"Authorization": f"Bearer {_get_token()}"},
            params=params,
        )
        response.raise_for_status()
        messages = response.json().get("items", [])
        if not messages:
            return [TextContent(type="text", text="No messages found in this thread.")]
        formatted = "\n".join(
            [
                f"[{m.get('created', '')}] {m.get('personEmail', '')}: "
                f"{m.get('text', '')}"
                for m in messages
            ]
        )
        return [TextContent(type="text", text=formatted)]

    logger.info("✅ Webex MCP tools registration completed successfully")
    logger.info("🔧 Registered tools: post_message, create_room, add_person_to_room, list_people, remove_person_from_room, list_rooms, list_messages, list_messages_thread")
