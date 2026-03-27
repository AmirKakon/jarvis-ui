"""AI Orchestrator service with streaming and tool execution."""
import asyncio
import json
import logging
from typing import AsyncGenerator, Optional
from dataclasses import dataclass

from services.llm_provider import (
    LLMProvider, ChatMessage, ToolCall, StreamEvent,
    create_provider_from_settings,
)
from services.tool_registry import tool_registry
from agents.router import AgentRouter
from agents.general import GeneralAgent
from agents.infrastructure import InfrastructureAgent
from agents.media import MediaAgent
from agents.memory import MemoryAgent

logger = logging.getLogger(__name__)



@dataclass
class OrchestratorEvent:
    """Event emitted by the orchestrator during processing."""
    type: str  # "start", "token", "tool_call", "tool_result", "end", "error"
    content: str = ""
    tool_name: Optional[str] = None
    tool_args: Optional[dict] = None
    tool_result: Optional[dict] = None
    full_response: Optional[str] = None


class Orchestrator:
    """
    AI Orchestrator that manages conversation flow, tool execution, and streaming.
    
    Handles the agentic loop:
    1. Route query to the best domain agent
    2. Send user message to LLM with agent-specific prompt and tools
    3. If LLM requests tool call, execute it and feed result back
    4. Continue until LLM produces final response
    5. Stream tokens to client throughout
    """
    
    def __init__(
        self,
        llm_provider: Optional[LLMProvider] = None,
        max_tool_iterations: int = 10,
        include_summaries: bool = True,
    ):
        self.llm_provider = llm_provider or create_provider_from_settings()
        self.max_tool_iterations = max_tool_iterations
        self.include_summaries = include_summaries
        self.router = self._build_router()
    
    def _build_router(self) -> AgentRouter:
        """Register all domain agents with the router."""
        router = AgentRouter()
        router.set_general_agent(GeneralAgent(tool_registry))
        router.register(InfrastructureAgent(tool_registry))
        router.register(MediaAgent(tool_registry))
        router.register(MemoryAgent(tool_registry))
        return router
    
    async def _search_relevant_summaries(self, query: str) -> str:
        """
        Search for summaries semantically relevant to the user's query.
        
        Uses vector similarity search with recency-weighted decay to find
        relevant past conversations. Recent memories are weighted higher.
        Retrieved summaries have last_accessed_at refreshed (spaced repetition).
        """
        try:
            from database.db import async_session_maker
            from services.session_cleanup import session_cleanup_service
            
            async with async_session_maker() as db:
                summaries_with_scores = await session_cleanup_service.search_relevant_summaries(
                    db, 
                    query_text=query,
                    limit=3,
                    similarity_threshold=0.25,
                    use_recency_decay=True,
                )
                
                if not summaries_with_scores:
                    return ""
                
                context_parts = ["\n\n## Relevant Past Conversations\n"]
                
                for summary, score in summaries_with_scores:
                    topics_str = ", ".join(summary.topics) if summary.topics else "General"
                    date_str = summary.session_created_at.strftime('%Y-%m-%d')
                    context_parts.append(
                        f"- **{date_str}** ({topics_str}): {summary.summary}"
                    )
                
                context_parts.append("\nUse this context if relevant to the user's question.\n")
                
                return "\n".join(context_parts)
                
        except Exception as e:
            logger.warning(f"Failed to search chat summaries: {e}")
            return ""

    async def _get_durable_facts(self) -> str:
        """Fetch all durable facts from memory_facts table."""
        try:
            from database.db import async_session_maker
            from sqlalchemy import select
            from models.memory_fact import MemoryFact

            async with async_session_maker() as db:
                result = await db.execute(
                    select(MemoryFact).order_by(MemoryFact.created_at)
                )
                facts = list(result.scalars().all())

                if not facts:
                    return ""

                lines = ["\n\n## Permanent Facts\n"]
                for f in facts:
                    lines.append(f"- {f.content}")
                lines.append("")
                return "\n".join(lines)

        except Exception as e:
            logger.warning(f"Failed to fetch durable facts: {e}")
            return ""
    
    async def _build_system_prompt(self, base_prompt: str, user_query: str) -> str:
        """
        Build the full system prompt with durable facts and relevant summaries.
        
        Two-tier memory injection:
          1. Durable facts — always included, never decay
          2. Session summaries — recency-weighted semantic search
        """
        if not self.include_summaries:
            return base_prompt
        
        facts_context, summaries_context = await asyncio.gather(
            self._get_durable_facts(),
            self._search_relevant_summaries(user_query),
        )
        
        return base_prompt + facts_context + summaries_context
    
    async def process_message(
        self,
        user_message: str,
        conversation_history: Optional[list[ChatMessage]] = None,
    ) -> AsyncGenerator[OrchestratorEvent, None]:
        """
        Process a user message with streaming and tool execution.
        
        Args:
            user_message: The user's message
            conversation_history: Previous messages in the conversation
            
        Yields:
            OrchestratorEvent objects representing the processing flow
        """
        messages = conversation_history.copy() if conversation_history else []
        messages.append(ChatMessage(role="user", content=user_message))
        
        # Route to the best domain agent
        agent = self.router.route(user_message)
        tools = agent.get_tool_schemas()
        llm = agent.get_llm_provider() or self.llm_provider
        max_iters = agent.config.max_tool_iterations
        
        logger.debug(f"Agent '{agent.config.name}' loaded {len(tools)} tools")
        
        # Build full system prompt with memory injection
        system_prompt = await self._build_system_prompt(
            agent.get_system_prompt(), user_message,
        )
        
        yield OrchestratorEvent(type="start")
        
        full_response = ""
        iteration = 0
        
        while iteration < max_iters:
            iteration += 1
            
            try:
                pending_tool_calls: list[ToolCall] = []
                current_text = ""
                
                # Stream response from LLM
                async for event in llm.chat_stream(
                    messages=messages,
                    tools=tools if tools else None,
                    system_prompt=system_prompt,
                ):
                    if event.type == "token":
                        current_text += event.content
                        yield OrchestratorEvent(type="token", content=event.content)
                    
                    elif event.type == "tool_call":
                        pending_tool_calls.append(ToolCall(
                            id=event.tool_call_id or f"call_{len(pending_tool_calls)}",
                            name=event.tool_name,
                            arguments=event.tool_args or {},
                        ))
                        yield OrchestratorEvent(
                            type="tool_call",
                            tool_name=event.tool_name,
                            tool_args=event.tool_args,
                        )
                    
                    elif event.type == "error":
                        yield OrchestratorEvent(type="error", content=event.content)
                        return
                    
                    elif event.type == "end":
                        if event.full_response:
                            current_text = event.full_response
                
                # If there are tool calls, execute them
                if pending_tool_calls:
                    # Add assistant message with tool calls to history
                    messages.append(ChatMessage(
                        role="assistant",
                        content=current_text,
                        tool_calls=pending_tool_calls,
                    ))
                    
                    # Execute each tool
                    for tool_call in pending_tool_calls:
                        logger.info(f"Executing tool: {tool_call.name} with args: {tool_call.arguments}")
                        
                        result = await tool_registry.execute(
                            tool_call.name,
                            tool_call.arguments,
                        )
                        
                        yield OrchestratorEvent(
                            type="tool_result",
                            tool_name=tool_call.name,
                            tool_result=result,
                        )
                        
                        # Add tool result to messages
                        messages.append(ChatMessage(
                            role="tool",
                            content=json.dumps(result),
                            tool_call_id=tool_call.id,
                            name=tool_call.name,
                        ))
                    
                    # Continue the loop to get LLM's response to tool results
                    continue
                
                # No tool calls, we have the final response
                full_response = current_text
                break
            
            except Exception as e:
                logger.error(f"Orchestrator error in iteration {iteration}: {e}")
                yield OrchestratorEvent(type="error", content=str(e))
                return
        
        if iteration >= max_iters:
            logger.warning(f"Max tool iterations ({max_iters}) reached")
            yield OrchestratorEvent(
                type="error",
                content="Maximum tool iterations reached. Please try a simpler request."
            )
            return
        
        yield OrchestratorEvent(type="end", full_response=full_response)
    
    async def process_message_simple(
        self,
        user_message: str,
        conversation_history: Optional[list[ChatMessage]] = None,
    ) -> str:
        """
        Process a message and return the final response (non-streaming).
        
        Useful for simple integrations that don't need streaming.
        """
        full_response = ""
        
        async for event in self.process_message(user_message, conversation_history):
            if event.type == "end":
                full_response = event.full_response or ""
            elif event.type == "error":
                full_response = f"Error: {event.content}"
        
        return full_response


def create_orchestrator() -> Orchestrator:
    """Create an orchestrator instance with default settings."""
    return Orchestrator()


def clear_summaries_cache():
    """
    Clear summaries cache (no-op with semantic search).
    
    Kept for backwards compatibility but no longer needed since
    semantic search queries the database directly for each request.
    """
    pass


# Global orchestrator instance (lazy initialization)
_orchestrator: Optional[Orchestrator] = None


def get_orchestrator() -> Orchestrator:
    """Get the global orchestrator instance."""
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = create_orchestrator()
    return _orchestrator

