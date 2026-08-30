# Govee Pixel Zones for Homebridge

Experimental local control of individual pucks on Govee H706A Permanent Outdoor Lights Pro.

This Homebridge plugin turns arbitrary puck ranges into normal HomeKit lights and exposes saved Govee Finger Sketch snapshots as switches. It adds software-generated fades for brightness, power, zone colors, and snapshot changes because Govee's per-puck LAN commands do not provide a transition-duration parameter.

> [!WARNING]
> This project uses an undocumented Govee Finger Sketch protocol and is currently verified only on model H706A with a 50-puck installation. It is not affiliated with or supported by Govee. Test cautiously and do not claim compatibility with another model without hardware validation.

## What it exposes

- One master light for power and global brightness.
- One HomeKit light per configured architectural zone.
- One HomeKit switch per imported Govee snapshot.
- Smooth, configurable transitions generated locally by Homebridge.

Snapshot switches keep the original Govee names as stable internal identifiers. You can rename their accessories independently in Apple Home without renaming the snapshots in Govee.

## How it works

The plugin preserves the stock Govee controller and sends Finger Sketch `ptReal` frames over Govee's LAN API. Color transitions are interpolated in linear-light RGB at a conservative five complete frames per second. Snapshot transitions finish with the exact captured target packets.

If two snapshots have identical per-puck colors but different master brightness, the plugin ramps brightness without reloading Finger Sketch. That avoids the visible off/on flash produced by scene reloads.

Power-off fades to minimum brightness before switching off. Power-on wakes at minimum brightness and ramps to the retained level. The last commanded snapshot, brightness, power state, and custom pixel frame are persisted atomically in Homebridge storage so child-bridge restarts resume from the last known logical state.

## Requirements

- Govee H706A Permanent Outdoor Lights Pro. Other models are unverified.
- Govee LAN API enabled in the Govee app.
- Homebridge 1.8 or 2.x.
- Node.js 22.10+ or 24.x.
- The stock `@homebridge-plugins/homebridge-govee` plugin, signed into the same Govee account, for the current snapshot-import workflow.

## Install from GitHub

Until an npm package is published, build and link the plugin with the same Node.js runtime used by Homebridge:

```bash
git clone https://github.com/rileysheehan/homebridge-govee-pixel-zones.git
cd homebridge-govee-pixel-zones
npm ci
npm test
npm link
```

Restart Homebridge after linking the plugin.

## Import snapshots

The importer reuses the existing stock Govee plugin's local account session to request the account's saved snapshots. It writes a credential-free catalog containing only snapshot names, brightness values, decoded color groups, and replayable light-command packets. It does not copy the account token, API key, device identifier, username, or IP address into the catalog.

```bash
govee-pixel-zones-import \
  --sku H706A \
  --pixel-count 50 \
  --names "Default,Christmas,Late Night"
```

By default the catalog is written to `~/.homebridge/govee-pixel-zones/snapshots.json` with owner-only permissions. Use `--output` to choose a different path.

## Map puck boundaries

The calibration tool can render a magenta/red split at an exact boundary or highlight one puck. Puck numbers supplied to the CLI are one-based for humans; zone arrays in Homebridge configuration are zero-based.

Always provide a known snapshot with `--base` so the original lighting can be restored afterward:

```bash
govee-pixel-zones-calibrate \
  --device-ip 192.0.2.1 \
  --base "Default" \
  --mode boundary \
  --value 8 \
  --brightness 30

govee-pixel-zones-calibrate \
  --device-ip 192.0.2.1 \
  --base "Default" \
  --mode identify \
  --value 9 \
  --brightness 30

govee-pixel-zones-calibrate \
  --device-ip 192.0.2.1 \
  --base "Default" \
  --mode restore
```

## Configure Homebridge

The example below creates two independently addressable HomeKit zones. Replace the documentation-only IP address, snapshot name, and pixel ranges with values from your installation.

```json
{
  "platform": "GoveePixelZones",
  "name": "Govee Pixel Zones",
  "deviceIp": "192.0.2.1",
  "catalogPath": "govee-pixel-zones/snapshots.json",
  "baseSnapshot": "Default",
  "transitionMs": 5000,
  "debounceMs": 80,
  "zones": [
    {
      "name": "Porch",
      "pixels": [0, 1, 2, 3, 4]
    },
    {
      "name": "Garage",
      "pixels": [5, 6, 7, 8, 9]
    }
  ]
}
```

Each puck may belong to at most one zone. Pucks can be left unassigned and remain controllable through imported snapshots.

If the same H706A is already exposed by the stock Govee plugin, hide that device there to avoid duplicate HomeKit accessories. Other Govee devices can remain on the stock bridge.

## Current limitations

- H706A is the only hardware-verified model.
- Mapping uses a command-line calibration tool; a phone-friendly mapper is planned.
- Device IP discovery is not automatic.
- Changes made directly in the Govee app are not reconciled into HomeKit's per-puck state.
- The snapshot importer depends on the stock Homebridge Govee plugin's current cache format and undocumented Govee account endpoints.
- LAN UDP commands are best-effort; retry and backpressure handling are still limited.

## Development

```bash
npm ci
npm test
npm run typecheck
```

The protocol codec, catalog importer, calibration frames, transition engine, power fades, debounced HomeKit writes, and restart persistence have automated tests.

## Security and privacy

Never commit Homebridge configuration, snapshot catalogs, state files, account caches, API keys, device identifiers, private IP addresses, or personal zone maps. See [SECURITY.md](SECURITY.md) for reporting guidance and the project's credential boundary.

## License

MIT
