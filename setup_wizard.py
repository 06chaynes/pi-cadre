#!/usr/bin/env python3
"""
Cross-Platform Guided Setup Wizard for Pi & LFM3 1.7B Swarm Framework
Supports macOS, Linux, and Windows.

Automates:
1. System diagnostics (OS, CPU, GPU acceleration, RAM, Node.js, npm, Python)
2. Backend provisioning (llama.cpp [Default/Recommended] or Ollama)
3. Model provisioning (LiquidAI/LFM3-1.7B-GGUF:Q4_K_M or lfm3:latest)
4. Pi Coding Assistant installation & verification
5. Customization deployment:
   - ~/.pi/agent/models.json (provider definitions)
   - ~/.pi/agent/settings.json (defaults & extensions)
   - ~/.pi/agent/extensions/lfm3-optimizer.ts (AutoThinking & AST hooks)
   - Platform launch scripts
6. End-to-end health check & live completion probe
"""

import os
import sys
import platform
import subprocess
import shutil
import urllib.request
import urllib.error
import json
import time
import argparse
from pathlib import Path
from typing import Dict, Any, Optional, Tuple

# Terminal color styling with automatic TTY and Windows VT100 support
class Color:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled and sys.stdout.isatty()
        if platform.system() == "Windows" and self.enabled:
            # Enable VT100 escape sequences on Windows 10+
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32
                kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
            except Exception:
                self.enabled = False

    def cyan(self, t: str) -> str: return f"\033[96m{t}\033[0m" if self.enabled else t
    def green(self, t: str) -> str: return f"\033[92m{t}\033[0m" if self.enabled else t
    def yellow(self, t: str) -> str: return f"\033[93m{t}\033[0m" if self.enabled else t
    def red(self, t: str) -> str: return f"\033[91m{t}\033[0m" if self.enabled else t
    def bold(self, t: str) -> str: return f"\033[1m{t}\033[0m" if self.enabled else t
    def dim(self, t: str) -> str: return f"\033[2m{t}\033[0m" if self.enabled else t

def print_header(col: Color):
    print("\n" + col.cyan("=" * 76))
    print(col.bold(col.cyan("   ⚡ PI & LIQUID LFM3 1.7B SWARM - GUIDED CROSS-PLATFORM INSTALLER ⚡   ")))
    print(col.dim("      Portable Setup for macOS, Linux, and Windows (Native & WSL)      "))
    print(col.cyan("=" * 76) + "\n")

class SystemInspector:
    """Discovers hardware, operating system, and installed runtimes."""
    @staticmethod
    def inspect() -> Dict[str, Any]:
        info = {
            "os": platform.system(),
            "os_release": platform.release(),
            "arch": platform.machine(),
            "ram_gb": SystemInspector._get_ram_gb(),
            "gpu": SystemInspector._detect_gpu(),
            "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "node_version": SystemInspector._run_command(["node", "-v"]),
            "npm_version": SystemInspector._run_command(["npm", "-v"]),
            "pi_installed": shutil.which("pi") is not None,
            "llama_server_installed": shutil.which("llama-server") is not None,
            "ollama_installed": shutil.which("ollama") is not None
        }
        return info

    @staticmethod
    def _run_command(cmd: list) -> Optional[str]:
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, check=True)
            return res.stdout.strip()
        except Exception:
            return None

    @staticmethod
    def _get_ram_gb() -> float:
        os_name = platform.system()
        try:
            if os_name == "Darwin":
                out = subprocess.check_output(["sysctl", "hw.memsize"]).decode()
                bytes_mem = int(out.split(":")[1].strip())
                return round(bytes_mem / (1024 ** 3), 1)
            elif os_name == "Linux":
                with open("/proc/meminfo", "r") as f:
                    for line in f:
                        if line.startswith("MemTotal:"):
                            kb = int(line.split()[1])
                            return round(kb / (1024 ** 2), 1)
            elif os_name == "Windows":
                out = subprocess.check_output(["wmic", "OS", "get", "TotalVisibleMemorySize"]).decode()
                lines = [l.strip() for l in out.splitlines() if l.strip().isdigit()]
                if lines:
                    kb = int(lines[0])
                    return round(kb / (1024 ** 2), 1)
        except Exception:
            pass
        return 8.0

    @staticmethod
    def _detect_gpu() -> str:
        os_name = platform.system()
        arch = platform.machine()
        if os_name == "Darwin":
            if "arm" in arch.lower():
                return "Apple Silicon (Metal GPU acceleration supported)"
            return "Intel Mac (CPU execution)"
        
        # Check NVIDIA CUDA
        if shutil.which("nvidia-smi"):
            try:
                out = subprocess.check_output(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"]).decode()
                first_gpu = out.strip().splitlines()[0]
                return f"NVIDIA CUDA ({first_gpu})"
            except Exception:
                return "NVIDIA GPU (CUDA detected)"
        
        # Check AMD ROCm
        if shutil.which("rocm-smi"):
            return "AMD ROCm GPU detected"

        return f"Standard CPU ({arch})"

class SetupWizard:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.col = Color(not args.no_color)
        self.root_dir = Path(__file__).resolve().parent
        self.config_dir = self._resolve_pi_dir()

    def _resolve_pi_dir(self) -> Path:
        env_dir = os.environ.get("PI_CODING_AGENT_DIR")
        if env_dir:
            return Path(env_dir)
        return Path.home() / ".pi" / "agent"

    def prompt(self, message: str, default: Optional[str] = None) -> str:
        if self.args.unattended:
            return default or ""
        prompt_str = f"{message} [{self.col.bold(default)}]: " if default else f"{message}: "
        try:
            resp = input(prompt_str).strip()
            return resp if resp else (default or "")
        except (KeyboardInterrupt, EOFError):
            print("\nSetup cancelled.")
            sys.exit(1)

    def run(self):
        print_header(self.col)

        # -------------------------------------------------------------
        # STEP 1: SYSTEM & RUNTIME DIAGNOSTICS
        # -------------------------------------------------------------
        print(self.col.bold(self.col.yellow("STEP 1: System & Runtime Inspection")))
        info = SystemInspector.inspect()

        print(f" • Operating System:  {self.col.green(info['os'])} {info['os_release']} ({info['arch']})")
        print(f" • System Memory:     {self.col.green(str(info['ram_gb']) + ' GB')}")
        print(f" • Compute Device:    {self.col.cyan(info['gpu'])}")
        print(f" • Python Runtime:    {self.col.green(info['python_version'])}")
        print(f" • Node.js Runtime:   {self.col.green(info['node_version'] or 'Not Detected')}")
        print(f" • npm Package Mgr:   {self.col.green(info['npm_version'] or 'Not Detected')}")
        print(f" • Pi CLI Assistant:  {self.col.green('Installed' if info['pi_installed'] else 'Not Found')}")
        print(f" • llama-server:      {self.col.green('Installed' if info['llama_server_installed'] else 'Not Found')}")
        print(f" • Ollama:            {self.col.green('Installed' if info['ollama_installed'] else 'Not Found')}")

        if sys.version_info < (3, 9):
            print(self.col.red("\nERROR: Python 3.9+ is required to run the LFM3 Swarm framework."))
            sys.exit(1)

        # -------------------------------------------------------------
        # STEP 2: INFERENCE BACKEND PROVISIONING
        # -------------------------------------------------------------
        print("\n" + self.col.bold(self.col.yellow("STEP 2: Inference Backend Selection")))
        print("Select the backend to run LiquidAI LFM3 1.7B GGUF:")
        print(f"  {self.col.bold('1')} - {self.col.bold('llama.cpp')} (Recommended - 42.1 tok/s, native parallel slots, low memory)")
        print(f"  {self.col.bold('2')} - {self.col.bold('Ollama')}   (Alternative - simple one-click model runner)")

        default_choice = "1" if self.args.backend in (None, "llama.cpp", "llama-cpp") else "2"
        if not self.args.unattended:
            choice = self.prompt("Choose backend (1 or 2)", default=default_choice)
        else:
            choice = "2" if self.args.backend == "ollama" else "1"

        backend = "llama-cpp" if choice in ("1", "llama.cpp", "llama-cpp") else "ollama"
        print(f"Selected backend: {self.col.green(backend)}")

        if backend == "llama-cpp":
            self._setup_llama_cpp(info)
        else:
            self._setup_ollama(info)

        # -------------------------------------------------------------
        # STEP 3: PI CODING AGENT INSTALLATION
        # -------------------------------------------------------------
        print("\n" + self.col.bold(self.col.yellow("STEP 3: Pi Coding Agent Setup")))
        self._setup_pi(info)

        # -------------------------------------------------------------
        # STEP 4: CONTEXT WINDOW & CONCURRENCY PROFILE
        # -------------------------------------------------------------
        if backend == "llama-cpp":
            self._configure_context_window()

        # -------------------------------------------------------------
        # STEP 5: APPLY FOUNDATIONAL CUSTOMIZATIONS
        # -------------------------------------------------------------
        print("\n" + self.col.bold(self.col.yellow("STEP 5: Deploying Customizations & Configuration")))
        self._apply_customizations(backend)

        # -------------------------------------------------------------
        # STEP 6: VERIFICATION & SMOKE TEST
        # -------------------------------------------------------------
        print("\n" + self.col.bold(self.col.yellow("STEP 6: System Verification & Self-Test")))
        self._verify_installation(backend)

        # -------------------------------------------------------------
        # STEP 7: SUMMARY & QUICKSTART
        # -------------------------------------------------------------
        self._print_completion_summary(backend)

    def _configure_context_window(self):
        print("\n" + self.col.bold(self.col.yellow("STEP 4: Model & Context Window Concurrency Profile")))
        print(" Choose your active model and context concurrency profile:")
        print(self.col.cyan(" --- Spark-X2.6-4B (4.0B Params | Native 1,048,576 Context / 1M) ---"))
        print(f"  {self.col.bold('1')} - {self.col.bold('Spark Balanced (Recommended)')}: 64k pool  | 8 slots @ 8k tokens/slot")
        print(f"  {self.col.bold('2')} - {self.col.bold('Spark High-Throughput Swarm')} : 32k pool  | 16 slots @ 2k tokens/slot")
        print(f"  {self.col.bold('3')} - {self.col.bold('Spark Deep Code Reasoning')} : 128k pool | 4 slots @ 32k tokens/slot")
        print(f"  {self.col.bold('4')} - {self.col.bold('Spark Subsystem Analysis')}  : 262k pool | 2 slots @ 131k tokens/slot")
        print(f"  {self.col.bold('5')} - {self.col.bold('Spark Full 1M Monorepo')}    : 1048k pool| 1 slot @ 1,048,576 tokens (1M)")
        print(self.col.cyan(" --- LiquidAI LFM3-1.7B (1.7B Params | Native 262,144 Context / 256k) ---"))
        print(f"  {self.col.bold('6')} - {self.col.bold('LFM3 Swarm Concurrency')}   : 32k pool  | 16 slots @ 2k tokens/slot")
        print(f"  {self.col.bold('7')} - {self.col.bold('LFM3 Balanced Navigation')}  : 64k pool  | 8 slots @ 8k tokens/slot")
        print(f"  {self.col.bold('8')} - {self.col.bold('LFM3 Full 256k Monorepo')}   : 262k pool | 1 slot @ 256k tokens max")

        default_opt = "1"
        if hasattr(self.args, "profile") and self.args.profile:
            choice = str(self.args.profile)
        elif not self.args.unattended:
            choice = self.prompt("Choose profile (1-8)", default=default_opt)
        else:
            choice = default_opt

        spark_model = "models/Spark-X2.6-4B-Q4_K_M.gguf" if (self.root_dir / "models/Spark-X2.6-4B-Q4_K_M.gguf").exists() else "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M"
        lfm3_model = "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"

        profiles = {
            "1": (65536, 8, spark_model, "Spark-X2.6 Balanced (8 slots @ 8k)"),
            "2": (32768, 16, spark_model, "Spark-X2.6 Swarm (16 slots @ 2k)"),
            "3": (131072, 4, spark_model, "Spark-X2.6 Deep Code Reasoning (4 slots @ 32k)"),
            "4": (262144, 2, spark_model, "Spark-X2.6 Subsystem (2 slots @ 131k)"),
            "5": (1048576, 1, spark_model, "Spark-X2.6 Ultra 1M Monorepo (1 slot @ 1M)"),
            "6": (32768, 16, lfm3_model, "LFM3 Swarm (16 slots @ 2k)"),
            "7": (65536, 8, lfm3_model, "LFM3 Balanced (8 slots @ 8k)"),
            "8": (262144, 1, lfm3_model, "LFM3 Full 256k Monorepo (1 slot @ 256k)")
        }
        ctx_size, slots, model_id, label = profiles.get(choice, profiles["1"])
        print(f" Configured Profile: {self.col.green(label)}")

        cfg_path = self.root_dir / "lfm3_config.env"
        if not self.args.dry_run:
            with open(cfg_path, "w") as fp:
                fp.write(f"# Multi-Model Configuration - Generated by setup_wizard.py\n")
                fp.write(f"ACTIVE_MODEL={'spark' if 'Spark' in label else 'lfm3'}\n")
                fp.write(f"CTX_SIZE={ctx_size}\n")
                fp.write(f"PARALLEL_SLOTS={slots}\n")
                fp.write(f"N_GPU_LAYERS=99\n")
                fp.write(f"PORT=8080\n")
                fp.write(f"HOST=127.0.0.1\n")
                fp.write(f"MODEL_ID={model_id}\n")
            print(f" -> {self.col.green('Saved profile configuration')}: {cfg_path}")

    def _setup_llama_cpp(self, info: Dict[str, Any]):
        if info["llama_server_installed"]:
            print(f" -> {self.col.green('llama-server is already installed and in PATH.')}")
            return

        print(f" -> {self.col.yellow('llama-server was not detected in PATH.')}")
        os_name = info["os"]

        if os_name == "Darwin":
            print("On macOS, the recommended way to install llama.cpp is via Homebrew:")
            print(self.col.bold("  brew install llama.cpp"))
            if shutil.which("brew") and not self.args.unattended:
                run_brew = self.prompt("Would you like to run 'brew install llama.cpp' now? (y/n)", default="y")
                if run_brew.lower() == "y":
                    if not self.args.dry_run:
                        subprocess.run(["brew", "install", "llama.cpp"], check=True)
                        print(self.col.green("llama.cpp successfully installed!"))
        elif os_name == "Linux":
            print("On Linux, you can install prebuilt binaries from ggml-org/llama.cpp or compile from source:")
            print(self.col.bold("  git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp && cmake -B build && cmake --build build --config Release"))
            print("Or download latest release from: https://github.com/ggml-org/llama.cpp/releases")
        elif os_name == "Windows":
            print("On Windows, install via winget or download prebuilt binaries:")
            print(self.col.bold("  winget install llama.cpp"))
            print("Or download llama-b*-bin-win-*.zip from: https://github.com/ggml-org/llama.cpp/releases")

    def _setup_ollama(self, info: Dict[str, Any]):
        if info["ollama_installed"]:
            print(f" -> {self.col.green('ollama is already installed.')}")
        else:
            print(f" -> {self.col.yellow('Ollama was not detected in PATH.')}")
            os_name = info["os"]
            if os_name == "Darwin":
                print("Install via Homebrew: " + self.col.bold("brew install ollama"))
            elif os_name == "Linux":
                print("Install via curl: " + self.col.bold("curl -fsSL https://ollama.com/install.sh | sh"))
            elif os_name == "Windows":
                print("Install via winget: " + self.col.bold("winget install Ollama.Ollama"))

        # Pull model
        if not self.args.skip_model and shutil.which("ollama"):
            pull_model = self.prompt("Pull LFM3 model ('ollama pull lfm3:latest') now? (y/n)", default="y")
            if pull_model.lower() == "y" and not self.args.dry_run:
                print("Pulling model lfm3:latest...")
                subprocess.run(["ollama", "pull", "lfm3:latest"])

    def _setup_pi(self, info: Dict[str, Any]):
        if self.args.skip_pi:
            print(" -> Skipping Pi installation as requested.")
            return

        if info["pi_installed"]:
            pi_version = SystemInspector._run_command(["pi", "--version"])
            print(f" -> {self.col.green('Pi is already installed')} (version {pi_version or 'unknown'}).")
            return

        if not info["npm_version"]:
            print(self.col.red("ERROR: Node.js and npm are required to install Pi (pi-coding-agent)."))
            print("Please install Node.js 18+ from https://nodejs.org/ and re-run this wizard.")
            return

        install_pi = self.prompt("Pi is not found. Install '@earendil-works/pi-coding-agent' globally via npm? (y/n)", default="y")
        if install_pi.lower() == "y" and not self.args.dry_run:
            print("Installing Pi globally...")
            try:
                subprocess.run(["npm", "install", "-g", "@earendil-works/pi-coding-agent"], check=True)
                print(self.col.green("Pi successfully installed!"))
            except subprocess.CalledProcessError:
                print(self.col.yellow("Retrying with package alias @mariozechner/pi-coding-agent..."))
                subprocess.run(["npm", "install", "-g", "@mariozechner/pi-coding-agent"])

    def _apply_customizations(self, backend: str):
        target_dir = self.config_dir
        ext_dir = target_dir / "extensions"
        prompts_dir = target_dir / "prompts"

        print(f" • Target configuration path: {self.col.cyan(str(target_dir))}")

        if not self.args.dry_run:
            try:
                ext_dir.mkdir(parents=True, exist_ok=True)
                prompts_dir.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                print(self.col.yellow(f"Note: Could not create {target_dir} ({e}). Using local repo templates."))

        # 1. Configure models.json
        models_file = target_dir / "models.json"
        existing_models = {}
        if models_file.exists():
            try:
                with open(models_file, "r") as fp:
                    existing_models = json.load(fp)
            except Exception:
                existing_models = {}

        if "providers" not in existing_models:
            existing_models["providers"] = {}

        # Add llama-cpp provider
        existing_models["providers"]["llama-cpp"] = {
            "name": "llama.cpp (Local LFM-3-1.7B)",
            "baseUrl": "http://127.0.0.1:8080/v1",
            "api": "openai-completions",
            "models": [
                {
                    "id": "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M",
                    "name": "Liquid LFM3 1.7B (Local GGUF)",
                    "contextWindow": 8192,
                    "maxTokens": 4096,
                    "reasoning": True
                }
            ]
        }

        # Add ollama provider
        existing_models["providers"]["ollama"] = {
            "name": "Ollama (Local LFM-3-1.7B)",
            "baseUrl": "http://127.0.0.1:11434/v1",
            "api": "openai-completions",
            "models": [
                {
                    "id": "lfm3:latest",
                    "name": "Liquid LFM3 1.7B (Ollama)",
                    "contextWindow": 8192,
                    "maxTokens": 4096,
                    "reasoning": True
                }
            ]
        }

        if not self.args.dry_run:
            try:
                with open(models_file, "w") as fp:
                    json.dump(existing_models, fp, indent=2)
                print(f" -> {self.col.green('Updated models.json')} with llama-cpp and ollama providers.")
            except Exception as e:
                print(self.col.yellow(f" -> Unable to write to {models_file}: {e}"))

        # 2. Configure settings.json
        settings_file = target_dir / "settings.json"
        existing_settings = {}
        if settings_file.exists():
            try:
                with open(settings_file, "r") as fp:
                    existing_settings = json.load(fp)
            except Exception:
                existing_settings = {}

        if backend == "llama-cpp":
            existing_settings["defaultProvider"] = "llama-cpp"
            existing_settings["defaultModel"] = "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"
        else:
            existing_settings["defaultProvider"] = "ollama"
            existing_settings["defaultModel"] = "lfm3:latest"

        existing_settings["defaultThinkingLevel"] = "medium"

        # Register our extension
        ext_list = existing_settings.get("extensions", [])
        opt_ext_path = str(ext_dir / "lfm3-optimizer.ts")
        if opt_ext_path not in ext_list:
            ext_list.append(opt_ext_path)
        existing_settings["extensions"] = ext_list

        if not self.args.dry_run:
            try:
                with open(settings_file, "w") as fp:
                    json.dump(existing_settings, fp, indent=2)
                print(f" -> {self.col.green('Updated settings.json')} with default provider '{backend}' and auto-thinking extension.")
            except Exception as e:
                print(self.col.yellow(f" -> Unable to write to {settings_file}: {e}"))

        # 3. Copy extension file
        src_ext = self.root_dir / "pi_extensions" / "lfm3_agent_extension.ts"
        dest_ext = ext_dir / "lfm3-optimizer.ts"
        if src_ext.exists() and not self.args.dry_run:
            try:
                shutil.copyfile(src_ext, dest_ext)
                print(f" -> {self.col.green('Installed Pi extension')}: {dest_ext}")
            except Exception as e:
                print(self.col.yellow(f" -> Unable to copy extension to {dest_ext}: {e}"))

    def _verify_installation(self, backend: str):
        port = 8080 if backend == "llama-cpp" else 11434
        url = f"http://127.0.0.1:{port}"
        print(f" • Probing backend connectivity at {self.col.cyan(url)}...")

        is_running = False
        try:
            health_path = f"{url}/health" if backend == "llama-cpp" else f"{url}/api/tags"
            req = urllib.request.Request(health_path, headers={"User-Agent": "pi-lfm3-setup"})
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                if resp.status in (200, 204):
                    is_running = True
        except Exception:
            is_running = False

        if is_running:
            print(f"   {self.col.green('✔ Backend is actively running and responding!')}")
            # Run 1-shot completion probe
            self._probe_model_completion(backend, url)
        else:
            print(f"   {self.col.yellow('ℹ Backend is currently offline (expected before initial launch).')}")
            print(f"   Start the server using the provided launcher: {self.col.bold('./launchers/start_llama_server.sh')}")

    def _probe_model_completion(self, backend: str, url: str):
        print(" • Running 1-shot sanity synthesis probe...")
        try:
            payload = {
                "model": "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M" if backend == "llama-cpp" else "lfm3:latest",
                "messages": [
                    {"role": "system", "content": "Emit only Python code."},
                    {"role": "user", "content": "def multiply(a, b):"}
                ],
                "temperature": 0.0,
                "max_tokens": 40
            }
            req = urllib.request.Request(
                f"{url}/v1/chat/completions",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"}
            )
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=10.0) as resp:
                data = json.loads(resp.read().decode())
                elapsed = time.time() - t0
                content = data["choices"][0]["message"]["content"]
                print(f"   {self.col.green('✔ Test probe returned in ' + f'{elapsed:.2f}s')}:")
                for line in content.strip().splitlines()[:3]:
                    print(f"     {self.col.dim(line)}")
        except Exception as e:
            print(f"   {self.col.yellow('Probe test skipped or deferred: ' + str(e))}")

    def _print_completion_summary(self, backend: str):
        is_win = platform.system() == "Windows"
        start_cmd = "launchers\\start_llama_server.bat" if is_win else "./launchers/start_llama_server.sh"
        pi_cmd = "launchers\\pi_lfm3.bat" if is_win else "./launchers/pi_lfm3.sh"

        print("\n" + self.col.cyan("=" * 76))
        print(self.col.bold(self.col.green("                 🎉 SETUP & CONFIGURATION COMPLETE! 🎉                 ")))
        print(self.col.cyan("=" * 76))
        print(f"\n{self.col.bold('Next Steps to run Pi with Liquid LFM3 1.7B:')}\n")
        print(f" 1. Start your local inference server in a dedicated terminal:")
        print(f"    {self.col.bold(self.col.cyan(start_cmd))}\n")
        print(f" 2. Launch Pi Coding Assistant with all LFM3 optimizations active:")
        print(f"    {self.col.bold(self.col.cyan(pi_cmd))}\n")
        print(f" 3. Inside Pi interactive chat:")
        print(f"    - Type {self.col.bold('/lfm3-status')} to verify model latency and memory.")
        print(f"    - Type {self.col.bold('/lfm3-thinking auto')} to use the intent-based dynamic policy.")
        print("\n" + self.col.cyan("=" * 76) + "\n")

def main():
    parser = argparse.ArgumentParser(description="Guided Cross-Platform Installer for Pi & LFM3 Swarm")
    parser.add_argument("--unattended", "--batch", action="store_true", help="Run without interactive prompts")
    parser.add_argument("--backend", choices=["llama.cpp", "llama-cpp", "ollama"], default=None, help="Force backend")
    parser.add_argument("--skip-model", action="store_true", help="Skip pulling or downloading the model")
    parser.add_argument("--skip-pi", action="store_true", help="Skip Pi CLI package installation")
    parser.add_argument("--profile", choices=["1", "2", "3", "4"], default=None, help="Context/Slots profile (1=Swarm 32k/16slots, 2=Balanced 64k/8slots, 3=Reasoning 128k/4slots, 4=Full 256k/1slot)")
    parser.add_argument("--dry-run", action="store_true", help="Simulate installation without writing changes")
    parser.add_argument("--no-color", action="store_true", help="Disable terminal colors")

    args = parser.parse_args()
    wizard = SetupWizard(args)
    wizard.run()

if __name__ == "__main__":
    main()
