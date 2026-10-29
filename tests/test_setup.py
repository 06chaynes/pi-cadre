import json
import os
import shutil
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

import pytest

import setup_wizard

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def wizard(tmp_path, monkeypatch):
    shutil.copy(ROOT / "lfm3_config.env", tmp_path / "lfm3_config.env")
    monkeypatch.setattr(setup_wizard, "ROOT", tmp_path)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi"))
    args = Namespace(unattended=True, backend=None, profile="8", skip_pi=True, skip_model=True, dry_run=False)
    return setup_wizard.SetupWizard(args)


def test_profile_writes_config_and_keeps_comments(wizard, tmp_path):
    assert wizard.choose_profile()[0] == "lfm3"
    config = (tmp_path / "lfm3_config.env").read_text()
    assert "MODEL=lfm3\nCTX_SIZE=65536\nPARALLEL_SLOTS=8\n" in config
    assert config.startswith("# Read by launchers")


def test_configure_pi_preserves_existing_settings(wizard, tmp_path):
    pi_dir = tmp_path / "pi"
    pi_dir.mkdir()
    (pi_dir / "settings.json").write_text(json.dumps({"theme": "dark", "extensions": ["other.ts"]}))
    wizard.configure_pi(setup_wizard.PROFILES["8"])
    wizard.configure_pi(setup_wizard.PROFILES["8"])

    settings = json.loads((pi_dir / "settings.json").read_text())
    assert settings["theme"] == "dark"
    assert settings["defaultModel"] == setup_wizard.LFM3_ID
    assert len(settings["extensions"]) == 2 and settings["extensions"][1].endswith("lfm3_agent_extension.ts")

    models = {m["id"]: m for m in json.loads((pi_dir / "models.json").read_text())["providers"]["llama-cpp"]["models"]}
    assert models[setup_wizard.LFM3_ID]["contextWindow"] == 8192
    assert models[setup_wizard.LFM3_ID]["baseUrl"] == "http://127.0.0.1:8081/v1"
    assert models[setup_wizard.SPARK_ID]["contextWindow"] == 8192


WINDOWS = sys.platform == "win32"
posix_only = pytest.mark.skipif(WINDOWS, reason="bash-only behavior")


def run_launcher(tmp_path, name, *args):
    """Runs launchers/<name>.sh (.bat on Windows) with stub llama-server and pi binaries that echo their arguments."""
    for tool, url in (("llama-server", ""), ("pi", "%LLAMA_BASE_URL%" if WINDOWS else "$LLAMA_BASE_URL")):
        if WINDOWS:
            (tmp_path / f"{tool}.bat").write_text(f"@echo {tool} %* {url}\n")
        else:
            stub = tmp_path / tool
            stub.write_text(f'#!/bin/sh\necho "{tool} $* {url}"\n')
            stub.chmod(0o755)
    script = ROOT / "launchers" / f"{name}.{'bat' if WINDOWS else 'sh'}"
    env = {**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"}
    res = subprocess.run([str(script), *args], capture_output=True, text=True, env=env, timeout=10)
    return res.returncode, res.stdout.split()


def test_server_launcher_single(tmp_path):
    rc, out = run_launcher(tmp_path, "start_llama_server", "-m", "lfm3", "-c", "4096")
    assert rc == 0
    assert out == ["llama-server", "-hf", setup_wizard.LFM3_ID, "--host", "127.0.0.1", "--port", "8081",
                   "--ctx-size", "4096", "--parallel", "16", "-ngl", "99", "--jinja"]


def test_server_launcher_rejects_unknown_flag(tmp_path):
    assert run_launcher(tmp_path, "start_llama_server", "--nope", "x")[0] == 1


def test_pi_launcher(tmp_path):
    _, out = run_launcher(tmp_path, "pi_lfm3")
    assert out == ["pi", "--provider", "llama-cpp", "--model", setup_wizard.SPARK_ID, "http://127.0.0.1:8080"]


@posix_only
def test_server_launcher_dual(tmp_path):
    _, out = run_launcher(tmp_path, "start_llama_server", "-m", "dual", "-c", "999")
    out = " ".join(out)
    assert "--port 8080 --ctx-size 65536 --parallel 8" in out
    assert "--port 8081 --ctx-size 32768 --parallel 16" in out


@posix_only
def test_server_launcher_gguf_path_and_extra_args(tmp_path):
    rc, out = run_launcher(tmp_path, "start_llama_server", "-m", "/m.gguf", "--", "--verbose")
    assert rc == 0
    assert out[:3] == ["llama-server", "-m", "/m.gguf"] and out[-2:] == ["--jinja", "--verbose"]
