# -*- coding: utf-8 -*-
"""
cloud_premarket.py — GitHub Actions 云端盘前外围温度计兜底 (与本地 premarket_fetch.py v1.1.0 同口径)
若当日 premarket_data.js 已由本地电脑推送且含今日北京时间日期，默认跳过(不与本地 08:45 任务冲突)；
本地关机/停跑时自动接管更新 premarket_data.js，传入 --force 可强制刷新。
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import requests

TZ_CN = dt.timezone(dt.timedelta(hours=8))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "premarket_data.js")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def r2(v):
    return round(float(v), 2)


def clamp(v, lo=-1.5, hi=1.5):
    return max(lo, min(hi, v))


def fetch_tencent():
    codes = [
        ("usDJI", "dji", "道琼斯"),
        ("usIXIC", "ixic", "纳斯达克"),
        ("usINX", "inx", "标普500"),
        ("hkHSI", "hsi", "恒生指数"),
        ("hkHSTECH", "hstech", "恒生科技"),
    ]
    url = "https://qt.gtimg.cn/q=" + ",".join(c for c, _, _ in codes)
    txt = requests.get(url, headers=UA, timeout=12).content.decode("gbk", errors="ignore")
    out = {}
    for code, key, cname in codes:
        m = re.search(rf'v_{code}="([^"]+)"', txt)
        if not m:
            continue
        f = m.group(1).split("~")
        try:
            px, prev = float(f[3]), float(f[4])
            if px <= 0 or prev <= 0:
                continue
            out[key] = {
                "name": (f[1] or cname).strip(),
                "price": r2(px),
                "prevClose": r2(prev),
                "pct": r2((px / prev - 1.0) * 100.0),
                "high": r2(f[33]) if len(f) > 33 and f[33] else r2(px),
                "low": r2(f[34]) if len(f) > 34 and f[34] else r2(px),
                "time": (f[30] if len(f) > 30 else "").strip(),
            }
        except Exception:
            continue
    return out


def fetch_sina():
    url = "https://hq.sinajs.cn/list=hf_CHA50CFD,fx_susdcnh,hf_ES,hf_YM,hf_NQ,b_KOSPI,b_NKY"
    h = dict(UA)
    h["Referer"] = "https://finance.sina.com.cn/"
    txt = requests.get(url, headers=h, timeout=12).content.decode("gbk", errors="ignore")
    kv = {}
    for line in txt.splitlines():
        if "hq_str_" not in line or '="' not in line:
            continue
        k = line.split("hq_str_", 1)[1].split('="', 1)[0].strip()
        v = line.split('="', 1)[1].rsplit('"', 1)[0]
        if v:
            kv[k] = v.split(",")
    out = {}
    for k, nm in (
        ("hf_CHA50CFD", "富时中国A50期货"),
        ("hf_ES", "标普500指数期货"),
        ("hf_YM", "道琼斯指数期货"),
        ("hf_NQ", "纳斯达克100期货"),
    ):
        p = kv.get(k) or []
        try:
            px, prev = float(p[0]), float(p[7])
            if px > 0 and prev > 0:
                out[k] = {
                    "price": r2(px),
                    "prevSettle": r2(prev),
                    "pct": r2((px / prev - 1.0) * 100.0),
                    "high": r2(p[4]) if p[4] else r2(px),
                    "low": r2(p[5]) if p[5] else r2(px),
                    "time": p[6] if len(p) > 6 else "",
                    "date": p[12] if len(p) > 12 else "",
                    "name": nm,
                    "key": k,
                }
        except Exception:
            pass
    p_fx = kv.get("fx_susdcnh") or []
    try:
        px, prev = float(p_fx[1]), float(p_fx[3])
        if px > 0 and prev > 0:
            out["fx"] = {
                "price": round(px, 4),
                "prevClose": round(prev, 4),
                "pct": r2((px / prev - 1.0) * 100.0),
                "high": round(float(p_fx[6]), 4),
                "low": round(float(p_fx[7]), 4),
                "name": "离岸人民币",
            }
    except Exception:
        pass
    for k, out_k, nm in (("b_KOSPI", "kospi", "韩国KOSPI"), ("b_NKY", "nikkei", "日经225")):
        p = kv.get(k) or []
        try:
            px, pct = float(p[1]), float(p[3])
            if px > 0:
                out[out_k] = {
                    "name": nm,
                    "price": r2(px),
                    "chg": r2(p[2]),
                    "pct": r2(pct),
                    "time": f"{p[6]} {p[5]}".strip(),
                    "source": "sina-cloud",
                }
        except Exception:
            pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    now_cn = dt.datetime.now(TZ_CN)
    today_str = now_cn.strftime("%Y-%m-%d")
    if (not args.force) and os.path.exists(OUT_PATH):
        cur = open(OUT_PATH, encoding="utf-8").read(400)
        if f'"date":"{today_str}"' in cur and "cloud-fallback" not in cur:
            print(f"[cloud_premarket] {today_str} 已有本地最新快照，跳过")
            return 0

    tq = fetch_tencent()
    sq = fetch_sina()
    specs = [
        ("ixic", tq.get("ixic"), 23.0, 2.0, False),
        ("inx", tq.get("inx"), 13.0, 1.5, False),
        ("dji", tq.get("dji"), 9.0, 1.5, False),
        ("a50", sq.get("hf_CHA50CFD"), 25.0, 1.2, False),
        ("kospi", sq.get("kospi"), 10.0, 1.5, False),
        ("usdcnh", sq.get("fx"), 10.0, 0.3, True),
        ("nikkei", sq.get("nikkei"), 5.0, 1.5, False),
        ("hsi", tq.get("hsi"), 3.0, 1.5, False),
        ("hstech", tq.get("hstech"), 2.0, 2.0, False),
    ]
    g_items = []
    score_sum, w_used = 0.0, 0.0
    for key, obj, w, denom, inv in specs:
        if not obj:
            continue
        pct = float(obj["pct"])
        signed = -pct if inv else pct
        contrib = round(w * clamp(signed / denom), 2)
        score_sum += contrib
        w_used += w
        g_items.append({
            "key": key,
            "name": obj.get("name", key),
            "weight": int(w),
            "pct": pct,
            "contrib": contrib,
            "inverse": inv,
        })
    final_score = round(score_sum * (100.0 / w_used), 2) if w_used > 0 else 0.0
    if final_score >= 25:
        g_label, g_hint = "外围偏暖", "外围共振走强 · 慎防A股早盘高开低走，严禁09:30追高"
    elif final_score <= -25:
        g_label, g_hint = "外围偏空", "外围偏弱承压 · 警惕早盘低开踩踏，勿急于早盘割肉"
    else:
        g_label, g_hint = "外围中性", "外围影响有限, 以A股自身节奏为主"

    payload = {
        "version": "1.1.0-cloud-fallback",
        "date": today_str,
        "fetchTime": now_cn.strftime("%H:%M:%S"),
        "us": [tq[k] for k in ("dji", "ixic", "inx") if k in tq],
        "hk": [tq[k] for k in ("hsi", "hstech") if k in tq],
        "a50": sq.get("hf_CHA50CFD"),
        "fx": sq.get("fx"),
        "nikkei": sq.get("nikkei"),
        "kospi": sq.get("kospi"),
        "usfut": [sq[k] for k in ("hf_ES", "hf_YM", "hf_NQ") if k in sq],
        "gauge": {
            "score": final_score,
            "label": g_label,
            "hint": g_hint,
            "items": g_items,
            "wsum": round(w_used, 1),
        },
    }
    banner = f"/* premarket_data.js — 自动生成 (cloud_premarket.py, {today_str} {now_cn.strftime('%H:%M')}) */\n"
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(banner + "window.PREMARKET_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print(f"[cloud_premarket] updated {today_str} score={final_score} ({g_label})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
