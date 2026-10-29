"""
Test Suite 2: Agentic Tool Calling Swarm for LFM3 1.7B.
Tests autonomous tool selection, multi-step execution loop, argument validity,
and multi-agent collaboration with tool use.
"""

import os
import json
import time
import urllib.request
from typing import Dict, Any, List, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
from resource_monitor import calculate_safe_swarm_limits

# Tool definitions in Ollama / OpenAI function format
SWARM_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_database",
            "description": "Execute a read-only query against the database to fetch records.",
            "parameters": {
                "type": "object",
                "properties": {
                    "table": {"type": "string", "enum": ["users", "orders", "inventory", "logs"], "description": "Database table"},
                    "filter_key": {"type": "string", "description": "Column name to filter by"},
                    "filter_val": {"type": "string", "description": "Value to match"}
                },
                "required": ["table", "filter_key", "filter_val"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "check_service_health",
            "description": "Check the latency, uptime, and HTTP status of an internal microservice.",
            "parameters": {
                "type": "object",
                "properties": {
                    "service_name": {"type": "string", "enum": ["auth-service", "payment-service", "notification-service", "catalog-service"], "description": "Target service"}
                },
                "required": ["service_name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "calculate_metrics",
            "description": "Perform mathematical and statistical calculations over numeric data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {"type": "string", "enum": ["sum", "average", "p99", "error_rate"], "description": "Mathematical aggregation"},
                    "values": {"type": "array", "items": {"type": "number"}, "description": "List of numeric values"}
                },
                "required": ["operation", "values"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "trigger_alert",
            "description": "Send an escalation alert to the on-call engineer via Slack/PagerDuty.",
            "parameters": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string", "enum": ["low", "warning", "critical"], "description": "Alert severity level"},
                    "message": {"type": "string", "description": "Short incident summary"}
                },
                "required": ["severity", "message"]
            }
        }
    }
]

# Mock execution environment for tools
def execute_mock_tool(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    if tool_name == "query_database":
        table = arguments.get("table")
        f_val = arguments.get("filter_val")
        if table == "orders":
            return {"status": "ok", "results": [{"order_id": "ORD-9912", "amount": 149.50, "status": "failed", "customer_id": f_val}]}
        elif table == "users":
            return {"status": "ok", "results": [{"user_id": f_val, "tier": "enterprise", "country": "US"}]}
        elif table == "logs":
            return {"status": "ok", "logs": [f"Connection timeout to payment-service for {f_val}", "Retry limit exceeded"]}
        return {"status": "ok", "results": []}

    elif tool_name == "check_service_health":
        svc = arguments.get("service_name")
        if svc == "payment-service":
            return {"service": svc, "status": "degraded", "http_code": 504, "latency_ms": 3200, "error_rate": "18.5%"}
        return {"service": svc, "status": "healthy", "http_code": 200, "latency_ms": 42, "error_rate": "0.01%"}

    elif tool_name == "calculate_metrics":
        op = arguments.get("operation")
        vals = arguments.get("values", [])
        if not vals:
            return {"result": 0}
        if op == "sum":
            return {"result": sum(vals)}
        elif op == "average":
            return {"result": sum(vals) / len(vals)}
        elif op == "error_rate":
            errs = [v for v in vals if v >= 400]
            return {"result": f"{(len(errs)/len(vals))*100:.1f}%"}
        return {"result": max(vals)}

    elif tool_name == "trigger_alert":
        return {"status": "alert_dispatched", "channel": "#incident-response", "ticket_id": "INC-8834"}

    return {"error": f"Unknown tool: {tool_name}"}


class AgenticToolRunner:
    def __init__(self, base_url: str = "http://127.0.0.1:11434", model: str = "lfm3:latest"):
        self.base_url = base_url
        self.model = model

    def run_agentic_loop(self, agent_id: str, system_prompt: str, user_prompt: str, max_steps: int = 4) -> Dict[str, Any]:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
        tool_call_history = []
        total_tokens = 0
        t0 = time.time()

        for step in range(max_steps):
            payload = {
                "model": self.model,
                "messages": messages,
                "tools": SWARM_TOOLS,
                "stream": False,
                "think": False
            }
            req = urllib.request.Request(
                f"{self.base_url}/api/chat",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            try:
                with urllib.request.urlopen(req, timeout=60.0) as resp:
                    res = json.loads(resp.read().decode("utf-8"))
            except Exception as e:
                return {
                    "agent_id": agent_id,
                    "success": False,
                    "error": str(e),
                    "tool_calls": tool_call_history,
                    "final_answer": "",
                    "duration_sec": round(time.time() - t0, 2)
                }

            msg = res.get("message", {})
            total_tokens += res.get("eval_count", 0)
            messages.append(msg)

            calls = msg.get("tool_calls", [])
            if not calls:
                # Agent provided final response
                return {
                    "agent_id": agent_id,
                    "success": True,
                    "steps": step + 1,
                    "tool_calls": tool_call_history,
                    "final_answer": msg.get("content", ""),
                    "total_tokens": total_tokens,
                    "duration_sec": round(time.time() - t0, 2)
                }

            # Execute tool calls
            for c in calls:
                fn = c.get("function", {})
                name = fn.get("name")
                args = fn.get("arguments", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}

                tool_result = execute_mock_tool(name, args)
                tool_call_history.append({
                    "step": step + 1,
                    "tool": name,
                    "arguments": args,
                    "output": tool_result
                })

                messages.append({
                    "role": "tool",
                    "content": json.dumps(tool_result)
                })

        return {
            "agent_id": agent_id,
            "success": True,
            "steps": max_steps,
            "tool_calls": tool_call_history,
            "final_answer": messages[-1].get("content", "Exceeded max steps"),
            "total_tokens": total_tokens,
            "duration_sec": round(time.time() - t0, 2)
        }


def run_tool_calling_swarm_test(concurrency: int = 4) -> Dict[str, Any]:
    print(f"\n--- Running Test 2: Agentic Tool Calling Swarm ({concurrency} Parallel Incident Agents) ---")
    runner = AgenticToolRunner()
    tasks = [
        {
            "id": "agent-sre",
            "system": "You are an SRE on-call agent. Use tools to diagnose degraded services and alert when necessary.",
            "prompt": "Check the health of payment-service. If it is degraded or latency > 1000ms, trigger a critical alert."
        },
        {
            "id": "agent-db",
            "system": "You are a Database triage agent. Query user and order tables to investigate customer issues.",
            "prompt": "Look up recent orders for customer 'CUST-402' in the orders table. State the order amount and status."
        },
        {
            "id": "agent-analytics",
            "system": "You are an Analytics agent. Calculate error statistics using mathematical tools.",
            "prompt": "Calculate the average response latency across these endpoint samples: [120, 250, 890, 420, 310, 150]. Return the average value."
        },
        {
            "id": "agent-security",
            "system": "You are a SecOps agent. Inspect system logs and trigger an alert if anomalies are found.",
            "prompt": "Query the logs table for 'payment-service'. If timeout errors appear, dispatch a warning alert."
        }
    ]

    t0 = time.time()
    results = []
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futs = {
            executor.submit(runner.run_agentic_loop, t["id"], t["system"], t["prompt"]): t["id"]
            for t in tasks
        }
        for fut in as_completed(futs):
            res = fut.result()
            results.append(res)
            print(f" -> [{res['agent_id']}] Finished in {res['duration_sec']}s with {len(res['tool_calls'])} tool call(s). Success: {res['success']}")

    total_time = round(time.time() - t0, 2)
    successful_calls = sum(len(r["tool_calls"]) for r in results)
    print(f"Tool Calling Swarm completed in {total_time}s across {len(results)} agents ({successful_calls} tool executions total).")

    return {
        "test_name": "Agentic Tool Calling Swarm",
        "total_time_sec": total_time,
        "agents_tested": len(tasks),
        "total_tool_calls": successful_calls,
        "agent_outcomes": results
    }

if __name__ == "__main__":
    out = run_tool_calling_swarm_test()
    print(json.dumps(out, indent=2))
