# Configurações do Conversor FLAC para Opus
import os
import json
from pathlib import Path

BITRATE = "192k"
SAMPLERATE = 48000
CHANNELS = 2
MAX_WORKERS = 4
OUTPUT_EXT = ".opus"
FFMPEG_BIN = "ffmpeg"
FFPROBE_BIN = "ffprobe"
PORT = 8000

INPUT_DIR = ""
OUTPUT_DIR = ""

CONFIG_FILE = Path(__file__).parent / "config.json"

def load_config():
    global BITRATE, SAMPLERATE, CHANNELS, MAX_WORKERS, OUTPUT_EXT, FFMPEG_BIN, FFPROBE_BIN, PORT, INPUT_DIR, OUTPUT_DIR
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            BITRATE = data.get("BITRATE", BITRATE)
            SAMPLERATE = int(data.get("SAMPLERATE", SAMPLERATE))
            CHANNELS = int(data.get("CHANNELS", CHANNELS))
            MAX_WORKERS = int(data.get("MAX_WORKERS", MAX_WORKERS))
            OUTPUT_EXT = data.get("OUTPUT_EXT", OUTPUT_EXT)
            FFMPEG_BIN = data.get("FFMPEG_BIN", FFMPEG_BIN)
            FFPROBE_BIN = data.get("FFPROBE_BIN", FFPROBE_BIN)
            PORT = int(data.get("PORT", PORT))
            INPUT_DIR = data.get("INPUT_DIR", INPUT_DIR)
            OUTPUT_DIR = data.get("OUTPUT_DIR", OUTPUT_DIR)
        except Exception as e:
            print(f"Erro ao carregar config.json: {e}")

    # Prioriza executáveis locais se existirem
    local_ffmpeg = Path(__file__).parent / "ffmpeg.exe"
    local_ffprobe = Path(__file__).parent / "ffprobe.exe"
    if local_ffmpeg.exists():
        FFMPEG_BIN = str(local_ffmpeg)
    if local_ffprobe.exists():
        FFPROBE_BIN = str(local_ffprobe)

def save_config():
    try:
        data = {
            "BITRATE": BITRATE,
            "SAMPLERATE": SAMPLERATE,
            "CHANNELS": CHANNELS,
            "MAX_WORKERS": MAX_WORKERS,
            "OUTPUT_EXT": OUTPUT_EXT,
            "FFMPEG_BIN": FFMPEG_BIN,
            "FFPROBE_BIN": FFPROBE_BIN,
            "PORT": PORT,
            "INPUT_DIR": INPUT_DIR,
            "OUTPUT_DIR": OUTPUT_DIR
        }
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"Erro ao salvar config.json: {e}")

# Carrega na inicialização
load_config()
