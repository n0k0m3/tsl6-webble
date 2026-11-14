# TSL6 Web App

A Web Bluetooth app for the TSL6 (Feifan Commander 6th gen) autopilot module. It replaces the vendor WeChat Mini App, makes no network calls, and can flash or recover the module firmware.

**Live app:** https://tsl6-app.surge.sh/
(The old recovery address, https://tsl6-recovery.surge.sh/, redirects to the **Flash firmware** tab.)

> Use at your own risk. This project is not affiliated with the module maker, its resellers, or Tesla. Work only while the car is parked.

## What the app does

| Tab | Function |
|---|---|
| **App** | Connect, BLE password, status, settings editor. A settings write sends one `A3` frame and checks the module's reply |
| **Flash firmware** | Restarts the module into boot mode and flashes a runtime in one step. Also flashes a module that is already stuck in boot mode (`TSL6-BOOT`) |

The app never sends the vendor server commands (`AD`, `AE`, `AF`), factory reset or car controls.
Protocol notes: [docs/miniapp-protocol.md](docs/miniapp-protocol.md).

## Browsers

- Android or desktop: Chrome or Edge.
- iPhone: the Bluefy browser (App Store: "Bluefy – Web BLE Browser"). Safari and Firefox have no Web Bluetooth.

Before you start:
1. Keep the car awake (climate or Camp mode on).
2. Turn off Bluetooth on any phone that has the vendor Mini App. The module accepts one connection at a time.

## Settings (App tab)

1. Tap **Connect** and pick `TSL6`.
2. Type the BLE password (default `1234`) and tap **Send password**. The module sends blank settings until it accepts the password.
3. Tick **Enable writes**, change settings, tap **Review changes**, then **Write to module**.

The editor changes only the fields you edit. It keeps every other bit as the module reported it.

## Firmware images (Flash tab)

| Image | How to load | Notes |
|---|---|---|
| **Secured build** | **Load secured build** | The June 2026 runtime with the vendor backdoor removed. Use this one |
| Original June 2026 dump | Passphrase, then **Load original** | The stock runtime. It **has a backdoor**: a fixed vendor password that opens every module over Bluetooth |
| Other image | File picker | Any image that passes the checks below |

The page checks every image:
- The page indices are correct.
- The image is not filler (no byte value fills more than 50%).
- The first instruction is a RISC-V jump.

## Flash a working module

1. Connect to `TSL6` and read the status (App tab).
2. Open the **Flash firmware** tab. Tap **Load secured build**. It must show **Image OK**.
3. Tick the confirm box. Tap **Enter boot mode and flash**.

The page then:
1. Sends `55 01` + UID14. The runtime restarts into the bootloader.
2. Reconnects by itself. If it cannot, tap **Connect** at once and pick `TSL6-BOOT`.
3. Sends `55` and `53` at once, then the 72 pages, then `45`.

The bootloader goes back to the runtime about 10 s after this restart unless it receives a valid `53`. If you miss the window, nothing changes. Start again.

## Recover a module stuck in `TSL6-BOOT`

After a failed OTA, the module advertises as `TSL6-BOOT`. The vendor Mini App flashes it to 100%, the module reboots, the app reports "init mode", and the loop starts again.

One known cause: for some module IDs, the vendor update server (`iffrc.com/ffkj/user/ble.php`, `fun=update`) replies `success: true` but sends 10 pages of the byte `0x31` ("1111…") instead of firmware. The bootloader writes this filler to the app slot and jumps to it. The app crashes, and the module returns to the bootloader.

To recover:
1. Open https://tsl6-app.surge.sh/#flash.
2. Tap **Connect** and pick `TSL6-BOOT`. The page reads the status and fills in the module ID.
3. Tap **Load secured build**. It must show **Image OK**.
4. Tick the confirm box. Tap **Flash runtime** (under "Module already in boot mode").
5. Unplug the module for 10 s, then plug it in. It must advertise as `TSL6`, not `TSL6-BOOT`.

**Do not run an update from the vendor Mini App.** The server can send the filler image again.

## Bootloader update commands

| Command | Payload | Bootloader action |
|---|---|---|
| `0x55` prepare | `01` + UID14 | Checks the UID |
| `0x53` start | `01` + UID14 | Accepts target `01` (runtime) only. Sets the boot flag to update mode |
| `0x57` page | one 1026-byte page | Erases, writes, and reads back 1 KiB at `0x08008000 + index × 0x400`. No reply = the read-back failed |
| `0x45` finish | `01` + UID14 | Drops BLE after 200 ms. Jumps to the app after 400 ms |

Frame format: `55 7F TYPE LEN_H LEN_L PAYLOAD CHK`, where `CHK = (TYPE + LEN_H + LEN_L + sum(PAYLOAD)) & 0xFF`.

For the bootloader, `UID14 = module_id[4:12] + module_id[0:6]`, where the module ID is the 12-byte field in the boot-mode status. Runtime commands use status bytes 4–17 as sent.

Why flashing is low-risk:
- The bootloader write handler accepts only addresses `0x08008000`–`0x0801FF00` (the app slot). It cannot overwrite itself over BLE.
- Settings, BLE pairings, and the activation code are in `0x08077800`–`0x08077FFF`. A flash does not touch them.
- After a `53`, a failed flash leaves the module in the bootloader. You can try again.

## Firmware image source

`public/runtime.bin` is the runtime image from [LQCross/TSL6-Firmware](https://github.com/LQCross/TSL6-Firmware). It was downloaded from the vendor server in June 2026. The app reported it as runtime V1.0.00 with boot V1.2.00.

- Transport format: 72 pages × 1026 bytes (2-byte big-endian page index + 1024 bytes of code).
- SHA-256: `b1b2a3aa5e71d88336719bccb5da822faffc05acf50b5b482e570f1981dabbd5`.
- Secured build SHA-256: `7008bd0d6802de2daa9fb7743f3cc460f21dbaa35c799c94c55082c6d93093af`. It is served by the live site only, not kept in this repo.

## Python version

`tools/tsl6_ble_flash.py` does the boot-mode flash from a laptop. It needs `pip install bleak`. It is not yet tested on hardware.

```sh
python3 tools/tsl6_ble_flash.py scan
python3 tools/tsl6_ble_flash.py check public/runtime.bin
python3 tools/tsl6_ble_flash.py status <ADDRESS>
python3 tools/tsl6_ble_flash.py flash <ADDRESS> public/runtime.bin --id <24-HEX-MODULE-ID> --yes
```

## Tests

`test/vendor-diff.mjs` compares the settings codec with the vendor Mini App settings code. The vendor code is not in this repo. Pass the path to the unpacked `pages/set/set.js`:

```sh
node test/vendor-diff.mjs <path>/pages/set/set.js
```

## Deploy

```sh
# App. Put runtime-nokey.bin (the secured build) next to index.html first.
surge public tsl6-app.surge.sh
# Redirect for the old recovery address
surge redirect tsl6-recovery.surge.sh
```

## Notes for browsers

- Bluefy does not give characteristic `properties`. The page then uses `FFF1` for both receive and send.
- The page cannot read the BLE MTU. Bytes per write default to 180 on Apple and 240 elsewhere, and drop to 20 by themselves if large writes fail.
- iOS rejects self-signed certificates without a bypass. Use a trusted HTTPS host.
