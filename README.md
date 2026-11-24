# Grid Console

**Bluetooth control for Casio G‑Shock watches — by KUYDIGITAL.**

A browser app (Chrome / Edge, Web Bluetooth) that reads and writes the real settings of
Bluetooth‑enabled Casio G‑Shocks. Each watch model is a small **profile**; an unrecognized
watch drops into **Diagnostic mode** so its protocol can be captured and a profile added —
*without the maintainer needing to own every watch.*

> This is the multi‑model successor to [**gbd200‑grid**](https://github.com/kuydigital/gbd200-grid),
> which remains the dedicated, hardware‑verified tool for the GBD‑200. Grid Console is **early and
> expands by community capture** — models other than the GBD‑200 are unverified until an owner confirms them.

It does **not** touch firmware and **cannot reskin** a watch's LCD (that's fixed in ROM). Bluetooth
only exposes *data* (time, alarms, settings, world time, …). Not affiliated with or endorsed by Casio.
Protocol facts derived from the open‑source [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge)
project and [dakk/casio‑gshock‑bt‑proto](https://github.com/dakk/casio-gshock-bt-proto). "G‑SHOCK" is a trademark of Casio.

## Architecture

```
index.html      shell + theme
app.js          engine: connect → discover GATT → route to profile → build UI
                from the profile's feature list, using shared feature modules
profiles/
  registry.js   list of profiles + Casio service UUIDs + generic fallback
  gbd200.js     one model = one data file (service, chars, features, byte layouts)
```

**Adding a watch = adding a `profiles/<model>.js` file.** No engine changes. A profile declares
the Casio service/characteristics, which feature modules to show, and the per‑model byte layouts
those modules read. Shared modules — Time, Alarms, Timers, World Time, Signal (notifications),
Finder, Activity, Profile, Status, Settings and Diagnostic — work across the whole 2C/"All Features"
family; a model only lists the ones it supports (and the optional channels, like the notification
and convoy characteristics, that Signal/Finder/Activity need).

## How we add watches without owning them

1. **Harvest open reverse‑engineering.** Gadgetbridge already supports many Casio BT models; their
   feature maps become profile entries (reimplemented from the protocol facts, kept MIT).
2. **Crowdsource captures.** The in‑app **Diagnostic** tab dumps the watch's GATT table, probes its
   feature codes, and exports a JSON report. Any owner of any model can run it and submit the report —
   every visitor becomes a potential data source. (Review the export first; it names your watch.)
3. **Emulate for testing.** Captured frames become fixtures so profiles can be built/tested with no hardware.

## Status

| Model | State |
|-------|-------|
| **GBD‑200** | ✅ full feature set (Time, Alarms, Timers, World Time, Signal, Finder, Activity, Profile, Status, Settings) |
| GBX‑100, GBD‑100, GG‑B100, … | ⏳ planned — same 2C family, need a capture to confirm |

The full GBD‑200 feature set from [gbd200‑grid](https://github.com/kuydigital/gbd200-grid) now runs
through Grid Console's shared modules; new models light up these same tabs by declaring the matching
feature codes in their profile.

## Use it

Open in **Chrome or Edge** (Web Bluetooth isn't in Safari/Firefox):

1. Turn your **phone's Bluetooth off** so the watch isn't already connected to the G‑SHOCK MOVE app
   (BLE allows one connection). On iPhone use **Settings → Bluetooth**, not Control Center.
2. Hold the watch's lower‑left button to enter pairing mode.
3. **Connect** and pick your watch. Recognized models load their tabs; unknown ones open Diagnostic.

Because it's multi‑file (ES modules), run it from a server, not `file://` — GitHub Pages works, or
locally `python3 -m http.server` then open `http://localhost:8000`.

## Contributing a model

Open an issue with your **Diagnostic export** — connect (Live Link) and run **Probe Features** before
exporting, so the capture includes the watch's feature codes (a GATT dump alone can't build a profile;
the app will warn you if the probe is empty). Or send a PR adding `profiles/<model>.js`. Keep every
write **read‑modify‑write and read‑back‑verified**, and mark an unverified model `verified: false`
(it shows a ⚠️ badge). Add yourself to `AUTHORS`.

## Support

If this is useful, you can [**☕ buy me a coffee**](https://www.paypal.com/paypalme/thekuys).

## License

MIT — see [LICENSE](LICENSE). © 2026 KUYDIGITAL.
