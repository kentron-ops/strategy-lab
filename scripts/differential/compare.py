#!/usr/bin/env python3
"""
Differential test — the independent second engine (Build Spec V2 §6).

Reruns the exported strategy (EMA 10/40 cross, long only, fixed price stop and
target anchored to the signal bar close, fill at next bar open, zero costs)
with backtesting.py on the exact CSV the TypeScript engine used, then compares
the two trade lists row by row.

Usage:
    pip install backtesting
    npm test              # (re)writes scripts/differential/out/
    python scripts/differential/compare.py

Exit code 0 = engines agree within documented tolerance. Anything else = stop
and reconcile before trusting any number the app shows.
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).parent / "out"
PRICE_TOL = 1e-6
MAX_MISMATCH_PCT = 1.0


def fail(msg: str) -> None:
    print(f"DIFFERENTIAL FAIL: {msg}")
    sys.exit(1)


def load_meta() -> dict:
    with open(OUT / "meta.json", encoding="utf8") as f:
        return json.load(f)


def load_ts_trades() -> list[dict]:
    with open(OUT / "ts_trades.csv", encoding="utf8") as f:
        return list(csv.DictReader(f))


def run_reference() -> list[dict]:
    """Run backtesting.py on the exported CSV with the same rules."""
    try:
        import pandas as pd
        from backtesting import Backtest, Strategy
    except ImportError as e:  # pragma: no cover
        fail(
            f"missing dependency ({e}). Run: pip install backtesting pandas"
        )

    df = pd.read_csv(OUT / "data.csv", parse_dates=["timestamp"])
    df = df.rename(
        columns={
            "timestamp": "Time",
            "open": "Open",
            "high": "High",
            "low": "Low",
            "close": "Close",
            "volume": "Volume",
        }
    ).set_index("Time")

    STOP = 15.0
    TARGET = 30.0

    def ema(series, period):
        return series.ewm(span=period, adjust=False).mean()

    class EmaCross(Strategy):
        def init(self):
            close = pd.Series(self.data.Close, index=self.data.index)
            # Match the TS engine's seeding: SMA of the first `period` values,
            # then the standard recursive EMA. pandas ewm(adjust=False) seeds
            # with the first VALUE, which diverges early — so seed explicitly.
            self.ema10 = self.I(seeded_ema, close, 10)
            self.ema40 = self.I(seeded_ema, close, 40)

        def next(self):
            if self.position:
                return
            i = len(self.data.Close) - 1
            if i < 1:
                return
            f0, f1 = self.ema10[-2], self.ema10[-1]
            s0, s1 = self.ema40[-2], self.ema40[-1]
            if any(map(lambda x: x != x, (f0, f1, s0, s1))):  # NaN guard
                return
            if f0 <= s0 and f1 > s1:  # CROSS_ABOVE, same semantics as TS
                anchor = self.data.Close[-1]
                self.buy(size=1, sl=anchor - STOP, tp=anchor + TARGET)

    def seeded_ema(series, period):
        import numpy as np

        values = series.to_numpy(dtype=float)
        out = np.full(len(values), np.nan)
        if len(values) < period:
            return out
        seed = values[:period].mean()
        out[period - 1] = seed
        k = 2.0 / (period + 1.0)
        prev = seed
        for i in range(period, len(values)):
            prev = values[i] * k + prev * (1.0 - k)
            out[i] = prev
        return out

    bt = Backtest(
        df,
        EmaCross,
        cash=1_000_000,
        commission=0.0,
        trade_on_close=False,  # fill at next bar open, like the TS engine
        exclusive_orders=False,
        finalize_trades=True,
    )
    stats = bt.run()
    trades = stats["_trades"]

    out = []
    for _, t in trades.iterrows():
        out.append(
            {
                "entry_time": t["EntryTime"].to_pydatetime().replace(tzinfo=timezone.utc),
                "exit_time": t["ExitTime"].to_pydatetime().replace(tzinfo=timezone.utc),
                "entry_price": float(t["EntryPrice"]),
                "exit_price": float(t["ExitPrice"]),
                "gross_per_unit": float(t["ExitPrice"]) - float(t["EntryPrice"]),
            }
        )
    return out


def main() -> None:
    meta = load_meta()
    ts = load_ts_trades()
    ref = run_reference()

    print(f"TS engine trades:        {len(ts)}")
    print(f"Reference engine trades: {len(ref)}")

    if abs(len(ts) - len(ref)) > max(1, round(len(ts) * MAX_MISMATCH_PCT / 100)):
        fail(f"trade counts diverge beyond tolerance: {len(ts)} vs {len(ref)}")

    mismatches = []
    for i, (a, b) in enumerate(zip(ts, ref)):
        a_entry = datetime.fromisoformat(a["entry_time"].replace("Z", "+00:00"))
        ambiguous = a.get("ambiguous") == "1"
        problems = []
        if a_entry != b["entry_time"]:
            problems.append(f"entry_time {a_entry} vs {b['entry_time']}")
        if abs(float(a["entry_price"]) - b["entry_price"]) > PRICE_TOL:
            problems.append(f"entry_price {a['entry_price']} vs {b['entry_price']}")
        if abs(float(a["exit_price"]) - b["exit_price"]) > PRICE_TOL and not ambiguous:
            problems.append(f"exit_price {a['exit_price']} vs {b['exit_price']}")
        if problems:
            mismatches.append((i, problems, ambiguous))

    hard = [m for m in mismatches if not m[2]]
    pct = 100.0 * len(hard) / max(1, len(ts))
    for i, problems, ambiguous in mismatches[:10]:
        tag = " (ambiguous, tolerated)" if ambiguous else ""
        print(f"  trade {i}{tag}: " + "; ".join(problems))

    print(f"Hard mismatches: {len(hard)} of {len(ts)} ({pct:.2f}%), tolerance {MAX_MISMATCH_PCT}%")
    if pct > MAX_MISMATCH_PCT:
        fail("engines disagree beyond documented tolerance — reconcile before trusting results")

    print("DIFFERENTIAL PASS: independent engines agree on the trade list.")
    print(f"(dataset hash {meta['datasetHash']}, {meta['bars']} bars, engine v{meta['engineVersion']})")


if __name__ == "__main__":
    main()
