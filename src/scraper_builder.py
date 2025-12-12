from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = REPO_ROOT / "data" / "scraper_builder"
JOBS_DIR = STATE_DIR / "jobs"
CURRENT_JOB_FILE = STATE_DIR / "current_job.json"
LOCK_FILE = STATE_DIR / "lock.json"


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{secrets.token_hex(6)}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def meta_path(job_id: str) -> Path:
    return job_dir(job_id) / "meta.json"


def status_path(job_id: str) -> Path:
    return job_dir(job_id) / "status.json"


def log_path(job_id: str) -> Path:
    return job_dir(job_id) / "job.log"


def generate_job_id() -> str:
    now = int(time.time())
    return f"{now}-{secrets.token_hex(4)}"


def init_job(job_id: str, url: str) -> str:
    jd = job_dir(job_id)
    jd.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(
        meta_path(job_id),
        {"job_id": job_id, "url": url, "created_at": time.time()},
    )
    _write_json_atomic(
        status_path(job_id),
        {"job_id": job_id, "state": "created", "phase": "created", "updated_at": time.time()},
    )
    _write_json_atomic(CURRENT_JOB_FILE, {"job_id": job_id, "updated_at": time.time()})
    return job_id


def get_current_job_id() -> str | None:
    payload = _read_json(CURRENT_JOB_FILE)
    if not payload:
        return None
    job_id = payload.get("job_id")
    return job_id if isinstance(job_id, str) else None


def read_job_meta(job_id: str) -> dict[str, Any] | None:
    return _read_json(meta_path(job_id))


def read_job_status(job_id: str) -> dict[str, Any] | None:
    return _read_json(status_path(job_id))


def write_job_status(job_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    current = read_job_status(job_id) or {"job_id": job_id}
    current.update(patch)
    current["updated_at"] = time.time()
    _write_json_atomic(status_path(job_id), current)
    return current


def try_acquire_lock(job_id: str) -> bool:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"job_id": job_id, "created_at": time.time()}
    try:
        fd = os.open(str(LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False, indent=2))
    return True


def release_lock(job_id: str | None = None) -> None:
    payload = _read_json(LOCK_FILE)
    if job_id and payload and payload.get("job_id") != job_id:
        return
    try:
        LOCK_FILE.unlink()
    except FileNotFoundError:
        pass


def read_lock() -> dict[str, Any] | None:
    return _read_json(LOCK_FILE)


def is_pid_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_log_tail(job_id: str, max_bytes: int = 200_000) -> dict[str, Any]:
    path = log_path(job_id)
    if not path.exists():
        return {"text": "", "start_offset": 0, "file_size": 0}

    size = path.stat().st_size
    start = max(0, size - max_bytes)
    with path.open("rb") as f:
        f.seek(start)
        data = f.read()
    text = data.decode("utf-8", errors="replace")
    return {"text": text, "start_offset": start, "file_size": size}
