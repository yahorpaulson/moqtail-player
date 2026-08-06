#!/usr/bin/env python3
"""
Universal analyser for MoQ experiment CSV files.

Creates one PNG per CSV file with:
  1. E2E latency and player latency
  2. Raw and smoothed inter-arrival time
  3. Buffer level
  4. Playback stall regions
  5. Optional 10-second E2E and player-latency means
  6. Summary statistics

Examples:
    py analyser.py 720p2.csv
    py analyser.py 480p.csv 720p.csv 1080p.csv
    py analyser.py "results/*.csv"
    py analyser.py results --recursive
    py analyser.py 720p2.csv --show
    py analyser.py "results/*.csv" --output-dir graphs
"""

from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path
from typing import Iterable

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


REQUIRED_COLUMNS = {
    "elapsed_seconds",
    "event_type",
}

NUMERIC_COLUMNS = [
    "elapsed_seconds",
    "e2e_latency_ms",
    "player_latency_ms",
    "mean_10s_e2e_latency_ms",
    "mean_10s_player_latency_ms",
    "mean_block_start_seconds",
    "mean_block_end_seconds",
    "mean_block_e2e_samples",
    "mean_block_player_samples",
    "e2e_latency_change_ms",
    "buffer_seconds",
    "stall_number",
    "stall_duration_ms",
    "group_id",
    "track_alias",
    "inter_arrival_ms",
    "smoothed_inter_arrival_ms",
]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Analyse one or more MoQ experiment CSV files and create one graph "
            "per file."
        )
    )

    parser.add_argument(
        "inputs",
        nargs="+",
        help=(
            "CSV files, directories, or glob patterns. "
            'Examples: 720p.csv, results, "results/*.csv"'
        ),
    )

    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help=(
            "Directory for generated PNG files. "
            "By default, each PNG is saved next to its CSV."
        ),
    )

    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Search directories recursively for CSV files.",
    )

    parser.add_argument(
        "--show",
        action="store_true",
        help="Display each graph after saving it.",
    )

    parser.add_argument(
        "--dpi",
        type=int,
        default=250,
        help="Output resolution. Default: 250 DPI.",
    )

    parser.add_argument(
        "--mean-window",
        type=float,
        default=10.0,
        help=(
            "Fallback mean window in seconds when CSV mean rows are absent. "
            "Default: 10."
        ),
    )

    parser.add_argument(
        "--alpha",
        type=float,
        default=0.3,
        help="Alpha value shown in the smoothed-IAT label. Default: 0.3.",
    )

    return parser.parse_args()


def resolve_input_files(
    inputs: Iterable[str],
    recursive: bool,
) -> list[Path]:
    resolved: list[Path] = []

    for item in inputs:
        path = Path(item)

        if path.is_file():
            if path.suffix.lower() == ".csv":
                resolved.append(path.resolve())
            continue

        if path.is_dir():
            pattern = "**/*.csv" if recursive else "*.csv"
            resolved.extend(candidate.resolve() for candidate in path.glob(pattern))
            continue

        # Treat unresolved input as a glob pattern.
        matches = glob.glob(item, recursive=recursive)
        for match in matches:
            candidate = Path(match)
            if candidate.is_file() and candidate.suffix.lower() == ".csv":
                resolved.append(candidate.resolve())

    # Remove duplicates while preserving sorted order.
    unique = sorted(set(resolved), key=lambda value: str(value).lower())
    return unique


def load_csv(csv_path: Path) -> pd.DataFrame:
    try:
        df = pd.read_csv(csv_path, index_col=False)
    except Exception as exc:
        raise ValueError(f"Could not read CSV: {exc}") from exc

    missing = REQUIRED_COLUMNS.difference(df.columns)
    if missing:
        raise ValueError(
            "Missing required CSV columns: " + ", ".join(sorted(missing))
        )

    for column in NUMERIC_COLUMNS:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")

    df["event_type"] = df["event_type"].astype(str).str.strip()
    return df


def event_rows(
    df: pd.DataFrame,
    event_type: str,
    columns: list[str],
) -> pd.DataFrame:
    existing_columns = [column for column in columns if column in df.columns]

    result = df.loc[
        df["event_type"].eq(event_type),
        existing_columns,
    ].copy()

    if "elapsed_seconds" in result.columns:
        result = result.dropna(subset=["elapsed_seconds"])
        result = result.sort_values("elapsed_seconds")

    return result.reset_index(drop=True)


def calculate_time_block_means(
    samples: pd.DataFrame,
    value_column: str,
    window_seconds: float,
) -> pd.DataFrame:
    if samples.empty or value_column not in samples.columns:
        return pd.DataFrame(
            columns=["start_seconds", "end_seconds", "mean_value", "sample_count"]
        )

    valid = samples.dropna(subset=["elapsed_seconds", value_column]).copy()
    if valid.empty:
        return pd.DataFrame(
            columns=["start_seconds", "end_seconds", "mean_value", "sample_count"]
        )

    if window_seconds <= 0:
        raise ValueError("--mean-window must be greater than zero.")

    valid["block_index"] = np.floor(
        valid["elapsed_seconds"] / window_seconds
    ).astype(int)

    grouped = valid.groupby("block_index")[value_column].agg(["mean", "count"])

    result = grouped.reset_index()
    result["start_seconds"] = result["block_index"] * window_seconds
    result["end_seconds"] = result["start_seconds"] + window_seconds
    result = result.rename(
        columns={
            "mean": "mean_value",
            "count": "sample_count",
        }
    )

    return result[
        ["start_seconds", "end_seconds", "mean_value", "sample_count"]
    ]


def extract_mean_blocks(
    df: pd.DataFrame,
    latency: pd.DataFrame,
    value_column: str,
    csv_mean_column: str,
    fallback_window_seconds: float,
) -> pd.DataFrame:
    mean_rows = event_rows(
        df,
        "latency_10s_mean",
        [
            "elapsed_seconds",
            csv_mean_column,
            "mean_block_start_seconds",
            "mean_block_end_seconds",
        ],
    )

    if (
        not mean_rows.empty
        and csv_mean_column in mean_rows.columns
        and mean_rows[csv_mean_column].notna().any()
    ):
        valid = mean_rows.dropna(subset=[csv_mean_column]).copy()

        if (
            "mean_block_start_seconds" in valid.columns
            and "mean_block_end_seconds" in valid.columns
            and valid["mean_block_start_seconds"].notna().any()
            and valid["mean_block_end_seconds"].notna().any()
        ):
            valid = valid.dropna(
                subset=[
                    "mean_block_start_seconds",
                    "mean_block_end_seconds",
                ]
            )

            # Export may contain two rows per block. Remove duplicates.
            valid = valid.drop_duplicates(
                subset=[
                    "mean_block_start_seconds",
                    "mean_block_end_seconds",
                    csv_mean_column,
                ]
            )

            return pd.DataFrame(
                {
                    "start_seconds": valid["mean_block_start_seconds"],
                    "end_seconds": valid["mean_block_end_seconds"],
                    "mean_value": valid[csv_mean_column],
                }
            ).sort_values("start_seconds")

    return calculate_time_block_means(
        latency,
        value_column,
        fallback_window_seconds,
    )


def extract_stalls(df: pd.DataFrame) -> list[dict[str, float]]:
    starts = event_rows(
        df,
        "stall_start",
        ["elapsed_seconds", "stall_number"],
    )

    ends = event_rows(
        df,
        "stall_end",
        [
            "elapsed_seconds",
            "stall_number",
            "stall_duration_ms",
        ],
    )

    stalls: list[dict[str, float]] = []

    if starts.empty:
        return stalls

    used_end_indices: set[int] = set()

    for start_position, start_row in starts.iterrows():
        start_seconds = float(start_row["elapsed_seconds"])
        stall_number = (
            int(start_row["stall_number"])
            if "stall_number" in starts.columns
            and pd.notna(start_row.get("stall_number"))
            else start_position + 1
        )

        matching_end = None
        matching_end_index = None

        # Prefer matching by stall number.
        if (
            not ends.empty
            and "stall_number" in ends.columns
            and pd.notna(start_row.get("stall_number"))
        ):
            candidates = ends.loc[
                ends["stall_number"].eq(start_row["stall_number"])
                & ends["elapsed_seconds"].ge(start_seconds)
            ]

            for index, row in candidates.iterrows():
                if index not in used_end_indices:
                    matching_end = row
                    matching_end_index = index
                    break

        # Fallback: first unused end after the start.
        if matching_end is None and not ends.empty:
            candidates = ends.loc[ends["elapsed_seconds"].ge(start_seconds)]

            for index, row in candidates.iterrows():
                if index not in used_end_indices:
                    matching_end = row
                    matching_end_index = index
                    break

        if matching_end is None:
            continue

        used_end_indices.add(int(matching_end_index))
        end_seconds = float(matching_end["elapsed_seconds"])

        duration_ms = (
            float(matching_end["stall_duration_ms"])
            if "stall_duration_ms" in matching_end
            and pd.notna(matching_end["stall_duration_ms"])
            else max(0.0, end_seconds - start_seconds) * 1000.0
        )

        stalls.append(
            {
                "number": stall_number,
                "start": start_seconds,
                "end": end_seconds,
                "duration_ms": duration_ms,
            }
        )

    return stalls


def safe_stat(series: pd.Series, method: str) -> float | None:
    valid = pd.to_numeric(series, errors="coerce").dropna()
    if valid.empty:
        return None
    return float(getattr(valid, method)())


def format_stat(value: float | None, digits: int = 1) -> str:
    if value is None or not np.isfinite(value):
        return "n/a"
    return f"{value:.{digits}f}"


def quality_label(df: pd.DataFrame) -> str:
    if "quality" not in df.columns:
        return "unknown"

    values = (
        df["quality"]
        .dropna()
        .astype(str)
        .str.strip()
    )
    values = values[values.ne("")]

    return values.iloc[0] if not values.empty else "unknown"


def upload_limit_label(df: pd.DataFrame) -> str:
    if "upload_limit_mbps" not in df.columns:
        return "unknown"

    values = (
        df["upload_limit_mbps"]
        .dropna()
        .astype(str)
        .str.strip()
    )
    values = values[values.ne("")]

    return values.iloc[0] if not values.empty else "unknown"


def add_stall_regions(
    axes: Iterable[plt.Axes],
    stalls: list[dict[str, float]],
) -> None:
    axes = list(axes)

    for stall_index, stall in enumerate(stalls):
        for axis_index, axis in enumerate(axes):
            axis.axvspan(
                stall["start"],
                stall["end"],
                alpha=0.16,
                label=(
                    "Playback stall"
                    if stall_index == 0 and axis_index == 0
                    else None
                ),
            )

        if axes:
            midpoint = (stall["start"] + stall["end"]) / 2.0
            axes[0].annotate(
                f"Stall {stall['number']}\n{stall['duration_ms']:.0f} ms",
                xy=(midpoint, 0.98),
                xycoords=("data", "axes fraction"),
                xytext=(0, -3),
                textcoords="offset points",
                ha="center",
                va="top",
                fontsize=7,
                rotation=90,
            )


def plot_mean_blocks(
    axis: plt.Axes,
    blocks: pd.DataFrame,
    label: str,
    linewidth: float = 2.3,
) -> None:
    if blocks.empty:
        return

    label_used = False

    for _, block in blocks.iterrows():
        start = block.get("start_seconds")
        end = block.get("end_seconds")
        mean_value = block.get("mean_value")

        if not (
            pd.notna(start)
            and pd.notna(end)
            and pd.notna(mean_value)
        ):
            continue

        axis.hlines(
            float(mean_value),
            float(start),
            float(end),
            linewidth=linewidth,
            label=label if not label_used else None,
        )
        label_used = True


def create_graph(
    df: pd.DataFrame,
    csv_path: Path,
    output_path: Path,
    mean_window_seconds: float,
    alpha: float,
    dpi: int,
    show: bool,
) -> None:
    latency = event_rows(
        df,
        "latency_sample",
        [
            "elapsed_seconds",
            "e2e_latency_ms",
            "player_latency_ms",
            "stall_active",
        ],
    )

    inter_arrival = event_rows(
        df,
        "inter_arrival_sample",
        [
            "elapsed_seconds",
            "group_id",
            "track_alias",
            "inter_arrival_ms",
            "smoothed_inter_arrival_ms",
        ],
    )

   
    if latency.empty and inter_arrival.empty:
        raise ValueError(
            "No latency_sample or inter_arrival_sample rows found."
        )
        
    e2e_means = extract_mean_blocks(
        df=df,
        latency=latency,
        value_column="e2e_latency_ms",
        csv_mean_column="mean_10s_e2e_latency_ms",
        fallback_window_seconds=mean_window_seconds,
    )

    player_means = extract_mean_blocks(
        df=df,
        latency=latency,
        value_column="player_latency_ms",
        csv_mean_column="mean_10s_player_latency_ms",
        fallback_window_seconds=mean_window_seconds,
    )

    stalls = extract_stalls(df)

    fig, (ax_latency, ax_iat) = plt.subplots(
        2,
        1,
        figsize=(15, 8),
        sharex=True,
        gridspec_kw={"height_ratios": [2, 1]},
    )
    # Panel 1: latency
    if (
        not latency.empty
        and "e2e_latency_ms" in latency.columns
        and latency["e2e_latency_ms"].notna().any()
    ):
        valid = latency.dropna(subset=["e2e_latency_ms"])
        ax_latency.plot(
            valid["elapsed_seconds"],
            valid["e2e_latency_ms"],
            marker="o",
            markersize=2.8,
            linewidth=1.0,
            alpha=0.75,
            label="E2E latency",
        )

        plot_mean_blocks(
            ax_latency,
            e2e_means,
            f"E2E mean per {mean_window_seconds:g} s",
        )

        overall_e2e = safe_stat(valid["e2e_latency_ms"], "mean")
        if overall_e2e is not None:
            ax_latency.axhline(
                overall_e2e,
                linestyle="--",
                linewidth=1.1,
                alpha=0.8,
                label=f"Overall E2E mean: {overall_e2e:.1f} ms",
            )

    if (
        not latency.empty
        and "player_latency_ms" in latency.columns
        and latency["player_latency_ms"].notna().any()
    ):
        valid = latency.dropna(subset=["player_latency_ms"])
        ax_latency.plot(
            valid["elapsed_seconds"],
            valid["player_latency_ms"],
            linewidth=0.9,
            alpha=0.6,
            label="Player latency",
        )

        plot_mean_blocks(
            ax_latency,
            player_means,
            f"Player mean per {mean_window_seconds:g} s",
            linewidth=1.8,
        )

    ax_latency.set_ylabel("Latency (ms)")
    ax_latency.set_title(
        f"MoQ experiment analysis: {csv_path.name}\n"
        f"quality={quality_label(df)}, upload limit={upload_limit_label(df)}"
    )
    ax_latency.grid(True, alpha=0.3)
    ax_latency.legend(loc="best")

    # Panel 2: inter-arrival
    if (
        not inter_arrival.empty
        and "inter_arrival_ms" in inter_arrival.columns
        and inter_arrival["inter_arrival_ms"].notna().any()
    ):
        valid = inter_arrival.dropna(subset=["inter_arrival_ms"])
        ax_iat.plot(
            valid["elapsed_seconds"],
            valid["inter_arrival_ms"],
            marker="o",
            markersize=3,
            linewidth=0.9,
            alpha=0.55,
            label="Raw inter-arrival",
        )

    if (
        not inter_arrival.empty
        and "smoothed_inter_arrival_ms" in inter_arrival.columns
        and inter_arrival["smoothed_inter_arrival_ms"].notna().any()
    ):
        valid = inter_arrival.dropna(subset=["smoothed_inter_arrival_ms"])
        ax_iat.plot(
            valid["elapsed_seconds"],
            valid["smoothed_inter_arrival_ms"],
            marker="s",
            markersize=3,
            linewidth=1.5,
            alpha=0.9,
            label=f"Smoothed inter-arrival (α={alpha:g})",
        )

    ax_iat.set_ylabel("Inter-arrival (ms)")
    ax_iat.grid(True, alpha=0.3)
    ax_iat.legend(loc="best")

    

    add_stall_regions(
        [ax_latency, ax_iat],
        stalls,
    )

    # Summary box
    e2e_series = (
        latency["e2e_latency_ms"]
        if "e2e_latency_ms" in latency.columns
        else pd.Series(dtype=float)
    )
    player_series = (
        latency["player_latency_ms"]
        if "player_latency_ms" in latency.columns
        else pd.Series(dtype=float)
    )
    iat_series = (
        inter_arrival["inter_arrival_ms"]
        if "inter_arrival_ms" in inter_arrival.columns
        else pd.Series(dtype=float)
    )
    smoothed_iat_series = (
        inter_arrival["smoothed_inter_arrival_ms"]
        if "smoothed_inter_arrival_ms" in inter_arrival.columns
        else pd.Series(dtype=float)
    )
    

    total_stall_ms = sum(stall["duration_ms"] for stall in stalls)

    summary = (
        f"Latency samples: {len(latency)}\n"
        f"E2E min / mean / max: "
        f"{format_stat(safe_stat(e2e_series, 'min'))} / "
        f"{format_stat(safe_stat(e2e_series, 'mean'))} / "
        f"{format_stat(safe_stat(e2e_series, 'max'))} ms\n"
        f"Player mean: "
        f"{format_stat(safe_stat(player_series, 'mean'))} ms\n"
        f"IAT samples: {len(inter_arrival)}\n"
        f"IAT mean: "
        f"{format_stat(safe_stat(iat_series, 'mean'))} ms\n"
        f"Smoothed IAT mean: "
        f"{format_stat(safe_stat(smoothed_iat_series, 'mean'))} ms\n"
        f"Stalls: {len(stalls)}\n"
        f"Total stall time: {total_stall_ms:.0f} ms"
    )

    ax_latency.text(
        0.99,
        0.02,
        summary,
        transform=ax_latency.transAxes,
        ha="right",
        va="bottom",
        fontsize=8.5,
        bbox={
            "boxstyle": "round",
            "facecolor": "white",
            "alpha": 0.88,
        },
    )

    fig.tight_layout()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(
        output_path,
        dpi=dpi,
        bbox_inches="tight",
    )

    print(f"[OK] {csv_path}")
    print(f"     Graph: {output_path}")
    print(f"     Latency samples: {len(latency)}")
    print(f"     IAT samples: {len(inter_arrival)}")
    print(f"     Stalls: {len(stalls)}")

    if show:
        plt.show()
    else:
        plt.close(fig)


def output_path_for(
    csv_path: Path,
    output_dir: Path | None,
) -> Path:
    filename = f"{csv_path.stem}_analysis.png"

    if output_dir is None:
        return csv_path.with_name(filename)

    return output_dir / filename


def main() -> int:
    args = parse_arguments()

    if not 0 <= args.alpha <= 1:
        print("Error: --alpha must be between 0 and 1.", file=sys.stderr)
        return 2

    csv_files = resolve_input_files(
        args.inputs,
        recursive=args.recursive,
    )

    if not csv_files:
        print(
            "Error: no CSV files were found for the supplied input(s).",
            file=sys.stderr,
        )
        return 2

    failures = 0

    for csv_path in csv_files:
        try:
            df = load_csv(csv_path)

            output_path = output_path_for(
                csv_path,
                args.output_dir,
            )

            create_graph(
                df=df,
                csv_path=csv_path,
                output_path=output_path,
                mean_window_seconds=args.mean_window,
                alpha=args.alpha,
                dpi=args.dpi,
                show=args.show,
            )

        except Exception as exc:
            failures += 1
            print(
                f"[ERROR] {csv_path}: {exc}",
                file=sys.stderr,
            )

    if failures:
        print(
            f"Finished with {failures} failed file(s).",
            file=sys.stderr,
        )
        return 1

    print(f"Finished successfully. Analysed {len(csv_files)} file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
