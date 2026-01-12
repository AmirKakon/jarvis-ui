"""Tool Registry for managing available tools for the LLM."""
import json
import logging
import math
from datetime import datetime
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo
import httpx

from config import get_settings

logger = logging.getLogger(__name__)


class ToolRegistry:
    """Registry of all available tools for the LLM."""
    
    # Map tool names to n8n workflow IDs for direct API calls
    N8N_WORKFLOW_IDS = {
        "system_status": "7LHGwHNVnfFNR7Dz",
        "docker_control": "oj51dGKjapXRP91r",
        "service_control": "EmRfZ7kbqyAIbz4m",
        "jellyfin_api": "JlhBPAIfI8WHfCsj",
        "ssh_command": "TTqKNvyugLWoVF08",
        "gemini_cli": "anunjMp26km77JN7",
        "add_memory": "sCcmYT1ufy8hrHMA",
        "memory_governance": "dUc4LsfxP25i11wD",
        "memory_deduplication": "07RhLX2UKvMjY1cr",
        "n8n_workflow_list": "Qa93D3eLsEyc8lP8",
        "n8n_workflow_get": "pnlb3Sp3BsBxRMwo",
        "n8n_workflow_create": "rmHtxGxBYPtmotHz",
        "n8n_workflow_update": "HGtPmkUCzYOy3lo1",
        "n8n_workflow_delete": "BMvwGw7h9cRylQUE",
        "n8n_workflow_activate": "GKM344aryPP29f2O",
        "n8n_workflow_deactivate": "OMqZ93GtwiWTuXne",
        "n8n_workflow_execute": "eEtS2fTRa7FA8wAl",
    }
    
    def __init__(self):
        self.settings = get_settings()
        self.n8n_url = self.settings.n8n_tool_executor_url
        self.n8n_api_url = self.settings.n8n_api_url
        self.n8n_api_key = self.settings.n8n_api_key
        self.n8n_timeout = self.settings.n8n_timeout_seconds
        self.tools: dict[str, Callable] = {}
        self.tool_schemas: list[dict] = []
        self._register_all_tools()
    
    def _register_all_tools(self):
        """Register all available tools."""
        # Built-in Python tools
        self._register_builtin_tools()
        
        # n8n infrastructure tools (only if n8n URL is configured)
        if self.n8n_url:
            self._register_n8n_tools()
    
    def _register_builtin_tools(self):
        """Register Python-native tools."""
        # Calculator
        self.tools["calculator"] = self._calculator
        self.tool_schemas.append({
            "type": "function",
            "function": {
                "name": "calculator",
                "description": "Perform mathematical calculations. Supports basic arithmetic, powers, roots, and common math functions.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": {
                            "type": "string",
                            "description": "Mathematical expression to evaluate (e.g., '2 + 2', 'sqrt(16)', '3 ** 4')"
                        }
                    },
                    "required": ["expression"]
                }
            }
        })
        
        # Get current time
        self.tools["get_current_time"] = self._get_current_time
        self.tool_schemas.append({
            "type": "function",
            "function": {
                "name": "get_current_time",
                "description": "Get the current date and time. Default timezone is Asia/Jerusalem.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "timezone": {
                            "type": "string",
                            "description": "Timezone name (e.g., 'UTC', 'America/New_York', 'Asia/Jerusalem')"
                        }
                    }
                }
            }
        })
    
    def _register_n8n_tools(self):
        """Register tools that call n8n Tool Executor workflow."""
        
        # System Status
        self.tools["system_status"] = self._make_n8n_tool("system_status")
        self.tool_schemas.append({
            "type": "function",
            "function": {
                "name": "system_status",
                "description": "Get system information: CPU, memory, disk, network, processes, or uptime from the server.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "infoType": {
                            "type": "string",
                            "enum": ["cpu", "memory", "disk", "network", "processes", "uptime", "all"],
                            "description": "Type of system info to retrieve. Use 'all' for a complete overview."
                        }
                    },
                    "required": ["infoType"]
                }
            }
        })
        
        # Docker Control
        self.tools["docker_control"] = self._make_n8n_tool("docker_control")
        self.tool_schemas.append({
            "type": "function",
            "function": {
                "name": "docker_control",
                "description": "Manage Docker containers: list, start, stop, restart, view logs, inspect, and more.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["ps", "list", "running", "stats", "logs", "start", "stop", "restart", "inspect", "images", "volumes", "networks", "compose-ps"],
                            "description": "Docker operation to perform"
                        },
                        "containerName": {
                            "type": "string",
                            "description": "Container name (required for logs, start, stop, restart, inspect)"
                        }
                    },
                    "required": ["action"]
                }
            }
        })
        
        # Service Control
        self.tools["service_control"] = self._make_n8n_tool("service_control")
        self.tool_schemas.append({
            "type": "function",
            "function": {
                "name": "service_control",
                "description": "Manage systemd services: check status, start, stop, restart, enable, disable, list, and view logs.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["status", "start", "stop", "restart", "enable", "disable", "list", "failed", "logs"],
                            "description": "Service operation to perform"
                        },
                        "serviceName": {
                            "type": "string",
                            "description": "Service name (required for status, start, stop, restart, enable, disable, logs)"
                        }
                    },
                    "required": ["action"]
                }
            }
        })
        
        # Jellyfin API
        self.tools["jellyfin_api"] = self._make_n8n_tool("jellyfin_api")
        self.tool_schemas.append({
            "type": "function",
            "function": {
                "name": "jellyfin_api",
                "description": "Interact with Jellyfin media server: get status, users, sessions, libraries, search media, trigger scans.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["status", "info", "health", "users", "sessions", "libraries", "items", "scan", "refresh", "activity", "scheduled-tasks", "search", "playing", "logs"],
                            "description": "Jellyfin API operation to perform"
                        },
                        "params": {
                            "type": "string",
                            "description": "Optional JSON string with additional parameters (e.g., for search: {\"query\": \"movie name\"})"
                        }
                    },
                    "required": ["action"]
                }
            }
        })
        
        # SSH Command
        self.tools["ssh_command"] = self._make_n8n_tool("ssh_command")
        self.tool_schemas.append({
            "type": "function",
            "function": {
                "name": "ssh_command",
                "description": "Execute an SSH command with sudo privileges on the server. Use with caution.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The command to execute (without sudo prefix, it will be added automatically)"
                        }
                    },
                    "required": ["command"]
                }
            }
        })
        
        # Gemini CLI
        self.tools["gemini_cli"] = self._make_n8n_tool("gemini_cli")
        self.tool_schemas.append({
            "type": "function",
            "function": {
                "name": "gemini_cli",
                "description": "Execute a query using the Gemini CLI on the server. Useful for AI-powered analysis of logs, code, or data.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": {
                            "type": "string",
                            "description": "The prompt/query to send to Gemini"
                        }
                    },
                    "required": ["prompt"]
                }
            }
        })
        
        # N8N Workflow Management Tools
        n8n_workflow_actions = [
            ("n8n_workflow_list", "List all n8n workflows", {"activeOnly": {"type": "boolean", "description": "Filter to only active workflows"}}),
            ("n8n_workflow_get", "Get details of a specific n8n workflow", {"workflowId": {"type": "string", "description": "The workflow ID to retrieve"}}),
            ("n8n_workflow_create", "Create a new n8n workflow from JSON definition", {"workflowJson": {"type": "object", "description": "Complete workflow definition with name, nodes, connections, settings"}}),
            ("n8n_workflow_update", "Update an existing n8n workflow", {"workflowId": {"type": "string"}, "workflowJson": {"type": "object"}}),
            ("n8n_workflow_delete", "Delete an n8n workflow", {"workflowId": {"type": "string", "description": "The workflow ID to delete"}}),
            ("n8n_workflow_activate", "Activate an n8n workflow", {"workflowId": {"type": "string", "description": "The workflow ID to activate"}}),
            ("n8n_workflow_deactivate", "Deactivate an n8n workflow", {"workflowId": {"type": "string", "description": "The workflow ID to deactivate"}}),
            ("n8n_workflow_execute", "Execute an n8n workflow manually", {"workflowId": {"type": "string"}, "inputData": {"type": "object", "description": "Optional input data for the workflow"}}),
        ]
        
        for tool_name, description, params in n8n_workflow_actions:
            self.tools[tool_name] = self._make_n8n_tool(tool_name)
            required = [k for k, v in params.items() if "workflowId" in k or "workflowJson" in k]
            self.tool_schemas.append({
                "type": "function",
                "function": {
                    "name": tool_name,
                    "description": description,
                    "parameters": {
                        "type": "object",
                        "properties": params,
                        "required": required if required else []
                    }
                }
            })
    
    def _make_n8n_tool(self, tool_name: str) -> Callable:
        """Create a callable that invokes n8n workflow (via API or Tool Executor)."""
        async def call_n8n(params: dict) -> dict:
            # Prefer direct API calls if configured
            if self.n8n_api_url and self.n8n_api_key and tool_name in self.N8N_WORKFLOW_IDS:
                return await self._call_n8n_api(tool_name, params)
            
            # Fallback to Tool Executor webhook
            if self.n8n_url:
                return await self._call_tool_executor(tool_name, params)
            
            return {"status": "error", "error": "n8n not configured (set N8N_API_URL + N8N_API_KEY, or N8N_TOOL_EXECUTOR_URL)"}
        
        return call_n8n
    
    async def _call_n8n_api(self, tool_name: str, params: dict) -> dict:
        """Execute n8n workflow directly via API."""
        workflow_id = self.N8N_WORKFLOW_IDS.get(tool_name)
        if not workflow_id:
            return {"status": "error", "error": f"No workflow ID mapped for tool: {tool_name}"}
        
        url = f"{self.n8n_api_url}/workflows/{workflow_id}/run"
        headers = {"X-N8N-API-KEY": self.n8n_api_key}
        
        try:
            async with httpx.AsyncClient(timeout=self.n8n_timeout) as client:
                response = await client.post(url, json=params, headers=headers)
                response.raise_for_status()
                result = response.json()
                
                # Extract the actual result from n8n API response
                if isinstance(result, dict):
                    # n8n API returns data in a specific format
                    if "data" in result and "resultData" in result["data"]:
                        run_data = result["data"]["resultData"].get("runData", {})
                        # Get the last node's output
                        for node_name, node_runs in reversed(list(run_data.items())):
                            if node_runs and len(node_runs) > 0:
                                last_run = node_runs[-1]
                                if "data" in last_run and "main" in last_run["data"]:
                                    main_output = last_run["data"]["main"]
                                    if main_output and len(main_output) > 0 and len(main_output[0]) > 0:
                                        return {"status": "success", "tool": tool_name, "result": main_output[0][0].get("json", {})}
                    return {"status": "success", "tool": tool_name, "result": result}
                return {"status": "success", "tool": tool_name, "result": result}
        except httpx.TimeoutException:
            return {"status": "error", "error": f"Tool execution timed out after {self.n8n_timeout}s"}
        except httpx.HTTPStatusError as e:
            logger.error(f"n8n API error: {e.response.status_code} - {e.response.text}")
            return {"status": "error", "error": f"n8n API error: {e.response.status_code}"}
        except Exception as e:
            logger.error(f"n8n API call error: {e}")
            return {"status": "error", "error": str(e)}
    
    async def _call_tool_executor(self, tool_name: str, params: dict) -> dict:
        """Execute tool via n8n Tool Executor webhook."""
        try:
            async with httpx.AsyncClient(timeout=self.n8n_timeout) as client:
                response = await client.post(
                    self.n8n_url,
                    json={"tool": tool_name, "params": params},
                )
                return response.json()
        except httpx.TimeoutException:
            return {"status": "error", "error": f"Tool execution timed out after {self.n8n_timeout}s"}
        except Exception as e:
            logger.error(f"n8n tool executor error: {e}")
            return {"status": "error", "error": str(e)}
    
    async def _calculator(self, params: dict) -> dict:
        """Evaluate a mathematical expression safely."""
        expression = params.get("expression", "")
        
        # Safe math functions
        safe_dict = {
            "abs": abs,
            "round": round,
            "min": min,
            "max": max,
            "sum": sum,
            "pow": pow,
            "sqrt": math.sqrt,
            "sin": math.sin,
            "cos": math.cos,
            "tan": math.tan,
            "log": math.log,
            "log10": math.log10,
            "exp": math.exp,
            "pi": math.pi,
            "e": math.e,
        }
        
        try:
            # Remove potentially dangerous characters
            allowed_chars = set("0123456789+-*/().,%^ ")
            for func in safe_dict:
                allowed_chars.update(func)
            
            # Replace ^ with ** for power
            expression = expression.replace("^", "**")
            
            result = eval(expression, {"__builtins__": {}}, safe_dict)
            return {"status": "success", "result": result, "expression": expression}
        except Exception as e:
            return {"status": "error", "error": str(e)}
    
    async def _get_current_time(self, params: dict) -> dict:
        """Get the current date and time."""
        timezone_name = params.get("timezone", "Asia/Jerusalem")
        
        try:
            tz = ZoneInfo(timezone_name)
            now = datetime.now(tz)
            return {
                "status": "success",
                "datetime": now.isoformat(),
                "date": now.strftime("%Y-%m-%d"),
                "time": now.strftime("%H:%M:%S"),
                "day": now.strftime("%A"),
                "timezone": timezone_name,
            }
        except Exception as e:
            return {"status": "error", "error": str(e)}
    
    async def execute(self, tool_name: str, params: dict) -> dict:
        """Execute a tool by name."""
        if tool_name not in self.tools:
            return {"status": "error", "error": f"Unknown tool: {tool_name}"}
        
        try:
            tool_func = self.tools[tool_name]
            result = await tool_func(params)
            logger.info(f"Tool executed: {tool_name} -> {result.get('status', 'unknown')}")
            return result
        except Exception as e:
            logger.error(f"Tool execution error ({tool_name}): {e}")
            return {"status": "error", "error": str(e)}
    
    def get_schemas(self) -> list[dict]:
        """Return OpenAI-compatible tool schemas."""
        return self.tool_schemas
    
    def get_tool_names(self) -> list[str]:
        """Return list of available tool names."""
        return list(self.tools.keys())


# Global tool registry instance
tool_registry = ToolRegistry()

