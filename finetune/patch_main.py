#!/usr/bin/env python3
"""Remove the val_mos ModelCheckpoint from piper.train.__main__._DEFAULT_CALLBACKS.
This Lightning (2.6.5) raises MisconfigurationException when a monitored key
(val_mos / UTMOS) is never logged, instead of warning+skipping as the code
comment assumed. Keep only the val_mel + save_last checkpoint callback.
"""
import re, sys, io

path = sys.argv[1]
src = io.open(path, encoding="utf-8").read()

new_block = '''_DEFAULT_CALLBACKS = [
    ModelCheckpoint(
        monitor=_MONITOR,
        mode="min",
        save_top_k=5,
        save_last=True,
        filename="epoch={epoch}-val_mel={val_mel:.4f}",
        auto_insert_metric_name=False,
    ),
]'''

# Replace the whole `_DEFAULT_CALLBACKS = [ ... ]` list (non-greedy up to the
# first line that is exactly "]").
pat = re.compile(r"_DEFAULT_CALLBACKS = \[.*?\n\]", re.DOTALL)
if not pat.search(src):
    print("PATTERN NOT FOUND", file=sys.stderr); sys.exit(2)
src2 = pat.sub(new_block, src, count=1)
io.open(path, "w", encoding="utf-8").write(src2)
# sanity: only one ModelCheckpoint left, no val_mos
print("ModelCheckpoint count:", src2.count("ModelCheckpoint("))
print("val_mos present:", "val_mos" in src2)
