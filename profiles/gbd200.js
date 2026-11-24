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
    req:      "26eb002c-b012-49a8-b1f8-394fb2032b0f",  // write feature code (no response)
    all:      "26eb002d-b012-49a8-b1f8-394fb2032b0f",  // notify + settings write
    note:     "26eb0030-b012-49a8-b1f8-394fb2032b0f",  // phone -> watch notification sink (Signal, Finder)
    convoyReq:"26eb0023-b012-49a8-b1f8-394fb2032b0f",  // convoy request / echo (Activity)
    convoyRx: "26eb0024-b012-49a8-b1f8-394fb2032b0f",  // convoy payload, inverted (Activity)
  },

  // Which feature modules the UI shows, in order
  features: ["time", "alarms", "timers", "world", "signal", "finder", "activity", "profile", "status", "settings", "diagnostic"],

  // Per-feature byte layouts the shared modules read
  time:   { feat: 0x09 },
  alarms: { count: 5, feat1: 0x15, featN: 0x16 },
  basic:  { feat: 0x13, h24Bit: 0x01, toneBit: 0x02, lightBit: 0x04, vibByte: 10 },
  timers: { count: 5, cfg: 0x2a, name: 0x44 },
  world:  { list: 0x1f, zone: 0x1e, pair: 0x1d, slots: 2 },
  person: { feat: 0x45, genderBit: 0x01, wristBit: 0x02 },
  activity: { convoyRead: [0x00, 0x11, 0x00, 0x00, 0x00] },
  info:   { name: 0x23, version: 0x20, city: 0x1f, condition: 0x28 },
};
