"""The launchers run on this platform (.sh on Linux and macOS, .bat on Windows) with stand-ins for llama-server and pi
that record their arguments, so both scripts are held to the same expected calls."""

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
WINDOWS = os.name == "nt"
EXT = ".bat" if WINDOWS else ".sh"
SPARK = ["-hf", "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M", "--host", "127.0.0.1", "--port", "8080", "--ctx-size", "131072", "--parallel", "4", "-ngl", "99", "--jinja"]
LFM3 = ["-hf", "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M", "--host", "127.0.0.1", "--port", "8081", "--ctx-size", "65536", "--parallel", "4", "-ngl", "99", "--jinja"]

# Each call is one file, renamed into place when written: dual mode's two servers record at the same time.
RECORD = """import json, os, sys
path = os.path.join(os.environ["STUB_LOG"], str(os.getpid()))
with open(path + ".tmp", "w") as f:
    json.dump(sys.argv[1:], f)
os.replace(path + ".tmp", path + ".json")
"""


@pytest.fixture
def project(tmp_path):
    """A copy of the launchers and the committed config, with stand-ins first on PATH."""
    shutil.copytree(ROOT / "launchers", tmp_path / "launchers")
    shutil.copy(ROOT / "cadre_config.env", tmp_path / "cadre_config.env")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "record.py").write_text(RECORD)
    for name in ("llama-server", "pi"):
        if WINDOWS:
            # Each stand-in is the launcher's last command, so a .bat that never returns to its caller is enough.
            (bin_dir / f"{name}.bat").write_text(f'@"{sys.executable}" "{bin_dir / "record.py"}" {name} %*\r\n')
        else:
            stub = bin_dir / name
            stub.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{bin_dir / "record.py"}" {name} "$@"\n')
            stub.chmod(0o755)
    return tmp_path


def set_config(project, **values):
    lines = (project / "cadre_config.env").read_text().splitlines()
    lines = [f"{line.split('=')[0]}={values[line.split('=')[0]]}" if line.split("=")[0] in values else line for line in lines]
    (project / "cadre_config.env").write_text("\n".join(lines) + "\n")


def run(project, script, *args, calls=1):
    """Runs a launcher; returns (exit code, output, calls the stand-ins recorded) once `calls` calls have arrived."""
    log = project / "calls"
    log.mkdir(exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k.upper() != "PATH"}
    env.update(PATH=str(project / "bin") + os.pathsep + os.environ["PATH"], STUB_LOG=str(log))
    path = project / "launchers" / f"{script}{EXT}"
    # On Windows the command line is written as a user types it in cmd: an argument with cmd's special characters in
    # double quotes (Python quotes only arguments with spaces), the whole line wrapped for /s /c.
    typed = " ".join(f'"{a}"' if re.search(r"[&|<>^()]", a) and '"' not in a else subprocess.list2cmdline([a]) for a in args)
    command = f'cmd /s /c ""{path}" {typed}"' if WINDOWS else [str(path), *args]
    # Output goes to a file: on Windows, dual mode's server windows inherit the handles and stay open.
    with open(project / "out.txt", "w+") as out:
        code = subprocess.run(command, env=env, stdout=out, stderr=subprocess.STDOUT, timeout=60).returncode
    deadline = time.time() + 30
    while time.time() < deadline and len(read_calls(log)) < calls:
        time.sleep(0.2)
    if WINDOWS:
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"Get-CimInstance Win32_Process | Where-Object {{ $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*{project}*' }} | "
                        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"])
    return code, (project / "out.txt").read_text(), read_calls(log)


def read_calls(log):
    return sorted(json.loads(p.read_text()) for p in log.glob("*.json"))


def test_server_defaults_per_model(project):
    assert run(project, "start_llama_server", "-m", "spark")[2] == [["llama-server", *SPARK]]
    for p in (project / "calls").glob("*.json"):
        p.unlink()
    assert run(project, "start_llama_server", "--model", "lfm3")[2] == [["llama-server", *LFM3]]


def test_server_flags_and_passthrough(project):
    code, _, calls = run(project, "start_llama_server", "-m", "lfm3", "-c", "4096", "-np", "2", "-p", "9000", "-ngl", "10", "--", "--device", "CUDA0")
    assert code == 0
    expected = list(LFM3)
    for flag, value in (("--port", "9000"), ("--ctx-size", "4096"), ("--parallel", "2"), ("-ngl", "10")):
        expected[expected.index(flag) + 1] = value
    assert calls == [["llama-server", *expected, "--device", "CUDA0"]]


def test_server_passes_arguments_after_double_dash_unchanged(project):
    """Values with =, commas, spaces, parentheses and & reach llama-server as one argument each, in both modes."""
    extra = ["--override-kv", "tokenizer.add_bos=bool:false", "--chat-template-kwargs", '{"a":1,"b":2}', "--alias", "Spark (Q4)", "--api-key", "p&ss;x"]
    assert run(project, "start_llama_server", "-m", "spark", "--", *extra)[2] == [["llama-server", *SPARK, *extra]]
    for p in (project / "calls").glob("*.json"):
        p.unlink()
    calls = run(project, "start_llama_server", "-m", "dual", "--", *extra, calls=2)[2]
    assert calls == sorted([["llama-server", *LFM3, *extra], ["llama-server", *SPARK, *extra]])


def test_server_local_gguf_in_any_case(project):
    set_config(project, MODEL="spark", SPARK_MODEL="models/Spark.GGUF")
    assert run(project, "start_llama_server")[2] == [["llama-server", "-m", "models/Spark.GGUF", *SPARK[2:]]]


def test_dual_starts_both_servers_with_the_shared_flags(project):
    """Dual mode starts both servers at their own defaults; -ngl and arguments after -- reach both."""
    code, _, calls = run(project, "start_llama_server", "-m", "dual", "-c", "4096", "-ngl", "10", "--", "--verbose", calls=2)
    assert code == 0
    with_ngl = lambda args: [v if args[i - 1] != "-ngl" else "10" for i, v in enumerate(args)]
    assert calls == sorted([["llama-server", *with_ngl(LFM3), "--verbose"], ["llama-server", *with_ngl(SPARK), "--verbose"]])


def test_server_help_and_unknown_flag(project):
    code, out, calls = run(project, "start_llama_server", "--help", calls=0)
    assert (code, calls) == (0, [])
    assert out.startswith("Usage: ") and f"start_llama_server{EXT}" in out and "[-- llama-server args]" in out
    code, out, _ = run(project, "start_llama_server", "-m", "spark", "--nope", calls=0)
    assert code == 1 and f"start_llama_server{EXT}" in out


@pytest.mark.parametrize("model, expected", [("dual", "cadre"), ("lfm3", LFM3[1]), ("spark", SPARK[1]), ("org/other-GGUF", SPARK[1])])
def test_pi_model_per_config(project, model, expected):
    set_config(project, MODEL=model)
    assert run(project, "pi_cadre", "--continue")[2] == [["pi", "--provider", "llama-cpp", "--model", expected, "--continue"]]


def test_searxng_help_is_the_header(project):
    code, out, _ = run(project, "searxng", "--help", calls=0)
    lines = out.splitlines()
    assert code == 0
    assert lines[0] == "Local SearXNG search for Pi web tools (pi-web-access), in Docker, reachable only from this machine."
    assert f"Usage: launchers/searxng{EXT} setup|status|teardown [--purge]" in [line.replace("\\", "/") for line in lines]
    assert lines[-1].startswith("SEARXNG_CONTAINER")
