/*
 * Frontend telemetry boundary. Keep wire-format handling here so the UI can
 * continue using one normalized tile model when the central server arrives.
 */
export const SENSOR_STALE_AFTER_MS = 3500;

const RISK_NAMES = {
  CLEAR: 'CLEAR',
  CAUTION: 'CAUTION',
  RISK: 'RISK',
  UNKNOWN: 'UNKNOWN',
  STALE: 'STALE'
};

const TURNTABLE_STATUS = {
  0: 'IDLE', 1: 'ROTATING', 2: 'HOLDING', 3: 'FAULT', 4: 'ESTOP'
};
const TURNTABLE_FAULT = {
  0: 'NONE', 1: 'ESTOP', 2: 'STALL', 3: 'OVERSPEED',
  4: 'TIMEOUT', 5: 'HOME_MISMATCH'
};

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeRiskState(value) {
  if (typeof value === 'number') return RISK_NAMES.UNKNOWN;
  const state = String(value || 'UNKNOWN').trim().toUpperCase();
  return RISK_NAMES[state] || RISK_NAMES.UNKNOWN;
}

function isUltrasonic(measurement) {
  const type = String(firstDefined(measurement, ['type', 'sensor_type', 'sensorType']) || '').toLowerCase();
  return type.includes('ultrasonic') || type === 'us';
}

function normalizeDock(dock, now) {
  const sensorValid = Boolean(firstDefined(dock, ['sensor_valid', 'sensorValid']));
  const measuredAt = isoTime(firstDefined(dock, ['measured_at', 'measuredAt', 'timestamp', 'ts']));
  const measuredMs = measuredAt ? Date.parse(measuredAt) : null;
  const ageMs = measuredMs === null ? null : Math.max(0, now - measuredMs);
  const timeStale = sensorValid && (ageMs === null || ageMs > SENSOR_STALE_AFTER_MS);
  const reportedRisk = sensorValid && !timeStale
    ? normalizeRiskState(firstDefined(dock, ['risk_state', 'riskState', 'status']))
    : 'UNKNOWN';
  const stale = timeStale || reportedRisk === 'STALE';
  const riskState = !sensorValid ? 'UNKNOWN' : stale ? 'STALE' : reportedRisk;

  return {
    side: Number(firstDefined(dock, ['side_index', 'sideIndex', 'side'])),
    occupied: Boolean(firstDefined(dock, ['occupied'])),
    riskState,
    blocked: firstDefined(dock, ['blocked']) === undefined ? null : Boolean(dock.blocked),
    blockReason: firstDefined(dock, ['blocked_reason', 'blockReason', 'reason']) || null,
    clearanceM: finiteNumber(firstDefined(dock, ['clearance_m', 'clearanceM', 'clearance'])),
    riskPercent: finiteNumber(firstDefined(dock, ['risk_percent', 'riskPercent', 'risk'])),
    sensorValid,
    measuredAt,
    ageMs,
    stale,
    neighborTile: firstDefined(dock, ['neighbor_tile', 'neighborTile', 'joined']) || null,
    measurements: Array.isArray(dock.measurements) ? dock.measurements.filter(isUltrasonic).map((measurement) => ({
      ...measurement,
      type: 'ultrasonic',
      distance: finiteNumber(firstDefined(measurement, ['distance_m', 'distanceM', 'distance'])),
      ts: Date.parse(isoTime(firstDefined(measurement, ['measured_at', 'measuredAt', 'timestamp', 'ts'])) || '') || null
    })) : []
  };
}

function legacyDocks(sides) {
  return (sides || []).map((side, index) => {
    if (side && side.joined) {
      return {
        side_index: index, occupied: true, sensor_valid: false,
        risk_state: 'UNKNOWN', blocked: true, neighbor_tile: side.joined
      };
    }
    const measurements = side && Array.isArray(side.measurements) ? side.measurements.filter(isUltrasonic) : [];
    const hits = measurements
      .filter((measurement) => measurement.hit && Number.isFinite(Number(measurement.distance)))
      .map((measurement) => Number(measurement.distance));
    return {
      side_index: index,
      occupied: false,
      risk_state: side && side.status,
      sensor_valid: Boolean(side && side.status && side.status !== 'UNKNOWN'),
      clearance_m: hits.length ? Math.min(...hits) : null,
      measured_at: side && side.ts,
      risk_percent: side && side.risk,
      measurements
    };
  });
}

function normalizeTurntable(source) {
  const status = firstDefined(source, ['status', 'turntable_status']);
  const fault = firstDefined(source, ['fault', 'turntable_fault']);
  return {
    status: typeof status === 'number' ? (TURNTABLE_STATUS[status] || 'UNKNOWN') : String(status || 'UNKNOWN').toUpperCase(),
    fault: typeof fault === 'number' ? (TURNTABLE_FAULT[fault] || 'UNKNOWN') : String(fault || 'UNKNOWN').toUpperCase(),
    angleDeg: finiteNumber(firstDefined(source, ['angle_deg', 'angleDeg', 'turntable_angle'])),
    currentEdge: finiteNumber(firstDefined(source, ['current_edge', 'currentEdge', 'turntable_current_edge'])),
    pwmUs: finiteNumber(firstDefined(source, ['pwm_us', 'pwmUs', 'turntable_pwm'])),
    speedDegS: finiteNumber(firstDefined(source, ['speed_deg_s', 'speedDegS', 'rotational_speed'])),
    speedGains: firstDefined(source, ['speed_gains', 'speedGains', 'turntable_speed_gains']) ?? null
  };
}

function normalizeDiagnostics(raw) {
  const arm = raw.arm || {};
  const conveyor = raw.conveyor || {};
  const dockSensors = raw.dock_sensors || raw.docks_diagnostics || {
    topDockCurrent: firstDefined(raw, ['top_dock_current_sensor', 'topDockCurrentSensor']) ?? null,
    topDockContact: firstDefined(raw, ['top_dock_contact_sensor', 'topDockContactSensor']) ?? null,
    topDockMotorPwm: firstDefined(raw, ['top_dock_motor_pwm_command', 'topDockMotorPwmCommand']) ?? null,
    bottomDockContact: firstDefined(raw, ['bottom_dock_contact_status', 'bottomDockContactStatus']) ?? null,
    bottomDockCapture: firstDefined(raw, ['bottom_dock_capture_status', 'bottomDockCaptureStatus']) ?? null,
    bottomDockPwm: firstDefined(raw, ['bottom_dock_pwm_command', 'bottomDockPwmCommand']) ?? null,
    bottomDockCurrent: firstDefined(raw, ['bottom_dock_current_sensor', 'bottomDockCurrentSensor']) ?? null,
    bottomDockDistance: firstDefined(raw, ['bottom_dock_distance_sensors', 'bottom_dock_distance_sensor', 'bottomDockDistanceSensors']) ?? null,
    relativeBottomEdgeAngle: firstDefined(raw, ['relative_bottom_edge_angle', 'relativeBottomEdgeAngle']) ?? null
  };
  const rapid = raw.rapid || raw.rapid_state || (
    raw.rapid_demand || raw.rapid_reference || raw.known_neighbor_demand
      ? { demand: raw.rapid_demand || null, reference: raw.rapid_reference || null, knownNeighbors: raw.known_neighbor_demand || null }
      : null
  );
  return {
    armAngle: finiteNumber(firstDefined(arm, ['angle_deg', 'angleDeg']) ?? raw.arm_angle),
    armCommand: firstDefined(arm, ['command']) ?? raw.arm_command ?? null,
    pneumaticPressure: finiteNumber(firstDefined(raw, ['pneumatic_pressure', 'pneumaticPressure'])),
    conveyorSpeed: finiteNumber(firstDefined(conveyor, ['speed', 'speed_m_s']) ?? raw.conveyor_speed),
    conveyorPwmUs: finiteNumber(firstDefined(conveyor, ['pwm_us', 'pwmUs']) ?? raw.conveyor_pwm),
    conveyorGains: firstDefined(conveyor, ['speed_gains', 'speedGains']) ?? null,
    dockSensors: Object.values(dockSensors).some((value) => value !== null && value !== undefined) ? dockSensors : null,
    rapid
  };
}

/** Normalize either the current simulator payload or the planned server payload. */
export function normalizeTileTelemetry(tile, now = Date.now()) {
  const raw = tile || {};
  const dockSource = Array.isArray(raw.sides)
    ? legacyDocks(raw.sides)
    : Array.isArray(raw.docks)
      ? raw.docks
      : Array.isArray(raw.dock_positions)
        ? raw.dock_positions
        : [];
  const docks = Array.from({ length: 6 }, (_, side) => {
    const source = dockSource.find((dock) => Number(firstDefined(dock, ['side_index', 'sideIndex', 'side'])) === side);
    return normalizeDock(source || { side_index: side }, now);
  });
  const turntableSource = raw.turntable || raw;
  const telemetry = {
    tileId: firstDefined(raw, ['tile_id', 'tileId', 'id']) ?? '—',
    batteryV: finiteNumber(firstDefined(raw, ['battery_v', 'batteryV', 'battery_level'])),
    lowerBatteryV: finiteNumber(firstDefined(raw, ['lower_battery_v', 'lowerBatteryV', 'lower_battery_level'])),
    turntable: normalizeTurntable(turntableSource),
    diagnostics: normalizeDiagnostics(raw)
  };

  return {
    ...raw,
    id: firstDefined(raw, ['id', 'tile_id', 'tileId']) ?? '—',
    q: finiteNumber(raw.q),
    r: finiteNumber(raw.r),
    docks,
    telemetry
  };
}
