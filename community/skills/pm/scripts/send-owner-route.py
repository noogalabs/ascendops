#!/usr/bin/env python3
"""PM example adapter: one approved owner binding, argv-only delivery.

Exit 0: sender returned success; 20: invalid/unbound; 21: outcome unknown; 22: not sent (pre-launch failure).
Coordinator notification is owned by the caller, independently of this reader.
"""
import json
import os
from pathlib import Path
import subprocess
import sys


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def read_binding(path):
    raw = Path(path).read_bytes()
    if raw.startswith(b"\xef\xbb\xbf") or b"\x00" in raw:
        raise ValueError("invalid encoding")
    value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=unique_object)
    if not isinstance(value, dict) or set(value) != {"argv", "recipient"}:
        raise ValueError("expected one binding")
    argv, recipient = value["argv"], value["recipient"]
    if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or not x.strip() or "\x00" in x for x in argv):
        raise ValueError("invalid argv")
    if not os.path.isabs(argv[0]):
        raise ValueError("sender executable must be absolute")
    if not isinstance(recipient, str) or not recipient.strip() or "\x00" in recipient:
        raise ValueError("invalid recipient")
    return argv, recipient


def main():
    if len(sys.argv) != 3 or not sys.argv[1]:
        return 20
    try:
        argv, recipient = read_binding(sys.argv[1])
    except Exception:
        return 20
    try:
        result = subprocess.run(argv + [recipient, sys.argv[2]], shell=False,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, ValueError, UnicodeError):
        return 22
    except Exception:
        return 21
    return 0 if result.returncode == 0 else 21


if __name__ == "__main__":
    sys.exit(main())
