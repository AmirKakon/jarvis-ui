"""Query classifier to determine which tools are needed for a given query."""
import re
from enum import Enum
from typing import Set


class QueryCategory(Enum):
    """Categories of queries that determine which tools to load."""
    SIMPLE = "simple"           # Greetings, simple questions - no tools needed
    KNOWLEDGE = "knowledge"     # Factual questions - no tools needed
    TIME_CALC = "time_calc"     # Time/date or math - basic tools only
    SYSTEM = "system"           # System status, docker, services
    MEDIA = "media"             # Jellyfin queries
    N8N = "n8n"                 # n8n workflow management
    MEMORY = "memory"           # Memory operations
    SSH = "ssh"                 # SSH/command execution
    FULL = "full"               # Unclear - send all tools


# Tool groups
TOOL_GROUPS = {
    QueryCategory.SIMPLE: [],
    QueryCategory.KNOWLEDGE: [],
    QueryCategory.TIME_CALC: ["calculator", "get_current_time"],
    QueryCategory.SYSTEM: [
        "calculator", "get_current_time",
        "system_status", "docker_control", "service_control"
    ],
    QueryCategory.MEDIA: [
        "calculator", "get_current_time",
        "jellyfin_api"
    ],
    QueryCategory.N8N: [
        "n8n_workflow_list", "n8n_workflow_get", "n8n_workflow_create",
        "n8n_workflow_update", "n8n_workflow_delete", "n8n_workflow_activate",
        "n8n_workflow_deactivate", "n8n_workflow_execute"
    ],
    QueryCategory.MEMORY: [
        "add_memory", "memory_governance", "memory_deduplication"
    ],
    QueryCategory.SSH: [
        "ssh_command", "gemini_cli"
    ],
    QueryCategory.FULL: None,  # None means all tools
}


# Keyword patterns for classification
PATTERNS = {
    QueryCategory.TIME_CALC: [
        r"\btime\b", r"\bdate\b", r"\bclock\b", r"\btoday\b",
        r"\bcalculate\b", r"\bmath\b", r"\bcompute\b",
        r"\d+\s*[\+\-\*\/\^]\s*\d+",  # Math expressions
        r"\bsquared?\b", r"\bsqrt\b", r"\broot\b",
        r"\bwhat\s+is\s+\d+", r"\bhow\s+much\s+is\b",
    ],
    QueryCategory.SYSTEM: [
        r"\bsystem\b", r"\bcpu\b", r"\bmemory\b", r"\bram\b",
        r"\bdisk\b", r"\buptime\b", r"\bprocess\b", r"\bnetwork\b",
        r"\bdocker\b", r"\bcontainer\b", r"\bservice\b", r"\bsystemd\b",
        r"\bserver\b", r"\bstatus\b", r"\bhealth\b",
        r"\bstart\b.*\bservice\b", r"\bstop\b.*\bservice\b",
        r"\brestart\b.*\b(service|container|docker)\b",
    ],
    QueryCategory.MEDIA: [
        r"\bjellyfin\b", r"\bmedia\b", r"\bmovie\b", r"\bshow\b",
        r"\bvideo\b", r"\bstream\b", r"\blibrary\b", r"\bplaying\b",
        r"\bsession\b.*\bactive\b", r"\bwhat\s+(is|are)\s+(being\s+)?watch",
    ],
    QueryCategory.N8N: [
        r"\bn8n\b", r"\bworkflow\b", r"\bautomation\b",
        r"\bactivate\b.*\bworkflow\b", r"\bdeactivate\b.*\bworkflow\b",
        r"\bcreate\b.*\bworkflow\b", r"\blist\b.*\bworkflow\b",
    ],
    QueryCategory.MEMORY: [
        r"\bremember\b", r"\bmemory\b", r"\bforget\b",
        r"\bsave\b.*\b(this|that|it)\b", r"\bstore\b",
        r"\brecall\b", r"\bwhat\s+do\s+you\s+(know|remember)\b",
    ],
    QueryCategory.SSH: [
        r"\bssh\b", r"\bcommand\b", r"\bexecute\b", r"\brun\b",
        r"\bgemini\b", r"\bterminal\b", r"\bshell\b",
    ],
    QueryCategory.SIMPLE: [
        r"^(hi|hello|hey|good\s+(morning|afternoon|evening)|greetings)",
        r"^(thanks|thank\s+you|bye|goodbye|dismiss|that\s+will\s+be\s+all)",
        r"^(how\s+are\s+you|what'?s\s+up)",
    ],
    QueryCategory.KNOWLEDGE: [
        r"^(what|who|when|where|why|how)\s+(is|are|was|were|did|does|do)\b",
        r"\b(explain|describe|tell\s+me\s+about|define)\b",
        r"\b(capital|president|population|country|city)\b",
        r"\b(compare|difference|between)\b",
        r"\bpros\s+and\s+cons\b",
    ],
}


def classify_query(query: str) -> QueryCategory:
    """
    Classify a query to determine which tools are needed.
    
    Args:
        query: The user's query text
        
    Returns:
        QueryCategory indicating which tool group to use
    """
    query_lower = query.lower().strip()
    
    # Check patterns in priority order
    priority_order = [
        # Check explicit tool mentions first
        QueryCategory.N8N,
        QueryCategory.SYSTEM,
        QueryCategory.MEDIA,
        QueryCategory.SSH,
        QueryCategory.MEMORY,
        QueryCategory.TIME_CALC,
        # Then check simple patterns
        QueryCategory.SIMPLE,
        QueryCategory.KNOWLEDGE,
    ]
    
    for category in priority_order:
        patterns = PATTERNS.get(category, [])
        for pattern in patterns:
            if re.search(pattern, query_lower, re.IGNORECASE):
                return category
    
    # Default to FULL if unclear
    return QueryCategory.FULL


def get_tools_for_category(category: QueryCategory) -> Set[str]:
    """
    Get the set of tool names for a given category.
    
    Args:
        category: The query category
        
    Returns:
        Set of tool names, or None for all tools
    """
    return TOOL_GROUPS.get(category)


def get_tools_for_query(query: str) -> Set[str]:
    """
    Convenience function to get tools needed for a query.
    
    Args:
        query: The user's query text
        
    Returns:
        Set of tool names, or None for all tools
    """
    category = classify_query(query)
    return get_tools_for_category(category), category


# Quick test
if __name__ == "__main__":
    test_queries = [
        "Hello, Jarvis!",
        "What is the capital of France?",
        "What time is it?",
        "Calculate 256 squared",
        "List docker containers",
        "Check system status",
        "What's playing on Jellyfin?",
        "List n8n workflows",
        "Remember that my birthday is January 15",
        "Run the command ls -la",
    ]
    
    for q in test_queries:
        tools, category = get_tools_for_query(q)
        print(f"Query: {q}")
        print(f"  Category: {category.value}")
        print(f"  Tools: {tools if tools else 'ALL'}")
        print()

