# Validador de arquivos Opus gerados via ffprobe
import subprocess
import json
import os
import config

def validate_opus(path: str) -> tuple[bool, str]:
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return False, "Arquivo ausente ou vazio"

    cmd = [
        config.FFPROBE_BIN, "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        path
    ]
    try:
        result = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
        if result.returncode != 0:
            return False, f"ffprobe retornou código de erro: {result.returncode}"
            
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        if not streams:
            return False, "Nenhum stream detectado"
        audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
        if not audio:
            return False, "Nenhum stream de áudio"
        if audio.get("codec_name") != "opus":
            return False, f"Codec inesperado: {audio.get('codec_name')}"
        duration = float(audio.get("duration", 0))
        if duration <= 0:
            return False, "Duração inválida (0 ou negativa)"
        return True, f"OK — {duration:.1f}s"
    except Exception as e:
        return False, f"ffprobe falhou: {e}"
