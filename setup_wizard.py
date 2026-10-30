#!/usr/bin/env python3
"""
Installs and configures the local Pi + llama.cpp (or Ollama) stack on macOS, Linux, and Windows.

Steps: pick a backend, install Pi via npm if missing, choose a server profile (writes cadre_config.env),
add this repo as a Pi package in ~/.pi/agent (or $PI_CODING_AGENT_DIR), then check which servers are up.
The package's extension registers the llama-cpp provider itself; the Ollama provider is written to models.json.

Usage: python3 setup_wizard.py [--unattended] [--backend llama.cpp|ollama] [--profile N] [--skip-pi] [--skip-model] [--dry-run]
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPARK_ID = "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M"
LFM3_ID = "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"
PORTS = {"spark": 8080, "lfm3": 8081}

# number: (MODEL, CTX_SIZE, PARALLEL_SLOTS, label)
PROFILES = {
    "1": ("dual", None, None, "Spark on 8080 (4 slots x 32k) and LFM3 on 8081 (16 slots x 2k)"),
    "2": ("spark", 65536, 8, "Spark, 8 slots x 8k"),
    "3": ("spark", 32768, 16, "Spark, 16 slots x 2k"),
    "4": ("spark", 131072, 4, "Spark, 4 slots x 32k"),
    "5": ("spark", 262144, 2, "Spark, 2 slots x 128k"),
    "6": ("spark", 1048576, 1, "Spark, 1 slot x 1M"),
    "7": ("lfm3", 32768, 16, "LFM3, 16 slots x 2k"),
    "8": ("lfm3", 65536, 8, "LFM3, 8 slots x 8k"),
    "9": ("lfm3", 262144, 1, "LFM3, 1 slot x 256k"),
}

LLAMA_INSTALL_HINTS = {
    "Darwin": "brew install llama.cpp",
    "Linux": "download a release from https://github.com/ggml-org/llama.cpp/releases or build from source",
    "Windows": "winget install llama.cpp",
}
OLLAMA_INSTALL_HINTS = {
    "Darwin": "brew install ollama",
    "Linux": "see https://ollama.com/download/linux",
    "Windows": "winget install Ollama.Ollama",
}


class SetupWizard:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.pi_dir = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent")

    def ask(self, message: str, default: str) -> str:
        if self.args.unattended:
            return default
        try:
            return input(f"{message} [{default}]: ").strip() or default
        except (KeyboardInterrupt, EOFError):
            sys.exit("\nSetup cancelled.")

    def confirm(self, message: str) -> bool:
        return self.ask(f"{message} (y/n)", "y").lower() == "y" and not self.args.dry_run

    def run(self):
        found = {tool: shutil.which(tool) is not None for tool in ("npm", "pi", "llama-server", "ollama")}
        print("Detected tools: " + ", ".join(f"{t}={'yes' if ok else 'no'}" for t, ok in found.items()))

        backend = self.args.backend or ("ollama" if self.ask("Backend: 1 = llama.cpp, 2 = Ollama", "1") == "2" else "llama.cpp")
        print(f"Backend: {backend}")
        if backend == "llama.cpp":
            if not found["llama-server"]:
                self.install_llama_cpp()
            profile = self.choose_profile()
        else:
            self.setup_ollama(found["ollama"])
            profile = ("ollama", None, None, "")
        model = profile[0]

        if not self.args.skip_pi and not found["pi"]:
            self.install_pi(found["npm"])
        self.configure_pi(profile)
        self.check_servers(model)

        server = "start_ollama" if model == "ollama" else "start_llama_server"
        start, pi = (rf"launchers\{server}.bat", r"launchers\pi_cadre.bat") if platform.system() == "Windows" else (
            f"./launchers/{server}.sh", "./launchers/pi_cadre.sh")
        if model == "ollama":
            pi = "pi"
        print(f"\nNext: start the server with {start}, then start Pi with {pi}.")
        print("In Pi, /cadre-status shows backend health and /cadre-thinking sets the thinking mode.")

    def install_llama_cpp(self):
        print(f"llama-server not found. Install: {LLAMA_INSTALL_HINTS.get(platform.system(), LLAMA_INSTALL_HINTS['Linux'])}")
        if platform.system() == "Darwin" and shutil.which("brew") and self.confirm("Run 'brew install llama.cpp' now?"):
            subprocess.run(["brew", "install", "llama.cpp"], check=True)

    def setup_ollama(self, installed: bool):
        if not installed:
            print(f"Ollama not found. Install: {OLLAMA_INSTALL_HINTS.get(platform.system(), OLLAMA_INSTALL_HINTS['Linux'])}")
        elif not self.args.skip_model and self.confirm("Pull lfm3:latest now?"):
            subprocess.run(["ollama", "pull", "lfm3:latest"], check=True)

    def install_pi(self, has_npm: bool):
        if not has_npm:
            print("Pi needs Node.js 18+ and npm: install from https://nodejs.org/ and re-run this wizard.")
        elif self.confirm("Install @earendil-works/pi-coding-agent globally with npm?"):
            subprocess.run(["npm", "install", "-g", "@earendil-works/pi-coding-agent"], check=True)

    def choose_profile(self) -> tuple:
        """Writes the chosen profile into cadre_config.env and returns it."""
        for number, (_, _, _, label) in PROFILES.items():
            print(f"  {number}  {label}")
        number = self.args.profile or self.ask("Server profile", "1")
        profile = model, ctx, slots, label = PROFILES.get(number, PROFILES["1"])
        print(f"Profile: {label}")
        if self.args.dry_run:
            return profile

        values = {"MODEL": model, "CTX_SIZE": ctx or "", "PARALLEL_SLOTS": slots or "", "PORT": ""}
        config = ROOT / "cadre_config.env"
        lines = [
            f"{key}={values[key]}" if (key := line.split("=", 1)[0]) in values else line
            for line in config.read_text().splitlines()
        ]
        config.write_text("\n".join(lines) + "\n")
        print(f"Wrote {config}")
        return profile

    def configure_pi(self, profile: tuple):
        """
        Adds this repo to settings.json packages, sets the default model, and adds lfm3:latest to the Ollama
        provider in models.json, keeping that provider's other models and settings. Removes the llama-cpp provider from models.json and the extension path from settings.json
        that earlier versions wrote, since models.json entries would override the extension's registration.
        """
        model = profile[0]
        ollama = {"name": "Ollama (local)", "baseUrl": "http://127.0.0.1:11434/v1", "api": "openai-completions", "apiKey": "none"}
        ollama_model = {"id": "lfm3:latest", "name": "LFM3-1.7B (Ollama)", "contextWindow": 8192, "maxTokens": 4096, "reasoning": True}
        default = {"ollama": ("ollama", "lfm3:latest"), "lfm3": ("llama-cpp", LFM3_ID)}.get(model, ("llama-cpp", SPARK_ID))
        old_extension = str(ROOT / "pi_extensions" / "lfm3_agent_extension.ts")

        def update(name, change):
            path = self.pi_dir / name
            data = json.loads(path.read_text()) if path.exists() else {}
            change(data)
            if not self.args.dry_run:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(data, indent=2))
            print(f"{'Would update' if self.args.dry_run else 'Updated'} {path}")

        def models(data):
            providers = data.setdefault("providers", {})
            providers.pop("llama-cpp", None)
            provider = {**ollama, **providers.get("ollama", {})}
            others = [m for m in provider.get("models", []) if m.get("id") != ollama_model["id"]]
            provider["models"] = others + [ollama_model]
            providers["ollama"] = provider

        def settings(data):
            data["defaultProvider"], data["defaultModel"] = default
            if old_extension in data.get("extensions", []):
                data["extensions"].remove(old_extension)
            if str(ROOT) not in data.setdefault("packages", []):
                data["packages"].append(str(ROOT))

        update("models.json", models)
        update("settings.json", settings)

    @staticmethod
    def check_servers(model: str):
        if model == "ollama":
            urls = ["http://127.0.0.1:11434/api/tags"]
        else:
            urls = [f"http://127.0.0.1:{port}/health" for key, port in PORTS.items() if model in (key, "dual")]
        for url in urls:
            try:
                with urllib.request.urlopen(url, timeout=3.0):
                    status = "online"
            except OSError:
                status = "offline (start it with the launcher below)"
            print(f"{url}: {status}")


def main():
    if sys.version_info < (3, 9):
        sys.exit("Python 3.9+ is required.")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--unattended", action="store_true", help="accept all defaults without prompting")
    parser.add_argument("--backend", choices=["llama.cpp", "ollama"])
    parser.add_argument("--profile", choices=list(PROFILES), help="server profile number, shown in the interactive menu")
    parser.add_argument("--skip-pi", action="store_true", help="do not install Pi")
    parser.add_argument("--skip-model", action="store_true", help="do not pull the Ollama model")
    parser.add_argument("--dry-run", action="store_true", help="print actions without installing or writing files")
    SetupWizard(parser.parse_args()).run()


if __name__ == "__main__":
    main()
