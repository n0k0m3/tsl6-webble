# TSL6 Mini App BLE protocol (runtime)

Source: static analysis of the vendor WeChat Mini App "TSL电子模块" (`__APP__.wxapkg`, PC WeChat cache, 2026-11-13).
Nothing in this file is tested on hardware yet, except where a line says so.
The unpacked vendor code is not in this repo. It stays local in `~/.cache/tsl6-miniapp/`.

The app serves many device types (`hw_ver` 3–20). This note covers the parts that the TSL6 uses.
The TSL6 is device type `hw_ver` 6 or 8. The vendor server assigns the type.
The app treats both types the same in every page that this note covers.

## Evidence levels

| Level | What |
|---|---|
| Tested on the car with our tools | `A0` (with and without the password), `A8`, `A3` settings write, the bootloader flasher |
| Runtime disassembly (`public/runtime.bin`), not run | Password gate, `A3` checks, `AB`, `BA`, `BB` handlers, the list of handled types |
| Seen in the vendor app on the owner's car (screenshots), not sent by our tools | `B9` tables on both tabs, `D0` pack values |
| Vendor app code only | Everything else, including the status bit meanings and the `B0`, `C0`, `C1`, `D1`, `D2`, `F0`, `A9` layouts |

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
| 3 | 1 | Bit 0: 1 = runtime is running, 0 = module is in update (boot) mode. The app reads the whole byte as `esp` for types 3–19. Bits 1–7: see "Status bits" |
| 4 | 12 | Module ID (chip UID). The app shows it as 24 hex characters |
| 12 | 6 | The app shows bytes 12–17, reversed, as the "MAC" (overlaps the ID) |
| 4 | 14 | `UID14` for A3, A4, A5, AD, AE: payload bytes 4–17. Runtime V1.0.00 fills these bytes and compares them on A3 (disassembly). The 12-byte "module ID" that the app shows is bytes 4–15. Bytes 16–17 repeat bytes 4–5 on the owner's module. The recovery page formula `id[4:12] + id[0:6]` is for the bootloader reply only (not checked how the two IDs relate) |
| 18 | 1 | `fxp` (types 3–19). Function states. See "Status bits" |
| 19 | 1 | `on`. Bit 0 = the "免打扰" (no-nag) function is active. See "Status bits" |
| 20 | 2 | Timer, little-endian, in ms (shown ÷ 1000). Time to the next scroll action |
| 22 | 1 | `dat0`. Vehicle make and the "P" flag. See "Status bits" |
| 23 | 1 | `dat1`. Types 6, 7, 8, 19: bit 0/1/2 = CAN1/CAN2/CAN3 connected |
| 24 | 11 | Settings bytes. See the bit map below |
| 36 | 4 | BLE password, ASCII (only if the payload is ≥ 40 bytes) |
| 40 | 1 + 17 | If byte 40 = 1: VIN in bytes 41–57 (layouts other than 178 bytes) |
| 46 | 17 | VIN, 178-byte layout. `FF` at byte 46 = no VIN |
| 59 | 16 | Extra settings block, 76-byte layout only (`airAutoArid` at byte 59 bits 6–7) |

Confirmed on hardware (boot mode only, 2026-11-12): the bootloader reply is `00 12 10 00` + ID12 + 2 bytes = 18 bytes.
Byte 3 bit 0 = 0, so the app reads it as update mode. This matches the table.

The app needs at least 18 bytes for the ID, at least 28 bytes before it writes settings, and at least 32 bytes to decode the TSL6 settings.

## Status bits (Status tab, types 6 and 8)

Source: vendor app code only. The Status tab shows these bits as switches. A tap sends the command in the last column.
"A7 x / y" = the value for off / on. The app sends no confirm and does not read the status again after a tap.
The switch shows the module state only when the next status frame arrives.

### Byte 3 (`esp`)

| Bit | zh | Meaning | Command off / on |
|---|---|---|---|
| 0 | | Runtime is running (not shown) | |
| 1 | 关闭前电机 | Front motor off | `A7` 46 / **47** |
| 2 | 关闭ESP(漂移) | ESP off (drift) | `A7` 48 / **49** |
| 3 | 关闭后电机 | Rear motor off | `A7` 50 / **51** |
| 4–7 | | Tesla model. See "Vehicle type" | |

The runtime clears bytes 18–39 before the password, but it fills byte 3. So bits 1–7 can show without the password.
The owner's no-password capture had byte 3 = `01` (not checked if the bits are live then).

### Byte 18 (`fxp`)

| Bit | zh | Meaning | Command off / on |
|---|---|---|---|
| 0 | AP恢复状态 | AP resume | `A6` 00 / 01 |
| 1 | 电池预热 | Battery preheat | `A7` 4 / 5 |
| 2 | 充电盖板 | Charge port door | `A7` 6 / 7 |
| 3 | 主驾座椅按摩 | Driver seat massage | `A7` 18 / 19 |
| 4 | 副驾座椅按摩 | Passenger seat massage | `A7` 20 / 21 |
| 5 | | Not used by the app | |
| 6 | 脉冲喇叭 | Pulse horn | `A7` 40 / 41 |
| 7 | 远光爆闪 | High-beam strobe | `A7` 38 / 39 |

### Byte 19 (`on`)

| Bit | zh | Meaning | Command off / on |
|---|---|---|---|
| 0 | AP辅助状态 | AP assist (no-nag) active. The app then shows the byte 20–21 countdown | `A1` 00 / 01 |
| 1 | 前雾灯爆闪 | Front fog strobe | `A7` 30 / 31 |
| 2 | 前雾灯领航 | Front fog guide light | `A7` 32 / 33 |
| 3 | 后雾灯爆闪 | Rear fog strobe | `A7` 34 / 35 |
| 4 | 后雾灯领航 | Rear fog guide light | `A7` 36 / 37 |
| 5 | 车辆AP状态 | Car AP state. Effect on the car not known | `A7` 42 / 43 |
| 6 | 运动模式 | Sport mode | `A7` 44 / 45 |
| 7 | 线束未插好 | Harness not plugged in (warning text) | |

The runtime sets byte 19 bit 7 only when CAN1 is inactive and `mianSwitch` = 0 (disassembly). This matches the warning.

### Bytes 22 and 23

| Byte | Bits | Meaning |
|---|---|---|
| 22 (`dat0`) | 0–4 | Vehicle make. See "Vehicle type" |
| 22 | 5–6 | Not used by the app |
| 22 | 7 | Performance model. The app adds "P" to the name |
| 23 (`dat1`) | 0, 1, 2 | CAN1, CAN2, CAN3 connected. A long press on the 车辆类型 label sends `A0` and shows them |

The runtime builds byte 22 as a 6-bit value (disassembly). The app uses bits 0–4 and 7. The two views are not reconciled.

### Vehicle type

1. Read the make from byte 22 bits 0–4. Types 6, 8, 19 use this list:
   0 未识别 (not recognized), 1 特斯拉 (Tesla), 2 问界M5新款, 3 问界M7老款, 4 问界M7新款, 5 问界/享界/尊界/尚界, 6 问界M5-ADS4.0+, 7 其它 (other).
   Type 5 uses a different list.
2. If the make is 1, read the Tesla model from byte 3 bits 4–7:

| Value | zh | English |
|---|---|---|
| 0 | 未识别 | Not recognized |
| 1 | 老款3 | Old Model 3 |
| 2 | 老款Y | Old Model Y |
| 3 | 普通3 | Model 3 |
| 4 | 普通Y | Model Y |
| 5 | 焕新3 | Refreshed Model 3 |
| 6 | 焕新Y | Refreshed Model Y |
| 7 | 新S | New Model S |
| 8 | 新X | New Model X |
| 9 | 焕新YL | Refreshed Model Y L |
| 10 | 新款焕新3 | Newer refreshed Model 3 |
| 11 | 其它 | Other |

3. If byte 22 bit 7 = 1, add "P".

The app shows an empty name for a make outside the list. A clean decoder keeps the raw value.

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
6. The module replies with the new status. The app accepts an `A0`, `A1` or `A3` frame. Runtime V1.0.00 sends it as `A0`.
   The app compares it with what it sent (bytes 18–23 masked).
   If it differs, the app sends `A3` again, up to 4 more times.

Vendor quirk: when a raw value has no entry in a menu, the app shows entry 0, and the next save writes entry 0's value.
For `beep` that is 0 %. A clean reimplementation must keep unknown raw values.

The `tsl7: true` mark on some vendor menu entries is used for `hw_ver` 7 only.
On type 7 the settings list shows only the rows with `tsl7: true`. The mark has no effect on types 6 and 8.

## Command table

| Type | Dir | Payload | Meaning | Risk |
|---|---|---|---|---|
| `A0` (160) | → | none | Read status | Read-only |
| `A0` | ← | status | Status payload | |
| `A1` (161) | → | `00`/`01` | No-nag function off/on (main switch on the status page, byte 19 bit 0) | Write |
| `A2` (162) | ↔ | 1 byte: 1 up, 2 right, 3 down, 4 left, 5 OK; `06` = release | Simulated scroll wheel (模拟滚轮). Sent on press, `06` on release. Reply echoes the id | Car action |
| `A3` (163) | ↔ | full status payload | Write settings. Reply = new status (V1.0.00: as an `A0` frame) | Write |
| `A4` (164) | ↔ | UID14 | Restore factory defaults. Reply `A4`. See "A4 and A5" | Destructive |
| `A5` (165) | ↔ | UID14 | Restart module. Reply `A5`. See "A4 and A5" | Low |
| `A6` (166) | → | `00`/`01` | AP resume off/on (status page switch, byte 18 bit 0). The app ignores the reply | Write |
| `A7` (167) | → | 1 byte | Car control (see "A7 values"). Reply `A7 01 00` / `A7 01 01` = seat memory save failed / OK | Car action |
| `A8` (168) | ↔ | `FF` request / 4 ASCII / `00`,`01` result | BLE password | |
| `A9` (169) | ↔ | 26 bytes: status bytes 0–17 + old key (4) + new key (4) | Change BLE password. Reply `A9 00` wrong old key, `01` OK, `02` bad length. See "A9" | Write |
| `AB` (171) | ↔ | `02` read / 256-byte table write | Shortcut table. See "AB" | Write |
| `AD` (173) | → | UID14 | Server-ordered reset/blacklist path | **Never send** |
| `AE` (174) | → | UID14 | Sent when the server says the module is blacklisted | **Never send** |
| `AF` (175) | → | 2-byte auth code from the server | Activation | **Never send** |
| `B0` (176) | ↔ | `01` start and keep-alive / `00` stop | Live gauge stream. See "B0" | Read-only |
| `B9` (185) | ↔ | op + tab (+ table) | Factory ambient light rules (page `rgb`, 原厂氛围灯设置). The TSL6 uses it. See "B9" | Write; "try" is a car action (lights) |
| `BA` (186) | ↔ | `01` pair / `02` read / 256-byte table write | BLE button table (page `blebtn`). See "BA" | Write |
| `BB` (187) | ↔ | 1 byte: action id | Run one shortcut action now. Runtime reply `BB 01` | Car action |
| `BC` (188) | ← | any | The app shows "操作成功" (done) | |
| `BD` (189) | ← | `00` / `01` | Operation failed / OK. The runtime sends `BD 00` for an `AB` or `BA` table write without `5A` in byte 255 | |
| `C0` (192) | ↔ | mode / filter / CAN frame | CAN debug page. See "C0" | **CAN TX** |
| `C1` (193) | ↔ | none / 4 bytes | Long press on the 模拟滚轮 label sends `C1`. The app shows the reply as a 32-bit little-endian hex value. Meaning not known. It is not a vehicle type query | Read-only (not checked) |
| `C2` (194) | ← | | Types 12, 13 only | |
| `D0` (208) | ↔ | `00`–`04` | Battery info. All requests use `D0`. See "D0–D2" | Read-only (not checked) |
| `D1`, `D2` (209, 210) | ← | | Battery info replies (cells, DC-DC) | |
| `F0` (240) | ↔ | UID14 + sub-command | BLE host (module as BLE central). See "F0" | Write |
| `55`,`53`,`57`,`45`,`52` | ↔ | | Bootloader OTA. See the README | Flash |

### A7 values

Source: vendor app code (Status tab and gauge page). The runtime handler is not traced.

| Value | Meaning | Vendor confirm |
|---|---|---|
| 0, 1, 2, 3 | Open door: front left, front right, rear left, rear right | Status tab: yes. Gauge: no |
| 4 / 5 | Battery preheat off / on | No |
| 6 / 7 | Charge port door off / on | No |
| 8 / 9 | Frunk / trunk | Status tab: yes. Gauge: no |
| 10 | Not known (icon looks like a glovebox) | No |
| 11 | Fold / unfold mirrors | No |
| 12, 13, 14, 15 | Passenger seat move (hold; sent on press) | No |
| 16 | Seat move release (sent on finger up) | No |
| 17 | Power off the car (下电). Factory mode only | Yes |
| 18 / 19, 20 / 21 | Driver / passenger seat massage off / on | No |
| 22 / 23 | Lock / unlock | Yes |
| 26, 27, 28, 29 | Driver seat move (hold; sent on press) | No |
| 30–45 | Off / on pairs: see "Status bits" (fog, horn, strobe, car AP state, sport mode) | No |
| 46 / 47, 48 / 49, 50 / 51 | Front motor, ESP, rear motor: normal / **off** | No |
| 52–71 | Seat memory. Driver: 52, 54, 56 = memory 1, 2, 3; 58 = 女王模式 ("queen" mode); 60 = 露营模式 (camp mode). Passenger: the same + 10. Even value = recall, value + 1 = save | Yes |
| 255 | Tesla service mode. The app warns that the car must be in P | Yes (disclaimer) |

The app never sends 24, 25 or 72–254.
The seat move buttons send release (16) only on `touchend`. A lost release frame may leave the seat moving.
`A7` 17, 47, 49, 51 and 255 can power off the car, disable traction systems or enter Tesla service mode. A reimplementation must hard-gate them.
The gauge page sends 0–5, 8 and 9 with no confirm. Its "speed > 0" check fails open when the gear is unknown. Gate these on a decoded speed of 0 and gear P.

## Command details

All offsets are into the frame payload. "LE" = little-endian. "BE" = big-endian.
UID14 = status payload bytes 4–17.

### A4 and A5

Source: vendor app code. Not sent by our tools yet.

- `A4` + UID14: restore factory defaults. The app asks "确定要将所有参数恢复默认设置吗？" (restore all settings?) first.
  The module replies `A4`. The app does not read the status again for types 6 and 8.
  Not known: does `A4` also reset the BLE password to `1234`?
- `A5` + UID14: restart the module. The module replies `A5`, then the BLE link drops.
  The app sends `A5` after a `BLEPWR` change, because the new BLE power needs a restart.
- The vendor app sends 14 zero bytes as the UID when the status is shorter than 18 bytes. A clean app must refuse instead.

### A9 (change BLE password)

Source: vendor app code. The runtime handler is not disassembled.

1. Payload: 26 bytes = last status bytes 0–17, then the old password (4 bytes), then the new password (4 bytes).
2. The app checks only that both passwords have 4 characters, that they differ, and that the new one equals the confirm field.
3. The module replies `A9 00` (wrong old password), `A9 01` (changed) or `A9 02` (wrong length).
4. The vendor app does not update its stored key after a change. The next connect then fails once and asks again.

Use only printable ASCII (0x20–0x7E) in a new password. Reason: the runtime rejects an `A3` write whose bytes 36–39 are not printable.

### AB (shortcut table, page `btn`, 快捷指令)

Source: runtime disassembly (handler 0x13FCA) and vendor app code.

| Send | Module reply |
|---|---|
| `AB 02` | `AB` + the 256-byte table |
| `AB` + 256 bytes, byte 255 = `5A` | Saves the table to flash. Replies `AB` + the table (echo) |
| `AB` + 256 bytes, byte 255 ≠ `5A` | `BD 00` |
| Any other length, or another 1-byte value | No reply |

Table layout:

| Bytes | Meaning |
|---|---|
| 2n, n = 0–126 | Trigger id. 0 = empty slot |
| 2n + 1 | Action id. 0 = no action |
| 254 | Not used. Keep it from the last read |
| 255 | `5A`. Required |

- When a trigger fires, the runtime runs the action of **every** slot with that trigger id. Then it scans the `B9` table the same way.
- The runtime has code for 211 of the action ids 1–253. Ids 0, 254 and 255 do nothing.
- The factory table is all 0, byte 255 = `5A`, with 13 pairs (trigger → action, hex):
  `02→14, 43→0B, 44→0C, 45→0D, 0A→2C, 0C→2B, 0E→46, 10→05, 11→07, 1E→50, 1F→5F, 20→1E, 21→2A`.
- The vendor app writes the list into slots 0, 1, 2 … in order and sets the other slots to 0. It keeps bytes 254–255.
- The vendor app compares the echo with what it sent and sends the table again, up to 4 more times.
- The trigger and action names come from the vendor server. They are not in the app package. Without them, show the raw ids.

### BA (BLE button table, page `blebtn`, 蓝牙按钮)

Source: runtime disassembly (handler 0x1468A) and vendor app code.

| Send | Module reply |
|---|---|
| `BA 01` | Starts pairing mode. Replies `BA 01` (echo) |
| `BA 02` | Replies `BA` + the 256-byte table. Probably also stops pairing (not checked) |
| `BA` + 256 bytes, byte 255 = `5A` | Saves the table to flash. Replies `BA` + the table (echo) |
| `BA` + 256 bytes, byte 255 ≠ `5A` | `BD 00` |

Table layout: 42 entries × 6 bytes (bytes 0–251).

| Bytes | Meaning |
|---|---|
| 6n + 0, n = 0–41 | Single-click action id |
| 6n + 1 | Double-click action id |
| 6n + 2 … 6n + 5 | Button id, 4 bytes, in the same order as the press messages. All 0 = empty entry |
| 252–254 | Not used. Keep them from the last read |
| 255 | `5A`. Required |

Press messages from the module (type `BA`):

| Length | When | Bytes |
|---|---|---|
| 6 | A button is pressed in pairing mode | 0–3 button id, 4–5 battery. Byte 5 bit 7 is a flag (meaning not known; the app clears it) |
| 7 | A known button is pressed | 0–3 button id, 4–5 battery, 6 click type (0 single, 1 double) |

- Battery: u16 LE in mV. The app maps 2200–3200 mV to 0–100 %.
- After a 6-byte message the vendor app adds the button to the table and writes the table. It does no duplicate check.
- There is no long-press action. The runtime runs byte 0 (single click) or byte 1 (double click) of every entry with the same id.
- The BLE link to the button itself is set up with `F0`.

### BB (run an action now)

- Send `BB` + 1 byte action id. The runtime runs the action at once and replies `BB 01` (disassembly, handler 0x14024).
- The vendor app sends it from the "尝试" (try) links on the `btn` and `blebtn` pages.
- Vendor bug: the try button in the trigger picker sends a **trigger** id as an action id. Do not copy that.
- An action can be a car action (door, mirror, seat, light). Ask before each send. Allow only known action ids.

### B9 (factory ambient light rules, page `rgb`)

Source: vendor app code. The vendor app shows live `B9` data from the owner's car on both tabs (screenshots).
The page is shown for types 6, 8 and 19 when `mianSwitch` = 0.

Payload byte 0 = operation, byte 1 = tab (0 = 分区联动, zone link; 1 = 整车效果, whole-car effect).

| Send | Meaning |
|---|---|
| `00 tab` | Read the table of the tab |
| `01 tab` + 256 bytes | Write the table of the tab |
| `02 tab index` | Try rule `index` (0–35) now. Lights only |
| `03 tab` | Delete all rules of the tab |

| Reply | Meaning |
|---|---|
| 256 bytes | The table. The reply does not name the tab |
| 1 byte `FF` | No ambient light module ("请先安装氛围灯模块") |

Table: 36 slots × 7 bytes (bytes 0–251). Bytes 252–255 are not used by the app. Keep them from the last read.
Slot at offset o = 7 × slot:

| Bytes | Field | Bits |
|---|---|---|
| o+0, o+1 (u16 LE, word A) | `cmd` | 0–8: trigger id (the same ids as the `AB` triggers) |
| | `run` | 9: rule on |
| | `addr` | 10–15: tab 0 = lamp (1 left, 2 right, 3 both). Tab 1 = effect (0 default or follow car, 1 custom, 2 whole-car gradient) |
| o+2, o+3, o+4 | colour | R, G, B |
| o+5, o+6 (u16 LE, word B) | `bright` | 0–4: 0 = off (tab 0) or follow car (tab 1); 1–10 = car brightness + 10 … 100 %; 11–20 = fixed 10 … 100 % |
| | `breathe` | 5–9: fade speed. 0 off, 1 fast, 2 medium, 3 slow |
| | `blink` | 10–14: blink speed. 0 off, 1 fast … 15 medium … 31 slow |
| | `effect` | 15: tab 0 only. 0 default effect, 1 custom |

- Slot 0 is a fixed rule: 转向灯联动 (turn signal link) on tab 0, 默认效果 (default effect) on tab 1. Other slots with `cmd` = 0 are empty.
- The vendor app writes the rules into slots 0, 1, 2 … in order and fills the rest with 0.
- Vendor bug: after a wrong echo it sends `B9` + the bare 256-byte table, without `01 tab`. Do not copy that.
- The runtime handles type 185 (dispatcher list). Not checked: the gate and the echo.

### B0 (gauge stream, page `gauge`)

Source: vendor app code. Not seen on the car.

- Send `B0 01` when the gauge opens, then once per second as a keep-alive. Send `B0 00` when the gauge closes.
- The module streams `B0` frames. The app does not reply.
- The app reads bytes 0–15 of every frame, and bytes 15–32 only when the frame has 33 bytes or more.

`w0` = bytes 0–3 as a u32 LE, `w1` = bytes 4–7, `w3` = bytes 12–15, `w23` = bytes 23–26, `w28` = bytes 28–31.

| Field | Meaning |
|---|---|
| `w0` bits 0–8 | Speed, in the car display unit |
| `w0` bits 9–11 | Gear. 1 P, 2 R, 3 N, 4 D. 0 and 5–7 = no gear |
| `w0` bits 12–13 | Turn signal. Bit 0 left, bit 1 right |
| `w0` bits 14–15 | Autopilot. 0 off, 1 and 2 active, 3 grey (exact states not known) |
| `w0` bits 16–19 | Doors open. Bit 0 FL, bit 1 **RL**, bit 2 **FR**, bit 3 RR |
| `w0` bits 20–23 | Lights. Bit 0 high beam, 1 low beam, 2 position, 3 front fog (inferred) |
| `w0` bits 24–30 | Battery % |
| `w0` bit 31 | Rear fog (inferred) |
| `w1` bit 0 | 0 = keep the phone screen on |
| `w1` bit 1 / bit 5 | Frunk open / trunk open |
| `w1` bit 2 | Car screen in light mode |
| `w1` bit 3 | Sport (accent colour; probably Chill vs Sport) |
| `w1` bit 4 | Brake light |
| `w1` bits 6–31 | Odometer × 0.1 km |
| bytes 8–11 | Tire pressure × 0.025 bar. FL, FR, RL, RR. 0 or 255 = no value |
| `w3` bits 0–7 | Accelerator pedal, raw / 250 × 100 % |
| `w3` bits 8–18 | Rear motor power, 11-bit signed, / 2 kW |
| `w3` bits 19–29 | Front motor power, 11-bit signed, / 2 kW |
| bytes 15–17 (u24 LE) bits 6–19 | Altitude, 14-bit signed, m |
| byte 17 bits 4–5 | Battery heat state. 0 off, 1 and 2 = two "on" colours (meaning not known) |
| byte 17 bit 6 | Speed unit. 1 km/h, 0 mph |
| byte 17 bit 7 | Hands-on-wheel warning |
| bytes 18–22 | Four 10-bit values: brake temperature, raw − 40 °C. FL, FR, RL, RR. Raw 0 = no value |
| `w23` bits 0–9 / 10–20 / 21–31 | Blower × 5 RPM / evaporator power × 5 W / cabin temperature × 0.1 − 40 °C |
| byte 27 | Outside temperature × 0.5 − 40 °C |
| `w28` bits 0–11 / 12–21 / 22–30 | Cell voltage × 0.002 V / range in miles (app × 1.61 for km) / battery temperature × 0.5 − 40 °C |
| bytes 31–32 (u16 LE) bits 7–11 | Speed limit × 5, car unit |
| bytes 31–32 bits 12–13 / 14–15 | Blind spot left / right. 0 none, 1 yellow, 2 red |

The door bits (FL, RL, FR, RR) are in a different order from the `A7` door values (FL, FR, RL, RR).
The gauge page sends `A7` 0–3 (doors), 8 and 9 (frunk, trunk) and 4 / 5 (battery heat off / on) on a tap, with no confirm.

### C0 (CAN debug, page `debug`)

Source: vendor app code. Not sent by our tools. The vendor app hides the page behind a code from its server.

| Send | Meaning |
|---|---|
| `C0 02` | On page open, and the 暂停 (pause) button. Stop forwarding (exact meaning not known) |
| `C0 01` | Forward all received CAN frames |
| `C0 FF FF` + ids (each u16 LE) | Forward only these CAN ids |
| `C0 00` | On page close. Leave debug mode |
| `C0` + id (u16 **BE**) + 1–8 data bytes | **Transmit one raw CAN frame on a car bus** |

- Reply `C0`: CAN id (u16 BE), then the data bytes. There is no bus number and no DLC byte.
- **The send command transmits raw CAN.** The bus is not known. There is no rate limit in the app and no confirm.
  An injected frame can fault the car. Hard-gate it.
- An id of `FFFF` gives `C0 FF FF …`, the same start as a filter request. How the runtime tells them apart is not known.
  The app accepts ids up to `FFFF`. Allow only 11-bit ids (≤ `7FF`).

### D0–D2 (battery info, page `batteryInfo`)

Source: vendor app code. The vendor app shows live `D0` data from the owner's car (screenshot). No `D1` or `D2` reply was seen.

All requests use type `D0` with 1 byte:

| Send | Meaning |
|---|---|
| `D0 01` | Start (page open) |
| `D0 02` / `03` / `04` | Poll the pack / cells / DC-DC. The app polls every 500 ms (cells: 1000 ms) |
| `D0 00` | Stop (page close) |

`D0` reply (pack):

| Offset | Field | Scale |
|---|---|---|
| 0 (u16 LE) | Pack voltage | × 0.01 V |
| 2 (i16 LE) | Pack current | × −0.1 A (sign meaning not checked) |
| 4 (u32 LE) | Total discharged | × 0.001 kWh |
| 8 (u32 LE) | Total charged | × 0.001 kWh |
| 12 (u16 LE) | Remaining energy | × 0.02 kWh |
| 14 (u16 LE) | Full-pack energy | × 0.02 kWh |
| 16 (u16 LE) | Reserved (buffer) energy | × 0.01 kWh |
| 18 (u24 LE) bits 0–11 / 12–23 | Highest / lowest cell | × 0.002 V |
| 21 (u64 LE) bits 0–9 | Factory capacity | × 0.1 kWh |
| bits 10–19 | Range | miles (app × 1.61 for km) |
| bits 20–21 | Heat state | 2 = heating |
| bits 22–30 | Battery temperature | × 0.5 − 40 °C |
| bits 31–37 | Car SOC | % |
| bits 38–63 | Odometer | × 0.1 km |

The app computes SOC = (remaining − reserved) / (full − reserved) × 100. It uses the car SOC when the remaining energy is 0.
The scales of the odometer, the temperature and the two lifetime counters gave values that do not look real in the screenshot. Do not trust them yet.

`D1` reply (cells): byte 0 = group g (cells 3g + 1 to 3g + 3). Byte 1 = not used. Bytes 2, 4, 6 = cell voltage, u16 LE × 0.0001 V.

`D2` reply (DC-DC): bytes 0–1 output voltage × 0.01 V, 2–3 input voltage × 0.1 V, 4–5 output current × 0.1 A, 6–7 not used.

Not known: does the module only listen on the bus for these values, or does it send diagnostic requests?

### F0 (BLE host, page `bleHost`, 蓝牙配对)

Source: vendor app code. The module acts as a BLE central. It pairs BLE buttons for the `BA` table.

Every request = UID14 + a body:

| Body | Meaning |
|---|---|
| `01` | Start scan (page open) |
| `02` | Stop scan (page close) |
| `04` | Read the paired list. The app polls every 1 s |
| `05` addrType MAC(6) name | Pair and connect. Name = the name bytes of the scan result, with the NUL padding (24 bytes) |
| `07` addrType MAC(6) | Delete a paired device |

Replies: byte 0 = sub-command, byte 1 = scan running (≠ 0), then the data.

| Sub | Data |
|---|---|
| `03` | Scan result: RSSI (i8), address type, MAC (6, wire order), name (24 bytes, UTF-8, NUL padded) |
| `04` | Paired list: count, then `count` records, then a 4-byte trailer whose last byte is `5A` |
| `06` | Status code: 0 connecting, 1 connected, 2 failed, 3 timeout, 4 deleted, 5 pairing limit, 6 connection limit |

Paired-list record (33 bytes): RSSI (i8; −128 = paired, not connected), battery %, address type, MAC (6; all 0 = empty), name (24 bytes, UTF-8).
The app shows the MAC with the 6 bytes reversed. Not checked: does the runtime check UID14 or the password on `F0`?

## Runtime V1.0.00 findings (disassembly of `public/runtime.bin`)

Base address 0x8000. Addresses below are in that space. Not run on hardware, except the A0 capture and the A3 test.

**BLE password gate.**
- Each BLE link has an "authenticated" flag. It starts at 0.
- A0 works without the password, but the reply then has bytes 18–39 and 59–74 set to 0. Bytes 0–17 and the VIN block (40–58) are always filled (A0 builder at 0x12F6C).
- Owner capture, 2026-11-13, no password sent: 76 bytes, `00 12 10 01` + ID, VIN present, settings all 0. This matches the gate.
- A8 (handler at 0x13D02) needs exactly 4 bytes. Each byte must match the stored password (config offset 12, the same bytes as status 36–39) **or** the byte at the same position of a fixed vendor key in the firmware. The fixed key opens every module that runs this runtime. Its value is left out of this public note on purpose. On a match the link is authenticated and the module sends the status. Otherwise it replies `A8 00`.
- Gated commands on a link without the password get the reply `A8 FF`. AD (173), AE (174) and A8 are handled before the gate.

**Handled types.** The V1.0.00 dispatcher has a handler for these types (decimal):
160–167, 169, 171, 173–176, 185–187, 192, 193, 208–210, 240. A8 (168) is handled before the gate, as above.

| Type | Handler in V1.0.00 | Gate |
|---|---|---|
| `A0`–`A7`, `A9` | yes | `A0` works without the password (blank reply). The others: not traced one by one |
| `AB`, `BA`, `BB` | yes (0x13FCA, 0x1468A, 0x14024) | Behind the password gate (reply `A8 FF` without it) |
| `AD`, `AE`, `AF`, `B0` | yes | `AD`, `AE` before the gate. `AF`, `B0`: not checked |
| `B9`, `C0`, `C1`, `D0`–`D2`, `F0` | yes | Not checked |
| `C2` | no | |

A handler in the list does not prove that the layouts in this note match the runtime. Only the `AB`, `BA` and `BB` handlers are traced.
Some types, `AB`, `BA` and `BB` among them, first call a check at 0x81A6. If it returns 0, the runtime runs the command 300 ms later. Not traced.

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

The runtime sources of the flags in bytes 3, 18 and 19 are not traced. The vendor app reads them as in "Status bits".

## Server-driven paths (vendor app only)

The vendor app posts to `https://www.iffrc.com/ffkj/user/ble.php` with the module ID and VIN on every status read (`fun=getinfo`).
The server reply sets `hw_ver`, the device name, the latest firmware versions and a `state`:
- `state = 1`: the app sends `AE` + UID14 (blacklist path).
- `state = 2`: the app asks the server for `fun=reset`, then sends `AD` + UID14.
- Activation (`fun=auth`) returns a 16-bit code that the app sends as `AF`.
- OTA (`fun=update`) returns the image. See the README for the filler-image failure.

A clean reimplementation makes no network calls and never sends `AD`, `AE` or `AF`.
