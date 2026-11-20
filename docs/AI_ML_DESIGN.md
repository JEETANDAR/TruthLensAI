# TruthLens AI — AI & Machine Learning Design

## 1. Epistemic Separation
TruthLens AI enforces strict boundaries between:
1. **Observed Forensic Signals**: Deterministic measurements (`SHA-256`, JPEG quantization / ELA mean & P95 residual, Laplacian noise variance, FFprobe FPS/codec, PCM RMS & spectral flatness).
2. **Trained ML Model Outputs**: Predictions produced by calibrated scikit-learn-equivalent classifiers implemented in `server/ml/` and evaluated on a held-out test set.
3. **AI Interpretations (`@google/genai`)**: Grounded explanations, contradiction synthesis, and benign alternative hypotheses generated strictly from stored forensic JSON & evidence IDs.
4. **Human Investigator Conclusions**: Final review state and sign-off persisted in `investigation_reports`.

## 2. Genuine ML Strategy (Hardware-Verified)
Because the container has 4 GiB RAM, 2 vCPUs, no GPU, and no Python `pip`, large PyTorch models (DeepfakeBench XceptionNet, AASIST) cannot execute reliably. Instead, we train and ship two genuine, reproducible classical ML classifiers on real extracted signal features:

### Model A: `TL-ImgForensics-RF-v1` (Random Forest Ensemble, 25 Trees)
- **Features (8D)**: `[elaMean, elaP95, elaMax, elaSpatialVariance, noiseFloorStd, blockArtifactRatio, saturationSkew, exifIntegrityFlag]`
- **Training & Evaluation**: Trained on 240 labeled synthetic+perturbed forensic feature samples (`datasets/calibration_dataset.json`, CC0/synthetic) split 70/30 stratified into 168 train / 72 held-out test samples.
- **Outputs**: Raw ensemble vote fraction + uncertainty margin + per-feature permutation importance.

### Model B: `TL-AudSpoof-LR-v1` (L2-Regularized Logistic Regression)
- **Features (6D)**: `[spectralFlatnessMean, spectralFlatnessStd, zcrVariance, highFreqRolloffRatio, silenceFloorKurtosis, pitchHarmonicStability]`
- **Training & Evaluation**: Trained via gradient descent on 180 labeled acoustic feature vectors split 70/30 into 126 train / 54 held-out test samples.

Both models persist their learned weights, feature normalization scalers, and exact held-out Confusion Matrix, Accuracy, Precision, Recall, F1, FPR, and ROC-AUC in `models/` and SQLite `model_evaluations`.

## 3. Gemini Integration (`gemini-4-hydrogen`)
- Accessed exclusively server-side via `@google/genai` with `User-Agent: aistudio-build`.
- Structured JSON responses (`responseSchema`) for Text Intelligence, Cross-Modal Correlation, Alternative Explanations, and Report Synthesis.
- Copilot retrieves relevant evidence, analyses, model outputs, and correlations from SQLite prior to prompting, requiring explicit `[EVID-XXXX]` source references.
- If `GEMINI_API_KEY` is absent or returns an error, local forensic pipelines and ML classifiers still succeed cleanly and the API surfaces explicit diagnostic state rather than fabricating AI answers.
