# Changelog

## 0.2.1 - 2026-09-17

- Optional `deviceId` (full Govee device ID or MAC) enables automatic LAN IP discovery; `deviceIp` becomes a hint.
- Discovery binds per interface, falls back to a paced Govee scan of small directly connected subnets, and
  never uses an address that has not answered with the configured identity.

## 0.2.0 - 2026-09-12

- Replace the separate master light with a HomeKit-native group of zone lights.
- Report each zone's effective brightness after Govee global dimming.
- Materialize global snapshot brightness into per-pixel values before independent zone edits.
- Fade and power down the physical controller when every grouped zone turns off.
- Preserve retained zone brightness while the controller is off for a smooth group wake.
- Keep existing zone and snapshot accessory identities during migration.

## 0.1.0 - 2026-08-29

- Decode and encode H706A Finger Sketch `ptReal` frames.
- Import a credential-free catalog of saved Govee snapshots.
- Expose a master light, snapshot switches, and arbitrary puck zones in HomeKit.
- Crossfade per-puck colors in linear-light RGB.
- Fade global brightness and power transitions.
- Debounce related HomeKit characteristic writes into complete frames.
- Persist the last commanded state across child-bridge restarts.
- Provide boundary and individual-puck calibration commands.
