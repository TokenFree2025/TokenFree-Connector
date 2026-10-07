#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x .local/build-venv/bin/python ]; then
  python3 -m venv .local/build-venv
  .local/build-venv/bin/pip install -r scripts/build-requirements.txt
fi
.local/build-venv/bin/python -m PyInstaller --noconfirm --clean --onefile --name tokenfree-adapter --paths vendor --distpath .local/adapter --workpath .local/pyinstaller --specpath .local adapter/main.py
