"""Agent router — picks the best domain agent for a given query."""
import logging
from typing import Optional

from agents.base import DomainAgent

logger = logging.getLogger(__name__)

ROUTING_THRESHOLD = 0.3


class AgentRouter:
    """
    Routes user queries to the most appropriate domain agent.

    Strategy:
      1. Score every specialist agent against the query
      2. Pick the highest scorer above ROUTING_THRESHOLD
      3. Fall back to the general agent if no specialist qualifies
    """

    def __init__(self):
        self.agents: dict[str, DomainAgent] = {}
        self.general_agent: Optional[DomainAgent] = None

    def register(self, agent: DomainAgent):
        self.agents[agent.config.name] = agent

    def set_general_agent(self, agent: DomainAgent):
        """Set the fallback agent for queries no specialist matches."""
        self.general_agent = agent
        self.register(agent)

    def route(self, query: str) -> DomainAgent:
        """Find the best agent for a query."""
        best_agent = None
        best_score = 0.0

        for name, agent in self.agents.items():
            if agent is self.general_agent:
                continue
            score = agent.routing_score(query)
            logger.debug(f"Agent '{name}' scored {score:.2f}")
            if score > best_score:
                best_score = score
                best_agent = agent

        if best_agent and best_score >= ROUTING_THRESHOLD:
            logger.info(f"Routed to '{best_agent.config.name}' (score={best_score:.2f})")
            return best_agent

        logger.info(f"No specialist matched (best={best_score:.2f}), using general agent")
        return self.general_agent
