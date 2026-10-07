# Third-party code

`codex_bridge/ipc.py`, `transport.py`, and `model.py` are copied without changes from
https://github.com/try2love/codex-mobile-bridge at commit
`560fc434c248882f206a6ee16a20b5a824533080` (MIT, copyright 2026 try2love).
The complete license is retained alongside the code and included in the desktop bundle.
TokenFree's adapter wraps the IPC and normalization functions. We do not reuse the
upstream account switching, auth/config mutation, tunnels, HTTP gateway or app-server
creation code. Those are outside this product's boundary.
