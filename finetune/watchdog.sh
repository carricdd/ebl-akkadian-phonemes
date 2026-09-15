#!/usr/bin/env bash
# watchdog.sh — keep the Akkadian Piper fine-tune alive on the VRAM-tight,
# ollama-shared RTX 4060. If training dies (e.g. transient CUDA OOM), resume
# from the newest last.ckpt. Capped to avoid a crash-loop. nohup this.
cd ~/tts-finetune || exit 1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
MAX=30
n=0
while [ "$n" -lt "$MAX" ]; do
  if ! pgrep -f "python -m piper.train fit" >/dev/null 2>&1; then
    CK=$(ls -t runs/akkadian-ar/lightning_logs/version_*/checkpoints/last.ckpt 2>/dev/null | head -1)
    ts=$(date '+%F %T')
    if [ -n "$CK" ]; then
      echo "[$ts] training down -> resume #$((n+1)) from $CK" >> train_resumes.log
      nohup nice -n 15 .venv-train/bin/python -m piper.train fit \
        -c akkadian-config.yaml --ckpt_path "$CK" >> train_resume_$(date +%s).log 2>&1 &
      n=$((n+1))
      sleep 90   # give it time to spin up before re-checking
    else
      echo "[$ts] training down but no last.ckpt found; stopping watchdog" >> train_resumes.log
      exit 1
    fi
  fi
  sleep 120
done
echo "[$(date '+%F %T')] hit MAX=$MAX resumes; stopping watchdog" >> train_resumes.log
