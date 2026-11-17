# WaveFlow

Browser app for evaluating WAV recordings with a node graph (React Flow). Wire
**WAV file → (frequency weighting) → analysis** nodes. Several WAV sources and chains can sit in one graph.

| Node | What it does |
|---|---|
| WAV file | PCM 8/16/24/32-bit or float WAV; pick channel, quantity (acceleration, velocity, displacement, sound pressure), the physical value of digital full scale (calibration) and the dB reference (defaults per ISO 1683: 1 µm/s², 1 nm/s, 1 pm, 20 µPa). |
| Frequency weighting | Z, A, C (IEC 61672); Wb, Wc, Wd, Wk, Wm, Wh (ISO 8041 / ISO 2631 / BS 6841 / ISO 5349). |
| Fast / Slow max level | Exponential running RMS, τ = 0.125 s and 1 s: max Fast, max Slow (time of max), overall RMS/Leq, VDV for acceleration; linear and dB. |
| Moving FFT | Hann-windowed STFT spectrogram (bin RMS) and average spectrum; FFT size, overlap, max frequency, display range. |
| Loudness & sharpness | Zwicker loudness (ISO 532-1 stationary method, free/diffuse field) for the whole file and per block, N5, Nmax; DIN 45692 sharpness. Needs Pa and fs ≥ 32 kHz. |
| Roughness | Daniel & Weber model, per ~0.2 s frame. Needs Pa. |

**New / Open… / Save…** handle graph files (JSON: node settings, layout, wiring and WAV file names — not the audio; reselect the WAVs after opening). The current graph is also autosaved in the browser and restored on reload.

Computation runs in a Web Worker; results are cached per upstream chain, so only changed nodes recompute.

## Run

```
npm install
npm run dev      # http://localhost:5193
npm test         # DSP unit tests
npm run build    # static build in dist/
```

## Accuracy notes

- A/C weighting is a bilinear IIR with pre-warped poles: within 0.3 dB of IEC 61672 to 4 kHz and 0.7 dB to 12.5 kHz at 48 kHz.
- Loudness uses our own 6th-order Butterworth third-octave bank, not the ISO 532-1 reference filters. The per-block values apply the stationary method to each block; they are **not** the ISO 532-1 time-varying method. The first block includes filter start-up.
- Roughness frames are the power of two nearest 0.2 s (171 ms at 48 kHz).
- Checks in `src/dsp/dsp.test.ts`: 1 kHz 40 dB → 1.0 sone; 1 kHz 60 dB → ~4 sone and ~1 acum; 1 kHz 60 dB 70 Hz AM → ~0.9 asper; weighting table points; Fast/Slow burst response; VDV; FFT scaling.

Loudness/roughness tables are ported from MoSQITo (Apache-2.0); see `THIRD_PARTY_NOTICES.md`.
