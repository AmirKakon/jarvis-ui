"""Media agent — Jellyfin media server management."""
from __future__ import annotations

from typing import TYPE_CHECKING

from agents.base import DomainAgent, AgentConfig
from prompts.agents import MEDIA_PROMPT

if TYPE_CHECKING:
    from services.tool_registry import ToolRegistry


class MediaAgent(DomainAgent):

    def __init__(self, tool_registry: ToolRegistry):
        super().__init__(
            config=AgentConfig(
                name="media",
                description="Jellyfin media server management",
                system_prompt=MEDIA_PROMPT,
                tool_names={"jellyfin_api", "calculator", "get_current_time"},
                routing_keywords=[
                    r"\bjellyfin\b", r"\bmedia\b", r"\bmovie\b", r"\bshow\b",
                    r"\bvideo\b", r"\bstream\b", r"\blibrary\b", r"\bplaying\b",
                    r"\bwatch\b", r"\bsession\b.*\bactive\b",
                    r"\bwhat\s+(is|are)\s+(being\s+)?watch",
                ],
                memory_categories=["media"],
            ),
            tool_registry=tool_registry,
        )

    def routing_score(self, query: str) -> float:
        return self._keyword_score(query)
