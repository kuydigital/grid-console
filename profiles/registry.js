// Profile registry. Import each model profile and add it to PROFILES.
// Contributors: add `import xyz from "./xyz.js";` and push it to the array.
import gbd200 from "./gbd200.js";
import abl100we from "./abl100we.js";

export const PROFILES = [gbd200, abl100we];

// Known Casio service UUIDs to request access to (optionalServices for Web Bluetooth).
// A watch that advertises one of these but has no matching profile still connects
// into Diagnostic mode.
export const CASIO_SERVICES = [
  "26eb000d-b012-49a8-b1f8-394fb2032b0f", // 2C / All Features (GBX-100, GBD-100/200, GG-B100, ...)
  "00001804-0000-1000-8000-00805f9b34fb", // Tx Power
  "00001805-0000-1000-8000-00805f9b34fb", // Current Time
];

// Generic fallback for an unrecognized watch: Diagnostic only.
export const GENERIC = {
  id: "generic",
  label: "Unknown watch",
  verified: false,
  service: null,                 // discovered at runtime
  chars: {},
  features: ["diagnostic"],
};

export function matchProfile(name) {
  return PROFILES.find((p) => typeof p.match === "function" && p.match(name)) || null;
}
