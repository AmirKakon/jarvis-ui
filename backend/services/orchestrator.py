"""AI Orchestrator service with streaming and tool execution."""
import json
import logging
from typing import AsyncGenerator, Optional
from dataclasses import dataclass

from services.llm_provider import (
    LLMProvider, ChatMessage, ToolCall, StreamEvent,
    create_provider_from_settings,
)
from services.tool_registry import tool_registry
from services.query_classifier import classify_query, get_tools_for_category, QueryCategory
from prompts.jarvis import JARVIS_SYSTEM_PROMPT, JARVIS_SYSTEM_PROMPT_SHORT

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
    1. Send user message to LLM
    2. If LLM requests tool call, execute it and feed result back
    3. Continue until LLM produces final response
    4. Stream tokens to client throughout
    
    Performance optimization:
    - Classifies queries to determine which tools are needed
    - Uses shorter system prompt for simple queries
    - Only loads relevant tools to reduce TTFT
    - Uses semantic search to include only relevant past session summaries
    """
    
    def __init__(
        self,
        llm_provider: Optional[LLMProvider] = None,
        system_prompt: str = JARVIS_SYSTEM_PROMPT,
        max_tool_iterations: int = 10,
        smart_tools: bool = True,  # Enable smart tool loading
        include_summaries: bool = True,  # Include past session summaries
    ):
        self.llm_provider = llm_provider or create_provider_from_settings()
        self.system_prompt = system_prompt
        self.system_prompt_short = JARVIS_SYSTEM_PROMPT_SHORT
        self.max_tool_iterations = max_tool_iterations
        self.smart_tools = smart_tools
        self.include_summaries = include_summaries
    
    async def _search_relevant_summaries(self, query: str) -> str:
        """
        Search for summaries semantically relevant to the user's query.
        
        Uses vector similarity search to find only relevant past conversations,
        avoiding the overhead of including all summaries in every prompt.
        
        Args:
            query: The user's current message
            
        Returns:
            Formatted context string with relevant summaries, or empty string
        """
        try:
            from database.db import async_session_maker
            from services.session_cleanup import session_cleanup_service
            
            async with async_session_maker() as db:
                # Search for semantically relevant summaries
                summaries_with_scores = await session_cleanup_service.search_relevant_summaries(
                    db, 
                    query_text=query,
                    limit=3,  # Only include top 3 most relevant
                    similarity_threshold=0.3,  # Minimum relevance
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
    
    async def _build_system_prompt(self, base_prompt: str, user_query: str) -> str:
        """
        Build the full system prompt, optionally including relevant summaries.
        
        Uses semantic search to only include summaries relevant to the query,
        reducing token usage and improving response quality.
        """
        if not self.include_summaries:
            return base_prompt
        
        summaries_context = await self._search_relevant_summaries(user_query)
        if summaries_context:
            return base_prompt + summaries_context
        return base_prompt
    
    def _get_tools_for_query(self, query: str) -> tuple[list[dict], str]:
        """
        Get appropriate tools and system prompt for a query.
        
        Strategy:
        - Always use full system prompt (has "be concise" instruction)
        - Filter tools only for specific categories to reduce cognitive load
        - For simple/knowledge queries, include basic tools (the model
          performs better with tools available to ignore than none at all)
        
        Returns:
            Tuple of (tool_schemas, system_prompt)
        """
        if not self.smart_tools:
            return tool_registry.get_schemas(), self.system_prompt
        
        category = classify_query(query)
        logger.debug(f"Query classified as: {category.value}")
        
        # Always use full prompt - it has important conciseness instructions
        prompt = self.system_prompt
        
        # For simple/knowledge queries, use minimal core tools
        # (Model performs better with SOME tools than NONE)
        if category in (QueryCategory.SIMPLE, QueryCategory.KNOWLEDGE):
            core_tools = {"calculator", "get_current_time"}
            tools = tool_registry.get_schemas(core_tools)
        elif category == QueryCategory.FULL:
            tools = tool_registry.get_schemas()  # All tools
        else:
            # Use category-specific tools
            tool_names = get_tools_for_category(category)
            tools = tool_registry.get_schemas(tool_names)
        
        logger.debug(f"Loading {len(tools)} tools for category {category.value}")
        return tools, prompt
    
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
        # Build messages list
        messages = conversation_history.copy() if conversation_history else []
        messages.append(ChatMessage(role="user", content=user_message))
        
        # Get appropriate tools and base prompt for this query
        tools, base_prompt = self._get_tools_for_query(user_message)
        
        # Build full system prompt with relevant chat summaries (semantic search)
        system_prompt = await self._build_system_prompt(base_prompt, user_message)
        
        yield OrchestratorEvent(type="start")
        
        full_response = ""
        iteration = 0
        
        while iteration < self.max_tool_iterations:
            iteration += 1
            
            try:
                pending_tool_calls: list[ToolCall] = []
                current_text = ""
                
                # Stream response from LLM
                async for event in self.llm_provider.chat_stream(
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
        
        if iteration >= self.max_tool_iterations:
            logger.warning(f"Max tool iterations ({self.max_tool_iterations}) reached")
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

