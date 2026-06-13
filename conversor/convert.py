# Script principal do conversor FLAC -> Opus (CLI e Servidor de API)
import os
import sys
import json
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import base64

import config
import logger
import validator

# Estado global para progresso da conversão
progress_state = {
    "processing": False,
    "done": 0,
    "errors": 0,
    "skipped": 0,
    "total": 0,
    "current_file": "",
    "log_entries": []
}
state_lock = threading.RLock()

def add_state_log(msg: str):
    with state_lock:
        progress_state["log_entries"].append(msg)
    print(msg)  # Imprime no terminal para CLI/servidor

def extract_flac_picture_block(flac_path: Path) -> bytes | None:
    try:
        with open(flac_path, 'rb') as f:
            header = f.read(4)
            if header != b'fLaC':
                return None
            
            while True:
                block_header = f.read(4)
                if len(block_header) < 4:
                    break
                
                is_last = (block_header[0] & 0x80) != 0
                block_type = block_header[0] & 0x7F
                length = (block_header[1] << 16) | (block_header[2] << 8) | block_header[3]
                
                if block_type == 6:  # PICTURE
                    return f.read(length)
                
                f.seek(length, 1)
                
                if is_last:
                    break
    except Exception:
        pass
    return None

def escape_ffmetadata_value(val: str) -> str:
    val = val.replace('\\', '\\\\')
    val = val.replace('=', '\\=')
    val = val.replace(';', '\\;')
    val = val.replace('#', '\\#')
    val = val.replace('\n', '\\\n')
    return val

def read_lrc_file(lrc_path: Path) -> str:
    try:
        with open(lrc_path, 'r', encoding='utf-8-sig') as lf:
            return lf.read()
    except UnicodeDecodeError:
        with open(lrc_path, 'r', encoding='cp1252', errors='replace') as lf:
            return lf.read()

class APIHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Desativa logs de requisições HTTP padrão para não poluir o console
        return

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/api/status":
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            with state_lock:
                res = json.dumps(progress_state)
            self.wfile.write(res.encode("utf-8"))
        elif self.path == "/api/config":
            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            conf = {
                "BITRATE": config.BITRATE,
                "SAMPLERATE": config.SAMPLERATE,
                "CHANNELS": config.CHANNELS,
                "MAX_WORKERS": config.MAX_WORKERS,
                "OUTPUT_EXT": config.OUTPUT_EXT,
                "FFMPEG_BIN": config.FFMPEG_BIN,
                "FFPROBE_BIN": config.FFPROBE_BIN,
                "INPUT_DIR": config.INPUT_DIR,
                "OUTPUT_DIR": config.OUTPUT_DIR
            }
            self.wfile.write(json.dumps(conf).encode("utf-8"))
        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()

    def do_POST(self):
        if self.path == "/api/convert":
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            try:
                data = json.loads(body)
            except Exception:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "JSON inválido"}).encode("utf-8"))
                return

            input_dir = data.get("input_dir")
            output_dir = data.get("output_dir")

            if not input_dir:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "input_dir obrigatório"}).encode("utf-8"))
                return

            input_path = Path(input_dir)
            if not input_path.exists() or not input_path.is_dir():
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Pasta de entrada não existe ou não é um diretório"}).encode("utf-8"))
                return

            if not output_dir:
                output_path = input_path / "converted"
            else:
                output_path = Path(output_dir)

            with state_lock:
                if progress_state["processing"]:
                    self.send_response(400)
                    self._send_cors_headers()
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Já existe um lote de conversão em execução"}).encode("utf-8"))
                    return

            # Iniciar processamento assíncrono em segundo plano
            threading.Thread(target=run_batch_async, args=(input_path, output_path), daemon=True).start()

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "started"}).encode("utf-8"))

        elif self.path == "/api/config":
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            try:
                data = json.loads(body)
                if "BITRATE" in data: config.BITRATE = str(data["BITRATE"])
                if "SAMPLERATE" in data: config.SAMPLERATE = int(data["SAMPLERATE"])
                if "CHANNELS" in data: config.CHANNELS = int(data["CHANNELS"])
                if "MAX_WORKERS" in data: config.MAX_WORKERS = int(data["MAX_WORKERS"])
                if "FFMPEG_BIN" in data: config.FFMPEG_BIN = str(data["FFMPEG_BIN"])
                if "FFPROBE_BIN" in data: config.FFPROBE_BIN = str(data["FFPROBE_BIN"])
                if "INPUT_DIR" in data: config.INPUT_DIR = str(data["INPUT_DIR"])
                if "OUTPUT_DIR" in data: config.OUTPUT_DIR = str(data["OUTPUT_DIR"])
                config.save_config()
                
                self.send_response(200)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "message": "Configurações atualizadas"}).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"Falha ao atualizar config: {e}"}).encode("utf-8"))
        else:
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

def run_batch_async(input_path: Path, output_dir: Path):
    with state_lock:
        progress_state["processing"] = True
        progress_state["done"] = 0
        progress_state["errors"] = 0
        progress_state["skipped"] = 0
        progress_state["total"] = 0
        progress_state["current_file"] = "Escaneando pasta..."
        progress_state["log_entries"] = []

    add_state_log(f"Escaneando pasta de entrada: {input_path}")
    try:
        flac_files = list(input_path.glob("**/*.flac"))
    except Exception as e:
        with state_lock:
            progress_state["processing"] = False
        add_state_log(f"ERRO ao escanear pasta: {e}")
        return

    if not flac_files:
        with state_lock:
            progress_state["processing"] = False
        add_state_log("Aviso: Nenhum arquivo .flac encontrado.")
        return

    with state_lock:
        progress_state["total"] = len(flac_files)
        progress_state["current_file"] = ""

    try:
        output_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        with state_lock:
            progress_state["processing"] = False
        add_state_log(f"ERRO: Não foi possível criar pasta de saída: {e}")
        return

    add_state_log(f"Iniciando conversão de {len(flac_files)} arquivos .flac em {output_dir}")

    def convert_single(file_path: Path) -> tuple[bool, str]:
        with state_lock:
            progress_state["current_file"] = file_path.name
        
        if not file_path.exists() or file_path.stat().st_size == 0:
            return False, "Arquivo de origem vazio ou ausente"

        dest_path = output_dir / (file_path.stem + config.OUTPUT_EXT)

        if dest_path.exists():
            return False, "SKIP: arquivo de destino já existe"

        meta_path = dest_path.with_suffix('.meta')
        meta_exported = False
        try:
            export_cmd = [
                config.FFMPEG_BIN,
                "-y",
                "-nostdin",
                "-i", str(file_path),
                "-f", "ffmetadata",
                str(meta_path)
            ]
            export_res = subprocess.run(
                export_cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=15,
                text=True,
                encoding="utf-8",
                errors="replace"
            )
            if export_res.returncode == 0:
                meta_exported = True
        except Exception:
            pass

        if meta_exported:
            try:
                with open(meta_path, 'r', encoding='utf-8', errors='replace') as mf:
                    meta_content = mf.read()
                
                pic_data = extract_flac_picture_block(file_path)
                if pic_data:
                    b64_pic = base64.b64encode(pic_data).decode('ascii')
                    escaped_pic = escape_ffmetadata_value(b64_pic)
                    meta_content += f"METADATA_BLOCK_PICTURE={escaped_pic}\n"
                
                lrc_path = file_path.with_suffix('.lrc')
                if lrc_path.exists():
                    try:
                        lrc_text = read_lrc_file(lrc_path)
                        escaped_lyrics = escape_ffmetadata_value(lrc_text)
                        meta_content += f"LYRICS={escaped_lyrics}\n"
                    except Exception as le:
                        logger.log_result(str(file_path), False, f"Aviso ao ler arquivo de letra (.lrc): {le}")
                
                with open(meta_path, 'w', encoding='utf-8') as mf:
                    mf.write(meta_content)
            except Exception as me:
                meta_exported = False
                logger.log_result(str(file_path), False, f"Aviso ao preparar arquivo de metadados: {me}")

        try:
            if meta_exported:
                cmd = [
                    config.FFMPEG_BIN,
                    "-y",
                    "-nostdin",
                    "-i", str(file_path),
                    "-i", str(meta_path),
                    "-map", "0:a",
                    "-map_metadata", "1",
                    "-c:a", "libopus",
                    "-b:a", config.BITRATE,
                    "-ar", str(config.SAMPLERATE),
                    "-ac", str(config.CHANNELS),
                    "-sample_fmt", "s16",
                    "-application", "audio",
                    str(dest_path)
                ]
            else:
                cmd = [
                    config.FFMPEG_BIN,
                    "-y",
                    "-nostdin",
                    "-i", str(file_path),
                    "-vn",
                    "-c:a", "libopus",
                    "-b:a", config.BITRATE,
                    "-ar", str(config.SAMPLERATE),
                    "-ac", str(config.CHANNELS),
                    "-sample_fmt", "s16",
                    "-map_metadata", "0",
                    "-application", "audio",
                    str(dest_path)
                ]
                
                lrc_path = file_path.with_suffix('.lrc')
                if lrc_path.exists():
                    try:
                        lrc_content = read_lrc_file(lrc_path)
                        cmd.insert(-1, "-metadata")
                        cmd.insert(-1, f"LYRICS={lrc_content}")
                    except Exception as le:
                        logger.log_result(str(file_path), False, f"Aviso ao ler arquivo de letra (.lrc) no fallback: {le}")

            try:
                result = subprocess.run(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    timeout=120,
                    text=True,
                    encoding="utf-8",
                    errors="replace"
                )
                if result.returncode != 0:
                    err_msg = result.stderr[-2000:] if result.stderr else "Código de retorno diferente de 0"
                    if dest_path.exists():
                        try: os.remove(dest_path)
                        except Exception: pass
                    return False, f"ffmpeg falhou: {err_msg}"
            except subprocess.TimeoutExpired:
                if dest_path.exists():
                    try: os.remove(dest_path)
                    except Exception: pass
                return False, "TIMEOUT: conversão excedeu o limite de tempo"
            except FileNotFoundError:
                return False, f"ERRO: binário '{config.FFMPEG_BIN}' não encontrado no PATH do sistema. Por favor, instale o FFmpeg ou coloque o 'ffmpeg.exe' dentro da pasta 'conversor'."

            ok, val_msg = validator.validate_opus(str(dest_path))
            if not ok:
                if dest_path.exists():
                    try: os.remove(dest_path)
                    except Exception: pass
                return False, f"Validação falhou: {val_msg}"

            return True, ""
        finally:
            if meta_path.exists():
                try: os.remove(meta_path)
                except Exception: pass

    # Processamento em lote usando ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=config.MAX_WORKERS) as executor:
        futures = {
            executor.submit(convert_single, f): f
            for f in flac_files
        }
        for future in as_completed(futures):
            src = futures[future]
            try:
                status, msg = future.result()
                logger.log_result(str(src), status, msg)
                
                with state_lock:
                    if status:
                        progress_state["done"] += 1
                        add_state_log(f"Sucesso: {src.name}")
                    elif msg.startswith("SKIP"):
                        progress_state["skipped"] += 1
                        add_state_log(f"Ignorado: {src.name} ({msg})")
                    else:
                        progress_state["errors"] += 1
                        add_state_log(f"Erro: {src.name} | {msg}")
            except Exception as e:
                logger.log_result(str(src), False, str(e))
                with state_lock:
                    progress_state["errors"] += 1
                    add_state_log(f"Falha na thread para {src.name}: {e}")

    with state_lock:
        progress_state["processing"] = False
        progress_state["current_file"] = ""
    add_state_log("Processamento em lote finalizado.")

def run_server():
    server_address = ('', config.PORT)
    httpd = HTTPServer(server_address, APIHandler)
    print(f"Servidor HTTP do Conversor rodando em http://localhost:{config.PORT}...")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado pelo usuário.")
        sys.exit(0)

if __name__ == "__main__":
    # Se não houver argumentos de terminal, assume-se execução do servidor
    if len(sys.argv) < 2:
        print("Nenhum argumento de pasta informado.")
        run_server()
    else:
        first_arg = sys.argv[1]
        if first_arg == "--server":
            run_server()
        else:
            # Modo CLI offline
            input_dir = Path(first_arg)
            if not input_dir.exists() or not input_dir.is_dir():
                print(f"Erro: Pasta de entrada '{input_dir}' não existe ou não é um diretório.")
                sys.exit(1)

            output_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else input_dir / "converted"
            
            flac_files = list(input_dir.glob("**/*.flac"))
            print(f"Encontrados {len(flac_files)} arquivos .flac")
            if not flac_files:
                print("Nenhum arquivo para converter.")
                sys.exit(0)

            # Executar de forma síncrona/bloqueante no terminal
            run_batch_async(input_dir, output_dir)
            print("Concluído. Veja logs/ para detalhes.")
