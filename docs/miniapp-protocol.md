# TSL6 Mini App BLE protocol (runtime)

Source: static analysis of the vendor WeChat Mini App "TSL电子模块" (`__APP__.wxapkg`, PC WeChat cache, 2026-11-13).
Nothing in this file is tested on hardware yet, except where a line says so.
The unpacked vendor code is not in this repo. It stays local in `~/.cache/tsl6-miniapp/`.

The app serves many device types (`hw_ver` 3–20). This note covers the parts that the TSL6 uses.

## Transport

| Item | Value |
|---|---|
| Service | `0000FFF0-0000-1000-8000-00805F9B34FB` |
| Characteristic | `FFF1`: write (with or without response) and notify. Same as the bootloader |
| MTU | Android asks for 247. Chunk size = MTU − 3, capped at 244. Default 20 |
| TX retry | Each chunk is retried up to 10 times on a write error |

Frame (both directions), same as the bootloader:

```
55 7F TYPE LEN_H LEN_L PAYLOAD... CHK
CHK = (TYPE + LEN_H + LEN_L + sum(PAYLOAD)) & 0xFF
```

RX rules in the app:
- A gap of 500 ms or more between notifications resets the parser.
- A frame with `LEN > 4096` is dropped.
- A bad checksum drops the frame without a message.

## Connect sequence

1. Connect GATT. Enable notify on `FFF1`.
2. Send `A0` (no payload). The module replies `A0` with the status payload.
3. If the module sends `A8 FF`, it asks for the BLE password. Send `A8` + 4 ASCII bytes. Default password: `1234`.
4. The module replies `A8 01` (password OK) or `A8 00` (wrong).
   The app allows 3 wrong tries, then waits 1 hour. This limit is in the app, not in the module (not checked).

## Status payload (reply to A0, A1 and A3)

Offsets are into the payload (after the 5-byte header).

| Offset | Size | Meaning |
|---|---|---|
| 0 | 1 | Device type hint. The app prefers `hw_ver` from the vendor server and uses this byte only as a fallback |
| 1 | 1 | Bootloader version, major byte (`bt_ver = b1 << 8`) |
| 2 | 1 | Runtime version, major byte (`fw_ver = b2 << 8`) |
| 3 | 1 | Bit 0: 1 = runtime is running, 0 = module is in update (boot) mode. The app reads the whole byte as `esp` for types 3–19 |
| 4 | 12 | Module ID (chip UID). The app shows it as 24 hex characters |
| 12 | 6 | The app shows bytes 12–17, reversed, as the "MAC" (overlaps the ID) |
| 4 | 14 | `UID14` for A3, A4, A5, AD, AE: payload bytes 4–17. Runtime V1.0.00 fills these bytes and compares them on A3 (disassembly). The 12-byte "module ID" that the app shows is bytes 4–15. Bytes 16–17 repeat bytes 4–5 on the owner's module. The recovery page formula `id[4:12] + id[0:6]` is for the bootloader reply only (not checked how the two IDs relate) |
| 18 | 1 | `fxp` (types 3–19) |
| 19 | 1 | `on`. Bit 0 = the "免打扰" (no-nag) function is active |
| 20 | 2 | Timer, little-endian, in ms (shown ÷ 1000) |
| 22 | 1 | `dat0` |
| 23 | 1 | `dat1`. Types 6, 7, 8, 19: bit 0/1/2 = CAN1/CAN2/CAN3 connected |
| 24 | 11 | Settings bytes. See the bit map below |
| 36 | 4 | BLE password, ASCII (only if the payload is ≥ 40 bytes) |
| 40 | 1 + 17 | If byte 40 = 1: VIN in bytes 41–57 (layouts other than 178 bytes) |
| 46 | 17 | VIN, 178-byte layout. `FF` at byte 46 = no VIN |
| 59 | 16 | Extra settings block, 76-byte layout only (`airAutoArid` at byte 59 bits 6–7) |

Confirmed on hardware (boot mode only, 2026-11-12): the bootloader reply is `00 12 10 00` + ID12 + 2 bytes = 18 bytes.
Byte 3 bit 0 = 0, so the app reads it as update mode. This matches the table.

The app needs at least 18 bytes for the ID, at least 28 bytes before it writes settings, and at least 32 bytes to decode the TSL6 settings.

## Settings bit map (types 3, 5, 6, 7, 8, 19)

`B[n]` = payload byte n. Values are raw field values. Labels are from the app (translated).

### Scroll (nag) settings

| ID | Field | Values |
|---|---|---|
| `time` | B27 bits 0–3 | With `rand` = 1: 1 = every 2–3 s random (default), 2 = 3–5 s, 3 = 5–10 s, 4 = 10–15 s, 5 = 15–20 s, 6 = 20–25 s, 7 = 25–30 s, 8 = 30–35 s. With `rand` = 0: 1 = every 2 s, 2 = 3 s, 3 = 5 s, 4 = 10 s, 5 = 15 s, 6 = 20 s, 7 = 25 s, 8 = 30 s. 15 = fixed-point assist |
| `rand` | B28 bit 0 | 0 = off, 1 = on (default). Random interval |
| `automdr` | B28 bit 4 | AP auto assist. 0 = off (default), 1 = follow AP. Types 6, 7, 8, 9, 19 |
| `lr` | B28 bits 6–7 | Scroll wheel. Types 6, 8, 19: 0 = left wheel, volume (default); 1 = right wheel, speed; 2 = alternate left and right; 3 = right wheel, follow distance. Other types: 0 = left, 1 = right, 2 = alternate, 3 = random |
| `ModeMDR` | B29 bits 0–1 | Assist method, type 19 only. 0 = wheel (default), 1 = "senseless" assist, 2 = both |
| `enable_save` | B30 bit 0 | Types 3, 5 only. Forced to 0 for 6, 7, 8, 19 |
| `jg` | B32 bits 0–3 | Up/down tick gap: value × 0.1 s (1–10). Default 1 |
| `dblclickMDR` | B32 bit 7 | Types 3, 5 only |
| `jj` | B33 bits 0–1 | Tick order. 0 = up then down, 1 = down then up (default), 2 = alternate, 3 = random |

### Basic settings

| ID | Field | Values |
|---|---|---|
| `beep` | B26, whole byte | Beep volume. 0, 1–10 (5 %–50 %), 20, 30, 50, 70, 90, 110, 130, 150, 170, 255 (100 %, default) |
| `led` | B27 bit 4 | 0 = LED on (default), 1 = off |
| `BLEPWR` | B31 bits 0–1 | BLE TX power. 0 = strong (default), 1 = medium, 2 = weak. Needs a module restart (A5). Types 3, 6, 8, 9, 19 |

### Vehicle function settings (`tsl6list`)

| ID | Field | Values |
|---|---|---|
| `autoSportMode` | B24 bits 0–2 | 0 = off, 1–7 = accelerator ≥ 20 % … 80 % |
| `backHazardRearFogLight` | B24 bit 3 | Rear fog light while reversing (lab) |
| `autoParkBrake` | B24 bit 4 | Auto park brake |
| `KERS` | B24 bits 5–7 | Regen. 0 = car setting, 1 = 0 %, 2 = 25 %, 3 = 50 %, 4 = 75 %, 5 = 100 % |
| `pluseHighBeam` | B25 bits 0–1 | High-beam strobe. 0 = off, 1 = fast, 2 = medium, 3 = slow |
| `pluseHighBeamAndLowBeam` | B25 bit 2 | Low beam follows the strobe (sub of `pluseHighBeam`) |
| `frontRightEasyAccess` | B25 bits 3–4 | Passenger easy entry. 1 = on belt release, 2 = on door open/close |
| `stoppingMode` | B25 bits 5–6 | 0 = car setting, 1 = hold, 2 = creep, 3 = roll |
| `OffAPAutoWiper` | B25 bit 7 | Turn off auto wipers (under AP) |
| `longPluseHorn` | B27 bit 5 | Long press horn starts pulse horn (sub of `pluseHorn`) |
| `pluseHorn` | B27 bits 6–7 | Pulse horn. 0 = off, 1 = fast, 2 = medium, 3 = slow |
| `apAutoOpenType` | B28 bits 1–2 | AP resume. 0 = off, 1 = double-click right wheel, 2 = stalk fully down, 3 = follow AP. Turning it on sets `fsd` to 0 |
| `mianSwitch` | B28 bit 3 | Module master switch. 0 = module on (default), 1 = module off |
| `fsd` | B28 bit 5 | "EAP assist". Turning it on sets `apAutoOpenType` to 0 |
| `TimeOpenFrontBox` | B29 bits 2–4 | Frunk by long door-handle pull: 0 = off, 1–7 s |
| `TimeOpenChargeDoor` | B29 bits 5–7 | Charge port by long door-handle pull: 0 = off, 1–7 s |
| `apAutoOpenTime` | B30 bits 1–3 | AP resume delay, 0–7 s (sub of `apAutoOpenType`) |
| `openDoorHazardLight` | B30 bit 4 | Hazards on door open |
| `pluseFrontFogLight` | B30 bit 5 | Front fog strobe |
| `blinkHighBeam` | B30 bit 6 | Flash high beam 3 times |
| `backHazardLight` | B30 bit 7 | Hazards while reversing |
| `APSpeedExit` | B31 bit 2 | Exit AP on overspeed |
| `oneClickOpenAP` | B31 bit 3 | One-click AP |
| `apHighBeam` | B31 bits 4–5 | Manual high beam. 0 = off, 1 = old (AP manual high beam), 2 = new |
| `pluseRearFogLight` | B31 bit 6 | Rear fog strobe |
| `steerAssistanceLighting` | B31 bit 7 | Cornering light (lab). Types 6, 7, 8, 19 only |
| `hornLinkedHighBeam` | B32 bit 5 | Horn also flashes high beam |
| `highBeamLinkedHorn` | B32 bit 6 | High beam also sounds horn |
| `turnLightPriority` | B33 bits 2–3 | Turn signal priority. 0 = off, 1 = mode 1, 2 = mode 2 |
| `dynamicBrakeLight` | B33 bits 6–7 | 0 = off, 1 = light braking, 2 = hard braking |
| `frontLeftBuckle` | B34 bit 1 | Driver seat-belt chime. 1 = off (admin + lab only) |
| `frontRightBuckle` | B34 bit 2 | Passenger seat-belt chime (admin + lab only) |
| `rearBuckle` | B34 bit 3 | Rear seat-belt chime (admin + lab only) |
| `gentryHorn` | B34 bits 4–5 | Soft horn at low speed. 0 = off, 1/2/3 = below 10/20/30 |
| `gentryHornCount` | B34 bits 6–7 | Soft horn count, value + 1 (sub of `gentryHorn`) |
| `airAutoArid` | B59 bits 6–7 | A/C auto dry, 76-byte layout only (lab) |

Unmapped bits in B24–B34: B32 bit 4, B33 bits 4–5 and B34 bit 0. The app clears B32 bit 4 and B33 bits 4–5 on every save. It keeps B34 bit 0 (`B34 &= 1`). Byte 35 is not touched.

### How the app writes settings

1. Copy the last status payload.
2. Set bytes 18–23 to 0.
3. Set bytes 24–33 to 0. Keep only B34 bit 0. In the 76-byte layout, set bytes 59–74 to 0.
4. Rebuild every field from the UI state.
5. Send the whole payload as `A3`.
6. The module replies `A3` with the new status. The app compares it with what it sent (bytes 18–23 masked).
   If it differs, the app sends `A3` again, up to 4 more times.

Vendor quirk: when a raw value has no entry in a menu, the app shows entry 0, and the next save writes entry 0's value.
For `beep` that is 0 %. A clean reimplementation must keep unknown raw values.

The `tsl7: true` mark on some vendor menu entries is not used by any page template. It does not hide or show anything.

## Command table

| Type | Dir | Payload | Meaning | Risk |
|---|---|---|---|---|
| `A0` (160) | → | none | Read status | Read-only |
| `A0` | ← | status | Status payload | |
| `A1` (161) | → | `00`/`01` | No-nag function off/on (main switch on the status page) | Write |
| `A2` (162) | ↔ | button id; 6 = release | Status-page button, sent on press and on release. Reply echoes the id. Function not checked | Car action |
| `A3` (163) | ↔ | full status payload | Write settings, reply = new status | Write |
| `A4` (164) | → | UID14 | Restore factory defaults. Reply `A4` | Destructive |
| `A5` (165) | → | UID14 | Restart module. Reply `A5` | Low |
| `A6` (166) | → | `00`/`01` | AP auto state | Write |
| `A7` (167) | → | 1 byte | Car control (see below). Reply `A7 01 00/01` for seat memory save | Car action |
| `A8` (168) | ↔ | `FF` request / 4 ASCII / `00`,`01` result | BLE password | |
| `A9` (169) | → | 18 bytes of status + old key (4) + new key (4) | Change BLE password. Reply `A9 00` wrong old key, `01` OK, `02` bad length | Write |
| `AB` (171) | ↔ | `02` read / data write | Shortcut-button table (page `btn`) | Write |
| `AD` (173) | → | UID14 | Server-ordered reset/blacklist path | **Never send** |
| `AE` (174) | → | UID14 | Sent when the server says the module is blacklisted | **Never send** |
| `AF` (175) | → | 2-byte auth code from the server | Activation | **Never send** |
| `B0` (176) | ↔ | `01` start / `00` stop | Live gauge stream | Read-only |
| `B9` (185) | ↔ | | RGB ambient light (other device type) | |
| `BA` (186) | ↔ | | BLE button table (page `blebtn`) | Write |
| `BB` (187) | → | button id | Send a shortcut command now | Car action |
| `BC`/`BD` (188/189) | ← | | "Operation OK / failed" | |
| `C0` (192) | ↔ | | Debug page | Unknown |
| `C1` (193) | ↔ | none / 4-byte LE value | Vehicle type query, reply shows a 32-bit value | Read-only |
| `C2` (194) | ← | | Types 12, 13 only | |
| `D0`–`D2` (208–210) | ↔ | | Battery info page | Read-only (not checked) |
| `F0` (240) | ↔ | | BLE host page | |
| `55`,`53`,`57`,`45`,`52` | ↔ | | Bootloader OTA. See the README | Flash |

`A7` car control values used by the status page: 16 = release (side control), 47/49/51 = front motor / ESP / rear motor off (switch value = 46/48/50 + on), 52–71 = seat memory recall/save (driver and passenger, memory 1–3, "queen" mode, camp mode), 255 = service mode.
`A7` 47, 49, 51 and 255 can disable traction systems or enter Tesla service mode. A reimplementation must hard-gate them.

## Runtime V1.0.00 findings (disassembly of `public/runtime.bin`)

Base address 0x8000. Addresses below are in that space. Not run on hardware, except the A0 capture.

**BLE password gate.**
- Each BLE link has an "authenticated" flag. It starts at 0.
- A0 works without the password, but the reply then has bytes 18–39 and 59–74 set to 0. Bytes 0–17 and the VIN block (40–58) are always filled (A0 builder at 0x12F6C).
- Owner capture, 2026-11-13, no password sent: 76 bytes, `00 12 10 01` + ID, VIN present, settings all 0. This matches the gate.
- A8 (handler at 0x13D02) needs exactly 4 bytes. Each byte must match the stored password (config offset 12, the same bytes as status 36–39) **or** the byte at the same position of a fixed vendor key in the firmware. The fixed key opens every module that runs this runtime. Its value is left out of this public note on purpose. On a match the link is authenticated and the module sends the status. Otherwise it replies `A8 00`.
- Gated commands on a link without the password get the reply `A8 FF`. AD (173), AE (174) and A8 are handled before the gate.

**A3 write (handler at 0x13EA6).** The module rejects the write unless:
- the payload is exactly 76 bytes,
- bytes 4–17 equal its UID14,
- bytes 36–39 are printable ASCII (0x20–0x7E).
So a payload copied from a blank (no-password) A0 reply is rejected. `writeBlocker()` in the codec checks the length and bytes 36–39.
- On success the module copies bytes 24–39 into config bytes 0–15 (this includes the password in 36–39) and bytes 59–74 into config bytes 96–111. It ignores bytes 18–23 and 40–58. It saves the config to flash, then sends a fresh status as an **A0** frame (not A3).
- Side effects on a change: B27 bit 4 (LED) and B24 bits 0–2 (`autoSportMode`) each call a handler at once.
- On a rejected A3 the module calls a function with the link and 0 (at 0x13B9E). It may clear the password flag. Not checked.

Owner capture with the password (2026-11-13): settings bytes 24–34 = `00 00 03 11 11 00 00 00 01 01 00`, bytes 36–39 = the stored password (printable ASCII). Decoded: `time` = 1, `rand` = 1, `lr` = 0, `automdr` = 1, `jg` = 1, `jj` = 1, `beep` = 3 (15 %), LED off, all vehicle functions off. This matches the vendor layout.
Owner test, 2026-11-13: an A3 write from `public/app.html` (beep volume) worked on the module, and the echo matched.

**Status bytes the runtime builds (authenticated link).**

| Offset | Source |
|---|---|
| 0 | Always 0. So the device type is not in the reply. The vendor app gets it from its server |
| 1, 2 | Version bytes |
| 3 | Bit 0 = 1. Bits 1–3 = three status flags. Bits 4+ = a state byte |
| 4–17 | UID14 |
| 18 | 8 status flags (bit 3 and bit 4 from the same source) |
| 19 | 7 status flags. Bit 7 = 1 only when CAN1 is inactive and `mianSwitch` = 0 |
| 20–21 | A 16-bit value |
| 22 | A value, 6 bits |
| 23 | Bits 0–2 = CAN1–CAN3 state |
| 24–39 | Copy of config bytes 0–15 (settings and password) |
| 40–58 | `01` + VIN (17) + 1 byte |
| 59–74 | Copy of config bytes 96–111 |

The meaning of the flags in bytes 3, 18 and 19 is not traced yet. The vendor app reads byte 19 bit 0 as "no-nag active".

## Server-driven paths (vendor app only)

The vendor app posts to `https://www.iffrc.com/ffkj/user/ble.php` with the module ID and VIN on every status read (`fun=getinfo`).
The server reply sets `hw_ver`, the device name, the latest firmware versions and a `state`:
- `state = 1`: the app sends `AE` + UID14 (blacklist path).
- `state = 2`: the app asks the server for `fun=reset`, then sends `AD` + UID14.
- Activation (`fun=auth`) returns a 16-bit code that the app sends as `AF`.
- OTA (`fun=update`) returns the image. See the README for the filler-image failure.

A clean reimplementation makes no network calls and never sends `AD`, `AE` or `AF`.
