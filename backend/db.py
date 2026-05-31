"""SQLite 永続化 (stdlib sqlite3)."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "visualizer.db"


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init_db() -> None:
    with _conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                source TEXT NOT NULL,
                dest TEXT NOT NULL,
                amount_sat INTEGER NOT NULL,
                payment_request TEXT,
                payment_hash TEXT,
                status TEXT NOT NULL,
                error TEXT
            )
            """
        )


def record_payment(
    source: str,
    dest: str,
    amount_sat: int,
    payment_request: str,
    payment_hash: str,
    status: str,
    error: str = "",
) -> int:
    ts = datetime.now(timezone.utc).isoformat()
    with _conn() as c:
        cur = c.execute(
            """
            INSERT INTO payments
              (timestamp, source, dest, amount_sat, payment_request, payment_hash, status, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (ts, source, dest, amount_sat, payment_request, payment_hash, status, error),
        )
        return int(cur.lastrowid)


def recent_payments(limit: int = 50) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM payments ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]
