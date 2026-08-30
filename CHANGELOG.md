# Changelog

## 0.1.0 - 2026-08-29

- Decode and encode H706A Finger Sketch `ptReal` frames.
- Import a credential-free catalog of saved Govee snapshots.
- Expose a master light, snapshot switches, and arbitrary puck zones in HomeKit.
- Crossfade per-puck colors in linear-light RGB.
- Fade global brightness and power transitions.
- Debounce related HomeKit characteristic writes into complete frames.
- Persist the last commanded state across child-bridge restarts.
- Provide boundary and individual-puck calibration commands.
