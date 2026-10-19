# Recorded Round streams
Data only, no test reads them yet: one event per line, `t` in seconds from the start of the recording.
- `claude_A_normal.jsonl` and `pi_A_normal.jsonl`: "Make a 5-slide deck about Uruguay." A Helper builds the deck, its result wakes the Assistant, and the Assistant hands it back.
- `claude_B_stop.jsonl` and `pi_B_stop.jsonl`: the same ask, Stop 8 s after the Helper starts, then "Did it finish?".
Recorded on 2026-10-18 by a validation script driving the engine's Claude and pi executors against a live model, teeing executor events and tool checkpoints; absolute paths were replaced with `/workspace`.
