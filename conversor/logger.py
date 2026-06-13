# Logger thread-safe para conversor de lote
import os
import threading
from datetime import datetime

_lock = threading.Lock()

# Garantir que a pasta logs existe na raiz do conversor
LOGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOGS_DIR, exist_ok=True)

def log_result(src_path: str, success: bool, msg: str = ""):
    timestamp = datetime.now().strftime("%H:%M:%S")
    line = f"[{timestamp}] {src_path}"
    if success:
        _write(os.path.join(LOGS_DIR, "success.log"), line)
    elif msg.startswith("SKIP"):
        _write(os.path.join(LOGS_DIR, "skipped.log"), f"{line} | {msg}")
    else:
        _write(os.path.join(LOGS_DIR, "errors.log"), f"{line} | {msg}")

def _write(path: str, line: str):
    with _lock:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
