"""Base class for domain agents."""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from services.llm_provider import LLMProvider
    from services.tool_registry import ToolRegistry


@dataclass
class AgentConfig:
    """Configuration that defines a domain agent's identity and capabilities."""
    name: str
    description: str
    system_prompt: str
    tool_names: Optional[set[str]] = None       # None = all tools
    llm_provider: Optional[LLMProvider] = None
    max_tool_iterations: int = 10
    memory_categories: list[str] = field(default_factory=list)
    routing_keywords: list[str] = field(default_factory=list)


class DomainAgent(ABC):
    """
    Base class for all domain agents.

    Each agent owns a system prompt, a tool subset, an optional LLM override,
    and a memory scope.  The orchestrator queries the router, gets back an
    agent, and uses its configuration for the agentic loop.
    """

    def __init__(self, config: AgentConfig, tool_registry: ToolRegistry):
        self.config = config
        self.tool_registry = tool_registry

    @abstractmethod
    def routing_score(self, query: str) -> float:
        """Return 0.0-1.0 confidence that this agent should handle the query."""
        ...

    def _keyword_score(self, query: str) -> float:
        """Score based on routing keyword matches (shared helper)."""
        q = query.lower()
        matches = sum(
            1 for kw in self.config.routing_keywords
            if re.search(kw, q)
        )
        if matches >= 2:
            return 0.95
        if matches == 1:
            return 0.6
        return 0.0

    def get_tool_schemas(self) -> list[dict]:
        """Return OpenAI-compatible tool schemas for this agent's tools."""
        if self.config.tool_names is None:
            return self.tool_registry.get_schemas()
        return self.tool_registry.get_schemas(self.config.tool_names)

    def get_system_prompt(self) -> str:
        return self.config.system_prompt

    def get_llm_provider(self) -> Optional[LLMProvider]:
        return self.config.llm_provider
