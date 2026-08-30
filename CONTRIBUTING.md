# Contributing

Issues and pull requests are welcome, especially hardware-verified protocol captures and compatibility results.

Before submitting a change:

1. Remove all account credentials, device identifiers, private IP addresses, personal snapshot catalogs, and zone maps.
2. Run `npm ci`, `npm test`, and `npm run typecheck`.
3. State the exact Govee model, puck count, Homebridge version, and Node.js version used for physical validation.
4. Do not advertise support for a model based only on similar packet structure; compatibility claims require a physical test.

Protocol changes should include focused tests using synthetic or sanitized packet fixtures.
