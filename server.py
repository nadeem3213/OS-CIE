#!/usr/bin/env python3
"""
OS Monitor Dashboard — Backend Server
Serves real Mac system stats via JSON API + serves static files.
Run: python3 server.py
"""

import json
import os
import platform
import subprocess
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler

import psutil

PORT = 8080
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

# ── CPU / ISA detection (Mac-specific via sysctl) ─────────────────────────────
def get_cpu_info():
    info = {}

    # Brand string
    try:
        brand = subprocess.check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            stderr=subprocess.DEVNULL
        ).decode().strip()
    except Exception:
        brand = platform.processor() or "Unknown CPU"
    info["brand"] = brand

    # ISA / Architecture
    machine = platform.machine()          # arm64 | x86_64 | i686
    info["machine"] = machine
    if "arm64" in machine or "arm" in machine.lower():
        info["isa"] = "ARM64 (AArch64)"
        info["isa_short"] = "ARM64"
    elif "x86_64" in machine or "AMD64" in machine:
        info["isa"] = "x86-64 (AMD64)"
        info["isa_short"] = "x86-64"
    elif "i386" in machine or "i686" in machine:
        info["isa"] = "x86 (IA-32)"
        info["isa_short"] = "x86"
    else:
        info["isa"] = machine
        info["isa_short"] = machine

    info["bits"] = "64-bit" if "64" in machine else "32-bit"

    # Core / thread counts
    info["physical_cores"] = psutil.cpu_count(logical=False) or 1
    info["logical_cores"]  = psutil.cpu_count(logical=True)  or 1

    # Frequency
    freq = psutil.cpu_freq()
    if freq:
        info["freq_current_mhz"] = round(freq.current, 0)
        info["freq_max_mhz"]     = round(freq.max, 0) if freq.max else round(freq.current, 0)
    else:
        # Apple Silicon fallback
        try:
            hz = subprocess.check_output(
                ["sysctl", "-n", "hw.cpufrequency_max"],
                stderr=subprocess.DEVNULL
            ).decode().strip()
            info["freq_max_mhz"] = round(int(hz) / 1e6, 0) if hz else 0
            info["freq_current_mhz"] = info["freq_max_mhz"]
        except Exception:
            info["freq_current_mhz"] = 0
            info["freq_max_mhz"] = 0

    # Cache sizes (sysctl)
    for level, key in [("l1d","hw.l1dcachesize"), ("l2","hw.l2cachesize"), ("l3","hw.l3cachesize")]:
        try:
            val = subprocess.check_output(["sysctl","-n",key], stderr=subprocess.DEVNULL).decode().strip()
            info[f"cache_{level}"] = round(int(val)/1024) if val else None
        except Exception:
            info[f"cache_{level}"] = None

    return info

# ── Static CPU info (doesn't change) ──────────────────────────────────────────
_STATIC_CPU = get_cpu_info()

# ── macOS-accurate memory via vm_stat ────────────────────────────────────────
def get_macos_memory():
    """
    Parse `vm_stat` to get Activity-Monitor-accurate memory breakdown.
    macOS does NOT expose a simple "used/free" — it uses:
      Wired   = kernel + app memory that CANNOT be swapped out
      Active  = recently accessed pages (in use right now)
      Inactive= pages not recently used but NOT yet freed (reclaimable)
      Speculative = prefetched, very cheap to free
      Compressed = pages compressed by memory compressor
      Free    = genuinely empty pages
    Activity Monitor "Memory Used" = Wired + Active + Inactive (excl. speculative)
    """
    mem  = psutil.virtual_memory()
    swap = psutil.swap_memory()
    page = 16384  # default page size; overridden by vm_stat header

    pages = {}
    try:
        raw = subprocess.check_output(["vm_stat"], stderr=subprocess.DEVNULL).decode()
        for line in raw.splitlines():
            if "page size of" in line:
                try:
                    page = int(line.split("page size of")[1].split()[0])
                except Exception:
                    pass
                continue
            if ":" not in line or line.strip().startswith('"'):
                continue
            key, _, val = line.partition(":")
            try:
                pages[key.strip()] = int(val.strip().rstrip("."))
            except ValueError:
                pass
    except Exception:
        pass

    def gb(key, default=0):
        return round(pages.get(key, default) * page / 1e9, 2)

    wired       = gb("Pages wired down")
    active      = gb("Pages active")
    inactive    = gb("Pages inactive")
    speculative = gb("Pages speculative")
    free        = gb("Pages free")
    purgeable   = gb("Pages purgeable")

    # Compressed memory (may not exist on older macOS)
    compressed  = gb("Pages occupied by compressor")

    total_gb    = round(mem.total / 1e9, 2)

    # "App Memory" (Activity Monitor top bar) = Active + Inactive - Purgeable
    app_memory  = round(active + inactive - purgeable, 2)

    # "Memory Used" = Wired + App Memory + Compressed  (matches Activity Monitor)
    used_gb     = round(wired + app_memory + compressed, 2)
    used_gb     = min(used_gb, total_gb)   # safety cap

    # Available = what the OS can hand out quickly
    available_gb = round(mem.available / 1e9, 2)

    # Percent = used / total  (same as Activity Monitor "Memory Pressure" basis)
    percent     = round(used_gb / total_gb * 100, 1)

    return {
        "total_gb":     total_gb,
        "used_gb":      used_gb,        # Wired + App + Compressed
        "available_gb": available_gb,   # what OS can allocate freely
        "free_gb":      round(free + speculative, 2),  # genuinely empty
        "wired_gb":     wired,          # kernel / always-resident
        "active_gb":    active,         # in use right now
        "inactive_gb":  inactive,       # cached, reclaimable
        "compressed_gb":compressed,     # memory compressor
        "app_memory_gb":app_memory,     # active+inactive-purgeable
        "percent":      percent,
        "swap_used_gb":  round(swap.used  / 1e9, 2),
        "swap_total_gb": round(swap.total / 1e9, 2),
        "swap_pct":      round(swap.percent, 1),
    }

# ── Locality of Reference Experiment (Row-Major vs Column-Major) ──────────────
def run_locality_experiment():
    """
    Run a CPU cache locality experiment by compiling and running the user's C++ code.
    Runs once at server startup to avoid lagging the API.
    """
    cpp_file = os.path.join(STATIC_DIR, "locality.cpp")
    exe_file = os.path.join(STATIC_DIR, "locality_test")

    try:
        # Compile the C++ code
        subprocess.check_call(["clang++", "-O0", cpp_file, "-o", exe_file], stderr=subprocess.DEVNULL)
        
        # Run the executable
        output = subprocess.check_output([exe_file]).decode("utf-8")
        
        row_time = 0
        col_time = 0
        ratio = 1.0
        
        # Parse output
        for line in output.splitlines():
            if "Row-major time" in line:
                # Row-major time    : 24747 microseconds
                row_time = int(line.split(":")[1].split()[0])
            elif "Column-major time" in line:
                col_time = int(line.split(":")[1].split()[0])
            elif "Column-major is" in line:
                ratio = float(line.split(":")[1].split("x")[0].strip())
        
        return {
            "n": 5000,
            "row_time_ms": round(row_time / 1000, 2), # convert micro to ms
            "col_time_ms": round(col_time / 1000, 2),
            "ratio": ratio,
            "raw_output": output
        }
    except Exception as e:
        print(f"Error running C++ experiment: {e}")
        return {
            "n": 5000,
            "row_time_ms": 0,
            "col_time_ms": 0,
            "ratio": 1.0,
            "raw_output": "Error compiling or running C++ code."
        }

# Run once globally
print("  Compiling and running C++ locality experiment...")
_LOCALITY_DATA = run_locality_experiment()
print(f"  Experiment done: Row={_LOCALITY_DATA['row_time_ms']}ms, Col={_LOCALITY_DATA['col_time_ms']}ms")

# ── Real-time stats ────────────────────────────────────────────────────────────
def get_stats():
    # CPU usage (per-core + total)
    cpu_total  = psutil.cpu_percent(interval=None)
    cpu_per    = psutil.cpu_percent(interval=None, percpu=True)

    # macOS-accurate memory
    mem_data = get_macos_memory()

    # Disk
    try:
        disk = psutil.disk_usage("/")
        disk_pct   = disk.percent
        disk_total = round(disk.total / 1e9, 1)
        disk_used  = round(disk.used  / 1e9, 1)
        disk_free  = round(disk.free  / 1e9, 1)
    except Exception:
        disk_pct = disk_total = disk_used = disk_free = 0

    # Disk I/O
    try:
        io1 = psutil.disk_io_counters()
        time.sleep(0.05)
        io2 = psutil.disk_io_counters()
        disk_read_mb  = round((io2.read_bytes  - io1.read_bytes)  / 1e6 / 0.05, 2)
        disk_write_mb = round((io2.write_bytes - io1.write_bytes) / 1e6 / 0.05, 2)
    except Exception:
        disk_read_mb = disk_write_mb = 0.0

    # Network I/O
    try:
        net1 = psutil.net_io_counters()
        time.sleep(0.05)
        net2 = psutil.net_io_counters()
        net_sent_kb = round((net2.bytes_sent - net1.bytes_sent) / 1024 / 0.05, 1)
        net_recv_kb = round((net2.bytes_recv - net1.bytes_recv) / 1024 / 0.05, 1)
        net_total_sent_mb = round(net2.bytes_sent / 1e6, 1)
        net_total_recv_mb = round(net2.bytes_recv / 1e6, 1)
    except Exception:
        net_sent_kb = net_recv_kb = 0.0
        net_total_sent_mb = net_total_recv_mb = 0.0

    # Load averages
    try:
        load1, load5, load15 = os.getloadavg()
    except Exception:
        load1 = load5 = load15 = 0.0

    # Top processes
    procs = []
    for p in psutil.process_iter(['pid','name','status','cpu_percent','memory_percent','num_threads']):
        try:
            info = p.info
            # Map psutil status to our labels
            state_map = {
                "running": "running", "sleeping": "sleeping",
                "disk-sleep": "waiting", "stopped": "stopped",
                "zombie": "zombie",   "idle": "sleeping",
                "dead": "stopped",    "wake": "running",
            }
            procs.append({
                "pid":     info["pid"],
                "name":    info["name"] or "unknown",
                "state":   state_map.get(info["status"], "sleeping"),
                "cpu":     round(info["cpu_percent"] or 0, 1),
                "mem":     round(info["memory_percent"] or 0, 2),
                "threads": info["num_threads"] or 1,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    # Sort by CPU, take top 5
    procs.sort(key=lambda x: x["cpu"], reverse=True)
    top5 = procs[:5]

    # Uptime
    boot_time  = psutil.boot_time()
    uptime_sec = int(time.time() - boot_time)

    # OS info
    os_info = {
        "os":      f"{platform.system()} {platform.mac_ver()[0] or platform.version()}",
        "kernel":  platform.release(),
        "machine": platform.machine(),
        "node":    platform.node(),
        "python":  platform.python_version(),
    }

    return {
        "cpu": {
            **_STATIC_CPU,
            "usage_total": cpu_total,
            "usage_per_core": cpu_per,
        },
        "memory": mem_data,
        "locality": _LOCALITY_DATA,
        "disk": {
            "pct":       disk_pct,
            "total_gb":  disk_total,
            "used_gb":   disk_used,
            "free_gb":   disk_free,
            "read_mb_s": disk_read_mb,
            "write_mb_s":disk_write_mb,
        },
        "network": {
            "sent_kb_s":      net_sent_kb,
            "recv_kb_s":      net_recv_kb,
            "total_sent_mb":  net_total_sent_mb,
            "total_recv_mb":  net_total_recv_mb,
        },
        "load": {
            "load1": round(load1, 2),
            "load5": round(load5, 2),
            "load15":round(load15, 2),
        },
        "processes":    top5,
        "total_procs":  len(procs),
        "uptime_sec":   uptime_sec,
        "os":           os_info,
        "timestamp":    time.time(),
    }


# ── HTTP Request Handler ───────────────────────────────────────────────────────
class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/stats":
            self._serve_json(get_stats())
        elif self.path == "/api/cpu_info":
            self._serve_json(_STATIC_CPU)
        else:
            super().do_GET()

    def _serve_json(self, data):
        body = json.dumps(data, default=str).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Suppress noisy per-request logs; only show API hits
        try:
            req_str = str(args[0]) if args else ""
            if "/api/" in req_str:
                print(f"  [API] {req_str.split(' ')[1]}")
        except Exception:
            pass


# ── Entry Point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Pre-warm psutil cpu_percent (first call returns 0)
    psutil.cpu_percent(interval=0.1)

    print(f"\n{'='*52}")
    print(f"  OS Monitor Dashboard")
    print(f"  http://localhost:{PORT}")
    print(f"  API: http://localhost:{PORT}/api/stats")
    print(f"{'='*52}\n")

    server = HTTPServer(("", PORT), DashboardHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        server.server_close()
