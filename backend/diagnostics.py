"""
Jarvis UI Diagnostics Script
Tests different prompt types and measures response times.

Usage:
    python diagnostics.py [--host HOST] [--port PORT]
"""

import asyncio
import json
import time
import argparse
import websockets
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime
import statistics

# Colors for terminal output
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    
    # ASCII-safe symbols for Windows compatibility
    CHECK = '[OK]'
    CROSS = '[FAIL]'


@dataclass
class TestResult:
    """Result of a single test."""
    name: str
    prompt: str
    success: bool
    total_time_ms: float
    time_to_first_token_ms: Optional[float] = None
    time_to_complete_ms: Optional[float] = None
    token_count: int = 0
    tool_calls: list = field(default_factory=list)
    tool_results: list = field(default_factory=list)
    response: str = ""
    error: Optional[str] = None
    
    def __str__(self):
        status = f"{Colors.GREEN}{Colors.CHECK}{Colors.ENDC}" if self.success else f"{Colors.RED}{Colors.CROSS}{Colors.ENDC}"
        lines = [
            f"\n{Colors.BOLD}Test: {self.name}{Colors.ENDC}",
            f"Status: {status}",
            f"Prompt: {self.prompt[:60]}{'...' if len(self.prompt) > 60 else ''}",
        ]
        
        if self.success:
            lines.extend([
                f"Total Time: {Colors.CYAN}{self.total_time_ms:.0f}ms{Colors.ENDC}",
            ])
            if self.time_to_first_token_ms:
                lines.append(f"Time to First Token: {Colors.CYAN}{self.time_to_first_token_ms:.0f}ms{Colors.ENDC}")
            if self.token_count > 0:
                lines.append(f"Tokens: {self.token_count}")
            if self.tool_calls:
                lines.append(f"Tool Calls: {', '.join(self.tool_calls)}")
            if self.tool_results:
                for tool, result in self.tool_results:
                    status = result.get('status', 'unknown')
                    status_color = Colors.GREEN if status == 'success' else Colors.RED
                    lines.append(f"  - {tool}: {status_color}{status}{Colors.ENDC}")
        else:
            lines.append(f"Error: {Colors.RED}{self.error}{Colors.ENDC}")
        
        # Show truncated response (ASCII-safe)
        if self.response:
            # Replace non-ASCII characters to avoid Windows encoding issues
            response_preview = self.response[:200].replace('\n', ' ')
            response_preview = response_preview.encode('ascii', 'replace').decode('ascii')
            if len(self.response) > 200:
                response_preview += '...'
            lines.append(f"Response: {response_preview}")
        
        return '\n'.join(lines)


async def run_websocket_test(
    ws_url: str,
    session_id: str,
    prompt: str,
    test_name: str,
    timeout: float = 120.0
) -> TestResult:
    """Run a single WebSocket test with timing."""
    
    start_time = time.time()
    first_token_time = None
    tokens = []
    tool_calls = []
    tool_results = []
    full_response = ""
    error = None
    
    try:
        async with websockets.connect(ws_url, ping_timeout=None) as ws:
            # Send the message
            await ws.send(json.dumps({
                "type": "message",
                "content": prompt
            }))
            
            # Listen for responses
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=timeout)
                    data = json.loads(msg)
                    msg_type = data.get("type")
                    
                    if msg_type == "stream_token":
                        if first_token_time is None:
                            first_token_time = time.time()
                        tokens.append(data.get("content", ""))
                    
                    elif msg_type == "tool_call":
                        tool_calls.append(data.get("tool", "unknown"))
                    
                    elif msg_type == "tool_result":
                        tool_name = data.get("tool", "unknown")
                        result = data.get("result", {})
                        tool_results.append((tool_name, result))
                    
                    elif msg_type == "stream_end":
                        full_response = data.get("content", "") or "".join(tokens)
                        break
                    
                    elif msg_type == "error":
                        error = data.get("content", "Unknown error")
                        break
                    
                    elif msg_type in ["message", "typing", "stream_start"]:
                        # These are expected intermediate messages
                        continue
                    
                except asyncio.TimeoutError:
                    error = f"Timeout after {timeout}s"
                    break
        
        end_time = time.time()
        total_time_ms = (end_time - start_time) * 1000
        ttft_ms = (first_token_time - start_time) * 1000 if first_token_time else None
        
        return TestResult(
            name=test_name,
            prompt=prompt,
            success=error is None,
            total_time_ms=total_time_ms,
            time_to_first_token_ms=ttft_ms,
            token_count=len(tokens),
            tool_calls=tool_calls,
            tool_results=tool_results,
            response=full_response,
            error=error,
        )
    
    except Exception as e:
        end_time = time.time()
        return TestResult(
            name=test_name,
            prompt=prompt,
            success=False,
            total_time_ms=(end_time - start_time) * 1000,
            error=str(e),
        )


async def run_diagnostics(host: str, port: int, session_id: str = "diagnostics-test", category_filter: str = None):
    """Run all diagnostic tests."""
    
    ws_url = f"ws://{host}:{port}/ws/{session_id}"
    
    print(f"\n{Colors.HEADER}{'='*60}{Colors.ENDC}")
    print(f"{Colors.HEADER}JARVIS UI DIAGNOSTICS{Colors.ENDC}")
    print(f"{Colors.HEADER}{'='*60}{Colors.ENDC}")
    print(f"Host: {host}:{port}")
    print(f"WebSocket URL: {ws_url}")
    print(f"Session ID: {session_id}")
    if category_filter:
        print(f"Category Filter: {category_filter}")
    print(f"Time: {datetime.now().isoformat()}")
    
    # Define test cases
    test_cases = [
        # Simple Q&A - No tools
        {
            "name": "Simple Greeting",
            "prompt": "Hello, Jarvis!",
            "category": "Simple Q&A",
        },
        {
            "name": "Simple Question",
            "prompt": "What is your name and what can you do?",
            "category": "Simple Q&A",
        },
        {
            "name": "Knowledge Question",
            "prompt": "What is the capital of France?",
            "category": "Simple Q&A",
        },
        
        # Built-in Tools (fast)
        {
            "name": "Calculator Tool",
            "prompt": "What is 42 * 17 + 365?",
            "category": "Built-in Tools",
        },
        {
            "name": "Time Tool",
            "prompt": "What time is it now?",
            "category": "Built-in Tools",
        },
        
        # N8N Tools (infrastructure)
        {
            "name": "System Status - All",
            "prompt": "Get the system status overview",
            "category": "N8N Tools",
        },
        {
            "name": "Docker List",
            "prompt": "List all Docker containers",
            "category": "N8N Tools",
        },
        {
            "name": "Service Status",
            "prompt": "Check if the Docker service is running",
            "category": "N8N Tools",
        },
        
        # Complex/Thinking prompts
        {
            "name": "Step-by-Step Analysis",
            "prompt": "Explain step by step how to set up a new Docker container for a PostgreSQL database with persistent storage",
            "category": "Complex Thinking",
        },
        {
            "name": "Technical Comparison",
            "prompt": "Compare the pros and cons of using SQLite vs PostgreSQL for a small home automation project. Be concise.",
            "category": "Complex Thinking",
        },
        
        # Memory operations (if available)
        # Note: Memory tools may not be fully implemented yet
        
        # Multi-tool scenarios
        {
            "name": "Multi-Info Request",
            "prompt": "What time is it and what is 256 squared?",
            "category": "Multi-Tool",
        },
    ]
    
    results = []
    categories = {}
    
    for test_case in test_cases:
        category = test_case["category"]
        
        # Skip if category filter is set and doesn't match
        if category_filter and category_filter.lower() not in category.lower():
            continue
        
        if category not in categories:
            categories[category] = []
            print(f"\n{Colors.YELLOW}--- {category} ---{Colors.ENDC}")
        
        print(f"\nRunning: {test_case['name']}...", end="", flush=True)
        
        result = await run_websocket_test(
            ws_url=ws_url,
            session_id=f"{session_id}-{len(results)}",
            prompt=test_case["prompt"],
            test_name=test_case["name"],
        )
        
        results.append(result)
        categories[category].append(result)
        
        # Quick status
        if result.success:
            print(f" {Colors.GREEN}OK{Colors.ENDC} ({result.total_time_ms:.0f}ms)")
        else:
            print(f" {Colors.RED}FAIL{Colors.ENDC}")
        
        # Small delay between tests
        await asyncio.sleep(0.5)
    
    # Print detailed results
    print(f"\n{Colors.HEADER}{'='*60}{Colors.ENDC}")
    print(f"{Colors.HEADER}DETAILED RESULTS{Colors.ENDC}")
    print(f"{Colors.HEADER}{'='*60}{Colors.ENDC}")
    
    for result in results:
        print(result)
    
    # Print summary by category
    print(f"\n{Colors.HEADER}{'='*60}{Colors.ENDC}")
    print(f"{Colors.HEADER}SUMMARY BY CATEGORY{Colors.ENDC}")
    print(f"{Colors.HEADER}{'='*60}{Colors.ENDC}")
    
    for category, cat_results in categories.items():
        successful = [r for r in cat_results if r.success]
        failed = [r for r in cat_results if not r.success]
        
        print(f"\n{Colors.BOLD}{category}{Colors.ENDC}")
        print(f"  Tests: {len(cat_results)} | Pass: {Colors.GREEN}{len(successful)}{Colors.ENDC} | Fail: {Colors.RED}{len(failed)}{Colors.ENDC}")
        
        if successful:
            times = [r.total_time_ms for r in successful]
            ttft_times = [r.time_to_first_token_ms for r in successful if r.time_to_first_token_ms]
            
            print(f"  Total Time: min={min(times):.0f}ms | avg={statistics.mean(times):.0f}ms | max={max(times):.0f}ms")
            if ttft_times:
                print(f"  TTFT: min={min(ttft_times):.0f}ms | avg={statistics.mean(ttft_times):.0f}ms | max={max(ttft_times):.0f}ms")
    
    # Overall summary
    all_successful = [r for r in results if r.success]
    all_failed = [r for r in results if not r.success]
    
    print(f"\n{Colors.HEADER}{'='*60}{Colors.ENDC}")
    print(f"{Colors.HEADER}OVERALL SUMMARY{Colors.ENDC}")
    print(f"{Colors.HEADER}{'='*60}{Colors.ENDC}")
    print(f"Total Tests: {len(results)}")
    print(f"Passed: {Colors.GREEN}{len(all_successful)}{Colors.ENDC}")
    print(f"Failed: {Colors.RED}{len(all_failed)}{Colors.ENDC}")
    
    if all_successful:
        all_times = [r.total_time_ms for r in all_successful]
        all_ttft = [r.time_to_first_token_ms for r in all_successful if r.time_to_first_token_ms]
        
        print(f"\nResponse Times (successful tests):")
        print(f"  Min: {min(all_times):.0f}ms")
        print(f"  Avg: {statistics.mean(all_times):.0f}ms")
        print(f"  Max: {max(all_times):.0f}ms")
        
        if all_ttft:
            print(f"\nTime to First Token:")
            print(f"  Min: {min(all_ttft):.0f}ms")
            print(f"  Avg: {statistics.mean(all_ttft):.0f}ms")
            print(f"  Max: {max(all_ttft):.0f}ms")
    
    if all_failed:
        print(f"\n{Colors.RED}Failed Tests:{Colors.ENDC}")
        for r in all_failed:
            print(f"  - {r.name}: {r.error}")
    
    # Tool execution summary
    all_tool_calls = []
    all_tool_results = []
    for r in results:
        all_tool_calls.extend(r.tool_calls)
        all_tool_results.extend(r.tool_results)
    
    if all_tool_calls:
        print(f"\n{Colors.CYAN}Tool Usage:{Colors.ENDC}")
        tool_counts = {}
        for tool in all_tool_calls:
            tool_counts[tool] = tool_counts.get(tool, 0) + 1
        for tool, count in sorted(tool_counts.items()):
            print(f"  - {tool}: {count} calls")
        
        # Tool success rate
        tool_success = {}
        tool_fail = {}
        for tool, result in all_tool_results:
            status = result.get('status', 'unknown')
            if status == 'success':
                tool_success[tool] = tool_success.get(tool, 0) + 1
            else:
                tool_fail[tool] = tool_fail.get(tool, 0) + 1
        
        print(f"\n{Colors.CYAN}Tool Success Rates:{Colors.ENDC}")
        all_tools = set(list(tool_success.keys()) + list(tool_fail.keys()))
        for tool in sorted(all_tools):
            s = tool_success.get(tool, 0)
            f = tool_fail.get(tool, 0)
            total = s + f
            rate = (s / total * 100) if total > 0 else 0
            color = Colors.GREEN if rate == 100 else (Colors.YELLOW if rate > 0 else Colors.RED)
            print(f"  - {tool}: {color}{rate:.0f}%{Colors.ENDC} ({s}/{total})")
    
    print(f"\n{Colors.HEADER}{'='*60}{Colors.ENDC}")
    print("Diagnostics complete!")
    
    return results


async def main():
    parser = argparse.ArgumentParser(description="Jarvis UI Diagnostics")
    parser.add_argument("--host", default="localhost", help="Backend host")
    parser.add_argument("--port", type=int, default=20005, help="Backend port")
    parser.add_argument("--session", default=f"diag-{int(time.time())}", help="Session ID")
    parser.add_argument("--category", "-c", help="Filter by category (e.g., 'Simple Q&A', 'Built-in Tools', 'N8N Tools')")
    
    args = parser.parse_args()
    
    await run_diagnostics(args.host, args.port, args.session, args.category)


if __name__ == "__main__":
    asyncio.run(main())

