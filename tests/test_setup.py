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
    shutil.copy(ROOT / "cadre_config.env", tmp_path / "cadre_config.env")
    monkeypatch.setattr(setup_wizard, "ROOT", tmp_path)
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi"))
    args = Namespace(unattended=True, backend=None, profile="8", skip_pi=True, skip_model=True, dry_run=False)
    return setup_wizard.SetupWizard(args)


def test_profile_writes_config_and_keeps_comments(wizard, tmp_path):
    assert wizard.choose_profile()[0] == "lfm3"
    config = (tmp_path / "cadre_config.env").read_text()
    assert {"MODEL=lfm3", "CTX_SIZE=65536", "PARALLEL_SLOTS=8"} <= set(config.splitlines())
    assert config.startswith("# Read by launchers")


def test_configure_pi_registers_package_and_preserves_settings(wizard, tmp_path):
    pi_dir = tmp_path / "pi"
    pi_dir.mkdir()
    old_extension = str(tmp_path / "pi_extensions" / "lfm3_agent_extension.ts")
    (pi_dir / "settings.json").write_text(json.dumps({"theme": "dark", "extensions": ["other.ts", old_extension]}))
    stale = {"api": "openai-completions", "models": [{"id": setup_wizard.LFM3_ID, "contextWindow": 8192}]}
    (pi_dir / "models.json").write_text(json.dumps({"providers": {"llama-cpp": stale, "other": {"models": []}}}))
    wizard.configure_pi(setup_wizard.PROFILES["8"])
    wizard.configure_pi(setup_wizard.PROFILES["8"])

    settings = json.loads((pi_dir / "settings.json").read_text())
    assert settings["theme"] == "dark"
    assert settings["defaultProvider"] == "llama-cpp" and settings["defaultModel"] == setup_wizard.LFM3_ID
    assert settings["extensions"] == ["other.ts"]
    assert settings["packages"] == [str(tmp_path)]

    providers = json.loads((pi_dir / "models.json").read_text())["providers"]
    assert "llama-cpp" not in providers
    assert set(providers) == {"other", "ollama"}


def test_configure_pi_keeps_other_ollama_models(wizard, tmp_path):
    pi_dir = tmp_path / "pi"
    pi_dir.mkdir()
    ollama = {"baseUrl": "http://gpu-box:11434/v1", "models": [{"id": "qwen3-coder:30b"}, {"id": "lfm3:latest", "contextWindow": 1}]}
    (pi_dir / "models.json").write_text(json.dumps({"providers": {"ollama": ollama}}))
    wizard.configure_pi(setup_wizard.PROFILES["8"])

    provider = json.loads((pi_dir / "models.json").read_text())["providers"]["ollama"]
    assert provider["baseUrl"] == "http://gpu-box:11434/v1"
    assert [m["id"] for m in provider["models"]] == ["qwen3-coder:30b", "lfm3:latest"]
    assert provider["models"][1]["contextWindow"] == 8192


WINDOWS = sys.platform == "win32"
posix_only = pytest.mark.skipif(WINDOWS, reason="bash-only behavior")


def run_launcher(tmp_path, name, *args, config="MODEL=dual\n"):
    """
    Runs a copy of launchers/<name>.sh (.bat on Windows) next to the given cadre_config.env contents,
    with stub llama-server and pi binaries that echo their arguments.
    """
    shutil.copytree(ROOT / "launchers", tmp_path / "launchers")
    (tmp_path / "cadre_config.env").write_text(config)
    for tool in ("llama-server", "pi"):
        if WINDOWS:
            (tmp_path / f"{tool}.bat").write_text(f"@echo {tool} %*\n")
        else:
            stub = tmp_path / tool
            stub.write_text(f'#!/bin/sh\necho "{tool} $*"\n')
            stub.chmod(0o755)
    script = tmp_path / "launchers" / f"{name}.{'bat' if WINDOWS else 'sh'}"
    env = {**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"}
    res = subprocess.run([str(script), *args], capture_output=True, text=True, env=env, timeout=10)
    return res.returncode, res.stdout.replace('"', "").split()


def test_server_launcher_single(tmp_path):
    rc, out = run_launcher(tmp_path, "start_llama_server", "-m", "lfm3", "-c", "4096")
    assert rc == 0
    assert out == ["llama-server", "-hf", setup_wizard.LFM3_ID, "--host", "127.0.0.1", "--port", "8081",
                   "--ctx-size", "4096", "--parallel", "16", "-ngl", "99", "--jinja"]


def test_server_launcher_local_model_file(tmp_path):
    _, out = run_launcher(tmp_path, "start_llama_server", "-m", "spark", config="SPARK_MODEL=C:/models/spark.gguf\n")
    assert out[:5] == ["llama-server", "-m", "C:/models/spark.gguf", "--host", "127.0.0.1"]
    assert out[5:11] == ["--port", "8080", "--ctx-size", "131072", "--parallel", "4"]


def test_server_launcher_rejects_unknown_flag(tmp_path):
    assert run_launcher(tmp_path, "start_llama_server", "--nope", "x")[0] == 1


def test_pi_launcher(tmp_path):
    _, out = run_launcher(tmp_path, "pi_cadre")
    assert out == ["pi", "--provider", "llama-cpp", "--model", setup_wizard.SPARK_ID]


@posix_only
def test_server_launcher_dual(tmp_path):
    _, out = run_launcher(tmp_path, "start_llama_server", "-m", "dual", "-c", "999")
    out = " ".join(out)
    assert "--port 8080 --ctx-size 131072 --parallel 4" in out
    assert "--port 8081 --ctx-size 32768 --parallel 16" in out


@posix_only
def test_server_launcher_gguf_path_and_extra_args(tmp_path):
    rc, out = run_launcher(tmp_path, "start_llama_server", "-m", "/m.gguf", "--", "--verbose")
    assert rc == 0
    assert out[:3] == ["llama-server", "-m", "/m.gguf"] and out[-2:] == ["--jinja", "--verbose"]
