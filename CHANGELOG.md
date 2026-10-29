# Changelog

## 0.2.3 - 2026-10-28

- Reach a dim copy of the base snapshot (same pixels, e.g. Late Night) from a different look (e.g. Halloween) by
  crossfading to the base snapshot's own packets at the current brightness and only then dimming, each in half the
  transition. Loading the copy's own packets while ramping down to 5% left the lights orange instead of warm white.
- Log each snapshot activation and how it was reached.

## 0.2.2 - 2026-10-26

- Confirm power changes by `devStatus` readback (first made on the live install on 2026-10-14, now committed).
- Wait up to 15 s for the controller to report the new power state, resending `turn` every 3 s, instead of three
  back-to-back tries: after the sunrise fade the controller kept reporting "on" for over a second, then turned out off.
- Log how long each power change took to confirm.
- Record an unconfirmed off as off, so the next wake sends an explicit power on instead of trusting a stale "on".

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
