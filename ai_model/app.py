"""
═══════════════════════════════════════════════════════════════
 APEX-MD v7 PRO VVIP  ·  ai_model/app.py
 ─────────────────────────────────────────────────────────────
 Lightweight FastAPI server — local AI prediction backend.
 Receives OHLCV candle data from the Node.js bot and returns
 a price direction prediction with confidence score.

 Architecture:
   • Full LSTM model (TensorFlow/Keras) when trained model exists
   • Intelligent rule-based fallback when model is not yet trained
   • Both modes return identical JSON shape

 Run:
   pip install fastapi uvicorn tensorflow scikit-learn pandas numpy joblib
   uvicorn app:app --host 0.0.0.0 --port 5000 --reload

 Train:
   POST /train  with CSV path to trigger background training
═══════════════════════════════════════════════════════════════
"""

import os
import math
import asyncio
import logging
import numpy as np
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("apex.ai")

# ── Model State ───────────────────────────────────────────────
MODEL_PATH  = os.path.join(os.path.dirname(__file__), "apex_lstm.keras")
SCALER_PATH = os.path.join(os.path.dirname(__file__), "apex_scaler.pkl")
SEQ_LEN     = 60

ML = {"model": None, "scaler": None, "ready": False}

# ── Try to load TensorFlow (optional) ────────────────────────
TF_AVAILABLE = False
try:
    os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
    import tensorflow as tf
    from tensorflow.keras.models import load_model as tf_load_model
    from tensorflow.keras.models import Sequential
    from tensorflow.keras.layers import LSTM, Dense, Dropout, BatchNormalization
    from tensorflow.keras.optimizers import Adam
    from sklearn.preprocessing import MinMaxScaler
    from sklearn.model_selection import train_test_split
    import pandas as pd
    import joblib
    TF_AVAILABLE = True
    log.info("TensorFlow available — LSTM mode enabled")
except ImportError:
    log.warning("TensorFlow not installed — running in rule-based fallback mode")
    log.warning("Install: pip install tensorflow scikit-learn pandas joblib")

# ── Feature Engineering ───────────────────────────────────────
FEATURES = ["open", "high", "low", "close", "volume",
            "rsi", "macd", "ema9", "ema21", "atr", "vol_ratio"]

def _add_features(df):
    """Derive indicators from raw OHLCV DataFrame."""
    c, h, l, v = df["close"], df["high"], df["low"], df["volume"]

    # RSI-14
    delta = c.diff()
    gain  = delta.clip(lower=0).rolling(14).mean()
    loss  = (-delta.clip(upper=0)).rolling(14).mean()
    rs    = gain / loss.replace(0, float("nan"))
    df["rsi"] = 100 - 100 / (1 + rs)

    # MACD line
    df["macd"] = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()

    # EMAs
    df["ema9"]  = c.ewm(span=9,  adjust=False).mean()
    df["ema21"] = c.ewm(span=21, adjust=False).mean()

    # ATR-14
    tr = np.maximum.reduce([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()])
    df["atr"] = tr.rolling(14).mean()

    # Volume ratio
    df["vol_ratio"] = v / v.rolling(20).mean()

    return df

def _build_sequences(df):
    """Build (X, y) sequences for LSTM training."""
    df = _add_features(df.copy()).dropna()
    labels = (df["close"].shift(-1) > df["close"]).astype(int)
    df["label"] = labels

    scaler = MinMaxScaler()
    scaled = scaler.fit_transform(df[FEATURES].values)

    X, y = [], []
    for i in range(SEQ_LEN, len(scaled) - 1):
        X.append(scaled[i - SEQ_LEN : i])
        y.append(df["label"].iloc[i])

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32), scaler

def _build_model(n_features):
    model = Sequential([
        LSTM(128, return_sequences=True, input_shape=(SEQ_LEN, n_features)),
        BatchNormalization(),
        Dropout(0.3),
        LSTM(64, return_sequences=False),
        BatchNormalization(),
        Dropout(0.3),
        Dense(32, activation="relu"),
        Dropout(0.2),
        Dense(1, activation="sigmoid"),
    ])
    model.compile(optimizer=Adam(0.001), loss="binary_crossentropy",
                  metrics=["accuracy"])
    return model

# ── Model Loader ──────────────────────────────────────────────
def _load_model():
    if not TF_AVAILABLE:
        return
    if not os.path.exists(MODEL_PATH) or not os.path.exists(SCALER_PATH):
        log.warning("Model files not found — using rule-based fallback. Train via POST /train")
        return
    try:
        ML["model"]  = tf_load_model(MODEL_PATH)
        ML["scaler"] = joblib.load(SCALER_PATH)
        ML["ready"]  = True
        log.info("LSTM model loaded successfully")
    except Exception as e:
        log.error(f"Failed to load model: {e}")

# ── Rule-Based Fallback Predictor ────────────────────────────
def _rule_based_predict(candles: list) -> dict:
    """
    Intelligent technical analysis fallback used when LSTM is not trained.
    Uses RSI, MACD momentum, EMA alignment, and volume for prediction.
    Confidence reflects signal confluence (50%–82% range).
    """
    if len(candles) < 30:
        return {"prediction": "Neutral", "confidence": 50, "source": "insufficient_data"}

    closes  = [float(c["close"]) for c in candles]
    volumes = [float(c["volume"]) for c in candles]

    # ── EMA 9 / 21 trend ────────────────────────────────────
    def ema(data, period):
        k, result = 2 / (period + 1), [data[0]]
        for p in data[1:]:
            result.append(p * k + result[-1] * (1 - k))
        return result[-1]

    ema9  = ema(closes[-30:], 9)
    ema21 = ema(closes[-30:], 21)
    price = closes[-1]
    ema_bull = price > ema9 > ema21
    ema_bear = price < ema9 < ema21

    # ── RSI ─────────────────────────────────────────────────
    diffs = [closes[i] - closes[i-1] for i in range(1, len(closes[-20:]))]
    gains = sum(d for d in diffs if d > 0) / 14
    losses = sum(-d for d in diffs if d < 0) / 14
    rsi = 100 - (100 / (1 + gains / losses)) if losses > 0 else 50
    rsi_bull = rsi < 45
    rsi_bear = rsi > 55

    # ── MACD ────────────────────────────────────────────────
    ema12_v = ema(closes[-40:], 12)
    ema26_v = ema(closes[-40:], 26)
    macd = ema12_v - ema26_v
    macd_bull = macd > 0
    macd_bear = macd < 0

    # ── Volume confirmation ──────────────────────────────────
    avg_vol = sum(volumes[-11:-1]) / 10 if len(volumes) >= 11 else sum(volumes) / len(volumes)
    vol_spike = volumes[-1] > avg_vol * 1.5

    # ── Score confluence ─────────────────────────────────────
    bull_score = sum([ema_bull, rsi_bull, macd_bull, vol_spike and ema_bull])
    bear_score = sum([ema_bear, rsi_bear, macd_bear, vol_spike and ema_bear])

    if bull_score > bear_score:
        base_conf = 50 + (bull_score / 4) * 32   # 50–82%
        return {
            "prediction": "Bullish",
            "confidence": round(base_conf, 1),
            "source": "rule_based_fallback",
        }
    elif bear_score > bull_score:
        base_conf = 50 + (bear_score / 4) * 32
        return {
            "prediction": "Bearish",
            "confidence": round(base_conf, 1),
            "source": "rule_based_fallback",
        }
    else:
        return {"prediction": "Neutral", "confidence": 50, "source": "rule_based_fallback"}

# ── LSTM Predictor ────────────────────────────────────────────
def _lstm_predict(candles: list) -> dict:
    if not TF_AVAILABLE or not ML["ready"]:
        return _rule_based_predict(candles)

    try:
        df = pd.DataFrame(candles)[["open","high","low","close","volume"]].astype(float)
        df = _add_features(df).dropna()

        if len(df) < SEQ_LEN:
            raise ValueError(f"Need ≥{SEQ_LEN} candles after warmup, got {len(df)}")

        feat = df[FEATURES].values[-SEQ_LEN:]
        scaled = ML["scaler"].transform(feat)
        X = scaled[np.newaxis, :, :]

        prob = float(ML["model"].predict(X, verbose=0)[0][0])
        direction  = "Bullish" if prob >= 0.5 else "Bearish"
        confidence = prob if prob >= 0.5 else 1.0 - prob

        return {
            "prediction": direction,
            "confidence": round(confidence * 100, 1),
            "source": "lstm",
        }
    except Exception as e:
        log.warning(f"LSTM predict failed: {e} — falling back to rule-based")
        return _rule_based_predict(candles)

# ── Lifespan ──────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_model()
    yield

# ── FastAPI App ───────────────────────────────────────────────
app = FastAPI(
    title="APEX-MD AI Prediction API",
    version="7.0.0",
    description="Local LSTM price direction predictor for Apex-MD trading bot.",
    lifespan=lifespan,
)

app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

# ── Schemas ───────────────────────────────────────────────────
class Candle(BaseModel):
    timestamp: Optional[str] = None
    open:   float = Field(..., gt=0)
    high:   float = Field(..., gt=0)
    low:    float = Field(..., gt=0)
    close:  float = Field(..., gt=0)
    volume: float = Field(..., ge=0)

class PredictRequest(BaseModel):
    symbol:  str
    candles: List[Candle] = Field(..., min_items=30)

class PredictResponse(BaseModel):
    symbol:     str
    prediction: str      # "Bullish" | "Bearish" | "Neutral"
    confidence: float    # 50–100 %
    source:     str      # "lstm" | "rule_based_fallback"
    model_ready: bool

class TrainRequest(BaseModel):
    csv_path: str = Field(default="ohlcv.csv")

# ── Routes ────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status":      "ok",
        "model_ready": ML["ready"],
        "tf_available": TF_AVAILABLE,
        "mode":        "lstm" if ML["ready"] else "rule_based_fallback",
    }

@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest):
    candle_dicts = [c.dict() for c in req.candles]
    result = _lstm_predict(candle_dicts)

    log.info(
        f"[{req.symbol}] {result['prediction']} "
        f"conf={result['confidence']}% source={result['source']}"
    )

    return PredictResponse(
        symbol      = req.symbol,
        prediction  = result["prediction"],
        confidence  = result["confidence"],
        source      = result["source"],
        model_ready = ML["ready"],
    )

@app.post("/train")
async def train(req: TrainRequest, background_tasks: BackgroundTasks):
    """Trigger LSTM training in the background."""
    if not TF_AVAILABLE:
        raise HTTPException(status_code=503,
                            detail="TensorFlow not installed. pip install tensorflow scikit-learn pandas joblib")

    def _do_train():
        log.info(f"Background training started from {req.csv_path}")
        ML["ready"] = False
        try:
            df = pd.read_csv(req.csv_path)
            df = df[["open","high","low","close","volume"]].astype(float)
            X, y, scaler = _build_sequences(df)
            log.info(f"Dataset: {X.shape} sequences")

            X_tr, X_val, y_tr, y_val = train_test_split(X, y, test_size=0.15, shuffle=False)
            model = _build_model(X.shape[2])

            from tensorflow.keras.callbacks import EarlyStopping, ModelCheckpoint
            model.fit(
                X_tr, y_tr,
                validation_data=(X_val, y_val),
                epochs=100, batch_size=64,
                callbacks=[
                    EarlyStopping(monitor="val_loss", patience=10, restore_best_weights=True),
                    ModelCheckpoint(MODEL_PATH, save_best_only=True),
                ],
                verbose=1,
            )
            joblib.dump(scaler, SCALER_PATH)
            _load_model()
            log.info("Training complete — model reloaded")
        except Exception as e:
            log.error(f"Training failed: {e}")

    background_tasks.add_task(_do_train)
    return {"status": "training_started", "csv_path": req.csv_path}
