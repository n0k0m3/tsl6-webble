# TSL6 Web App

A Web Bluetooth app for the TSL6 (Feifan Commander 6th gen) autopilot module. It replaces the vendor WeChat Mini App, makes no network calls, and can flash or recover the module firmware.

**Live app:** https://tsl6-app.surge.sh/
(The old recovery address, https://tsl6-recovery.surge.sh/, redirects to `/#firmware`, the Firmware page. Old `#flash` and `flash.html` links also land there.)

> Use at your own risk. This project is not affiliated with the module maker, its resellers, or Tesla. Work only while the car is parked.

## What the app does

The app has the functions of the vendor Mini App, in its own layout. The labels are in English, with a switch to the original Chinese (中).

| Tab or page | Function |
|---|---|
| **Car** | Vehicle type, live switches (AP assist, AP resume, battery preheat, charge port, horn and light strobes, sport mode, seat massage), seat move and memory, doors, frunk, trunk, lock, simulated scroll wheel |
| **Settings** | Every settings row of the vendor app, with search. Each change writes one `A3` frame and checks the module's reply |
| Tools > **Shortcuts** | The trigger → action table (`AB`), with the vendor function names |
| Tools > **BLE buttons** | Pair BLE buttons and set click and double-click actions (`BA`) |
| Tools > **Ambient light** | Zone rules and whole-car effects (`B9`) |
| Tools > **Gauges** | Full-screen dashboard from the `B0` stream, with the vendor gauge menu |
| Tools > **Battery** | Pack, cell and DC-DC values (`D0`) |
| Tools > **Backup and restore** | Saves the settings, shortcuts and BLE buttons to a local JSON file, and writes them back. The vendor cloud backup is replaced by this file |
| Tools | Log and capture, change password, firmware flasher, restore defaults, BLE host pairing, CAN debug, Tesla service mode |
| **Device** | Connect through the browser's device chooser, BLE password, bytes per write. Module ID, MAC, VIN, versions, restart, flash firmware, preferences |
| Tools > **Firmware**, Device > **Flash firmware** (`#firmware`, `#flash`) | Restarts the module into boot mode and flashes a runtime in one step, on the app's own connection. Also flashes a module that is already stuck in boot mode (`TSL6-BOOT`). When the app connects to a module in boot mode, it opens this page by itself. Tested on the car (2026-11-14) |

Safety rules in the app:
- It never sends the vendor server commands `AD`, `AE` and `AF`.
- Rear motor off, front motor off, ESP off, Tesla service mode and raw CAN send are blocked until you turn on **Device > Allow driving-system controls**.
- Doors, frunk, trunk, lock, seat memory, restore defaults, restart and password change ask first.
- Seat and wheel buttons send the release frame when you lift your finger, also if the page loses focus.
- The first use of a command other than `A0`, `A8` and `A3` in a session shows a warning.
- Lab settings and service mode need a code from the vendor server in the Mini App. Here they need only a local confirm.

Car test on 2026-11-14 (BLE Link and Bluefy on iPhone): connect, password, status switches, CAN state, settings, shortcuts, BLE buttons, ambient light, backup and restore, battery, gauges and BLE host work. Seat move does nothing on the test car. It does not work in the vendor Mini App either.

The function names and help texts are a copy of the vendor server data from 2026-11-13 (`public/data/`), with English translations.
Protocol notes: [docs/miniapp-protocol.md](docs/miniapp-protocol.md).

## Browsers

- Android or desktop: Chrome or Edge.
- iPhone: the Bluefy browser (App Store: "Bluefy – Web BLE Browser"). Safari and Firefox have no Web Bluetooth.

Before you start:
1. Keep the car awake (climate or Camp mode on).
2. Turn off Bluetooth on any phone that has the vendor Mini App. The module accepts one connection at a time.

## Connect and change settings

1. Open the **Device** tab. Tap **Connect** and pick `TSL6`.
2. Type the BLE password (default `1234`). The app saves it in this browser and sends it on the next connection. The module sends blank settings until it accepts the password.
3. Open the **Settings** tab and change a row. The app writes the change at once and shows **Saved** when the module confirms it.

A settings write changes only the field you edit. It keeps every other bit as the module reported it, including values that no menu lists.

To test the app without a module, open it with `?mock`. A red **MOCK MODULE** label shows. The mock answers from the same notes as the codecs, so it proves nothing about the real module.

## BLE board

The app also controls a board with the `scrl-ble-board` firmware (BLE only, no Wi-Fi). The firmware runs on the M5Stack NanoH2 with the Unit Mini CAN, and on every hypery ESP32 board: ATOM Lite and Matrix, ESP32 DevKit, ESP32 + MCP2515, T-CAN485, T-Display, T-2CAN, T-2CAN FD and Waveshare S3-CAN. The board sends scroll ticks on Vehicle CAN, as the TSL6 does. Its firmware is in another repo. Inside the code the device type is still called "H2".

**Status: checked against a mock board only. The app never talked to a real board.**

Pick `SCRL-xxxx` in the Bluetooth list. The app then shows the board as one more device type: the same tabs, with only the rows that the board has.

| Tab | What shows for the board |
|---|---|
| Car | The AP assist switch (scroll ticks on or off), the live prompt state, and the board warnings |
| Settings | Scroll interval (on the hands-on prompt, or on a timer), tick gap, tick order, and the op mode |
| Tools | Board, Board firmware, Log, Restore defaults |
| Device | Device type ("BLE board: " and the board name; every board has the same rows), board type, chip, CAN controller, board ID, firmware version, restart |

What only the board has is on the **Board** page (Tools > Board):

- **Op mode.** Listen-Only: the board never sends. Active: it sends. A change to Active asks for a confirm.
- **Warnings**, for example: not Vehicle CAN, bus-off lock, a new firmware image that is not confirmed.
- **Live state and counters.**
- **Exact times** in milliseconds. A value that no Settings menu holds shows there as "Custom value".
- **Pairing**: change the passkey, forget bonds, factory reset.

Differences from the TSL6:

- **No BLE password.** The board uses Bluetooth pairing. At the first connection the phone asks for a 6-digit passkey: it is on the label that you put on the board. The app never asks for it.
- **The board accepts a new phone only in its pairing window:** 5 minutes after power-on, or 2 minutes after a press of its button.
- **Firmware update** is on its own page (Tools > Board firmware). Use `build/out/scrl-<build>.bin` of the firmware build. The page sends an image only when its chip and its board ID match the connected board, because the firmware refuses any other image. An image with another CAN controller for the same board (a T-2CAN can0 or can1 build) is allowed, with a warning to move the Vehicle CAN wires. After an update, confirm the new image within 10 minutes, or the board goes back to the old one.
- **The listen-only build** (`esp32-generic-twai-sniffer`) never sends. The Board page says so and locks Active.
- **Restore defaults** turns the scroll ticks off and puts the board in Listen-Only. The bonds and the passkey stay.

How it works: the link to the board (`public/app/scrl-link.js`) gives the pages a status in the TSL6 layout and takes the TSL6 commands that the board can do. It refuses every other command, and it refuses a settings write that changes a bit that the board does not have (`public/lib/scrl-tsl6.js`).

To test without a board, open the app with `?mock=h2`. Options: `&pair` (pairing delay), `&nopair` (pairing fails), `&lock` (bus-off lock), `&pending` (unconfirmed image), `&cut=N` (writes longer than N bytes are cut), `&lo` (scroll ticks off, Listen-Only), `&board=ID` (board type, for example `lilygo-t2can`), `&can=mcp2515` (its CAN controller), `&nofeat` (firmware 0.2.0: no ported TSL6 settings), `&noimax` (firmware 0.3.1 and older: Timer interval up to 10 s).

## Firmware images (flasher, step 1)

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

1. Open **Tools > Firmware** (or **Device > Flash firmware**). Tap **Connect** and pick `TSL6`. The page reads the status.
2. Tap **Load secured build**. It must show **Image OK**.
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
1. Open https://tsl6-app.surge.sh/#flash. (Or open the app and connect: a module in boot mode opens the Firmware page by itself.)
2. Tap **Connect** and pick `TSL6-BOOT`. The page reads the status and fills in the module ID.
3. Tap **Load secured build**. It must show **Image OK**.
4. Tick the confirm box. Tap **Flash runtime** (under "Module already in boot mode").
5. Unplug the module for 10 s, then plug it in. It must advertise as `TSL6`, not `TSL6-BOOT`.

**Do not run an update from the vendor Mini App.** The server can send the filler image again.

## Rescue a module with a safe-boot build

A runtime that sets boot flag mode 1 at start (a "safe-boot" test build) keeps the bootloader in `TSL6-BOOT` for about 10 s at every power-on, then starts the runtime. If that runtime does not work, flash another one in the 10 s:
1. On the Firmware page, load an image and tick the confirm box.
2. Tap **Arm flash for TSL6-BOOT** (under "Rescue"). It stays armed for 3 min. Tap it again to cancel.
3. Power-cycle the module. Tap **Connect** at once and pick `TSL6-BOOT`. The flash starts by itself.

A runtime that sets mode 0 (all normal builds) gives no such window.

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

Each codec in `public/lib/` has a differential test that runs the vendor Mini App code in `node:vm` and compares the bytes. The vendor code is not in this repo. Pass the path to the unpacked package (`<src>` = the folder that holds `app.js` and `pages/`):

```sh
node test/vendor-diff.mjs  <src>/pages/set/set.js        # settings (A3)
node test/status-vendor.mjs <src>/pages/index/index.js   # status tab, A1/A2/A4-A7/A9
node test/tables-vendor.mjs <src>                        # shortcuts (AB), BLE buttons (BA), backup
node test/rgb-vendor.mjs   <src>/pages/rgb/rgb.js        # ambient light (B9)
node test/live-vendor.mjs  <src>                         # battery (D0), CAN debug (C0), BLE host (F0)
node test/gauge-vendor.mjs <src>/pages/gauge/gauge.js <src>/pages/gaugeMenu/gaugeMenu.js   # gauge stream (B0)
```

The flash code (`public/lib/tsl6-flash.js`) has its own test. It needs no vendor code. It checks the image rules, UID14 and the 55/53/57/45 frame order on a fake link:

```sh
node test/flash.mjs
```

To test the Firmware page without a module, open the app with `?mock`. The mock has a bootloader: `55 01` restarts it into boot mode, and `?mock&boot` starts in boot mode.

The BLE board support has two tests:

```sh
node test/scrl.mjs     # board codec, adapter to the TSL6 pages, type filter. Needs nothing else
PLAYWRIGHT_CORE=<path>/playwright-core/index.mjs CHROME=<path of chrome> node test/h2-ui.mjs   # the app in headless Chrome
```

- `test/scrl.mjs` checks the app against `test/fixtures/scrl-protocol.json`. That file holds what the board firmware defines and does: its constants, its board list and board descriptor, the output of its status packers, and the answer of its settings reader to each write that the app can send. `node tools/scrl-fixture.mjs <firmware repo>` writes it. Run that again after each change of the board protocol, and look at `git diff`.
- `test/h2-ui.mjs` runs 18 scenarios. It serves `public/` on 127.0.0.1 itself. It skips without `playwright-core`. Three of the scenarios put a fake `navigator.bluetooth` in, so the real connect path runs: two with a board behind it, one with a TSL6 behind it. All scenarios answer from the mocks in the app.

## Deploy

```sh
# App with the Firmware page. Put runtime-nokey.bin (the secured build) next to index.html first.
surge public tsl6-app.surge.sh
# Redirect for the old recovery address
surge redirect tsl6-recovery.surge.sh
```

## Notes for browsers

- Bluefy gives short characteristic UUIDs (`FFF1`, `FFF2`) and lists `FFF2` first. The app picks `FFF1` for receive and send.
- iPhone browsers do not save downloads. **Back up** and **Download** open the share sheet, or show the text with a **Copy** button. **Restore** takes a file or pasted text.
- iOS shares one BLE link between apps. While one app is logged in, another app on the same phone (also the vendor Mini App) uses that link without the password. Disconnect before you switch apps.
- The page cannot read the BLE MTU. Bytes per write default to 180 on Apple and 240 elsewhere, and drop to 20 by themselves if large writes fail.
- iOS rejects self-signed certificates without a bypass. Use a trusted HTTPS host.
