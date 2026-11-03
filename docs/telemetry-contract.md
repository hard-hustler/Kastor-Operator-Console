# Frontend telemetry contract

The tablet UI consumes a normalized tile model in `static/js/telemetry.js`. That module is the boundary between the central server's wire format and the UI. Keep transport code and server-specific enum decoding outside the renderers.

## Operator view

The default view uses the fields that help an operator identify the tile and make a safe next-step decision:

- Tile ID and axial `q,r` coordinates.
- Per dock: side index, occupied, risk state, blocked state/reason, clearance in meters, sensor validity, and measured time.
- Tile battery voltage.
- Turntable status, fault, angle, and current edge.

Controller gains, PWM commands, rotational/conveyor speeds, arm state, pneumatic pressure, individual motor currents, contact/capture sensors, raw distance sensors, and RAPID values are kept in the collapsed **Advanced diagnostics** section. Missing fields display as “Not reported”; the UI does not fabricate defaults for hardware telemetry.

## Planned server payload

```json
{
  "tile_id": 321,
  "q": 2,
  "r": -1,
  "battery_v": 12.1,
  "lower_battery_v": null,
  "docks": [
    {
      "side_index": 0,
      "occupied": false,
      "risk_state": "CAUTION",
      "blocked": false,
      "blocked_reason": null,
      "clearance_m": 1.8,
      "sensor_valid": true,
      "measured_at": "2026-09-14T14:00:00.123Z"
    }
  ],
  "turntable": {
    "status": 1,
    "fault": 0,
    "angle_deg": 57.3,
    "current_edge": 1,
    "pwm_us": 1820,
    "speed_deg_s": 34.2,
    "speed_gains": [1.24, 0.0, 0.0]
  },
  "arm": {"angle_deg": null, "command": null},
  "conveyor": {"speed": null, "pwm_us": null, "speed_gains": null},
  "pneumatic_pressure": null,
  "dock_sensors": null,
  "rapid": null
}
```

`docks` should contain one entry per side (0–5). The frontend currently decodes the provided turntable status and fault enums. **Risk-state numeric values are intentionally not guessed**: until the central server publishes their mapping, send the semantic strings `CLEAR`, `CAUTION`, `RISK`, or `UNKNOWN`. An unrecognized or numeric risk value is rendered as unknown. A sensor with `sensor_valid: false`, a missing timestamp, or a timestamp older than 3.5 seconds is also treated as unknown/stale.

`blocked` is the server's decision for the dock and should be paired with a human-readable `blocked_reason` when true. Occupancy and risk remain separate from blocked state; an occupied dock is not assumed to be a joined tile unless `neighbor_tile` is supplied. The current page still uses its mock server for command behavior; wiring the central API and making its blocked decision authoritative are a later integration step.

The adapter does not assume units for conveyor speed, pneumatic pressure, arm readings, or dock current/PWM values where the hardware list did not specify them. Agree on and include those units in the central-server contract before presenting them as engineering measurements.
