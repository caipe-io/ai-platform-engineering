"""User-facing Webex bot message copy."""

from __future__ import annotations

TEAM_SESSION_UNAVAILABLE_MESSAGE = (
    "I couldn't start your CAIPE session for this Webex space. "
    "Ask an admin to refresh this space's team setup in CAIPE."
)

TEAM_SETUP_INCOMPLETE_MESSAGE = (
    "This {surface}'s team setup is incomplete. Ask an admin to refresh the "
    "{surface}'s team assignment in CAIPE, then try again."
)

GENERIC_REQUEST_DENIED_MESSAGE = (
    "I couldn't complete that request because this space is not ready for CAIPE yet. "
    "Please try again, or ask an admin to check the space setup in CAIPE."
)


WEBEX_SPACE_MENTION_REQUIRED_MESSAGE = (
    "I can help in this Webex space when you mention {app_name}. "
    "Try mentioning {app_name} with your question, or ask an admin to enable "
    "always-on replies for this space."
)

WEBEX_SPACE_SETUP_REQUIRED_MESSAGE = (
    "This Webex space is not set up for {app_name} yet. Ask an admin to set up "
    "the Webex integration for this space in {app_name}."
)

WEBEX_DIRECT_AGENT_REQUIRED_MESSAGE = (
    "I couldn't find an agent for this 1:1 Webex chat. Open {app_name} and "
    "choose a default agent, or ask an admin to check your Webex setup."
)

WEBEX_DIRECT_MESSAGE_NOT_ONBOARDED_MESSAGE = (
    "You don't have access to message {app_name} directly. Ask an admin to "
    "enable 1:1 Webex messages for your account in {app_name}."
)

FRIENDLY_REASON_MESSAGES = {
    "WEBEX_OBO_FAILED": TEAM_SESSION_UNAVAILABLE_MESSAGE,
    "WEBEX_WORKSPACE_UNCONFIGURED": (
        "This Webex workspace is not connected to CAIPE yet. Ask an admin to finish "
        "the Webex workspace setup, then try again."
    ),
    "WEBEX_SPACE_TEAM_NOT_FOUND": (
        "This Webex space is not assigned to a CAIPE team yet. Ask an admin to add "
        "it to the right team in CAIPE, then try again."
    ),
    "WEBEX_IDENTITY_UNAVAILABLE": (
        "I couldn't verify your identity right now. Please try again in a minute or "
        "ask an admin to check your identity in CAIPE."
    ),
}
