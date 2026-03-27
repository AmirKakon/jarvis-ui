"""General-purpose fallback agent — preserves current Jarvis behaviour."""
from __future__ import annotations

from typing import TYPE_CHECKING

from agents.base import DomainAgent, AgentConfig
from prompts.jarvis import JARVIS_SYSTEM_PROMPT

if TYPE_CHECKING:
    from services.tool_registry import ToolRegistry


class GeneralAgent(DomainAgent):
    """
    Fallback agent that handles anything no specialist picks up.

    Uses the full system prompt and all available tools — identical
    to what Jarvis does today before the agent framework.
    """

    def __init__(self, tool_registry: ToolRegistry):
        super().__init__(
            config=AgentConfig(
                name="general",
                description="General-purpose assistant for anything not covered by specialists",
                system_prompt=JARVIS_SYSTEM_PROMPT,
                tool_names=None,  # all tools
                memory_categories=[],  # reads all categories
            ),
            tool_registry=tool_registry,
        )

    def routing_score(self, query: str) -> float:
        return 0.1  # always available, but lowest priority
