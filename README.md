# WaveFlow

Browser app for evaluating WAV recordings with a node graph (React Flow). Wire
**WAV file → (frequency weighting) → analysis** nodes. Several WAV sources and chains can sit in one graph.

| Node | What it does |
|---|---|
| WAV file | ▶ Play button with volume (plays the raw file at its own rate; vibration recordings below ~20 Hz are inaudible). PCM 8/16/24/32-bit or float WAV; pick channel, quantity (acceleration, velocity, displacement, sound pressure), the physical value of digital full scale (calibration) and the dB reference (defaults per ISO 1683: 1 µm/s², 1 nm/s, 1 pm, 20 µPa). |
| Frequency weighting | Z, A, C (IEC 61672); Wb, Wc, Wd, Wk, Wm, Wh (ISO 8041 / ISO 2631 / BS 6841 / ISO 5349). |
| Fast / Slow max level | Exponential running RMS, τ = 0.125 s and 1 s: max Fast, max Slow (time of max), overall RMS/Leq, VDV for acceleration; linear and dB. |
| Moving FFT | Hann-windowed STFT spectrogram (bin RMS) and average spectrum; FFT size, overlap, max frequency, display range. |
| Loudness & sharpness | Zwicker loudness (ISO 532-1 stationary method, free/diffuse field) for the whole file and per block, N5, Nmax; DIN 45692 sharpness. Needs Pa and fs ≥ 32 kHz. |
| Loudness, time-varying | ISO 532-1:2017 time-varying method (Annex A filters, temporal decay and weighting): N(t) every 2 ms, Nmax, mean, N5/N10/N50/N95, loudness level. Resamples to 48 kHz. Needs Pa. |
| Roughness (ECMA-418-2) | Sottek hearing-model roughness (asper<sub>HMS</sub>): R(t) at 50 Hz, single value R (90th percentile) and specific roughness per Bark. Reproduces the standard's calibration (1 kHz, 60 dB, 100 % AM at 70 Hz = 1 asper: 0.99999 here) and the 0.3735 specific value of band 17. Needs ≥ 1 s of Pa. |
| Roughness | Daniel & Weber model, per ~0.2 s frame. Needs Pa. |
| Fluctuation strength | Slow loudness modulation (0.5–20 Hz) in vacil, 2 s windows. Simplified Fastl model scaled to 1 kHz / 60 dB / 100 % AM 4 Hz = 1 vacil. Needs Pa, fs ≥ 32 kHz. |
| Loudness (ECMA-418-2) | Sottek hearing-model loudness (sone<sub>HMS</sub>) from tonal + noise specific loudness (clause 8): N(t) at 187.5 Hz, single value N (power average), average specific loudness. 1 kHz, 40 dB tone = 1.0000 sone. Needs >= 0.5 s of Pa. |
| Octave / third-octave bands | IEC 61260 band Leq and frame maximum from a Hann-windowed FFT; works on any quantity. |
| Level statistics | Leq, peak, Fast max/min and L1/L5/L10/L50/L90/L95/L99 from the 125 ms Fast level. |
| Psychoacoustic annoyance | Zwicker and Fastl PA from N5 (ISO 532-1 time-varying), S5, R5 and F5 of this app's non-ECMA nodes. |
| Speech transmission index | STI from an impulse response (IEC 60268-16 indirect method, male weights, noise-free). |
| Binaural analysis | Two-channel head recording (left = selected channel, right ear chosen in the WAV node): ECMA-418-2 binaural loudness (quadratic mean of left/right specific loudness, clause 8.1.5), per-ear loudness, Leq and ILD, broadband IACC (±1 ms) and ITD. Roughness, tonality and fluctuation are not combined binaurally yet. |
| Psychoacoustic metric vs RPM | Loudness (ISO 532-1 or ECMA-418-2), roughness, tonality or fluctuation (ECMA-418-2) plotted as mean and maximum per RPM bin; speed from the WAV's tacho channel or an RPM ramp. |
| Order analysis (vs RPM) | Speed from a tacho channel of the same WAV (pulses per revolution) or a linear RPM ramp; order tracking by heterodyne, overall level and orders vs RPM, order spectrum by angular resampling (64 samples/rev, 1/16-order resolution). |
| Fluctuation strength (ECMA-418-2) | Sottek hearing-model fluctuation strength (vacil<sub>HMS</sub>) from clause 9.1: envelope analysis windows, high-resolution spectral analysis of the 0–35 Hz envelope spectrum, harmonic analysis, HSA-based loudness scaling. F(t) at 50 Hz, single value F (90th percentile), specific F′ per Bark. 1 kHz, 60 dB, 100 % AM at 4 Hz reads 1.004 vacil. Needs ≥ 2 s of Pa. |
| Tonality (ECMA-418-2) | Sottek hearing-model tonality (tu<sub>HMS</sub>), written from the published standard (clause 6.2), not from any GPL code: T(t) at 187.5 Hz, single value T, specific tonality per Bark and the prominent components (T′ > 0.4). A 1 kHz, 40 dB tone gives 0.99998 tu. Needs ≥ 0.5 s of Pa; about 1 s of compute per second of audio. |
| Tonality | Tone-to-noise ratio and prominence ratio per ECMA-74, the Nordic (Nordtest NT ACOU 112 / ISO 1996-2 Annex D) tonal audibility and tone adjustment K<sub>t</sub> (0–6 dB), a tone table, and an Aures-type tonality in tu. Needs Pa. |
| Impulsiveness | L<sub>AF,max</sub>, L<sub>AI,max</sub> and their difference, L<sub>Aeq</sub>, peak, crest factor. A-weights internally, so connect the unweighted signal. Needs Pa. |

**New / Open… / Save…** handle graph files (JSON: node settings, layout, wiring and WAV file names — not the audio; reselect the WAVs after opening a file on another machine). The current graph and its loaded WAVs are also kept in the browser (localStorage + IndexedDB) and restored on reload.

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
- - Fluctuation strength, tonality (Aures part) and the loudness ratio inside it are approximations calibrated to their reference definitions, not ports of a standard's reference code. TNR/PR use the average spectrum; thresholds follow ECMA-74.
- Time-varying loudness is a port of the ISO 532-1 method via MoSQITo; it has not been checked against the standard's Annex B reference signals (tests: 1 kHz 40 dB → 1 sone, 60 dB → ~4 sone, burst decay). Per-block loudness in the older loudness node is still the stationary method.
- ECMA-418-2 fluctuation strength: written from the standard text. Formula (159) is applied with the analysis-window length in place of s̃b (2048); with the literal s̃b the calibration signal reads 1.06 vacil, with the window length 1.004. The standard's other formulas were followed literally; no reference output was available to check beyond the calibration signal.
- Order analysis: speed is a shaft-phase estimate from rising tacho edges (pchip); the order spectrum uses cubic resampling without an anti-alias filter, so content above order 32 can fold. The metric-vs-RPM node places each frame of the chosen metric at k·Δt and bins it by the speed at that time, so tacho and metric timing are only as good as the metric's frame alignment (the ECMA frames are assumed to start at t = 0). STI is the noise-free indirect STI (no masking or background noise); annoyance mixes ISO 532-1 loudness with this app's older roughness/fluctuation/sharpness nodes.
- Checks in `src/dsp/dsp.test.ts`: 1 kHz 40 dB → 1.0 sone; 1 kHz 60 dB → ~4 sone and ~1 acum; 1 kHz 60 dB 70 Hz AM → ~0.9 asper; weighting table points; Fast/Slow burst response; VDV; FFT scaling.

Loudness/roughness tables are ported from MoSQITo (Apache-2.0); see `THIRD_PARTY_NOTICES.md`.
