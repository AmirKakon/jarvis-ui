"""Memory agent — fact storage, recall, governance, deduplication."""
from __future__ import annotations

from typing import TYPE_CHECKING

from agents.base import DomainAgent, AgentConfig
from prompts.agents import MEMORY_PROMPT

if TYPE_CHECKING:
    from services.tool_registry import ToolRegistry


class MemoryAgent(DomainAgent):

    def __init__(self, tool_registry: ToolRegistry):
        super().__init__(
            config=AgentConfig(
                name="memory",
                description="Memory storage, recall, governance, and deduplication",
                system_prompt=MEMORY_PROMPT,
                tool_names={
                    "add_memory", "memory_governance", "memory_deduplication",
                    "calculator", "get_current_time",
                },
                routing_keywords=[
                    r"\bremember\b", r"\bmemory\b", r"\bforget\b",
                    r"\bsave\b.*\b(this|that|it)\b", r"\bstore\b",
                    r"\brecall\b", r"\bwhat\s+do\s+you\s+(know|remember)\b",
                ],
                memory_categories=[],  # reads all categories
            ),
            tool_registry=tool_registry,
        )

    def routing_score(self, query: str) -> float:
        return self._keyword_score(query)
