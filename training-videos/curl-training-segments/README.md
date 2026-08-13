# Curl training segments

The original `C:\Users\omarg\Downloads\curl trining.mp4` was left unchanged.

This folder contains 24 independently playable MP4 clips segmented by source video or demonstration. Every clip was fully decoded after export and retains H.264 video, AAC audio, 1920x1040 resolution, and 30 FPS.

## Files

- `clip_001.mp4` through `clip_024.mp4`: segmented footage.
- `segments-index.json`: timestamps, content labels, validation metadata, and proposed training use.
- `segments-preview.jpg`: midpoint frame from each clip in row-major order (clips 1–24).
- `_preview_frames/`: individual midpoint frames used for visual validation.

## Dataset filtering

- 13 clips are initial real-exercise candidates.
- 7 clips contain real exercise but are under five seconds and require manual review.
- Clip 6 is animation and should be instructional reference only.
- Clips 11, 15, and 23 are about hair curls, not exercise, and must be excluded.

The source appears to contain third-party social-media footage. Before using any candidate to train or redistribute a model, verify that you own the footage or have permission for that use. Technical segmentation does not establish training rights.
