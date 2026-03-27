"""Infrastructure agent — system admin, Docker, services, SSH, n8n."""
from __future__ import annotations

from typing import TYPE_CHECKING

from agents.base import DomainAgent, AgentConfig
from prompts.agents import INFRASTRUCTURE_PROMPT

if TYPE_CHECKING:
    from services.tool_registry import ToolRegistry


class InfrastructureAgent(DomainAgent):

    def __init__(self, tool_registry: ToolRegistry):
        super().__init__(
            config=AgentConfig(
                name="infrastructure",
                description="System administration, Docker, services, SSH, n8n workflows",
                system_prompt=INFRASTRUCTURE_PROMPT,
                tool_names={
                    "system_status", "docker_control", "service_control",
                    "ssh_command", "gemini_cli",
                    "n8n_workflow_list", "n8n_workflow_get",
                    "n8n_workflow_create", "n8n_workflow_update",
                    "n8n_workflow_delete", "n8n_workflow_execute",
                    "n8n_workflow_activate", "n8n_workflow_deactivate",
                    "calculator", "get_current_time",
                },
                routing_keywords=[
                    r"\bdocker\b", r"\bcontainer\b", r"\bservice\b", r"\bsystemd\b",
                    r"\bserver\b", r"\bstatus\b", r"\bhealth\b",
                    r"\bcpu\b", r"\bmemory\b", r"\bram\b", r"\bdisk\b",
                    r"\buptime\b", r"\bprocess(?:es)?\b", r"\bnetwork\b",
                    r"\bssh\b", r"\bterminal\b", r"\bshell\b",
                    r"\bn8n\b", r"\bworkflow\b", r"\bautomation\b",
                    r"\brestart\b", r"\bstop\b.*\b(?:service|container)\b",
                    r"\blogs?\b",
                ],
                memory_categories=["infrastructure", "server"],
            ),
            tool_registry=tool_registry,
        )

    def routing_score(self, query: str) -> float:
        return self._keyword_score(query)
