"""
System Resource Monitor and Safe Swarm Sizing Calculator.
Determines safe bounds for swarm concurrency based on Apple Silicon / general hardware resources.
"""

import os
import subprocess
import re
from typing import Dict, Any

def get_system_metrics() -> Dict[str, Any]:
    """Inspects RAM, CPU cores, GPU architecture, and active memory pressure."""
    metrics: Dict[str, Any] = {
        "total_ram_gb": 0.0,
        "available_ram_gb": 0.0,
        "free_ram_gb": 0.0,
        "cpu_cores": os.cpu_count() or 4,
        "platform": "generic"
    }

    try:
        # Check macOS sysctl
        sysctl_out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip()
        total_bytes = int(sysctl_out)
        metrics["total_ram_gb"] = round(total_bytes / (1024**3), 2)
        metrics["platform"] = "apple_silicon"

        # Check vm_stat on macOS
        vm_out = subprocess.check_output(["vm_stat"], text=True)
        page_size_match = re.search(r"page size of (\d+) bytes", vm_out)
        page_size = int(page_size_match.group(1)) if page_size_match else 16384

        def extract_pages(key: str) -> int:
            m = re.search(rf"{key}:\s+(\d+)", vm_out)
            return int(m.group(1)) if m else 0

        free_pages = extract_pages("Pages free")
        inactive_pages = extract_pages("Pages inactive")
        speculative_pages = extract_pages("Pages speculative")
        purgeable_pages = extract_pages("Pages purgeable")

        # In macOS unified memory, free + inactive + speculative + purgeable represent reclaimable memory
        free_bytes = free_pages * page_size
        avail_bytes = (free_pages + inactive_pages + speculative_pages + purgeable_pages) * page_size
        metrics["free_ram_gb"] = round(free_bytes / (1024**3), 2)
        metrics["available_ram_gb"] = round(avail_bytes / (1024**3), 2)

    except Exception:
        # Fallback for Linux or cross-platform
        try:
            with open("/proc/meminfo", "r") as f:
                lines = f.readlines()
            meminfo = {}
            for line in lines:
                parts = line.split(":")
                if len(parts) == 2:
                    val = parts[1].strip().split()[0]
                    meminfo[parts[0].strip()] = int(val)
            metrics["total_ram_gb"] = round(meminfo.get("MemTotal", 0) / 1024**2, 2)
            metrics["available_ram_gb"] = round(meminfo.get("MemAvailable", meminfo.get("MemFree", 0)) / 1024**2, 2)
            metrics["free_ram_gb"] = round(meminfo.get("MemFree", 0) / 1024**2, 2)
        except Exception:
            metrics["total_ram_gb"] = 16.0
            metrics["available_ram_gb"] = 8.0
            metrics["free_ram_gb"] = 4.0

    return metrics


def calculate_safe_swarm_limits(
    model_name: str = "lfm3:latest",
    safety_margin_ratio: float = 0.25,
    per_agent_active_ram_gb: float = 0.25,
    base_model_ram_gb: float = 1.7
) -> Dict[str, Any]:
    """
    Calculates safe swarm sizing.
    For Ollama with lfm3 (nvfp4 MLX runner):
    - Base weights footprint: ~1.6 - 1.7 GB
    - Shared Model In-Memory Queue Mode: Base model stays in VRAM once; each concurrent request holds context KV cache & task state.
    - Safe concurrent active agents calculated dynamically from available unified RAM and CPU core count.
    """
    sys_metrics = get_system_metrics()
    avail_ram = sys_metrics["available_ram_gb"]
    cpu_cores = sys_metrics["cpu_cores"]

    # Budget after preserving safety margin for OS & UI
    usable_ram = max(0.5, avail_ram * (1.0 - safety_margin_ratio) - base_model_ram_gb)
    
    # Calculate max agents by RAM
    max_agents_ram = max(1, int(usable_ram / per_agent_active_ram_gb))
    
    # Core-based limit: swarms run best with thread pool 2x to 3x physical performance cores for I/O + LLM async calls
    max_agents_core = max(2, cpu_cores * 2)

    # Balanced safe recommendation
    safe_max_swarm = min(max_agents_ram, max_agents_core, 30) # Default cap at 30 for stability
    conservative_swarm = max(2, safe_max_swarm // 2)
    stress_swarm = min(max_agents_ram, max_agents_core * 2, 40)

    return {
        "metrics": sys_metrics,
        "base_model_ram_gb": base_model_ram_gb,
        "usable_ram_gb": round(usable_ram, 2),
        "conservative_swarm_size": conservative_swarm,
        "safe_recommended_swarm_size": safe_max_swarm,
        "stress_test_swarm_size": stress_swarm,
        "rationale": (
            f"Detected {sys_metrics['total_ram_gb']}GB Total RAM ({avail_ram}GB available) and "
            f"{cpu_cores} CPU cores. With base model footprint of {base_model_ram_gb}GB and "
            f"safety headroom of {int(safety_margin_ratio*100)}%, recommended safe swarm concurrency is {safe_max_swarm} agents."
        )
    }

if __name__ == "__main__":
    import json
    print(json.dumps(calculate_safe_swarm_limits(), indent=2))
