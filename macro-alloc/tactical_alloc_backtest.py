# -*- coding: utf-8 -*-
"""
TQQQ/SPY 宏观战术配置回测

策略：平时满仓 TQQQ 进攻；当 4 项宏观风险信号中至少触发 2 项时，全仓切到 SPY 防守；
等风险信号连续干净 15 个交易日后再切回 TQQQ。回测窗口 2014-01-01 至今。

数据源（公开、可复现，已在回复中披露）：
  - TQQQ / SPY / ^VIX 日线：Yahoo Finance (yfinance)
  - 10Y-2Y 美债收益率价差 (T10Y2Y)：FRED (圣路易斯联储)
脚本优先读取同目录缓存 CSV；缺失则实时下载。

纯 pandas 实现，无回测框架。信号在 bar i 收盘判定，切换在 bar i+1 开盘执行（防前视）。
"""

import os
import sys
import math
import datetime as dt

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from export_results import export_results
from render_dashboard import build_dashboard_data, render_dashboard

# ---------------------------------------------------------------------------
# 参数（未明确指定的部分在此固化，并在回复中披露）
# ---------------------------------------------------------------------------
INITIAL_CASH = 100_000.0
COMMISSION = 0.0005          # 单边 0.05% 摩擦成本（ETF 佣金 + 点差近似）
EVAL_START = "2014-01-01"    # 评估窗口起点
DATA_START = "2012-05-01"    # 数据加载起点（含约 1.5 年 warmup，满足 200 日均线）
VIX_THRESHOLD = 25           # 条件2：VIX 突破阈值
VIX_MA = 20                  # 条件3：VIX 自身 N 日均值（波动率上行）
SPY_MA200 = 200              # 条件1：SPY 200 日均线
SPY_MA50 = 50                # 条件4：SPY 50 日均线（"走弱"判定）
CLEAN_DAYS = 15              # 防守后回到进攻所需的连续干净交易日
MIN_RISK = 2                 # 触发防守的最小风险信号数

PREFIX = "tactical_alloc"
OUTPUT_LANG = "zh"           # 用户用中文描述 -> 全中文输出


# ---------------------------------------------------------------------------
# 数据：优先缓存，缺失则下载
# ---------------------------------------------------------------------------
def _fetch_yfinance(symbol, cache_file, start, end):
    if os.path.exists(cache_file):
        df = pd.read_csv(cache_file)
        if len(df) > 50 and df["date"].iloc[0] <= start:
            return df
    import yfinance as yf
    df = yf.download(symbol, start=start, end=end, progress=False, auto_adjust=False)
    df.columns = df.columns.get_level_values(0)
    df = df[["Open", "High", "Low", "Close", "Adj Close", "Volume"]].copy()
    df.index.name = "date"
    df = df.reset_index()
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    df.to_csv(cache_file, index=False)
    return df


def _fetch_fred(cache_file, start):
    if os.path.exists(cache_file):
        df = pd.read_csv(cache_file)
        if "date" in df.columns and len(df) > 50:
            return df
    import requests
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=T10Y2Y"
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    r.raise_for_status()
    raw = pd.read_csv(pd.io.common.BytesIO(r.content))
    raw.columns = ["date", "spread"]
    raw = raw[raw["date"] >= start]
    raw["spread"] = pd.to_numeric(raw["spread"], errors="coerce")
    raw.to_csv(cache_file, index=False)
    return raw


def load_data():
    tqqq = _fetch_yfinance("TQQQ", os.path.join(HERE, "tqqq_price.csv"), DATA_START, "2026-07-16")
    spy = _fetch_yfinance("SPY", os.path.join(HERE, "spy_price.csv"), DATA_START, "2026-07-16")
    vix = _fetch_yfinance("^VIX", os.path.join(HERE, "vix_price.csv"), DATA_START, "2026-07-16")
    yc = _fetch_fred(os.path.join(HERE, "t10y2y_fred.csv"), DATA_START)

    tqqq = tqqq.rename(columns=lambda c: f"tqqq_{c.lower().replace(' ', '_')}" if c != "date" else "date")
    spy = spy.rename(columns=lambda c: f"spy_{c.lower().replace(' ', '_')}" if c != "date" else "date")
    vix = vix.rename(columns=lambda c: f"vix_{c.lower().replace(' ', '_')}" if c != "date" else "date")
    yc = yc.rename(columns={"spread": "spread"})

    df = pd.merge(tqqq, spy, on="date", how="inner")
    df = pd.merge(df, vix[["date", "vix_close"]], on="date", how="inner")
    df = pd.merge(df, yc[["date", "spread"]], on="date", how="left")
    # 复权价：以 Adj Close / Close 比例把开盘价也调整到复权尺度，保证开/收一致
    for tag in ("tqqq", "spy"):
        close = df[f"{tag}_close"]
        adj = df[f"{tag}_adj_close"]
        ratio = (adj / close).replace([float("inf"), -float("inf")], float("nan"))
        df[f"{tag}_adj_open"] = df[f"{tag}_open"] * ratio
    df["spread"] = df["spread"].ffill()  # FRED 个别非交易日缺口前向填充
    df = df.sort_values("date").reset_index(drop=True)
    return df


def _is_nan(x):
    return x is None or (isinstance(x, float) and math.isnan(x))


def main():
    df = load_data()

    # 指标（warmup 段一并计算，避免前视）
    df["spy_ma200"] = df["spy_adj_close"].rolling(SPY_MA200).mean()
    df["spy_ma50"] = df["spy_adj_close"].rolling(SPY_MA50).mean()
    df["vix_ma20"] = df["vix_close"].rolling(VIX_MA).mean()

    dates = df["date"].tolist()
    tqqq_open = df["tqqq_adj_open"].tolist()
    tqqq_close = df["tqqq_adj_close"].tolist()
    spy_open = df["spy_adj_open"].tolist()
    spy_close = df["spy_adj_close"].tolist()
    vix = df["vix_close"].tolist()
    spread = df["spread"].tolist()
    spy_ma200 = df["spy_ma200"].tolist()
    spy_ma50 = df["spy_ma50"].tolist()
    vix_ma20 = df["vix_ma20"].tolist()

    eval_start_idx = next(i for i, d in enumerate(dates) if d >= EVAL_START)
    last_idx = len(dates) - 1

    # 状态
    holding = None          # 'TQQQ' / 'SPY'
    shares = 0
    pending_target = None   # bar i 收盘判定、bar i+1 开盘执行的切换目标
    clean_streak = 0
    entry_date = None
    entry_price = None
    entry_bar = None

    equity_curve = []
    trade_history = []
    risk_points = []        # 宏观风险信号计数（用于图表）
    regime_points = []      # 当日持仓（用于着色）

    for i in range(len(dates)):
        date = dates[i]
        in_eval = i >= eval_start_idx

        # 初始化：评估窗口第一天以开盘价满仓 TQQQ
        if in_eval and holding is None:
            holding = "TQQQ"
            o = tqqq_open[i]
            shares = int(INITIAL_CASH / (o * (1 + COMMISSION)))
            entry_date = date
            entry_price = o
            entry_bar = i
            pending_target = None

        # 执行上一根 bar 判定的切换（bar i 开盘价成交）
        if in_eval and pending_target is not None and holding is not None and pending_target != holding:
            cur_open = tqqq_open[i] if holding == "TQQQ" else spy_open[i]
            proceeds = shares * cur_open * (1 - COMMISSION)
            tgt_open = tqqq_open[i] if pending_target == "TQQQ" else spy_open[i]
            new_shares = int(proceeds / (tgt_open * (1 + COMMISSION)))
            if new_shares > 0:
                cost = shares * entry_price * (1 + COMMISSION)
                exit_val = shares * cur_open * (1 - COMMISSION)
                pnl = exit_val - cost
                pnl_pct = (pnl / cost * 100.0) if cost else 0.0
                trade_history.append({
                    "entry_date": entry_date,
                    "exit_date": date,
                    "side": "long",
                    "size": shares,
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(cur_open, 4),
                    "pnl": round(pnl, 2),
                    "pnl_pct": round(pnl_pct, 4),
                    "holding_bars": i - entry_bar,
                    "symbol": holding,
                    "symbol_name": "TQQQ（纳指3倍ETF）" if holding == "TQQQ" else "SPY（标普500ETF）",
                })
                holding = pending_target
                shares = new_shares
                entry_date = date
                entry_price = tgt_open
                entry_bar = i
            else:
                pending_target = holding  # 极端情况下无法建仓，保持原样

        # 依据 bar i 收盘数据判定风险信号（纯历史状态，warmup 外才产生交易副作用）
        if in_eval and holding is not None:
            c1 = (not _is_nan(spy_close[i])) and (not _is_nan(spy_ma200[i])) and spy_close[i] < spy_ma200[i]
            c2 = (not _is_nan(vix[i])) and vix[i] > VIX_THRESHOLD
            c3 = (not _is_nan(vix[i])) and (not _is_nan(vix_ma20[i])) and vix[i] > vix_ma20[i]
            c4 = (not _is_nan(spread[i])) and spread[i] < 0 and \
                 (not _is_nan(spy_close[i])) and (not _is_nan(spy_ma50[i])) and spy_close[i] < spy_ma50[i]
            risk = int(c1) + int(c2) + int(c3) + int(c4)
            risk_points.append({"date": date, "value": risk})

            if holding == "TQQQ":
                pending_target = "SPY" if risk >= MIN_RISK else "TQQQ"
                clean_streak = 0
            else:  # 防守中
                clean_streak = clean_streak + 1 if risk == 0 else 0
                pending_target = "TQQQ" if clean_streak >= CLEAN_DAYS else "SPY"

        # 记录权益（bar i 收盘）
        if in_eval and holding is not None:
            cur_close = tqqq_close[i] if holding == "TQQQ" else spy_close[i]
            equity_curve.append({"date": date, "value": round(shares * cur_close, 2)})
            regime_points.append({"date": date, "regime": holding})

    # 期末强制平仓（记录最后一笔交易，组合归零）
    if holding is not None and shares > 0:
        cur_close = tqqq_close[last_idx] if holding == "TQQQ" else spy_close[last_idx]
        cost = shares * entry_price * (1 + COMMISSION)
        exit_val = shares * cur_close * (1 - COMMISSION)
        pnl = exit_val - cost
        pnl_pct = (pnl / cost * 100.0) if cost else 0.0
        trade_history.append({
            "entry_date": entry_date,
            "exit_date": dates[last_idx],
            "side": "long",
            "size": shares,
            "entry_price": round(entry_price, 4),
            "exit_price": round(cur_close, 4),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 4),
            "holding_bars": last_idx - entry_bar,
            "symbol": holding,
            "symbol_name": "TQQQ（纳指3倍ETF）" if holding == "TQQQ" else "SPY（标普500ETF）",
        })
        holding = None
        shares = 0

    # 买入持有对照（评估窗口内）
    bh_tqqq, bh_spy = [], []
    base_tqqq = tqqq_close[eval_start_idx]
    base_spy = spy_close[eval_start_idx]
    for i in range(eval_start_idx, len(dates)):
        f0 = INITIAL_CASH * (1 - COMMISSION)
        bh_tqqq.append({"date": dates[i], "value": round(f0 * tqqq_close[i] / base_tqqq, 2)})
        bh_spy.append({"date": dates[i], "value": round(f0 * spy_close[i] / base_spy, 2)})

    # 导出三件套
    export_results(
        equity_curve=equity_curve,
        trade_history=trade_history,
        prefix=PREFIX,
        initial_cash=INITIAL_CASH,
        start=EVAL_START,
        end=dates[last_idx],
        market="us_stock",
        strategy_name="TQQQ/SPY 宏观战术配置",
        symbol="TQQQ,SPY",
        is_flat_at_end=True,
    )

    # 渲染仪表盘
    report_data = build_dashboard_data(
        equity_csv=f"{PREFIX}_equity.csv",
        trades_csv=f"{PREFIX}_trades.csv",
        summary_json=f"{PREFIX}_summary.json",
        language=OUTPUT_LANG,
        market="us_stock",
        extra_modules=[
            {"type": "text", "tab": "overview", "title": "策略结论速览",
             "text": "- 平时满仓 TQQQ（纳指3倍ETF）进攻；4 项宏观风险信号中≥2 项触发则全仓切 SPY 防守。\n"
                     "- 防守期间风险信号连续干净 15 个交易日，再切回 TQQQ。\n"
                     "- 信号在当日收盘判定、次交易日开盘成交（防前视）。回测窗口 2014-01-01 至今。"},
            {"type": "text", "tab": "overview", "title": "关键假设与口径",
             "text": "- 初始资金 10 万美元；单边 0.05% 摩擦成本（ETF 佣金+点差近似）。\n"
                     "- 复权价：以 Adj Close/Close 比例将开盘价同步复权，开/收一致。\n"
                     "- 四类风险信号定义：① SPY 收盘价 < SPY 200 日均线；② VIX > 25；"
                     "③ VIX > 其 20 日均线（波动率上行）；④ 10Y-2Y 收益率价差 < 0（曲线倒挂）且 SPY < 50 日均线（走弱）。\n"
                     "- 数据：TQQQ/SPY/^VIX 来自 Yahoo Finance；10Y-2Y 价差来自 FRED（T10Y2Y）。"},
            {"type": "text", "tab": "overview", "title": "局限与已知偏差",
             "text": "- 日线层面无法重建盘中顺序；切换按次日均价成交，剧烈波动期与信号价可能有偏差。\n"
                     "- 未建模滑点之外的市场冲击；TQQQ 为每日再平衡杠杆 ETF，长期持有存在波动率损耗。\n"
                     "- 样本内回测（2014 起为美股长牛+低利率环境），样本外与加息/衰退切换期表现未验证。\n"
                     "- 策略参数（阈值、干净天数、均线周期）未做样本外优化，存在过拟合风险。"},
        ],
    )
    # 注入买入持有对照与风险计数曲线
    for m in report_data["modules"]:
        if m.get("type") == "overview_chart":
            m["overlay_series"] = [
                {"name": "买入持有 TQQQ", "stroke": "#2e7d32", "points": bh_tqqq},
                {"name": "买入持有 SPY", "stroke": "#1565c0", "points": bh_spy},
            ]
    report_data["modules"].append({
        "type": "line_chart", "tab": "overview",
        "title": "宏观风险信号计数（0–4）", "subtitle": "≥2 触发防守切换",
        "series": [{"name": "风险信号数", "points": risk_points}],
    })
    render_dashboard(report_data, output_path=os.path.join(HERE, "index.html"))

    # 生成独立 PNG 图表（NAV + 宏观风险计数）
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib import font_manager
        import matplotlib.dates as mdates
        _cjk = "C:/Windows/Fonts/simhei.ttf"
        if os.path.exists(_cjk):
            font_manager.fontManager.addfont(_cjk)
            plt.rcParams["font.sans-serif"] = ["SimHei"]
            plt.rcParams["axes.unicode_minus"] = False

        eq_df = pd.DataFrame(equity_curve)
        eq_df["date"] = pd.to_datetime(eq_df["date"])
        bh_tqqq_df = pd.DataFrame(bh_tqqq); bh_tqqq_df["date"] = pd.to_datetime(bh_tqqq_df["date"])
        bh_spy_df = pd.DataFrame(bh_spy); bh_spy_df["date"] = pd.to_datetime(bh_spy_df["date"])
        reg_df = pd.DataFrame(regime_points); reg_df["date"] = pd.to_datetime(reg_df["date"])
        rsk_df = pd.DataFrame(risk_points); rsk_df["date"] = pd.to_datetime(rsk_df["date"])

        # 图1：净值曲线 + 买入持有对照 + 持仓区间着色
        fig, ax = plt.subplots(figsize=(11, 5))
        ax.plot(eq_df["date"], eq_df["value"], color="#6a1b9a", lw=1.6, label="策略净值")
        ax.plot(bh_tqqq_df["date"], bh_tqqq_df["value"], color="#2e7d32", lw=1.0, ls="--", label="买入持有 TQQQ")
        ax.plot(bh_spy_df["date"], bh_spy_df["value"], color="#1565c0", lw=1.0, ls="--", label="买入持有 SPY")
        # 持仓区间底色
        cur = reg_df.iloc[0]["regime"]; seg_start = reg_df.iloc[0]["date"]
        for j in range(1, len(reg_df) + 1):
            if j == len(reg_df) or reg_df.iloc[j]["regime"] != cur:
                seg_end = reg_df.iloc[j - 1]["date"]
                ax.axvspan(seg_start, seg_end, color=("#e8f5e9" if cur == "TQQQ" else "#eceff1"), alpha=0.6, lw=0)
                if j < len(reg_df):
                    cur = reg_df.iloc[j]["regime"]; seg_start = reg_df.iloc[j]["date"]
        ax.set_yscale("log")
        ax.set_title("策略净值 vs 买入持有（对数轴，绿区=TQQQ 进攻 / 灰区=SPY 防守）", fontsize=12)
        ax.set_ylabel("净值（美元，对数）")
        ax.legend(loc="upper left", fontsize=9)
        ax.grid(True, alpha=0.3)
        fig.tight_layout()
        fig.savefig(os.path.join(HERE, f"{PREFIX}_nav.png"), dpi=110)
        plt.close(fig)

        # 图2：宏观风险信号计数
        fig, ax = plt.subplots(figsize=(11, 3.2))
        ax.step(rsk_df["date"], rsk_df["value"], where="post", color="#c62828", lw=1.3)
        ax.axhline(2, color="#555", ls="--", lw=1.0, label="防守触发阈值 = 2")
        ax.set_title("每日宏观风险信号计数（0–4，≥2 触发切 SPY）", fontsize=12)
        ax.set_ylabel("信号数")
        ax.set_ylim(-0.3, 4.3)
        ax.legend(loc="upper right", fontsize=9)
        ax.grid(True, alpha=0.3)
        fig.tight_layout()
        fig.savefig(os.path.join(HERE, f"{PREFIX}_risk.png"), dpi=110)
        plt.close(fig)
        print("PNG 图表已生成")
    except Exception as e:  # 图表仅为加分项，失败不影响主流程
        print(f"PNG 图表生成跳过: {e}")

    # 诊断信息
    n_tqqq = sum(1 for r in regime_points if r["regime"] == "TQQQ")
    n_spy = len(regime_points) - n_tqqq
    switches = len(trade_history)
    print("=== 诊断 ===")
    print(f"评估窗口: {EVAL_START} ~ {dates[last_idx]}  共 {len(equity_curve)} 个交易日")
    print(f"TQQQ 持仓天数: {n_tqqq} ({n_tqqq/len(regime_points)*100:.1f}%)  SPY 持仓天数: {n_spy} ({n_spy/len(regime_points)*100:.1f}%)")
    print(f"切换/仓位段数（交易笔数）: {switches}")
    print(f"期末权益见 {PREFIX}_summary.json")


if __name__ == "__main__":
    main()
