from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from .scraper_builder import REPO_ROOT, find_codex_bin, release_lock, write_job_status


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _print(msg: str) -> None:
    print(msg, flush=True)


def _run(cmd: list[str], *, cwd: Path, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=check,
    )


def _get_scrapers(*, cwd: Path) -> set[str]:
    code = "import json; from src.scrapers import list_scrapers; print(json.dumps(list_scrapers()))"
    out = _run([sys.executable, "-c", code], cwd=cwd, check=True).stdout.strip()
    return set(json.loads(out or "[]"))


def _normalize_url(url: str) -> str:
    raw = (url or "").strip()
    if raw.startswith("//"):
        raw = "https:" + raw
    elif "://" not in raw:
        raw = "https://" + raw

    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("URL must be http(s) and include a hostname")
    parsed = parsed._replace(fragment="")
    return urlunparse(parsed)


def _prompt_for_url(url: str) -> str:
    return f"""You are working in a Python FastAPI webapp repo.

Goal: add a NEW scraper for this target URL: {url}

Constraints:
- Implement a new scraper under `src/scrapers/` as a `BaseScraper` subclass.
- Register it in `src/scrapers/__init__.py` in `SCRAPERS` and `SCRAPER_DISPLAY_NAMES`.
- Name the scraper key based on the domain (snake_case, short, unique).
- Scraper must extract products (name, price, currency, url, item_id if possible) and MUST save at least one product image in the DB when run via the worker.
- Follow existing scraper patterns; prefer Playwright selectors and stable data sources (JSON-LD, embedded state, etc).
- Do not add new third-party dependencies.
- We are trying to build a scraper for the Blackroll brand.
- If a single product link was provided, look through the website to find a page that has all products of the blackroll brand and try to scrape that. If that doesnt exist, just scrape the single product page.
- Keep changes limited to `src/scrapers/` and `tests/`.

Testing (required):
- Add a live test `tests/test_<scraper_name>_live.py` that runs the scraper through the same path as the web UI: enqueue -> claim_next -> `Worker._execute_job`.
- Assert:
  - job completed successfully
  - at least one product saved
  - at least one product has `image_data`
  - the image is decodable via PIL and has reasonable dimensions (>30x30)
- Run: `python3 -m pytest -q tests/test_<scraper_name>_live.py`

If you cannot make the test pass reliably:
- Revert any partial work you added for this scraper (remove new files/registry entries) and explain why.

Deliverable:
- A working new scraper + test that passes.
"""


def _rsync_dir(src: Path, dst: Path, *, delete: bool = False, excludes: list[str] | None = None) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    cmd = ["rsync", "-a"]
    if delete:
        cmd.append("--delete")
    for ex in (excludes or []):
        cmd.extend(["--exclude", ex])
    cmd.extend([str(src) + "/", str(dst) + "/"])
    subprocess.run(cmd, check=True)


def _safe_rmtree(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass


def _restore_backup(backupdir: Path) -> None:
    if (backupdir / "src" / "scrapers").exists():
        _rsync_dir(backupdir / "src" / "scrapers", REPO_ROOT / "src" / "scrapers", delete=True)
    if (backupdir / "tests").exists():
        _rsync_dir(backupdir / "tests", REPO_ROOT / "tests", delete=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--url", required=True)
    args = parser.parse_args()

    job_id: str = args.job_id
    cancelled = False

    def _handle_cancel(signum, frame) -> None:  # noqa: ARG001
        nonlocal cancelled
        cancelled = True
        write_job_status(job_id, {"phase": "canceling", "cancel_requested_at": _now_iso()})
        raise KeyboardInterrupt()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _handle_cancel)

    try:
        url = _normalize_url(args.url)
    except Exception as e:
        write_job_status(job_id, {"state": "failed", "phase": "validate", "error": str(e), "ended_at": _now_iso()})
        release_lock(job_id)
        return 2

    write_job_status(
        job_id,
        {
            "state": "running",
            "phase": "preflight",
            "pid": os.getpid(),
            "started_at": _now_iso(),
            "url": url,
        },
    )

    tmp_root = Path(os.environ.get("SCRAPER_BUILDER_TMP", "/tmp/corastuff_scraper_builder")).resolve()
    workdir = tmp_root / job_id
    backupdir = tmp_root / f"{job_id}.backup"
    before_scrapers: set[str] | None = None
    applied = False

    try:
        codex_bin = find_codex_bin()
        codex_dir = str(Path(codex_bin).resolve().parent)
        base_env = dict(os.environ)
        current_path = base_env.get("PATH", "")
        base_env["PATH"] = f"{codex_dir}:{current_path}" if current_path else codex_dir

        write_job_status(job_id, {"phase": "copy", "workdir": str(workdir)})
        _safe_rmtree(workdir)
        workdir.mkdir(parents=True, exist_ok=True)

        excludes = [
            ".git/",
            "venv/",
            "data/",
            "output/",
            "__pycache__/",
            ".pytest_cache/",
            ".mypy_cache/",
            ".ruff_cache/",
            "*.pyc",
        ]
        _rsync_dir(REPO_ROOT, workdir, delete=True, excludes=excludes)

        # Ensure the codex-run shell can invoke `python`/`python3` and has pytest available.
        shim_dir = workdir / ".scraper_builder_shims"
        shim_dir.mkdir(parents=True, exist_ok=True)
        python_shim = shim_dir / "python"
        python3_shim = shim_dir / "python3"
        shim_payload = f"#!/usr/bin/env sh\nexec {sys.executable} \"$@\"\n"
        python_shim.write_text(shim_payload, encoding="utf-8")
        python3_shim.write_text(shim_payload, encoding="utf-8")
        os.chmod(python_shim, 0o755)
        os.chmod(python3_shim, 0o755)
        base_env["PATH"] = f"{shim_dir}:{base_env.get('PATH','')}"

        before_scrapers = _get_scrapers(cwd=workdir)
        write_job_status(job_id, {"phase": "codex", "scrapers_before": sorted(before_scrapers)})

        _print(f"[scraper-builder] job_id={job_id} url={url} started_at={_now_iso()}")
        _print(f"[scraper-builder] Running codex agent ({codex_bin})...")
        prompt = _prompt_for_url(url)
        codex_proc = subprocess.run(
            [codex_bin, "exec", "--yolo", "--color", "never", "--skip-git-repo-check", "-"],
            cwd=workdir,
            text=True,
            input=prompt,
            env=base_env,
        )
        write_job_status(job_id, {"codex_exit_code": codex_proc.returncode})
        if codex_proc.returncode != 0:
            raise RuntimeError(f"codex exec exited with code {codex_proc.returncode}")

        write_job_status(job_id, {"phase": "verify"})
        after_scrapers = _get_scrapers(cwd=workdir)
        new_scrapers = sorted(after_scrapers - (before_scrapers or set()))
        if len(new_scrapers) != 1:
            raise RuntimeError(f"Expected exactly 1 new scraper, found {len(new_scrapers)}: {new_scrapers}")

        new_scraper = new_scrapers[0]
        test_file = workdir / "tests" / f"test_{new_scraper}_live.py"
        if not test_file.exists():
            raise RuntimeError(f"Expected test file to exist: {test_file}")

        _print(f"[scraper-builder] Detected new scraper: {new_scraper}")
        _print(f"[scraper-builder] Running pytest: {test_file.name}")

        write_job_status(job_id, {"phase": "pytest", "new_scraper": new_scraper, "test_file": str(test_file)})
        pytest_proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", str(test_file)],
            cwd=workdir,
            text=True,
        )
        write_job_status(job_id, {"pytest_exit_code": pytest_proc.returncode})
        if pytest_proc.returncode != 0:
            raise RuntimeError(f"pytest failed with exit code {pytest_proc.returncode}")

        write_job_status(job_id, {"phase": "apply", "apply_target": str(REPO_ROOT)})
        _safe_rmtree(backupdir)

        if (REPO_ROOT / "src" / "scrapers").exists():
            _rsync_dir(REPO_ROOT / "src" / "scrapers", backupdir / "src" / "scrapers", delete=True)
        if (REPO_ROOT / "tests").exists():
            _rsync_dir(REPO_ROOT / "tests", backupdir / "tests", delete=True)

        _rsync_dir(workdir / "src" / "scrapers", REPO_ROOT / "src" / "scrapers", delete=True)
        _rsync_dir(workdir / "tests", REPO_ROOT / "tests", delete=True)
        applied = True

        _print(f"[scraper-builder] Re-running pytest on main tree: {test_file.name}")
        pytest_main = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", str(REPO_ROOT / "tests" / test_file.name)],
            cwd=REPO_ROOT,
            text=True,
        )
        write_job_status(job_id, {"pytest_main_exit_code": pytest_main.returncode})
        if pytest_main.returncode != 0:
            _restore_backup(backupdir)
            raise RuntimeError(f"pytest failed after apply (exit code {pytest_main.returncode})")

        write_job_status(job_id, {"state": "success", "phase": "done", "ended_at": _now_iso()})
        _print("[scraper-builder] Success.")
        _safe_rmtree(workdir)
        _safe_rmtree(backupdir)
        return 0

    except KeyboardInterrupt:
        write_job_status(job_id, {"phase": "cleanup", "cleanup_started_at": _now_iso()})
        if applied and backupdir.exists():
            _print("[scraper-builder] Restoring backup after cancel/interrupt...")
            _restore_backup(backupdir)
        _safe_rmtree(workdir)
        _safe_rmtree(backupdir)
        write_job_status(job_id, {"cleanup_completed_at": _now_iso()})

        if cancelled:
            write_job_status(job_id, {"state": "canceled", "phase": "done", "ended_at": _now_iso()})
            return 130

        write_job_status(job_id, {"state": "failed", "phase": "interrupted", "error": "Interrupted", "ended_at": _now_iso()})
        return 129

    except Exception as e:
        err = str(e)
        _print(f"[scraper-builder] ERROR: {err}")
        write_job_status(job_id, {"state": "failed", "phase": "error", "error": err})

        write_job_status(job_id, {"phase": "cleanup", "cleanup_started_at": _now_iso()})
        if applied and backupdir.exists():
            _print("[scraper-builder] Restoring backup after failure...")
            _restore_backup(backupdir)
        _safe_rmtree(workdir)
        _safe_rmtree(backupdir)
        write_job_status(job_id, {"cleanup_completed_at": _now_iso(), "ended_at": _now_iso()})
        return 1

    finally:
        release_lock(job_id)


if __name__ == "__main__":
    raise SystemExit(main())
