#!/usr/bin/env python3
"""
Indicator differential test — independent reimplementation.

Recomputes Bollinger Bands, CCI and MFI from their textbook definitions in
pandas, on the exact CSV the TypeScript engine used, and compares the two
series value by value.

This is deliberately NOT a call into a TA library: a library could share the
same convention mistake (sample vs population deviation, standard deviation vs
mean absolute deviation) and agree with us while both are wrong. Writing the
formula out is the point.

Usage:
    pip install pandas
    npm test                                   # (re)writes scripts/differential/out/
    python scripts/differential/compare_indicators.py

Exit code 0 = the two implementations agree within tolerance.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

OUT = Path(__file__).parent / "out"
REL_TOL = 1e-9
ABS_TOL = 1e-9


def fail(msg: str) -> None:
    print(f"INDICATOR DIFFERENTIAL FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    try:
        import numpy as np
        import pandas as pd
    except ImportError as e:  # pragma: no cover
        fail(f"missing dependency ({e}). Run: pip install pandas")

    meta = json.loads((OUT / "indicator_meta.json").read_text(encoding="utf8"))
    p = meta["params"]
    bb_period = p["bollinger"]["period"]
    bb_std = p["bollinger"]["stdDevs"]
    cci_period = p["cci"]["period"]
    mfi_period = p["mfi"]["period"]

    df = pd.read_csv(OUT / "indicator_data.csv", parse_dates=["timestamp"])
    ts = pd.read_csv(OUT / "ts_indicators.csv")

    if len(df) != len(ts):
        fail(f"row count mismatch: data {len(df)} vs ts_indicators {len(ts)}")

    close = df["close"].astype(float)
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    volume = df["volume"].fillna(0).astype(float)

    # ── Bollinger: SMA ± k × population σ (ddof=0) ────────────────────────
    mid = close.rolling(bb_period).mean()
    sd = close.rolling(bb_period).std(ddof=0)
    upper = mid + bb_std * sd
    lower = mid - bb_std * sd

    # ── CCI: (TP − SMA(TP)) / (0.015 × mean absolute deviation) ───────────
    tp = (high + low + close) / 3.0
    tp_sma = tp.rolling(cci_period).mean()
    mad = tp.rolling(cci_period).apply(
        lambda w: np.abs(w - w.mean()).mean(), raw=True
    )
    with np.errstate(divide="ignore", invalid="ignore"):
        cci = (tp - tp_sma) / (0.015 * mad)
    cci = cci.where(mad != 0)  # flat window → undefined, matching the TS engine

    # ── MFI: volume-weighted RSI on typical price ─────────────────────────
    raw_flow = tp * volume
    delta = tp.diff()
    pos_flow = raw_flow.where(delta > 0, 0.0)
    neg_flow = raw_flow.where(delta < 0, 0.0)
    # First bar has no previous typical price and contributes nothing.
    pos_flow.iloc[0] = 0.0
    neg_flow.iloc[0] = 0.0
    pos_sum = pos_flow.rolling(mfi_period).sum()
    neg_sum = neg_flow.rolling(mfi_period).sum()
    mfi = pd.Series(np.nan, index=df.index, dtype=float)
    both_zero = (pos_sum == 0) & (neg_sum == 0)
    only_pos = (neg_sum == 0) & (pos_sum > 0)
    normal = neg_sum > 0
    mfi[normal] = 100 - 100 / (1 + pos_sum[normal] / neg_sum[normal])
    mfi[only_pos] = 100.0
    mfi[both_zero] = np.nan

    # The TS engine starts the MFI window at bar 1 (bar 0 has no delta), so its
    # first defined index is `period`, whereas a naive rolling(period) over a
    # series whose first element is a forced zero would define it at period-1.
    mfi.iloc[:mfi_period] = np.nan

    checks = [
        ("bb_middle", mid),
        ("bb_upper", upper),
        ("bb_lower", lower),
        ("cci", cci),
        ("mfi", mfi),
    ]

    total_compared = 0
    failures: list[str] = []

    for name, ref in checks:
        ours = pd.to_numeric(ts[name], errors="coerce")
        ref = pd.to_numeric(ref, errors="coerce")

        ours_defined = ours.notna()
        ref_defined = ref.notna()

        # Disagreeing about WHERE a value exists is as serious as disagreeing
        # about its magnitude — a silent warm-up shift would misalign every
        # downstream signal.
        shape_mismatch = (ours_defined != ref_defined).sum()
        if shape_mismatch:
            first = int((ours_defined != ref_defined).idxmax())
            failures.append(
                f"{name}: {shape_mismatch} bars disagree on whether a value is defined "
                f"(first at index {first}: ts={'set' if ours_defined[first] else 'null'}, "
                f"ref={'set' if ref_defined[first] else 'null'})"
            )
            continue

        both = ours_defined & ref_defined
        n = int(both.sum())
        if n == 0:
            failures.append(f"{name}: no overlapping defined values to compare")
            continue

        a = ours[both].to_numpy()
        b = ref[both].to_numpy()
        diff = np.abs(a - b)
        scale = np.maximum(np.abs(a), np.abs(b))

        # Per-element tolerance, the numpy.isclose formulation: a value passes
        # if it is within ABS_TOL *or* within REL_TOL of its own magnitude.
        # Comparing the worst relative error against the worst absolute error
        # would be incoherent — those can come from different bars, so a large
        # reading with harmless float noise could excuse a genuinely wrong
        # small one, or vice versa.
        allowed = ABS_TOL + REL_TOL * scale
        bad = diff > allowed
        total_compared += n

        rel = np.where(scale > 0, diff / scale, diff)
        worst_rel = float(rel.max())

        if bad.any():
            idx = int(np.argmax(diff - allowed))
            failures.append(
                f"{name}: {int(bad.sum())} of {n} values outside tolerance; "
                f"worst at ts={a[idx]!r} vs ref={b[idx]!r} "
                f"(absolute {diff[idx]:.3e}, allowed {allowed[idx]:.3e})"
            )
        else:
            print(
                f"  {name}: {n} values agree "
                f"(max absolute diff {float(diff.max()):.2e}, worst relative {worst_rel:.2e})"
            )

    if failures:
        for f in failures:
            print(f"  {f}")
        fail("independent implementations disagree — reconcile before trusting these indicators")

    print(
        f"INDICATOR DIFFERENTIAL PASS: {total_compared} values across "
        f"{len(checks)} series agree within {REL_TOL:.0e}."
    )
    print(f"(dataset hash {meta['datasetHash']}, {meta['bars']} bars)")


if __name__ == "__main__":
    main()
