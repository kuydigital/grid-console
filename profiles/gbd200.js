// Casio GBD-200 profile — verified on hardware.
// A profile is pure data: it tells the engine which Casio service/characteristics
// to use, which feature modules to show, and the per-model byte layouts those
// modules read. Adding a new watch = adding a file like this (no engine changes).
export default {
  id: "gbd200",
  label: "Casio GBD-200",
  verified: true,                       // confirmed on real hardware
  match: (name) => /GBD-?200/i.test(name || ""),
  namePrefix: "CASIO",

  // Casio "2C / All Features" service + characteristics
  service: "26eb000d-b012-49a8-b1f8-394fb2032b0f",
  chars: {
    req:  "26eb002c-b012-49a8-b1f8-394fb2032b0f",  // write feature code (no response)
    all:  "26eb002d-b012-49a8-b1f8-394fb2032b0f",  // notify + settings write
  },

  // Which feature modules the UI shows, in order
  features: ["time", "alarms", "settings", "status", "diagnostic"],

  // Per-feature byte layouts the shared modules read
  time:   { feat: 0x09 },
  alarms: { count: 5, feat1: 0x15, featN: 0x16 },
  basic:  { feat: 0x13, h24Bit: 0x01, toneBit: 0x02, lightBit: 0x04, vibByte: 10 },
  info:   { name: 0x23, version: 0x20, city: 0x1f, condition: 0x28 },
};
