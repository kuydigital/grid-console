// Casio ABL-100WE — UNVERIFIED profile, inferred from a community Diagnostic export.
//
// The export (device "CASIO ABL-100WE") showed the standard Casio 2C/"All Features"
// service 26eb000d with the request (0x2c) and all (0x2d) characteristics, so the
// shared 2C feature modules should apply. It did NOT include a Probe Features run,
// so no feature code is confirmed on this hardware yet — the byte layouts below are
// the family defaults (same as the GBD-200), left `verified:false` until an owner
// confirms with a live capture. The feature list is deliberately conservative:
//   - no 0x30 notification characteristic was seen -> Signal/Finder omitted
//   - the ABL-100WE has no pedometer                -> Activity omitted
//   - no interval timer / fitness profile on this model -> Timers/Profile omitted
// A probe capture may add or correct any of these.
export default {
  id: "abl100we",
  label: "Casio ABL-100WE",
  verified: false,                      // inferred from a GATT dump, not confirmed live
  match: (name) => /ABL-?100/i.test(name || ""),
  namePrefix: "CASIO",

  service: "26eb000d-b012-49a8-b1f8-394fb2032b0f",
  chars: {
    req: "26eb002c-b012-49a8-b1f8-394fb2032b0f",
    all: "26eb002d-b012-49a8-b1f8-394fb2032b0f",
  },

  // Conservative set the shared modules can drive over the 2C protocol.
  features: ["time", "alarms", "world", "status", "settings", "diagnostic"],

  time:   { feat: 0x09 },
  alarms: { count: 5, feat1: 0x15, featN: 0x16 },
  basic:  { feat: 0x13, h24Bit: 0x01, toneBit: 0x02, lightBit: 0x04, vibByte: 10 },
  world:  { list: 0x1f, zone: 0x1e, pair: 0x1d, slots: 2 },
  info:   { name: 0x23, version: 0x20, city: 0x1f, condition: 0x28 },
};
